/**
 * The third source of milestone dates, after a ladder's own series and the
 * hand-kept record: the day the board first saw a rung reached.
 *
 * WHY. Rungs read from a snapshot (Stripe MRR, paying customers, lifecycle
 * counts, the record signup day) cannot date themselves, and the hand-kept
 * record in `growth-milestone-record.ts` only grows when someone reruns its
 * queries. Until then every new rung sat under "Reached, day unknown". The
 * board renders every few minutes, so writing the current UTC day the first
 * time a rung shows up reached and undated dates it to its crossing day, or a
 * little after when nobody had the board open. Never before: a late day is
 * allowed, an early one is not, the same rule the record follows.
 *
 * NOTHING HERE THROWS. A failed read or write leaves the rung undated for this
 * render, which the panel already draws, and the next render tries again.
 */

import { createServiceRoleClient } from '@/lib/supabase/service';
import { achievementReport, type AchievementInput, type AchievementReport } from './growth-achievements';
import { MILESTONE_UNLOCK_RECORD, type MilestoneUnlockRecord, type RecordedUnlock } from './growth-milestone-record';

const NOTE = 'first seen reached by the board: this day or, if the board was closed, a little earlier';

/** Every day the board has stored, keyed like the record. Empty on failure. */
export async function fetchStoredUnlocks(): Promise<MilestoneUnlockRecord> {
  try {
    const service = createServiceRoleClient();
    const { data, error } = await service.from('growth_milestone_unlocks').select('id, day, note');
    if (error || !data) return {};
    const record: Record<string, RecordedUnlock> = {};
    for (const row of data) record[row.id] = { day: row.day, note: row.note };
    return record;
  } catch {
    return {};
  }
}

/**
 * Stores today for every reached rung the report could not date, and returns
 * what was stored so the caller can rebuild the report with it. Insert-only:
 * a day already written is never moved.
 */
export async function storeFirstSeenUnlocks(
  report: AchievementReport,
  now: number = Date.now(),
): Promise<MilestoneUnlockRecord> {
  const undated = report.unlocked.filter((entry) => !entry.unlockedOn);
  if (undated.length === 0) return {};
  const day = new Date(now).toISOString().slice(0, 10);
  const rows = undated.map((entry) => ({ id: entry.id, day, note: NOTE }));
  try {
    const service = createServiceRoleClient();
    const { error } = await service
      .from('growth_milestone_unlocks')
      .upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
    if (error) return {};
  } catch {
    return {};
  }
  return Object.fromEntries(rows.map((row) => [row.id, { day: row.day, note: row.note }]));
}

/**
 * The milestone report with every reached rung dated. The hand-kept record
 * wins over what the board stored, and a rung neither can date is stored as
 * reached today, so nothing stays undated past this render.
 */
export async function datedMilestoneReport(
  input: AchievementInput,
  stored: MilestoneUnlockRecord,
  now: number = Date.now(),
): Promise<AchievementReport> {
  const record = { ...stored, ...MILESTONE_UNLOCK_RECORD };
  const first = achievementReport(input, now, record);
  const added = await storeFirstSeenUnlocks(first, now);
  return Object.keys(added).length > 0 ? achievementReport(input, now, { ...added, ...record }) : first;
}
