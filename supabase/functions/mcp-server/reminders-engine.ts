// ---------------------------------------------------------------------------
// reminders-engine.ts - the Pro "reminders" feature: one state machine for
// follow-ups and snoozes, and the unattended dispatcher that drives it.
//
// Two kinds, one table (public.reminders, migration 20261024235200):
//
//   follow_up  "tell me if nobody replies to this within N days". The server
//              looks for a reply on a cadence. A reply marks it `replied`; past
//              due_at with no reply it becomes `due` and stays listed until the
//              user marks it done or cancels it.
//   snooze     the message is moved out of the inbox into a folder ("MCPEmails
//              Snoozed" unless the caller picked one) and moved back to INBOX at
//              due_at. With condition `no_reply` it comes back only when no
//              reply arrived meanwhile; otherwise it is marked `replied` and
//              left where it is.
//
// States:
//
//   follow_up: pending -> replied | due ; due -> replied ; pending|due -> done | cancelled
//   snooze:    pending -> returned | replied ; pending -> cancelled (moved back now) | done (left in place)
//   either:    pending|due -> failed after REMINDER_MAX_CONSECUTIVE_FAILURES
//
// No model anywhere: a reply is a message that names the tracked message in
// In-Reply-To or References (IMAP), shares its thread (Gmail), or its
// conversation (Graph), arrived after it, and is not from the account itself.
//
// Pure module: the decisions, the provider-neutral reply rules and the
// dispatcher loop, over an injected `RemindersDeps`. index.ts supplies the
// Supabase queries and provider seams. Same split as triage-engine.ts, and for
// the same reason: the runner has no provider code of its own.
//
// Memory-worthy rules this keeps:
//   * One IMAP session per inbox per run, opened lazily, commands strictly
//     serial on it (the client's own runExclusive does the rest).
//   * Message ids are opaque. A snoozed message's id in the snooze folder is
//     what the move reported; when it did not (no COPYUID), index.ts finds it
//     again by Message-ID inside that one folder.
//   * Rows of one inbox are claimed together, so a mailbox sees at most one
//     reminders connection at a time (Yahoo allows few connections per account).
//   * A snooze is never stranded: it is returned even when the workspace has
//     left Pro, its key was revoked, or the rollout flag went off.
// ---------------------------------------------------------------------------

export type ReminderKind = "follow_up" | "snooze";
export type ReminderStatus =
  | "pending"
  | "due"
  | "replied"
  | "returned"
  | "done"
  | "cancelled"
  | "failed";
/** follow_up rows always carry `no_reply`; a snooze is `always` or `no_reply`. */
export type ReminderCondition = "always" | "no_reply";

export const REMINDER_KINDS: readonly ReminderKind[] = ["follow_up", "snooze"];
export const REMINDER_STATUSES: readonly ReminderStatus[] = [
  "pending",
  "due",
  "replied",
  "returned",
  "done",
  "cancelled",
  "failed",
];
/** Statuses the dispatcher may still act on. */
export const REMINDER_OPEN_STATUSES: readonly ReminderStatus[] = ["pending", "due"];
/** Statuses a user may still mark done or cancel. */
export const REMINDER_ACTIVE_STATUSES: readonly ReminderStatus[] = ["pending", "due", "failed"];

/** The default snooze folder, created on demand. */
export const SNOOZE_FOLDER_NAME = "MCPEmails Snoozed";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** follow_up_days / days bounds. */
export const FOLLOW_UP_MIN_DAYS = 1;
export const FOLLOW_UP_MAX_DAYS = 365;
/** The furthest a due_at or a snooze may be set. */
export const REMINDER_MAX_HORIZON_MS = 366 * DAY;
/** The nearest a snooze may be set, so it is not back before it has gone. */
export const SNOOZE_MIN_LEAD_MS = 2 * MINUTE;
/** Open (pending, due, failed) reminders one workspace may hold. */
export const MAX_OPEN_REMINDERS_PER_WORKSPACE = 500;

/** How often a pending follow-up is checked for a reply. */
export const REPLY_CHECK_INTERVAL_MS = 20 * MINUTE;
/** How often a due follow-up is re-checked, so a late reply still clears it. */
export const DUE_RECHECK_INTERVAL_MS = 6 * HOUR;
/** A due follow-up stops being re-checked this long after due_at (it stays listed). */
export const DUE_RECHECK_WINDOW_MS = 60 * DAY;
/** A follow-up of a workspace that cannot use Pro features is looked at again after this. */
export const NOT_ALLOWED_DEFER_MS = DAY;
/**
 * Follow-ups of an inbox that is being opened anyway are checked early when
 * they fall due within this window: one session, many checks.
 */
export const INBOX_BATCH_HORIZON_MS = 10 * MINUTE;

/** A lease older than this is released by the next run. */
export const REMINDER_STALE_LEASE_MS = 10 * MINUTE;
/** Wall-clock budget of one dispatcher invocation (pg_cron calls every minute). */
export const REMINDER_TIME_BUDGET_MS = 40_000;
/** Rows one invocation may claim. */
export const MAX_REMINDERS_PER_INVOCATION = 100;
/** Due rows one invocation looks at to pick its inboxes. */
export const REMINDER_DUE_SCAN_LIMIT = 200;
/** Consecutive failures before a reminder is marked failed. */
export const REMINDER_MAX_CONSECUTIVE_FAILURES = 5;
/** Back-off after the nth consecutive failure (1-based; the last repeats). */
export const REMINDER_FAILURE_BACKOFF_MS: readonly number[] = [5 * MINUTE, 15 * MINUTE, HOUR, 4 * HOUR];

// ── Stored shapes ──────────────────────────────────────────────────────────

/** The AES-GCM wrapper every encrypted column holds, as scheduled_sends.payload. */
export interface EncryptedWrapper {
  v: 1;
  data: string;
}

export function isEncryptedWrapper(value: unknown): value is EncryptedWrapper {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (value as Record<string, unknown>).v === 1 &&
    typeof (value as Record<string, unknown>).data === "string" &&
    ((value as Record<string, unknown>).data as string).length > 0;
}

/**
 * What identifies the tracked message. Stored encrypted (message_ref): message
 * identifiers are the same narrow carve-out triage_run_items.undo_state makes.
 */
export interface MessageRef {
  /** The provider id the caller knows the message by (the sent copy, or the original before a snooze). */
  provider_message_id: string;
  /** Gmail threadId, Graph conversationId; null on IMAP. */
  thread_id: string | null;
  /** RFC 5322 Message-ID without angle brackets, when known. */
  rfc_message_id: string | null;
  /** When the message was sent or snoozed; replies must be newer. */
  since: string;
  /** snooze: the message's id inside the snooze folder. */
  snoozed_message_id?: string | null;
  /** snooze: the snooze folder's provider id (IMAP mailbox name, Gmail label id, Graph folder id). */
  snooze_folder_id?: string | null;
}

/**
 * What the user will want to read back (and the morning brief will show):
 * stored encrypted (summary). Subject and addresses only, never a body.
 */
export interface ReminderSummary {
  subject: string;
  to: string[];
  from: string | null;
}

/** The columns the dispatcher reads. */
export interface ReminderRow {
  id: string;
  workspace_id: string;
  inbox_id: string;
  api_key_id: string | null;
  kind: ReminderKind;
  status: ReminderStatus;
  condition: ReminderCondition;
  due_at: string;
  next_check_at: string | null;
  message_ref: unknown;
  consecutive_failures: number;
}

/** A write back to one row, applied when its lease is released. */
export interface ReminderUpdate {
  status?: ReminderStatus;
  next_check_at?: string | null;
  last_checked_at?: string;
  consecutive_failures?: number;
  last_error_code?: string | null;
  replied_at?: string;
  returned_at?: string;
  completed_at?: string;
  message_ref?: EncryptedWrapper;
}

// ── Argument parsing (pure) ────────────────────────────────────────────────

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** follow_up_days / days: a whole number of days, 1 to 365. */
export function parseFollowUpDays(value: unknown, argName = "follow_up_days"): Parsed<number> {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return { ok: false, error: `${argName} must be a whole number of days.` };
  }
  if (value < FOLLOW_UP_MIN_DAYS || value > FOLLOW_UP_MAX_DAYS) {
    return {
      ok: false,
      error: `${argName} must be between ${FOLLOW_UP_MIN_DAYS} and ${FOLLOW_UP_MAX_DAYS}.`,
    };
  }
  return { ok: true, value };
}

/** An ISO 8601 timestamp that carries a zone ("Z" or an offset). */
const ZONED_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/i;

/** A future time with a timezone, within the horizon. */
export function parseFutureTime(
  value: unknown,
  nowMs: number,
  argName: string,
  minLeadMs = 0,
): Parsed<string> {
  if (typeof value !== "string" || !ZONED_ISO.test(value.trim())) {
    return {
      ok: false,
      error: `${argName} must be an ISO 8601 timestamp with a timezone, e.g. "2026-06-02T09:00:00+02:00".`,
    };
  }
  const ms = Date.parse(value.trim());
  if (!Number.isFinite(ms)) return { ok: false, error: `${argName} is not a valid date.` };
  if (ms <= nowMs + minLeadMs) return { ok: false, error: `${argName} must be in the future.` };
  if (ms > nowMs + REMINDER_MAX_HORIZON_MS) {
    return { ok: false, error: `${argName} must be at most a year ahead.` };
  }
  return { ok: true, value: new Date(ms).toISOString() };
}

/** The due time of a follow-up made from `days` or an explicit `due_at` (exactly one). */
export function followUpDueAt(args: { days?: unknown; due_at?: unknown }, nowMs: number): Parsed<string> {
  const hasDays = args.days !== undefined && args.days !== null;
  const hasDueAt = args.due_at !== undefined && args.due_at !== null;
  if (hasDays === hasDueAt) {
    return { ok: false, error: "pass exactly one of `days` (whole days from now) or `due_at` (ISO 8601 with timezone)." };
  }
  if (hasDays) {
    const days = parseFollowUpDays(args.days, "days");
    if (!days.ok) return days;
    return { ok: true, value: new Date(nowMs + days.value * DAY).toISOString() };
  }
  return parseFutureTime(args.due_at, nowMs, "due_at");
}

export function parseSnoozeCondition(value: unknown): Parsed<ReminderCondition> {
  if (value === undefined || value === null) return { ok: true, value: "always" };
  if (value === "always" || value === "no_reply") return { ok: true, value };
  return { ok: false, error: "condition must be 'always' or 'no_reply'." };
}

/** reminder_list `show`. */
export type ReminderListFilter = "due" | "upcoming" | "all";
export function parseListFilter(value: unknown): Parsed<ReminderListFilter> {
  if (value === undefined || value === null) return { ok: true, value: "due" };
  if (value === "due" || value === "upcoming" || value === "all") return { ok: true, value };
  return { ok: false, error: "show must be 'due', 'upcoming' or 'all'." };
}

/** The statuses each list filter shows. `due` is what needs the user: due follow-ups and failures. */
export function statusesForFilter(filter: ReminderListFilter): ReminderStatus[] {
  switch (filter) {
    case "due":
      return ["due", "failed"];
    case "upcoming":
      return ["pending"];
    case "all":
      return [...REMINDER_STATUSES];
  }
}

// ── Message ids ────────────────────────────────────────────────────────────

/**
 * An RFC 5322 msg-id, brackets stripped, or null when it is unusable in an IMAP
 * quoted string (no quote, backslash, angle bracket, space or control char).
 */
export function cleanRfcMessageId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const bare = value.trim().replace(/^<|>$/g, "").trim();
  if (bare.length < 3 || bare.length > 500) return null;
  if (!/^[\x21-\x7e]+$/.test(bare) || /["\\<>]/.test(bare)) return null;
  return bare;
}

/** True for the `<local@host>` shape the IMAP send path returns as message_id. */
export function looksLikeRfcMessageId(value: string): boolean {
  return /^<[^<>\s"\\]+@[^<>\s"\\]+>$/.test(value.trim());
}

// ── Scheduling (pure) ──────────────────────────────────────────────────────

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** next_check_at for a new or still-pending follow-up. */
export function nextPendingFollowUpCheck(nowMs: number, dueAtIso: string): string {
  const dueMs = Date.parse(dueAtIso);
  return iso(Math.max(nowMs + MINUTE, Math.min(nowMs + REPLY_CHECK_INTERVAL_MS, dueMs)));
}

/** next_check_at for a due follow-up, or null once the re-check window has passed. */
export function nextDueFollowUpCheck(nowMs: number, dueAtIso: string): string | null {
  const dueMs = Date.parse(dueAtIso);
  const next = nowMs + DUE_RECHECK_INTERVAL_MS;
  return next - dueMs > DUE_RECHECK_WINDOW_MS ? null : iso(next);
}

/** The outcome of one reply check on a follow-up. */
export function decideFollowUpCheck(
  row: Pick<ReminderRow, "status" | "due_at">,
  replyFound: boolean,
  nowMs: number,
): ReminderUpdate {
  const now = iso(nowMs);
  const base = { last_checked_at: now, consecutive_failures: 0, last_error_code: null };
  if (replyFound) {
    return { ...base, status: "replied", replied_at: now, completed_at: now, next_check_at: null };
  }
  if (nowMs >= Date.parse(row.due_at)) {
    return { ...base, status: "due", next_check_at: nextDueFollowUpCheck(nowMs, row.due_at) };
  }
  return { ...base, status: "pending", next_check_at: nextPendingFollowUpCheck(nowMs, row.due_at) };
}

/** What a snooze does when its time comes. */
export type SnoozeAction = "return" | "keep";
export function decideSnoozeAction(condition: ReminderCondition, replyFound: boolean): SnoozeAction {
  return condition === "no_reply" && replyFound ? "keep" : "return";
}

/** The write after a snooze was handled (moved back, or kept because a reply came). */
export function snoozeOutcomeUpdate(action: SnoozeAction, nowMs: number): ReminderUpdate {
  const now = iso(nowMs);
  const base = { last_checked_at: now, consecutive_failures: 0, last_error_code: null, next_check_at: null };
  return action === "return"
    ? { ...base, status: "returned", returned_at: now, completed_at: now }
    : { ...base, status: "replied", replied_at: now, completed_at: now };
}

/** Back-off, and `failed` at the limit. Status otherwise unchanged. */
export function failureUpdate(
  row: Pick<ReminderRow, "consecutive_failures">,
  errorCode: string,
  nowMs: number,
): ReminderUpdate {
  const failures = (row.consecutive_failures ?? 0) + 1;
  const now = iso(nowMs);
  if (failures >= REMINDER_MAX_CONSECUTIVE_FAILURES) {
    return {
      status: "failed",
      consecutive_failures: failures,
      last_error_code: errorCode,
      last_checked_at: now,
      next_check_at: null,
    };
  }
  const backoff = REMINDER_FAILURE_BACKOFF_MS[Math.min(failures, REMINDER_FAILURE_BACKOFF_MS.length) - 1];
  return {
    consecutive_failures: failures,
    last_error_code: errorCode,
    last_checked_at: now,
    next_check_at: iso(nowMs + backoff),
  };
}

// ── Reply rules (pure, per provider) ───────────────────────────────────────

/** The bare address of a From header value or a plain address. */
export function addressOf(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const bracketed = /<([^<>\s]+@[^<>\s]+)>/.exec(value);
  const candidate = bracketed ? bracketed[1] : value.trim();
  return /^[^\s@<>"]+@[^\s@<>"]+$/.test(candidate) ? candidate.toLowerCase() : null;
}

const IMAP_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** RFC 3501 date (dd-Mon-yyyy) a day before `ms`, so no timezone can hide a reply. */
export function imapSinceDate(ms: number): string {
  const d = new Date(ms - DAY);
  return `${d.getUTCDate()}-${IMAP_MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

/**
 * The UID SEARCH criteria that find a reply in INBOX: a message naming the
 * tracked Message-ID in In-Reply-To or References, newer than the send, not
 * from the account itself. Null when the id cannot be searched for safely.
 */
export function imapReplySearchCriteria(
  rfcMessageId: string | null,
  sinceMs: number,
  ownAddresses: Iterable<string>,
): string | null {
  const id = cleanRfcMessageId(rfcMessageId);
  if (!id) return null;
  const parts = [
    `SINCE ${imapSinceDate(sinceMs)}`,
    `OR HEADER In-Reply-To "${id}" HEADER References "${id}"`,
  ];
  for (const raw of ownAddresses) {
    const addr = addressOf(raw);
    if (addr) parts.push(`NOT FROM "${addr}"`);
  }
  return parts.join(" ");
}

/** Gmail threads.get (format=metadata) message, the fields this reads. */
export interface GmailThreadMessage {
  id?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: { headers?: { name: string; value: string }[] };
}

/** A reply in a Gmail thread: a newer message, not ours (SENT/DRAFT or own From), not the tracked one. */
export function gmailThreadHasReply(
  messages: GmailThreadMessage[],
  trackedMessageId: string,
  sinceMs: number,
  ownAddresses: ReadonlySet<string>,
): boolean {
  return messages.some((m) => {
    if (!m || m.id === trackedMessageId) return false;
    const labels = m.labelIds ?? [];
    if (labels.includes("SENT") || labels.includes("DRAFT")) return false;
    const when = Number(m.internalDate);
    if (!Number.isFinite(when) || when <= sinceMs) return false;
    const fromHeader = m.payload?.headers?.find((h) => h.name.toLowerCase() === "from")?.value;
    const from = addressOf(fromHeader);
    return !(from && ownAddresses.has(from));
  });
}

/** Graph message, the fields this reads. */
export interface GraphConversationMessage {
  id?: string;
  isDraft?: boolean;
  receivedDateTime?: string;
  from?: { emailAddress?: { address?: string } };
}

/** A reply in a Graph conversation, by the same rule as Gmail. */
export function graphConversationHasReply(
  messages: GraphConversationMessage[],
  trackedMessageId: string,
  sinceMs: number,
  ownAddresses: ReadonlySet<string>,
): boolean {
  return messages.some((m) => {
    if (!m || m.id === trackedMessageId || m.isDraft) return false;
    const when = Date.parse(m.receivedDateTime ?? "");
    if (!Number.isFinite(when) || when <= sinceMs) return false;
    const from = addressOf(m.from?.emailAddress?.address);
    return !(from && ownAddresses.has(from));
  });
}

/** The OData filter for a conversation's messages newer than `sinceIso`. Quotes doubled. */
export function graphConversationFilter(conversationId: string, sinceIso: string): string {
  return `conversationId eq '${conversationId.replace(/'/g, "''")}' and receivedDateTime gt ${sinceIso}`;
}

// ── The dispatcher ─────────────────────────────────────────────────────────

/** The gate's answer for a workspace, as the dispatcher needs it. */
export interface ReminderAccess {
  allowed: boolean;
}

export interface RemindersStore {
  /** Release leases older than the cutoff (the work is safe to repeat). */
  releaseStaleLeases(cutoffIso: string): Promise<number>;
  /** Open rows with next_check_at <= now and no lease, oldest first. */
  listDue(nowIso: string, limit: number): Promise<ReminderRow[]>;
  /** Any live lease on this inbox other than ours. */
  inboxLeaseHeld(inboxId: string, token: string): Promise<boolean>;
  /**
   * Claim the inbox's open, unleased rows that are due now, plus follow-ups due
   * before `horizonIso` (batched onto the same session). Atomic per row.
   */
  claimInbox(inboxId: string, nowIso: string, horizonIso: string, token: string, limit: number): Promise<ReminderRow[]>;
  /** Write the update and drop the lease, only while the lease is still ours. */
  release(id: string, token: string, update: ReminderUpdate): Promise<void>;
}

export interface RemindersDeps {
  store: RemindersStore;
  /** Pro access of a workspace. Errors count as not allowed. */
  access(workspaceId: string): Promise<ReminderAccess>;
  decryptRef(wrapper: unknown): Promise<MessageRef>;
  encryptRef(ref: MessageRef): Promise<EncryptedWrapper>;
  /** One provider session per inbox per run; IMAP connects lazily on first use. */
  openSession(inboxId: string): Promise<unknown>;
  closeSession(session: unknown): Promise<void>;
  /** Has a reply to the tracked message arrived? */
  checkReply(session: unknown, ref: MessageRef): Promise<boolean>;
  /** Move a snoozed message back to INBOX. Returns the ref to store (ids may change). */
  returnSnoozed(session: unknown, ref: MessageRef): Promise<{ ref: MessageRef; notFound?: boolean }>;
  /** A short code for an error, never provider text. */
  errorCode(error: unknown): string;
  newToken(): string;
  now?: () => number;
}

export interface DispatchSummary {
  claimed: number;
  checked: number;
  replied: number;
  due: number;
  returned: number;
  failed: number;
  deferred: number;
  cancelled: number;
  inboxes: number;
  inbox_busy: number;
  released_stale: number;
  budget_exhausted: boolean;
}

function clock(deps: RemindersDeps): number {
  return deps.now ? deps.now() : Date.now();
}

/**
 * One invocation: release stale leases, pick inboxes with due work, and for
 * each inbox claim its rows, open one session, act on every row, close.
 */
export async function runRemindersDispatch(deps: RemindersDeps): Promise<DispatchSummary> {
  const started = clock(deps);
  const token = deps.newToken();
  const summary: DispatchSummary = {
    claimed: 0,
    checked: 0,
    replied: 0,
    due: 0,
    returned: 0,
    failed: 0,
    deferred: 0,
    cancelled: 0,
    inboxes: 0,
    inbox_busy: 0,
    released_stale: 0,
    budget_exhausted: false,
  };

  try {
    summary.released_stale = await deps.store.releaseStaleLeases(iso(started - REMINDER_STALE_LEASE_MS));
  } catch (error) {
    console.warn("[reminders-dispatch] stale lease release failed", deps.errorCode(error));
  }

  const due = await deps.store.listDue(iso(started), REMINDER_DUE_SCAN_LIMIT);
  const inboxOrder: string[] = [];
  for (const row of due) if (!inboxOrder.includes(row.inbox_id)) inboxOrder.push(row.inbox_id);

  const accessMemo = new Map<string, Promise<ReminderAccess>>();
  const accessFor = (workspaceId: string) => {
    let pending = accessMemo.get(workspaceId);
    if (!pending) {
      pending = deps.access(workspaceId).catch(() => ({ allowed: false }));
      accessMemo.set(workspaceId, pending);
    }
    return pending;
  };

  for (const inboxId of inboxOrder) {
    if (summary.claimed >= MAX_REMINDERS_PER_INVOCATION) break;
    if (clock(deps) - started >= REMINDER_TIME_BUDGET_MS) {
      summary.budget_exhausted = true;
      break;
    }
    try {
      if (await deps.store.inboxLeaseHeld(inboxId, token)) {
        summary.inbox_busy++;
        continue;
      }
    } catch {
      continue;
    }
    const nowMs = clock(deps);
    let rows: ReminderRow[];
    try {
      rows = await deps.store.claimInbox(
        inboxId,
        iso(nowMs),
        iso(nowMs + INBOX_BATCH_HORIZON_MS),
        token,
        MAX_REMINDERS_PER_INVOCATION - summary.claimed,
      );
    } catch (error) {
      console.warn("[reminders-dispatch] claim failed", { inbox_id: inboxId, error: deps.errorCode(error) });
      continue;
    }
    if (rows.length === 0) continue;
    // The look before the claim is not atomic with it: look again now our
    // claim is committed. Both sides backing off costs a minute, never a
    // second connection.
    let collision = true;
    try {
      collision = await deps.store.inboxLeaseHeld(inboxId, token);
    } catch { /* treated as a collision */ }
    if (collision) {
      summary.inbox_busy++;
      for (const row of rows) await deps.store.release(row.id, token, {}).catch(() => {});
      continue;
    }
    summary.claimed += rows.length;
    summary.inboxes++;
    await processInbox(deps, rows, token, accessFor, started, summary);
  }

  return summary;
}

type Plan =
  | { row: ReminderRow; kind: "update"; update: ReminderUpdate; counter: "cancelled" | "deferred" }
  | { row: ReminderRow; kind: "provider" };

async function processInbox(
  deps: RemindersDeps,
  rows: ReminderRow[],
  token: string,
  accessFor: (workspaceId: string) => Promise<ReminderAccess>,
  started: number,
  summary: DispatchSummary,
): Promise<void> {
  const plans: Plan[] = [];
  for (const row of rows) {
    const nowMs = clock(deps);
    if (row.kind === "follow_up") {
      if (!row.api_key_id) {
        // The key that set it up is gone. A follow-up only reads, and nobody
        // is left who asked for it: stop rather than read on.
        plans.push({
          row,
          kind: "update",
          counter: "cancelled",
          update: {
            status: "cancelled",
            last_error_code: "api_key_revoked",
            next_check_at: null,
            completed_at: iso(nowMs),
          },
        });
        continue;
      }
      if (!(await accessFor(row.workspace_id)).allowed) {
        plans.push({
          row,
          kind: "update",
          counter: "deferred",
          update: { next_check_at: iso(nowMs + NOT_ALLOWED_DEFER_MS), last_checked_at: iso(nowMs) },
        });
        continue;
      }
    }
    // Snoozes go through whatever the plan or key: mail is never left hidden.
    plans.push({ row, kind: "provider" });
  }

  for (const plan of plans) {
    if (plan.kind === "update") {
      await deps.store.release(plan.row.id, token, plan.update).catch(() => {});
      summary[plan.counter]++;
    }
  }

  const providerRows = plans.filter((p) => p.kind === "provider").map((p) => p.row);
  if (providerRows.length === 0) return;

  let session: unknown = null;
  try {
    session = await deps.openSession(providerRows[0].inbox_id);
  } catch (error) {
    const code = deps.errorCode(error);
    for (const row of providerRows) {
      const update = failureUpdate(row, code, clock(deps));
      if (update.status === "failed") summary.failed++;
      await deps.store.release(row.id, token, update).catch(() => {});
    }
    return;
  }

  try {
    for (let i = 0; i < providerRows.length; i++) {
      const row = providerRows[i];
      if (clock(deps) - started >= REMINDER_TIME_BUDGET_MS) {
        // Hand the rest back untouched; they are still due next minute.
        summary.budget_exhausted = true;
        for (const rest of providerRows.slice(i)) await deps.store.release(rest.id, token, {}).catch(() => {});
        return;
      }
      const update = await actOnRow(deps, session, row, summary);
      await deps.store.release(row.id, token, update).catch((error) => {
        console.error("[reminders-dispatch] release failed", { id: row.id, error: deps.errorCode(error) });
      });
    }
  } finally {
    await deps.closeSession(session).catch(() => {});
  }
}

async function actOnRow(
  deps: RemindersDeps,
  session: unknown,
  row: ReminderRow,
  summary: DispatchSummary,
): Promise<ReminderUpdate> {
  let ref: MessageRef;
  try {
    ref = await deps.decryptRef(row.message_ref);
  } catch {
    const update = failureUpdate(row, "reference_unreadable", clock(deps));
    if (update.status === "failed") summary.failed++;
    return update;
  }
  try {
    if (row.kind === "follow_up") {
      const replied = await deps.checkReply(session, ref);
      summary.checked++;
      const update = decideFollowUpCheck(row, replied, clock(deps));
      if (update.status === "replied") summary.replied++;
      else if (update.status === "due" && row.status !== "due") summary.due++;
      return update;
    }
    // snooze
    const replied = row.condition === "no_reply" ? await deps.checkReply(session, ref) : false;
    if (row.condition === "no_reply") summary.checked++;
    const action = decideSnoozeAction(row.condition, replied);
    if (action === "keep") {
      summary.replied++;
      return snoozeOutcomeUpdate("keep", clock(deps));
    }
    const moved = await deps.returnSnoozed(session, ref);
    summary.returned++;
    const update = snoozeOutcomeUpdate("return", clock(deps));
    if (moved.notFound) {
      // Not in the snooze folder any more: the user moved it themselves.
      // Nothing to bring back, and nothing to retry.
      const { returned_at: _notReturned, ...rest } = update;
      return { ...rest, status: "done", last_error_code: "message_not_found" };
    }
    return { ...update, message_ref: await deps.encryptRef(moved.ref) };
  } catch (error) {
    const update = failureUpdate(row, deps.errorCode(error), clock(deps));
    if (update.status === "failed") summary.failed++;
    return update;
  }
}
