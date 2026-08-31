// ---------------------------------------------------------------------------
// MCP Apps — the approval domain.
//
// The four tools the review card calls (`approval_review`, `approval_decide`,
// `approval_update`, `approval_schedule`) plus the envelope builders defined by
// `docs/mcp-apps/contract.md` §§1-5.
//
// ── THE ONE RULE ────────────────────────────────────────────────────────────
// `approval_decide` accepts `decision: "reject"` and nothing else. Approving a
// send is unreachable over MCP, by construction and forever.
//
// Why, since a `visibility: ["app"]` tool "can only be called by the card":
// it cannot. Phase 0 proved the server receives no signal that distinguishes an
// app-originated `tools/call` from a model-originated one — same origin, same
// headers, same bearer token — the host-side filter lives in the host's own
// application code, the SDK exports visibility helpers and never calls them,
// and a plain SDK client called an `["app"]`-only tool successfully. A
// server-issued token does not rescue it either: the model can call whichever
// tool hands out the token. **Nothing the card can do, the model cannot also
// do.** So every tool in this file must be assumed reachable by a
// prompt-injected agent, and the design goal is that this is merely useless
// rather than harmful:
//
//   reject   — fail-safe. Worst case: an email does not go out.
//   update   — changes what a human will be shown before they approve.
//   schedule — moves a delivery time. Still requires the human approve.
//   review   — discloses a body the same key already composed.
//
// Approving is irreversible and exfiltration-capable, so it lives on exactly
// one code path: an authenticated browser session with an owner/admin role, at
// `/approvals/<id>` (see `apps/web/src/lib/approvals/decide.ts`). Do not add a
// second one, and do not "fix" the guard in `runApprovalDecide` — it is not an
// oversight.
//
// ── Why this is a separate module ───────────────────────────────────────────
// Same reason as `mcp-app-resources.ts`: `index.ts` calls `Deno.serve` and
// builds a service-role client at module load, so a test cannot import it.
// Every dependency here is injected (`ApprovalDeps`), so the guards below are
// directly testable — see `mcp-app-approvals.test.ts`.
// ---------------------------------------------------------------------------

// The Supabase query builder is a deeply-chained generic; typing it faithfully
// here would couple this module to supabase-js and buy nothing. Handled as an
// opaque chain instead — see `ApprovalDb`.
// deno-lint-ignore-file no-explicit-any

import { neutralizeList, neutralizeMaybe, neutralizeText } from "./text-safety.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** `schema_version` every envelope carries (contract §1). */
export const CARD_SCHEMA_VERSION = "review-card-v1";

/**
 * How long a queued send stays decidable. After this, no human and no tool can
 * turn it into a delivery: the decide paths refuse it, the tools here retire
 * the row, and the scheduled-send dispatcher re-checks it before running the
 * original operation.
 *
 * 24h is chosen to match the `outbound_idempotency` retention window, so a
 * caller retrying with the same `idempotency_key` after an approval lapses
 * always finds either a live approval or a clean slate — never a dead record
 * it cannot get past.
 */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** Contract §2: each body is clipped at 64 KB and the clip is flagged. */
const BODY_CLIP_BYTES = 64 * 1024;

/** RFC 5322 recommends 998 octets per header line. */
const MAX_SUBJECT_LENGTH = 998;

/** Generous, but bounded: an unbounded edit is a storage-amplification lever. */
const MAX_BODY_LENGTH = 1_000_000;

/** Rejection notes are for humans reading the audit trail, not for essays. */
const MAX_NOTE_LENGTH = 500;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The tools defined in this module, in `tools/list` order. */
export const APPROVAL_TOOL_NAMES = [
  "approval_review",
  "approval_decide",
  "approval_update",
  "approval_schedule",
] as const;

export type ApprovalToolName = typeof APPROVAL_TOOL_NAMES[number];

export function isApprovalToolName(name: string): name is ApprovalToolName {
  return (APPROVAL_TOOL_NAMES as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

/** The subset of the Supabase client this module uses. */
export interface ApprovalDb {
  from(table: string): any;
}

export interface ApprovalDeps {
  /** MUST be the service-role client: RLS re-evaluates its SELECT policy
   * against the NEW row, so a status write from an RLS client is rejected. */
  db: ApprovalDb;
  /** `encryptForStorage` — AES-256-GCM, base64url. */
  encrypt(plaintext: string): Promise<string>;
  /** `decryptStoredToken` — the inverse of `encrypt`. */
  decrypt(ciphertext: string): Promise<string>;
  /** Canonical app origin, no trailing slash. */
  appUrl: string;
  /** Injectable clock, for tests. */
  now?(): number;
}

/** The authenticated caller, projected from `ApiKeyRow`. */
export interface ApprovalCaller {
  id: string;
  workspace_id: string;
  name: string;
  /** Non-null = this key may only touch these inboxes. */
  inbox_ids: string[] | null;
}

/** The result shape every `index.ts` tool handler returns. */
export interface ApprovalToolResult {
  result: {
    content: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/**
 * The one-click review page for an approval.
 *
 * **A bare id, with no token and no signature — deliberately.** A signed URL
 * sitting in model context would itself be a bearer capability, and model
 * context is exactly where this string ends up. The id is useless without an
 * authenticated Supabase session and an owner/admin role on the approval's own
 * workspace, so it is safe for a hostile agent to hold. Do not "harden" this by
 * signing it; that would weaken it.
 */
export function approvalReviewUrl(appUrl: string, approvalId: string): string {
  return `${appUrl}/approvals/${approvalId}`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function nowMs(deps: ApprovalDeps): number {
  return deps.now ? deps.now() : Date.now();
}

/** Clip to 64 KB of UTF-8 without emitting a replacement character. */
export function clipBody(value: unknown): { value: string | null; truncated: boolean } {
  if (typeof value !== "string" || value.length === 0) {
    return { value: null, truncated: false };
  }
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= BODY_CLIP_BYTES) return { value, truncated: false };
  const decoded = new TextDecoder("utf-8").decode(bytes.slice(0, BODY_CLIP_BYTES));
  return { value: decoded.replace(/�$/, ""), truncated: true };
}

/** True when a still-`pending` row has passed its deadline. */
export function isApprovalExpired(
  approval: { expires_at?: string | null } | null,
  atMs: number,
): boolean {
  const expiresAt = approval?.expires_at;
  if (!expiresAt) return false;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) && parsed <= atMs;
}

/**
 * True when an *approved* row must still be refused by the dispatcher.
 *
 * The window closes on the decision, not on the delivery: a human who approved
 * in time may legitimately have scheduled the send for next week, and that must
 * not be silently dropped. So this only fires when the request was never
 * decided inside its window — the belt to the decide paths' braces.
 */
export function approvalLapsedBeforeDecision(
  approval: { expires_at?: string | null; decided_at?: string | null },
  atMs: number,
): boolean {
  if (!isApprovalExpired(approval, atMs)) return false;
  const decidedAt = approval.decided_at ? Date.parse(approval.decided_at) : NaN;
  if (!Number.isFinite(decidedAt)) return true; // never decided
  const expiresAt = Date.parse(String(approval.expires_at));
  return decidedAt > expiresAt; // decided after the window closed
}

/**
 * True when a PostgREST/Postgres error means "that column does not exist".
 *
 * Mirrors `apps/web/src/lib/approvals/columns.ts#isUnknownColumnError`. Both
 * exist only so the migration and the code that uses it stay independently
 * deployable — the edge function is deployed by hand, and a deploy that landed
 * before the migration would otherwise 500 every gated send. DELETE BOTH once
 * `20260805200000_mcp_app_approval_review.sql` is applied everywhere.
 */
export function isUnknownColumnError(error: any): boolean {
  if (!error) return false;
  if (error.code === "42703" || error.code === "PGRST204") return true;
  const message = String(error.message ?? "");
  return /column .* does not exist/i.test(message) ||
    /could not find the '.+' column/i.test(message);
}

/** Runs a write built from `patch`; retries once without `optional` columns. */
export async function writeTolerantly<T>(
  patch: Record<string, unknown>,
  optional: readonly string[],
  // PromiseLike, not Promise: a Supabase query builder is thenable but is not
  // an actual Promise until it is awaited.
  run: (patch: Record<string, unknown>) => PromiseLike<{ data: T; error: any }>,
): Promise<{ data: T; error: any }> {
  const first = await run(patch);
  if (!first.error || !isUnknownColumnError(first.error)) return first;
  const reduced = { ...patch };
  let dropped = false;
  for (const key of optional) {
    if (key in reduced) {
      delete reduced[key];
      dropped = true;
    }
  }
  if (!dropped) return first;
  console.warn("[mcp-server] approvals: retrying without pending columns:", optional.join(", "));
  return run(reduced);
}

/** Columns added by the Phase 2 migration that a write may have to drop. */
export const PENDING_APPROVAL_COLUMNS = [
  "decided_via",
  "decided_by_api_key_id",
  "expires_at",
] as const;

// ---------------------------------------------------------------------------
// Envelope builders (contract §§1-5)
// ---------------------------------------------------------------------------

export interface ReceiptFields {
  outcome:
    | "sent"
    | "scheduled"
    | "rejected"
    | "expired"
    | "decided_elsewhere"
    | "executed"
    | "failed";
  headline: string;
  detail: string;
  affected_count: number;
  dashboard_url: string | null;
  error_code: string | null;
}

export type CardState =
  | "pending"
  | "sent"
  | "scheduled"
  | "rejected"
  | "expired"
  | "decided_elsewhere"
  | "executed"
  | "error";

function receiptEnvelope(
  state: CardState,
  receipt: ReceiptFields,
  reason: string | null,
): Record<string, unknown> {
  return {
    schema_version: CARD_SCHEMA_VERSION,
    card: "receipt",
    // Envelope-level, always present, absolute. `ui/open-link` requires an
    // absolute URL, and the card must not hold an origin of its own: it ships
    // inside the edge function, so a hardcoded origin would be deployment
    // config baked into a build artifact, silently duplicating APP_URL. It is
    // also the one link the card still needs when it cannot parse the rest of
    // the envelope — an unsupported schema_version, say — which is exactly when
    // a receipt-level field would be unreachable.
    dashboard_url: receipt.dashboard_url,
    state,
    receipt,
    // `can_decide` means "the inline actions are still available". Approving is
    // never one of them on this channel, whatever this flag says.
    actor: { can_decide: false, reason },
  };
}

/**
 * Contract §5, specialised to sends.
 *
 * Note that `COMPATIBILITY_PROFILES.notes` — which contract §5 names as the
 * source — carries no send-relevant line (every note is about search, folders,
 * or delete semantics). These caveats are therefore authored here, and mirror
 * `apps/web/src/lib/approvals/review.ts#providerRouteFor` so the card and the
 * approve page describe the same delivery in the same words.
 */
export function sendProviderBlock(inbox: {
  provider?: string | null;
  smtp_host?: string | null;
  smtp_port?: number | null;
}): { label: string; route: string; caveats: string[] } {
  const provider = inbox?.provider ?? "imap";
  if (provider === "gmail") {
    return {
      label: "Gmail API",
      route: "users.messages.send",
      caveats: [
        "Sending threads the message into the existing conversation when it is a reply.",
        "A copy is written to the Sent label automatically.",
      ],
    };
  }
  if (provider === "outlook") {
    return {
      label: "Microsoft Graph",
      route: "me/sendMail",
      caveats: ["A copy is written to Sent Items automatically."],
    };
  }
  const host = inbox?.smtp_host || "the configured SMTP host";
  const port = inbox?.smtp_port ?? 465;
  return {
    label: "IMAP + SMTP",
    route: `SMTP submission · ${host}:${port}`,
    caveats: [
      "SMTP submission does not itself file a copy in Sent; the server appends one over IMAP where the account allows it.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Loading a pending approval, with every guard re-applied
// ---------------------------------------------------------------------------

interface ApprovalRow {
  id: string;
  workspace_id: string;
  inbox_id: string;
  api_key_id: string | null;
  operation: string;
  payload: unknown;
  payload_encrypted: boolean | null;
  summary: Record<string, unknown> | null;
  send_at: string | null;
  status: string;
  created_at: string | null;
  expires_at?: string | null;
  decided_at?: string | null;
  decided_via?: string | null;
  [key: string]: unknown;
}

type LoadResult =
  | { ok: true; row: ApprovalRow }
  | { ok: false; failure: ApprovalToolResult };

/**
 * Fetch a pending approval, re-verifying everything from scratch.
 *
 * **An id from the caller proves nothing.** Every guard below is applied on
 * every call of every tool, because the caller may be a hostile agent that
 * learned an id from anywhere:
 *
 *   1. the id is a UUID (a malformed id never reaches the database);
 *   2. the row is in the calling key's workspace — enforced in the query, not
 *      compared afterwards;
 *   3. the key's `inbox_ids` allowlist, if it has one, covers the row's inbox;
 *   4. the row is still `pending`;
 *   5. the row has not expired — and if it has, it is retired on the spot so a
 *      later reader sees a terminal state rather than a live one.
 *
 * (2) and (3) fail with the *same* response as "no such approval", so this
 * cannot be used to probe which ids exist in other workspaces.
 */
async function loadPendingApproval(
  deps: ApprovalDeps,
  caller: ApprovalCaller,
  approvalId: unknown,
): Promise<LoadResult> {
  if (typeof approvalId !== "string" || !UUID_PATTERN.test(approvalId)) {
    return {
      ok: false,
      failure: failureResult(
        "error",
        {
          outcome: "failed",
          headline: "That approval could not be found.",
          detail: "approval_id must be the UUID returned alongside status \"pending_approval\".",
          affected_count: 0,
          dashboard_url: `${deps.appUrl}/dashboard/approvals`,
          error_code: "invalid_approval_id",
        },
        "not_found",
        "invalid_approval_id",
      ),
    };
  }

  // `select("*")` rather than a column list: it cannot fail against a database
  // where the Phase 2 migration has not been applied yet, and every column it
  // returns is one this module reads.
  const { data, error } = await deps.db
    .from("send_approvals")
    .select("*")
    .eq("id", approvalId)
    .eq("workspace_id", caller.workspace_id)
    .maybeSingle();

  if (error) {
    console.error("[mcp-server] approval_load_failed", { error: error.message });
    return { ok: false, failure: notFoundFailure(deps.appUrl) };
  }
  const row = data as ApprovalRow | null;
  if (!row) return { ok: false, failure: notFoundFailure(deps.appUrl) };

  // The key's inbox allowlist is the server's data-isolation mechanism
  // everywhere else; an approval is inbox-bound data and gets the same rule.
  // The `!== null` (rather than `length > 0`) test is deliberate and matches
  // the primary inbox gate: an empty allowlist denies everything, which is the
  // fail-safe reading of "this key may touch exactly these inboxes".
  if (caller.inbox_ids !== null && !caller.inbox_ids.includes(row.inbox_id)) {
    return { ok: false, failure: notFoundFailure(deps.appUrl) };
  }

  const at = nowMs(deps);

  if (row.status !== "pending") {
    return {
      ok: false,
      failure: failureResult(
        row.status === "expired" ? "expired" : "decided_elsewhere",
        {
          outcome: row.status === "expired" ? "expired" : "decided_elsewhere",
          headline: row.status === "expired"
            ? "This request expired before it was decided."
            : `This request was already ${row.status}.`,
          detail: row.status === "approved"
            ? "It was approved in the browser and is queued for delivery."
            : "It was decided elsewhere — in the dashboard, on the review page, or by another client.",
          affected_count: 0,
          dashboard_url: `${deps.appUrl}/dashboard/approvals`,
          error_code: null,
        },
        "not_pending",
        row.status === "expired" ? "approval_expired" : "approval_not_pending",
      ),
    };
  }

  if (isApprovalExpired(row, at)) {
    // Retire it here rather than waiting for a sweep. This is also what makes a
    // retry work: `claimOutboundIdempotency` reclaims a `pending_approval`
    // idempotency record whose approval reads rejected/cancelled/expired, so a
    // caller repeating the request with the same key gets a fresh approval
    // instead of being pinned to a dead one forever.
    //
    // `decided_via` is left NULL: no human and no surface decided this, the
    // clock did, and recording "mcp_app" would attribute a decision to whoever
    // happened to read the row first.
    await writeTolerantly(
      { status: "expired", decided_at: new Date(at).toISOString() },
      PENDING_APPROVAL_COLUMNS,
      (patch) =>
        deps.db.from("send_approvals").update(patch).eq("id", row.id).eq("status", "pending"),
    );
    return {
      ok: false,
      failure: failureResult(
        "expired",
        {
          outcome: "expired",
          headline: "This request expired before it was decided.",
          detail:
            "Pending sends stay decidable for 24 hours. Nothing was sent. Ask the agent to compose it again if it is still wanted.",
          affected_count: 0,
          dashboard_url: `${deps.appUrl}/dashboard/approvals`,
          error_code: null,
        },
        "expired",
        "approval_expired",
      ),
    };
  }

  return { ok: true, row };
}

function notFoundFailure(appUrl: string): ApprovalToolResult {
  return failureResult(
    "error",
    {
      outcome: "failed",
      headline: "That approval could not be found.",
      detail:
        "It may have been deleted, or it belongs to a different workspace than this API key.",
      affected_count: 0,
      dashboard_url: `${appUrl}/dashboard/approvals`,
      error_code: "not_found",
    },
    "not_found",
    "approval_not_found",
  );
}

function failureResult(
  state: CardState,
  receipt: ReceiptFields,
  reason: string | null,
  logErrorCode: string,
): ApprovalToolResult {
  const envelope = receiptEnvelope(state, receipt, reason);
  return {
    result: {
      content: [{ type: "text", text: receipt.headline + " " + receipt.detail }],
      structuredContent: envelope,
      isError: true,
    },
    logStatus: "error",
    logErrorCode,
  };
}

// ---------------------------------------------------------------------------
// The outbound envelope (contract §2)
// ---------------------------------------------------------------------------

/**
 * Decrypt the stored snapshot. Returns null when the row is not decryptable —
 * never throws into a tool result.
 */
async function readSnapshot(
  deps: ApprovalDeps,
  row: ApprovalRow,
): Promise<Record<string, unknown> | null> {
  const payload = row.payload;
  if (!payload) return null;
  if (row.payload_encrypted === false) {
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;
  }
  const ciphertext = (payload as Record<string, unknown>)["data"];
  if (typeof ciphertext !== "string") return null;
  try {
    const parsed = JSON.parse(await deps.decrypt(ciphertext));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch (error) {
    console.error("[mcp-server] approval_decrypt_failed", {
      approval_id: row.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** `subject` only matters where the operation actually sends one. */
function operationCarriesSubject(operation: string): boolean {
  return operation === "email_send" || operation === "schedule_create";
}

/** draft_send stores a draft id; the message itself never leaves the provider. */
function contentLivesWithProvider(operation: string): boolean {
  return operation === "draft_send";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Recipients and subject that a stored payload does not carry, resolved from
 * somewhere else (the mail provider at queue time, or the summary already on
 * the row after an edit).
 */
export interface ResolvedSummaryFields {
  to?: string[];
  cc?: string[];
  bcc_count?: number;
  subject?: string;
}

/**
 * True when a payload already describes its own send, so nothing has to be
 * resolved from the provider.
 *
 * `email_send` and `schedule_create` always pass. `email_reply` (no `to`, no
 * `subject`), `email_forward` (no `subject`) and `draft_send` (only a
 * `draft_id`) never do — which is the whole reason `resolveApprovalSummaryFields`
 * in index.ts exists.
 */
export function summaryIsComplete(payload: Record<string, unknown>): boolean {
  const hasRecipients = Array.isArray(payload.to) && payload.to.length > 0;
  const hasSubject = typeof payload.subject === "string" && payload.subject.length > 0;
  return hasRecipients && hasSubject;
}

/**
 * Build `send_approvals.summary` — the ONE projection the dashboard queue, the
 * approve page and the review card all render.
 *
 * Two rules, both load-bearing:
 *
 *  1. The payload wins where it has a value; `resolved` fills the gaps. That
 *     ordering matters: the payload is what will actually be transmitted, so it
 *     can never be overridden by a derived value.
 *  2. Every string is neutralised (see text-safety.ts). Subjects, display names
 *     and recipient labels arrive from inbound mail or from an agent, and
 *     U+202E RIGHT-TO-LEFT OVERRIDE lets one lie about itself. This is the
 *     string a human reads before deciding to send, and it is also what lands
 *     in the audit log.
 *
 * NOT neutralised anywhere: the encrypted payload itself. That is the immutable
 * delivery request, and rewriting it would silently alter outgoing mail. The
 * rule is neutralise what is RENDERED, never what is SENT.
 */
export function buildApprovalSummary(
  payload: Record<string, unknown>,
  resolved: ResolvedSummaryFields = {},
): Record<string, unknown> {
  const to = stringList(payload.to);
  const cc = stringList(payload.cc);
  const subject = typeof payload.subject === "string" && payload.subject.length > 0
    ? payload.subject
    : resolved.subject ?? "";
  return {
    to: neutralizeList(to.length ? to : resolved.to ?? []),
    cc: neutralizeList(cc.length ? cc : resolved.cc ?? []),
    bcc_count: Array.isArray(payload.bcc) ? payload.bcc.length : resolved.bcc_count ?? 0,
    subject: neutralizeText(subject),
    attachment_count: Array.isArray(payload.attachments) ? payload.attachments.length : 0,
  };
}

/**
 * Recompute `send_approvals.summary` from a snapshot after an edit.
 *
 * The summary is what the dashboard queue and the approve page render, so
 * leaving it stale would show a reviewer the *old* subject and recipients for a
 * message whose content has since changed — the exact failure this feature
 * exists to prevent.
 *
 * `previous` is the summary already on the row, and it is not optional in
 * practice. A reply's snapshot holds no `to` and no `subject` — both are
 * derived — so they are resolved from the provider once, at queue time.
 * Recomputing purely from the snapshot after an unrelated body edit would blank
 * them again and hand the reviewer back the empty recipient line this whole
 * change exists to remove. So the previous summary is fed in as the fallback.
 */
export function summaryFromSnapshot(
  snapshot: Record<string, unknown>,
  previous?: Record<string, unknown> | null,
): Record<string, unknown> {
  const prev = previous ?? {};
  return buildApprovalSummary(snapshot, {
    to: stringList(prev.to),
    cc: stringList(prev.cc),
    bcc_count: typeof prev.bcc_count === "number" ? prev.bcc_count : 0,
    subject: typeof prev.subject === "string" ? prev.subject : "",
  });
}

async function buildOutboundEnvelope(
  deps: ApprovalDeps,
  caller: ApprovalCaller,
  row: ApprovalRow,
): Promise<Record<string, unknown>> {
  const snapshot = await readSnapshot(deps, row);
  const summary = (row.summary ?? {}) as Record<string, unknown>;

  const { data: inbox } = await deps.db
    .from("inboxes")
    .select(
      "id, email_address, display_name, provider, service, smtp_host, smtp_port, " +
        "signature_enabled, signature_text, signature_html, signature_source",
    )
    .eq("id", row.inbox_id)
    .maybeSingle();
  const inboxRow = (inbox ?? {}) as Record<string, any>;

  // NEUTRALISATION BOUNDARY (see text-safety.ts). Recipients, subject, sender
  // display name and attachment filenames are all attacker-influenced short
  // strings that a reviewer *scans* rather than reads, and U+202E in any of them
  // makes the card show something other than what will be sent. The card runs
  // its own `neutralizeDeep` on ingest; this pass is what protects every other
  // reader of the same envelope and keeps the server honest on its own.
  //
  // `body` is deliberately NOT neutralised: bidi controls are legitimate in
  // right-to-left prose, and a body is read as untrusted content in a block of
  // its own rather than scanned as a structural field.
  const summaryTo = neutralizeList(summary.to);
  const summaryCc = neutralizeList(summary.cc);
  const to = summaryTo.length ? summaryTo : neutralizeList(snapshot?.to);
  const cc = summaryCc.length ? summaryCc : neutralizeList(snapshot?.cc);
  const subject = neutralizeText(
    (typeof summary.subject === "string" && summary.subject) ||
      (typeof snapshot?.subject === "string" ? snapshot.subject as string : "") || "",
  );

  const providerSide = contentLivesWithProvider(row.operation);
  const text = providerSide ? { value: null, truncated: false } : clipBody(snapshot?.body);
  const html = providerSide ? { value: null, truncated: false } : clipBody(snapshot?.html_body);

  const attachments = Array.isArray(snapshot?.attachments)
    ? (snapshot!.attachments as unknown[]).slice(0, 25).map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      // The stored key is `data` (base64), per the email_send input schema.
      const data = typeof item.data === "string" ? item.data : null;
      return {
        // The headline case for neutralisation: `invoice<U+202E> fdp.exe`
        // renders as `invoiceexe.pdf`.
        filename: typeof item.filename === "string"
          ? neutralizeText(item.filename)
          : "attachment",
        size_bytes: data ? Math.max(0, Math.floor((data.length * 3) / 4)) : null,
        mime_type: typeof item.mime_type === "string" ? neutralizeText(item.mime_type) : null,
      };
    })
    : [];

  const signatureText = typeof inboxRow.signature_text === "string" ? inboxRow.signature_text : "";
  const willAppend = inboxRow.signature_enabled === true &&
    !providerSide &&
    snapshot?.include_signature !== false &&
    Boolean(signatureText || inboxRow.signature_html);

  return {
    schema_version: CARD_SCHEMA_VERSION,
    card: "outbound_review",
    // Envelope-level so the card never has to synthesise an origin. See the
    // note on `receiptEnvelope`.
    dashboard_url: `${deps.appUrl}/dashboard/approvals`,
    // A scheduled-but-undecided send is still `pending`: nothing is queued for
    // delivery until a human approves, so "scheduled" would overstate it.
    state: "pending",
    outbound: {
      approval_id: row.id,
      operation: row.operation,
      created_at: row.created_at,
      expires_at: row.expires_at ?? null,
      send_at: row.send_at ?? null,
      review_url: approvalReviewUrl(deps.appUrl, row.id),
      identity: {
        inbox_id: inboxRow.id ?? row.inbox_id,
        email_address: neutralizeMaybe(inboxRow.email_address ?? null),
        display_name: neutralizeMaybe(inboxRow.display_name ?? null),
        provider: inboxRow.provider ?? null,
        service: inboxRow.service ?? null,
      },
      recipients: {
        to,
        cc,
        // Count only. The addresses are deliberately never returned: a bcc list
        // is the one recipient field a reviewer is not meant to disclose.
        bcc_count: typeof summary.bcc_count === "number"
          ? summary.bcc_count
          : Array.isArray(snapshot?.bcc)
          ? (snapshot!.bcc as unknown[]).length
          : 0,
      },
      subject,
      body: {
        text: text.value,
        html: html.value,
        truncated: text.truncated || html.truncated,
      },
      attachments,
      signature: {
        will_append: willAppend,
        source: typeof inboxRow.signature_source === "string" ? inboxRow.signature_source : null,
        preview_text: willAppend ? neutralizeText(signatureText.slice(0, 200)) : "",
      },
      requested_by: {
        // Key names are user-chosen and client names are self-reported by the
        // MCP client; both are rendered as provenance a reviewer trusts.
        api_key_name: neutralizeMaybe(await requestingKeyName(deps, caller, row)),
        client_name: neutralizeMaybe(await requestingClientName(deps, row)),
      },
    },
    provider: sendProviderBlock(inboxRow),
    actor: {
      // Inline actions (reject / edit / schedule) are available. Approving is
      // not, on this channel, ever — see the header of this file.
      can_decide: true,
      reason: null,
    },
  };
}

/**
 * The contract §2 envelope for a send that has JUST been held for approval.
 *
 * WHY THIS IS EXPORTED, AND WHY IT MATTERS MORE THAN IT LOOKS. Until this
 * existed the review card could not render on the thing it was built to review.
 * A gated `email_compose` / `draft` / `schedule` call returned the flat
 * `{status:"pending_approval", ...}` payload, which carries no
 * `schema_version`, so the card classified it "foreign" and rendered nothing
 * (see `apps/mcp-app/src/store.ts#classifyResult`). The only producer of an
 * `outbound_review` envelope was `approval_review`, an app-only tool the card
 * calls from an already-rendered card. That is circular: the card rendered only
 * if it was already rendered, and nothing in the pending-approval message text
 * ever asked the model to make the second call.
 *
 * So the send itself now returns the envelope, and `index.ts` merges it over
 * the pending-approval keys. Deliberately the SAME builder `approval_review`
 * uses, not a parallel one: two builders for one wire shape is how the card and
 * the review page drift, and the card renders whichever it gets with no way to
 * tell them apart.
 *
 * `row` is the freshly-inserted `send_approvals` row (`insert().select("*")`),
 * which is why this takes a loose record rather than the module-private
 * `ApprovalRow`. It is read, never trusted for authority: the caller has just
 * written it under the service-role client, and every field this reads is one
 * the caller supplied moments ago.
 *
 * MODEL-CONTEXT NOTE (contract §7). The returned envelope contains decrypted
 * body content for every operation except `draft_send` (whose content lives
 * with the provider, see `contentLivesWithProvider`). It belongs in
 * `structuredContent` and must never be mirrored into the `content` text. Do
 * not hand this to `jsonOk`.
 */
/**
 * Assemble the two channels of a held-send tool result.
 *
 * `payload` is the flat `pending_approval` object index.ts has always returned;
 * `envelope` is `buildHeldSendEnvelope`'s output, or null when it could not be
 * built (in which case this degrades to exactly the pre-card behaviour).
 *
 * ── THE TWO CHANNELS ARE NOT THE SAME OBJECT, ON PURPOSE ────────────────────
 * `content` reaches the model. `structuredContent` reaches the card. The
 * envelope carries decrypted body text and HTML for four of the five gated
 * operations, and contract §7 commits to the default flow not re-injecting
 * message content into the conversation, so only the payload goes into
 * `content`. This is why the caller must not reach for `index.ts#jsonOk`, which
 * puts one object in both.
 *
 * ── THE MERGE IS A SUPERSET ─────────────────────────────────────────────────
 * `structuredContent` is the payload's keys PLUS the envelope's. The card's
 * `isEnvelope` needs only `schema_version` and `card` and ignores extra
 * top-level keys, so the merged object renders; and the pending-approval keys
 * are a published output contract, so they stay exactly where callers already
 * find them. The two key sets are disjoint today and a test pins that, because
 * a collision would silently drop one side.
 *
 * Lives here rather than in index.ts so the merge rule is directly testable
 * (index.ts calls `Deno.serve` at module load and cannot be imported).
 */
export function heldSendToolResult(
  payload: Record<string, unknown>,
  envelope: Record<string, unknown> | null,
): { content: { type: string; text: string }[]; structuredContent: Record<string, unknown> } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: envelope ? { ...payload, ...envelope } : payload,
  };
}

export async function buildHeldSendEnvelope(
  deps: ApprovalDeps,
  caller: ApprovalCaller,
  row: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return await buildOutboundEnvelope(deps, caller, row as unknown as ApprovalRow);
}

async function requestingKeyName(
  deps: ApprovalDeps,
  caller: ApprovalCaller,
  row: ApprovalRow,
): Promise<string | null> {
  if (!row.api_key_id) return null;
  if (row.api_key_id === caller.id) return caller.name;
  const { data } = await deps.db
    .from("api_keys")
    .select("name")
    .eq("id", row.api_key_id)
    .maybeSingle();
  const name = (data as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : null;
}

async function requestingClientName(
  deps: ApprovalDeps,
  row: ApprovalRow,
): Promise<string | null> {
  if (!row.api_key_id) return null;
  const { data } = await deps.db
    .from("mcp_client_capabilities")
    .select("client_name")
    .eq("api_key_id", row.api_key_id)
    .order("last_seen", { ascending: false })
    .limit(1)
    .maybeSingle();
  const name = (data as { client_name?: unknown } | null)?.client_name;
  return typeof name === "string" && name !== "unknown" ? name : null;
}

/**
 * Wrap an envelope as a tool result.
 *
 * `content` is written by hand rather than produced by `jsonOk`, and this is
 * load-bearing: `jsonOk` mirrors the whole object into the model-visible
 * `content` array, which for `approval_review` would inject the decrypted body
 * straight into the conversation. Contract §7 commits to the default flow not
 * re-injecting message content, so `content` carries a summary that
 * deliberately omits the body while `structuredContent` carries the full
 * envelope for the card.
 *
 * This is context hygiene, not a boundary: the model can call
 * `approval_review` itself, and some hosts may show `structuredContent` to the
 * model too. It is worth having and it is worth not overselling.
 */
function cardResult(
  envelope: Record<string, unknown>,
  text: string,
): ApprovalToolResult {
  return {
    result: { content: [{ type: "text", text }], structuredContent: envelope, isError: false },
    logStatus: "success",
    logErrorCode: null,
  };
}

function outboundSummaryText(envelope: Record<string, unknown>, lead: string): string {
  const outbound = envelope.outbound as Record<string, any>;
  const to = outbound.recipients.to as string[];
  const recipients = to.length
    ? to.slice(0, 3).join(", ") + (to.length > 3 ? ` and ${to.length - 3} more` : "")
    : "recipients resolved from the original message";
  return `${lead} To: ${recipients}. Subject: ${outbound.subject || "(none)"}. ` +
    `${outbound.attachments.length} attachment(s). Nothing has been sent. ` +
    `Approve it at ${outbound.review_url} (sign-in required) or reject it with approval_decide. ` +
    `The message body is shown in the review card and is not repeated here.`;
}

// ---------------------------------------------------------------------------
// approval_review
// ---------------------------------------------------------------------------

export async function runApprovalReview(
  deps: ApprovalDeps,
  caller: ApprovalCaller,
  rawArgs: unknown,
): Promise<ApprovalToolResult> {
  const args = asObject(rawArgs);
  const loaded = await loadPendingApproval(deps, caller, args["approval_id"]);
  if (!loaded.ok) return loaded.failure;

  const envelope = await buildOutboundEnvelope(deps, caller, loaded.row);
  return cardResult(
    envelope,
    outboundSummaryText(envelope, "This send is awaiting human approval."),
  );
}

// ---------------------------------------------------------------------------
// approval_decide — reject only
// ---------------------------------------------------------------------------

export async function runApprovalDecide(
  deps: ApprovalDeps,
  caller: ApprovalCaller,
  rawArgs: unknown,
): Promise<ApprovalToolResult> {
  const args = asObject(rawArgs);
  const decision = args["decision"];

  // ─────────────────────────────────────────────────────────────────────────
  // THE LOAD-BEARING GUARD. Do not relax it, do not add an escape hatch, do
  // not make it conditional on who the caller claims to be.
  //
  // This looks like an oversight — a "decide" tool that can only decide one
  // way. It is not. The server cannot tell an app-originated tools/call from a
  // model-originated one (Phase 0 Q2), so any approve reachable from here is
  // an approve reachable by a prompt-injected agent, and approving a send is
  // both irreversible and exfiltration-capable. Approving therefore happens
  // only at /approvals/<id>, behind a Supabase session and an owner/admin
  // role. Rejecting is fail-safe and stays here.
  //
  // The input schema already restricts `decision` to "reject", so a conforming
  // client is stopped one layer earlier. That layer is a convenience; this one
  // is the boundary. Neither is redundant.
  // ─────────────────────────────────────────────────────────────────────────
  if (decision !== "reject") {
    return failureResult(
      "error",
      {
        outcome: "failed",
        headline: "Approving is not possible from here.",
        detail:
          "approval_decide can only reject. Approving a send requires a signed-in " +
          "browser session with an owner or admin role: open the review link for " +
          "this approval and approve it there. No email was sent.",
        affected_count: 0,
        dashboard_url: `${deps.appUrl}/dashboard/approvals`,
        error_code: "approve_requires_browser_session",
      },
      "approve_not_available_over_mcp",
      "approve_not_supported",
    );
  }

  const noteRaw = args["note"];
  if (noteRaw !== undefined && (typeof noteRaw !== "string" || noteRaw.length > MAX_NOTE_LENGTH)) {
    return invalidArgs(deps.appUrl, `note must be a string of at most ${MAX_NOTE_LENGTH} characters.`);
  }
  // Stored on the audit record and rendered in the dashboard, so it gets the
  // same treatment as any other short string a human will read and act on.
  const note = typeof noteRaw === "string" && noteRaw.trim().length > 0
    ? neutralizeText(noteRaw.trim())
    : null;

  const loaded = await loadPendingApproval(deps, caller, args["approval_id"]);
  if (!loaded.ok) return loaded.failure;
  const row = loaded.row;

  // Atomic claim. `.eq("status", "pending")` is what makes a dashboard decision
  // and a card decision racing each other safe: exactly one update matches a
  // row, the other matches nothing and reports `decided_elsewhere` rather than
  // overwriting a decision that has already been acted on.
  //
  // `decided_by` stays NULL — no human session exists on this path, and naming
  // one would falsify the audit trail. `decided_by_api_key_id` records the key.
  const { data: claimed, error } = await writeTolerantly<any>(
    {
      status: "rejected",
      decided_at: new Date(nowMs(deps)).toISOString(),
      decided_via: "mcp_app",
      decided_by_api_key_id: caller.id,
      ...(note ? { decision_note: note } : {}),
    },
    PENDING_APPROVAL_COLUMNS,
    (patch) =>
      deps.db
        .from("send_approvals")
        .update(patch)
        .eq("id", row.id)
        .eq("workspace_id", caller.workspace_id)
        .eq("status", "pending")
        .select("id")
        .maybeSingle(),
  );

  if (error) {
    console.error("[mcp-server] approval_reject_failed", { error: error.message });
    return failureResult(
      "error",
      {
        outcome: "failed",
        headline: "The rejection could not be recorded.",
        detail: "Nothing was sent. Try again, or reject it in the dashboard.",
        affected_count: 0,
        dashboard_url: `${deps.appUrl}/dashboard/approvals`,
        error_code: "write_failed",
      },
      "error",
      "approval_write_failed",
    );
  }

  if (!claimed) {
    return failureResult(
      "decided_elsewhere",
      {
        outcome: "decided_elsewhere",
        headline: "This request was already decided.",
        detail:
          "Another reviewer decided it first — in the dashboard, on the review page, or " +
          "in another client. This rejection changed nothing.",
        affected_count: 0,
        dashboard_url: `${deps.appUrl}/dashboard/approvals`,
        error_code: null,
      },
      "not_pending",
      "approval_decided_elsewhere",
    );
  }

  const envelope = receiptEnvelope(
    "rejected",
    {
      outcome: "rejected",
      headline: "Rejected. Nothing was sent.",
      detail:
        "The message was discarded" + (note ? ` (note: ${note})` : "") +
        ". Retrying the original request with the same idempotency_key will create a fresh approval.",
      affected_count: 0,
      dashboard_url: `${deps.appUrl}/dashboard/approvals`,
      error_code: null,
    },
    "rejected",
  );
  return cardResult(
    envelope,
    `Rejected approval ${row.id}. Nothing was sent.` +
      (note ? ` Note recorded: ${note}` : ""),
  );
}

// ---------------------------------------------------------------------------
// approval_update
// ---------------------------------------------------------------------------

export async function runApprovalUpdate(
  deps: ApprovalDeps,
  caller: ApprovalCaller,
  rawArgs: unknown,
): Promise<ApprovalToolResult> {
  const args = asObject(rawArgs);

  const subject = args["subject"];
  const bodyText = args["body_text"];
  const bodyHtml = args["body_html"];
  if (subject === undefined && bodyText === undefined && bodyHtml === undefined) {
    return invalidArgs(deps.appUrl, "Pass at least one of subject, body_text or body_html.");
  }
  if (subject !== undefined && (typeof subject !== "string" || subject.length > MAX_SUBJECT_LENGTH)) {
    return invalidArgs(deps.appUrl, `subject must be a string of at most ${MAX_SUBJECT_LENGTH} characters.`);
  }
  for (const [name, value] of [["body_text", bodyText], ["body_html", bodyHtml]] as const) {
    if (value !== undefined && (typeof value !== "string" || value.length > MAX_BODY_LENGTH)) {
      return invalidArgs(deps.appUrl, `${name} must be a string of at most ${MAX_BODY_LENGTH} characters.`);
    }
  }

  const loaded = await loadPendingApproval(deps, caller, args["approval_id"]);
  if (!loaded.ok) return loaded.failure;
  const row = loaded.row;

  // A draft_send approval stores a draft id, not a message: the body lives with
  // the provider and is sent verbatim at dispatch. Accepting an edit here would
  // silently change nothing, which is worse than refusing.
  if (contentLivesWithProvider(row.operation)) {
    return failureResult(
      "error",
      {
        outcome: "failed",
        headline: "This request cannot be edited here.",
        detail:
          "It sends an existing draft, whose content lives with the mail provider. " +
          "Edit the draft itself, or reject this request and send a new one.",
        affected_count: 0,
        dashboard_url: `${deps.appUrl}/dashboard/approvals`,
        error_code: "not_editable",
      },
      "not_editable",
      "approval_not_editable",
    );
  }

  const snapshot = await readSnapshot(deps, row);
  if (!snapshot) {
    return failureResult(
      "error",
      {
        outcome: "failed",
        headline: "This request could not be read.",
        detail: "Its stored copy could not be decrypted. Reject it and compose the message again.",
        affected_count: 0,
        dashboard_url: `${deps.appUrl}/dashboard/approvals`,
        error_code: "decrypt_failed",
      },
      "error",
      "approval_decrypt_failed",
    );
  }

  const updated: Record<string, unknown> = { ...snapshot };
  if (typeof subject === "string") {
    // Replies and forwards derive their subject from the original message at
    // send time, so writing one would be shown to the reviewer and then ignored.
    if (!operationCarriesSubject(row.operation)) {
      return invalidArgs(deps.appUrl, 
        `subject cannot be set on a ${row.operation} request: it is derived from the original message at send time.`,
      );
    }
    updated.subject = subject;
  }
  if (typeof bodyText === "string") updated.body = bodyText;
  if (typeof bodyHtml === "string") updated.html_body = bodyHtml;

  const ciphertext = await deps.encrypt(JSON.stringify(updated));

  // Same atomic claim as the reject path: an edit must not land on a row that
  // has just been approved, or the human would have approved content that is no
  // longer what will be sent.
  const { data: claimed, error } = await deps.db
    .from("send_approvals")
    .update({
      payload: { v: 1, data: ciphertext },
      payload_encrypted: true,
      // Refreshing the summary is not cosmetic: it is what the dashboard queue
      // and the approve page render. `row.summary` is passed so a reply's
      // provider-resolved recipients and subject survive a body-only edit.
      summary: summaryFromSnapshot(updated, row.summary),
    })
    .eq("id", row.id)
    .eq("workspace_id", caller.workspace_id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();

  if (error) {
    console.error("[mcp-server] approval_update_failed", { error: error.message });
    return failureResult(
      "error",
      {
        outcome: "failed",
        headline: "The edit could not be saved.",
        detail: "Nothing was sent and the pending request is unchanged.",
        affected_count: 0,
        dashboard_url: `${deps.appUrl}/dashboard/approvals`,
        error_code: "write_failed",
      },
      "error",
      "approval_write_failed",
    );
  }
  if (!claimed) return decidedElsewhereDuringEdit(deps.appUrl);

  const envelope = await buildOutboundEnvelope(deps, caller, claimed as ApprovalRow);
  return cardResult(
    envelope,
    outboundSummaryText(envelope, "Updated. This send is still awaiting human approval."),
  );
}

function decidedElsewhereDuringEdit(appUrl: string): ApprovalToolResult {
  return failureResult(
    "decided_elsewhere",
    {
      outcome: "decided_elsewhere",
      headline: "This request was decided while you were editing it.",
      detail: "Nothing was changed. Reload the approval to see its current state.",
      affected_count: 0,
      dashboard_url: `${appUrl}/dashboard/approvals`,
      error_code: null,
    },
    "not_pending",
    "approval_decided_elsewhere",
  );
}

// ---------------------------------------------------------------------------
// approval_schedule
// ---------------------------------------------------------------------------

export async function runApprovalSchedule(
  deps: ApprovalDeps,
  caller: ApprovalCaller,
  rawArgs: unknown,
): Promise<ApprovalToolResult> {
  const args = asObject(rawArgs);
  const sendAtRaw = args["send_at"];
  if (typeof sendAtRaw !== "string") {
    return invalidArgs(deps.appUrl, "send_at is required and must be an ISO 8601 timestamp with a timezone.");
  }
  const sendAtMs = Date.parse(sendAtRaw);
  if (!Number.isFinite(sendAtMs)) {
    return invalidArgs(deps.appUrl, "send_at could not be parsed as an ISO 8601 timestamp.");
  }
  if (sendAtMs <= nowMs(deps)) {
    return invalidArgs(deps.appUrl, "send_at must be in the future.");
  }

  const loaded = await loadPendingApproval(deps, caller, args["approval_id"]);
  if (!loaded.ok) return loaded.failure;
  const row = loaded.row;

  const { data: claimed, error } = await deps.db
    .from("send_approvals")
    .update({ send_at: new Date(sendAtMs).toISOString() })
    .eq("id", row.id)
    .eq("workspace_id", caller.workspace_id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();

  if (error) {
    console.error("[mcp-server] approval_schedule_failed", { error: error.message });
    return failureResult(
      "error",
      {
        outcome: "failed",
        headline: "The delivery time could not be saved.",
        detail: "Nothing was sent and the pending request is unchanged.",
        affected_count: 0,
        dashboard_url: `${deps.appUrl}/dashboard/approvals`,
        error_code: "write_failed",
      },
      "error",
      "approval_write_failed",
    );
  }
  if (!claimed) return decidedElsewhereDuringEdit(deps.appUrl);

  const envelope = await buildOutboundEnvelope(deps, caller, claimed as ApprovalRow);
  return cardResult(
    envelope,
    outboundSummaryText(
      envelope,
      `Delivery time set to ${new Date(sendAtMs).toISOString()}. ` +
        "This send is still awaiting human approval and will not go out until it is approved.",
    ),
  );
}

// ---------------------------------------------------------------------------
// Shared argument helpers
// ---------------------------------------------------------------------------

function asObject(rawArgs: unknown): Record<string, unknown> {
  return rawArgs !== null && typeof rawArgs === "object" && !Array.isArray(rawArgs)
    ? rawArgs as Record<string, unknown>
    : {};
}

function invalidArgs(appUrl: string, message: string): ApprovalToolResult {
  return failureResult(
    "error",
    {
      outcome: "failed",
      headline: "That request could not be understood.",
      detail: message,
      affected_count: 0,
      dashboard_url: `${appUrl}/dashboard/approvals`,
      error_code: "invalid_arguments",
    },
    "error",
    "-32602",
  );
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export interface ApprovalToolDefinition {
  name: string;
  title: string;
  description: string;
  /**
   * SCOPE CHOICE — `send:email`, with `schedule:email` accepted as well.
   *
   * These tools act on a *pending outbound send*, not on an inbox's mail, so
   * `read:email` would be both too weak (it does not imply any right to alter
   * an outbound message) and too broad (a read-only key would gain a lever over
   * sends). `send:email` is the consent that produced the approval in the first
   * place: four of the five gated operations require it.
   *
   * The fifth, `schedule_create`, requires `schedule:email` instead — so a key
   * holding only that scope could queue an approval it then could not review or
   * withdraw. `schedule:email` is therefore accepted as an alternative. The
   * widening it buys is bounded by what these tools can do at all: no approve,
   * no send, workspace-scoped, and further narrowed by the key's `inbox_ids`
   * allowlist.
   *
   * A new `manage:approvals` scope was considered and rejected: every existing
   * key would lack it, so the card would be dead for every current user until
   * they re-minted their keys.
   */
  requiredScope: "send:email";
  altScopes?: string[];
  inputSchema: Record<string, unknown>;
  /**
   * The shape of `structuredContent`. Loose on purpose: these four tools all
   * return the card envelope plus per-tool keys, and `additionalProperties`
   * must stay true so the per-tool keys are not rejected. See the note on
   * CONSOLIDATED_ENVELOPE_KEYS in index.ts for why every listed tool declares
   * one and why none of them is strict.
   */
  outputSchema?: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

const APPROVAL_ID_PROPERTY = {
  type: "string",
  format: "uuid",
  description:
    "The approval_id returned by a gated send (status: \"pending_approval\").",
} as const;

const APPROVAL_ALT_SCOPES = ["schedule:email"];

/**
 * The card envelope every approval tool returns, as a schema.
 *
 * Shared by all four because they genuinely share it: each result is built by
 * an *Envelope helper in this file and carries `schema_version`, `card`,
 * `state` and `dashboard_url` at the top level. The per-card payload
 * (`outbound`, `receipt`, `actor`) rides in the same object and is admitted by
 * `additionalProperties`, which is why no tool needs its own variant.
 */
const APPROVAL_CARD_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    schema_version: {
      type: "integer",
      description: "Card envelope version. A client that does not know this version should fall back to dashboard_url.",
    },
    card: {
      type: "string",
      description: "Which card this envelope renders: 'outbound_review' or 'receipt'.",
    },
    state: {
      type: "string",
      description: "Where the request stands: pending, approved, rejected, expired or sent.",
    },
    dashboard_url: {
      type: "string",
      description: "Absolute link to the signed-in approvals page. Always present, and the one link that still works when the rest of the envelope cannot be parsed.",
    },
  },
  additionalProperties: true,
} as const;

export const APPROVAL_TOOL_DEFINITIONS: ApprovalToolDefinition[] = [
  {
    name: "approval_review",
    title: "Review a pending send",
    description:
      "Fetch the full contents of a send that is waiting for human approval, " +
      "including its body, so it can be shown in the review card. Read-only. " +
      "Approving is not possible from here: it requires the signed-in review " +
      "page linked as review_url.",
    requiredScope: "send:email",
    altScopes: APPROVAL_ALT_SCOPES,
    inputSchema: {
      type: "object",
      properties: { approval_id: APPROVAL_ID_PROPERTY },
      required: ["approval_id"],
      additionalProperties: false,
    },
    outputSchema: APPROVAL_CARD_OUTPUT_SCHEMA,
    annotations: {
      title: "Review a pending send",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "approval_decide",
    title: "Reject a pending send",
    description:
      "Reject a send that is waiting for human approval, so it is never " +
      "delivered. `decision` accepts only \"reject\". Approving is deliberately " +
      "not available over MCP — it requires a signed-in browser session with an " +
      "owner or admin role, at the review_url of the approval.",
    requiredScope: "send:email",
    altScopes: APPROVAL_ALT_SCOPES,
    inputSchema: {
      type: "object",
      properties: {
        approval_id: APPROVAL_ID_PROPERTY,
        decision: {
          type: "string",
          // Not a typo and not a placeholder: "approve" is refused at the tool
          // layer too. See runApprovalDecide.
          enum: ["reject"],
          description: "Only \"reject\" is accepted. Approving requires the review page.",
        },
        note: {
          type: "string",
          maxLength: MAX_NOTE_LENGTH,
          description: "Optional reason, stored on the audit record.",
        },
      },
      required: ["approval_id", "decision"],
      additionalProperties: false,
    },
    outputSchema: APPROVAL_CARD_OUTPUT_SCHEMA,
    annotations: {
      title: "Reject a pending send",
      readOnlyHint: false,
      // Rejecting destroys nothing that was ever delivered; it prevents a
      // delivery. The fail-safe direction is not a destructive action.
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "approval_update",
    title: "Edit a pending send",
    description:
      "Change the subject or body of a send that is waiting for human approval. " +
      "The message still has to be approved afterwards, and the reviewer sees " +
      "the edited version. Subject can only be set on operations that carry " +
      "one (email_send, schedule_create).",
    requiredScope: "send:email",
    altScopes: APPROVAL_ALT_SCOPES,
    inputSchema: {
      type: "object",
      properties: {
        approval_id: APPROVAL_ID_PROPERTY,
        subject: { type: "string", maxLength: MAX_SUBJECT_LENGTH, description: "Replacement subject line." },
        body_text: { type: "string", maxLength: MAX_BODY_LENGTH, description: "Replacement plain-text body." },
        body_html: { type: "string", maxLength: MAX_BODY_LENGTH, description: "Replacement HTML body." },
      },
      required: ["approval_id"],
      additionalProperties: false,
    },
    outputSchema: APPROVAL_CARD_OUTPUT_SCHEMA,
    annotations: {
      title: "Edit a pending send",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "approval_schedule",
    title: "Schedule a pending send",
    description:
      "Set the delivery time of a send that is waiting for human approval. " +
      "Nothing is queued until it is approved; this only decides when an " +
      "approved message goes out. send_at must be in the future.",
    requiredScope: "send:email",
    altScopes: APPROVAL_ALT_SCOPES,
    inputSchema: {
      type: "object",
      properties: {
        approval_id: APPROVAL_ID_PROPERTY,
        send_at: {
          type: "string",
          format: "date-time",
          description: "ISO 8601 timestamp with timezone, in the future.",
        },
      },
      required: ["approval_id", "send_at"],
      additionalProperties: false,
    },
    outputSchema: APPROVAL_CARD_OUTPUT_SCHEMA,
    annotations: {
      title: "Schedule a pending send",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

/** Dispatch by name. Unknown names return null so the caller can 404 them. */
export function runApprovalTool(
  name: string,
  deps: ApprovalDeps,
  caller: ApprovalCaller,
  rawArgs: unknown,
): Promise<ApprovalToolResult> | null {
  switch (name) {
    case "approval_review":
      return runApprovalReview(deps, caller, rawArgs);
    case "approval_decide":
      return runApprovalDecide(deps, caller, rawArgs);
    case "approval_update":
      return runApprovalUpdate(deps, caller, rawArgs);
    case "approval_schedule":
      return runApprovalSchedule(deps, caller, rawArgs);
    default:
      return null;
  }
}
