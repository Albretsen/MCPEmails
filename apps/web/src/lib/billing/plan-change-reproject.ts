/**
 * The cron fallback for pause and downgrade projections.
 *
 * The webhook projects the plan change on the events that carry it (the
 * period roll's customer.subscription.updated, invoice.voided). This makes
 * sure no customer depends on one webhook: the billing dispatch cron (every
 * five minutes) calls `reprojectDuePlanChanges`, which re-reads from Stripe
 * any owner whose stored state is overdue:
 *
 *   paused_from has passed but the row is not 'paused' yet   (pause started)
 *   the row is 'paused' but pause_resumes_at passed 2h ago   (pause ended)
 *   pending_plan_effective_at has passed                     (downgrade landed)
 *
 * and applies the same projection the webhook would: user_billing plan and
 * status, workspaces.plan, the pause/downgrade columns, park or unpark.
 *
 * Small and bounded (BATCH rows per run), and it never throws: the email
 * dispatch it runs in front of must not depend on it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';

import type { Database } from '@/types/database.types';
import { isUnknownColumnError } from '@/lib/approvals/columns';
import { basePlanItem, getPlanByStripePriceId } from '@/lib/stripe/plans';
import {
  PAUSED_STATUS,
  parkOwner,
  projectSubscription,
  unparkOwner,
  writePlanChangeColumns,
} from '@/lib/billing/plan-change-sync';

type Db = SupabaseClient<Database>;

const BATCH = 20;

/** How long after resumes_at a still-'paused' row counts as missed. */
const RESUME_GRACE_MS = 2 * 60 * 60 * 1000;

interface DueRow {
  user_id: string;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
  paused_from: string | null;
  pause_resumes_at: string | null;
  pending_plan: string | null;
  pending_plan_effective_at: string | null;
  inbox_keep_order: string[] | null;
}

type DbError = { message: string; code?: string } | null;

/** The narrow facade over the 20261024190000 columns (see plan-change-sync.ts). */
interface DueTable {
  select(columns: string): {
    not(column: 'paused_from' | 'pending_plan', operator: 'is', value: null): {
      limit(n: number): PromiseLike<{ data: DueRow[] | null; error: DbError }>;
    };
  };
}

const COLUMNS =
  'user_id, stripe_subscription_id, subscription_status, paused_from, pause_resumes_at, ' +
  'pending_plan, pending_plan_effective_at, inbox_keep_order';

/** Pure: is this row overdue for a re-projection at `now`? */
export function isOverdue(row: DueRow, now: Date): boolean {
  const t = now.getTime();
  const at = (iso: string | null) => (iso ? new Date(iso).getTime() : null);
  const pausedFrom = at(row.paused_from);
  const resumesAt = at(row.pause_resumes_at);
  const effective = at(row.pending_plan_effective_at);
  if (pausedFrom !== null && pausedFrom <= t && row.subscription_status !== PAUSED_STATUS) return true;
  if (row.subscription_status === PAUSED_STATUS && resumesAt !== null && resumesAt + RESUME_GRACE_MS <= t) return true;
  if (row.pending_plan && effective !== null && effective <= t) return true;
  return false;
}

export interface ReprojectStripe {
  subscriptions: { retrieve(id: string): Promise<Stripe.Subscription> };
}

export async function reprojectDuePlanChanges(
  db: Db,
  stripe: ReprojectStripe,
  now: Date = new Date(),
): Promise<{ checked: number; reprojected: number; failed: number }> {
  const result = { checked: 0, reprojected: 0, failed: 0 };
  try {
    const table = db.from('user_billing') as unknown as DueTable;
    const [paused, pending] = await Promise.all([
      table.select(COLUMNS).not('paused_from', 'is', null).limit(200),
      table.select(COLUMNS).not('pending_plan', 'is', null).limit(200),
    ]);
    for (const read of [paused, pending]) {
      if (read.error) {
        if (!isUnknownColumnError(read.error)) {
          console.error(`[plan-change-reproject] read failed: ${read.error.message}`);
        }
        return result;
      }
    }
    const seen = new Set<string>();
    const due = [...(paused.data ?? []), ...(pending.data ?? [])]
      .filter((row) => {
        if (seen.has(row.user_id)) return false;
        seen.add(row.user_id);
        return isOverdue(row, now);
      })
      .slice(0, BATCH);

    for (const row of due) {
      result.checked += 1;
      if (!row.stripe_subscription_id) continue;
      try {
        const subscription = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
        if (await reprojectOne(db, row, subscription, now)) result.reprojected += 1;
      } catch (err) {
        result.failed += 1;
        console.error(`[plan-change-reproject] ${row.user_id} failed:`, err instanceof Error ? err.message : String(err));
      }
    }
  } catch (err) {
    console.error('[plan-change-reproject] unexpected failure, swallowed:', err instanceof Error ? err.message : String(err));
  }
  if (result.checked > 0) console.log(`[plan-change-reproject] ${JSON.stringify(result)}`);
  return result;
}

const ENTITLED = new Set(['active', 'trialing', 'past_due', 'unpaid']);

async function reprojectOne(db: Db, row: DueRow, subscription: Stripe.Subscription, now: Date): Promise<boolean> {
  const label = `cron ${subscription.id}`;
  const clear = { paused_from: null, pause_resumes_at: null, pending_plan: null, pending_plan_effective_at: null };

  if (!ENTITLED.has(subscription.status)) {
    // Ended: the deleted webhook owns the plan write; only clear the state.
    await writePlanChangeColumns(db, row.user_id, clear);
    return true;
  }
  const priceId = basePlanItem(subscription.items.data)?.price?.id;
  const resolved = getPlanByStripePriceId(priceId);
  if (!resolved) return false;

  const projection = projectSubscription(subscription, resolved.plan.id, now);
  const { error: billingError } = await db
    .from('user_billing')
    .update({ plan: projection.grantPlan, subscription_status: projection.status, updated_at: now.toISOString() })
    .eq('user_id', row.user_id);
  if (billingError) throw new Error(billingError.message);
  const { error: workspaceError } = await db
    .from('workspaces')
    .update({ plan: projection.grantPlan, updated_at: now.toISOString() })
    .eq('owner_id', row.user_id)
    .is('deleted_at', null);
  if (workspaceError) throw new Error(workspaceError.message);
  await writePlanChangeColumns(db, row.user_id, projection.columns);

  if (projection.parkTo) {
    await parkOwner(db, row.user_id, projection.parkTo, row.inbox_keep_order, label);
  } else if (projection.unpark) {
    await unparkOwner(db, row.user_id, projection.grantPlan, row.inbox_keep_order, label);
  }
  return true;
}
