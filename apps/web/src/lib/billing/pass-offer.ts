/**
 * Where and to whom the 3-month Personal pass is OFFERED (plan sections 2 D2,
 * D3, D7, 7 and 8). The pass itself (entitlement, stacking, expiry) is
 * src/lib/billing/pass.ts; this file only decides whether a surface shows the
 * pass line, which arm of the holdout test a workspace is in, and what the
 * Billing screen says to someone who already holds a pass.
 *
 * SURFACES (phase 1, post-decline only):
 *   checkout_return  the dashboard after an abandoned Personal checkout
 *                    (cancel_url carries plan=personal)
 *   cap_banner       the Usage banner, once the workspace has been at the
 *                    action cap or the inbox cap for 72 hours (capBannerDue)
 *   paywall_email_3  step 3 of the paywall follow-up email
 *   pass_reminder    the last-7-days banner for someone who holds a pass; not
 *                    part of the experiment (they already bought)
 *
 * NEVER: the MCP server paywall text, the pricing page, /cancel, subscribers.
 * The pass always sits below the subscription options and is never
 * preselected; monthly stays the default.
 *
 * THE EXPERIMENT. Key `personal_pass_3m` (migration 20261025010100). Unit: the
 * workspace, as a subject id (its uuid without dashes is 32 lowercase hex, the
 * shape the experiments system requires). Variants `holdout` (control, today's
 * surfaces) and `pass`. Assigned at the first ELIGIBLE surface render through
 * the experiments system, whose assignment row is written once and is the
 * exposure log. PERSONAL_PASS_ENABLED decides:
 *   off      nobody sees it, and the experiment is never called (no assignment)
 *   holdout  the experiment runs; only the `pass` arm sees the line
 *   on       every eligible workspace sees it; nobody is assigned
 *
 * `pass_offer_shown` is written once per workspace per surface per UTC day,
 * only when the line was actually shown.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';
import { getExperimentVariant, type ExperimentStore } from '@/lib/experiments';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { recordProductFunnelEvent } from '@/lib/analytics/product-funnel';
import { fetchWorkspaceActionAllowance } from '@/lib/usage/allowance';
import { checkInboxLimit } from '@/lib/plans/check-inbox-limit';
import {
  canQueueAnotherPass,
  getActivePass,
  hasEntitledSubscription,
  isPausedSubscriber,
  passCheckoutOpen,
  passEndsAt,
  passSubscriptionStart,
  personalPassMode,
  type ActivePass,
  type BillingSnapshot,
  type PersonalPassMode,
} from '@/lib/billing/pass';

type Db = SupabaseClient<Database>;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const PASS_EXPERIMENT_KEY = 'personal_pass_3m';
export type PassArm = 'holdout' | 'pass';
/** Variant 0 of the experiment, and what an unknown or draft experiment serves. */
export const PASS_CONTROL: PassArm = 'holdout';

export const PASS_OFFER_SURFACES = ['checkout_return', 'cap_banner', 'paywall_email_3', 'pass_reminder'] as const;
export type PassOfferSurface = (typeof PASS_OFFER_SURFACES)[number];

/** The surfaces that are part of the holdout test (pass_reminder is for holders). */
const EXPERIMENT_SURFACES: ReadonlySet<PassOfferSurface> = new Set([
  'checkout_return',
  'cap_banner',
  'paywall_email_3',
]);

export function isPassOfferSurface(value: unknown): value is PassOfferSurface {
  return typeof value === 'string' && (PASS_OFFER_SURFACES as readonly string[]).includes(value);
}

/** A workspace uuid as an experiment subject id, or null when it is not a uuid. */
export function passExperimentSubject(workspaceId: string | null | undefined): string | null {
  if (typeof workspaceId !== 'string') return null;
  const hex = workspaceId.replace(/-/g, '').toLowerCase();
  return /^[a-f0-9]{32}$/.test(hex) ? hex : null;
}

// ---------------------------------------------------------------------------
// The 72-hour cap rule (cap_banner)
// ---------------------------------------------------------------------------

/** How long a workspace must have been at a cap before the banner offers the pass. */
export const CAP_DWELL_MS = 72 * HOUR_MS;
/** How far back an inbox-cap hit still counts: older blocks are not "at the cap now". */
export const INBOX_CAP_LOOKBACK_MS = 30 * DAY_MS;

export interface CapState {
  /** The earliest recorded hit of this cap that still applies, ISO, or null. */
  firstHitAt: string | null;
  /** True when the workspace is at this cap right now. */
  atCapNow: boolean;
}

/**
 * THE RULE. The cap banner offers the pass when, for EITHER cap:
 *
 *   1. the workspace is at that cap right now, and
 *   2. its earliest recorded hit of that cap that still applies is at least
 *      72 hours old.
 *
 * What "still applies" means is decided by the caller and differs per cap:
 *
 *   actions  the earliest `usage_limit_events` row (limit_kind 'actions') in
 *            the CURRENT allowance period. A new period resets the count, so
 *            a hit from last month does not make this month's banner due.
 *            At the cap now = used >= cap on the metered Free allowance.
 *   inboxes  the earliest inbox-cap paywall row (`paywall_reached` with
 *            connection_type 'first_connect') in the last 30 days. At the cap
 *            now = connected inboxes >= the plan's inbox cap.
 *
 * "Without buying" is the caller's eligibility test (Free, no entitled
 * subscription, no pass), which runs before this. A future hit (clock skew)
 * or an unparseable date never makes the banner due.
 */
export function capBannerDue(input: {
  now: Date;
  actions: CapState;
  inboxes: CapState;
}): { due: boolean; cap: 'actions' | 'inboxes' | null } {
  const dwelt = (state: CapState): boolean => {
    if (!state.atCapNow || !state.firstHitAt) return false;
    const hit = Date.parse(state.firstHitAt);
    if (!Number.isFinite(hit)) return false;
    return input.now.getTime() - hit >= CAP_DWELL_MS;
  };
  if (dwelt(input.actions)) return { due: true, cap: 'actions' };
  if (dwelt(input.inboxes)) return { due: true, cap: 'inboxes' };
  return { due: false, cap: null };
}

// ---------------------------------------------------------------------------
// Eligibility and the arm
// ---------------------------------------------------------------------------

/**
 * May this workspace be offered a pass at all (before any surface trigger)?
 * A Free workspace owned by the viewer, whose owner has no entitled
 * subscription, no paused one, no comped grant and no pass running. Pure.
 */
export function passOfferEligible(input: {
  isOwner: boolean;
  workspacePlan: string | null | undefined;
  billing: BillingSnapshot | null | undefined;
  compedGrant: boolean;
  active: ActivePass | null;
}): boolean {
  if (!input.isOwner) return false;
  if ((input.workspacePlan ?? 'free') !== 'free') return false;
  if (input.compedGrant) return false;
  if (hasEntitledSubscription(input.billing)) return false;
  if (isPausedSubscriber(input.billing)) return false;
  if (input.active) return false;
  return true;
}

/**
 * The arm for an eligible workspace, or null when the pass is switched off.
 * Only `holdout` mode touches the experiment, so `off` and `on` never write an
 * assignment. A missing or draft experiment row serves the control.
 */
export async function resolvePassArm(
  workspaceId: string,
  mode: PersonalPassMode = personalPassMode(),
  store?: ExperimentStore,
): Promise<PassArm | null> {
  if (mode === 'off') return null;
  if (mode === 'on') return 'pass';
  const subject = passExperimentSubject(workspaceId);
  if (!subject) return PASS_CONTROL;
  const variant = await getExperimentVariant(PASS_EXPERIMENT_KEY, subject, {
    fallback: PASS_CONTROL,
    ...(store ? { store } : {}),
  });
  return variant === 'pass' ? 'pass' : 'holdout';
}

// ---------------------------------------------------------------------------
// The Billing screen for a pass holder
// ---------------------------------------------------------------------------

/** What the Billing screen and the last-7-days banner render for a holder. */
export interface PassBillingState {
  /** End of the pass covering now, ISO. */
  currentEndsAt: string;
  /** End of the queued pass, ISO, or null. */
  queuedEndsAt: string | null;
  /** End of the whole cover, ISO. */
  coveredUntil: string;
  /** True inside the last 7 days of the whole cover. */
  inLastWeek: boolean;
  /** True when one more pass can be queued and new pass checkouts are open. */
  canAddPass: boolean;
  /** The end date another pass bought now would run to, ISO. */
  nextPassEndsAt: string;
  /**
   * When a subscription bought now would first charge, ISO, per interval: the
   * pass's end whether Stripe anchors the billing cycle there or has to fall
   * back to trial_end; null when it would charge today (the pass ends within
   * the hour). Our UI only ever calls it the first charge date, never a trial.
   */
  firstCharge: { month: string | null; year: string | null };
}

export function passBillingState(
  active: ActivePass,
  options: { now?: Date; checkoutOpen?: boolean } = {},
): PassBillingState {
  const now = options.now ?? new Date();
  const checkoutOpen = options.checkoutOpen ?? passCheckoutOpen();
  const firstChargeAt = (interval: 'month' | 'year'): string | null =>
    passSubscriptionStart(active.coveredUntil, interval, now) ? active.coveredUntil.toISOString() : null;
  return {
    currentEndsAt: new Date(active.current.ends_at).toISOString(),
    queuedEndsAt: active.queued ? new Date(active.queued.ends_at).toISOString() : null,
    coveredUntil: active.coveredUntil.toISOString(),
    inLastWeek: active.coveredUntil.getTime() - now.getTime() <= 7 * DAY_MS,
    canAddPass: checkoutOpen && canQueueAnotherPass(active),
    nextPassEndsAt: passEndsAt(active.coveredUntil).toISOString(),
    firstCharge: { month: firstChargeAt('month'), year: firstChargeAt('year') },
  };
}

/**
 * Does the holder's pass get its own Billing panel and last-week banner? Not
 * for a subscriber: an entitled subscription is what they have (the paid-plan
 * panel shows it), and the pass ending changes nothing for them. The same
 * rule evaluatePassOffer applies to `pass_reminder`, so the banner and the
 * server answer agree. Pure.
 */
export function passPanelApplies(billing: BillingSnapshot | null | undefined): boolean {
  return !hasEntitledSubscription(billing);
}

/**
 * The dashboard's read: the holder's Billing state, or null for anyone who
 * holds no pass, for a subscriber (passPanelApplies), and for a member of
 * someone else's workspace, whose owner's passes are not theirs to see. A
 * paused subscriber sees the pass, without the option to add another.
 * Tolerant: a read failure is "no pass".
 */
export async function loadPassBillingState(
  db: Db,
  userId: string,
  isOwner: boolean,
  now: Date = new Date(),
): Promise<PassBillingState | null> {
  if (!isOwner) return null;
  const active = await getActivePass(db, userId, { now });
  if (!active) return null;
  const { data: billing, error } = await db
    .from('user_billing')
    .select('plan, subscription_status, stripe_subscription_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.error('[pass-offer] billing read failed, treating as no pass:', { error: error.message });
    return null;
  }
  if (!passPanelApplies(billing)) return null;
  const state = passBillingState(active, { now });
  return isPausedSubscriber(billing) ? { ...state, canAddPass: false } : state;
}

// ---------------------------------------------------------------------------
// The server decision for one surface render
// ---------------------------------------------------------------------------

export interface PassOfferAnswer {
  show: boolean;
  /** The arm, for checkout metadata; null when nothing is shown. */
  arm: PassArm | 'holder' | null;
  /** The end date a pass bought now would run to, ISO; null when not shown. */
  endsAt: string | null;
}

const HIDDEN: PassOfferAnswer = { show: false, arm: null, endsAt: null };

/** The earliest action-cap hit in the current allowance period, or null. */
async function firstActionCapHit(db: Db, workspaceId: string, periodStart: string): Promise<string | null> {
  const { data, error } = await db
    .from('usage_limit_events')
    .select('occurred_at')
    .eq('workspace_id', workspaceId)
    .eq('limit_kind', 'actions')
    .gte('occurred_at', periodStart)
    .order('occurred_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[pass-offer] action cap read failed', { error: error.message });
    return null;
  }
  return data?.occurred_at ?? null;
}

/** The earliest inbox-cap paywall in the lookback window, or null. */
async function firstInboxCapHit(db: Db, workspaceId: string, now: Date): Promise<string | null> {
  const { data, error } = await db
    .from('product_funnel_events')
    .select('occurred_at')
    .eq('workspace_id', workspaceId)
    .eq('stage', 'paywall_reached')
    .eq('connection_type', 'first_connect')
    .gte('occurred_at', new Date(now.getTime() - INBOX_CAP_LOOKBACK_MS).toISOString())
    .order('occurred_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[pass-offer] inbox cap read failed', { error: error.message });
    return null;
  }
  return data?.occurred_at ?? null;
}

/** Reads both caps and applies capBannerDue. Any failure reads as "not due". */
export async function capBannerDueFor(db: Db, workspaceId: string, now: Date = new Date()): Promise<boolean> {
  try {
    const [allowance, inboxLimit, inboxHit] = await Promise.all([
      fetchWorkspaceActionAllowance(db, workspaceId),
      checkInboxLimit(db, workspaceId),
      firstInboxCapHit(db, workspaceId, now),
    ]);
    const cap = allowance?.monthly.cap ?? null;
    const actionsAtCap = cap != null && (allowance?.monthly.used ?? 0) >= cap;
    const actionHit =
      actionsAtCap && allowance ? await firstActionCapHit(db, workspaceId, allowance.monthly.period_start) : null;
    return capBannerDue({
      now,
      actions: { firstHitAt: actionHit, atCapNow: actionsAtCap },
      inboxes: { firstHitAt: inboxHit, atCapNow: inboxLimit.atLimit },
    }).due;
  } catch (err) {
    console.error('[pass-offer] cap banner check failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Write `pass_offer_shown` once per workspace, surface and UTC day. Same
 * dedupe as recordPricingViewed. Never throws.
 */
export async function recordPassOfferShownOnce(
  db: Db,
  workspaceId: string,
  surface: PassOfferSurface,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    const { data: existing } = await db
      .from('product_funnel_events')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('stage', 'pass_offer_shown')
      .eq('category', surface)
      .gte('occurred_at', dayStart.toISOString())
      .limit(1)
      .maybeSingle();
    if (existing) return false;
    await recordProductFunnelEvent(db, {
      workspaceId,
      stage: 'pass_offer_shown',
      outcome: 'success',
      category: surface,
    });
    return true;
  } catch (err) {
    console.error('[pass-offer] shown record failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Should this surface show the pass line for this viewer right now? Runs the
 * eligibility test, the surface trigger, the arm (assigning on the first
 * eligible render in holdout mode), and records `pass_offer_shown` once a day
 * when the answer is yes. Never throws: any failure hides the line.
 *
 * `checkout_return` trusts the surface: the client only asks after Stripe sent
 * the buyer back with plan=personal, and a forged ask would only show the
 * line to someone the test already counts as eligible.
 */
export async function evaluatePassOffer(input: {
  userId: string;
  workspaceId: string;
  surface: PassOfferSurface;
  now?: Date;
  db?: Db;
  store?: ExperimentStore;
}): Promise<PassOfferAnswer> {
  const now = input.now ?? new Date();
  const mode = personalPassMode();
  if (mode === 'off' || input.surface === 'paywall_email_3') return HIDDEN;
  try {
    const db = input.db ?? createServiceRoleClient();
    const { data: workspace } = await db
      .from('workspaces')
      .select('id, owner_id, plan, deleted_at')
      .eq('id', input.workspaceId)
      .maybeSingle();
    if (!workspace || workspace.deleted_at || workspace.owner_id !== input.userId) return HIDDEN;

    const [{ data: billing }, { data: entitlement }, active] = await Promise.all([
      db
        .from('user_billing')
        .select('plan, subscription_status, stripe_subscription_id')
        .eq('user_id', input.userId)
        .maybeSingle(),
      db.from('user_usage_entitlements').select('kind, expires_at').eq('user_id', input.userId).maybeSingle(),
      getActivePass(db, input.userId, { now }),
    ]);
    const compedGrant =
      entitlement?.kind === 'comped_scale' &&
      (entitlement.expires_at == null || new Date(entitlement.expires_at) > now);

    if (input.surface === 'pass_reminder') {
      // For holders in their last week; not part of the experiment.
      if (!active || !passPanelApplies(billing) || isPausedSubscriber(billing) || compedGrant) return HIDDEN;
      const state = passBillingState(active, { now });
      if (!state.inLastWeek) return HIDDEN;
      await recordPassOfferShownOnce(db, input.workspaceId, 'pass_reminder', now);
      return { show: true, arm: 'holder', endsAt: state.nextPassEndsAt };
    }

    if (!EXPERIMENT_SURFACES.has(input.surface)) return HIDDEN;
    const eligible = passOfferEligible({
      isOwner: true,
      workspacePlan: workspace.plan,
      billing,
      compedGrant,
      active,
    });
    if (!eligible) return HIDDEN;
    if (input.surface === 'cap_banner' && !(await capBannerDueFor(db, input.workspaceId, now))) return HIDDEN;

    const arm = await resolvePassArm(input.workspaceId, mode, input.store);
    if (arm !== 'pass') return HIDDEN;
    await recordPassOfferShownOnce(db, input.workspaceId, input.surface, now);
    return { show: true, arm, endsAt: passEndsAt(now).toISOString() };
  } catch (err) {
    console.error('[pass-offer] evaluate failed', {
      surface: input.surface,
      error: err instanceof Error ? err.message : String(err),
    });
    return HIDDEN;
  }
}

/**
 * The pass checkout link a surface renders. A plain anchor to the GET start
 * route (never a next/link, which would prefetch and create Stripe sessions).
 */
export function passCheckoutHref(options: {
  base?: string;
  locale?: string | null;
  arm?: string | null;
  surface: PassOfferSurface;
}): string {
  const params = new URLSearchParams({ product: 'personal_pass_3m' });
  if (options.locale) params.set('lang', options.locale);
  if (options.arm) params.set('arm', options.arm);
  params.set('from', options.surface);
  return `${options.base ?? ''}/api/stripe/checkout/start?${params.toString()}`;
}

/**
 * Step 3 of the paywall follow-up email (paywall_email_3). The run has already
 * decided the workspace is Free with no subscription (its own eligibility
 * test, at send time); this adds the pass's own conditions and the arm, which
 * is assigned here, at the first eligible render. Null hides the line.
 */
export async function paywallEmailPassLine(
  workspaceId: string,
  now: Date = new Date(),
  options: { db?: Db; store?: ExperimentStore; base?: string } = {},
): Promise<{ endsOn: string; url: string } | null> {
  const mode = personalPassMode();
  if (mode === 'off') return null;
  try {
    const db = options.db ?? createServiceRoleClient();
    const { data: workspace } = await db
      .from('workspaces')
      .select('owner_id, plan, deleted_at')
      .eq('id', workspaceId)
      .maybeSingle();
    if (!workspace || workspace.deleted_at || !workspace.owner_id) return null;
    const [{ data: billing }, { data: entitlement }, active] = await Promise.all([
      db
        .from('user_billing')
        .select('plan, subscription_status, stripe_subscription_id')
        .eq('user_id', workspace.owner_id)
        .maybeSingle(),
      db.from('user_usage_entitlements').select('kind, expires_at').eq('user_id', workspace.owner_id).maybeSingle(),
      getActivePass(db, workspace.owner_id, { now }),
    ]);
    const compedGrant =
      entitlement?.kind === 'comped_scale' &&
      (entitlement.expires_at == null || new Date(entitlement.expires_at) > now);
    if (!passOfferEligible({ isOwner: true, workspacePlan: workspace.plan, billing, compedGrant, active })) {
      return null;
    }
    const arm = await resolvePassArm(workspaceId, mode, options.store);
    if (arm !== 'pass') return null;
    const base = (options.base ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://mcpemails.com').replace(/\/+$/, '');
    const endsOn = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(passEndsAt(now));
    return { endsOn, url: passCheckoutHref({ base, arm, surface: 'paywall_email_3' }) };
  } catch (err) {
    console.error('[pass-offer] paywall email line failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
