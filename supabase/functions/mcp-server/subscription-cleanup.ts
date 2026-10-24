// ---------------------------------------------------------------------------
// Subscription cleanup: the `subscriptions_scan` and `subscriptions_cleanup`
// tools and the 72-hour follow-up (Phase 2).
//
// Phase 1 (list-unsubscribe.ts, subscription-scan.ts, one-click-post.ts) reads
// the List-Unsubscribe headers, decides per sender which method is safe and
// knows how to send an RFC 8058 one-click POST without being turned against
// our own network. This module is what a tool call does with that:
//
//   subscriptions_scan     scan, group, freeze the result as a plan for 15
//                          minutes, return a `subscription_plan` card.
//   subscriptions_cleanup  for the senders the user picked, run the method
//                          ladder, write one ledger row per sender, then
//                          (optionally) archive what those senders already
//                          sent, resumable with `continue: true`.
//   runSubscriptionFollowUp  hourly, from pg_cron: did the sender stop?
//
// ── The ladder, per approved sender (spec D6, "Method ladder") ──────────────
//   unsafe (Junk, DKIM not aligned, mixed domains)  skipped_unsafe
//   one_click   server POST: requested on 2xx, failed otherwise
//   mailto      a DRAFT to the mailto address: draft_ready. Never sent.
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
// unsubscribe part (an atomic `used_at IS NULL` claim) and lives 15 minutes.
// The ledger's idempotency key means a replay finds its row instead of
// sending a second POST.
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

/** A plan is runnable for 15 minutes, like a bulk plan. */
export const SUBSCRIPTION_PLAN_TTL_MS = 15 * 60 * 1000;
/**
 * `continue: true` (the backlog move only) is accepted for an hour after the
 * scan. The unsubscribe part stays bound to the 15-minute window; moving mail
 * the user already chose to archive is safe to finish a little later, and a
 * "Continue archiving" button that expires with the plan would strand a
 * half-archived backlog.
 */
export const BACKLOG_CONTINUE_WINDOW_MS = 60 * 60 * 1000;
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
  /** Only for needs_user: the raw link for the user to open. */
  link: string | null;
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
  | { claimed: false; status: string; draft_id: string | null };

export interface FollowUpRow {
  id: string;
  inbox_id: string;
  from_address: string | null;
  status: string;
  requested_at: string | null;
  check_after: string | null;
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
  saveProgress(planId: string, update: {
    progress: { v: 1; data: string };
    backlog_moved: number;
    backlog_remaining: number;
  }): Promise<void>;
  /** Take the backlog lease when it is free or stale. */
  leaseBacklog(planId: string, nowIso: string, untilIso: string): Promise<boolean>;
  claimRequest(row: NewRequestRow): Promise<ClaimRequestResult>;
  finishRequest(id: string, update: RequestUpdate): Promise<void>;
  listDueFollowUps(nowIso: string, limit: number): Promise<FollowUpRow[]>;
  claimFollowUp(id: string, nowIso: string, staleBeforeIso: string): Promise<boolean>;
  finishFollowUp(id: string, update: { status: "stopped" | "still_sending" | null; checked_at: string }): Promise<void>;
  releaseFollowUp(id: string): Promise<void>;
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

export async function runSubscriptionsScan(
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

  const candidates = groupSenders(scan.records, { maxSenders: SCAN_MAX_SENDERS });
  const senders = storedSendersOf(candidates, scan.records);
  const summary = summaryOf(senders);
  const at = nowMs(deps);
  const expiresAt = new Date(at + SUBSCRIPTION_PLAN_TTL_MS).toISOString();

  const planId = await deps.store.insertPlan({
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
      `${summary.unsafe} look unsafe and will be skipped.`,
  );
  if (senders.length > 0) {
    lines.push("", "Top senders (sender_key: name, messages, read share, method):");
    for (const s of senders.slice(0, SCAN_TEXT_SENDERS)) {
      const name = JSON.stringify(clean(s.display_name, 80) || clean(s.from_address, 80));
      lines.push(
        `- ${s.sender_key}: ${name}, ${s.message_count} message(s), ${Math.round(s.read_share * 100)}% read, ` +
          `${methodLabel(s.method)}${s.safe ? "" : ", unsafe"}${s.suggested ? ", suggested" : ""}`,
      );
    }
    if (senders.length > SCAN_TEXT_SENDERS) {
      lines.push(`- and ${senders.length - SCAN_TEXT_SENDERS} more in the card.`);
    }
  }
  lines.push(
    "",
    "Nothing has been changed. To unsubscribe, call subscriptions_cleanup with this plan_id and the " +
      "sender_keys the user chose (only keys from this list are accepted), and backlog \"archive\" to also " +
      "archive what those senders already sent or \"keep\". One-click senders are unsubscribed by the server; " +
      "senders that unsubscribe by email get a draft in the Drafts folder that the user sends themselves " +
      "(nothing is sent); link-only senders come back as a link for the user to open.",
    `plan_id: ${planId} (expires ${expiresAt}, runs once)`,
  );
  return lines.join("\n");
}

// ── subscriptions_cleanup ───────────────────────────────────────────────────

interface CleanupArgs {
  planId: string;
  senderKeys: string[];
  backlog: "archive" | "keep";
  continueBacklog: boolean;
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
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== "string" || k.length === 0 || k.length > 600)) {
    return "sender_keys must be a list of sender_key values from the scan.";
  }
  if (keys.length > SCAN_MAX_SENDERS) return `sender_keys may name at most ${SCAN_MAX_SENDERS} senders.`;
  const backlog = args.backlog ?? "keep";
  if (backlog !== "archive" && backlog !== "keep") return "backlog must be \"archive\" or \"keep\".";
  const cont = args.continue ?? false;
  if (typeof cont !== "boolean") return "continue must be true or false.";
  if (!cont && keys.length === 0) return "sender_keys must name at least one sender.";
  return {
    planId,
    senderKeys: [...new Set(keys as string[])],
    backlog,
    continueBacklog: cont,
  };
}

/** HMAC(inbox, sender, target): the ledger's replay guard. */
export function idempotencyInput(inboxId: string, sender: StoredSender): string {
  const target = sender.method === "mailto"
    ? sender.mailto?.raw ?? ""
    : sender.method === "one_click" || sender.method === "link"
    ? sender.https_url ?? ""
    : "";
  return `unsubscribe:${inboxId}\n${sender.sender_key}\n${target}`;
}

export async function runSubscriptionsCleanup(
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
  if (unknown.length > 0) {
    return envelopeFailure(
      deps,
      "error",
      "unknown_sender_keys",
      `subscriptions_cleanup: ${unknown.length} sender key(s) are not in this plan. Use only sender_key ` +
        "values returned by the same subscriptions_scan. Nothing was changed.",
      row.id,
      "not_pending",
    );
  }
  const selected = parsed.senderKeys.map((k) => byKey.get(k)!);
  const at = nowMs(deps);
  const meta = { window_days: row.window_days, scanned: row.scanned, truncated: row.truncated };

  if (parsed.continueBacklog) return await continueBacklog(deps, caller, row, inbox, senders, meta, at);

  if (row.used_at) return await replayExecuted(deps, row, inbox, senders, meta);

  const expiresMs = Date.parse(row.expires_at);
  if (Number.isFinite(expiresMs) && expiresMs <= at) {
    return envelopeFailure(
      deps,
      "expired",
      "plan_expired",
      "This subscription plan expired (plans last 15 minutes). Nothing was changed. Run subscriptions_scan again.",
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
    return await replayExecuted(deps, fresh ?? row, inbox, senders, meta);
  }

  const budget = createWorkBudget(deps.budgetMs ?? CLEANUP_BUDGET_MS, deps.now ?? Date.now);
  const results = await runLadder(deps, caller, row.id, inbox, selected, budget);

  const archiveIds = parsed.backlog === "archive" ? [...new Set(selected.flatMap((s) => s.archive_ids))] : [];
  let backlog: BacklogProgress = {
    action: parsed.backlog,
    destination: null,
    remaining_ids: archiveIds,
    moved: 0,
    failed: 0,
  };
  if (parsed.backlog === "archive") backlog = await moveBacklog(deps, inbox, backlog, budget);

  await saveProgress(deps, row.id, { v: 1, results, backlog });
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
): Promise<CleanupResult[]> {
  const results = new Map<string, CleanupResult>();
  let posts = 0;
  const canDraft = caller.scopes.includes("manage:drafts");

  // Claim every sender's ledger row first, so the order of the work below
  // cannot change which senders count as already done.
  const claims = new Map<string, string>();
  for (const sender of selected) {
    const claim = await deps.store.claimRequest({
      workspace_id: caller.workspace_id,
      inbox_id: inbox.id,
      plan_id: planId,
      api_key_id: caller.id,
      sender_key: sender.sender_key,
      sender_domain: sender.domain || null,
      display_name: clean(sender.display_name) || null,
      from_address: sender.from_address || null,
      method: sender.method,
      url_host: sender.method === "mailto" ? domainOfAddress(sender.mailto?.address) : hostOf(sender.https_url),
      idempotency_key: await deps.digest(idempotencyInput(inbox.id, sender)),
    });
    if (claim.claimed) {
      claims.set(sender.sender_key, claim.id);
    } else {
      results.set(sender.sender_key, {
        ...baseResult(sender),
        status: "already_done",
        detail: claim.status === "pending"
          ? "An earlier request for this sender has not finished; it was not repeated."
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
    await deps.store.finishRequest(id, {
      status: result.status as RequestUpdate["status"],
      ...update,
      ...(followed
        ? { requested_at: nowIso, check_after: new Date(nowMs(deps) + FOLLOW_UP_DELAY_MS).toISOString() }
        : {}),
    });
  };

  const oneClick: StoredSender[] = [];
  for (const sender of selected) {
    if (!claims.has(sender.sender_key)) continue;
    if (!sender.safe) {
      await finish(sender, {
        ...baseResult(sender),
        status: "skipped_unsafe",
        detail: unsafeDetail(sender.unsafe_reason),
      });
      continue;
    }
    switch (sender.method) {
      case "one_click":
        oneClick.push(sender);
        break;
      case "link":
        await finish(sender, {
          ...baseResult(sender),
          status: "needs_user",
          detail: "This sender only offers an unsubscribe page. Open the link to finish.",
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
  return selected.map((s) => results.get(s.sender_key)!).filter(Boolean);
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
    return [{
      ...baseResult(sender),
      status: "needs_user",
      detail: canDraft
        ? "Ran out of time for this run. Open the link to write the unsubscribe email yourself."
        : "This connection cannot create drafts. Open the link to write the unsubscribe email yourself.",
      link: mailto.raw,
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

async function saveProgress(deps: SubscriptionDeps, planId: string, progress: PlanProgress): Promise<void> {
  await deps.store.saveProgress(planId, {
    progress: { v: 1, data: await deps.encrypt(JSON.stringify(progress)) },
    backlog_moved: progress.backlog.moved,
    backlog_remaining: progress.backlog.remaining_ids.length,
  });
}

async function continueBacklog(
  deps: SubscriptionDeps,
  _caller: SubCaller,
  row: PlanRow,
  inbox: SubInbox,
  senders: StoredSender[],
  meta: { window_days: number; scanned: number; truncated: boolean },
  at: number,
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
    return envelopeFailure(
      deps,
      "expired",
      "plan_expired",
      "This plan is too old to continue archiving. Run subscriptions_scan again; the senders already " +
        "handled are remembered and will not be asked twice.",
      row.id,
      "expired",
    );
  }
  const progress = await readProgress(deps, row);
  if (!progress) return inFlight(deps, row.id);
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
  await saveProgress(deps, row.id, { v: 1, results: progress.results, backlog });
  return executedResult(deps, row, inbox, senders, meta, progress.results, backlog, true);
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

async function replayExecuted(
  deps: SubscriptionDeps,
  row: PlanRow,
  inbox: SubInbox,
  senders: StoredSender[],
  meta: { window_days: number; scanned: number; truncated: boolean },
): Promise<SubToolResult> {
  const progress = await readProgress(deps, row);
  if (!progress) return inFlight(deps, row.id);
  return executedResult(deps, row, inbox, senders, meta, progress.results, progress.backlog, true);
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
  const summary: FollowUpSummary = { due: 0, checked: 0, stopped: 0, still_sending: 0, errors: 0 };
  const rows = await deps.store.listDueFollowUps(new Date(at).toISOString(), FOLLOW_UP_BATCH);
  summary.due = rows.length;
  const byInbox = new Map<string, FollowUpRow[]>();
  for (const row of rows) {
    const group = byInbox.get(row.inbox_id);
    if (group) group.push(row);
    else byInbox.set(row.inbox_id, [row]);
  }
  for (const [inboxId, group] of byInbox) {
    for (const row of group.slice(0, FOLLOW_UP_MAX_PER_INBOX)) {
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
        await deps.store.releaseFollowUp(row.id);
        // One failure on an inbox (auth, outage) will be the next one too.
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

const FOLLOW_UP_COLUMNS = "id, inbox_id, from_address, status, requested_at, check_after";

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

    async saveProgress(planId, update) {
      const { error } = await db
        .from("subscription_plans")
        .update({ ...update, backlog_leased_until: null })
        .eq("id", planId);
      if (error) console.error("[subscriptions] plan_progress_failed", { error: error.message });
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

    async claimRequest(row) {
      // INSERT ... ON CONFLICT DO NOTHING; a row back means this call owns it.
      const { data, error } = await db
        .from("unsubscribe_requests")
        .upsert({ ...row, status: "pending" }, { onConflict: "idempotency_key", ignoreDuplicates: true })
        .select("id");
      if (error) {
        // FAIL CLOSED: without the ledger a POST could be sent twice.
        console.error("[subscriptions] request_claim_failed", { error: error.message });
        return { claimed: false, status: "pending", draft_id: null };
      }
      if (Array.isArray(data) && data.length > 0) return { claimed: true, id: (data[0] as { id: string }).id };
      const existing = await db
        .from("unsubscribe_requests")
        .select("id, status, draft_id")
        .eq("idempotency_key", row.idempotency_key)
        .maybeSingle();
      const found = existing.data as { id: string; status: string; draft_id: string | null } | null;
      if (existing.error || !found) return { claimed: false, status: "pending", draft_id: null };
      if ((RETRYABLE_STATUSES as readonly string[]).includes(found.status)) {
        // A failed, link-only or skipped attempt may run again; the claim is
        // conditional on the status, so two retries cannot both win it.
        const retried = await db
          .from("unsubscribe_requests")
          .update({
            status: "pending",
            plan_id: row.plan_id,
            api_key_id: row.api_key_id,
            method: row.method,
            url_host: row.url_host,
            http_status: null,
            error: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", found.id)
          .in("status", RETRYABLE_STATUSES as unknown as string[])
          .select("id");
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
      if (error) console.error("[subscriptions] request_finish_failed", { error: error.message });
    },

    async listDueFollowUps(nowIso, limit) {
      const { data, error } = await db
        .from("unsubscribe_requests")
        .select(FOLLOW_UP_COLUMNS)
        .is("checked_at", null)
        .not("check_after", "is", null)
        .lte("check_after", nowIso)
        .in("status", ["requested", "draft_ready"])
        .order("check_after", { ascending: true })
        .limit(limit);
      if (error) throw new Error(error.message);
      return (data ?? []) as FollowUpRow[];
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
      "Returns a plan_id and sender_key values for subscriptions_cleanup; the plan expires after 15 minutes.",
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
      "archiving.",
    requiredScope: "manage:folders",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string", format: "uuid", description: "The plan_id from subscriptions_scan." },
        sender_keys: {
          type: "array",
          items: { type: "string" },
          maxItems: SCAN_MAX_SENDERS,
          description: "sender_key values from that plan, for the senders to unsubscribe from.",
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

