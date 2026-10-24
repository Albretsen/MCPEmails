/**
 * Swapping a parked inbox with an active one, at most once per workspace per
 * rolling 24 hours (Documents/plans/pause-downgrade-20261024.md, section 2.4:
 * "one swap a day, to stop rotating 10 inboxes through one Free slot").
 *
 * Used by app/api/inboxes/swap-parked/route.ts. The parking itself is
 * parking.ts (`parkAboveCap` with the customer's pick first), so rules on the
 * swapped inboxes are paused and resumed exactly as at a plan change.
 *
 * THE CLOCK. `workspaces.inbox_swapped_at` (migration 20261025020000), claimed
 * with a conditional update on the value just read, so two clicks at once
 * cannot both swap. The column is reached through one narrow facade, like
 * plan-change-sync.ts, because the committed types are generated from
 * production, where the migration is not applied yet.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';
import { isUnknownColumnError } from '@/lib/approvals/columns';

type Db = SupabaseClient<Database>;
type DbError = { message: string; code?: string } | null;

export const SWAP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** When the next swap is allowed, or null when one is allowed now. Pure. */
export function nextSwapAllowedAt(lastSwapAt: string | null, now: Date): Date | null {
  if (!lastSwapAt) return null;
  const last = new Date(lastSwapAt).getTime();
  if (Number.isNaN(last)) return null;
  const next = last + SWAP_WINDOW_MS;
  return next > now.getTime() ? new Date(next) : null;
}

export interface SwapInbox {
  id: string;
  parked_at: string | null;
}

export type SwapPlan =
  | { ok: true; cap: number; preferredOrder: string[] }
  | { ok: false; error: 'not_parked' | 'active_not_found' | 'pick_active' | 'over_cap' };

/**
 * What `parkAboveCap` should be called with. Pure.
 *
 * With `activeInboxId`: a one-for-one swap. The parked inbox and every other
 * active inbox stay active, the picked one is parked. Without it: only when
 * the workspace has a free slot under `planCap`. Either way the active count
 * after the swap never exceeds `planCap` (null = unlimited).
 */
export function planSwap(
  inboxes: readonly SwapInbox[],
  parkedInboxId: string,
  activeInboxId: string | null,
  planCap: number | null,
): SwapPlan {
  const parked = inboxes.find((inbox) => inbox.id === parkedInboxId);
  if (!parked || !parked.parked_at) return { ok: false, error: 'not_parked' };
  const active = inboxes.filter((inbox) => !inbox.parked_at).map((inbox) => inbox.id);
  if (activeInboxId !== null && !active.includes(activeInboxId)) return { ok: false, error: 'active_not_found' };
  const keep = activeInboxId === null ? active : active.filter((id) => id !== activeInboxId);
  const after = keep.length + 1;
  if (planCap !== null && after > planCap) {
    return { ok: false, error: activeInboxId === null ? 'pick_active' : 'over_cap' };
  }
  return { ok: true, cap: after, preferredOrder: [parkedInboxId, ...keep] };
}

/**
 * The owner's new keep order after a swap: the active inboxes first, then the
 * rest of the old order without the inbox that was just parked. Pure.
 */
export function keepOrderAfterSwap(
  active: readonly string[],
  previous: readonly string[] | null,
  swappedOut: string | null,
): string[] {
  const seen = new Set(active);
  const rest = (previous ?? []).filter((id) => !seen.has(id) && id !== swappedOut);
  return [...active, ...rest].slice(0, 200);
}

// ── The clock ────────────────────────────────────────────────────────────────

interface ClockRow {
  owner_id: string;
  inbox_swapped_at: string | null;
}

interface ClaimChain {
  eq(column: 'id' | 'inbox_swapped_at', value: string): ClaimChain;
  is(column: 'inbox_swapped_at', value: null): ClaimChain;
  select(columns: 'id'): PromiseLike<{ data: Array<{ id: string }> | null; error: DbError }>;
}

interface ClockTable {
  select(columns: string): {
    eq(column: 'id', value: string): {
      is(column: 'deleted_at', value: null): {
        maybeSingle(): PromiseLike<{ data: ClockRow | null; error: DbError }>;
      };
    };
  };
  update(patch: { inbox_swapped_at: string | null }): ClaimChain;
}

function clockTable(db: Db): ClockTable {
  return db.from('workspaces') as unknown as ClockTable;
}

export type ClockRead =
  | { ok: true; ownerId: string; lastSwapAt: string | null }
  | { ok: false; reason: 'not_found' | 'unavailable' | 'failed' };

export async function readSwapClock(db: Db, workspaceId: string): Promise<ClockRead> {
  const { data, error } = await clockTable(db)
    .select('owner_id, inbox_swapped_at')
    .eq('id', workspaceId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) {
    if (isUnknownColumnError(error)) return { ok: false, reason: 'unavailable' };
    console.error(`[inbox-swap] clock read failed: ${error.message}`);
    return { ok: false, reason: 'failed' };
  }
  if (!data) return { ok: false, reason: 'not_found' };
  return { ok: true, ownerId: data.owner_id, lastSwapAt: data.inbox_swapped_at ?? null };
}

/**
 * Set the clock to `value` only if it still reads `expected`. True when this
 * call won. Also used to put the clock back after a failed swap.
 */
export async function claimSwapClock(
  db: Db,
  workspaceId: string,
  expected: string | null,
  value: string | null,
): Promise<boolean> {
  const base = clockTable(db).update({ inbox_swapped_at: value }).eq('id', workspaceId);
  const guarded = expected === null ? base.is('inbox_swapped_at', null) : base.eq('inbox_swapped_at', expected);
  const { data, error } = await guarded.select('id');
  if (error) {
    console.error(`[inbox-swap] clock write failed: ${error.message}`);
    return false;
  }
  return (data?.length ?? 0) > 0;
}
