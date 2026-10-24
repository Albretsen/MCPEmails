/**
 * The 3-month Personal pass: one payment, Personal for exactly three calendar
 * months, nothing renews. Plan: Documents/plans/three-month-pass-20261024.md
 * (owner's checkout, not in git). Schema: 20261024230000_personal_pass.sql.
 *
 * EXPORTED API (the dashboard, emails and checkout build on these):
 *
 *   personalPassMode()                     'off' | 'holdout' | 'on' from PERSONAL_PASS_ENABLED (default off)
 *   passCheckoutOpen(mode?)                true when new pass checkouts are accepted (holdout or on)
 *   passEndsAt(paidAt, months?)            paidAt + 3 calendar months, UTC, clamped to month end
 *   passSubscriptionStart(until, interval) how a subscription bought during a pass starts (anchor,
 *                                          trial_end fallback, or null for today); re-exported by checkout-core
 *   planPassWindow(live, paidAt)           where a new pass goes: active now, or stacked after the cover
 *   getActivePass(db, userId, opts?)       the pass covering now (+ queued one), or null; tolerant of
 *                                          the table not existing yet; `strict` throws on other errors
 *   canQueueAnotherPass(active)            false once a pass is already queued (one queued pass max)
 *   hasEntitledSubscription(billing)       a user_billing row that is entitled (active, trialing,
 *                                          past_due, unpaid, or a paid plan with no status)
 *   passEligibility({ billing, active })   may this user buy a pass right now, and if not, why
 *   effectivePlan({ billing, active })     the plan to project onto workspaces.plan
 *   reprojectUserPlan(db, userId, source)  writes effectivePlan onto every owned workspace
 *   recordPassPurchase(db, input)          the webhook's idempotent insert for a paid pass Checkout
 *   refundPass(db, input)                  the webhook's full-refund transition
 *   sweepPassExpiry(db, opts?)             expire ended passes, start stacked ones, re-project
 *   passNoticesFor(pass)                   the two service notices a pass is owed (7 days before, on the day)
 *   PassNoticeSink                         where those notices go; the email PR supplies one
 *
 * ENTITLEMENT IS TIME, NOT STATUS. A pass covers [starts_at, ends_at). The
 * status column is bookkeeping the sweep keeps up to date; every reader here
 * also checks the window, so a pass whose end passed five minutes before the
 * sweep ran covers nothing, and a stacked pass whose start has come covers
 * before the sweep has flipped it to `active`.
 *
 * MRR. A pass is a payment-mode Checkout and creates no Stripe subscription,
 * so revenue-math.ts (which reads subscriptions only) never counts it. Its
 * money lands in the cash tiles through cash-math.ts.
 *
 * TYPING. `user_passes` is not in src/types/database.types.ts until the
 * migration is applied to production and the types are regenerated from it
 * (`npm run gen:types` reads the linked project). Hand-editing that file is
 * forbidden, so table access goes through `passTable()` below, which adds a
 * local declaration of this one table (UserPassesTable) to the generated
 * schema. Every other table stays checked against the generated types.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';
import { PERSONAL_PASS_3M, type BillingInterval, type PlanId } from '@/lib/stripe/plans';
import { primaryWorkspaceId, recordPassEvent } from '@/lib/analytics/billing-funnel';
import { liftPlanLimitPauses, workspacesEnteringPaidPlan } from '@/lib/billing/plan-limit-pauses';

type Db = SupabaseClient<Database>;
/** Reads need only `from`, so the checkout core's narrowed client fits. */
type ReadDb = Pick<Db, 'from'>;

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

export type PersonalPassMode = 'off' | 'holdout' | 'on';

/**
 * PERSONAL_PASS_ENABLED, read at call time (a module-scope capture would keep
 * a warm lambda on the value it booted with; see lifecycle-mode.ts).
 *
 *   off      (default, and any unknown value) every surface hidden, new pass
 *            checkouts refused. Passes already sold keep running to their end
 *            date whatever this says.
 *   holdout  checkout open; surfaces shown only to the treatment arm.
 *   on       checkout open; surfaces shown to every eligible workspace.
 */
export function personalPassMode(): PersonalPassMode {
  const raw = process.env.PERSONAL_PASS_ENABLED?.trim().toLowerCase();
  return raw === 'on' || raw === 'holdout' ? raw : 'off';
}

/** True when a new pass Checkout may be created. */
export function passCheckoutOpen(mode: PersonalPassMode = personalPassMode()): boolean {
  return mode !== 'off';
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * The end of a pass paid at `paidAt`: the same wall-clock instant `months`
 * calendar months later, in UTC, with the day clamped to the last day of the
 * target month. 30 Nov + 3 months is 28 Feb (29 Feb in a leap year); 31 Jan is
 * 30 Apr. UTC throughout, so no DST shift can move the end by an hour.
 */
export function passEndsAt(paidAt: Date, months: number = PERSONAL_PASS_3M.months): Date {
  const year = paidAt.getUTCFullYear();
  const month = paidAt.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(paidAt.getUTCDate(), lastDay);
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      paidAt.getUTCHours(),
      paidAt.getUTCMinutes(),
      paidAt.getUTCSeconds(),
      paidAt.getUTCMilliseconds(),
    ),
  );
}

// ---------------------------------------------------------------------------
// A subscription bought during a pass
// ---------------------------------------------------------------------------

const HOUR_SECONDS = 60 * 60;

/**
 * How a Personal subscription bought during a pass starts, or null for "from
 * today".
 *
 * Preferred: `billing_cycle_anchor` at the pass's end with `proration_behavior:
 * 'none'`. The hosted page shows nothing due today and the first full charge on
 * that date, and the subscription is `active` from the start. Stripe only
 * accepts an anchor up to the first natural billing date, so it covers a yearly
 * subscription always and a monthly one only in the pass's last month.
 *
 * Otherwise `trial_end` at the pass's end, which Checkout accepts up to two
 * years out but only from 48 hours ahead. Stripe labels those days a trial on
 * its own page; the subscription is `trialing`, which every entitlement check
 * here already treats as entitled.
 */
export function passSubscriptionStart(
  coveredUntil: Date,
  interval: BillingInterval,
  now: Date = new Date(),
):
  | { billing_cycle_anchor: number; proration_behavior: 'none' }
  | { trial_end: number }
  | null {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const endSeconds = Math.floor(coveredUntil.getTime() / 1000);
  // Within the hour: not worth a different first invoice.
  if (endSeconds <= nowSeconds + HOUR_SECONDS) return null;

  const naturalBilling = Math.floor(
    passEndsAt(now, interval === 'year' ? 12 : 1).getTime() / 1000,
  );
  if (endSeconds < naturalBilling - HOUR_SECONDS) {
    return { billing_cycle_anchor: endSeconds, proration_behavior: 'none' };
  }
  if (endSeconds >= nowSeconds + 48 * HOUR_SECONDS) {
    return { trial_end: endSeconds };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type PassStatus = 'active' | 'scheduled' | 'expired' | 'refunded';

/** A `user_passes` row, as this module reads it. */
export interface PassRow {
  id: string;
  user_id: string;
  product: string;
  plan: string;
  stripe_checkout_session_id: string;
  stripe_payment_intent_id: string | null;
  amount_minor: number | null;
  currency: string | null;
  starts_at: string;
  ends_at: string;
  status: PassStatus;
  reminder_queued_at: string | null;
  expired_at: string | null;
  refunded_at: string | null;
  created_at?: string;
}

const PASS_COLUMNS =
  'id, user_id, product, plan, stripe_checkout_session_id, stripe_payment_intent_id, amount_minor, currency, starts_at, ends_at, status, reminder_queued_at, expired_at, refunded_at';

/** The pass covering now, and the stacked one behind it if any. */
export interface ActivePass {
  /** The pass whose window contains now. */
  current: PassRow;
  /** A pass that starts when `current` ends, if one was bought. */
  queued: PassRow | null;
  /** The end of the whole cover: the queued pass's end when there is one. */
  coveredUntil: Date;
}

/**
 * `public.user_passes` exactly as 20261024230000_personal_pass.sql declares it,
 * in the generator's shape. Merged into the generated public schema below, so
 * every other table keeps its generated types and this one is checked against
 * this declaration until the regenerated types carry it (the two then agree).
 */
interface UserPassesTable {
  Row: {
    id: string;
    user_id: string;
    product: string;
    plan: string;
    stripe_checkout_session_id: string;
    stripe_payment_intent_id: string | null;
    amount_minor: number | null;
    currency: string | null;
    starts_at: string;
    ends_at: string;
    status: PassStatus;
    reminder_queued_at: string | null;
    expired_at: string | null;
    refunded_at: string | null;
    created_at: string;
  };
  Insert: {
    id?: string;
    user_id: string;
    product?: string;
    plan?: string;
    stripe_checkout_session_id: string;
    stripe_payment_intent_id?: string | null;
    amount_minor?: number | null;
    currency?: string | null;
    starts_at: string;
    ends_at: string;
    status: PassStatus;
    reminder_queued_at?: string | null;
    expired_at?: string | null;
    refunded_at?: string | null;
    created_at?: string;
  };
  Update: Partial<UserPassesTable['Insert']>;
  Relationships: [];
}

type PassSchema = Database['public'] & {
  Tables: Database['public']['Tables'] & { user_passes: UserPassesTable };
};

/**
 * Table access for the one table the generated schema does not have yet. See
 * TYPING in the header. The client is the same object, typed with the
 * generated schema plus UserPassesTable.
 */
function passTable(db: ReadDb) {
  return (db as unknown as SupabaseClient<Database, 'public', 'public', PassSchema>).from('user_passes');
}

/** 42P01 is Postgres' undefined_table; PGRST205 is PostgREST not finding it. */
function isMissingRelation(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  return /user_passes/.test(error.message ?? '') && /does not exist|schema cache/.test(error.message ?? '');
}

let missingTableLogged = false;
function logMissingTableOnce(): void {
  if (missingTableLogged) return;
  missingTableLogged = true;
  console.error(
    '[pass] public.user_passes does not exist yet (migration 20261024230000 not applied); treating every user as holding no pass.',
  );
}

const LIVE: readonly PassStatus[] = ['active', 'scheduled'];

function covers(pass: PassRow, now: Date): boolean {
  return new Date(pass.starts_at) <= now && now < new Date(pass.ends_at);
}

/**
 * The live passes of a user (active or scheduled and not yet ended), earliest
 * start first. `null` when the table does not exist. Throws on any other read
 * error, so a caller can decide whether that is fatal.
 */
async function readLivePasses(db: ReadDb, userId: string, now: Date): Promise<PassRow[] | null> {
  const { data, error } = await passTable(db)
    .select(PASS_COLUMNS)
    .eq('user_id', userId)
    .in('status', LIVE as PassStatus[]);
  if (error) {
    if (isMissingRelation(error)) {
      logMissingTableOnce();
      return null;
    }
    throw new Error(`[pass] could not read passes for ${userId}: ${error.message}`);
  }
  return ((data ?? []) as unknown as PassRow[])
    .filter((pass) => new Date(pass.ends_at) > now)
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
}

/** Shape the live passes into an ActivePass, or null when none covers now. */
export function activeFromLive(live: readonly PassRow[], now: Date = new Date()): ActivePass | null {
  const current = live.find((pass) => covers(pass, now));
  if (!current) return null;
  const queued =
    live.find((pass) => pass.id !== current.id && new Date(pass.starts_at) >= new Date(current.ends_at)) ??
    null;
  const coveredUntil = new Date(
    Math.max(...live.map((pass) => new Date(pass.ends_at).getTime())),
  );
  return { current, queued, coveredUntil };
}

/**
 * The pass covering `userId` now, or null.
 *
 * Tolerant by default: a missing table (the code shipped before the migration
 * was applied) is "no pass", logged once, and any other read error is logged
 * and also returns null, which is right for a dashboard or a checkout that only
 * wants to know whether to anchor a subscription.
 *
 * `strict: true` is for the code that would TAKE something away on a null: the
 * webhook projecting Free, and the expiry sweep. There a read error other than
 * the missing table throws, so Stripe retries rather than a paid pass being
 * projected away on a transient failure.
 */
export async function getActivePass(
  db: ReadDb,
  userId: string,
  options: { strict?: boolean; now?: Date } = {},
): Promise<ActivePass | null> {
  const now = options.now ?? new Date();
  try {
    const live = await readLivePasses(db, userId, now);
    return live ? activeFromLive(live, now) : null;
  } catch (err) {
    if (options.strict) throw err;
    console.error('[pass] getActivePass failed, treating as no pass:', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** One queued pass at most (plan D6). */
export function canQueueAnotherPass(active: ActivePass | null): boolean {
  return !active?.queued;
}

/**
 * Where a pass paid at `paidAt` goes, given the user's live passes.
 *
 * Nothing covers `paidAt`: it starts now and is `active`. Otherwise it is
 * `scheduled` and starts at the end of the whole cover, so no paid day is lost.
 * The one-queued-pass rule is enforced at checkout; a payment that arrives past
 * it anyway (two tabs) still stacks after the last pass rather than vanishing.
 */
export function planPassWindow(
  live: readonly PassRow[],
  paidAt: Date,
): { status: 'active' | 'scheduled'; startsAt: Date; endsAt: Date } {
  const stillLive = live.filter((pass) => new Date(pass.ends_at) > paidAt);
  const coveredNow = stillLive.some((pass) => covers(pass, paidAt));
  if (!coveredNow) {
    return { status: 'active', startsAt: paidAt, endsAt: passEndsAt(paidAt) };
  }
  const startsAt = new Date(Math.max(...stillLive.map((pass) => new Date(pass.ends_at).getTime())));
  return { status: 'scheduled', startsAt, endsAt: passEndsAt(startsAt) };
}

// ---------------------------------------------------------------------------
// Subscriptions, eligibility, the effective plan
// ---------------------------------------------------------------------------

/** Stripe statuses that keep a subscriber entitled; same set as the webhook. */
export const ENTITLED_SUBSCRIPTION_STATUSES: readonly string[] = [
  'active',
  'trialing',
  'past_due',
  'unpaid',
];

/** The `user_billing` columns this module reads. */
export interface BillingSnapshot {
  plan: string | null;
  subscription_status: string | null;
}

/**
 * True when `user_billing` says the user is on an entitled subscription. A paid
 * plan with no status is a comped or manually seeded plan and counts too, the
 * same rule checkout-core.ts applies.
 */
export function hasEntitledSubscription(billing: BillingSnapshot | null | undefined): boolean {
  if (!billing || !billing.plan || billing.plan === 'free') return false;
  return (
    billing.subscription_status == null ||
    ENTITLED_SUBSCRIPTION_STATUSES.includes(billing.subscription_status)
  );
}

export type PassEligibility =
  | { eligible: true; stacked: boolean }
  | { eligible: false; reason: 'already_subscribed' | 'pass_already_queued' };

/** May this user buy a pass right now (plan D6 and D7)? */
export function passEligibility(input: {
  billing: BillingSnapshot | null | undefined;
  active: ActivePass | null;
}): PassEligibility {
  if (hasEntitledSubscription(input.billing)) return { eligible: false, reason: 'already_subscribed' };
  if (!canQueueAnotherPass(input.active)) return { eligible: false, reason: 'pass_already_queued' };
  return { eligible: true, stacked: input.active != null };
}

/**
 * The plan to project onto `workspaces.plan`.
 *
 * An entitled subscription wins (every paid tier is at least Personal). Then a
 * covering pass grants its plan. Otherwise Free. `user_billing.plan` stays the
 * subscription's own truth and is never written from a pass, so checkout's
 * "already subscribed" test is not fooled into the swap path for a pass holder.
 */
export function effectivePlan(input: {
  billing: BillingSnapshot | null | undefined;
  active: ActivePass | null;
}): PlanId {
  if (hasEntitledSubscription(input.billing)) return input.billing!.plan as PlanId;
  if (input.active) return PERSONAL_PASS_3M.plan;
  return 'free';
}

/**
 * Re-run the projection for one user from what is stored: their user_billing
 * row and their passes. Writes `workspaces.plan` on every owned, undeleted
 * workspace and lifts plan-limit pauses for the ones moving onto a paid plan.
 *
 * Throws on a failed read or write so the webhook can answer 500 and be
 * retried. Returns the plan it projected.
 */
export async function reprojectUserPlan(
  db: Db,
  userId: string,
  source: string,
  now: Date = new Date(),
): Promise<PlanId> {
  const { data: billing, error: billingError } = await db
    .from('user_billing')
    .select('plan, subscription_status')
    .eq('user_id', userId)
    .maybeSingle();
  if (billingError) {
    throw new Error(`[pass] ${source}: could not read user_billing for ${userId}: ${billingError.message}`);
  }
  const active = await getActivePass(db, userId, { strict: true, now });
  const plan = effectivePlan({ billing: billing as BillingSnapshot | null, active });

  const entering = await workspacesEnteringPaidPlan(db, userId, plan);
  const { error } = await db
    .from('workspaces')
    .update({ plan, updated_at: now.toISOString() })
    .eq('owner_id', userId)
    .is('deleted_at', null);
  if (error) {
    throw new Error(`[pass] ${source}: could not project "${plan}" for ${userId}: ${error.message}`);
  }
  console.log(`[pass] ${source}: user ${userId} projected to "${plan}"`);
  await liftPlanLimitPauses(db, entering, { label: source });
  return plan;
}

// ---------------------------------------------------------------------------
// Service notices (the extension point for the email PR)
// ---------------------------------------------------------------------------

export type PassNoticeTemplate = 'pass_ending_7d' | 'pass_ended';

/** One service notice a pass is owed, with the instant it becomes due. */
export interface PassNotice {
  template: PassNoticeTemplate;
  userId: string;
  passId: string;
  endsAt: string;
  sendAfter: string;
}

/**
 * Where notices go. This PR passes none, so nothing is queued; the email PR
 * passes one that writes `billing_email_sends` rows. Must not throw.
 */
export type PassNoticeSink = (notices: PassNotice[]) => Promise<void>;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The two notices a pass is owed: 7 days before its end, and on the day. A
 * stacked pass's notices are computed from its own window, and the sink should
 * skip an ending notice for a pass that another pass follows.
 */
export function passNoticesFor(pass: Pick<PassRow, 'id' | 'user_id' | 'ends_at'>): PassNotice[] {
  const ends = new Date(pass.ends_at);
  return [
    {
      template: 'pass_ending_7d',
      userId: pass.user_id,
      passId: pass.id,
      endsAt: ends.toISOString(),
      sendAfter: new Date(ends.getTime() - SEVEN_DAYS_MS).toISOString(),
    },
    {
      template: 'pass_ended',
      userId: pass.user_id,
      passId: pass.id,
      endsAt: ends.toISOString(),
      sendAfter: ends.toISOString(),
    },
  ];
}

async function deliverNotices(sink: PassNoticeSink | undefined, notices: PassNotice[]): Promise<void> {
  if (!sink || notices.length === 0) return;
  try {
    await sink(notices);
  } catch (err) {
    console.error('[pass] notice sink failed, swallowed:', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Webhook transitions
// ---------------------------------------------------------------------------

export type PassPurchaseResult =
  | { kind: 'recorded'; pass: PassRow; plan: PlanId }
  | { kind: 'duplicate' }
  | { kind: 'table_missing' };

/**
 * Record a paid pass Checkout. Idempotent on the Checkout session id: a replay
 * (the ledger already dedupes event ids; this also covers a second event for
 * the same session) records nothing and projects nothing. Then re-projects, so
 * every owned workspace is on Personal. Throws on a failed write.
 */
export async function recordPassPurchase(
  db: Db,
  input: {
    userId: string;
    sessionId: string;
    paymentIntentId: string | null;
    amountMinor: number | null;
    currency: string | null;
    paidAt?: Date;
    source: string;
    notices?: PassNoticeSink;
  },
): Promise<PassPurchaseResult> {
  const paidAt = input.paidAt ?? new Date();

  const { data: existing, error: existingError } = await passTable(db)
    .select('id')
    .eq('stripe_checkout_session_id', input.sessionId)
    .maybeSingle();
  if (existingError) {
    if (isMissingRelation(existingError)) {
      logMissingTableOnce();
      return { kind: 'table_missing' };
    }
    throw new Error(`[pass] ${input.source}: could not check session ${input.sessionId}: ${existingError.message}`);
  }
  if (existing) return { kind: 'duplicate' };

  const live = (await readLivePasses(db, input.userId, paidAt)) ?? [];
  const window = planPassWindow(live, paidAt);

  const { data: inserted, error } = await passTable(db)
    .insert({
      user_id: input.userId,
      product: PERSONAL_PASS_3M.id,
      plan: PERSONAL_PASS_3M.plan,
      stripe_checkout_session_id: input.sessionId,
      stripe_payment_intent_id: input.paymentIntentId,
      amount_minor: input.amountMinor,
      currency: input.currency,
      starts_at: window.startsAt.toISOString(),
      ends_at: window.endsAt.toISOString(),
      status: window.status,
    })
    .select(PASS_COLUMNS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === '23505') return { kind: 'duplicate' };
    throw new Error(`[pass] ${input.source}: could not record pass for ${input.userId}: ${error.message}`);
  }
  const pass = inserted as unknown as PassRow;

  const plan = await reprojectUserPlan(db, input.userId, input.source, paidAt);
  await recordPassEvent({
    workspaceId: await primaryWorkspaceId(db, input.userId),
    stage: 'pass_checkout_completed',
  });
  await deliverNotices(input.notices, passNoticesFor(pass));
  return { kind: 'recorded', pass, plan };
}

export type PassRefundResult =
  | { kind: 'refunded'; pass: PassRow; plan: PlanId }
  | { kind: 'already_refunded' }
  | { kind: 'partial' }
  | { kind: 'not_a_pass' }
  | { kind: 'table_missing' };

/**
 * A charge was refunded. Only a FULL refund ends a pass; a partial refund
 * changes nothing and is logged. The pass is found by its payment intent.
 *
 * Refunding the pass that covers now while a stacked pass waits starts the
 * stacked pass today, with its full three months, so a paid pass never sits
 * behind a gap. Then the projection re-runs: Free unless a subscription or
 * another pass is entitled.
 */
export async function refundPass(
  db: Db,
  input: {
    paymentIntentId: string | null;
    fullyRefunded: boolean;
    source: string;
    now?: Date;
  },
): Promise<PassRefundResult> {
  const now = input.now ?? new Date();
  if (!input.paymentIntentId) return { kind: 'not_a_pass' };

  const { data, error } = await passTable(db)
    .select(PASS_COLUMNS)
    .eq('stripe_payment_intent_id', input.paymentIntentId)
    .maybeSingle();
  if (error) {
    if (isMissingRelation(error)) {
      logMissingTableOnce();
      return { kind: 'table_missing' };
    }
    throw new Error(`[pass] ${input.source}: could not read pass for ${input.paymentIntentId}: ${error.message}`);
  }
  if (!data) return { kind: 'not_a_pass' };
  const pass = data as unknown as PassRow;

  if (!input.fullyRefunded) {
    console.log(`[pass] ${input.source}: partial refund on pass ${pass.id}; entitlement unchanged.`);
    return { kind: 'partial' };
  }
  if (pass.status === 'refunded') return { kind: 'already_refunded' };

  const wasCovering = (pass.status === 'active' || pass.status === 'scheduled') && covers(pass, now);

  const { error: updateError } = await passTable(db)
    .update({ status: 'refunded', refunded_at: now.toISOString() })
    .eq('id', pass.id);
  if (updateError) {
    throw new Error(`[pass] ${input.source}: could not mark pass ${pass.id} refunded: ${updateError.message}`);
  }

  if (wasCovering) {
    const live = (await readLivePasses(db, pass.user_id, now)) ?? [];
    const next = live.find((other) => other.id !== pass.id && other.status === 'scheduled');
    if (next) {
      const { error: startError } = await passTable(db)
        .update({
          status: 'active',
          starts_at: now.toISOString(),
          ends_at: passEndsAt(now).toISOString(),
        })
        .eq('id', next.id)
        .eq('status', 'scheduled');
      if (startError) {
        throw new Error(`[pass] ${input.source}: could not start stacked pass ${next.id}: ${startError.message}`);
      }
    }
  }

  const plan = await reprojectUserPlan(db, pass.user_id, input.source, now);
  await recordPassEvent({
    workspaceId: await primaryWorkspaceId(db, pass.user_id),
    stage: 'pass_refunded',
  });
  return { kind: 'refunded', pass: { ...pass, status: 'refunded', refunded_at: now.toISOString() }, plan };
}

// ---------------------------------------------------------------------------
// Expiry sweep
// ---------------------------------------------------------------------------

export interface PassSweepResult {
  expired: number;
  started: number;
  reprojected: number;
  failed: number;
  tableMissing: boolean;
}

/**
 * Expire every active pass whose end has passed, start every stacked pass
 * whose start has come, and re-project each affected user. Independent of
 * BILLING_LIFECYCLE_EMAILS: a pass ends on its date whatever the email flag
 * says. One user's failure is counted and does not stop the others.
 *
 * `pass_expired` is written once per expired row. `notices` receives a
 * `pass_ended` notice only when the cover really ended (no stacked pass took
 * over and no subscription is entitled); the email PR decides what to send.
 */
export async function sweepPassExpiry(
  db: Db,
  options: { now?: Date; notices?: PassNoticeSink } = {},
): Promise<PassSweepResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const result: PassSweepResult = { expired: 0, started: 0, reprojected: 0, failed: 0, tableMissing: false };

  const { data: ended, error: endedError } = await passTable(db)
    .select(PASS_COLUMNS)
    .eq('status', 'active')
    .lte('ends_at', nowIso);
  if (endedError) {
    if (isMissingRelation(endedError)) {
      logMissingTableOnce();
      return { ...result, tableMissing: true };
    }
    throw new Error(`[pass] sweep: could not read ended passes: ${endedError.message}`);
  }
  const { data: due, error: dueError } = await passTable(db)
    .select(PASS_COLUMNS)
    .eq('status', 'scheduled')
    .lte('starts_at', nowIso);
  if (dueError) throw new Error(`[pass] sweep: could not read stacked passes: ${dueError.message}`);

  // Grouped by user, and each user is RE-PROJECTED FIRST, then bookkept.
  // The projection reads the windows, not the statuses, so it is already
  // right before any status moves; and if it fails, the rows stay as they are
  // and the next tick finds them again. Flipping first would leave a user on
  // Personal with nothing left for a later sweep (or the cron's early-return
  // check) to find.
  const byUser = new Map<string, { ended: PassRow[]; due: PassRow[] }>();
  const bucket = (userId: string) => {
    let entry = byUser.get(userId);
    if (!entry) {
      entry = { ended: [], due: [] };
      byUser.set(userId, entry);
    }
    return entry;
  };
  for (const pass of (ended ?? []) as unknown as PassRow[]) bucket(pass.user_id).ended.push(pass);
  for (const pass of (due ?? []) as unknown as PassRow[]) {
    // A stacked pass already over (the sweep was down for its whole window)
    // never covered anything the sweep saw, so it simply expires.
    if (new Date(pass.ends_at) <= now) bucket(pass.user_id).ended.push(pass);
    else bucket(pass.user_id).due.push(pass);
  }

  for (const [userId, rows] of byUser) {
    try {
      const plan = await reprojectUserPlan(db, userId, 'pass-expiry', now);
      result.reprojected += 1;

      const expired: PassRow[] = [];
      for (const pass of rows.ended) {
        // The status predicate makes two overlapping sweeps harmless: only the
        // one that actually flips the row counts it and records it.
        const { data: flipped, error } = await passTable(db)
          .update({ status: 'expired', expired_at: nowIso })
          .eq('id', pass.id)
          .eq('status', pass.status)
          .select('id');
        if (error) throw new Error(`could not expire ${pass.id}: ${error.message}`);
        if ((flipped ?? []).length > 0) expired.push(pass);
      }
      for (const pass of rows.due) {
        const { data: flipped, error } = await passTable(db)
          .update({ status: 'active' })
          .eq('id', pass.id)
          .eq('status', 'scheduled')
          .select('id');
        if (error) throw new Error(`could not start ${pass.id}: ${error.message}`);
        if ((flipped ?? []).length > 0) result.started += 1;
      }
      result.expired += expired.length;
      if (expired.length === 0) continue;

      const workspaceId = await primaryWorkspaceId(db, userId);
      for (let i = 0; i < expired.length; i += 1) {
        await recordPassEvent({ workspaceId, stage: 'pass_expired' });
      }
      if (plan === 'free') {
        const last = expired.reduce((a, b) => (Date.parse(a.ends_at) >= Date.parse(b.ends_at) ? a : b));
        await deliverNotices(
          options.notices,
          passNoticesFor(last).filter((notice) => notice.template === 'pass_ended'),
        );
      }
    } catch (err) {
      console.error(`[pass] sweep: failed for ${userId}:`, {
        error: err instanceof Error ? err.message : String(err),
      });
      result.failed += 1;
    }
  }

  return result;
}
