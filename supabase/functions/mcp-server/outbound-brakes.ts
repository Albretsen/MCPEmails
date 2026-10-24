// ---------------------------------------------------------------------------
// outbound-brakes.ts - abuse brakes on every outbound send.
//
// The risk these exist for is a customer's AUTOMATION, not the customer:
// a loop or a compromised key mass-sending through the customer's own mailbox
// until the mailbox, or our relay addresses, get reported. Four brakes, all
// decided in one atomic RPC (`outbound_send_gate`, migration
// 20261024130000_outbound_abuse_brakes.sql), checked in this order:
//
//   sends_frozen                    an operator set workspaces.sends_frozen_at
//   sends_paused_provider_refusals  the provider refused 3 messages from this
//                                   inbox as spam or policy within an hour;
//                                   paused for an hour
//   daily_send_limit                500 messages from this inbox in a rolling
//                                   24 hours (messages, not recipients)
//   hold (fan-out)                  one normalized subject+body went to more
//                                   than 25 distinct recipients within an hour;
//                                   further sends from the inbox are held for a
//                                   human in send_approvals until the end of the
//                                   UTC day. Held, never dropped.
//
// The first three are refusals: an isError tool result (never a JSON-RPC
// error) with `error_code` in `_meta`, delivery_status "not_sent", and a
// retry time. Nothing was transmitted, so the idempotency key is released.
//
// PRIVACY. Only SHA-256 digests leave this file: of the normalized content and
// of each normalized recipient address. Never the content or an address.
//
// FAIL OPEN. A database error, a missing RPC or a malformed answer allows the
// send and logs, the same as every other limiter in this server. These are
// brakes against a runaway, not the approval boundary.
//
// COPY. The limits are named in the refusal only. They are deliberately not in
// any marketing or docs copy.
//
// Run: deno test supabase/functions/mcp-server/outbound-brakes.test.ts
// ---------------------------------------------------------------------------

/** Messages one inbox may send in a rolling 24 hours. */
export const DAILY_SEND_LIMIT_PER_INBOX = 500;
/** Distinct recipients one content hash may reach from one inbox per window. */
export const FANOUT_RECIPIENT_LIMIT = 25;
export const FANOUT_WINDOW_MS = 60 * 60 * 1000;
/** Provider spam/policy refusals within REFUSAL_WINDOW_MS that pause an inbox. */
export const REFUSAL_PAUSE_THRESHOLD = 3;
export const REFUSAL_WINDOW_MS = 60 * 60 * 1000;
export const REFUSAL_PAUSE_MS = 60 * 60 * 1000;

export const DAILY_SEND_LIMIT_ERROR_CODE = "daily_send_limit";
export const SENDS_PAUSED_ERROR_CODE = "sends_paused_provider_refusals";
export const SENDS_FROZEN_ERROR_CODE = "sends_frozen";

/**
 * Every refusal code a brake can log. Each one means "nothing was sent and the
 * same request may go through later", which is what the idempotency release
 * and the scheduled dispatcher's hold both key on.
 */
export const OUTBOUND_BRAKE_ERROR_CODES: ReadonlySet<string> = new Set([
  DAILY_SEND_LIMIT_ERROR_CODE,
  SENDS_PAUSED_ERROR_CODE,
  SENDS_FROZEN_ERROR_CODE,
]);

/** The `_meta` key a brake refusal carries its machine-readable fields under. */
export const SEND_LIMIT_META_KEY = "com.mcpemails/send_limit";

export type BrakeRefusalCode =
  | typeof DAILY_SEND_LIMIT_ERROR_CODE
  | typeof SENDS_PAUSED_ERROR_CODE
  | typeof SENDS_FROZEN_ERROR_CODE;

export type BrakeDecision =
  | { kind: "allow" }
  | { kind: "refuse"; code: BrakeRefusalCode; retryAt: string | null }
  | { kind: "hold"; retryAt: string | null; newlyTripped: boolean };

/** The slice of the Supabase client the brakes use. */
export interface BrakeDb {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

/** One send, as the gate sees it. */
export interface OutboundSend {
  workspaceId: string;
  /** The inbox that transmits (the sender identity's inbox). */
  inboxId: string;
  /** Messages this call transmits. A forward batch of 12 is 12. */
  messages: number;
  /** Content for the fan-out hash. Omit both to skip the fan-out brake. */
  subject?: string | null;
  body?: string | null;
  /** Recipient keys for the fan-out count: addresses, or thread markers. */
  recipients: readonly string[];
  /** An approved send being dispatched: skips the fan-out brake only. */
  humanApproved: boolean;
}

const encoder = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Subject and body reduced to what makes two sends "the same message":
 * Unicode-normalized, case-folded, whitespace collapsed. A template with a
 * different greeting per recipient still differs, which is fine: the brake is
 * for one identical message blasted out, not for mail merges.
 */
export function normalizeContent(subject: string | null | undefined, body: string | null | undefined): string {
  const fold = (value: string | null | undefined) =>
    (value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  return `${fold(subject)}\n${fold(body)}`;
}

/** SHA-256 of the normalized content, or null when there is no content. */
export async function contentHash(
  subject: string | null | undefined,
  body: string | null | undefined,
): Promise<string | null> {
  const normalized = normalizeContent(subject, body);
  if (normalized === "\n") return null;
  return await sha256Hex(`mcpemails-outbound-content-v1\n${normalized}`);
}

/** `"Ann <ANN@x.example>"` and `" ann@x.example "` are one recipient. */
export function normalizeRecipient(value: string): string {
  const trimmed = value.trim();
  const angle = /<([^<>]+)>\s*$/.exec(trimmed);
  return (angle ? angle[1] : trimmed).trim().toLowerCase();
}

/** Distinct SHA-256 digests of the normalized recipients. */
export async function recipientHashes(recipients: readonly string[]): Promise<string[]> {
  const distinct = [...new Set(recipients.map(normalizeRecipient).filter((r) => r.length > 0))];
  return await Promise.all(distinct.map((r) => sha256Hex(`mcpemails-outbound-recipient-v1\n${r}`)));
}

/** A string array out of an unknown argument (to/cc/bcc), ignoring anything else. */
export function addressList(value: unknown): string[] {
  if (typeof value === "string") return value.length > 0 ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** Read the gate's jsonb answer. Anything unexpected is null (fail open). */
export function parseGateAnswer(data: unknown): BrakeDecision | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const answer = data as Record<string, unknown>;
  const retryAt = typeof answer.retry_at === "string" ? answer.retry_at : null;
  switch (answer.decision) {
    case "allow":
      return { kind: "allow" };
    case "frozen":
      return { kind: "refuse", code: SENDS_FROZEN_ERROR_CODE, retryAt: null };
    case "paused":
      return { kind: "refuse", code: SENDS_PAUSED_ERROR_CODE, retryAt };
    case "daily_limit":
      return { kind: "refuse", code: DAILY_SEND_LIMIT_ERROR_CODE, retryAt };
    case "hold":
      return { kind: "hold", retryAt, newlyTripped: answer.newly_tripped === true };
    default:
      return null;
  }
}

/**
 * Ask the gate about one send and, when it is allowed and `commit` is true
 * (the default), count it. Counted BEFORE transmission: a send that then
 * fails still counts, which errs towards the brake, never past it.
 */
export async function checkOutboundBrakes(
  db: BrakeDb,
  send: OutboundSend,
  options: { commit?: boolean } = {},
): Promise<BrakeDecision> {
  try {
    const hash = send.subject == null && send.body == null ? null : await contentHash(send.subject, send.body);
    const recipients = hash === null ? [] : await recipientHashes(send.recipients);
    const { data, error } = await db.rpc("outbound_send_gate", {
      p_workspace_id: send.workspaceId,
      p_inbox_id: send.inboxId,
      p_messages: Math.max(1, Math.floor(send.messages)),
      p_content_hash: hash,
      p_recipient_hashes: recipients,
      p_daily_limit: DAILY_SEND_LIMIT_PER_INBOX,
      p_fanout_limit: FANOUT_RECIPIENT_LIMIT,
      p_fanout_window_ms: FANOUT_WINDOW_MS,
      p_human_approved: send.humanApproved,
      p_commit: options.commit ?? true,
    });
    if (error) {
      console.error("[mcp-server] outbound_brake_gate_failed", { inbox_id: send.inboxId, error: error.message });
      return { kind: "allow" };
    }
    const decision = parseGateAnswer(data);
    if (decision === null) {
      console.error("[mcp-server] outbound_brake_gate_malformed", { inbox_id: send.inboxId });
      return { kind: "allow" };
    }
    if (decision.kind !== "allow") {
      console.warn("[mcp-server] outbound_brake", {
        workspace_id: send.workspaceId,
        inbox_id: send.inboxId,
        decision: decision.kind,
        ...(decision.kind === "refuse" ? { error_code: decision.code } : { newly_tripped: decision.newlyTripped }),
        retry_at: decision.retryAt,
      });
    }
    return decision;
  } catch (err) {
    console.error("[mcp-server] outbound_brake_gate_threw", {
      inbox_id: send.inboxId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: "allow" };
  }
}

// ── Provider refusals ───────────────────────────────────────────────────────

/** Microsoft Graph codes that mean "this account is sending what we will not take". */
const GRAPH_POLICY_CODES = new Set([
  "ErrorAccountSuspend",
  "ErrorMessageSubmissionBlocked",
  "ErrorSubmissionQuotaExceeded",
  "ErrorExceededMessageLimit",
]);

/** Spam, abuse and sending-limit wording, across SMTP servers, Gmail and Graph. */
const POLICY_REFUSAL_RE =
  /\bspam\b|unsolicited|\bphish|\babuse\b|content (?:policy|restrictions?|filter)|(?:message|content) (?:was )?(?:rejected|blocked) (?:due to|because|as)|policy (?:violation|reasons?)|violates? (?:our|the) policy|sending (?:limit|quota)|daily (?:user )?sending quota|too many (?:messages|emails)|suspicious|\breputation\b/i;

/**
 * Refusals about the CONNECTING ADDRESS, not the mail: an egress or relay IP a
 * host will not take (the ACR04 family). Those are ours to fix with the relay
 * fallback (smtp-relay.ts), and pausing the customer for them would punish
 * them for our network.
 */
const ORIGIN_REFUSAL_RE = /\bACR\d+\b|client host|may not use this server|\bIP\b|ip address/i;

/** Credential and sender-ownership refusals are their own problems, never abuse. */
const NOT_ABUSE_RE = /_auth_failed\b|authentication|not owned by|send ?as|does not match authenticated/i;

/**
 * True when a send failed because the provider refused it as spam, against
 * its policy, or over its sending limit. Classified by `name`, a `code`
 * property and the message text, so this module needs no provider imports.
 */
export function isProviderPolicyRefusal(error: unknown): boolean {
  if (!(error instanceof Error) && typeof error !== "string") return false;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : error;
  if (name === "SmtpSenderRefusedError") return false;
  if (message === "quota_exceeded") return true;
  if (name === "GraphSendRefusedError") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && GRAPH_POLICY_CODES.has(code)) return true;
  }
  if (NOT_ABUSE_RE.test(message) || ORIGIN_REFUSAL_RE.test(message)) return false;
  return POLICY_REFUSAL_RE.test(message);
}

export interface RefusalOutcome {
  paused: boolean;
  newlyTripped: boolean;
  retryAt: string | null;
}

/**
 * Count one provider refusal against the inbox if it is a policy refusal.
 * Never throws; a failure to count is logged and treated as "not paused".
 */
export async function recordProviderRefusal(
  db: BrakeDb,
  input: { workspaceId: string; inboxId: string; error: unknown },
): Promise<RefusalOutcome | null> {
  if (!isProviderPolicyRefusal(input.error)) return null;
  try {
    const { data, error } = await db.rpc("outbound_send_refusal", {
      p_workspace_id: input.workspaceId,
      p_inbox_id: input.inboxId,
      p_threshold: REFUSAL_PAUSE_THRESHOLD,
      p_window_ms: REFUSAL_WINDOW_MS,
      p_pause_ms: REFUSAL_PAUSE_MS,
    });
    if (error || !data || typeof data !== "object") {
      console.error("[mcp-server] outbound_refusal_record_failed", {
        inbox_id: input.inboxId,
        error: error?.message ?? "malformed",
      });
      return null;
    }
    const answer = data as Record<string, unknown>;
    const outcome: RefusalOutcome = {
      paused: answer.paused === true,
      newlyTripped: answer.newly_tripped === true,
      retryAt: typeof answer.retry_at === "string" ? answer.retry_at : null,
    };
    console.warn("[mcp-server] outbound_provider_refusal", {
      workspace_id: input.workspaceId,
      inbox_id: input.inboxId,
      ...outcome,
    });
    return outcome;
  } catch (err) {
    console.error("[mcp-server] outbound_refusal_record_threw", {
      inbox_id: input.inboxId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── Results ─────────────────────────────────────────────────────────────────

/** "2026-10-25 14:03 UTC", or a plain fallback when the time is unknown. */
export function formatRetryAt(retryAt: string | null): string | null {
  if (!retryAt) return null;
  const ms = Date.parse(retryAt);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/** The agent-facing sentence for a refusal. States the limit; no marketing. */
export function brakeRefusalText(tool: string, code: BrakeRefusalCode, retryAt: string | null): string {
  const when = formatRetryAt(retryAt);
  switch (code) {
    case DAILY_SEND_LIMIT_ERROR_CODE:
      return `${tool}: this inbox has reached its limit of ${DAILY_SEND_LIMIT_PER_INBOX} messages in 24 hours. ` +
        `Nothing was sent. ` +
        (when ? `Sending from this inbox is possible again from ${when}.` : "Try again later.");
    case SENDS_PAUSED_ERROR_CODE:
      return `${tool}: sending from this inbox is paused because the mail provider refused ` +
        `${REFUSAL_PAUSE_THRESHOLD} recent messages as spam or against its policy. Nothing was sent. ` +
        (when ? `Sending resumes at ${when}. ` : "Sending resumes within an hour. ") +
        "Check why the provider refused those messages before sending more.";
    case SENDS_FROZEN_ERROR_CODE:
      return `${tool}: sending is suspended for this workspace. Nothing was sent. ` +
        "Contact MCPEmails support to restore sending.";
  }
}

/** The isError tool result for a brake refusal. */
export function brakeRefusalResult(
  tool: string,
  decision: Extract<BrakeDecision, { kind: "refuse" }>,
): {
  result: {
    content: { type: string; text: string }[];
    isError: true;
    delivery_status: "not_sent";
    _meta: Record<string, unknown>;
  };
  logStatus: "error";
  logErrorCode: BrakeRefusalCode;
} {
  return {
    result: {
      content: [{ type: "text", text: brakeRefusalText(tool, decision.code, decision.retryAt) }],
      isError: true,
      delivery_status: "not_sent",
      _meta: {
        [SEND_LIMIT_META_KEY]: {
          error_code: decision.code,
          retry_at: decision.retryAt,
          ...(decision.code === DAILY_SEND_LIMIT_ERROR_CODE ? { limit: DAILY_SEND_LIMIT_PER_INBOX } : {}),
        },
      },
    },
    logStatus: "error",
    logErrorCode: decision.code,
  };
}

/** The operator notice for a brake that just tripped (system_events payload). */
export function brakeTrippedEvent(input: {
  workspaceId: string;
  inboxId: string;
  brake: "fanout_hold" | "provider_refusal_pause";
  retryAt: string | null;
}): { p_event_type: string; p_payload: Record<string, unknown> } {
  return {
    p_event_type: "outbound.brake_tripped",
    p_payload: {
      workspace_id: input.workspaceId,
      inbox_id: input.inboxId,
      brake: input.brake,
      until: input.retryAt,
    },
  };
}
