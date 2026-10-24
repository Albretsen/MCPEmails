import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import type { FunnelEntryPoint } from '@/lib/analytics/product-funnel';

import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { stripe } from '@/lib/stripe/client';
import { getOrCreateStripeCustomer } from '@/lib/stripe/customer';
import { adaptivePricingParam } from '@/lib/stripe/adaptive-pricing';
import { checkoutSessionIdOrNull } from '@/lib/email/abandoned-checkout';
import { reminderLocale } from '@/lib/email/abandoned-checkout-templates';
import {
  PLANS,
  basePlanItem,
  extraMailboxQuantity,
  mailboxAddonPriceId,
  planCommitmentRank,
  getPlanByStripePriceId,
  retainedPriceGenerationId,
  type PlanId,
  type BillingInterval,
} from '@/lib/stripe/plans';
import {
  countOwnedInboxes,
  mailboxAddonItemChanges,
  readMailboxAddonState,
  type MailboxAddonItemChange,
} from '@/lib/stripe/mailbox-addon';
import { getActiveSeasonalOffers } from '@/lib/stripe/seasonal-offer-server';
import {
  BLACK_WEEK_2026,
  SEASONAL_OFFER_METADATA_KEY,
  isSeasonalPlanId,
  type SeasonalOffer,
} from '@/lib/stripe/seasonal-offer';
import {
  billingTarget,
  planCategory,
  recordCheckoutStarted,
  recordPlanChange,
  type PlanChangeDirection,
} from '@/lib/analytics/billing-funnel';

/**
 * The shared checkout core.
 *
 * ONE implementation, TWO entry points:
 *
 *   POST /api/stripe/checkout        - the in-dashboard fetch, answers JSON.
 *   GET  /api/stripe/checkout/start  - the buy CTA, answers a 303 to Stripe.
 *
 * The GET entry point exists because the old buy path was a link to
 * /dashboard/settings?upgrade=<plan>, which server-rendered the whole dashboard
 * (workspaces, inboxes, usage, keys), hydrated it, and only then let a client
 * effect POST here. Two to three seconds of dead time at the highest-intent
 * moment in the product. `runCheckout` is everything that happened after that
 * wait, lifted out so the CTA can reach Stripe on the first request.
 *
 * NOTHING may be forked between the two callers. This is live billing code with
 * real subscribers: two divergent checkout paths would eventually disagree
 * about who is allowed to be charged, and the comped guard below is the only
 * thing standing between a comped account and a bill for access it already has
 * for nothing.
 *
 * A third caller, the chat checkout link (GET /u/[token]), has no cookie
 * session and enters through `runCheckoutForIdentity` instead. It skips only
 * the cookie lookup; everything below that is the same function.
 *
 * The callers own only presentation: JSON body vs redirect target. Every
 * decision (validation, entitlement guards, price resolution, funnel recording,
 * the in-place price swap, session creation) lives here.
 */

/** The failure vocabulary `recordCheckoutStarted` accepts, without a new import. */
type CheckoutFailure = Parameters<typeof recordCheckoutStarted>[2];

/**
 * The target vocabulary it accepts, likewise. Wider than `BillingTargetCategory`
 * by exactly one member, `'unknown'`, which is what an attempt that never got a
 * valid plan and interval is recorded against.
 */
type CheckoutTarget = Parameters<typeof recordCheckoutStarted>[1];

/**
 * The purchasable plan ids: every plan in the catalogue except `free`.
 *
 * Derived from PLANS rather than listed literally so adding a tier cannot leave
 * checkout silently refusing to sell it. `enterprise` is not in the catalogue
 * and is therefore still rejected, as before.
 *
 * NAMING TRAP: these are internal ids, not display names. `solo` is sold as
 * "Pro" and `pro` is sold as "Business"; `personal` is the one id that matches its
 * own name. Use plan.name for anything a customer reads.
 */
export type PurchasablePlanId = Exclude<PlanId, 'free'>;

export const PURCHASABLE_PLAN_IDS: readonly PurchasablePlanId[] = (
  Object.keys(PLANS) as PlanId[]
).filter((id): id is PurchasablePlanId => id !== 'free');

export function isPurchasablePlanId(value: unknown): value is PurchasablePlanId {
  return (
    typeof value === 'string' &&
    (PURCHASABLE_PLAN_IDS as readonly string[]).includes(value)
  );
}

/**
 * Why a checkout attempt ended the way it did.
 *
 * This is the machine-readable half of the outcome and the reason the two entry
 * points can diverge in presentation without diverging in behaviour: the JSON
 * caller keeps returning the exact `message` and `errorCode` strings it always
 * has (no dashboard client changes), while the redirecting caller maps `reason`
 * onto a status parameter the dashboard can translate.
 *
 * Every value here is a terminal state of `runCheckout`.
 */
export type CheckoutReason =
  | 'unauthenticated'
  | 'invalid_plan'
  | 'invalid_interval'
  | 'workspace_not_found'
  | 'price_not_configured'
  | 'comped'
  // 'grandfathered_personal' was removed on 2026-09-07. It is no longer
  // reachable: holding `unlimited_inboxes` does not refuse any purchase (see
  // the note in runCheckout). The `billing.checkoutErrors.grandfathered_personal`
  // string is deliberately kept in messages/*/dashboard.json so a bookmarked or
  // in-flight ?checkout_error= URL still renders instead of throwing.
  | 'plan_not_self_service'
  // 'already_on_plan' was removed on 2026-09-14, for the same reason
  // 'grandfathered_personal' was: it refused money. It answered a 409 to any
  // request naming the plan the subscriber already holds, BEFORE looking at the
  // interval, so a Personal-monthly customer who clicked the annual price was
  // told they were already on Personal and nothing happened. Every
  // monthly-to-annual and annual-to-monthly switch in the product died there,
  // on top of a swap path that handles interval moves perfectly well.
  // `already_on_plan_interval` below is the genuine no-op (the subscription is
  // already on the exact price being asked for) and is now the only one. The
  // `billing.checkoutErrors.already_on_plan` string is deliberately kept in
  // messages/*/dashboard.json so a bookmarked or in-flight ?checkout_error=
  // URL still renders instead of throwing.
  | 'already_on_plan_interval'
  | 'stripe_customer_failed'
  | 'plan_change_failed'
  | 'stripe_session_failed'
  // Only reachable through `runCheckoutForIdentity` (the chat checkout link,
  // app/u/[token]/route.ts). That caller may open a hosted page and nothing
  // else, so an owner who already holds an entitled subscription is refused
  // here instead of being quoted the in-place swap. The two cookie entry points
  // never see it: they still reach the swap and its consent gate as before.
  | 'subscription_exists';

/**
 * What an in-place plan change will cost, quoted BEFORE anything is changed.
 *
 * Every amount is in the smallest unit of `currency`, exactly as Stripe reports
 * it, and is the answer to a different question the buyer is entitled to have
 * answered before they agree to anything:
 *
 *   amountDueNowCents  what leaves their card the moment they confirm
 *   creditCents        the unused remainder of the plan they are leaving
 *   recurringCents     what the new plan costs every period from the renewal on
 *   nextRenewalAt      when that first full period is billed
 *
 * Computed from Stripe's own invoice preview rather than from the catalogue, so
 * the number shown is the number charged: a mid-cycle upgrade is neither a full
 * period nor a difference of list prices, and only Stripe knows the proration.
 */
export interface PlanChangePreview {
  /** Lowercase ISO currency code, as Stripe reports it. */
  currency: string;
  /** Charged immediately on confirmation. Zero when credit covers the change. */
  amountDueNowCents: number;
  /** Credit for the unused remainder of the current plan, as a positive number. */
  creditCents: number;
  /**
   * What the new plan costs per period from the next renewal onwards: its own
   * price plus, for Business, the extra mailboxes at their per-mailbox price.
   */
  recurringCents: number;
  /**
   * Business only: mailboxes above the included ten that `recurringCents`
   * already prices. Zero for every other plan, so the dialog can say why the
   * figure is above the list price instead of leaving the buyer to wonder.
   */
  extraMailboxes: number;
  /** Unix seconds. Null when Stripe reports no period on the subscription. */
  nextRenewalAt: number | null;
  /**
   * The seasonal first-year discount already included in `amountDueNowCents`,
   * as Stripe priced it. Zero when no offer applies.
   */
  discountCents: number;
  /**
   * The seasonal offer this change is priced with (Black Week 2026), or null.
   * When set, `amountDueNowCents` already includes it and `recurringCents` is
   * the normal renewal price, because the coupon applies to the first year only.
   */
  seasonalOffer: SeasonalOffer | null;
}

export type CheckoutOutcome =
  /**
   * A hosted Stripe Checkout page is waiting at `url`. `sessionId` is only read
   * by the chat checkout link, which stores it so a second open of the same
   * link lands on the same session instead of creating another.
   */
  | { kind: 'checkout'; url: string; sessionId: string }
  /**
   * An existing subscriber asked for a different plan. NOTHING has been
   * changed and nothing has been charged: this is the quote, and the caller
   * must come back with `confirmChange: true` to act on it.
   *
   * `preview` is null when Stripe could not price the change. That is not a
   * refusal, it only means the confirmation has to be worded without an exact
   * figure; the change itself is still available.
   */
  | {
      kind: 'confirmation_required';
      planId: PurchasablePlanId;
      planName: string;
      interval: BillingInterval;
      preview: PlanChangePreview | null;
      /**
       * True when the caller confirmed a quote that carried a seasonal offer
       * and the offer is no longer available (window closed, coupon killed,
       * redeemed elsewhere). Nothing was charged; `preview` is the fresh quote
       * at the price that now applies.
       */
      offerEnded?: boolean;
    }
  /**
   * An existing subscriber's price was swapped in place and the proration was
   * invoiced and paid. There is no hosted page for this: the change is done.
   */
  | {
      kind: 'changed';
      planId: PurchasablePlanId;
      planName: string;
      interval: BillingInterval;
      /** What was actually collected. Null if Stripe returned no invoice. */
      amountPaidCents: number | null;
      currency: string | null;
    }
  /**
   * The swap was accepted by Stripe but the money was not: the card needs 3DS
   * authentication, or it failed. The subscription is UNCHANGED and held as a
   * Stripe pending update, which Stripe applies by itself once the invoice at
   * `invoiceUrl` is paid. The customer keeps the plan they already paid for
   * until then, which is the whole point of routing it this way.
   */
  | {
      kind: 'payment_required';
      planId: PurchasablePlanId;
      planName: string;
      interval: BillingInterval;
      invoiceUrl: string | null;
    }
  /** Nothing was created. `message`/`errorCode` are the legacy JSON payload. */
  | {
      kind: 'error';
      reason: CheckoutReason;
      status: number;
      message: string;
      errorCode?: 'subscription_not_self_service';
    };

/**
 * Quote an in-place plan change without making one.
 *
 * `invoices.createPreview` is a pure read: it prices the change against the
 * live subscription and creates nothing. A failure here must never block the
 * change, so every error resolves to null and the caller words the
 * confirmation without a figure.
 */
async function previewPlanChange(args: {
  subscription: Stripe.Subscription;
  itemId: string;
  priceId: string;
  /** The add-on half of the change, exactly as the swap below will send it. */
  addonChanges: MailboxAddonItemChange[];
  extraMailboxes: number;
  addonPriceId: string | null;
  /** The seasonal offer the confirmed swap will apply, so the quote matches. */
  offer: SeasonalOffer | null;
}): Promise<PlanChangePreview | null> {
  const { subscription, itemId, priceId, addonChanges, extraMailboxes, addonPriceId, offer } = args;

  try {
    const customerId =
      typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer.id;

    const [preview, price, addonPrice] = await Promise.all([
      stripe.invoices.createPreview({
        customer: customerId,
        subscription: subscription.id,
        subscription_details: {
          // The same items the swap below sends, add-on included, or the
          // quote prices a different event from the one the button performs.
          items: [{ id: itemId, price: priceId }, ...addonChanges],
          proration_behavior: 'always_invoice',
        },
        // The same discounts the confirmed swap sends. Top-level `discounts`
        // replaces what the preview would inherit from the subscription, so
        // the subscription's existing ones are passed through with it.
        ...(offer ? { discounts: offerDiscounts(subscription, offer) } : {}),
      }),
      stripe.prices.retrieve(priceId),
      extraMailboxes > 0 && addonPriceId
        ? stripe.prices.retrieve(addonPriceId)
        : Promise.resolve(null),
    ]);

    // Proration credit arrives as negative invoice lines (the unused remainder
    // of the old price). Summing them is what lets the dialog show the discount
    // rather than only the net, which is the difference between "you are being
    // charged $62.41" and "you are being charged $62.41, $16.59 already
    // credited back".
    const creditCents = preview.lines.data
      .filter((line) => line.amount < 0)
      .reduce((sum, line) => sum + Math.abs(line.amount), 0);

    return {
      currency: preview.currency,
      amountDueNowCents: preview.amount_due,
      creditCents,
      recurringCents:
        (price.unit_amount ?? 0) + (addonPrice?.unit_amount ?? 0) * extraMailboxes,
      extraMailboxes,
      nextRenewalAt: basePlanItem(subscription.items.data)?.current_period_end ?? null,
      discountCents: (preview.total_discount_amounts ?? []).reduce(
        (sum, d) => sum + (d.amount ?? 0),
        0,
      ),
      seasonalOffer: offer,
    };
  } catch (err) {
    console.error(
      '[checkout] plan change preview failed:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * The languages the hosted Checkout page is shown in. Deliberately two.
 *
 * German is the one exception to the English pin (see the session params
 * below), for a legal reason rather than a cosmetic one: in subscription mode
 * the button label follows `locale` and nothing else, and only under 'de' does
 * Stripe render "Zahlungspflichtig abonnieren", the wording §312j BGB asks for
 * on the button that commits a consumer to pay. Every other buyer keeps the
 * English page, because the Product names on the line items are English and a
 * page half in Norwegian and half in English reads worse than one in English.
 */
export type CheckoutLocale = 'en' | 'de';

/**
 * The buyer's language as it arrives from a request (a JSON body field or a
 * `lang` query parameter), allow-listed down to a CheckoutLocale.
 *
 * Exact match only: 'de' is German, and anything else, including 'DE',
 * 'de-AT', an array or a missing value, is English. The value is never passed
 * to Stripe as given, so a caller cannot reach a Stripe locale this file has
 * not written copy for.
 */
export function checkoutLocale(value: unknown): CheckoutLocale {
  return value === 'de' ? 'de' : 'en';
}

/**
 * The two messages the hosted page leaves room for, one deck per locale.
 *
 * Plain sentences in the same register as the pricing page: no exclamation
 * marks, no urgency, no upsell. The German deck uses formal Sie and links the
 * German cancellation and withdrawal pages, which serve the same content as
 * the English ones under /de.
 */
function checkoutCustomText(
  locale: CheckoutLocale,
  appUrl: string,
): Stripe.Checkout.SessionCreateParams.CustomText {
  if (locale === 'de') {
    return {
      submit: {
        message:
          'Mit dem Abonnieren verpflichten Sie sich, den angezeigten Preis in jedem Abrechnungszeitraum zu zahlen, bis Sie kündigen. ' +
          `Sie können jederzeit in Ihrem Dashboard oder unter [mcpemails.com/de/cancel](${appUrl}/de/cancel) kündigen. ` +
          `Verbraucher können innerhalb von 14 Tagen widerrufen: [Widerrufsrecht](${appUrl}/de/withdrawal). ` +
          'Fragen vor dem Kauf: hello@mcpemails.com',
      },
      after_submit: {
        message:
          'Sie werden zu mcpemails.com zurückgeleitet, um Ihre Postfächer zu verbinden.',
      },
    };
  }
  return {
    submit: {
      message:
        'By subscribing you agree to pay the price shown, every billing period until you cancel. ' +
        `Cancel any time from your dashboard or at [mcpemails.com/cancel](${appUrl}/cancel). ` +
        `Consumers can withdraw within 14 days: [right of withdrawal](${appUrl}/withdrawal). ` +
        'Questions before you buy: hello@mcpemails.com',
    },
    after_submit: {
      message:
        'Taking you back to mcpemails.com to connect your inboxes.',
    },
  };
}

// ---------------------------------------------------------------------------
// Seasonal offer (Black Week 2026) helpers
// ---------------------------------------------------------------------------

/**
 * The `discounts` list for a swap that adds the seasonal coupon: whatever the
 * subscription already carries, then the coupon. Passing `discounts` replaces
 * the list, so dropping the existing entries would silently remove a discount
 * the customer already has.
 */
export function offerDiscounts(
  subscription: Pick<Stripe.Subscription, 'discounts'>,
  offer: SeasonalOffer,
): Array<{ discount: string } | { coupon: string }> {
  const existing = (subscription.discounts ?? [])
    .map((d) => (typeof d === 'string' ? d : d?.id))
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .map((id) => ({ discount: id }));
  return [...existing, { coupon: offer.couponId }];
}

/**
 * Has this Stripe customer ever had a subscription tagged with the offer?
 * One redemption per person. FAILS CLOSED: if Stripe cannot answer, the offer
 * is not applied, and the buyer sees the normal price on Stripe's own page
 * (never a charge different from what that page states).
 */
export async function hasRedeemedSeasonalOffer(customerId: string): Promise<boolean> {
  try {
    const list = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
    return list.data.some(
      (sub) => sub.metadata?.[SEASONAL_OFFER_METADATA_KEY] === BLACK_WEEK_2026.id,
    );
  } catch (err) {
    console.error(
      '[checkout] seasonal offer redemption check failed, offer not applied:',
      err instanceof Error ? err.message : String(err),
    );
    return true;
  }
}

/** The live offer for this plan and interval, or null. Never throws. */
async function liveOfferFor(planId: string, interval: string): Promise<SeasonalOffer | null> {
  if (interval !== 'year' || !isSeasonalPlanId(planId)) return null;
  try {
    const offers = await getActiveSeasonalOffers();
    return offers[planId] ?? null;
  } catch {
    return null;
  }
}

function fail(
  reason: CheckoutReason,
  status: number,
  message: string,
  errorCode?: 'subscription_not_self_service',
): CheckoutOutcome {
  return { kind: 'error', reason, status, message, errorCode };
}

/**
 * Run a checkout attempt for the currently authenticated user.
 *
 * `planId` and `interval` arrive unvalidated (a JSON body from one caller, a
 * query string from the other) and are validated here, so neither entry point
 * can widen what is purchasable.
 *
 * `confirmChange` is the consent gate on the one branch that can move money
 * without a hosted Stripe page. It defaults to false, so a caller that has not
 * been updated cannot change anyone's billing by accident: the worst it can do
 * is ask for a quote. Only pass true in response to a person confirming the
 * amount they were shown.
 *
 * `locale` is the buyer's language (the app-realm choice from the dashboard,
 * or the page's language on a marketing CTA). It only chooses the language of
 * the hosted page, never what is sold or charged, and is allow-listed by
 * `checkoutLocale` before Stripe sees it.
 *
 * `recoveredFrom` is the expired Checkout session an abandoned-checkout
 * reminder linked from (see src/lib/email/abandoned-checkout.ts). It only lands
 * in the new session's metadata, after a format check, so the completed
 * purchase can be credited to the reminder.
 *
 * `quotedOffer` is the seasonal offer id the confirmed quote carried (the
 * dashboard echoes `preview.seasonalOffer.offerId`). On the confirmed pass of a
 * plan change, an offer that was quoted but is no longer available stops the
 * swap and returns a fresh quote, so nobody is charged a price they did not see.
 */
export async function runCheckout(input: {
  planId: unknown;
  interval: unknown;
  confirmChange?: unknown;
  locale?: unknown;
  recoveredFrom?: unknown;
  quotedOffer?: unknown;
}): Promise<CheckoutOutcome> {
  // ── 1. Authenticate ────────────────────────────────────────────────────────
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    // NOT RECORDABLE, and that is a schema fact rather than an oversight.
    // `product_funnel_events.workspace_id` is NOT NULL: every row hangs off a
    // workspace, and with no user there is nobody to resolve one from. A
    // synthetic id would be worse than no row at all, because it would put
    // invented attempts in the one column every funnel number is grouped by.
    //
    // So this log IS the trace. It is the only evidence that somebody clicked
    // buy with a missing or lapsed session, which is exactly the case the
    // funnel cannot see: the GET entry point bounces them to /login and they
    // leave nothing behind anywhere else. Nothing identifying is logged (there
    // is no session to identify), which is also how the rest of this codebase
    // logs a failure: the reason, never the person.
    console.warn(
      '[checkout] unauthenticated attempt, not recordable in the funnel:',
      authError ? authError.message : 'no session',
    );
    return fail('unauthenticated', 401, 'Unauthorized');
  }

  // ── 2. Resolve the user's primary workspace ────────────────────────────────
  // Resolved BEFORE validation and before the Stripe price lookup, deliberately.
  // Every funnel row needs a workspace id (`product_funnel_events.workspace_id`
  // is NOT NULL), so a checkout attempt that dies on a bad plan id or an
  // unconfigured price has nothing to attach its trace to until this has run.
  //
  // Hoisting it above validation cannot change what any caller sees, which is
  // the only reason it is allowed to move in live billing code:
  //
  //   - it is a pure read of the caller's OWN oldest active workspace and
  //     writes nothing;
  //   - its result is not ACTED on until after the two validation checks below,
  //     so a bad plan id is still a 400 and never a 404, exactly as before;
  //   - it cannot throw past this function. The Supabase client returns a fetch
  //     failure as an `error` value instead of rejecting unless `throwOnError()`
  //     is set, and it is not set here.
  //
  // The cost is one extra read on a request that was going to be refused
  // anyway. That is the price of being able to see the refusal at all.
  //
  // The subscription itself is tied to the USER, not this workspace; the
  // display name only gives the Stripe customer a friendly label.
  const { data: workspace, error: wsError } = await supabase
    .from('workspaces')
    .select('id, display_name')
    .eq('owner_id', user.id)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .single();

  return checkoutFor(
    { supabase, user: { id: user.id, email: user.email }, workspace, wsError },
    input,
    { allowPlanChange: true },
  );
}

/**
 * Who a checkout is for, when the caller has no cookie session to read it from.
 *
 * Built by the chat checkout link (app/u/[token]/route.ts) from its
 * `checkout_links` row with the service-role client: the owner's id and email
 * from auth, and the workspace the refusal happened in. The subscription is
 * still tied to the USER, exactly as on the cookie path; the workspace only
 * labels the Stripe customer and carries the funnel rows.
 */
export interface CheckoutIdentity {
  userId: string;
  email: string;
  workspaceId: string;
  displayName: string;
}

/**
 * Presentation the identity caller may change. Nothing here can widen what is
 * sold or to whom: the plan, interval and every guard are decided in
 * `checkoutFor`, the same as for the two cookie entry points.
 */
export interface CheckoutOptions {
  /** Defaults to the dashboard's ?checkout=success page. */
  successUrl?: string;
  /** Defaults to the dashboard's ?checkout=cancelled page. */
  cancelUrl?: string;
  /** Stored on the `checkout_started` row, so the funnel can tell the link apart. */
  entryPoint?: FunnelEntryPoint;
  /** Extra session metadata. Can never replace user_id, plan_id or interval. */
  extraMetadata?: Record<string, string>;
  /** Stripe `expires_at`, unix seconds. Stripe's minimum is 30 minutes ahead. */
  sessionExpiresAt?: number;
}

/**
 * The service-role entry point: a checkout for an identity resolved without a
 * cookie session (the chat checkout link).
 *
 * It runs the same `checkoutFor` as `runCheckout`, so the purchasable
 * allowlist, the comped guard, price resolution and the `checkout_started` row
 * are not repeated anywhere. What it can NOT do is reach the in-place price
 * swap: `allowPlanChange: false` turns an entitled subscriber into a
 * `subscription_exists` refusal before the subscription is even read, and
 * `confirmChange` is pinned to false on top of that. A bearer link in a chat
 * transcript must never be able to touch a card on file.
 */
export async function runCheckoutForIdentity(
  identity: CheckoutIdentity,
  input: { planId: unknown; interval: unknown; locale?: unknown },
  options: CheckoutOptions = {},
): Promise<CheckoutOutcome> {
  return checkoutFor(
    {
      supabase: createServiceRoleClient(),
      user: { id: identity.userId, email: identity.email },
      workspace: { id: identity.workspaceId, display_name: identity.displayName },
      wsError: null,
    },
    { planId: input.planId, interval: input.interval, locale: input.locale, confirmChange: false },
    { ...options, allowPlanChange: false },
  );
}

/**
 * Everything after "who is buying" is known. Shared verbatim by `runCheckout`
 * (cookie session) and `runCheckoutForIdentity` (service role).
 *
 * `supabase` is whichever client resolved the identity. The reads below are
 * all keyed on `user.id`, so the cookie client (RLS: the caller's own rows)
 * and the service-role client (the link's owner, resolved server side from
 * the token) read the same rows for the same user.
 */
async function checkoutFor(
  ctx: {
    supabase: Pick<SupabaseClient<Database>, 'from'>;
    user: { id: string; email?: string | null };
    workspace: { id: string; display_name: string } | null;
    wsError: { code?: string; message: string } | null;
  },
  input: {
    planId: unknown;
    interval: unknown;
    confirmChange?: unknown;
    locale?: unknown;
    recoveredFrom?: unknown;
  },
  options: CheckoutOptions & { allowPlanChange: boolean },
): Promise<CheckoutOutcome> {
  const { supabase, user, workspace, wsError } = ctx;

  // The one and only `checkout_started` writer for this request.
  //
  // What this GUARANTEES: every exit below it that the funnel is able to
  // represent writes exactly one row. The `recorded` latch makes a second call
  // a no-op, so a successful checkout can only ever produce one row no matter
  // how the branches below evolve. The latch is per call of `runCheckout`, so
  // the two entry points cannot double-record either: each HTTP request runs
  // this function exactly once.
  //
  // What it knowingly does NOT cover, because the table cannot hold it: the two
  // exits that have no workspace to hang a row off. `unauthenticated` above (no
  // user at all) and `workspace_not_found` below (a user who owns none) are
  // logged instead, each with a comment saying why.
  //
  // And what it deliberately no longer covers, as of 2026-09-14: the in-place
  // plan change. That path creates no Stripe Checkout session, so it has no
  // `checkout_started` to record; it writes its own row in the `plan_upgraded`
  // / `plan_downgraded` stages instead, at whichever of its three exits it
  // reaches. The once-per-request property is unchanged, since those exits are
  // mutually exclusive and each writes once. The two exits that report "you
  // already have exactly this" write nothing at all, and say why inline.
  //
  // Everything else, the validation refusals included, is a row.
  //
  // The attempt is not written eagerly with a provisional outcome: the view
  // over this table reads `outcome = 'success'` as "a checkout was started" and
  // `outcome = 'failure'` as "it never got off the ground", so each request
  // writes its row once, at the first point its outcome is known.
  let recorded = false;
  const recordOnce = async (
    target: CheckoutTarget,
    failure?: CheckoutFailure,
  ): Promise<void> => {
    if (recorded) return;
    recorded = true;
    // recordCheckoutStarted swallows its own errors (analytics must never be
    // able to fail a payment) and no-ops on a null workspace id. That null case
    // is what makes it safe to call from the validation refusals below, which
    // deliberately run before `wsError` has been acted on.
    await recordCheckoutStarted(workspace?.id ?? null, target, failure, options.entryPoint);
  };

  // ── 3. Validate the requested plan and interval ────────────────────────────
  const { planId, interval } = input;
  // Strictly `=== true`: a truthy string from a query parameter must not be
  // able to stand in for a person clicking Confirm.
  const confirmChange = input.confirmChange === true;

  // ORDER IS LOAD-BEARING. Both checks run before the `workspace_not_found`
  // return below, so the refusal a caller sees is unchanged from when
  // validation came first in this function: a bad plan id from a user who owns
  // no workspace is still `invalid_plan` / 400, not a 404.
  if (!isPurchasablePlanId(planId)) {
    // Recorded as `unknown` / `validation_failed`. `billingTarget` cannot build
    // a category out of a plan id that is not a plan, and the caller's own
    // string has no business in a bounded category column, so the row says the
    // part that is actually known: an attempt was made and died on its input.
    // Both values are in the CHECK constraints, whose current definitions are
    // 20260827100000_add_personal_plan.sql (category, which lists 'unknown')
    // and 20260829220000_funnel_consent_required_category.sql (error_category,
    // which lists 'validation_failed').
    await recordOnce('unknown', 'validation_failed');
    return fail(
      'invalid_plan',
      400,
      `planId must be one of: ${PURCHASABLE_PLAN_IDS.map((id) => `"${id}"`).join(', ')}.`,
    );
  }

  if (interval !== 'month' && interval !== 'year') {
    // `unknown` again rather than `${planId}_month`: the plan is valid here but
    // the interval is not, and inventing the missing half to make the category
    // complete would file the attempt under a price nobody asked for.
    await recordOnce('unknown', 'validation_failed');
    return fail('invalid_interval', 400, 'interval must be "month" or "year".');
  }

  if (wsError || !workspace) {
    // NOT RECORDABLE either, for the same NOT NULL reason: this user is
    // authenticated but owns no workspace, so there is no row for the attempt
    // to hang off, and there is no id to invent that would not corrupt someone
    // else's numbers. The log is the trace instead. It carries the shape of the
    // failure (a missing row surfaces as PGRST116; any other code means the
    // database itself is in trouble, which is a different incident) and what
    // was being bought, and deliberately carries no user identifier, matching
    // how failures are logged everywhere else here.
    console.error('[checkout] workspace not found, not recordable in the funnel:', {
      plan: planId,
      interval,
      code: wsError?.code ?? 'none',
      error: wsError?.message ?? 'no active owned workspace',
    });
    return fail('workspace_not_found', 404, 'Workspace not found.');
  }

  // Past this point the attempt has a plan, an interval and a workspace, so
  // every remaining exit records against the real target rather than 'unknown'.
  // `recordAttempt` is the same single latch, with the target already bound.
  const target = billingTarget(planId, interval);
  const recordAttempt = (failure?: CheckoutFailure): Promise<void> =>
    recordOnce(target, failure);

  // ── 4. Resolve the target Stripe price ID ─────────────────────────────────
  const plan = PLANS[planId];
  const priceId =
    interval === 'year' ? plan.stripePriceIdYearly : plan.stripePriceIdMonthly;

  if (!priceId) {
    // An unset STRIPE_PRICE_* env var makes a plan silently unbuyable, which is
    // indistinguishable from disinterest unless it is recorded here.
    await recordAttempt('price_not_configured');
    return fail(
      'price_not_configured',
      503,
      `Stripe price ID for ${planId}/${interval} is not configured. ` +
        'Please try again later or contact support.',
    );
  }

  // ── 4b. Guard against a duplicate / no-op subscription ─────────────────────
  // The subscription is per-user. If the user already has an entitled plan,
  // route plan/interval changes through an in-place price swap instead of
  // creating a second Stripe subscription (which would double-charge them).
  const { data: billing } = await supabase
    .from('user_billing')
    .select('plan, subscription_status, stripe_subscription_id')
    .eq('user_id', user.id)
    .maybeSingle();

  // A comped grant lives in user_usage_entitlements, NOT in user_billing, so a
  // comped user can sit at plan 'free' here while already having full paid
  // access. Without this check they fall through to a real Checkout session
  // and pay for what they were given for nothing.
  const { data: entitlement } = await supabase
    .from('user_usage_entitlements')
    .select('kind, expires_at')
    .eq('user_id', user.id)
    .maybeSingle();

  const hasCompedGrant =
    entitlement?.kind === 'comped_scale' &&
    (entitlement.expires_at == null ||
      new Date(entitlement.expires_at) > new Date());

  if (hasCompedGrant) {
    await recordAttempt('subscription_exists');
    return fail(
      'comped',
      409,
      'Your account already has full access at no charge. ' +
        'Contact us if you need to change it.',
      'subscription_not_self_service',
    );
  }

  // GRANDFATHERING (2026-08-19 repricing). There is deliberately NO check here
  // against `entitlement.unlimited_inboxes`. Until 2026-09-07 this spot held a
  // 409 `grandfathered_personal` that refused {planId:'personal'} from anyone
  // holding the grant, on the theory that Personal's three inboxes would be a
  // paid DOWNGRADE from unlimited. That theory was wrong, and it was refusing
  // money from every remaining grandfathered account. Do not put it back. The
  // three facts that make Personal a strict UPGRADE for this cohort:
  //
  //   1. The grant is inbox-only. `resolvePlanLimits` (see plans.ts) spreads
  //      exactly `{ maxInboxes: Infinity }` for it and touches no other field,
  //      so a grandfathered user is still living under Free's other limits.
  //   2. The grant SURVIVES the plan change. Nothing anywhere clears or ignores
  //      `unlimited_inboxes` when a subscription activates: the only writes to
  //      that column in the entire codebase are the two grandfather migrations
  //      (20260819170500 and 20260901120000), the Stripe webhook never touches
  //      user_usage_entitlements, and `effective_workspace_plan` returns the
  //      column unconditionally rather than gating it on the plan. So a buyer
  //      resolves to Personal's limits with maxInboxes still Infinity.
  //   3. Personal therefore ADDS four things they do not have: the monthly
  //      action ceiling goes 5,000 to 100,000, the burst rate 60/min to 120/min,
  //      `billingPortalEnabled` false to true, and support community to email.
  //
  // Nothing is given up in exchange, because the one thing the grant provides
  // is the one thing Personal cannot take away from them. The refusal cost us
  // the whole cohort at the cheapest paid tier, and the last time an equivalent
  // 409 was lifted a full-price annual sale followed 2h15m later.
  //
  // The comped guard above is a different case and correctly stays: a comped
  // grant resolves to Pro with an uncapped action ceiling, so for those users
  // Personal really would be less than they already hold for free.

  const entitledStatuses = ['active', 'trialing', 'past_due', 'unpaid'];
  const hasEntitledSubscription =
    billing != null &&
    billing.plan !== 'free' &&
    (billing.subscription_status == null ||
      entitledStatuses.includes(billing.subscription_status));

  if (hasEntitledSubscription && !options.allowPlanChange) {
    // The chat checkout link. It opens a hosted page or nothing: the swap below
    // charges a card on file without one, and must stay out of reach of a
    // bearer link. Recorded like the other "somebody wanted to pay and was
    // turned away" refusals.
    await recordAttempt('subscription_exists');
    return fail('subscription_exists', 409, 'This account already has a paid plan.');
  }

  if (hasEntitledSubscription) {
    // Different paid plan OR a different interval of the same plan: change the
    // price on the existing subscription rather than opening a second one.
    //
    // SAME-PLAN REQUESTS FALL THROUGH HERE ON PURPOSE (2026-09-14). This spot
    // used to hold a 409 `already_on_plan` keyed on `billing.plan === planId`
    // alone, which ran before anything had looked at the interval. `user_billing`
    // records the TIER, not the price, so that check could not tell "already
    // paying for exactly this" from "paying monthly, asking for annual" and
    // refused both. Annual is sold at the paywall; the refusal meant nobody who
    // had already bought could ever take it, in either direction.
    //
    // Nothing is left unguarded by its removal. The real no-op is a price
    // comparison, not a plan comparison, and it is made below against the live
    // subscription item: if `currentItem.price.id === priceId` the request is
    // genuinely asking for the price already in force and is refused with
    // `already_on_plan_interval`. An interval switch reaches the swap exactly
    // like a tier change does, consent gate and all: `confirmChange` is still
    // required before a card is touched, so the first request only ever quotes.
    //
    // One case changes its wording rather than its outcome: a subscriber whose
    // plan is entitled but has no `stripe_subscription_id` (comped or manually
    // seeded) asking for the plan they already hold now gets
    // `plan_not_self_service` instead of `already_on_plan`. That is the honest
    // answer. Without a subscription to read there is no interval to compare,
    // so "contact support to change it" is what we actually know.
    //
    // This used to send the customer to the Billing Portal, which was a dead
    // end: the portal cannot offer a plan list on this account (the API
    // silently drops features.subscription_update.products), and the account
    // default configuration belongs to a different product, so it must not be
    // reshaped around these plans. Doing the swap here also keeps the customer
    // on our own copy instead of Stripe's.
    const subscriptionId = billing!.stripe_subscription_id;

    if (!subscriptionId) {
      // Entitled with no subscription id is a comped or manually seeded plan.
      // Those are not ours to re-price from a self-service button.
      await recordAttempt('subscription_exists');
      return fail(
        'plan_not_self_service',
        409,
        'Your plan is managed manually. Contact support to change it.',
        'subscription_not_self_service',
      );
    }

    // Where the change is coming FROM, and therefore whether it is expansion or
    // contraction. Filled in once the subscription has been read, because the
    // price the subscription is actually on is the only place the CURRENT
    // interval is written down at all: `user_billing` stores a plan and no
    // interval, so without this a monthly-to-annual switch on one tier would be
    // indistinguishable from no change.
    let fromPrice: { planId: PlanId; interval: BillingInterval } | null = null;

    // One rule, evaluated at whichever exit is reached, on the best inputs that
    // exit has. The fallback (`user_billing.plan` at the target's interval) is
    // for an exit taken before the subscription could be read, and for a price
    // that no longer maps to a plan at all: `getPlanByStripePriceId` returns
    // null for an archived id that was dropped from `legacyStripePriceIds`,
    // which the webhook already treats as an anomaly to reconcile by hand.
    // `>=` rather than `>` so an unresolvable pair defaults to the direction a
    // person clicking a paid plan almost always means.
    const changeDirection = (): PlanChangeDirection => {
      const fromPlanId = fromPrice?.planId ?? planCategory(billing!.plan);
      const fromInterval = fromPrice?.interval ?? interval;
      return planCommitmentRank(planId, interval) >=
        planCommitmentRank(fromPlanId, fromInterval)
        ? 'upgrade'
        : 'downgrade';
    };

    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      // The plan's own item. A Business subscription also carries the
      // per-mailbox add-on, and swapping THAT for the new plan's price would
      // bill the new plan once per extra mailbox.
      const currentItem = basePlanItem(subscription.items.data);

      if (!currentItem) {
        throw new Error(`Subscription ${subscriptionId} has no items.`);
      }

      const resolvedFrom = getPlanByStripePriceId(currentItem.price.id);
      if (resolvedFrom) {
        fromPrice = { planId: resolvedFrom.plan.id, interval: resolvedFrom.interval };
      }

      // The same no-op reached through a RETIRED price. A subscriber still
      // billing on Personal's $5 (or any legacy id) who asks for the same plan
      // at the same interval is asking for what they already have; comparing
      // price ids alone would read that as a change and quote them onto the
      // current, higher price. Grandfathered prices are kept, never re-priced
      // from a button. An interval or tier change is unaffected.
      const samePlanAndInterval =
        fromPrice?.planId === planId && fromPrice?.interval === interval;

      // A Pro subscriber who kept $15 / $144 at the Pro price change keeps
      // that generation when switching interval: monthly $15 goes to yearly
      // $144, not to the $182.40 Pro now sells. Null for everyone else, who
      // move to the sold price as before. See retainedPriceGenerationId.
      const swapPriceId =
        retainedPriceGenerationId(currentItem.price.id, planId, interval) ?? priceId;

      if (currentItem.price.id === swapPriceId || samePlanAndInterval) {
        // THE no-op, and the only one left since `already_on_plan` was removed
        // on 2026-09-14 (see the note at the top of this branch): the
        // subscription is already on the exact price being asked for.
        //
        // Not recorded, and not a checkout failure. Nothing was attempted,
        // nothing was refused and nothing could have been bought, so a
        // `checkout_started / failure` row would put a no-op click in the
        // bucket the growth board captions "our bug, not a change of mind".
        // The two refusals that DO stay in that bucket are the comped guard
        // and the manually-managed plan above, where somebody wanted to pay us
        // and was turned away.
        return fail(
          'already_on_plan_interval',
          409,
          `You are already on ${plan.name}, billed ${interval}ly.`,
        );
      }

      // ── The add-on half of the change ─────────────────────────────────────
      //
      // Business bills mailboxes past ten as a second item. Moving TO Business
      // adds it (or re-prices it on an interval switch) at the owner's current
      // count; moving AWAY removes it. Computed once and sent identically to
      // the quote and to the swap, so what the buyer confirms is what Stripe
      // bills: no silent re-pricing on the second call.
      const extraMailboxes =
        planId === 'pro'
          ? extraMailboxQuantity(
              (await countOwnedInboxes(createServiceRoleClient(), user.id)) ?? 0,
            )
          : 0;
      let addonChanges: MailboxAddonItemChange[];
      try {
        addonChanges = mailboxAddonItemChanges({
          targetPlan: planId,
          interval,
          extra: extraMailboxes,
          addonItem: readMailboxAddonState(subscription).addonItem,
        });
      } catch {
        await recordPlanChange({
          workspaceId: workspace.id,
          direction: changeDirection(),
          target,
          outcome: 'failure',
          failure: 'price_not_configured',
        });
        return fail(
          'price_not_configured',
          503,
          `Stripe price ID for the ${planId}/${interval} mailbox add-on is not configured. ` +
            'Please try again later or contact support.',
        );
      }

      // ── The seasonal offer on a switch ───────────────────────────────────
      //
      // Black Week 2026: a MONTHLY Personal or Pro subscriber on the current
      // monthly price who moves to annual Personal or Pro gets the first-year
      // coupon on this swap. Existing annual subscribers, Business, legacy
      // Team and the retired Personal $5 price get nothing. One redemption per
      // customer (any subscription ever tagged offer=bw2026, this one included).
      let offer: SeasonalOffer | null = null;
      const fromCurrentMonthly =
        fromPrice !== null &&
        fromPrice.interval === 'month' &&
        isSeasonalPlanId(fromPrice.planId) &&
        currentItem.price.id === PLANS[fromPrice.planId].stripePriceIdMonthly;
      // Only on the price the offer was checked against: the offer reader
      // vetted the SOLD yearly price, so a retained-generation swap (Pro price
      // change, see retainedPriceGenerationId) never carries the coupon.
      if (fromCurrentMonthly && interval === 'year' && swapPriceId === priceId) {
        offer = await liveOfferFor(planId, interval);
        if (offer) {
          const customerId =
            typeof subscription.customer === 'string'
              ? subscription.customer
              : subscription.customer.id;
          const redeemed =
            subscription.metadata?.[SEASONAL_OFFER_METADATA_KEY] === BLACK_WEEK_2026.id ||
            (await hasRedeemedSeasonalOffer(customerId));
          if (redeemed) offer = null;
        }
      }

      // ── The consent gate ───────────────────────────────────────────────────
      //
      // Everything above this line is a read. Below it, a card gets charged.
      //
      // A first-time buyer gets Stripe's hosted page, which states the amount
      // and takes an explicit action before any money moves. An existing
      // subscriber has a card on file and no hosted page, so without this gate
      // a single click on "Get Team" both changed their plan and their bill,
      // with the amount never once shown to them. Quote first, act only on the
      // way back.
      //
      // Nothing is recorded here: the funnel counts attempts, and asking the
      // price is not one. The row is written below, on the confirmed pass,
      // exactly once per completed decision.
      // The quote the customer confirmed carried the offer, and it is gone
      // now (typically: shown at 23:58 on 1 December, clicked at 00:01). Do
      // not charge the full price they never saw; quote again instead.
      const offerEnded =
        Boolean(confirmChange) && input.quotedOffer === BLACK_WEEK_2026.id && offer === null;

      if (!confirmChange || offerEnded) {
        return {
          kind: 'confirmation_required',
          planId,
          planName: plan.name,
          interval,
          ...(offerEnded ? { offerEnded: true } : {}),
          preview: await previewPlanChange({
            subscription,
            itemId: currentItem.id,
            priceId: swapPriceId,
            addonChanges,
            extraMailboxes,
            addonPriceId: mailboxAddonPriceId(interval),
            offer,
          }),
        };
      }

      // NOTHING IS RECORDED HERE, and until 2026-09-14 that was the bug. This
      // spot held `recordAttempt('subscription_exists')`, so the funnel's only
      // trace of a confirmed, invoiced, PAID upgrade was a row saying the
      // checkout had failed because a subscription already existed. Workspace
      // dbed58c7 bought Personal at 10:21 on 2026-09-14, hit the three-inbox
      // ceiling at 10:46 and upgraded to Pro; Stripe invoiced and collected it,
      // `user_billing` and `workspaces.plan` both moved, and the funnel
      // recorded the opposite. It made expansion revenue invisible and put the
      // one real customer who had ever expanded into the failure bucket.
      //
      // A checkout is not what happens here: no hosted page is created, so a
      // `checkout_started` row of either outcome would be a claim about a
      // Stripe Checkout session that does not exist, and a success row would
      // additionally read as an abandonment in the view (started with no
      // matching completion). The row this path owns is written at the three
      // exits below, in the `plan_upgraded` / `plan_downgraded` stages, once
      // the outcome is known.

      // `always_invoice` invoices and charges the proration NOW, at the moment
      // access changes. The old `create_prorations` deferred it to the next
      // invoice, which meant a subscriber could upgrade, use the higher tier,
      // and cancel before the proration was ever collected: access granted for
      // up to a month, billed for none of it.
      //
      // `pending_if_incomplete` decides what happens when that charge does not
      // succeed. Stripe holds the swap as a PENDING UPDATE and leaves the
      // subscription on the price it has, so an unpaid upgrade grants nothing;
      // Stripe applies it by itself the moment the invoice is paid. The
      // alternatives were both wrong here: the default `allow_incomplete`
      // upgrades first and chases the money afterwards (the same hole in a new
      // place), and `error_if_incomplete` throws away the invoice, which would
      // make every 3DS card in the EU and UK an outright failure with nothing
      // to authenticate against.
      //
      // Pending updates accept only a subset of parameters, so the metadata
      // this call used to write is gone. Nothing read it: `user_id` is already
      // on the subscription from `subscription_data` at creation and survives
      // untouched, and the webhook resolves the plan from the price id.
      //
      // A seasonal offer rides on the same call: `discounts` and `metadata`
      // are both supported on a pending update (Stripe "Pending updates"
      // reference), so an unpaid switch neither consumes the coupon on the
      // monthly plan nor tags a subscription that did not move.
      const updated = await stripe.subscriptions.update(subscriptionId, {
        items: [{ id: currentItem.id, price: swapPriceId }, ...addonChanges],
        proration_behavior: 'always_invoice',
        payment_behavior: 'pending_if_incomplete',
        expand: ['latest_invoice'],
        ...(offer
          ? {
              discounts: offerDiscounts(subscription, offer),
              metadata: { [SEASONAL_OFFER_METADATA_KEY]: offer.offerId },
            }
          : {}),
      });

      const latestInvoice =
        updated.latest_invoice && typeof updated.latest_invoice === 'object'
          ? updated.latest_invoice
          : null;

      if (updated.pending_update) {
        // Held, not applied. The plan the customer already paid for is intact,
        // so this is `started` and not `success`: the change has begun and the
        // money has not moved. See recordPlanChange for why no later row closes
        // it when Stripe applies the update by itself.
        await recordPlanChange({
          workspaceId: workspace.id,
          direction: changeDirection(),
          target,
          outcome: 'started',
        });
        return {
          kind: 'payment_required',
          planId,
          planName: plan.name,
          interval,
          invoiceUrl: latestInvoice?.hosted_invoice_url ?? null,
        };
      }

      // Paid and applied. The subscription.updated webhook projects the new
      // plan onto user_billing and every workspace the user owns.
      //
      // Recorded from here rather than from that webhook, which is the opposite
      // of the rule `recordCheckoutCompleted` follows, for a reason that only
      // applies to this path: the webhook is handed a subscription and nothing
      // about what it replaced, and nothing anywhere stores the price a
      // subscription was previously on. It can therefore see neither the
      // interval half of the move nor, without a second read, the direction.
      // This is not a client's claim either: `pending_if_incomplete` above
      // guarantees Stripe would have returned a pending update instead of an
      // applied one if the invoice had not been paid, so reaching this line IS
      // Stripe's confirmation that the money arrived.
      await recordPlanChange({
        workspaceId: workspace.id,
        direction: changeDirection(),
        target,
        outcome: 'success',
      });

      return {
        kind: 'changed',
        planId,
        planName: plan.name,
        interval,
        amountPaidCents: latestInvoice?.amount_paid ?? null,
        currency: latestInvoice?.currency ?? null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[checkout] plan change failed:', message);
      // Recorded, where before it was only logged. A subscriber who confirmed
      // an amount and got a 500 is the most expensive failure on this path and
      // was the one the funnel could not see at all: it left no row of any
      // stage, because the single `checkout_started` write sat inside the try
      // below the throw. `stripe_error` rather than `subscription_exists`,
      // since what failed is the call to Stripe and not the entitlement check.
      await recordPlanChange({
        workspaceId: workspace.id,
        direction: changeDirection(),
        target,
        outcome: 'failure',
        failure: 'stripe_error',
      });
      return fail(
        'plan_change_failed',
        500,
        'Could not change your plan. Please try again.',
      );
    }
  }

  // ── 4c. Business: the mailboxes past ten ───────────────────────────────────
  // A first-time Business buyer who already runs more than ten mailboxes is
  // billed for them from the first invoice, on Stripe's own page, where the
  // line and its quantity are shown before they pay. The per-mailbox price must
  // be configured for EVERY Business checkout, not only one with extras today:
  // the next connect past ten would otherwise have nothing to bill against.
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    { price: priceId, quantity: 1 },
  ];
  if (planId === 'pro') {
    const addonPriceId = mailboxAddonPriceId(interval);
    if (!addonPriceId) {
      await recordAttempt('price_not_configured');
      return fail(
        'price_not_configured',
        503,
        `Stripe price ID for the ${planId}/${interval} mailbox add-on is not configured. ` +
          'Please try again later or contact support.',
      );
    }
    const extra = extraMailboxQuantity(
      (await countOwnedInboxes(createServiceRoleClient(), user.id)) ?? 0,
    );
    if (extra > 0) lineItems.push({ price: addonPriceId, quantity: extra });
  }

  // ── 5. Get or create the single Stripe Customer for this user ─────────────
  const ownerEmail = user.email ?? '';
  let customerId: string;

  try {
    const result = await getOrCreateStripeCustomer({
      userId: user.id,
      ownerEmail,
      displayName: workspace.display_name,
    });
    customerId = result.customerId;
  } catch (err) {
    console.error('[checkout] getOrCreateStripeCustomer failed:', err);
    await recordAttempt('stripe_error');
    return fail(
      'stripe_customer_failed',
      500,
      'Failed to create Stripe customer. Please try again.',
    );
  }

  // ── 6. Build success / cancel URLs ────────────────────────────────────────
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

  // The interval rides along with the plan because the confirmation panel on
  // the other side cannot derive it: a plan id alone does not say whether the
  // buyer just paid the monthly or the yearly price, so without this the panel
  // can name the plan but not state what it cost or when it renews. Both values
  // are validated above (`planId` against PURCHASABLE_PLAN_IDS, `interval`
  // against 'month' | 'year'), so neither can put anything unexpected in the
  // query string. The panel treats a missing `interval` as "price unknown" and
  // simply omits those two rows, which is what any session created before this
  // shipped will still do when its buyer returns.
  const successUrl =
    options.successUrl ??
    `${appUrl}/dashboard?checkout=success&plan=${planId}&interval=${interval}`;
  const cancelUrl = options.cancelUrl ?? `${appUrl}/dashboard?checkout=cancelled`;

  // ── 6b. Seasonal offer (Black Week 2026) ──────────────────────────────────
  // Annual Personal or Pro inside the window, coupon live, price unchanged,
  // and this customer has never had a subscription tagged with the offer.
  let offer = await liveOfferFor(planId, interval);
  if (offer && (await hasRedeemedSeasonalOffer(customerId))) offer = null;
  const offerMetadata: Record<string, string> = offer
    ? { [SEASONAL_OFFER_METADATA_KEY]: offer.offerId }
    : {};

  // ── 7. Create the Stripe Checkout session ─────────────────────────────────
  const locale = checkoutLocale(input.locale);
  const lang = reminderLocale(input.locale);
  const reminderLang = lang === 'en' ? null : lang;
  const recoveredFrom = checkoutSessionIdOrNull(input.recoveredFrom);
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: lineItems,
      success_url: successUrl,
      cancel_url: cancelUrl,
      // `discounts` and `allow_promotion_codes` cannot be combined in one
      // session, so an offer session applies the coupon server side and
      // shows no promotion-code field.
      ...(offer
        ? { discounts: [{ coupon: offer.couponId }] }
        : { allow_promotion_codes: true }),
      // Billing address is collected by Stripe: required for tax calculation.
      billing_address_collection: 'auto',
      // Local-currency checkout for buyers outside the US. Prices stay USD and
      // every amount Stripe hands back to us stays USD; see adaptive-pricing.ts.
      // It converts the amount only, so the language pin below is unaffected.
      adaptive_pricing: adaptivePricingParam(),
      // ── Presentation ────────────────────────────────────────────────────
      //
      // ENGLISH IS PINNED for everyone but German buyers, deliberately. Left
      // to itself Stripe localises its own chrome from the buyer's browser
      // (Accept-Language), but the things it renders from OUR data cannot
      // follow: the product name and description on the line item live once,
      // in English, on the Stripe Product. A Norwegian browser therefore
      // produced a page that said "Abonner pa MCPEmails Personal / 48,00 USD
      // per ar" directly above an English sentence about connected inboxes,
      // in two different voices. One language beats a half-translated one.
      //
      // German is the exception because the law makes it one: see
      // CheckoutLocale above. A German buyer accepts English product names in
      // exchange for a subscribe button that reads "Zahlungspflichtig
      // abonnieren" and German text beside it. Pass another locale through
      // the day the Stripe Products carry translated names and descriptions.
      locale,
      // The two moments the hosted page leaves room for our own voice.
      //
      // `submit` sits directly above the subscribe button, where the
      // hesitation is, and is also the closest we can put consumer-law text to
      // it. Stripe renders Markdown links there (checked in test mode
      // 2026-10-20). `after_submit` covers the redirect back to us.
      //
      // THE BUTTON LABEL IS STRIPE'S, and in subscription mode it cannot be
      // changed: `submit_type: 'pay'` is rejected ("You can not pass
      // submit_type: 'pay' in subscription mode"), and the label follows
      // `locale`. Under 'en' it reads "Subscribe"; under 'de' it reads
      // "Zahlungspflichtig abonnieren". The first sentence of the message
      // states the payment obligation in words next to the button; it does
      // not replace a compliant label.
      custom_text: checkoutCustomText(locale, appUrl),
      // Pass USER context through to the subscription for the webhook handler.
      // The subscription is tied to the user; the webhook resolves the owner
      // from user_id (or the customer) and propagates to all owned workspaces.
      subscription_data: {
        metadata: {
          user_id: user.id,
          ...offerMetadata,
        },
      },
      // Unset unless the caller asks (the chat link's 31 minutes). Every other
      // session keeps Stripe's 24-hour default, which the abandoned-checkout
      // reminder is timed around.
      ...(options.sessionExpiresAt ? { expires_at: options.sessionExpiresAt } : {}),
      metadata: {
        // Spread FIRST, so a caller's extra key can never replace the three
        // the webhook trusts.
        ...(options.extraMetadata ?? {}),
        user_id: user.id,
        plan_id: planId,
        interval,
        ...offerMetadata,
        // The buyer's app language, so an abandoned-checkout reminder for this
        // session can be written in it. Allow-listed; English adds nothing.
        ...(reminderLang ? { lang: reminderLang } : {}),
        ...(recoveredFrom ? { recovered_from: recoveredFrom } : {}),
      },
      // Stripe Tax stays OFF, deliberately (decision 2026-08-19).
      //
      // Stripe Tax IS active on the account, but the account holds ZERO tax
      // registrations. Stripe only calculates tax where you are registered, so
      // enabling automatic_tax today would add a "Tax: $0.00" line to every
      // checkout in every country and change nothing else. The prerequisite is
      // registering for Norway MVA, EU Non-Union OSS and UK VAT; until those
      // exist there is nothing for it to compute.
      //
      // Turning it on later needs no price migration: the prices created in the
      // repricing already carry tax_behavior=exclusive, so the displayed amount
      // stays the amount and tax is added on top the day registrations land.
      // automatic_tax: { enabled: true },
    });

    if (!session.url) {
      throw new Error('Stripe returned a session without a URL.');
    }

    // The user is now on Stripe's hosted page. A `checkout_completed` event
    // that never follows this one is the abandonment signal.
    await recordAttempt();
    return { kind: 'checkout', url: session.url, sessionId: session.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[checkout] stripe.checkout.sessions.create failed:', message);
    await recordAttempt('stripe_error');
    return fail(
      'stripe_session_failed',
      500,
      'Failed to create checkout session. Please try again.',
    );
  }
}
