/**
 * The dashboard's "first week" checklist: which items a new paying owner sees,
 * and which are ticked.
 *
 * WHY IT EXISTS. Payers who use MCPEmails on 4 or more of their first 7 days
 * nearly all keep using it; payers with 3 or fewer mostly drift off. Inbox
 * count predicts nothing. So the checklist asks for active days and an
 * automation, and the "connect another inbox" row is optional, last, and only
 * shown where the plan already has room (no price, no upsell).
 *
 * Browser-safe and pure: the route (app/api/onboarding/first-week) gathers the
 * counts, the card (components/dashboard/FirstWeekChecklist.jsx) renders the
 * result. Everything that decides what a customer reads is here, so it can be
 * tested without a database or a DOM.
 */

/** How long after the first payment the card can appear. */
export const FIRST_WEEK_WINDOW_DAYS = 14;

/** Active days asked for. */
export const TARGET_ACTIVE_DAYS = 3;

/** How many of the latest calls the inbox-trouble rule looks at. */
export const RECENT_CALL_WINDOW = 10;

/**
 * Error codes that mean the mailbox itself is the problem, and that a
 * reconnect (new password, new app password) is the fix. Everything else
 * (bad arguments from the model, a message that moved) is not the
 * customer's inbox and must not tell them it is broken.
 */
export const INBOX_TROUBLE_CODES: readonly string[] = ['auth_failed', 'provider_error', 'connection_limit'];

/** What the route returns. Every count is since the first payment. */
export interface FirstWeekCounts {
  /** ISO time of the workspace's first checkout_completed, or null. */
  paidAt: string | null;
  /** True when the workspace is on a paid plan right now. */
  paid: boolean;
  /** True once the owner dismissed the card for this workspace. */
  dismissed: boolean;
  /** Distinct UTC days with a successful call, capped at TARGET_ACTIVE_DAYS. */
  successDays: number;
  /** Error codes of the latest calls, newest first, null for a success. */
  recentErrorCodes: (string | null)[];
  /** Inbox id of the newest call that failed with an inbox-trouble code. */
  troubleInboxId: string | null;
  /** Non-deleted automations (triage_rules). */
  automationCount: number;
}

export type FirstWeekItemId = 'first_call' | 'inbox_attention' | 'active_days' | 'automation' | 'another_inbox';

export interface FirstWeekItem {
  id: FirstWeekItemId;
  done: boolean;
  /** An optional item never keeps the card on screen by itself. */
  optional: boolean;
  /** active_days: days so far, out of TARGET_ACTIVE_DAYS. */
  progress?: number;
  /** another_inbox: the plan's inbox allowance. */
  inboxLimit?: number;
  /** inbox_attention: the inbox to reconnect, when known. */
  inboxId?: string | null;
}

export interface FirstWeekState {
  visible: boolean;
  items: FirstWeekItem[];
}

const HIDDEN: FirstWeekState = { visible: false, items: [] };

/**
 * True when most of the latest calls failed because of the mailbox.
 * "Most" is strictly more than half of the calls looked at, so one failure
 * among two calls is not enough, and no calls at all is never trouble.
 */
export function inboxNeedsAttention(recentErrorCodes: readonly (string | null)[]): boolean {
  const window = recentErrorCodes.slice(0, RECENT_CALL_WINDOW);
  if (window.length === 0) return false;
  const trouble = window.filter((c) => c != null && INBOX_TROUBLE_CODES.includes(c)).length;
  return trouble * 2 > window.length;
}

/** True while `now` is within the window that starts at the first payment. */
export function withinFirstWeekWindow(paidAt: string | null, now: Date): boolean {
  if (!paidAt) return false;
  const paid = Date.parse(paidAt);
  if (!Number.isFinite(paid)) return false;
  const age = now.getTime() - paid;
  return age >= 0 && age < FIRST_WEEK_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * The checklist for one owner.
 *
 * `inboxCount` and `maxInboxes` come from the dashboard's live arrays, never
 * from the route, so the card and the inbox badge cannot disagree. A null
 * `maxInboxes` means unlimited, and an unlimited plan gets no inbox row:
 * "your plan includes N" has no N to say.
 */
export function firstWeekChecklist({
  counts,
  now,
  isOwner,
  inboxCount,
  maxInboxes,
}: {
  counts: FirstWeekCounts | null | undefined;
  now: Date;
  isOwner: boolean;
  inboxCount: number;
  maxInboxes: number | null | undefined;
}): FirstWeekState {
  if (!isOwner || !counts || !counts.paid || counts.dismissed) return HIDDEN;
  if (!withinFirstWeekWindow(counts.paidAt, now)) return HIDDEN;

  const items: FirstWeekItem[] = [];
  const days = Math.max(0, Math.min(TARGET_ACTIVE_DAYS, Math.floor(counts.successDays || 0)));

  if (inboxNeedsAttention(counts.recentErrorCodes ?? [])) {
    items.push({ id: 'inbox_attention', done: false, optional: false, inboxId: counts.troubleInboxId ?? null });
  } else {
    items.push({ id: 'first_call', done: days > 0, optional: false });
  }
  items.push({ id: 'active_days', done: days >= TARGET_ACTIVE_DAYS, optional: false, progress: days });
  items.push({ id: 'automation', done: (counts.automationCount ?? 0) > 0, optional: false });

  if (typeof maxInboxes === 'number' && Number.isFinite(maxInboxes) && inboxCount < maxInboxes) {
    items.push({ id: 'another_inbox', done: false, optional: true, inboxLimit: maxInboxes });
  }

  const visible = items.some((item) => !item.optional && !item.done);
  return visible ? { visible, items } : HIDDEN;
}

/**
 * Distinct UTC days with a success since `paidAt`, up to `cap`, using one
 * index-backed "first success at or after T" lookup per day instead of reading
 * every row: a heavy first week is thousands of rows, and PostgREST would cut
 * a plain select off at 1000 without saying so.
 *
 * `firstSuccessAtOrAfter` returns the ISO time of the earliest successful call
 * at or after the given ISO time, or null.
 */
export async function countSuccessDays(
  paidAt: string,
  firstSuccessAtOrAfter: (fromIso: string) => Promise<string | null>,
  cap: number = TARGET_ACTIVE_DAYS,
): Promise<number> {
  let from = paidAt;
  let days = 0;
  while (days < cap) {
    const hit = await firstSuccessAtOrAfter(from);
    if (!hit) break;
    const t = new Date(hit);
    if (!Number.isFinite(t.getTime())) break;
    days += 1;
    from = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1)).toISOString();
  }
  return days;
}

/** Key in the owner's auth user_metadata that holds dismissed workspace ids. */
export const DISMISSED_METADATA_KEY = 'first_week_checklist_dismissed';

/** Keep the list short: it rides in the session token. */
const MAX_DISMISSED = 20;

/** Workspace ids the owner has dismissed the card for. */
export function dismissedWorkspaceIds(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const raw = (metadata as Record<string, unknown>)[DISMISSED_METADATA_KEY];
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

/** The list after dismissing `workspaceId`, newest last, bounded. */
export function withDismissed(metadata: unknown, workspaceId: string): string[] {
  const list = dismissedWorkspaceIds(metadata).filter((id) => id !== workspaceId);
  list.push(workspaceId);
  return list.slice(-MAX_DISMISSED);
}
