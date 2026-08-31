// ---------------------------------------------------------------------------
// MCP Apps — the bulk-plan domain.
//
// Destructive bulk mailbox operations used to run the instant an agent asked
// for them. This module turns four of them (`email_delete` delete_batch /
// search_and_delete, `email_organize` move_batch / search_and_move) into a
// two-step flow for inboxes that opt in: the server resolves exactly which
// messages would be affected, freezes that list as a plan, and returns a card.
// Nothing happens until someone clicks Execute (`bulk_execute`) or Cancel
// (`bulk_cancel`); an untouched plan simply lapses after 15 minutes.
//
// ── Why executing IS allowed inline, unlike approving a send ────────────────
// Contract §6 splits authority by reversibility, and a bulk plan lands on the
// reversible side:
//
//   * A bulk delete on Gmail and Outlook moves messages to Trash, and both
//     providers refuse permanent deletion outright (`delete.permanent:
//     "unavailable"` in COMPATIBILITY_PROFILES), so the destructive case is
//     recoverable by the user without our help. A move is recoverable by
//     definition. Requiring a browser round-trip for routine mailbox cleanup
//     would be real friction in exchange for very little safety.
//   * More decisively: today these four operations run with NO confirmation at
//     all. An inline click is a strict improvement on the status quo, not a
//     weakening of a stronger control. There is no world in which adding this
//     feature makes a prompt-injected agent more capable than it is right now.
//
// Approving a send is the opposite on both counts — irreversible and
// exfiltration-capable — which is why it lives on an authenticated web page and
// `approval_decide` refuses "approve" unconditionally. Do not read this file's
// inline Execute as a precedent for relaxing that one.
//
// ── What `visibility: ["app"]` buys: nothing ────────────────────────────────
// `bulk_execute` carries `_meta.ui.visibility: ["app"]` for tidiness only. Phase
// 0 Q2 proved the server receives no signal distinguishing an app-originated
// `tools/call` from a model-originated one — same origin, same headers, same
// bearer token — and that a plain SDK client called an `["app"]`-only tool
// successfully. So assume `bulk_execute` is called by a prompt-injected agent
// and make that as harmless as possible:
//
//   * The scope is SERVER-HELD. The card sends only `plan_id`. There is no
//     argument through which a caller can widen, narrow, or restate the
//     selection, and the stored scope is a resolved id list rather than a query
//     to re-run — re-running a search at execute time could sweep up messages
//     that arrived in the meantime, which is exactly the surprise this feature
//     exists to prevent.
//   * Single-use, via an atomic `.eq("status", "pending")` claim.
//   * 15-minute TTL (contract §3).
//   * Workspace-scoped, and bound to the calling key's inbox allowlist.
//   * A replayed, expired, foreign or nonexistent `plan_id` all fail with a
//     renderable §4 receipt, and the foreign and nonexistent cases are
//     byte-identical so this cannot be used as an existence oracle.
//
// ── Why this is a separate module ───────────────────────────────────────────
// Same reason as `mcp-app-approvals.ts`: `index.ts` calls `Deno.serve` and
// builds a service-role client at module load, so a test cannot import it.
// Every dependency here is injected (`BulkDeps`) — including the provider
// execution itself — so the guards below are directly testable. See
// `mcp-app-bulk.test.ts`.
// ---------------------------------------------------------------------------

// The Supabase query builder is a deeply-chained generic; typing it faithfully
// here would couple this module to supabase-js and buy nothing. Handled as an
// opaque chain instead — see `BulkDb`.
// deno-lint-ignore-file no-explicit-any

import { CARD_SCHEMA_VERSION, type CardState } from "./mcp-app-approvals.ts";
import { neutralizeText } from "./text-safety.ts";

// ---------------------------------------------------------------------------
// Contract §4 — the receipt
//
// Declared locally rather than imported from `mcp-app-approvals.ts`. That was
// originally a workaround: this module already emitted the contract's absolute
// `dashboard_url` while the approvals module still emitted a relative
// `dashboard_path`, and widening the shared type would have broken fifteen call
// sites in a module this phase did not own.
//
// RESOLVED: the rename has since been applied across `mcp-app-approvals.ts`,
// `apps/mcp-app/src/contract.ts` and `Receipt.tsx`, and `dashboard_url` is now
// carried at envelope level as well as on the receipt. The two shapes no longer
// disagree; only the `"cancelled"` outcome, which is bulk-only, still justifies
// a separate declaration. Collapse the two into one exported type if a third
// module ever needs it.
// ---------------------------------------------------------------------------

export interface BulkReceiptFields {
  outcome:
    | "sent"
    | "scheduled"
    | "rejected"
    | "cancelled"
    | "expired"
    | "decided_elsewhere"
    | "executed"
    | "failed";
  headline: string;
  detail: string;
  affected_count: number;
  /** Absolute URL — `ui/open-link` rejects a bare path. Built from `appUrl`. */
  dashboard_url: string | null;
  error_code: string | null;
}

/**
 * Contract §1 `actor.reason`, now an enumeration.
 *
 * Note the gap: there is no member meaning "the server failed", so the internal
 * error paths below report `not_pending`, which is at least true — after a
 * failed write or an unreadable scope the plan is no longer actionable. Raised
 * in the Phase 3 report rather than worked around silently.
 */
type ActorReason = "viewer_role" | "expired" | "not_pending" | "wrong_workspace";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How long a plan stays executable (contract §3).
 *
 * Short on purpose, and much shorter than the 24h approval window. A plan is a
 * frozen snapshot of a mailbox; the longer it lives the less it describes the
 * mailbox the user is looking at. Fifteen minutes is long enough for a human to
 * read a card, scroll the sample and decide, and short enough that a plan
 * abandoned in a transcript is dead before it could be replayed usefully.
 */
export const BULK_PLAN_TTL_MS = 15 * 60 * 1000;

/** Contract §3: at most five sample rows, newest first. */
export const MAX_PLAN_SAMPLE = 5;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The tools defined in this module, in `tools/list` order. */
export const BULK_TOOL_NAMES = ["bulk_execute", "bulk_cancel"] as const;

export type BulkToolName = typeof BULK_TOOL_NAMES[number];

export function isBulkToolName(name: string): name is BulkToolName {
  return (BULK_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * The gate: does this inbox preview bulk operations, or run them?
 *
 * Pure, so the one decision that can silently break every existing non-UI
 * integration is directly testable. Everything that is not exactly `"plan"` —
 * `"off"`, an unrecognised value, `null` from a database without the column,
 * `undefined` from a failed read — means run immediately, which is the
 * behaviour every client had before this feature existed.
 *
 * The default MUST stay on this side. Failing the other way would leave a
 * scripted integration silently not deleting anything while being told a
 * preview was prepared, and the preview would then lapse unseen after 15
 * minutes. A broken preview is a nuisance; a delete that quietly never happens
 * is a data-integrity bug in someone else's system.
 */
export function shouldPlanForMode(mode: string | null | undefined): boolean {
  return mode === "plan";
}

/** The four actions that can be planned instead of executed. */
export const PLANNABLE_ACTIONS = [
  "delete_batch",
  "search_and_delete",
  "move_batch",
  "search_and_move",
] as const;

export type BulkAction = typeof PLANNABLE_ACTIONS[number];

/** The consolidated tool an action belongs to (contract §3 `operation`). */
export function operationForAction(action: BulkAction): "email_delete" | "email_organize" {
  return action === "delete_batch" || action === "search_and_delete"
    ? "email_delete"
    : "email_organize";
}

function isDeleteAction(action: BulkAction): boolean {
  return operationForAction(action) === "email_delete";
}

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

/** The subset of the Supabase client this module uses. */
export interface BulkDb {
  from(table: string): any;
}

/**
 * A provider compatibility profile, as `getCompatibilityProfile()` returns it.
 *
 * Injected rather than imported because it lives in `index.ts`. Contract §5
 * names `COMPATIBILITY_PROFILES` as the source for bulk caveats, and unlike the
 * send case (where Phase 2 found the map carries no send-relevant line at all)
 * it genuinely is: every note in it is about search, folder or delete
 * semantics, which is precisely what a bulk plan needs to explain.
 */
export interface CompatibilityFacts {
  operations: Record<string, "exact" | "different" | "unavailable">;
  notes: string[];
}

/** What `bulk_execute` hands to `index.ts` to run through the real code path. */
export interface BulkExecutionRequest {
  inbox_id: string;
  action: BulkAction;
  /** The frozen id list. Exactly these, in this order, and nothing else. */
  message_ids: string[];
  /** Provider-native destination, resolved at plan time. Move actions only. */
  destination_id: string | null;
  permanent: boolean;
}

export interface BulkExecutionOutcome {
  succeeded: number;
  failed: number;
  /** Set when the operation could not run at all (auth, provider outage). */
  error_code?: string | null;
}

export interface BulkDeps {
  /** MUST be the service-role client: RLS re-evaluates its SELECT policy
   * against the NEW row, so a status write from an RLS client is rejected. */
  db: BulkDb;
  /** `encryptForStorage` — AES-256-GCM, base64url. */
  encrypt(plaintext: string): Promise<string>;
  /** `decryptStoredToken` — the inverse of `encrypt`. */
  decrypt(ciphertext: string): Promise<string>;
  /** `getCompatibilityProfile`, for the §5 provider block. */
  compatibility(provider: string): CompatibilityFacts;
  /**
   * Runs the frozen id set through `index.ts`'s EXISTING provider bulk paths
   * (`gmailBulkDelete` / `imapBulkMove` / …).
   *
   * Injected as a callback specifically so that executing a plan cannot become
   * a second way to delete or move mail. There is one implementation, in
   * `index.ts`, shared with the immediate-execution path.
   */
  execute(request: BulkExecutionRequest): Promise<BulkExecutionOutcome>;
  /** Canonical app origin, no trailing slash. Receipts carry absolute URLs. */
  appUrl: string;
  /** Injectable clock, for tests. */
  now?(): number;
}

/** Contract §4 `dashboard_url`: absolute, because `ui/open-link` demands it. */
function dashboardUrl(deps: BulkDeps): string {
  return `${deps.appUrl}/dashboard`;
}

/** The authenticated caller, projected from `ApiKeyRow`. */
export interface BulkCaller {
  id: string;
  workspace_id: string;
  name: string;
  /** Non-null = this key may only touch these inboxes. */
  inbox_ids: string[] | null;
}

/** The result shape every `index.ts` tool handler returns. */
export interface BulkToolResult {
  result: {
    content: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function nowMs(deps: BulkDeps): number {
  return deps.now ? deps.now() : Date.now();
}

function receiptEnvelope(
  state: CardState,
  receipt: BulkReceiptFields,
  reason: ActorReason | null,
): Record<string, unknown> {
  return {
    schema_version: CARD_SCHEMA_VERSION,
    card: "receipt",
    // Envelope-level and absolute — see the matching note in
    // mcp-app-approvals.ts#receiptEnvelope. The card holds no origin of its own.
    dashboard_url: receipt.dashboard_url,
    state,
    receipt,
    actor: { can_decide: false, reason },
  };
}

function failureResult(
  state: CardState,
  receipt: BulkReceiptFields,
  reason: ActorReason | null,
  logErrorCode: string,
): BulkToolResult {
  return {
    result: {
      content: [{ type: "text", text: receipt.headline + " " + receipt.detail }],
      structuredContent: receiptEnvelope(state, receipt, reason),
      isError: true,
    },
    logStatus: "error",
    logErrorCode,
  };
}

/**
 * Wrap an envelope as a tool result.
 *
 * `content` is hand-written rather than produced by `jsonOk`, and that is
 * load-bearing here for the same reason as in `mcp-app-approvals.ts`: `jsonOk`
 * mirrors the whole object into the model-visible `content` array, which for a
 * plan would inject the sample rows — real subjects and senders from the user's
 * mailbox — straight into the conversation. Contract §7 puts the match count
 * and the scope description in model context and keeps the sample rows out of
 * it, so `content` carries exactly the former.
 */
function cardResult(envelope: Record<string, unknown>, text: string): BulkToolResult {
  return {
    result: { content: [{ type: "text", text }], structuredContent: envelope, isError: false },
    logStatus: "success",
    logErrorCode: null,
  };
}

function invalidArgs(deps: BulkDeps, message: string): BulkToolResult {
  return failureResult(
    "error",
    {
      outcome: "failed",
      headline: "That request could not be understood.",
      detail: message,
      affected_count: 0,
      dashboard_url: dashboardUrl(deps),
      error_code: "invalid_arguments",
    },
    "not_pending",
    "-32602",
  );
}

// ---------------------------------------------------------------------------
// Contract §5 — provider semantics
//
// This is the differentiating part of the card: a generic confirm dialog says
// "delete 128 messages?", and this says what "delete" will actually mean on
// this account. Caveats are selected by operation, never dumped wholesale.
// ---------------------------------------------------------------------------

/** Contract §5 `label` — the transport, in the words the rest of the app uses. */
function providerLabel(provider: string): string {
  if (provider === "gmail") return "Gmail API";
  if (provider === "outlook") return "Microsoft Graph";
  return "IMAP";
}

/** Contract §5 `route` — the concrete call, matching what index.ts really issues. */
function providerRoute(provider: string, action: BulkAction, permanent: boolean): string {
  if (isDeleteAction(action)) {
    if (provider === "gmail") {
      return permanent ? "users.messages.delete" : "users.messages.trash";
    }
    if (provider === "outlook") {
      return permanent ? "messages/{id}/permanentDelete" : "messages/{id}/move → deleteditems";
    }
    return permanent
      ? "UID STORE +FLAGS (\\Deleted) · EXPUNGE"
      : "UID MOVE → Trash";
  }
  if (provider === "gmail") return "users.messages.modify";
  if (provider === "outlook") return "messages/{id}/move";
  return "UID MOVE";
}

/**
 * Contract §5 `caveats` — 0-3 lines explaining what will really happen.
 *
 * Sourced from the injected `COMPATIBILITY_PROFILES` entry wherever that map
 * says something true and relevant, and authored here only where it is silent.
 * The selection rule:
 *
 *   1. one line about the operation itself (delete semantics or move
 *      semantics), because that is what the user is about to authorise;
 *   2. one line about the container model when it changes the meaning of a
 *      move (Gmail's labels);
 *   3. for a search-derived plan, at most one line about a search field the
 *      provider handles differently from the way the caller asked for it.
 *
 * Rule 3 is why the search fields are passed in: warning about Gmail's
 * whole-message body search on a plan that never used `body` would be noise,
 * and noise is how a caveat block stops being read.
 */
export function bulkProviderBlock(input: {
  provider: string;
  action: BulkAction;
  permanent: boolean;
  facts: CompatibilityFacts;
  /** Normalized search fields used, for rule 3. Empty for id-based plans. */
  searchFields?: string[];
}): { label: string; route: string; caveats: string[] } {
  const { provider, action, permanent, facts } = input;
  const caveats: string[] = [];
  const note = (needle: string): string | undefined =>
    facts.notes.find((n) => n.toLowerCase().includes(needle));

  if (isDeleteAction(action)) {
    if (facts.operations["delete.permanent"] === "unavailable") {
      // Gmail and Outlook. The point the user needs is that this is undoable.
      caveats.push(
        provider === "outlook"
          ? "Delete moves the message to Deleted Items; permanent delete is not available on Outlook, so it can be restored."
          : "Delete moves the message to Trash; permanent delete is not available on Gmail, so it can be restored.",
      );
    } else if (permanent) {
      caveats.push(
        "Permanent delete expunges the message from the server immediately. It does not go to Trash and cannot be undone.",
      );
    } else {
      caveats.push(
        "Delete moves the message to the Trash folder, where it stays until the server expires or you empty it.",
      );
    }
  } else {
    // Move. The Gmail label model is the one that genuinely surprises people.
    const moveNote = note("a move adds the destination label");
    if (moveNote) {
      caveats.push(moveNote);
    } else if (facts.operations["organization.move"] === "different") {
      caveats.push(
        note("copy/delete fallback") ??
          "The move may be performed as a copy followed by a delete on servers that lack MOVE.",
      );
    } else {
      caveats.push("The message is relocated to the destination folder and leaves its current one.");
    }
    const containerNote = note("labels rather than folders");
    if (containerNote && containerNote !== caveats[0]) caveats.push(containerNote);
  }

  // Rule 3 — a search caveat, only when the plan's search actually used the
  // field the provider treats differently.
  const used = new Set(input.searchFields ?? []);
  const searchCaveat = (field: string, key: string, fallback: string): string | undefined => {
    if (!used.has(field)) return undefined;
    const level = facts.operations[key];
    if (level !== "different" && level !== "unavailable") return undefined;
    return note(field) ?? fallback;
  };
  const search = searchCaveat("body", "search.body", "Body search is not exact on this provider.") ??
    searchCaveat(
      "has_attachment",
      "search.has_attachment",
      "Attachment-only search is not supported here, so the match may be wider than asked for.",
    ) ??
    searchCaveat(
      "flagged",
      "search.flagged",
      "Flagged search is not supported here, so the match may be wider than asked for.",
    );
  if (search && caveats.length < 3) caveats.push(search);

  return {
    label: providerLabel(provider),
    route: providerRoute(provider, action, permanent),
    caveats: caveats.slice(0, 3),
  };
}

// ---------------------------------------------------------------------------
// Contract §3 — describing the scope in words
// ---------------------------------------------------------------------------

function quote(value: unknown): string {
  return `"${String(value).replace(/"/g, "'").slice(0, 120)}"`;
}

/**
 * Render the resolved selection as one human sentence fragment.
 *
 * Server-authored on purpose (contract §3 says `description` is server-
 * rendered): the card must not have to reconstruct the meaning of a search
 * object, and the model must not be the one narrating what is about to be
 * deleted.
 *
 * Server-authored is not the same as trustworthy text, though: the search terms
 * and the folder name are interpolated straight in, and both are caller- or
 * mailbox-controlled. A U+202E in a folder name or a `subject:` term would let
 * the sentence describing a bulk delete render as something other than what it
 * says. The whole sentence is therefore neutralised on the way out — once, at
 * the end, so no individual interpolation site can be forgotten.
 */
export function describeScope(input: {
  kind: "explicit_ids" | "search";
  matchCount: number;
  search?: Record<string, unknown> | null;
  folder?: string | null;
  capped?: boolean;
  limit?: number;
}): string {
  const noun = input.matchCount === 1 ? "message" : "messages";
  if (input.kind === "explicit_ids") {
    return `${input.matchCount} ${noun} selected by id`;
  }
  return neutralizeText(describeSearchScope(input, noun));
}

function describeSearchScope(
  input: {
    matchCount: number;
    search?: Record<string, unknown> | null;
    folder?: string | null;
    capped?: boolean;
    limit?: number;
  },
  noun: string,
): string {
  const s = input.search ?? {};
  const parts: string[] = [];
  if (s.unread === true) parts.push("unread");
  if (s.unread === false) parts.push("read");
  if (s.flagged === true) parts.push("flagged");
  if (s.has_attachment === true) parts.push("with an attachment");
  if (typeof s.from === "string") parts.push(`from ${s.from}`);
  if (typeof s.to === "string") parts.push(`to ${s.to}`);
  if (typeof s.cc === "string") parts.push(`cc ${s.cc}`);
  if (typeof s.subject === "string") parts.push(`with subject containing ${quote(s.subject)}`);
  if (typeof s.body === "string") parts.push(`with body containing ${quote(s.body)}`);
  if (typeof s.text === "string") parts.push(`containing ${quote(s.text)}`);
  if (typeof s.since === "string") parts.push(`received on or after ${s.since}`);
  if (typeof s.before === "string") parts.push(`received before ${s.before}`);
  if (typeof s.raw === "string") parts.push(`matching the raw query ${quote(s.raw)}`);

  const criteria = parts.length > 0 ? parts.join(", ") : "matching every message";
  const where = input.folder ? ` in ${input.folder}` : "";
  // The cap is part of the truth of the selection: with more matches than the
  // limit, this plan covers the first N and the rest survive. Saying so in the
  // description is the only place the card can learn it, since contract §3 has
  // no field for it.
  const capped = input.capped
    ? ` (capped at the ${input.limit ?? input.matchCount}-message limit; more may match)`
    : "";
  return `${input.matchCount} ${noun} ${criteria}${where}${capped}`;
}

// ---------------------------------------------------------------------------
// Plan creation
// ---------------------------------------------------------------------------

/** One card sample row (contract §3). Built in memory; never persisted. */
export interface PlanSampleRow {
  from: string;
  subject: string;
  date: string;
}

export interface BulkPlanInput {
  action: BulkAction;
  inbox: { id: string; email_address: string; provider: string };
  /**
   * The EXACT ids the operation would have acted on, already resolved by the
   * calling handler. `match_count` is their length, so it is exact by
   * construction rather than by promise (contract §3).
   */
  message_ids: string[];
  /** Provider-native destination id, already resolved. Move actions only. */
  destination_id?: string | null;
  /** Destination as a human would name it, for the card. */
  destination_label?: string | null;
  permanent?: boolean;
  /** The normalized search, for the description and the §5 caveats. */
  search?: Record<string, unknown> | null;
  folder?: string | null;
  capped?: boolean;
  limit?: number;
  /** Newest-first preview rows. Returned once, never written to the database. */
  sample?: PlanSampleRow[];
}

/**
 * The frozen scope, as it is encrypted into `bulk_plans.scope`.
 *
 * Note what is absent: no query, no search object, no subjects, no senders.
 * `description` is a pre-rendered sentence, so nothing here can be replayed as
 * a search even by our own code.
 */
interface FrozenScope {
  message_ids: string[];
  destination_id: string | null;
  destination_label: string | null;
  permanent: boolean;
  description: string;
  folder: string | null;
}

/**
 * Freeze a resolved bulk operation as a plan and return the card envelope.
 *
 * Called by the four handlers in `index.ts` in place of executing, once they
 * have done every validation, capability gate and id resolution they would have
 * done anyway. Creating the plan is therefore the last step before the
 * operation would have run, which is what makes the frozen set exactly the set
 * that would have been acted on.
 */
export async function createBulkPlan(
  deps: BulkDeps,
  caller: BulkCaller,
  input: BulkPlanInput,
): Promise<BulkToolResult> {
  const at = nowMs(deps);
  const kind: "explicit_ids" | "search" = input.search ? "search" : "explicit_ids";
  const permanent = input.permanent === true;
  const matchCount = input.message_ids.length;

  const description = describeScope({
    kind,
    matchCount,
    search: input.search,
    folder: input.folder,
    capped: input.capped,
    limit: input.limit,
  });

  const scope: FrozenScope = {
    message_ids: input.message_ids,
    destination_id: input.destination_id ?? null,
    destination_label: input.destination_label ?? null,
    permanent,
    description,
    folder: input.folder ?? null,
  };

  const ciphertext = await deps.encrypt(JSON.stringify(scope));
  const expiresAt = new Date(at + BULK_PLAN_TTL_MS).toISOString();

  const { data, error } = await deps.db
    .from("bulk_plans")
    .insert({
      workspace_id: caller.workspace_id,
      inbox_id: input.inbox.id,
      api_key_id: caller.id,
      operation: operationForAction(input.action),
      action: input.action,
      scope: { v: 1, data: ciphertext },
      scope_encrypted: true,
      match_count: matchCount,
      scope_kind: kind,
      permanent,
      status: "pending",
      expires_at: expiresAt,
    })
    .select("id")
    .maybeSingle();

  if (error || !data) {
    console.error("[mcp-server] bulk_plan_create_failed", {
      inbox_id: input.inbox.id,
      action: input.action,
      error: error?.message,
    });
    return failureResult(
      "error",
      {
        outcome: "failed",
        headline: "The preview could not be prepared.",
        detail:
          "Nothing was changed in the mailbox. Try the same request again in a moment.",
        affected_count: 0,
        dashboard_url: dashboardUrl(deps),
        error_code: "plan_write_failed",
      },
      "not_pending",
      "bulk_plan_write_failed",
    );
  }

  const planId = (data as { id: string }).id;
  // The sample rows are the only part of this envelope that comes straight from
  // inbound mail: `from` is a sender display name and `subject` is a subject
  // line, both written by whoever sent the message. A U+202E in either makes the
  // preview lie about which messages a bulk delete will take. Neutralised here,
  // at the one point where they enter the envelope. (The card neutralises again
  // on ingest; this covers the dashboard and any other reader of the same rows.)
  const sample = (input.sample ?? []).slice(0, MAX_PLAN_SAMPLE).map((row) => ({
    from: neutralizeText(row.from),
    subject: neutralizeText(row.subject),
    date: neutralizeText(row.date),
  }));

  const envelope = {
    schema_version: CARD_SCHEMA_VERSION,
    card: "bulk_plan",
    dashboard_url: dashboardUrl(deps),
    state: "pending",
    plan: {
      plan_id: planId,
      operation: operationForAction(input.action),
      action: input.action,
      expires_at: expiresAt,
      inbox: {
        inbox_id: input.inbox.id,
        email_address: neutralizeText(input.inbox.email_address),
        provider: input.inbox.provider,
      },
      scope: {
        kind,
        // `description` is already neutralised by describeScope.
        description,
        // Folder and destination labels are mailbox-controlled names.
        folder: input.folder ? neutralizeText(input.folder) : null,
        destination: input.destination_label ? neutralizeText(input.destination_label) : null,
      },
      match_count: matchCount,
      sample,
      sample_truncated: (input.sample ?? []).length > MAX_PLAN_SAMPLE ||
        sample.length < matchCount,
    },
    provider: bulkProviderBlock({
      provider: input.inbox.provider,
      action: input.action,
      permanent,
      facts: deps.compatibility(input.inbox.provider),
      searchFields: input.search ? Object.keys(input.search) : [],
    }),
    actor: { can_decide: true, reason: null },
  };

  const verb = isDeleteAction(input.action)
    ? (permanent ? "permanently delete" : "delete")
    : `move to ${envelope.plan.scope.destination ?? "the destination folder"}`;

  // Model-visible text. Contract §7: the match count and the scope description
  // belong here; the sample rows deliberately do not.
  return cardResult(
    envelope,
    `Nothing has been changed yet. This is a preview of a bulk operation on ` +
      `${envelope.plan.inbox.email_address}: ${verb} ${description}. ` +
      `Review it in the card above and choose Execute to run it, or let it lapse. ` +
      `The plan is frozen — the exact ${matchCount} message(s) are already chosen, so ` +
      `mail arriving in the meantime is not included — expires at ${expiresAt}, and can run once. ` +
      `plan_id: ${planId}`,
  );
}

// ---------------------------------------------------------------------------
// Loading a pending plan, with every guard re-applied
// ---------------------------------------------------------------------------

interface BulkPlanRow {
  id: string;
  workspace_id: string;
  inbox_id: string;
  api_key_id: string | null;
  operation: string;
  action: string;
  scope: unknown;
  scope_encrypted: boolean | null;
  match_count: number;
  scope_kind: string;
  permanent: boolean;
  status: string;
  created_at: string | null;
  expires_at: string | null;
  [key: string]: unknown;
}

type LoadResult =
  | { ok: true; row: BulkPlanRow }
  | { ok: false; failure: BulkToolResult };

/**
 * Fetch a pending plan, re-verifying everything from scratch.
 *
 * **A plan_id from the caller proves nothing.** Every guard is applied on every
 * call, because the caller may be a hostile agent that learned an id from
 * anywhere — a transcript, a log, a guess:
 *
 *   1. the id is a UUID (a malformed id never reaches the database);
 *   2. the row is in the calling key's workspace — enforced in the query, not
 *      compared afterwards;
 *   3. the key's `inbox_ids` allowlist, if it has one, covers the row's inbox;
 *   4. the row is still `pending` — this is what refuses a replay;
 *   5. the row has not expired, and if it has it is retired on the spot so a
 *      later reader sees a terminal state rather than a live one.
 *
 * (2) and (3) fail with the *same* response as "no such plan", so this cannot
 * be used to probe which ids exist in other workspaces.
 */
async function loadPendingPlan(
  deps: BulkDeps,
  caller: BulkCaller,
  planId: unknown,
): Promise<LoadResult> {
  if (typeof planId !== "string" || !UUID_PATTERN.test(planId)) {
    return {
      ok: false,
      failure: failureResult(
        "error",
        {
          outcome: "failed",
          headline: "That plan could not be found.",
          detail: "plan_id must be the UUID returned with the bulk preview.",
          affected_count: 0,
          dashboard_url: dashboardUrl(deps),
          error_code: "invalid_plan_id",
        },
        "wrong_workspace",
        "invalid_plan_id",
      ),
    };
  }

  const { data, error } = await deps.db
    .from("bulk_plans")
    .select("*")
    .eq("id", planId)
    .eq("workspace_id", caller.workspace_id)
    .maybeSingle();

  if (error) {
    console.error("[mcp-server] bulk_plan_load_failed", { error: error.message });
    return { ok: false, failure: planNotFoundFailure(deps) };
  }
  const row = data as BulkPlanRow | null;
  if (!row) return { ok: false, failure: planNotFoundFailure(deps) };

  // The key's inbox allowlist is the server's data-isolation mechanism
  // everywhere else, and a plan is inbox-bound data, so it gets the same rule.
  // `!== null` rather than `length > 0` matches the primary inbox gate: an
  // empty allowlist denies everything, the fail-safe reading of "this key may
  // touch exactly these inboxes".
  if (caller.inbox_ids !== null && !caller.inbox_ids.includes(row.inbox_id)) {
    return { ok: false, failure: planNotFoundFailure(deps) };
  }

  const at = nowMs(deps);

  if (row.status !== "pending") {
    const already = row.status === "expired"
      ? "expired"
      : row.status === "executing"
      ? "still running"
      : row.status === "failed"
      ? "already attempted and failed"
      : "already executed";
    return {
      ok: false,
      failure: failureResult(
        row.status === "expired" ? "expired" : "decided_elsewhere",
        {
          outcome: row.status === "expired" ? "expired" : "decided_elsewhere",
          headline: row.status === "expired"
            ? "This preview expired before it was run."
            : `This preview was ${already}.`,
          detail: row.status === "executed"
            ? "A plan runs exactly once. Nothing was done a second time. Ask for the operation again to get a fresh preview."
            : row.status === "executing"
            ? "It was claimed by an earlier click and is running or has stopped part-way. It will not be retried automatically, because some messages may already have been changed."
            : "Nothing was changed by this call. Ask for the operation again to get a fresh preview.",
          affected_count: 0,
          dashboard_url: dashboardUrl(deps),
          error_code: null,
        },
        "not_pending",
        row.status === "expired" ? "bulk_plan_expired" : "bulk_plan_not_pending",
      ),
    };
  }

  if (isPlanExpired(row, at)) {
    // Retire it here rather than waiting for a sweep, so the next reader sees a
    // terminal state. Nothing was executed, so there is nothing to undo.
    await deps.db
      .from("bulk_plans")
      .update({ status: "expired" })
      .eq("id", row.id)
      .eq("status", "pending");
    return { ok: false, failure: expiredPlanFailure(deps) };
  }

  return { ok: true, row };
}

/** True when a still-`pending` row has passed its deadline. */
export function isPlanExpired(
  plan: { expires_at?: string | null } | null,
  atMs: number,
): boolean {
  const expiresAt = plan?.expires_at;
  if (!expiresAt) return false;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) && parsed <= atMs;
}

function expiredPlanFailure(deps: BulkDeps): BulkToolResult {
  return failureResult(
    "expired",
    {
      outcome: "expired",
      headline: "This preview expired before it was run.",
      detail:
        "A bulk preview stays runnable for 15 minutes, because it is a frozen snapshot of the " +
        "mailbox and stops describing it accurately soon after. Nothing was changed. " +
        "Ask for the operation again to get a fresh preview.",
      affected_count: 0,
      dashboard_url: dashboardUrl(deps),
      error_code: null,
    },
    "expired",
    "bulk_plan_expired",
  );
}

/**
 * The single response for "no such plan", "not your workspace" and "not an
 * inbox this key may touch". Identical by design: three different envelopes
 * would let a caller enumerate which plan ids exist elsewhere.
 */
function planNotFoundFailure(deps: BulkDeps): BulkToolResult {
  return failureResult(
    "error",
    {
      outcome: "failed",
      headline: "That plan could not be found.",
      detail:
        "It may have been run already, expired, or belong to a different workspace than this API key. " +
        "Nothing was changed.",
      affected_count: 0,
      dashboard_url: dashboardUrl(deps),
      error_code: "not_found",
    },
    "wrong_workspace",
    "bulk_plan_not_found",
  );
}

/** Decrypt the frozen scope. Returns null rather than throwing. */
async function readScope(deps: BulkDeps, row: BulkPlanRow): Promise<FrozenScope | null> {
  const stored = row.scope;
  if (!stored) return null;
  let parsed: unknown;
  if (row.scope_encrypted === false) {
    parsed = stored;
  } else {
    const ciphertext = (stored as Record<string, unknown>)["data"];
    if (typeof ciphertext !== "string") return null;
    try {
      parsed = JSON.parse(await deps.decrypt(ciphertext));
    } catch (error) {
      console.error("[mcp-server] bulk_plan_decrypt_failed", {
        plan_id: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const scope = parsed as Record<string, unknown>;
  // An EMPTY id list is a legitimate frozen scope — a search that matched
  // nothing still produces a plan, so the card can say "0 messages matched"
  // rather than leaving the user with an unrenderable result. A MISSING list is
  // corruption, and is refused. The distinction matters: "act on nothing" is the
  // safe reading of an empty array and must not be conflated with a decrypt
  // failure, whose safe reading is "refuse".
  if (!Array.isArray(scope.message_ids)) return null;
  const ids = (scope.message_ids as unknown[]).filter((v): v is string => typeof v === "string");
  return {
    message_ids: ids,
    destination_id: typeof scope.destination_id === "string" ? scope.destination_id : null,
    destination_label: typeof scope.destination_label === "string" ? scope.destination_label : null,
    permanent: scope.permanent === true,
    description: typeof scope.description === "string" ? scope.description : "",
    folder: typeof scope.folder === "string" ? scope.folder : null,
  };
}

// ---------------------------------------------------------------------------
// bulk_execute
// ---------------------------------------------------------------------------

/**
 * Run a frozen plan, exactly once.
 *
 * The ONLY argument is `plan_id`. Everything about what will happen — which
 * messages, which inbox, which destination, whether the delete is permanent —
 * comes out of the encrypted row. Extra arguments are refused by the tool
 * schema (`additionalProperties: false`) and, more importantly, are never read
 * here, so a caller that gets past the schema still cannot influence the scope.
 */
export async function runBulkExecute(
  deps: BulkDeps,
  caller: BulkCaller,
  rawArgs: unknown,
): Promise<BulkToolResult> {
  const args = rawArgs !== null && typeof rawArgs === "object" && !Array.isArray(rawArgs)
    ? rawArgs as Record<string, unknown>
    : {};

  const loaded = await loadPendingPlan(deps, caller, args["plan_id"]);
  if (!loaded.ok) return loaded.failure;
  const row = loaded.row;

  const scope = await readScope(deps, row);
  if (!scope) {
    await deps.db
      .from("bulk_plans")
      .update({ status: "failed", error_code: "scope_unreadable" })
      .eq("id", row.id)
      .eq("status", "pending");
    return failureResult(
      "error",
      {
        outcome: "failed",
        headline: "This preview could not be read.",
        detail:
          "Its stored selection could not be decrypted, so the server does not know which messages it covered. " +
          "Nothing was changed. Ask for the operation again to get a fresh preview.",
        affected_count: 0,
        dashboard_url: dashboardUrl(deps),
        error_code: "scope_unreadable",
      },
      "not_pending",
      "bulk_plan_decrypt_failed",
    );
  }

  const at = nowMs(deps);

  // ── The atomic claim ─────────────────────────────────────────────────────
  // Made BEFORE any mail is touched, and `.eq("status", "pending")` is what
  // makes it single-use: of two concurrent calls — a double-click, or a replay
  // racing the original — exactly one UPDATE matches a row and the other
  // matches none. The loser never reaches `deps.execute`, so a plan cannot run
  // twice even under a race that the earlier status read would have missed.
  const { data: claimed, error: claimError } = await deps.db
    .from("bulk_plans")
    .update({
      status: "executing",
      executed_at: new Date(at).toISOString(),
      executed_by_api_key_id: caller.id,
    })
    .eq("id", row.id)
    .eq("workspace_id", caller.workspace_id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (claimError) {
    console.error("[mcp-server] bulk_plan_claim_failed", { error: claimError.message });
    return failureResult(
      "error",
      {
        outcome: "failed",
        headline: "The operation could not be started.",
        detail: "Nothing was changed in the mailbox. Try again in a moment.",
        affected_count: 0,
        dashboard_url: dashboardUrl(deps),
        error_code: "claim_failed",
      },
      "not_pending",
      "bulk_plan_claim_failed",
    );
  }

  if (!claimed) {
    return failureResult(
      "decided_elsewhere",
      {
        outcome: "decided_elsewhere",
        headline: "This preview was already run.",
        detail:
          "A plan runs exactly once, and another call claimed this one first. " +
          "Nothing was done a second time.",
        affected_count: 0,
        dashboard_url: dashboardUrl(deps),
        error_code: null,
      },
      "not_pending",
      "bulk_plan_already_executed",
    );
  }

  const action = row.action as BulkAction;

  // ── Execution ────────────────────────────────────────────────────────────
  // Through the injected callback, which is `index.ts`'s existing provider bulk
  // path — the same code the immediate-execution route runs. There is no second
  // way to delete or move mail in this codebase and this must not become one.
  let outcome: BulkExecutionOutcome;
  try {
    outcome = await deps.execute({
      inbox_id: row.inbox_id,
      action,
      // The frozen list. Not `args`, not a re-run search, not a widened set.
      message_ids: scope.message_ids,
      destination_id: scope.destination_id,
      permanent: scope.permanent,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[mcp-server] bulk_plan_execute_failed", { plan_id: row.id, error: message });
    await deps.db
      .from("bulk_plans")
      .update({ status: "failed", error_code: "provider_error" })
      .eq("id", row.id);
    return failureResult(
      "error",
      {
        outcome: "failed",
        headline: "The operation could not be completed.",
        detail:
          `The mail provider returned an error (${message}). Some messages may already have been ` +
          "changed, so this plan will not be retried. Check the mailbox and ask again if needed.",
        affected_count: 0,
        dashboard_url: dashboardUrl(deps),
        error_code: "provider_error",
      },
      "not_pending",
      "provider_error",
    );
  }

  const totalFailure = outcome.succeeded === 0 && outcome.failed > 0;

  await deps.db
    .from("bulk_plans")
    .update({
      status: totalFailure ? "failed" : "executed",
      affected_count: outcome.succeeded,
      ...(outcome.error_code ? { error_code: outcome.error_code } : {}),
    })
    .eq("id", row.id);

  const noun = outcome.succeeded === 1 ? "message" : "messages";
  const isDelete = isDeleteAction(action);
  const verb = isDelete ? (scope.permanent ? "Permanently deleted" : "Deleted") : "Moved";
  const destination = scope.destination_label ? ` to ${scope.destination_label}` : "";
  const partial = outcome.failed > 0
    ? ` ${outcome.failed} could not be changed and were left alone.`
    : "";

  if (totalFailure) {
    return failureResult(
      "error",
      {
        outcome: "failed",
        headline: "Nothing could be changed.",
        detail:
          `All ${outcome.failed} messages failed${
            outcome.error_code ? ` (${outcome.error_code})` : ""
          }. The mailbox is unchanged. ` +
          "This plan will not run again; ask for the operation to get a fresh preview.",
        affected_count: 0,
        dashboard_url: dashboardUrl(deps),
        error_code: outcome.error_code ?? "provider_error",
      },
      "not_pending",
      outcome.error_code ?? "provider_error",
    );
  }

  const receipt: BulkReceiptFields = {
    outcome: "executed",
    headline: `${verb} ${outcome.succeeded} ${noun}${destination}.`,
    detail: isDelete && !scope.permanent
      ? `They are in Trash and can be restored from the mail provider.${partial}`
      : isDelete
      ? `They were expunged from the server and cannot be restored.${partial}`
      : `They are now in ${scope.destination_label ?? "the destination folder"}.${partial}`,
    affected_count: outcome.succeeded,
    dashboard_url: dashboardUrl(deps),
    error_code: null,
  };

  return cardResult(
    receiptEnvelope("executed", receipt, "not_pending"),
    `${receipt.headline} ${receipt.detail}`,
  );
}

// ---------------------------------------------------------------------------
// bulk_cancel
// ---------------------------------------------------------------------------

/**
 * Decline a plan, retiring it immediately instead of waiting out the TTL.
 *
 * Letting a plan lapse is already fail-safe, so this exists for the audit
 * trail rather than for safety: a lapsed plan is indistinguishable from one
 * nobody ever looked at, while a cancelled one records that a human read a
 * destructive preview and said no. That is the event worth keeping.
 *
 * Every guard `bulk_execute` applies is applied here too, for the same reason:
 * a `plan_id` from the caller proves nothing. The direction of this tool is
 * fail-safe — the worst a hostile agent achieves is that a bulk delete the user
 * wanted does not happen, and they are told so — which is why, unlike
 * approving a send, it is fine inline.
 */
export async function runBulkCancel(
  deps: BulkDeps,
  caller: BulkCaller,
  rawArgs: unknown,
): Promise<BulkToolResult> {
  const args = rawArgs !== null && typeof rawArgs === "object" && !Array.isArray(rawArgs)
    ? rawArgs as Record<string, unknown>
    : {};

  const loaded = await loadPendingPlan(deps, caller, args["plan_id"]);
  if (!loaded.ok) return loaded.failure;
  const row = loaded.row;

  // The same atomic claim as the execute path, and it matters just as much:
  // a cancel racing an execute must not record a refusal for an operation that
  // already ran. Exactly one of the two updates matches a row.
  const { data: claimed, error } = await deps.db
    .from("bulk_plans")
    .update({
      status: "cancelled",
      cancelled_at: new Date(nowMs(deps)).toISOString(),
      cancelled_by_api_key_id: caller.id,
    })
    .eq("id", row.id)
    .eq("workspace_id", caller.workspace_id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[mcp-server] bulk_plan_cancel_failed", { error: error.message });
    return failureResult(
      "error",
      {
        outcome: "failed",
        headline: "The cancellation could not be recorded.",
        detail:
          "Nothing was changed in the mailbox, and the preview will expire on its own within 15 minutes.",
        affected_count: 0,
        dashboard_url: dashboardUrl(deps),
        error_code: "write_failed",
      },
      "not_pending",
      "bulk_plan_write_failed",
    );
  }

  if (!claimed) {
    return failureResult(
      "decided_elsewhere",
      {
        outcome: "decided_elsewhere",
        headline: "This preview was already decided.",
        detail:
          "Another call ran or cancelled it first. This cancellation changed nothing.",
        affected_count: 0,
        dashboard_url: dashboardUrl(deps),
        error_code: null,
      },
      "not_pending",
      "bulk_plan_decided_elsewhere",
    );
  }

  const isDelete = isDeleteAction(row.action as BulkAction);
  const receipt: BulkReceiptFields = {
    outcome: "cancelled",
    headline: "Cancelled. Nothing was changed.",
    detail:
      `The ${row.match_count} message(s) in this preview were left exactly as they were, and the ` +
      `plan cannot be run now. Ask for the ${isDelete ? "delete" : "move"} again to get a fresh preview.`,
    affected_count: 0,
    dashboard_url: dashboardUrl(deps),
    error_code: null,
  };

  return cardResult(
    receiptEnvelope("rejected", receipt, "not_pending"),
    `${receipt.headline} ${receipt.detail}`,
  );
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export interface BulkToolDefinition {
  name: string;
  title: string;
  description: string;
  /**
   * SCOPE CHOICE — `delete:email`, with `manage:folders` accepted as well.
   *
   * A plan is either a delete or a move, and the two consolidated tools that
   * create them require exactly those two scopes. A single tool cannot demand
   * both without locking out a key that legitimately holds only one, so it
   * requires either.
   *
   * The widening this buys a hostile caller is bounded to nothing it did not
   * already have: `bulk_execute` can only run a plan that a key in the same
   * workspace already created, over an inbox on this key's allowlist, within 15
   * minutes, once. A `manage:folders`-only key can already move mail freely and
   * a `delete:email`-only key can already delete it; neither gains a capability
   * here, and running an existing plan is strictly less than the tool that
   * created it could do unattended before this feature existed.
   */
  requiredScope: "delete:email";
  altScopes?: string[];
  inputSchema: Record<string, unknown>;
  /**
   * The shape of `structuredContent`. Loose for the same reason as the
   * approval tools: the receipt payload rides in the same object as the
   * envelope, so `additionalProperties` must stay true.
   */
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/**
 * The receipt envelope both bulk tools return, as a schema.
 *
 * Mirrors mcp-app-approvals.ts#APPROVAL_CARD_OUTPUT_SCHEMA because
 * `receiptEnvelope` in this file builds the same four top-level keys.
 */
const BULK_CARD_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    schema_version: {
      type: "integer",
      description: "Card envelope version. A client that does not know this version should fall back to dashboard_url.",
    },
    card: {
      type: "string",
      description: "Which card this envelope renders. Always 'receipt' here.",
    },
    state: {
      type: "string",
      description: "Where the plan stands: executed, cancelled, expired or failed.",
    },
    dashboard_url: {
      type: "string",
      description: "Absolute link to the signed-in dashboard for this operation.",
    },
    receipt: {
      type: "object",
      description: "What the run actually did: headline, detail and the affected counts.",
      additionalProperties: true,
    },
  },
  additionalProperties: true,
} as const;

export const BULK_TOOL_DEFINITIONS: BulkToolDefinition[] = [
  {
    name: "bulk_execute",
    title: "Run a previewed bulk operation",
    description:
      "Run a bulk delete or move that was previewed as a plan. Takes only the " +
      "plan_id: which messages are affected was decided and frozen when the " +
      "preview was created, and cannot be changed here. A plan runs at most " +
      "once and expires 15 minutes after it is created.",
    requiredScope: "delete:email",
    altScopes: ["manage:folders"],
    inputSchema: {
      type: "object",
      properties: {
        plan_id: {
          type: "string",
          format: "uuid",
          description: "The plan_id returned with a bulk preview.",
        },
      },
      required: ["plan_id"],
      // Not decoration: the frozen scope is the security property of this
      // feature, and refusing unknown properties stops a caller from even
      // appearing to pass message_ids, a folder, or a permanent flag.
      additionalProperties: false,
    },
    outputSchema: BULK_CARD_OUTPUT_SCHEMA,
    annotations: {
      title: "Run a previewed bulk operation",
      readOnlyHint: false,
      // Truthfully destructive: it can delete mail. That the delete lands in
      // Trash on Gmail and Outlook is a mitigation, not a reason to under-state
      // the hint to a client that may be deciding whether to prompt.
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "bulk_cancel",
    title: "Cancel a previewed bulk operation",
    description:
      "Decline a previewed bulk delete or move, so it can never run. Takes only " +
      "the plan_id. Nothing in the mailbox changes. A preview would also expire " +
      "on its own after 15 minutes; cancelling records the decision instead of " +
      "leaving it implicit.",
    requiredScope: "delete:email",
    altScopes: ["manage:folders"],
    inputSchema: {
      type: "object",
      properties: {
        plan_id: {
          type: "string",
          format: "uuid",
          description: "The plan_id returned with a bulk preview.",
        },
      },
      required: ["plan_id"],
      additionalProperties: false,
    },
    outputSchema: BULK_CARD_OUTPUT_SCHEMA,
    annotations: {
      title: "Cancel a previewed bulk operation",
      readOnlyHint: false,
      // Cancelling destroys nothing; it prevents a change. The fail-safe
      // direction is not a destructive action — same reasoning as
      // `approval_decide`'s reject.
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

/** Dispatch by name. Unknown names return null so the caller can 404 them. */
export function runBulkTool(
  name: string,
  deps: BulkDeps,
  caller: BulkCaller,
  rawArgs: unknown,
): Promise<BulkToolResult> | null {
  switch (name) {
    case "bulk_execute":
      return runBulkExecute(deps, caller, rawArgs);
    case "bulk_cancel":
      return runBulkCancel(deps, caller, rawArgs);
    default:
      return null;
  }
}

/** Exported for `index.ts`'s argument-shape checks and for tests. */
export { invalidArgs as bulkInvalidArgs };
