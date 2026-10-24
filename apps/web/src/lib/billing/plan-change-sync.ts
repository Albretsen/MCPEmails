/**
 * Projecting a pause or a pending downgrade onto the database.
 *
 * Shared by the Stripe webhook (handleSubscriptionUpserted), the billing
 * dispatch cron's fallback re-projection, and the pause / downgrade routes.
 *
 *   projectSubscription()  PURE. Which plan the owner is entitled to right
 *                          now, which status to store, the user_billing
 *                          pause/downgrade columns, and whether inboxes park
 *                          (plan dropped) or unpark (plan restored).
 *   read/writePlanChangeColumns()
 *                          the six user_billing columns of 20261024233000.
 *   parkOwner() / unparkOwner()
 *                          parking.ts over every workspace the owner has, at
 *                          the plan's inbox cap.
 *
 * NONE OF THE I/O THROWS. Each sits beside the plan write, which matters more:
 * the webhook answers 500 on a throw, Stripe retries, and the plan write would
 * run again. A failure is logged and a later event (or the cron) repairs it.
 *
 * THE COLUMNS AND THE GENERATED TYPES. `src/types/database.types.ts` is
 * generated from production, where 20261024233000 is not applied yet, while
 * CI also type-checks against types generated from a freshly migrated local
 * database, where it is. The six columns are therefore reached through one
 * narrow facade (`planChangeTable`), cast once from the real client. It
 * compiles against both schemas and names exactly the columns it touches.
 * After the migration is applied and `npm run gen:types` has run, replace the
 * facade with the generated Row/Update types, as parking.ts did.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';
import { isUnknownColumnError } from '@/lib/approvals/columns';
import { parkAboveCap, unparkUpToCap } from '@/lib/billing/parking';
import { pauseState, parsePauseHistory, PAUSE_HISTORY_KEY, type PausableSubscription } from '@/lib/billing/pause';
import { downgradeState } from '@/lib/billing/downgrade';
import { resolvePlanLimits, type PlanId } from '@/lib/stripe/plans';
import { recordProductFunnelEvent } from '@/lib/analytics/product-funnel';

type Db = SupabaseClient<Database>;

/** The status we store for a running pause. Our own value, not Stripe's. */
export const PAUSED_STATUS = 'paused';

// ── The columns ──────────────────────────────────────────────────────────────

export interface PlanChangeColumns {
  paused_from: string | null;
  pause_resumes_at: string | null;
  pending_plan: string | null;
  pending_plan_effective_at: string | null;
  pause_history: Array<{ from: number; months: number }>;
}

export interface PlanChangeRow extends PlanChangeColumns {
  plan: string | null;
  subscription_status: string | null;
  inbox_keep_order: string[] | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}

type DbError = { message: string; code?: string } | null;

/** The one place the six columns are typed (see the module note). */
interface PlanChangeTable {
  select(columns: string): {
    eq(column: 'user_id', value: string): {
      maybeSingle(): PromiseLike<{ data: PlanChangeRow | null; error: DbError }>;
    };
  };
  update(patch: Partial<PlanChangeColumns> & { inbox_keep_order?: string[] | null }): {
    eq(column: 'user_id', value: string): PromiseLike<{ error: DbError }>;
  };
}

function planChangeTable(db: Db): PlanChangeTable {
  return db.from('user_billing') as unknown as PlanChangeTable;
}

const ROW_COLUMNS =
  'plan, subscription_status, stripe_customer_id, stripe_subscription_id, paused_from, pause_resumes_at, ' +
  'pending_plan, pending_plan_effective_at, inbox_keep_order, pause_history';

/**
 * The owner's row with the pause/downgrade columns. Null when it cannot be
 * read, including before the migration is applied (unknown column): the
 * callers then skip the pause/downgrade work rather than guess.
 */
export async function readPlanChangeRow(db: Db, userId: string): Promise<PlanChangeRow | null> {
  try {
    const { data, error } = await planChangeTable(db).select(ROW_COLUMNS).eq('user_id', userId).maybeSingle();
    if (error) {
      if (isUnknownColumnError(error)) {
        console.warn('[plan-change] pause/downgrade columns not migrated yet; skipped.');
      } else {
        console.error(`[plan-change] user_billing read failed: ${error.message}`);
      }
      return null;
    }
    return data;
  } catch (err) {
    console.error('[plan-change] user_billing read threw, swallowed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Write some of the columns. Never throws; false on failure. */
export async function writePlanChangeColumns(
  db: Db,
  userId: string,
  patch: Partial<PlanChangeColumns> & { inbox_keep_order?: string[] | null },
): Promise<boolean> {
  try {
    const { error } = await planChangeTable(db).update(patch).eq('user_id', userId);
    if (error) {
      console.error(`[plan-change] user_billing write failed: ${error.message}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[plan-change] user_billing write threw, swallowed:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** Only strings, de-duplicated, at most 200. Anything else is dropped. */
export function sanitizeKeepOrder(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((v): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v));
  return [...new Set(ids)].slice(0, 200);
}

// ── The pure projection ──────────────────────────────────────────────────────

export interface PlanChangeProjection {
  /** The plan the owner is entitled to right now. */
  grantPlan: PlanId | 'free';
  /** The subscription_status to store. */
  status: string;
  columns: PlanChangeColumns;
  /** Park every workspace down to this plan's inbox cap, or null. */
  parkTo: PlanId | 'free' | null;
  /** Unpark up to grantPlan's cap (only matters when something is parked). */
  unpark: boolean;
  pause: ReturnType<typeof pauseState>;
  downgrade: ReturnType<typeof downgradeState>;
}

function iso(seconds: number | null): string | null {
  return seconds == null ? null : new Date(seconds * 1000).toISOString();
}

/**
 * For an ENTITLED subscription (active, trialing, past_due, unpaid) whose
 * price resolved to `pricePlan`.
 *
 *   paused             Free, status 'paused', park to Free's cap.
 *   pause scheduled    the paid plan; paused_from / resumes stored.
 *   downgrade pending  the plan it came from (already paid until the date).
 *   downgrade effective the price's plan; park to its cap.
 *   otherwise          the price's plan; unpark up to its cap.
 */
export function projectSubscription(
  subscription: PausableSubscription,
  pricePlan: PlanId,
  now: Date = new Date(),
): PlanChangeProjection {
  const pause = pauseState(subscription, now);
  const downgrade = downgradeState(subscription, now);
  const history = parsePauseHistory(subscription.metadata?.[PAUSE_HISTORY_KEY]);
  // The pair CHECK wants both or neither, from strictly before resumes. A pause
  // with no end date (set by hand in Stripe) gets a far end; the next event
  // that carries one replaces it.
  let pauseCols: { paused_from: string | null; pause_resumes_at: string | null } = {
    paused_from: null,
    pause_resumes_at: null,
  };
  if (pause.state !== 'none' && pause.pausedFrom != null) {
    const resumes = pause.resumesAt ?? Date.UTC(9999, 11, 31) / 1000;
    if (pause.pausedFrom < resumes) {
      pauseCols = { paused_from: iso(pause.pausedFrom), pause_resumes_at: iso(resumes) };
    }
  }
  const pendingCols =
    downgrade.state === 'pending'
      ? { pending_plan: downgrade.toPlan, pending_plan_effective_at: iso(downgrade.effectiveAt) }
      : { pending_plan: null, pending_plan_effective_at: null };
  const columns: PlanChangeColumns = { ...pauseCols, ...pendingCols, pause_history: history };

  if (pause.state === 'paused') {
    return { grantPlan: 'free', status: PAUSED_STATUS, columns, parkTo: 'free', unpark: false, pause, downgrade };
  }
  if (downgrade.state === 'pending' && downgrade.fromPlan) {
    return {
      grantPlan: downgrade.fromPlan,
      status: subscription.status,
      columns,
      parkTo: null,
      unpark: true,
      pause,
      downgrade,
    };
  }
  if (downgrade.state === 'effective') {
    return { grantPlan: pricePlan, status: subscription.status, columns, parkTo: pricePlan, unpark: false, pause, downgrade };
  }
  return { grantPlan: pricePlan, status: subscription.status, columns, parkTo: null, unpark: true, pause, downgrade };
}

// ── Parking across the owner's workspaces ────────────────────────────────────

interface OwnerWorkspace {
  id: string;
  pro_unlimited_inboxes_exempt: boolean;
}

async function ownerWorkspaces(db: Db, ownerId: string): Promise<OwnerWorkspace[] | null> {
  const { data, error } = await db
    .from('workspaces')
    .select('id, pro_unlimited_inboxes_exempt')
    .eq('owner_id', ownerId)
    .is('deleted_at', null);
  if (error) {
    console.error(`[plan-change] workspace read failed for ${ownerId}: ${error.message}`);
    return null;
  }
  return (data ?? []).map((w) => ({ id: w.id, pro_unlimited_inboxes_exempt: w.pro_unlimited_inboxes_exempt === true }));
}

/**
 * The owner's inbox protections: the 2026-08-19 grandfather (unlimited
 * inboxes on any plan) and a comped grant. On a read failure both are assumed
 * TRUE, so an uncertain read never parks anybody's inbox.
 */
async function ownerProtections(db: Db, ownerId: string): Promise<{ unlimitedInboxes: boolean; compedScale: boolean }> {
  const { data, error } = await db
    .from('user_usage_entitlements')
    .select('kind, unlimited_inboxes, expires_at')
    .eq('user_id', ownerId);
  if (error) {
    console.error(`[plan-change] entitlement read failed for ${ownerId}; treating as protected: ${error.message}`);
    return { unlimitedInboxes: true, compedScale: true };
  }
  const now = Date.now();
  const live = (data ?? []).filter((row) => !row.expires_at || new Date(row.expires_at).getTime() > now);
  return {
    unlimitedInboxes: live.some((row) => row.unlimited_inboxes === true),
    compedScale: live.some((row) => row.kind === 'comped_scale'),
  };
}

/** The per-workspace inbox cap for `plan`, null when unlimited. */
export function inboxCapFor(
  plan: PlanId | 'free',
  protections: { unlimitedInboxes: boolean; compedScale: boolean },
  proUnlimitedInboxes = false,
): number | null {
  const limits = resolvePlanLimits(plan, { ...protections, proUnlimitedInboxes });
  return Number.isFinite(limits.maxInboxes) ? limits.maxInboxes : null;
}

export interface OwnerParkingResult {
  parked: number;
  unparked: number;
  failed: boolean;
}

async function recordParking(workspaceId: string, stage: 'inbox_parked' | 'inbox_unparked', plan: PlanId | 'free', db: Db) {
  try {
    await recordProductFunnelEvent(db, { workspaceId, stage, outcome: 'success', category: plan });
  } catch (err) {
    console.error('[plan-change] funnel write failed, swallowed:', err instanceof Error ? err.message : String(err));
  }
}

/** Park inboxes above `plan`'s cap in every workspace the owner has. Never throws. */
export async function parkOwner(
  db: Db,
  ownerId: string,
  plan: PlanId | 'free',
  keepOrder: readonly string[] | null,
  label: string,
): Promise<OwnerParkingResult> {
  const result: OwnerParkingResult = { parked: 0, unparked: 0, failed: false };
  try {
    const [workspaces, protections] = await Promise.all([ownerWorkspaces(db, ownerId), ownerProtections(db, ownerId)]);
    if (!workspaces) return { ...result, failed: true };
    for (const workspace of workspaces) {
      const cap = inboxCapFor(plan, protections, workspace.pro_unlimited_inboxes_exempt);
      if (cap === null) continue;
      const parked = await parkAboveCap(db, workspace.id, cap, keepOrder ?? [], { label });
      if (parked.failed) result.failed = true;
      if (parked.newlyParked.length > 0) {
        result.parked += parked.newlyParked.length;
        await recordParking(workspace.id, 'inbox_parked', plan, db);
      }
    }
  } catch (err) {
    console.error('[plan-change] parkOwner failed, swallowed:', err instanceof Error ? err.message : String(err));
    result.failed = true;
  }
  return result;
}

/**
 * Unpark up to `plan`'s cap in every workspace the owner has. Cheap when
 * nothing is parked: one count first, and nothing else. Never throws.
 */
export async function unparkOwner(
  db: Db,
  ownerId: string,
  plan: PlanId | 'free',
  keepOrder: readonly string[] | null,
  label: string,
): Promise<OwnerParkingResult> {
  const result: OwnerParkingResult = { parked: 0, unparked: 0, failed: false };
  try {
    const workspaces = await ownerWorkspaces(db, ownerId);
    if (!workspaces) return { ...result, failed: true };
    if (workspaces.length === 0) return result;
    const { data: parkedRows, error } = await db
      .from('inboxes')
      .select('id, workspace_id')
      .in('workspace_id', workspaces.map((w) => w.id))
      .not('parked_at', 'is', null)
      .is('deleted_at', null)
      .limit(1);
    if (error) {
      // Before the parking migration nothing can be parked: not a failure.
      if (!isUnknownColumnError(error)) {
        console.error(`[plan-change] parked read failed for ${ownerId}: ${error.message}`);
        result.failed = true;
      }
      return result;
    }
    if (!parkedRows || parkedRows.length === 0) return result;
    const protections = await ownerProtections(db, ownerId);
    for (const workspace of workspaces) {
      const cap = inboxCapFor(plan, protections, workspace.pro_unlimited_inboxes_exempt);
      const back = await unparkUpToCap(db, workspace.id, cap, keepOrder ?? [], { label });
      if (back.failed) result.failed = true;
      if (back.unparked.length > 0) {
        result.unparked += back.unparked.length;
        await recordParking(workspace.id, 'inbox_unparked', plan, db);
      }
    }
  } catch (err) {
    console.error('[plan-change] unparkOwner failed, swallowed:', err instanceof Error ? err.message : String(err));
    result.failed = true;
  }
  return result;
}
