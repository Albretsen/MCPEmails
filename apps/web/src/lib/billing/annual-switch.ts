/**
 * Whether the dashboard may show the "switch to annual" card (billing page)
 * and notice (Overview) to a monthly subscriber.
 *
 * WHO. The workspace OWNER whose live subscription is on the CURRENT monthly
 * price of Personal, Pro or Business (Business only while a yearly Business
 * price is configured), with at least two paid invoices on that subscription,
 * no payment issue (workspaces.payment_issue_since null, status active, not
 * past_due), no scheduled cancel (cancel_at / cancel_at_period_end), no pause
 * or booked downgrade, not comped and not on a 3-month pass. Everyone else
 * sees nothing: annual subscribers, retired prices (Personal $5, the Pro
 * $15 / $144 generation, the Business founder price), legacy Team.
 *
 * WHY THE CURRENT PRICE ONLY. The card quotes a saving computed from the
 * catalogue (annual-offer.ts). For a subscriber on a retired monthly price the
 * swap in checkout-core moves them to a different yearly price than the one
 * the catalogue compares (retainedPriceGenerationId, the founder pair), so the
 * printed percentage would not be theirs.
 *
 * BLACK WEEK. From 27 Nov 2026 00:00 to 1 Dec 2026 23:59:59 Oslo the seasonal
 * switch card (seasonal-switch.ts) owns this space and this card is hidden for
 * everyone, so nobody is quoted the normal annual price while the promotion
 * runs.
 *
 * WHY STRIPE. `user_billing` stores a plan and no interval: the price on the
 * Stripe subscription is the only place the interval is written down, and the
 * paid-invoice count is only in Stripe. So the server reads the subscription
 * and its last three paid invoices, in parallel, and only after every cheap
 * check below has passed (flag on, owner, plan, status, no payment issue).
 *
 * Never throws. Any failure, and a Stripe call slower than `timeoutMs`, means
 * no card: the page then renders exactly what it rendered before.
 *
 * NEVER IN CHAT. Only the dashboard page reads this. Nothing in the MCP server
 * or in a tool result mentions annual billing.
 */

import { PLANS, basePlanItem, canonicalPriceId, getPlanByStripePriceId } from '@/lib/stripe/plans';
import { isSeasonalWindowOpen } from '@/lib/stripe/seasonal-offer';

export type AnnualSwitchPlanId = 'personal' | 'solo' | 'pro';
export type AnnualSwitchMode = 'off' | 'on';

/** ANNUAL_SWITCH_CARD_ENABLED: only 'on' turns it on. Read at call time. */
export function annualSwitchMode(env: Record<string, string | undefined> = process.env): AnnualSwitchMode {
  return (env.ANNUAL_SWITCH_CARD_ENABLED ?? '').trim().toLowerCase() === 'on' ? 'on' : 'off';
}

export function isAnnualSwitchPlanId(value: unknown): value is AnnualSwitchPlanId {
  return value === 'personal' || value === 'solo' || value === 'pro';
}

/** The parts of a Stripe subscription this reads. */
export interface AnnualSwitchSubscriptionFacts {
  id: string;
  status: string;
  currency?: string | null;
  cancel_at?: number | null;
  cancel_at_period_end?: boolean | null;
  pause_collection?: { behavior?: string | null } | null;
  metadata?: Record<string, string> | null;
  items: { data: Array<{ price?: { id?: string | null; metadata?: Record<string, string> | null } | null }> };
}

/** The parts of a Stripe invoice this reads. */
export interface AnnualSwitchInvoiceFacts {
  status?: string | null;
  amount_paid?: number | null;
}

export interface AnnualSwitchInput {
  mode: AnnualSwitchMode;
  now: Date;
  /** The workspace's effective plan id. */
  plan: string | null | undefined;
  isOwner: boolean;
  compedScale: boolean;
  /** True when a 3-month pass covers the owner (passState non-null). */
  onPass: boolean;
  /** user_billing.subscription_status */
  subscriptionStatus: string | null | undefined;
  /** workspaces.payment_issue_since */
  paymentIssueSince: string | null | undefined;
  stripeCustomerId: string | null | undefined;
  stripeSubscriptionId: string | null | undefined;
}

/** What the dashboard receives. Null means no card and no notice. */
export interface AnnualSwitch {
  planId: AnnualSwitchPlanId;
  /** Lowercase ISO code the subscription is billed in. */
  currency: string;
}

/** Paid invoices a subscription needs before the card shows. */
export const MIN_PAID_INVOICES = 2;

/** The yearly half a swap would land on must exist, or there is nothing to sell. */
function sellable(planId: AnnualSwitchPlanId): boolean {
  return Boolean(PLANS[planId].stripePriceIdMonthly) && Boolean(PLANS[planId].stripePriceIdYearly);
}

/**
 * Cheap pre-check, no Stripe call: could this account take the card at all?
 * Lets the dashboard skip both Stripe reads for nearly everyone.
 */
export function mayOfferAnnualSwitch(input: AnnualSwitchInput): boolean {
  if (input.mode !== 'on') return false;
  if (input.isOwner !== true || input.compedScale === true || input.onPass === true) return false;
  if (!isAnnualSwitchPlanId(input.plan) || !sellable(input.plan)) return false;
  if (input.subscriptionStatus !== 'active') return false;
  if (input.paymentIssueSince) return false;
  if (isSeasonalWindowOpen(input.now)) return false;
  return (
    typeof input.stripeCustomerId === 'string' && input.stripeCustomerId.length > 0 &&
    typeof input.stripeSubscriptionId === 'string' && input.stripeSubscriptionId.length > 0
  );
}

/** A pause (running or booked) or a booked switch to a smaller plan. */
function hasBookedChange(sub: AnnualSwitchSubscriptionFacts, nowSeconds: number): boolean {
  if (sub.pause_collection?.behavior) return true;
  const effective = Number(sub.metadata?.mcpe_downgrade_effective_at ?? '');
  return Number.isFinite(effective) && effective > nowSeconds;
}

/** Invoices that actually took money. A zero invoice is not a payment. */
export function countPaidInvoices(invoices: readonly AnnualSwitchInvoiceFacts[]): number {
  return invoices.filter((i) => i.status === 'paid' && (i.amount_paid ?? 0) > 0).length;
}

/**
 * The switch to show, or null. Pure over the facts it is handed, so the rule
 * is testable without Stripe.
 */
export function annualSwitchFromFacts(
  input: AnnualSwitchInput,
  subscription: AnnualSwitchSubscriptionFacts | null,
  paidInvoices: number,
): AnnualSwitch | null {
  if (!mayOfferAnnualSwitch(input) || !subscription) return null;
  if (subscription.id !== input.stripeSubscriptionId) return null;
  if (subscription.status !== 'active') return null;
  if (subscription.cancel_at != null || subscription.cancel_at_period_end === true) return null;
  if (hasBookedChange(subscription, Math.floor(input.now.getTime() / 1000))) return null;
  if (paidInvoices < MIN_PAID_INVOICES) return null;

  const item = basePlanItem(subscription.items.data);
  const priceId = item?.price?.id ?? null;
  const resolved = getPlanByStripePriceId(item?.price ?? null);
  if (!priceId || !resolved || resolved.interval !== 'month') return null;
  const planId = resolved.plan.id;
  if (!isAnnualSwitchPlanId(planId) || planId !== input.plan) return null;
  // The CURRENT monthly price only (an inclusive-tax twin of it counts as it).
  if (canonicalPriceId(priceId) !== PLANS[planId].stripePriceIdMonthly) return null;

  return { planId, currency: (subscription.currency || 'usd').toLowerCase() };
}

export interface AnnualSwitchDeps {
  retrieveSubscription: (subscriptionId: string) => Promise<AnnualSwitchSubscriptionFacts>;
  /** Up to the last few paid invoices of the subscription. */
  listPaidInvoices: (subscriptionId: string) => Promise<AnnualSwitchInvoiceFacts[]>;
  timeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export async function resolveAnnualSwitch(
  input: AnnualSwitchInput,
  deps: AnnualSwitchDeps,
): Promise<AnnualSwitch | null> {
  if (!mayOfferAnnualSwitch(input)) return null;
  const subscriptionId = input.stripeSubscriptionId as string;
  try {
    const [subscription, invoices] = await withTimeout(
      Promise.all([deps.retrieveSubscription(subscriptionId), deps.listPaidInvoices(subscriptionId)]),
      deps.timeoutMs ?? 2000,
    );
    return annualSwitchFromFacts(input, subscription, countPaidInvoices(invoices));
  } catch (err) {
    console.error(
      '[annual-switch] could not read the subscription, no card:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** The real thing, wired to Stripe. Server only. */
export async function getAnnualSwitch(input: AnnualSwitchInput): Promise<AnnualSwitch | null> {
  return resolveAnnualSwitch(input, {
    retrieveSubscription: async (id) => {
      const { stripe } = await import('@/lib/stripe/client');
      return (await stripe.subscriptions.retrieve(id)) as unknown as AnnualSwitchSubscriptionFacts;
    },
    listPaidInvoices: async (id) => {
      const { stripe } = await import('@/lib/stripe/client');
      const list = await stripe.invoices.list({ subscription: id, status: 'paid', limit: MIN_PAID_INVOICES + 1 });
      return list.data as unknown as AnnualSwitchInvoiceFacts[];
    },
  });
}

// ---------------------------------------------------------------------------
// The Overview notice: dismissal per workspace
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a first dismissal hides the notice before it may come back once. */
export const NOTICE_RETURN_AFTER_DAYS = 60;

/**
 * Whether the Overview notice may show, given the workspace's dismissal
 * columns. Never dismissed: yes. Dismissed once: only from 60 days after that
 * dismissal. Dismissed twice: never again. The billing-page card ignores this.
 */
export function annualNoticeVisible(input: {
  dismissedAt: string | null | undefined;
  dismissCount: number | null | undefined;
  now: Date;
}): boolean {
  const count = typeof input.dismissCount === 'number' && Number.isFinite(input.dismissCount) ? input.dismissCount : 0;
  if (count <= 0) return true;
  if (count >= 2) return false;
  const at = input.dismissedAt ? Date.parse(input.dismissedAt) : Number.NaN;
  // Dismissed but no readable date: stay hidden rather than guess.
  if (!Number.isFinite(at)) return false;
  return input.now.getTime() - at >= NOTICE_RETURN_AFTER_DAYS * DAY_MS;
}
