// ---------------------------------------------------------------------------
// Subscription cleanup: the `subscriptions_scan` and `subscriptions_cleanup`
// tools and the 72-hour follow-up (Phase 2).
//
// Phase 1 (list-unsubscribe.ts, subscription-scan.ts, one-click-post.ts) reads
// the List-Unsubscribe headers, decides per sender which method is safe and
// knows how to send an RFC 8058 one-click POST without being turned against
// our own network. This module is what a tool call does with that:
//
//   subscriptions_scan     scan, group, freeze the result as a plan for 60
//                          minutes, return a `subscription_plan` card.
//   subscriptions_cleanup  for the senders the user picked, run the method
//                          ladder, write one ledger row per sender, then
//                          (optionally) archive what those senders already
//                          sent, resumable with `continue: true`.
//   runSubscriptionFollowUp  hourly, from pg_cron: did the sender stop?
//
// ── The ladder, per approved sender (spec D6, "Method ladder") ──────────────
//   unsafe (Junk, DKIM not aligned, mixed domains)  skipped_unsafe
//   auth_unverified  no POST; the mailto or link rung below still runs
//   one_click   server POST: requested on 2xx, failed otherwise
//   mailto      a DRAFT to the mailto address: draft_ready. Never sent. With
//               no draft possible: needs_user with `mailto_address`, no link.
//   link        the raw https link handed back: needs_user. Never fetched.
//   none        skipped_unsafe (nothing in the headers to act on)
// A one-click sender past the per-call POST cap, or reached after the time
// budget is spent, falls back to needs_user with its link. "Filter instead"
// (an automation moving future mail to Archive, spec D4) is NOT implemented
// here: creating a stored rule from this path would widen what the tool can
// do unattended, and the card contract does not ask for it yet.
//
// ── What a hostile caller can do ────────────────────────────────────────────
// Same posture as mcp-app-bulk.ts: assume the model (or a prompt-injected
// agent) calls subscriptions_cleanup directly. Everything that decides an
// action is SERVER-HELD in the encrypted plan: the URL, the mailto address and
// the message ids. The caller sends a plan_id and sender keys, and a key that
// is not in the plan is refused before anything runs. The plan is
// workspace-scoped, bound to the key's inbox allowlist, single use for the
// unsubscribe part (an atomic `used_at IS NULL` claim) and lives 60 minutes.
// The ledger's idempotency key (inbox, sender, URL host or mailto address)
// means a replay or a second scan finds its row instead of sending a second
// POST. A run killed half way is recoverable: ledger rows it left `pending`
// go stale after REQUEST_CLAIM_LEASE_MS, and its plan after PLAN_RECOVERY_MS.
//
// ── Why a separate module ───────────────────────────────────────────────────
// index.ts calls Deno.serve and builds a service-role client at module load,
// so a test cannot import it. Every dependency here is injected
// (SubscriptionDeps, FollowUpDeps), the storage included (SubscriptionStore),
// so the guards are directly testable: subscription-cleanup.test.ts.
// ---------------------------------------------------------------------------

// The Supabase query builder is handled as an opaque chain, as in
// mcp-app-bulk.ts; typing it faithfully would couple this file to supabase-js.
// deno-lint-ignore-file no-explicit-any

import { CARD_SCHEMA_VERSION } from "./mcp-app-approvals.ts";
import { createWorkBudget, type WorkBudget } from "./bulk-budget.ts";
import { groupSenders, type ListHeaderRecord, type ParsedMailto, type SenderCandidate } from "./list-unsubscribe.ts";
import type { OneClickResult } from "./one-click-post.ts";
import { redactUnsubscribeUrl } from "./one-click-post.ts";
import type { ScanResult } from "./subscription-scan.ts";
import { neutralizeText } from "./text-safety.ts";
import { SUBSCRIPTION_CARD_TOOL_NAMES } from "./mcp-app-resources.ts";

// ── Constants ───────────────────────────────────────────────────────────────

export const SUBSCRIPTION_TOOL_NAMES = SUBSCRIPTION_CARD_TOOL_NAMES;
export type SubscriptionToolName = "subscriptions_scan" | "subscriptions_cleanup";

export function isSubscriptionToolName(name: string): name is SubscriptionToolName {
  return (SUBSCRIPTION_TOOL_NAMES as readonly string[]).includes(name);
}

/** Card kind (contract: "Card contract" in the build spec). */
export const SUBSCRIPTION_CARD = "subscription_plan";

/**
 * A plan is runnable for 60 minutes. Longer than a bulk plan's 15: the user
 * reads a list of up to 200 senders and picks from it, and 15 minutes was not
 * enough to get through a 99-sender list (2026-10-24). The daily sweep
 * (20261024210100) deletes plans a day after they were made, so the TTL must
 * stay well under a day.
 */
export const SUBSCRIPTION_PLAN_TTL_MS = 60 * 60 * 1000;
/** The TTL in minutes, for the text that names it. */
export const SUBSCRIPTION_PLAN_TTL_MINUTES = SUBSCRIPTION_PLAN_TTL_MS / 60_000;
/**
 * `continue: true` (the backlog move only) is accepted for two hours after the
 * scan. The unsubscribe part stays bound to the plan's TTL; moving mail the
 * user already chose to archive is safe to finish a little later, and a
 * "Continue archiving" button that expires with the plan would strand a
 * half-archived backlog. Must stay longer than SUBSCRIPTION_PLAN_TTL_MS.
 */
export const BACKLOG_CONTINUE_WINDOW_MS = 2 * 60 * 60 * 1000;

/** A throw after the provider scan (grouping, encryption, the plan insert). */
export const SCAN_POSTPROCESS_FAILED = "scan_postprocess_failed";
/** Any other throw from this module's own code. */
export const SUBSCRIPTION_INTERNAL_ERROR = "subscription_internal_error";
/** How long a run holds the backlog lease. Longer than one call's budget. */
export const BACKLOG_LEASE_MS = 90 * 1000;

/** Spec D5 defaults. */
export const SCAN_DEFAULT_DAYS = 90;
export const SCAN_MAX_DAYS = 365;
export const SCAN_DEFAULT_LIMIT = 2000;
export const SCAN_MIN_LIMIT = 50;
export const SCAN_MAX_LIMIT = 2000;
export const SCAN_MAX_SENDERS = 200;
/** Senders named in the model-facing text; the card gets all of them. */
export const SCAN_TEXT_SENDERS = 25;

/** One call's wall-clock budget, as for every bulk tool. */
export const CLEANUP_BUDGET_MS = 25_000;
/** At most this many one-click POSTs per call. */
export const MAX_ONE_CLICK_POSTS_PER_CALL = 50;
/** Distinct hosts posted to at once. One request per host at a time, always. */
export const ONE_CLICK_HOST_CONCURRENCY = 4;
/** Do not start a POST with less than this left; hand the link back instead. */
export const ONE_CLICK_MIN_REMAINING_MS = 3_000;
/** Do not start a draft with less than this left. */
export const DRAFT_MIN_REMAINING_MS = 3_000;
/** Do not start the backlog move with less than this left. */
export const BACKLOG_MIN_REMAINING_MS = 2_000;

/** The follow-up looks 72 hours after the request. */
export const FOLLOW_UP_DELAY_MS = 72 * 60 * 60 * 1000;
/**
 * Mail in the first 24 hours after the request does not count as "still
 * sending": many senders confirm an unsubscribe by mail, and RFC 8058 allows
 * up to two days to process one.
 */
export const FOLLOW_UP_GRACE_MS = 24 * 60 * 60 * 1000;
export const FOLLOW_UP_BUDGET_MS = 40_000;
export const FOLLOW_UP_BATCH = 100;
export const FOLLOW_UP_MAX_PER_INBOX = 25;
export const FOLLOW_UP_LEASE_MS = 10 * 60 * 1000;
/** An inbox that could not be searched is tried again this much later. */
export const FOLLOW_UP_RETRY_MS = 24 * 60 * 60 * 1000;
/** After this many failed searches the row is closed without a verdict. */
export const FOLLOW_UP_MAX_ATTEMPTS = 3;

/**
 * A `pending` ledger row claimed longer ago than this belongs to a run that
 * died (an edge function killed mid-call). The next run may take it over.
 */
export const REQUEST_CLAIM_LEASE_MS = 10 * 60 * 1000;
/**
 * A plan claimed longer ago than this whose run never saved complete progress
 * is recoverable: a replay re-runs what is left instead of answering "in
 * progress" forever. A minute longer than the ledger lease, so the dead run's
 * ledger rows (claimed in its first seconds) are stale by then too.
 */
export const PLAN_RECOVERY_MS = REQUEST_CLAIM_LEASE_MS + 60 * 1000;

/** The ledger's CHECK limits (20261024210000). */
const LEDGER_MAX = { sender_key: 600, sender_domain: 255, display_name: 200, from_address: 320, url_host: 255 };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ledger statuses an earlier attempt may be retried from. */
const RETRYABLE_STATUSES = ["failed", "needs_user", "skipped_unsafe"] as const;

// ── Types ───────────────────────────────────────────────────────────────────

export type ResultStatus =
  | "requested"
  | "failed"
  | "draft_ready"
  | "needs_user"
  | "filtered"
  | "skipped_unsafe"
  | "already_done";

export type SenderMethod = SenderCandidate["method"];

export interface SubInbox {
  id: string;
  email_address: string;
  provider: string;
}

export interface SubCaller {
  id: string;
  workspace_id: string;
  /** Non-null = this key may only touch these inboxes. */
  inbox_ids: string[] | null;
  scopes: string[];
}

/** One sender as the plan stores it: server-held, encrypted at rest. */
export interface StoredSender {
  sender_key: string;
  display_name: string;
  from_address: string;
  domain: string;
  list_id: string | null;
  message_count: number;
  unread_count: number;
  read_share: number;
  last_received_at: string;
  method: SenderMethod;
  safe: boolean;
  unsafe_reason: string | null;
  https_url: string | null;
  mailto: ParsedMailto | null;
  suggested: boolean;
  /** Messages the backlog step may archive: the group's ids outside Junk. */
  archive_ids: string[];
}

export interface CleanupResult {
  sender_key: string;
  display_name: string;
  status: ResultStatus;
  method: SenderMethod;
  detail: string | null;
  draft_id: string | null;
  /** Only for needs_user: the raw https link for the user to open. */
  link: string | null;
  /**
   * Only for a mailto sender that came back needs_user (no draft could be
   * made): the plain address the user emails with the word unsubscribe.
   */
  mailto_address: string | null;
}

export interface BacklogProgress {
  action: "archive" | "keep";
  destination: string | null;
  remaining_ids: string[];
  moved: number;
  failed: number;
}

interface PlanProgress {
  v: 1;
  results: CleanupResult[];
  backlog: BacklogProgress;
  /**
   * False while the run is still going (checkpoints); a replay then answers
   * "in progress" until PLAN_RECOVERY_MS, and recovers after that. Absent
   * counts as complete.
   */
  complete?: boolean;
  /** The sender keys the run was started for, in order (for recovery). */
  selected?: string[];
}

export interface PlanRow {
  id: string;
  workspace_id: string;
  inbox_id: string;
  senders: unknown;
  senders_encrypted: boolean | null;
  window_days: number;
  scanned: number;
  truncated: boolean;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  progress: unknown;
  backlog_action: string | null;
  backlog_moved: number;
  backlog_remaining: number;
  backlog_leased_until: string | null;
}

export interface NewPlanRow {
  workspace_id: string;
  inbox_id: string;
  api_key_id: string;
  senders: { v: 1; data: string };
  senders_encrypted: true;
  sender_count: number;
  summary: Record<string, number>;
  window_days: number;
  scanned: number;
  truncated: boolean;
  expires_at: string;
}

export interface NewRequestRow {
  workspace_id: string;
  inbox_id: string;
  plan_id: string;
  api_key_id: string;
  sender_key: string;
  sender_domain: string | null;
  display_name: string | null;
  from_address: string | null;
  method: SenderMethod;
  url_host: string | null;
  idempotency_key: string;
  /** When this run took the row; a stale claim may be taken over. */
  claimed_at: string;
}

export interface RequestUpdate {
  status: Exclude<ResultStatus, "already_done">;
  http_status?: number | null;
  error?: string | null;
  draft_id?: string | null;
  requested_at?: string | null;
  check_after?: string | null;
}

export type ClaimRequestResult =
  | { claimed: true; id: string }
  | { claimed: false; status: string; draft_id: string | null }
  /** The ledger could not be written or read: nothing may be sent. */
  | { claimed: false; write_failed: true };

export interface FollowUpRow {
  id: string;
  inbox_id: string;
  from_address: string | null;
  status: string;
  requested_at: string | null;
  check_after: string | null;
  /** Failed searches so far. */
  check_attempts?: number;
}

/** Every database access this module makes. See `supabaseSubscriptionStore`. */
export interface SubscriptionStore {
  insertPlan(row: NewPlanRow): Promise<string | null>;
  loadPlan(planId: string, workspaceId: string): Promise<PlanRow | null>;
  /** The single-use claim. True when this call won it. */
  claimPlan(input: {
    planId: string;
    workspaceId: string;
    apiKeyId: string;
    nowIso: string;
    backlogAction: "archive" | "keep";
    leaseUntilIso: string;
  }): Promise<boolean>;
  /**
   * `releaseLease` false = a checkpoint mid-run: the backlog lease the claim
   * took is kept.
   */
  saveProgress(planId: string, update: {
    progress: { v: 1; data: string };
    backlog_moved: number;
    backlog_remaining: number;
  }, releaseLease?: boolean): Promise<void>;
  /**
   * Take over a plan whose run died: conditional on `used_at` still being the
   * value this call read, so two recoveries cannot both win.
   */
  reclaimPlan(input: {
    planId: string;
    workspaceId: string;
    apiKeyId: string;
    previousUsedAtIso: string;
    nowIso: string;
    leaseUntilIso: string;
  }): Promise<boolean>;
  /** Take the backlog lease when it is free or stale. */
  leaseBacklog(planId: string, nowIso: string, untilIso: string): Promise<boolean>;
  /**
   * Insert the ledger row, or take over an existing one that is retryable
   * (RETRYABLE_STATUSES) or `pending` with a claim older than `staleBeforeIso`.
   */
  claimRequest(row: NewRequestRow, staleBeforeIso: string): Promise<ClaimRequestResult>;
  /** False when the write failed. */
  finishRequest(id: string, update: RequestUpdate): Promise<boolean>;
  /** Due rows of live inboxes only (not soft-deleted, status active). */
  listDueFollowUps(nowIso: string, limit: number): Promise<FollowUpRow[]>;
  claimFollowUp(id: string, nowIso: string, staleBeforeIso: string): Promise<boolean>;
  finishFollowUp(id: string, update: {
    status: "stopped" | "still_sending" | null;
    checked_at: string;
    error?: string | null;
  }): Promise<void>;
  releaseFollowUp(id: string): Promise<void>;
  /** Push an unchecked row back (the inbox could not be searched) and release it. */
  deferFollowUp(id: string, update: { check_after: string; check_attempts: number }): Promise<void>;
}

/**
 * Counts for activity_log.error_details, written on success as well as on
 * failure: this is how the https/mailto split is measured. Value-free: no
 * names, no addresses, no URLs; hosts only, as `https://host`.
 */
export type SubscriptionAuditDetails =
  | {
    phase: "subscription_scan";
    scanned: number;
    truncated: boolean;
    senders: number;
    one_click: number;
    mailto: number;
    link: number;
    none: number;
    unsafe: number;
    suggested: number;
  }
  | {
    phase: "subscription_cleanup";
    continued: boolean;
    selected: number;
    requested: number;
    failed: number;
    draft_ready: number;
    needs_user: number;
    skipped_unsafe: number;
    already_done: number;
    one_click_hosts: string[];
    backlog_moved: number;
    backlog_remaining: number;
  };

export interface SubToolResult {
  result: {
    content: { type: "text"; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    _meta?: Record<string, unknown>;
  };
  logStatus: "success" | "error";
  logErrorCode: string | null;
  logDetails?: SubscriptionAuditDetails | null;
}

export type InboxLookup =
  | { ok: true; inbox: SubInbox }
  | { ok: false; result: SubToolResult };

export interface SubscriptionDeps {
  store: SubscriptionStore;
  /** `encryptForStorage` / `decryptStoredToken`. */
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
  /** Keyed digest for the ledger's idempotency key (HMAC in production). */
  digest(value: string): Promise<string>;
  /** Canonical app origin, no trailing slash. */
  appUrl: string;
  now?(): number;
  /** `workspaces.subscription_cleanup_enabled`. Fails closed. */
  workspaceEnabled(workspaceId: string): Promise<boolean>;
  /** resolveInboxArg with the tool's own refusal shape. */
  resolveInbox(args: Record<string, unknown>): Promise<InboxLookup>;
  /** The Phase 1 scan, inside the given budget. Throws a sentinel on failure. */
  scan(inbox: SubInbox, opts: { days: number; limit: number }, budget: WorkBudget): Promise<ScanResult>;
  postOneClick(url: string, opts: { timeoutMs: number }): Promise<OneClickResult>;
  /** Create (never send) a draft. */
  createDraft(
    inbox: SubInbox,
    draft: { to: string; subject: string; body: string },
  ): Promise<{ ok: true; draft_id: string } | { ok: false; error_code: string }>;
  /**
   * Move these ids to the provider's archive, inside the budget. `moved` and
   * `failed` are ids; anything in neither was not reached.
   */
  archive(inbox: SubInbox, ids: string[], budget: WorkBudget): Promise<{
    destination: string | null;
    moved: string[];
    failed: string[];
    error_code?: string | null;
  }>;
  /** Override CLEANUP_BUDGET_MS (tests). */
  budgetMs?: number;
}

// ── Small helpers ───────────────────────────────────────────────────────────

function nowMs(deps: { now?(): number }): number {
  return deps.now ? deps.now() : Date.now();
}

function dashboardUrl(deps: SubscriptionDeps): string {
  return `${deps.appUrl}/dashboard`;
}

/** Display names and addresses are written by whoever sent the mail. */
function clean(value: string | null | undefined, max = 200): string {
  if (!value) return "";
  // deno-lint-ignore no-control-regex
  return neutralizeText(value).replace(/[\x00-\x1F\x7F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function domainOfAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const at = address.lastIndexOf("@");
  return at === -1 ? null : address.slice(at + 1).toLowerCase() || null;
}

/** Contract `unsafe_reason`: Phase 1's `dkim_not_aligned` is the card's `dkim_fail`. */
function contractUnsafeReason(reason: string | null): string | null {
  if (!reason) return null;
  return reason === "dkim_not_aligned" ? "dkim_fail" : reason;
}

function methodLabel(method: SenderMethod): string {
  switch (method) {
    case "one_click":
      return "one-click";
    case "mailto":
      return "email (becomes a draft)";
    case "link":
      return "link to open";
    case "none":
      return "no unsubscribe option";
  }
}

/** Message of a caught throw for the operator log: bounded, never a value from the plan. */
function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

function textResult(text: string, code: string, extra: Partial<SubToolResult> = {}): SubToolResult {
  return {
    result: { content: [{ type: "text", text }], isError: true, _meta: { error_code: code } },
    logStatus: "error",
    logErrorCode: code,
    ...extra,
  };
}

function flagOffResult(): SubToolResult {
  return textResult(
    "Subscription cleanup is not available for this workspace yet. Nothing was scanned or changed.",
    "feature_not_enabled",
  );
}

type EnvelopeState = "pending" | "executed" | "expired" | "error";

function envelope(
  deps: SubscriptionDeps,
  state: EnvelopeState,
  subscriptions: Record<string, unknown>,
  actor: { can_decide: boolean; reason: string | null },
  error?: { code: string; message: string },
): Record<string, unknown> {
  return {
    schema_version: CARD_SCHEMA_VERSION,
    card: SUBSCRIPTION_CARD,
    dashboard_url: dashboardUrl(deps),
    state,
    actor,
    subscriptions,
    ...(error ? { error } : {}),
  };
}

/** A renderable failure: card envelope with state error or expired. */
function envelopeFailure(
  deps: SubscriptionDeps,
  state: "error" | "expired",
  code: string,
  message: string,
  planId: string | null,
  reason: string,
): SubToolResult {
  return {
    result: {
      content: [{ type: "text", text: message }],
      structuredContent: envelope(deps, state, { plan_id: planId }, { can_decide: false, reason }, {
        code,
        message,
      }),
      isError: true,
      _meta: { error_code: code },
    },
    logStatus: "error",
    logErrorCode: code,
  };
}

function invalidArgs(deps: SubscriptionDeps, message: string): SubToolResult {
  return envelopeFailure(deps, "error", "invalid_arguments", message, null, "not_pending");
}

/** One response for "no such plan", "another workspace" and "not this key's inbox". */
function planNotFound(deps: SubscriptionDeps): SubToolResult {
  return envelopeFailure(
    deps,
    "error",
    "plan_not_found",
    "That subscription plan could not be found. It may belong to a different workspace or inbox than " +
      "this connection. Nothing was changed. Run subscriptions_scan again for a fresh plan.",
    null,
    "wrong_workspace",
  );
}

function scanErrorResult(error: unknown): SubToolResult {
  const raw = error instanceof Error ? error.message : String(error);
  const code = /^[a-z][a-z0-9_]{2,63}$/.test(raw) ? raw : "provider_error";
  const auth = code.endsWith("_auth_failed");
  return textResult(
    auth
      ? "The mailbox refused the sign-in, so it could not be scanned. Reconnect the inbox in the MCPEmails dashboard and try again. Nothing was changed."
      : `The mailbox could not be scanned (${code}). Nothing was changed. Try again in a moment.`,
    code,
  );
}

// ── Plan encoding ───────────────────────────────────────────────────────────

/** Turn Phase 1 candidates into what the plan stores. */
export function storedSendersOf(candidates: SenderCandidate[], records: ListHeaderRecord[]): StoredSender[] {
  const junkIds = new Set(records.filter((r) => r.inJunk).map((r) => r.messageId));
  return candidates.map((c) => ({
    sender_key: c.senderKey,
    display_name: c.displayName,
    from_address: c.fromAddress,
    domain: c.domain,
    list_id: c.listId,
    message_count: c.messageCount,
    unread_count: c.unreadCount,
    read_share: c.readShare,
    last_received_at: c.lastReceivedAt,
    method: c.method,
    safe: c.safe,
    unsafe_reason: c.unsafeReason ?? null,
    https_url: c.httpsUrl ?? null,
    mailto: c.mailto ?? null,
    suggested: c.suggested,
    // Junk is never archived: moving spam out of Junk is the opposite of
    // cleaning up.
    archive_ids: c.messageIds.filter((id) => !junkIds.has(id)),
  }));
}

/** The plan's senders as the card sees them: no URL, no message id. */
export function publicSender(s: StoredSender): Record<string, unknown> {
  const urlHost = s.method === "mailto"
    ? domainOfAddress(s.mailto?.address)
    : s.method === "one_click" || s.method === "link"
    ? hostOf(s.https_url)
    : null;
  return {
    sender_key: s.sender_key,
    display_name: clean(s.display_name) || clean(s.from_address),
    from_address: clean(s.from_address, 320),
    domain: clean(s.domain, 255),
    list_id: s.list_id ? clean(s.list_id, 255) : null,
    message_count: s.message_count,
    unread_count: s.unread_count,
    read_share: Math.round(s.read_share * 100) / 100,
    last_received_at: s.last_received_at,
    method: s.method,
    safe: s.safe,
    unsafe_reason: contractUnsafeReason(s.unsafe_reason),
    url_host: urlHost,
    suggested: s.suggested,
  };
}

export function summaryOf(senders: StoredSender[]): Record<string, number> {
  const count = (m: SenderMethod) => senders.filter((s) => s.method === m).length;
  return {
    senders: senders.length,
    one_click: count("one_click"),
    mailto: count("mailto"),
    link: count("link"),
    none: count("none"),
    unsafe: senders.filter((s) => !s.safe).length,
  };
}

async function readSenders(deps: SubscriptionDeps, row: PlanRow): Promise<StoredSender[] | null> {
  let parsed: unknown;
  try {
    if (row.senders_encrypted === false) parsed = row.senders;
    else {
      const data = (row.senders as Record<string, unknown> | null)?.["data"];
      if (typeof data !== "string") return null;
      parsed = JSON.parse(await deps.decrypt(data));
    }
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed as StoredSender[] : null;
}

async function readProgress(deps: SubscriptionDeps, row: PlanRow): Promise<PlanProgress | null> {
  const data = (row.progress as Record<string, unknown> | null)?.["data"];
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(await deps.decrypt(data));
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.results) || !parsed.backlog) return null;
    return parsed as PlanProgress;
  } catch {
    return null;
  }
}

function inboxBlock(inbox: SubInbox): Record<string, unknown> {
  return { inbox_id: inbox.id, email_address: clean(inbox.email_address, 320), provider: inbox.provider };
}

function planBlock(
  planId: string,
  expiresAt: string,
  inbox: SubInbox,
  meta: { window_days: number; scanned: number; truncated: boolean },
  senders: StoredSender[],
): Record<string, unknown> {
  return {
    plan_id: planId,
    expires_at: expiresAt,
    inbox: inboxBlock(inbox),
    window_days: meta.window_days,
    scanned: meta.scanned,
    truncated: meta.truncated,
    summary: summaryOf(senders),
    senders: senders.map(publicSender),
  };
}

// ── subscriptions_scan ──────────────────────────────────────────────────────

function intArg(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return Math.min(max, Math.max(min, value));
}

/**
 * A throw from this module's own code is a tool error with a stable code, not
 * an unhandled -32603 the model can only retry blind.
 */
function internalErrorResult(tool: SubscriptionToolName, error: unknown): SubToolResult {
  console.error(`[subscriptions] ${tool}: internal_error`, { error: errorText(error) });
  return textResult(
    tool === "subscriptions_scan"
      ? "The scan failed on the server. Nothing was changed. Try again in a moment."
      : "The cleanup stopped on a server error. Senders already handled are recorded and are never asked " +
        "twice: call subscriptions_cleanup again with the same plan_id and sender_keys to see what was done " +
        "(a run that stopped half way is picked up again after about 10 minutes).",
    SUBSCRIPTION_INTERNAL_ERROR,
  );
}

export async function runSubscriptionsScan(
  deps: SubscriptionDeps,
  caller: SubCaller,
  rawArgs: unknown,
): Promise<SubToolResult> {
  try {
    return await scanInner(deps, caller, rawArgs);
  } catch (error) {
    return internalErrorResult("subscriptions_scan", error);
  }
}

async function scanInner(
  deps: SubscriptionDeps,
  caller: SubCaller,
  rawArgs: unknown,
): Promise<SubToolResult> {
  if (!(await deps.workspaceEnabled(caller.workspace_id))) return flagOffResult();
  const args = (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs))
    ? rawArgs as Record<string, unknown>
    : {};
  const days = intArg(args.days, SCAN_DEFAULT_DAYS, 1, SCAN_MAX_DAYS);
  const limit = intArg(args.limit, SCAN_DEFAULT_LIMIT, SCAN_MIN_LIMIT, SCAN_MAX_LIMIT);
  if (days === null) return textResult("subscriptions_scan: days must be a whole number of days (1 to 365).", "-32602");
  if (limit === null) return textResult("subscriptions_scan: limit must be a whole number (50 to 2000).", "-32602");

  const lookup = await deps.resolveInbox(args);
  if (!lookup.ok) return lookup.result;
  const inbox = lookup.inbox;

  const budget = createWorkBudget(deps.budgetMs ?? CLEANUP_BUDGET_MS, deps.now ?? Date.now);
  let scan: ScanResult;
  try {
    scan = await deps.scan(inbox, { days, limit }, budget);
  } catch (error) {
    return scanErrorResult(error);
  }

  // Everything after the provider scan is our own code (grouping, encryption,
  // the plan insert). A throw there used to escape as an unhandled -32603
  // ("Maximum call stack size exceeded" from the encoder, 2026-10-24); now it
  // is a tool error with a stable code, and nothing has changed yet.
  let senders: StoredSender[];
  let summary: Record<string, number>;
  let expiresAt: string;
  let planId: string | null;
  try {
    // Only Authentication-Results from the inbox's own provider count (the
    // scan context pins them); none = every sender is auth_unverified.
    const candidates = groupSenders(scan.records, { maxSenders: SCAN_MAX_SENDERS, trust: scan.trust });
    senders = storedSendersOf(candidates, scan.records);
    summary = summaryOf(senders);
    expiresAt = new Date(nowMs(deps) + SUBSCRIPTION_PLAN_TTL_MS).toISOString();

    planId = await deps.store.insertPlan({
      workspace_id: caller.workspace_id,
      inbox_id: inbox.id,
      api_key_id: caller.id,
      senders: { v: 1, data: await deps.encrypt(JSON.stringify(senders)) },
      senders_encrypted: true,
      sender_count: senders.length,
      summary,
      window_days: days,
      scanned: scan.scanned,
      truncated: scan.truncated,
      expires_at: expiresAt,
    });
  } catch (error) {
    console.error("[subscriptions] scan_postprocess_failed", { scanned: scan.scanned, error: errorText(error) });
    return textResult(
      "The scan read the mailbox but could not build or save the list of senders. Nothing was changed. " +
        "Try again with a smaller limit (for example limit: 500).",
      SCAN_POSTPROCESS_FAILED,
    );
  }
  if (!planId) {
    return textResult(
      "The scan finished but its result could not be saved. Nothing was changed. Try again in a moment.",
      "plan_write_failed",
    );
  }

  const meta = { window_days: days, scanned: scan.scanned, truncated: scan.truncated };
  const structured = envelope(deps, "pending", planBlock(planId, expiresAt, inbox, meta, senders), {
    can_decide: true,
    reason: null,
  });

  return {
    result: {
      content: [{ type: "text", text: scanText(inbox, planId, expiresAt, meta, senders, summary) }],
      structuredContent: structured,
      isError: false,
    },
    logStatus: "success",
    logErrorCode: null,
    logDetails: {
      phase: "subscription_scan",
      scanned: scan.scanned,
      truncated: scan.truncated,
      senders: summary.senders,
      one_click: summary.one_click,
      mailto: summary.mailto,
      link: summary.link,
      none: summary.none,
      unsafe: summary.unsafe,
      suggested: senders.filter((s) => s.suggested).length,
    },
  };
}

/**
 * The model-facing summary. Names, counts and methods; never a URL. Display
 * names are quoted with JSON.stringify: they are text written by the sender.
 */
function scanText(
  inbox: SubInbox,
  planId: string,
  expiresAt: string,
  meta: { window_days: number; scanned: number; truncated: boolean },
  senders: StoredSender[],
  summary: Record<string, number>,
): string {
  const lines: string[] = [];
  const mailbox = clean(inbox.email_address, 320);
  lines.push(
    `Scanned ${meta.scanned} message(s) from the last ${meta.window_days} day(s) in ${mailbox}` +
      (meta.truncated ? " (stopped early: not every message in the window was read)" : "") +
      `. Found ${summary.senders} sender(s) of list mail: ${summary.one_click} one-click, ` +
      `${summary.mailto} by email, ${summary.link} by link, ${summary.none} with no unsubscribe option; ` +
      `${summary.unsafe} look unsafe and are never unsubscribed by the server.`,
  );
  const preselected = senders.filter((s) => s.suggested);
  if (senders.length > 0) {
    lines.push(
      "",
      "Top senders (the quoted sender_key first, then name, messages, read share, method):",
    );
    for (const s of senders.slice(0, SCAN_TEXT_SENDERS)) {
      lines.push(
        `- ${senderKeyLabel(s)}, ${s.message_count} message(s), ${Math.round(s.read_share * 100)}% read, ` +
          `${methodLabel(s.method)}${s.safe ? "" : ", unsafe"}${s.suggested ? ", pre-selected" : ""}`,
      );
    }
    if (senders.length > SCAN_TEXT_SENDERS) {
      lines.push(
        `- and ${senders.length - SCAN_TEXT_SENDERS} more in the card ` +
          "(their sender_key values are in structuredContent.subscriptions.senders).",
      );
    }
  }
  // The card ticks exactly the `suggested` senders, and the card's selection
  // is what its button cleans up. Name every one of them so the model's reply
  // describes the card the user is looking at (2026-10-24: the reply said
  // GitHub and LinkedIn were left out while the card had them ticked).
  lines.push("");
  if (preselected.length === 0) {
    lines.push("Pre-selected on the card: none. The user ticks the senders to clean up.");
  } else {
    lines.push(`Pre-selected on the card (${preselected.length}), ticked when the card opens:`);
    for (const s of preselected) lines.push(`- ${senderKeyLabel(s)}`);
  }
  lines.push(
    "Whatever is ticked on the card when the user presses its button is what gets unsubscribed, not what " +
      "you write here. When you reply, describe exactly this pre-selection. If you think a pre-selected " +
      "sender should be kept, say it is ticked and ask the user to untick it on the card; do not say it was " +
      "left out.",
  );
  lines.push(
    "",
    "Nothing has been changed. Without the card, call subscriptions_cleanup with this plan_id and the " +
      "sender_keys the user chose, copied exactly as quoted above" +
      (senders.length > 0 ? ` (for example ${JSON.stringify(senders.slice(0, 2).map((s) => s.sender_key))})` : "") +
      ". Display names, addresses and domains are not sender_keys, and only keys from this plan are " +
      "accepted. Pass backlog \"archive\" to " +
      "also archive what those senders already sent, or \"keep\". One-click senders are unsubscribed by the " +
      "server; senders that unsubscribe by email get a draft in the Drafts folder that the user sends " +
      "themselves (nothing is sent); link-only senders come back as a link for the user to open.",
    `plan_id: ${planId} (expires ${expiresAt}, ${SUBSCRIPTION_PLAN_TTL_MINUTES} minutes after the scan; runs once)`,
  );
  return lines.join("\n");
}

/**
 * `"<sender_key>": "<name>"`. Both quoted with JSON.stringify: the key so it
 * reads as one exact token to copy (a bare `list:news.example.com: Name` read
 * as a label and a value), the name because the sender wrote it.
 */
function senderKeyLabel(s: StoredSender): string {
  const name = JSON.stringify(clean(s.display_name, 80) || clean(s.from_address, 80));
  return `${JSON.stringify(s.sender_key)}: ${name}`;
}

// ── subscriptions_cleanup ───────────────────────────────────────────────────

interface CleanupArgs {
  planId: string;
  senderKeys: string[];
  backlog: "archive" | "keep";
  continueBacklog: boolean;
}

/** What every sender_keys refusal says about the expected shape. */
const SENDER_KEYS_SHAPE =
  "Expected the quoted sender_key strings from the subscriptions_scan text (or " +
  "structuredContent.subscriptions.senders[].sender_key), for example " +
  "[\"list:news.example.com\", \"from:deals@example.com\"]. Nothing was changed.";

function describeJsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
}

/** At most this many keys are named back in a refusal. */
const REFUSAL_MAX_KEYS = 40;

function quotedKeys(keys: string[]): string {
  const shown = keys.slice(0, REFUSAL_MAX_KEYS).map((k) => JSON.stringify(k));
  return shown.join(", ") + (keys.length > REFUSAL_MAX_KEYS ? `, and ${keys.length - REFUSAL_MAX_KEYS} more` : "");
}

/** The pre-selected keys, or a pointer to where the keys are when none are. */
function validKeysHint(senders: StoredSender[]): string {
  const preselected = senders.filter((s) => s.suggested).map((s) => s.sender_key);
  if (preselected.length > 0) {
    return `The senders pre-selected on the card are: [${quotedKeys(preselected)}].`;
  }
  return senders.length > 0
    ? `This plan's sender_keys include: [${quotedKeys(senders.map((s) => s.sender_key))}].`
    : "This plan has no senders.";
}

/**
 * For a key that is not in the plan, the plan key it most likely meant: the
 * same key in another case, the key without its `list:` / `from:` prefix, or
 * the sender's address, display name or domain when exactly one sender has
 * it. A HINT only, never a substitute: the call is still refused, and the
 * caller must send the real key (mcp-server CLAUDE.md, "hint, don't alias").
 */
export function guessSenderKey(value: string, senders: StoredSender[]): string | null {
  const v = value.trim().replace(/^["'<]+|["'>]+$/g, "").trim().toLowerCase();
  if (!v) return null;
  const unique = (matches: StoredSender[]) => matches.length === 1 ? matches[0].sender_key : null;
  return unique(senders.filter((s) => s.sender_key.toLowerCase() === v)) ??
    unique(senders.filter((s) => s.sender_key === `list:${v}` || s.sender_key === `from:${v}`)) ??
    unique(senders.filter((s) => s.from_address.trim().toLowerCase() === v)) ??
    unique(senders.filter((s) => clean(s.display_name).toLowerCase() === v)) ??
    unique(senders.filter((s) => s.domain.toLowerCase() === v || (s.list_id ?? "").toLowerCase() === v));
}

function unknownKeysResult(deps: SubscriptionDeps, planId: string, unknown: string[], senders: StoredSender[]) {
  const shown = unknown.slice(0, 10).map((k) => {
    const guess = guessSenderKey(k, senders);
    const quoted = JSON.stringify(clean(k, 120));
    return guess ? `${quoted} (did you mean ${JSON.stringify(guess)}?)` : quoted;
  });
  return envelopeFailure(
    deps,
    "error",
    "unknown_sender_keys",
    `subscriptions_cleanup: ${unknown.length} sender key(s) are not in this plan: ${shown.join(", ")}` +
      (unknown.length > 10 ? `, and ${unknown.length - 10} more` : "") +
      ". A sender_key is the quoted string before each sender's name in the subscriptions_scan text, such as " +
      "\"list:news.example.com\" or \"from:deals@example.com\", copied exactly; a display name, address or " +
      `domain is not one. ${validKeysHint(senders)} Nothing was changed; call again with keys from this plan.`,
    planId,
    "not_pending",
  );
}

function emptyKeysResult(deps: SubscriptionDeps, planId: string, senders: StoredSender[]) {
  return envelopeFailure(
    deps,
    "error",
    "invalid_arguments",
    "subscriptions_cleanup: sender_keys is empty, so there is nothing to unsubscribe from. Pass the " +
      `sender_key of every sender the user chose. ${validKeysHint(senders)} If the user is choosing on ` +
      "the card, do not call this tool: the card runs the cleanup itself. Nothing was changed.",
    planId,
    "not_pending",
  );
}

function parseCleanupArgs(rawArgs: unknown): CleanupArgs | string {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return "arguments must be an object with plan_id and sender_keys.";
  }
  const args = rawArgs as Record<string, unknown>;
  const planId = args.plan_id;
  if (typeof planId !== "string" || !UUID_PATTERN.test(planId)) {
    return "plan_id must be the UUID returned by subscriptions_scan.";
  }
  const keys = args.sender_keys;
  if (!Array.isArray(keys)) {
    return `sender_keys must be a list of strings, not ${describeJsonType(keys)}. ${SENDER_KEYS_SHAPE}`;
  }
  const bad = keys.findIndex((k) => typeof k !== "string" || k.length === 0 || k.length > 600);
  if (bad !== -1) {
    const item = keys[bad];
    const what = typeof item === "string" ? (item.length === 0 ? "an empty string" : "over 600 characters") : describeJsonType(item);
    return `sender_keys[${bad}] is ${what}; every item must be one sender_key string. ${SENDER_KEYS_SHAPE}`;
  }
  if (keys.length > SCAN_MAX_SENDERS) return `sender_keys may name at most ${SCAN_MAX_SENDERS} senders.`;
  const backlog = args.backlog ?? "keep";
  if (backlog !== "archive" && backlog !== "keep") return "backlog must be \"archive\" or \"keep\".";
  const cont = args.continue ?? false;
  if (typeof cont !== "boolean") return "continue must be true or false.";
  // An empty list without continue is refused AFTER the plan is loaded
  // (emptyKeysResult), so the refusal can name the plan's pre-selected keys.
  return {
    planId,
    senderKeys: [...new Set(keys as string[])],
    backlog,
    continueBacklog: cont,
  };
}

/**
 * HMAC(inbox, sender, target): the ledger's replay guard. The target is the
 * URL HOST for https and the ADDRESS for mailto, never the full URI: senders
 * put a per-message token in the URL, so keying on it would let a second scan
 * (newer message, new token) send a second POST for the same sender.
 */
export function idempotencyInput(inboxId: string, sender: StoredSender): string {
  const target = sender.method === "mailto"
    ? `mailto:${(sender.mailto?.address ?? "").trim().toLowerCase()}`
    : sender.method === "one_click" || sender.method === "link"
    ? `https:${(hostOf(sender.https_url) ?? "").toLowerCase()}`
    : "";
  return `unsubscribe:${inboxId}\n${sender.sender_key}\n${target}`;
}

/** A ledger text column cut to its CHECK limit; empty becomes null. */
function ledgerText(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const out = value.slice(0, max);
  return out.length > 0 ? out : null;
}

export async function runSubscriptionsCleanup(
  deps: SubscriptionDeps,
  caller: SubCaller,
  rawArgs: unknown,
): Promise<SubToolResult> {
  try {
    return await cleanupInner(deps, caller, rawArgs);
  } catch (error) {
    return internalErrorResult("subscriptions_cleanup", error);
  }
}

async function cleanupInner(
  deps: SubscriptionDeps,
  caller: SubCaller,
  rawArgs: unknown,
): Promise<SubToolResult> {
  if (!(await deps.workspaceEnabled(caller.workspace_id))) return flagOffResult();
  const parsed = parseCleanupArgs(rawArgs);
  if (typeof parsed === "string") return invalidArgs(deps, `subscriptions_cleanup: ${parsed}`);

  const row = await deps.store.loadPlan(parsed.planId, caller.workspace_id);
  if (!row) return planNotFound(deps);
  if (caller.inbox_ids !== null && !caller.inbox_ids.includes(row.inbox_id)) return planNotFound(deps);

  const lookup = await deps.resolveInbox({ inbox_id: row.inbox_id });
  if (!lookup.ok) return lookup.result;
  const inbox = lookup.inbox;

  const senders = await readSenders(deps, row);
  if (!senders) {
    return envelopeFailure(
      deps,
      "error",
      "plan_unreadable",
      "This subscription plan could not be read. Nothing was changed. Run subscriptions_scan again.",
      row.id,
      "not_pending",
    );
  }
  const byKey = new Map(senders.map((s) => [s.sender_key, s]));
  const unknown = parsed.senderKeys.filter((k) => !byKey.has(k));
  if (unknown.length > 0) return unknownKeysResult(deps, row.id, unknown, senders);
  if (!parsed.continueBacklog && parsed.senderKeys.length === 0) return emptyKeysResult(deps, row.id, senders);
  const selected = parsed.senderKeys.map((k) => byKey.get(k)!);
  const at = nowMs(deps);
  const meta = { window_days: row.window_days, scanned: row.scanned, truncated: row.truncated };

  if (parsed.continueBacklog) {
    return await continueBacklog(deps, caller, row, inbox, byKey, senders, meta, at, parsed);
  }

  if (row.used_at) return await replayOrRecover(deps, caller, row, inbox, byKey, senders, meta, at, parsed);

  const expiresMs = Date.parse(row.expires_at);
  if (Number.isFinite(expiresMs) && expiresMs <= at) {
    return envelopeFailure(
      deps,
      "expired",
      "plan_expired",
      `This subscription plan expired (plans last ${SUBSCRIPTION_PLAN_TTL_MINUTES} minutes). Nothing was changed. Run subscriptions_scan again.`,
      row.id,
      "expired",
    );
  }

  const claimed = await deps.store.claimPlan({
    planId: row.id,
    workspaceId: caller.workspace_id,
    apiKeyId: caller.id,
    nowIso: new Date(at).toISOString(),
    backlogAction: parsed.backlog,
    leaseUntilIso: new Date(at + BACKLOG_LEASE_MS).toISOString(),
  });
  if (!claimed) {
    // Lost a race with a concurrent call (a double click). Its results are the
    // answer once it has written them.
    const fresh = await deps.store.loadPlan(row.id, caller.workspace_id);
    return await replayOrRecover(deps, caller, fresh ?? row, inbox, byKey, senders, meta, at, parsed);
  }

  return await executeRun(deps, caller, row, inbox, senders, meta, selected, parsed.backlog, null);
}

/**
 * The unsubscribe part and the first backlog pass of a claimed plan. Progress
 * is saved as soon as the plan is claimed, again before the one-click POSTs
 * start, and in full at the end, so a run killed half way leaves a plan a
 * replay can recover (replayOrRecover) rather than one stuck "in progress".
 * `prior` is the dead run's checkpoint when recovering: its results stand and
 * those senders are not run again.
 */
async function executeRun(
  deps: SubscriptionDeps,
  caller: SubCaller,
  row: PlanRow,
  inbox: SubInbox,
  senders: StoredSender[],
  meta: { window_days: number; scanned: number; truncated: boolean },
  selected: StoredSender[],
  backlogAction: "archive" | "keep",
  prior: PlanProgress | null,
): Promise<SubToolResult> {
  const selectedKeys = selected.map((s) => s.sender_key);
  const archiveIds = backlogAction === "archive" ? [...new Set(selected.flatMap((s) => s.archive_ids))] : [];
  const startBacklog: BacklogProgress = prior?.backlog ?? {
    action: backlogAction,
    destination: null,
    remaining_ids: archiveIds,
    moved: 0,
    failed: 0,
  };
  const earlier = new Map((prior?.results ?? []).map((r) => [r.sender_key, r]));
  const inOrder = (fresh: CleanupResult[]) => {
    const byKeyFresh = new Map(fresh.map((r) => [r.sender_key, r]));
    return selectedKeys
      .map((k) => earlier.get(k) ?? byKeyFresh.get(k))
      .filter((r): r is CleanupResult => r !== undefined);
  };
  const checkpoint = (fresh: CleanupResult[]) =>
    saveProgress(deps, row.id, {
      v: 1,
      complete: false,
      selected: selectedKeys,
      results: inOrder(fresh),
      backlog: startBacklog,
    }, false);

  await checkpoint([]);
  const budget = createWorkBudget(deps.budgetMs ?? CLEANUP_BUDGET_MS, deps.now ?? Date.now);
  const todo = selected.filter((s) => !earlier.has(s.sender_key));
  const results = inOrder(await runLadder(deps, caller, row.id, inbox, todo, budget, checkpoint));

  let backlog = startBacklog;
  if (backlog.action === "archive") backlog = await moveBacklog(deps, inbox, backlog, budget);

  await saveProgress(deps, row.id, { v: 1, complete: true, selected: selectedKeys, results, backlog }, true);
  return executedResult(deps, row, inbox, senders, meta, results, backlog, false);
}

/** Run the ladder for every selected sender. One-click POSTs by host, in parallel across hosts. */
async function runLadder(
  deps: SubscriptionDeps,
  caller: SubCaller,
  planId: string,
  inbox: SubInbox,
  selected: StoredSender[],
  budget: WorkBudget,
  checkpoint?: (partial: CleanupResult[]) => Promise<void>,
): Promise<CleanupResult[]> {
  const results = new Map<string, CleanupResult>();
  let posts = 0;
  const canDraft = caller.scopes.includes("manage:drafts");
  const ordered = () =>
    selected.map((s) => results.get(s.sender_key)).filter((r): r is CleanupResult => r !== undefined);

  // Claim every sender's ledger row first, so the order of the work below
  // cannot change which senders count as already done.
  const claims = new Map<string, string>();
  for (const sender of selected) {
    const at = nowMs(deps);
    const claim = await deps.store.claimRequest({
      workspace_id: caller.workspace_id,
      inbox_id: inbox.id,
      plan_id: planId,
      api_key_id: caller.id,
      // Every text column cut to the migration's CHECK limits: an over-long
      // value from a hostile header must not make the insert fail.
      sender_key: sender.sender_key.slice(0, LEDGER_MAX.sender_key),
      sender_domain: ledgerText(sender.domain, LEDGER_MAX.sender_domain),
      display_name: ledgerText(clean(sender.display_name), LEDGER_MAX.display_name),
      from_address: ledgerText(sender.from_address, LEDGER_MAX.from_address),
      method: sender.method,
      url_host: ledgerText(
        sender.method === "mailto" ? domainOfAddress(sender.mailto?.address) : hostOf(sender.https_url),
        LEDGER_MAX.url_host,
      ),
      idempotency_key: await deps.digest(idempotencyInput(inbox.id, sender)),
      claimed_at: new Date(at).toISOString(),
    }, new Date(at - REQUEST_CLAIM_LEASE_MS).toISOString());
    if (claim.claimed) {
      claims.set(sender.sender_key, claim.id);
    } else if ("write_failed" in claim) {
      // FAIL CLOSED: without a ledger row a replay could send a second POST.
      results.set(sender.sender_key, {
        ...baseResult(sender),
        status: "failed",
        detail: "Nothing was sent: the server could not record the request. Try again in a moment.",
      });
    } else {
      results.set(sender.sender_key, {
        ...baseResult(sender),
        status: "already_done",
        detail: claim.status === "pending"
          ? "An earlier request for this sender has not finished; it was not repeated. If it never finishes, it can be retried after 10 minutes."
          : `Already handled earlier (${claim.status.replace(/_/g, " ")}); not repeated.`,
        draft_id: claim.draft_id,
      });
    }
  }

  const finish = async (sender: StoredSender, result: CleanupResult, update: Partial<RequestUpdate> = {}) => {
    results.set(sender.sender_key, result);
    const id = claims.get(sender.sender_key)!;
    const nowIso = new Date(nowMs(deps)).toISOString();
    const followed = result.status === "requested" || result.status === "draft_ready";
    const full: RequestUpdate = {
      status: result.status as RequestUpdate["status"],
      ...update,
      ...(followed
        ? { requested_at: nowIso, check_after: new Date(nowMs(deps) + FOLLOW_UP_DELAY_MS).toISOString() }
        : {}),
    };
    // One retry. If both fail the row stays `pending` with this run's
    // claimed_at, so the next run takes it over after REQUEST_CLAIM_LEASE_MS
    // (claimRequest): never pending forever.
    if (!(await deps.store.finishRequest(id, full)) && !(await deps.store.finishRequest(id, full))) {
      console.error("[subscriptions] request_finish_lost", { request_id: id, status: full.status });
    }
  };

  const oneClick: StoredSender[] = [];
  for (const sender of selected) {
    if (!claims.has(sender.sender_key)) continue;
    // auth_unverified is the one unsafe reason that still gets a rung: the
    // user's provider wrote no header we can believe, which rules out the
    // server POST but not a draft or a link the user acts on (list-unsubscribe.ts).
    const unverified = !sender.safe && sender.unsafe_reason === "auth_unverified";
    if (!sender.safe && !unverified) {
      await finish(sender, {
        ...baseResult(sender),
        status: "skipped_unsafe",
        detail: unsafeDetail(sender.unsafe_reason),
      });
      continue;
    }
    // Never a POST for a sender that could not be verified: its one-click
    // link is handed back like any other link.
    const rung: SenderMethod = sender.method === "one_click" && unverified ? "link" : sender.method;
    switch (rung) {
      case "one_click":
        oneClick.push(sender);
        break;
      case "link":
        await finish(sender, {
          ...baseResult(sender),
          status: "needs_user",
          detail: unverified
            ? "This sender could not be verified, so the server did not unsubscribe automatically. Open the link to finish."
            : "This sender only offers an unsubscribe page. Open the link to finish.",
          link: sender.https_url,
        });
        break;
      case "none":
        await finish(sender, {
          ...baseResult(sender),
          status: "skipped_unsafe",
          detail: "No unsubscribe option in the mail headers.",
        });
        break;
      case "mailto":
        await finish(sender, ...(await mailtoStep(deps, inbox, sender, canDraft, budget)));
        break;
    }
  }

  // Save what is known before any POST goes out: a run killed during the
  // POSTs leaves a checkpoint, and its claimed ledger rows go stale.
  if (oneClick.length > 0 && checkpoint) await checkpoint(ordered());

  // One request per host at a time: group by host, run up to
  // ONE_CLICK_HOST_CONCURRENCY groups at once, each group in sequence.
  const groups = new Map<string, StoredSender[]>();
  for (const sender of oneClick) {
    const host = hostOf(sender.https_url) ?? "";
    const group = groups.get(host);
    if (group) group.push(sender);
    else groups.set(host, [sender]);
  }
  const queue = [...groups.values()];
  const worker = async () => {
    for (let group = queue.shift(); group; group = queue.shift()) {
      for (const sender of group) {
        const remaining = budget.remainingMs();
        if (posts >= MAX_ONE_CLICK_POSTS_PER_CALL || remaining < ONE_CLICK_MIN_REMAINING_MS) {
          await finish(sender, {
            ...baseResult(sender),
            status: "needs_user",
            detail: posts >= MAX_ONE_CLICK_POSTS_PER_CALL
              ? `Over the limit of ${MAX_ONE_CLICK_POSTS_PER_CALL} one-click requests per run. Open the link, or run a new scan for the rest.`
              : "Ran out of time for this run. Open the link, or run a new scan for the rest.",
            link: sender.https_url,
          });
          continue;
        }
        posts++;
        const outcome = await deps.postOneClick(sender.https_url!, {
          timeoutMs: Math.max(1_000, Math.min(10_000, remaining - 1_000)),
        });
        if (outcome.ok) {
          await finish(sender, {
            ...baseResult(sender),
            status: "requested",
            detail: "Unsubscribe requested from the sender.",
          }, { http_status: outcome.status });
        } else {
          await finish(sender, {
            ...baseResult(sender),
            status: "failed",
            detail: oneClickFailureDetail(outcome),
          }, { http_status: outcome.status, error: outcome.error ?? "failed" });
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ONE_CLICK_HOST_CONCURRENCY, queue.length) }, worker));

  // In the order the caller asked for them.
  return ordered();
}

function baseResult(sender: StoredSender): CleanupResult {
  return {
    sender_key: sender.sender_key,
    display_name: clean(sender.display_name) || clean(sender.from_address),
    status: "skipped_unsafe",
    method: sender.method,
    detail: null,
    draft_id: null,
    link: null,
    mailto_address: null,
  };
}

function unsafeDetail(reason: string | null): string {
  switch (reason) {
    case "in_junk":
      return "Skipped: this sender's mail is in Junk, so its unsubscribe link is not trusted.";
    case "mixed_sender_domains":
      return "Skipped: several unrelated domains send under this list name, so it is not trusted.";
    case "dkim_not_aligned":
      return "Skipped: the sender's signature does not match its address, so its unsubscribe link is not trusted.";
    case "auth_unverified":
      return "Skipped: your mail provider's check of this sender could not be read, so it was not trusted.";
    default:
      return "Skipped: this sender could not be verified.";
  }
}

function oneClickFailureDetail(outcome: OneClickResult): string {
  switch (outcome.error) {
    case "redirect":
      return "The sender's server answered with a redirect instead of confirming. Not followed.";
    case "http_error":
      return `The sender's server refused the request (HTTP ${outcome.status ?? "error"}).`;
    case "timeout":
      return "The sender's server did not answer in time.";
    case "blocked_host":
      return "The unsubscribe address points somewhere the server will not send requests to.";
    case "invalid_url":
      return "The unsubscribe address is not a valid https link.";
    default:
      return "The sender's server could not be reached.";
  }
}

async function mailtoStep(
  deps: SubscriptionDeps,
  inbox: SubInbox,
  sender: StoredSender,
  canDraft: boolean,
  budget: WorkBudget,
): Promise<[CleanupResult, Partial<RequestUpdate>]> {
  const mailto = sender.mailto!;
  if (!canDraft || budget.remainingMs() < DRAFT_MIN_REMAINING_MS) {
    // No link: the card opens https links only. The plain address goes back
    // instead, for the user to write to themselves.
    const address = mailto.address.slice(0, 320);
    return [{
      ...baseResult(sender),
      status: "needs_user",
      detail: (canDraft ? "Ran out of time to save a draft. " : "This connection cannot create drafts. ") +
        `To unsubscribe, email ${address} with the word unsubscribe.`,
      mailto_address: address,
    }, {}];
  }
  // Both come from the sender's header: no control characters in a subject
  // line (header injection), and neither may be long.
  // deno-lint-ignore no-control-regex
  const subject = (mailto.subject ?? "").replace(/[\x00-\x1F\x7F]+/g, " ").trim().slice(0, 200) || "unsubscribe";
  const body = (mailto.body ?? "").trim().slice(0, 2000) || "unsubscribe";
  const created = await deps.createDraft(inbox, { to: mailto.address, subject, body });
  if (!created.ok) {
    return [{
      ...baseResult(sender),
      status: "failed",
      detail: "The unsubscribe draft could not be created.",
    }, { error: created.error_code.slice(0, 64) }];
  }
  return [{
    ...baseResult(sender),
    status: "draft_ready",
    detail: "An unsubscribe email is waiting in Drafts. Nothing was sent: open it and send it to finish.",
    draft_id: created.draft_id,
  }, { draft_id: created.draft_id.slice(0, 1024) }];
}

async function moveBacklog(
  deps: SubscriptionDeps,
  inbox: SubInbox,
  backlog: BacklogProgress,
  budget: WorkBudget,
): Promise<BacklogProgress> {
  if (backlog.remaining_ids.length === 0 || budget.remainingMs() < BACKLOG_MIN_REMAINING_MS) return backlog;
  let outcome: Awaited<ReturnType<SubscriptionDeps["archive"]>>;
  try {
    outcome = await deps.archive(inbox, backlog.remaining_ids, budget);
  } catch (error) {
    console.warn("[subscriptions] backlog_archive_failed", {
      inbox_id: inbox.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return backlog;
  }
  const done = new Set([...outcome.moved, ...outcome.failed]);
  return {
    action: backlog.action,
    destination: outcome.destination ?? backlog.destination,
    remaining_ids: backlog.remaining_ids.filter((id) => !done.has(id)),
    moved: backlog.moved + outcome.moved.length,
    failed: backlog.failed + outcome.failed.length,
  };
}

async function saveProgress(
  deps: SubscriptionDeps,
  planId: string,
  progress: PlanProgress,
  releaseLease = true,
): Promise<void> {
  await deps.store.saveProgress(planId, {
    progress: { v: 1, data: await deps.encrypt(JSON.stringify(progress)) },
    backlog_moved: progress.backlog.moved,
    backlog_remaining: progress.backlog.remaining_ids.length,
  }, releaseLease);
}

async function continueBacklog(
  deps: SubscriptionDeps,
  caller: SubCaller,
  row: PlanRow,
  inbox: SubInbox,
  byKey: Map<string, StoredSender>,
  senders: StoredSender[],
  meta: { window_days: number; scanned: number; truncated: boolean },
  at: number,
  parsed: CleanupArgs,
): Promise<SubToolResult> {
  if (!row.used_at) {
    return envelopeFailure(
      deps,
      "error",
      "nothing_to_continue",
      "continue: true resumes the archive step of a plan that already ran, and this plan has not run yet. " +
        "Call subscriptions_cleanup without continue first. Nothing was changed.",
      row.id,
      "not_pending",
    );
  }
  const createdMs = Date.parse(row.created_at);
  if (Number.isFinite(createdMs) && createdMs + BACKLOG_CONTINUE_WINDOW_MS <= at) {
    return tooOldResult(deps, row.id);
  }
  const progress = await readProgress(deps, row);
  // A run still going, or one that died before it finished: the same answer
  // as a replay (in progress, or recovered once the lease is over).
  if (!progress || progress.complete === false) {
    return await replayOrRecover(deps, caller, row, inbox, byKey, senders, meta, at, parsed);
  }
  if (progress.backlog.action !== "archive" || progress.backlog.remaining_ids.length === 0) {
    return executedResult(deps, row, inbox, senders, meta, progress.results, progress.backlog, true);
  }
  const leased = await deps.store.leaseBacklog(
    row.id,
    new Date(at).toISOString(),
    new Date(at + BACKLOG_LEASE_MS).toISOString(),
  );
  if (!leased) return inFlight(deps, row.id);
  const budget = createWorkBudget(deps.budgetMs ?? CLEANUP_BUDGET_MS, deps.now ?? Date.now);
  const backlog = await moveBacklog(deps, inbox, progress.backlog, budget);
  await saveProgress(deps, row.id, { ...progress, backlog });
  return executedResult(deps, row, inbox, senders, meta, progress.results, backlog, true);
}

function tooOldResult(deps: SubscriptionDeps, planId: string): SubToolResult {
  return envelopeFailure(
    deps,
    "expired",
    "plan_expired",
    "This plan is too old to continue. Run subscriptions_scan again; the senders already " +
      "handled are remembered and will not be asked twice.",
    planId,
    "expired",
  );
}

function inFlight(deps: SubscriptionDeps, planId: string): SubToolResult {
  return envelopeFailure(
    deps,
    "error",
    "plan_in_progress",
    "This plan is being run by another request right now. Wait a moment and call again with continue: true.",
    planId,
    "not_pending",
  );
}

/**
 * A plan that was already claimed. Complete progress is replayed. A run that
 * is still inside PLAN_RECOVERY_MS answers "in progress". Past that, the run
 * died (the edge function was killed), so this call takes the plan over
 * (atomically on the old used_at) and runs what the dead run had not
 * finished: the senders in its checkpoint keep their results, the rest go
 * through the ladder again, guarded by the ledger as always.
 */
async function replayOrRecover(
  deps: SubscriptionDeps,
  caller: SubCaller,
  row: PlanRow,
  inbox: SubInbox,
  byKey: Map<string, StoredSender>,
  senders: StoredSender[],
  meta: { window_days: number; scanned: number; truncated: boolean },
  at: number,
  parsed: CleanupArgs,
): Promise<SubToolResult> {
  const progress = await readProgress(deps, row);
  if (progress && progress.complete !== false) {
    return executedResult(deps, row, inbox, senders, meta, progress.results, progress.backlog, true);
  }
  const usedMs = Date.parse(row.used_at ?? "");
  if (!row.used_at || !Number.isFinite(usedMs) || usedMs + PLAN_RECOVERY_MS > at) return inFlight(deps, row.id);

  const createdMs = Date.parse(row.created_at);
  if (Number.isFinite(createdMs) && createdMs + BACKLOG_CONTINUE_WINDOW_MS <= at) return tooOldResult(deps, row.id);

  const keys = progress?.selected ?? parsed.senderKeys;
  const selected = keys.map((k) => byKey.get(k)).filter((s): s is StoredSender => s !== undefined);
  if (selected.length === 0) {
    return envelopeFailure(
      deps,
      "error",
      "nothing_to_continue",
      "The earlier run of this plan stopped before it recorded which senders were picked. Call " +
        "subscriptions_cleanup again with the same plan_id and the sender_keys. Nothing else was changed.",
      row.id,
      "not_pending",
    );
  }
  const reclaimed = await deps.store.reclaimPlan({
    planId: row.id,
    workspaceId: caller.workspace_id,
    apiKeyId: caller.id,
    previousUsedAtIso: row.used_at,
    nowIso: new Date(at).toISOString(),
    leaseUntilIso: new Date(at + BACKLOG_LEASE_MS).toISOString(),
  });
  if (!reclaimed) return inFlight(deps, row.id);
  console.warn("[subscriptions] plan_recovered", { plan_id: row.id, checkpointed: progress !== null });
  const backlogAction = progress?.backlog.action ?? (row.backlog_action === "archive" ? "archive" : parsed.backlog);
  return await executeRun(deps, caller, row, inbox, senders, meta, selected, backlogAction, progress);
}

function backlogBlock(backlog: BacklogProgress): Record<string, unknown> {
  return {
    action: backlog.action,
    destination: backlog.action === "archive" ? (backlog.destination ?? "Archive") : null,
    moved: backlog.moved,
    remaining: backlog.remaining_ids.length,
    has_more: backlog.action === "archive" && backlog.remaining_ids.length > 0,
  };
}

function executedResult(
  deps: SubscriptionDeps,
  row: PlanRow,
  inbox: SubInbox,
  senders: StoredSender[],
  meta: { window_days: number; scanned: number; truncated: boolean },
  results: CleanupResult[],
  backlog: BacklogProgress,
  continued: boolean,
): SubToolResult {
  const block = backlogBlock(backlog);
  const hasMore = block.has_more === true;
  const subscriptions = {
    ...planBlock(row.id, row.expires_at, inbox, meta, senders),
    results,
    backlog: block,
  };
  const count = (s: ResultStatus) => results.filter((r) => r.status === s).length;
  const oneClickHosts = [
    ...new Set(
      results.filter((r) => r.method === "one_click" && (r.status === "requested" || r.status === "failed"))
        .map((r) => senders.find((s) => s.sender_key === r.sender_key)?.https_url)
        .filter((u): u is string => typeof u === "string")
        .map(redactUnsubscribeUrl),
    ),
  ].slice(0, 50);
  return {
    result: {
      content: [{ type: "text", text: cleanupText(results, block, continued) }],
      structuredContent: envelope(deps, "executed", subscriptions, {
        // The card may still act on this plan only to continue the archive.
        can_decide: hasMore,
        reason: hasMore ? null : "not_pending",
      }),
      isError: false,
    },
    logStatus: "success",
    logErrorCode: null,
    logDetails: {
      phase: "subscription_cleanup",
      continued,
      selected: results.length,
      requested: count("requested"),
      failed: count("failed"),
      draft_ready: count("draft_ready"),
      needs_user: count("needs_user"),
      skipped_unsafe: count("skipped_unsafe"),
      already_done: count("already_done"),
      one_click_hosts: oneClickHosts,
      backlog_moved: backlog.moved,
      backlog_remaining: backlog.remaining_ids.length,
    },
  };
}

function cleanupText(results: CleanupResult[], backlog: Record<string, unknown>, continued: boolean): string {
  const count = (s: ResultStatus) => results.filter((r) => r.status === s).length;
  const lines: string[] = [];
  if (!continued) {
    lines.push(
      `Done for ${results.length} sender(s): ${count("requested")} unsubscribe request(s) sent, ` +
        `${count("draft_ready")} unsubscribe email(s) saved as drafts (NOT sent: the user opens Drafts and sends them), ` +
        `${count("needs_user")} need the user to open a link, ${count("failed")} failed, ` +
        `${count("skipped_unsafe")} skipped as unsafe, ${count("already_done")} already handled earlier.`,
    );
  } else {
    lines.push(`Results for ${results.length} sender(s) were recorded earlier and were not run again.`);
  }
  const links = results.filter((r) => r.status === "needs_user" && r.link);
  if (links.length > 0) {
    lines.push("", "Links for the user to open (untrusted, from the senders' mail headers):");
    for (const r of links) lines.push(`- ${JSON.stringify(clean(r.display_name, 80))}: ${r.link}`);
  }
  const addresses = results.filter((r) => r.status === "needs_user" && r.mailto_address);
  if (addresses.length > 0) {
    lines.push("", "Addresses for the user to email with the word unsubscribe (untrusted, from the senders' mail headers):");
    for (const r of addresses) lines.push(`- ${JSON.stringify(clean(r.display_name, 80))}: ${r.mailto_address}`);
  }
  if (backlog.action === "archive") {
    lines.push(
      "",
      `Archived ${backlog.moved} message(s) from these senders; ${backlog.remaining} left.` +
        (backlog.has_more ? " Call subscriptions_cleanup again with the same plan_id and continue: true to archive the rest." : ""),
    );
  }
  lines.push("", "The server checks again in 3 days whether each sender stopped.");
  return lines.join("\n");
}

// ── Follow-up (pg_cron, hourly) ─────────────────────────────────────────────

export interface FollowUpDeps {
  store: SubscriptionStore;
  now?(): number;
  budgetMs?: number;
  /**
   * Is there mail from `fromAddress` in this inbox received on or after
   * `sinceIso`? Throws when the inbox cannot be searched.
   */
  search(inboxId: string, fromAddress: string, sinceIso: string): Promise<boolean>;
}

export interface FollowUpSummary {
  due: number;
  checked: number;
  stopped: number;
  still_sending: number;
  errors: number;
  /** Rows pushed back FOLLOW_UP_RETRY_MS because their inbox could not be searched. */
  deferred: number;
  /** Rows closed without a verdict after FOLLOW_UP_MAX_ATTEMPTS failures. */
  given_up: number;
}

/**
 * Check due ledger rows: one inbox at a time (never two searches against one
 * mailbox at once), at most FOLLOW_UP_MAX_PER_INBOX rows per inbox per run,
 * inside FOLLOW_UP_BUDGET_MS. Each row is leased before it is searched so two
 * overlapping runs never check one row twice.
 */
export async function runSubscriptionFollowUp(deps: FollowUpDeps): Promise<FollowUpSummary> {
  const budget = createWorkBudget(deps.budgetMs ?? FOLLOW_UP_BUDGET_MS, deps.now ?? Date.now);
  const at = nowMs(deps);
  const summary: FollowUpSummary = {
    due: 0,
    checked: 0,
    stopped: 0,
    still_sending: 0,
    errors: 0,
    deferred: 0,
    given_up: 0,
  };
  // An inbox that cannot be searched (deleted, disconnected, signed out, an
  // outage) must not keep its rows at the head of the queue: they are pushed
  // back a day, and closed after FOLLOW_UP_MAX_ATTEMPTS, so the oldest-first
  // batch always moves on to rows that can be checked.
  const defer = async (row: FollowUpRow) => {
    const attempts = (row.check_attempts ?? 0) + 1;
    const nowMsValue = nowMs(deps);
    if (attempts >= FOLLOW_UP_MAX_ATTEMPTS) {
      await deps.store.finishFollowUp(row.id, {
        status: null,
        checked_at: new Date(nowMsValue).toISOString(),
        error: "follow_up_unavailable",
      });
      summary.given_up++;
      return;
    }
    await deps.store.deferFollowUp(row.id, {
      check_after: new Date(nowMsValue + FOLLOW_UP_RETRY_MS).toISOString(),
      check_attempts: attempts,
    });
    summary.deferred++;
  };
  const rows = await deps.store.listDueFollowUps(new Date(at).toISOString(), FOLLOW_UP_BATCH);
  summary.due = rows.length;
  const byInbox = new Map<string, FollowUpRow[]>();
  for (const row of rows) {
    const group = byInbox.get(row.inbox_id);
    if (group) group.push(row);
    else byInbox.set(row.inbox_id, [row]);
  }
  for (const [inboxId, group] of byInbox) {
    const batch = group.slice(0, FOLLOW_UP_MAX_PER_INBOX);
    for (let index = 0; index < batch.length; index++) {
      const row = batch[index];
      if (budget.exhausted()) return summary;
      const nowIso = new Date(nowMs(deps)).toISOString();
      const staleIso = new Date(nowMs(deps) - FOLLOW_UP_LEASE_MS).toISOString();
      if (!(await deps.store.claimFollowUp(row.id, nowIso, staleIso))) continue;
      if (!row.from_address) {
        // Nothing to search for. Mark it checked so it leaves the queue.
        await deps.store.finishFollowUp(row.id, { status: null, checked_at: nowIso });
        summary.checked++;
        continue;
      }
      const requestedMs = Date.parse(row.requested_at ?? "") ||
        (Date.parse(row.check_after ?? "") - FOLLOW_UP_DELAY_MS);
      const sinceIso = new Date((Number.isFinite(requestedMs) ? requestedMs : at) + FOLLOW_UP_GRACE_MS)
        .toISOString();
      let found: boolean;
      try {
        found = await deps.search(inboxId, row.from_address, sinceIso);
      } catch (error) {
        summary.errors++;
        console.warn("[subscriptions] follow_up_search_failed", {
          inbox_id: inboxId,
          error: error instanceof Error ? error.message : String(error),
        });
        // One failure on an inbox (auth, outage, gone) will be the next one
        // too: push back this row and the rest of the inbox's batch.
        await defer(row);
        for (const rest of batch.slice(index + 1)) await defer(rest);
        break;
      }
      await deps.store.finishFollowUp(row.id, {
        status: found ? "still_sending" : "stopped",
        checked_at: new Date(nowMs(deps)).toISOString(),
      });
      summary.checked++;
      if (found) summary.still_sending++;
      else summary.stopped++;
    }
  }
  return summary;
}

// ── The Supabase store ──────────────────────────────────────────────────────

const PLAN_COLUMNS =
  "id, workspace_id, inbox_id, senders, senders_encrypted, window_days, scanned, truncated, " +
  "created_at, expires_at, used_at, progress, backlog_action, backlog_moved, backlog_remaining, " +
  "backlog_leased_until";

// The inner embed keeps only rows whose inbox matches the filters on it
// (listDueFollowUps); its own column is not read.
const FOLLOW_UP_SELECT =
  "id, inbox_id, from_address, status, requested_at, check_after, check_attempts, inboxes!inner(id)";

/**
 * The store over a service-role Supabase client. Every write goes through the
 * service role: RLS gives members SELECT only.
 */
export function supabaseSubscriptionStore(db: { from(table: string): any }): SubscriptionStore {
  return {
    async insertPlan(row) {
      const { data, error } = await db.from("subscription_plans").insert(row).select("id").maybeSingle();
      if (error || !data) {
        console.error("[subscriptions] plan_insert_failed", { error: error?.message });
        return null;
      }
      return (data as { id: string }).id;
    },

    async loadPlan(planId, workspaceId) {
      const { data, error } = await db
        .from("subscription_plans")
        .select(PLAN_COLUMNS)
        .eq("id", planId)
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      if (error) {
        console.error("[subscriptions] plan_load_failed", { error: error.message });
        return null;
      }
      return (data ?? null) as PlanRow | null;
    },

    async claimPlan(input) {
      const { data, error } = await db
        .from("subscription_plans")
        .update({
          used_at: input.nowIso,
          used_by_api_key_id: input.apiKeyId,
          backlog_action: input.backlogAction,
          backlog_leased_until: input.leaseUntilIso,
        })
        .eq("id", input.planId)
        .eq("workspace_id", input.workspaceId)
        .is("used_at", null)
        .select("id");
      if (error) {
        console.error("[subscriptions] plan_claim_failed", { error: error.message });
        return false;
      }
      return Array.isArray(data) && data.length > 0;
    },

    async saveProgress(planId, update, releaseLease = true) {
      const { error } = await db
        .from("subscription_plans")
        .update(releaseLease ? { ...update, backlog_leased_until: null } : update)
        .eq("id", planId);
      if (error) console.error("[subscriptions] plan_progress_failed", { error: error.message });
    },

    async reclaimPlan(input) {
      const { data, error } = await db
        .from("subscription_plans")
        .update({
          used_at: input.nowIso,
          used_by_api_key_id: input.apiKeyId,
          backlog_leased_until: input.leaseUntilIso,
        })
        .eq("id", input.planId)
        .eq("workspace_id", input.workspaceId)
        .eq("used_at", input.previousUsedAtIso)
        .select("id");
      if (error) {
        console.error("[subscriptions] plan_reclaim_failed", { error: error.message });
        return false;
      }
      return Array.isArray(data) && data.length > 0;
    },

    async leaseBacklog(planId, nowIso, untilIso) {
      const { data, error } = await db
        .from("subscription_plans")
        .update({ backlog_leased_until: untilIso })
        .eq("id", planId)
        .or(`backlog_leased_until.is.null,backlog_leased_until.lt.${nowIso}`)
        .select("id");
      if (error) {
        console.error("[subscriptions] backlog_lease_failed", { error: error.message });
        return false;
      }
      return Array.isArray(data) && data.length > 0;
    },

    async claimRequest(row, staleBeforeIso) {
      // INSERT ... ON CONFLICT DO NOTHING; a row back means this call owns it.
      const { data, error } = await db
        .from("unsubscribe_requests")
        .upsert({ ...row, status: "pending" }, { onConflict: "idempotency_key", ignoreDuplicates: true })
        .select("id");
      if (error) {
        // FAIL CLOSED: without the ledger a POST could be sent twice.
        console.error("[subscriptions] request_claim_failed", { error: error.message });
        return { claimed: false, write_failed: true };
      }
      if (Array.isArray(data) && data.length > 0) return { claimed: true, id: (data[0] as { id: string }).id };
      const existing = await db
        .from("unsubscribe_requests")
        .select("id, status, draft_id, claimed_at")
        .eq("idempotency_key", row.idempotency_key)
        .maybeSingle();
      const found = existing.data as
        | { id: string; status: string; draft_id: string | null; claimed_at: string | null }
        | null;
      if (existing.error || !found) {
        console.error("[subscriptions] request_lookup_failed", { error: existing.error?.message ?? "missing" });
        return { claimed: false, write_failed: true };
      }
      const retryable = (RETRYABLE_STATUSES as readonly string[]).includes(found.status);
      const claimedMs = Date.parse(found.claimed_at ?? "");
      const stalePending = found.status === "pending" &&
        (!Number.isFinite(claimedMs) || claimedMs < Date.parse(staleBeforeIso));
      if (retryable || stalePending) {
        // A failed, link-only or skipped attempt, or a pending one whose run
        // died, may run again. The update is conditional on what was read
        // (the status, and for pending the stale claim), so two retries cannot
        // both win it.
        let retry = db
          .from("unsubscribe_requests")
          .update({
            status: "pending",
            plan_id: row.plan_id,
            api_key_id: row.api_key_id,
            method: row.method,
            url_host: row.url_host,
            http_status: null,
            error: null,
            claimed_at: row.claimed_at,
            updated_at: new Date().toISOString(),
          })
          .eq("id", found.id);
        retry = retryable
          ? retry.in("status", RETRYABLE_STATUSES as unknown as string[])
          : retry.eq("status", "pending").or(`claimed_at.is.null,claimed_at.lt.${staleBeforeIso}`);
        const retried = await retry.select("id");
        if (!retried.error && Array.isArray(retried.data) && retried.data.length > 0) {
          return { claimed: true, id: found.id };
        }
        return { claimed: false, status: "pending", draft_id: null };
      }
      return { claimed: false, status: found.status, draft_id: found.draft_id };
    },

    async finishRequest(id, update) {
      const { error } = await db
        .from("unsubscribe_requests")
        .update({ ...update, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) {
        console.error("[subscriptions] request_finish_failed", { error: error.message });
        return false;
      }
      return true;
    },

    async listDueFollowUps(nowIso, limit) {
      // Inner join on the inbox: a soft-deleted or disconnected inbox's rows
      // never reach the batch, so they cannot hold up the live ones. They wait
      // (unchecked) until the inbox is reconnected.
      const { data, error } = await db
        .from("unsubscribe_requests")
        .select(FOLLOW_UP_SELECT)
        .is("inboxes.deleted_at", null)
        .eq("inboxes.status", "active")
        .is("checked_at", null)
        .not("check_after", "is", null)
        .lte("check_after", nowIso)
        .in("status", ["requested", "draft_ready"])
        .order("check_after", { ascending: true })
        .limit(limit);
      if (error) throw new Error(error.message);
      return ((data ?? []) as Array<FollowUpRow & { inboxes?: unknown }>).map(({ inboxes: _inbox, ...row }) => row);
    },

    async claimFollowUp(id, nowIso, staleBeforeIso) {
      const { data, error } = await db
        .from("unsubscribe_requests")
        .update({ check_leased_at: nowIso })
        .eq("id", id)
        .is("checked_at", null)
        .or(`check_leased_at.is.null,check_leased_at.lt.${staleBeforeIso}`)
        .select("id");
      if (error) return false;
      return Array.isArray(data) && data.length > 0;
    },

    async finishFollowUp(id, update) {
      const { error } = await db
        .from("unsubscribe_requests")
        .update({
          ...(update.status ? { status: update.status } : {}),
          ...(update.error ? { error: update.error } : {}),
          checked_at: update.checked_at,
          check_leased_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (error) console.error("[subscriptions] follow_up_finish_failed", { error: error.message });
    },

    async releaseFollowUp(id) {
      await db.from("unsubscribe_requests").update({ check_leased_at: null }).eq("id", id);
    },

    async deferFollowUp(id, update) {
      const { error } = await db
        .from("unsubscribe_requests")
        .update({ ...update, check_leased_at: null, updated_at: new Date().toISOString() })
        .eq("id", id)
        .is("checked_at", null);
      if (error) console.error("[subscriptions] follow_up_defer_failed", { error: error.message });
    },
  };
}

// ── Tool definitions ────────────────────────────────────────────────────────

export interface SubscriptionToolDefinition {
  name: SubscriptionToolName;
  title: string;
  description: string;
  requiredScope: "read:email" | "manage:folders";
  altScopes?: string[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

/** Loose on purpose (mcp-server CLAUDE.md): additionalProperties, no required. */
const SUBSCRIPTION_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    schema_version: { type: "string", description: "Card envelope version." },
    card: { type: "string", description: "Always 'subscription_plan'." },
    state: { type: "string", description: "pending, executed, expired or error." },
    dashboard_url: { type: "string", description: "Absolute link to the dashboard." },
    subscriptions: {
      type: "object",
      description: "plan_id, inbox, summary counts, senders and (once run) results and backlog.",
      additionalProperties: true,
    },
  },
  additionalProperties: true,
} as const;

export const SUBSCRIPTION_TOOL_DEFINITIONS: SubscriptionToolDefinition[] = [
  {
    name: "subscriptions_scan",
    title: "Find newsletter and list subscriptions",
    description:
      "Scan recent mail for newsletters and mailing lists, grouped by sender, with how each one can be " +
      "unsubscribed (one-click, by email, or by link) and which look worth dropping. Changes nothing. " +
      `Returns a plan_id and sender_key values for subscriptions_cleanup; the plan expires after ${SUBSCRIPTION_PLAN_TTL_MINUTES} minutes.`,
    requiredScope: "read:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: { type: "string", description: "Inbox to scan (UUID or email address). Optional with one inbox." },
        inbox: { type: "string", description: "Inbox email address, instead of inbox_id." },
        days: {
          type: "integer",
          minimum: 1,
          maximum: SCAN_MAX_DAYS,
          description: `How many days back to scan. Default ${SCAN_DEFAULT_DAYS}.`,
        },
        limit: {
          type: "integer",
          minimum: SCAN_MIN_LIMIT,
          maximum: SCAN_MAX_LIMIT,
          description: `Most messages to read. Default ${SCAN_DEFAULT_LIMIT}.`,
        },
      },
      additionalProperties: false,
    },
    outputSchema: SUBSCRIPTION_OUTPUT_SCHEMA,
    annotations: {
      title: "Find newsletter and list subscriptions",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "subscriptions_cleanup",
    title: "Unsubscribe from chosen senders",
    description:
      "Unsubscribe from senders picked from a subscriptions_scan plan. One-click senders are unsubscribed " +
      "by the server; senders that unsubscribe by email get a DRAFT in Drafts that the user sends " +
      "themselves (nothing is ever sent); link-only senders come back as a link for the user to open. " +
      "backlog \"archive\" also archives what those senders already sent. Only sender_keys from the plan " +
      "are accepted, and each sender is asked once. Use continue: true with the same plan_id to finish " +
      "archiving. When the scan's card is shown, the user picks and runs the cleanup on the card; call " +
      "this tool only when the user named the senders in chat.",
    // manage:folders covers the backlog step (it moves mail). The outbound
    // part has no scope of its own on purpose: send:email is reserved for
    // sending drafts (mcp-server CLAUDE.md) and an unsubscribe POST sends no
    // mail; the draft rung re-checks manage:drafts inside the handler. What
    // bounds the POST is the server-held plan, the user's pick of senders,
    // the DKIM and authserv-id checks and the per-call cap.
    requiredScope: "manage:folders",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string", format: "uuid", description: "The plan_id from subscriptions_scan." },
        sender_keys: {
          type: "array",
          items: { type: "string" },
          maxItems: SCAN_MAX_SENDERS,
          description:
            "The senders to unsubscribe from: sender_key strings from that scan, copied exactly as quoted " +
            "in its text (e.g. \"list:news.example.com\", \"from:deals@example.com\"). Not names, addresses " +
            "or domains. At least one, unless continue is true.",
        },
        backlog: {
          type: "string",
          enum: ["archive", "keep"],
          description: "archive = also archive the mail these senders already sent; keep = leave it. Default keep.",
        },
        continue: {
          type: "boolean",
          description: "true = only continue archiving for a plan that already ran.",
        },
      },
      required: ["plan_id", "sender_keys"],
      additionalProperties: false,
    },
    outputSchema: SUBSCRIPTION_OUTPUT_SCHEMA,
    annotations: {
      title: "Unsubscribe from chosen senders",
      readOnlyHint: false,
      // An unsubscribe cannot be taken back from our side, and the backlog
      // step moves mail in bulk: both are destructive by this server's
      // convention (see TOOL_ANNOTATIONS in index.ts).
      destructiveHint: true,
      // A replay finds the ledger row and repeats nothing.
      idempotentHint: true,
      // Sends a request to the sender's server.
      openWorldHint: true,
    },
  },
];

/** Dispatch by name. */
export function runSubscriptionTool(
  name: string,
  deps: SubscriptionDeps,
  caller: SubCaller,
  rawArgs: unknown,
): Promise<SubToolResult> | null {
  switch (name) {
    case "subscriptions_scan":
      return runSubscriptionsScan(deps, caller, rawArgs);
    case "subscriptions_cleanup":
      return runSubscriptionsCleanup(deps, caller, rawArgs);
    default:
      return null;
  }
}

