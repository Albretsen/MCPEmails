/**
 * Inbox parking: which inboxes stay active when a plan includes fewer.
 *
 * WHAT PARKED MEANS. `inboxes.parked_at` is set (migration 20261024150000):
 * credentials kept, nothing deleted, no MCP tool can resolve the inbox, its
 * automations are paused with `paused_reason = 'inbox_parked'`, new scheduled
 * sends from it are refused (ones created before parking still go out), and
 * the Inboxes page shows it greyed. Unparking reverses exactly that.
 *
 * WHO CALLS THIS. The pause and downgrade work, at the moment the plan actually
 * drops (pause start, downgrade date) and again on upgrade or resume.
 * Documents/plans/pause-downgrade-20261024.md, section 2.4. Nothing calls it
 * yet, so shipping this module changes no behaviour.
 *
 * THE CHOICE. `chooseActiveInboxes` is pure: the customer's own order first,
 * then the inboxes already active (so a re-run with the same cap is a no-op),
 * then the most used in the last 30 days, then the oldest. Usage comes from
 * `workspace_inbox_activity` (20260819120000), one aggregated query over
 * `activity_log`, the same numbers the Inboxes page shows. It is SECURITY
 * INVOKER and filters on its argument only, so it answers under the service
 * role too.
 *
 * SAFETY. Every read and write is scoped to the one workspace; every write
 * repeats its predicate (`parked_at is null` to park, `not null` to unpark,
 * `paused_reason = 'inbox_parked'` to resume), so a replay or two concurrent
 * calls change nothing twice, and a rule paused for any other reason is never
 * resumed here. Neither I/O function throws: the callers sit beside billing
 * writes that matter more (the Stripe webhook answers 500 on a throw). A
 * failure is logged and reported as `failed: true`, and a re-run repairs it.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';
import { resumeSlots } from '@/lib/billing/plan-limit-pauses';

/** The only value of `inboxes.parked_reason` (inboxes_parked_reason_check). */
export const PARKED_REASON_PLAN_LIMIT = 'plan_limit';

/** `triage_rules.paused_reason` for a rule whose inbox is parked. */
export const INBOX_PARKED_PAUSE_REASON = 'inbox_parked';

/**
 * `triage_rules.paused_until` for a parking pause. The dispatcher's predicate
 * (`paused_until is null or paused_until <= now()`) never claims it, so the
 * rule waits for `unparkUpToCap` and nothing else.
 */
export const INBOX_PARKED_PAUSED_UNTIL = 'infinity';

/** The usage window the choice is ranked on. */
export const PARKING_USAGE_DAYS = 30;

// ── Types for the columns gen:types has not seen yet ─────────────────────────
//
// `src/types/database.types.ts` is generated from the linked project, and the
// parking columns exist there only once 20261024150000 is applied. Until then
// the client stays `SupabaseClient<Database>` and the two columns are handled
// in exactly two narrow places: the inbox read below names its row shape
// (`ParkingInboxRow`), and the inbox writes pass their patch as a
// `Record<string, unknown>` (`InboxParkingPatch`), the same shape
// src/lib/approvals/columns.ts uses for columns a migration adds after the
// code. Filters on the columns use the client's string-column overloads. After
// the migration is applied and `npm run gen:types` has run, both can become the
// generated Row and Update types.

type InboxParkingPatch = Record<string, unknown> & {
  parked_at: string | null;
  parked_reason: string | null;
};
type ParkingInboxRow = { id: string; created_at: string; parked_at: string | null };

// ── The pure choice ──────────────────────────────────────────────────────────

export interface ParkingCandidate {
  id: string;
  /** ISO. Oldest wins a tie. */
  created_at: string;
  /** ISO or null. Currently parked inboxes rank after active ones. */
  parked_at?: string | null;
  /** Tool calls in the last 30 days. Missing = 0. */
  calls?: number;
}

export interface ActiveInboxChoice<T extends ParkingCandidate> {
  /** In rank order. */
  active: T[];
  /** In rank order. */
  parked: T[];
}

/**
 * Split `inboxes` into the `cap` that stay active and the rest.
 *
 * Rank: ids in `preferredOrder` first, in that order (unknown ids ignored);
 * then inboxes that are not parked now; then most calls; then oldest; then id,
 * so the result never depends on the order rows arrived in.
 *
 * `cap` null, Infinity or not a finite number keeps everything active; a
 * negative cap is 0.
 */
export function chooseActiveInboxes<T extends ParkingCandidate>(
  inboxes: readonly T[],
  cap: number | null,
  preferredOrder: readonly string[] = [],
): ActiveInboxChoice<T> {
  const preferredRank = new Map<string, number>();
  preferredOrder.forEach((id, index) => {
    if (!preferredRank.has(id)) preferredRank.set(id, index);
  });

  const ranked = [...inboxes].sort((a, b) => {
    const pa = preferredRank.get(a.id) ?? Number.POSITIVE_INFINITY;
    const pb = preferredRank.get(b.id) ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    const parkedA = a.parked_at ? 1 : 0;
    const parkedB = b.parked_at ? 1 : 0;
    if (parkedA !== parkedB) return parkedA - parkedB;
    const callsA = a.calls ?? 0;
    const callsB = b.calls ?? 0;
    if (callsA !== callsB) return callsB - callsA;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  if (cap === null || !Number.isFinite(cap)) return { active: ranked, parked: [] };
  const keep = Math.max(0, Math.floor(cap));
  return { active: ranked.slice(0, keep), parked: ranked.slice(keep) };
}

// ── I/O ──────────────────────────────────────────────────────────────────────

export interface ParkingResult {
  /** Inbox ids active after the call, in rank order. */
  active: string[];
  /** Inbox ids parked after the call, in rank order. */
  parked: string[];
  /** Parked by THIS call. Empty on a replay. */
  newlyParked: string[];
  /** Unparked by THIS call. Empty on a replay. */
  unparked: string[];
  /** Rules paused with 'inbox_parked' by this call. */
  rulesPaused: number;
  /** Rules whose 'inbox_parked' pause this call lifted. */
  rulesResumed: number;
  /** True when any read or write failed. Already logged; re-run to repair. */
  failed: boolean;
}

export interface ParkingOptions {
  now?: Date;
  /** Shown in log lines, e.g. 'pause_start' or 'webhook'. */
  label?: string;
}

type CandidateRow = ParkingCandidate & { id: string };

/** `ids` in the order of `ranked` (the database returns updated rows in its own order). */
function inRankOrder(ids: readonly string[], ranked: readonly { id: string }[]): string[] {
  const wanted = new Set(ids);
  return ranked.filter((row) => wanted.has(row.id)).map((row) => row.id);
}

function emptyResult(failed: boolean): ParkingResult {
  return { active: [], parked: [], newlyParked: [], unparked: [], rulesPaused: 0, rulesResumed: 0, failed };
}

/** The workspace's connected inboxes with their 30-day call counts, or null on a failed read. */
async function loadCandidates(
  db: SupabaseClient<Database>,
  workspaceId: string,
  label: string,
): Promise<CandidateRow[] | null> {
  const [inboxes, usage] = await Promise.all([
    db
      .from('inboxes')
      .select('id, created_at, parked_at')
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null),
    db.rpc('workspace_inbox_activity', { p_workspace_id: workspaceId, p_days: PARKING_USAGE_DAYS }),
  ]);
  if (inboxes.error) {
    console.error(`[parking] ${label}: could not read inboxes; nothing changed: ${inboxes.error.message}`);
    return null;
  }
  const calls = new Map<string, number>();
  if (usage.error) {
    // Usage only ranks the choice. Without it the oldest inboxes win, which is
    // a worse guess but not a wrong state, and the customer can swap later.
    console.warn(`[parking] ${label}: usage read failed; ranking by age: ${usage.error.message}`);
  } else {
    for (const row of usage.data ?? []) {
      if (row.inbox_id) calls.set(row.inbox_id, row.calls ?? 0);
    }
  }
  // The projection names `parked_at`, which the generated row type does not
  // know yet (see the type notes above), so the row shape is stated here.
  const rows = (inboxes.data ?? []) as unknown as ParkingInboxRow[];
  return rows.map((row) => ({
    id: row.id,
    created_at: row.created_at,
    parked_at: row.parked_at ?? null,
    calls: calls.get(row.id) ?? 0,
  }));
}

/** Set parked_at on the given ids that are still active. Returns the ids it parked. */
async function parkIds(
  db: SupabaseClient<Database>,
  workspaceId: string,
  ids: string[],
  now: Date,
): Promise<{ ids: string[]; error: string | null }> {
  if (ids.length === 0) return { ids: [], error: null };
  const patch: InboxParkingPatch = { parked_at: now.toISOString(), parked_reason: PARKED_REASON_PLAN_LIMIT };
  const { data, error } = await db
    .from('inboxes')
    .update(patch)
    .eq('workspace_id', workspaceId)
    .in('id', ids)
    .is('parked_at', null)
    .is('deleted_at', null)
    .select('id');
  if (error) return { ids: [], error: error.message };
  return { ids: (data ?? []).map((row) => row.id), error: null };
}

/** Clear parked_at on the given ids that are still parked. Returns the ids it unparked. */
async function unparkIds(
  db: SupabaseClient<Database>,
  workspaceId: string,
  ids: string[],
): Promise<{ ids: string[]; error: string | null }> {
  if (ids.length === 0) return { ids: [], error: null };
  const patch: InboxParkingPatch = { parked_at: null, parked_reason: null };
  const { data, error } = await db
    .from('inboxes')
    .update(patch)
    .eq('workspace_id', workspaceId)
    .in('id', ids)
    .not('parked_at', 'is', null)
    .select('id');
  if (error) return { ids: [], error: error.message };
  return { ids: (data ?? []).map((row) => row.id), error: null };
}

/**
 * Pause every live rule bound to a parked inbox that is not already paused for
 * parking. A rule paused for the Free allowance is re-labelled: the parking
 * pause is the stronger one, and when the inbox comes back the dispatcher
 * re-checks the allowance before it runs anything.
 *
 * Disabled rules are paused too, so turning one back on while its inbox is
 * parked does not make it run against an inbox it cannot open.
 */
async function pauseRulesFor(
  db: SupabaseClient<Database>,
  workspaceId: string,
  inboxIds: string[],
): Promise<{ count: number; error: string | null }> {
  if (inboxIds.length === 0) return { count: 0, error: null };
  const { data: rules, error: readError } = await db
    .from('triage_rules')
    .select('id, paused_reason')
    .eq('workspace_id', workspaceId)
    .in('inbox_id', inboxIds)
    .is('deleted_at', null);
  if (readError) return { count: 0, error: readError.message };
  const ids = (rules ?? [])
    .filter((rule) => rule.paused_reason !== INBOX_PARKED_PAUSE_REASON)
    .map((rule) => rule.id);
  if (ids.length === 0) return { count: 0, error: null };
  const { data, error } = await db
    .from('triage_rules')
    .update({ paused_reason: INBOX_PARKED_PAUSE_REASON, paused_until: INBOX_PARKED_PAUSED_UNTIL })
    .eq('workspace_id', workspaceId)
    .in('id', ids)
    .is('deleted_at', null)
    .select('id');
  if (error) return { count: 0, error: error.message };
  return { count: data?.length ?? 0, error: null };
}

/**
 * Lift the 'inbox_parked' pause on rules bound to these (now active) inboxes,
 * and only that pause. Enabled rules become due, spread like the plan-limit
 * lift (`resumeSlots`); disabled rules keep `next_run_at` as it is (null).
 */
async function resumeRulesFor(
  db: SupabaseClient<Database>,
  workspaceId: string,
  inboxIds: string[],
  now: Date,
): Promise<{ count: number; error: string | null }> {
  if (inboxIds.length === 0) return { count: 0, error: null };
  const { data: rules, error: readError } = await db
    .from('triage_rules')
    .select('id, enabled')
    .eq('workspace_id', workspaceId)
    .in('inbox_id', inboxIds)
    .eq('paused_reason', INBOX_PARKED_PAUSE_REASON)
    .is('deleted_at', null);
  if (readError) return { count: 0, error: readError.message };
  if (!rules || rules.length === 0) return { count: 0, error: null };

  const cleared = { paused_reason: null, paused_until: null };
  const enabled = rules.filter((rule) => rule.enabled).map((rule) => rule.id).sort();
  const disabled = rules.filter((rule) => !rule.enabled).map((rule) => rule.id).sort();
  const writes: Array<{ patch: typeof cleared & { next_run_at?: string }; ids: string[] }> =
    resumeSlots(enabled, now).map((slot) => ({ patch: { ...cleared, next_run_at: slot.nextRunAt }, ids: slot.ruleIds }));
  if (disabled.length > 0) writes.push({ patch: cleared, ids: disabled });

  let count = 0;
  let firstError: string | null = null;
  for (const write of writes) {
    const { data, error } = await db
      .from('triage_rules')
      .update(write.patch)
      .eq('workspace_id', workspaceId)
      .in('id', write.ids)
      .eq('paused_reason', INBOX_PARKED_PAUSE_REASON)
      .is('deleted_at', null)
      .select('id');
    if (error) {
      firstError ??= error.message;
      continue;
    }
    count += data?.length ?? 0;
  }
  return { count, error: firstError };
}

/**
 * Make the workspace's active inboxes exactly the `cap` that
 * `chooseActiveInboxes` picks, and park the rest.
 *
 * In practice this parks: with no `preferredOrder`, inboxes already active rank
 * first, so the only inbox it unparks is one that fills a free slot (fewer
 * active than the cap). With a `preferredOrder` it can swap: a preferred parked
 * inbox comes back and the lowest-ranked active one is parked in its place.
 *
 * Rules on every parked inbox are paused with 'inbox_parked'; rules on an
 * inbox it unparks are resumed. Idempotent: a second call with the same
 * arguments writes nothing. Never touches another workspace. Never throws.
 */
export async function parkAboveCap(
  client: SupabaseClient<Database>,
  workspaceId: string,
  cap: number | null,
  preferredOrder: readonly string[] = [],
  options: ParkingOptions = {},
): Promise<ParkingResult> {
  const label = options.label ?? 'park';
  const now = options.now ?? new Date();
  const db = client;
  try {
    const candidates = await loadCandidates(db, workspaceId, label);
    if (!candidates) return emptyResult(true);

    const choice = chooseActiveInboxes(candidates, cap, preferredOrder);
    const toPark = choice.parked.filter((inbox) => !inbox.parked_at).map((inbox) => inbox.id);
    const toUnpark = choice.active.filter((inbox) => inbox.parked_at).map((inbox) => inbox.id);

    let failed = false;
    const fail = (what: string, message: string) => {
      failed = true;
      console.error(`[parking] ${label}: ${what} failed for workspace ${workspaceId}: ${message}`);
    };

    // Park before unparking, so a failure between the two leaves fewer active
    // inboxes than the plan allows, never more.
    const parkedNow = await parkIds(db, workspaceId, toPark, now);
    if (parkedNow.error) fail('park', parkedNow.error);
    const unparkedNow = parkedNow.error ? { ids: [], error: null } : await unparkIds(db, workspaceId, toUnpark);
    if (unparkedNow.error) fail('unpark', unparkedNow.error);

    // Every inbox that is parked now, not only the ones this call parked: a
    // replay after a failed rule write repairs the rules.
    const parkedIds = choice.parked
      .filter((inbox) => inbox.parked_at || parkedNow.ids.includes(inbox.id))
      .map((inbox) => inbox.id);
    const paused = await pauseRulesFor(db, workspaceId, parkedIds);
    if (paused.error) fail('rule pause', paused.error);
    const resumed = await resumeRulesFor(db, workspaceId, unparkedNow.ids, now);
    if (resumed.error) fail('rule resume', resumed.error);

    const parkedSet = new Set(parkedIds);
    for (const id of toUnpark) if (!unparkedNow.ids.includes(id)) parkedSet.add(id);
    const ordered = [...choice.active, ...choice.parked].map((inbox) => inbox.id);
    const result: ParkingResult = {
      active: ordered.filter((id) => !parkedSet.has(id)),
      parked: ordered.filter((id) => parkedSet.has(id)),
      newlyParked: inRankOrder(parkedNow.ids, choice.parked),
      unparked: inRankOrder(unparkedNow.ids, choice.active),
      rulesPaused: paused.count,
      rulesResumed: resumed.count,
      failed,
    };
    if (result.newlyParked.length > 0 || result.unparked.length > 0 || result.rulesPaused > 0) {
      console.log(
        `[parking] ${label}: workspace ${workspaceId} cap ${cap ?? 'none'}: parked ${result.newlyParked.length}, ` +
          `unparked ${result.unparked.length}, paused ${result.rulesPaused} rule(s)`,
      );
    }
    return result;
  } catch (err) {
    console.error('[parking] unexpected failure, swallowed:', {
      label,
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return emptyResult(true);
  }
}

/**
 * Unpark parked inboxes until `cap` are active (`cap` null or Infinity: all),
 * in `chooseActiveInboxes` order, and resume their 'inbox_parked' rules.
 *
 * Never parks anything: a workspace already above `cap` is left as it is (that
 * is `parkAboveCap`'s job). Rules paused for any other reason stay paused.
 * Idempotent, scoped to one workspace, never throws.
 */
export async function unparkUpToCap(
  client: SupabaseClient<Database>,
  workspaceId: string,
  cap: number | null,
  preferredOrder: readonly string[] = [],
  options: ParkingOptions = {},
): Promise<ParkingResult> {
  const label = options.label ?? 'unpark';
  const now = options.now ?? new Date();
  const db = client;
  try {
    const candidates = await loadCandidates(db, workspaceId, label);
    if (!candidates) return emptyResult(true);

    const active = candidates.filter((inbox) => !inbox.parked_at);
    const parked = candidates.filter((inbox) => inbox.parked_at);
    const room = cap === null || !Number.isFinite(cap)
      ? parked.length
      : Math.max(0, Math.floor(cap) - active.length);
    // Rank the parked ones on their own: all are parked, so the order is the
    // customer's, then usage, then age.
    const { active: comeBack } = chooseActiveInboxes(parked, room, preferredOrder);

    let failed = false;
    const unparkedNow = await unparkIds(db, workspaceId, comeBack.map((inbox) => inbox.id));
    if (unparkedNow.error) {
      failed = true;
      console.error(`[parking] ${label}: unpark failed for workspace ${workspaceId}: ${unparkedNow.error}`);
    }
    // Resume on every active inbox, not only the ones unparked now: a replay
    // after a failed rule write repairs the rules.
    const activeIds = [...active.map((inbox) => inbox.id), ...unparkedNow.ids];
    const resumed = await resumeRulesFor(db, workspaceId, activeIds, now);
    if (resumed.error) {
      failed = true;
      console.error(`[parking] ${label}: rule resume failed for workspace ${workspaceId}: ${resumed.error}`);
    }

    const stillParked = parked.filter((inbox) => !unparkedNow.ids.includes(inbox.id));
    const result: ParkingResult = {
      active: chooseActiveInboxes(
        candidates.filter((inbox) => !stillParked.includes(inbox)),
        null,
        preferredOrder,
      ).active.map((inbox) => inbox.id),
      parked: chooseActiveInboxes(stillParked, null, preferredOrder).active.map((inbox) => inbox.id),
      newlyParked: [],
      unparked: inRankOrder(unparkedNow.ids, comeBack),
      rulesPaused: 0,
      rulesResumed: resumed.count,
      failed,
    };
    if (result.unparked.length > 0 || result.rulesResumed > 0) {
      console.log(
        `[parking] ${label}: workspace ${workspaceId} cap ${cap ?? 'none'}: unparked ${result.unparked.length}, ` +
          `resumed ${result.rulesResumed} rule(s)`,
      );
    }
    return result;
  } catch (err) {
    console.error('[parking] unexpected failure, swallowed:', {
      label,
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return emptyResult(true);
  }
}
