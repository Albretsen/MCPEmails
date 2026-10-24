/**
 * Stripe plan definitions for MCPEmails.
 *
 * PRICING STRATEGY (rebuilt 2026-08-19).
 *
 * The value metric is CONNECTED INBOXES, not actions. Inboxes are the scarce,
 * defensible asset: every workspace with two or more inboxes is active, and the
 * businesses that run three to seven mailboxes (hotels, agencies, publishers)
 * are the accounts worth pricing for.
 *
 * FREE ACTION ALLOWANCE (2026-09-12). Free workspaces created after launch get
 * FREE_ACTION_ALLOWANCE billable email actions per UTC calendar month, with the
 * first FREE_ACTION_GRACE_DAYS days uncounted. That allowance is public and
 * sold: it is on the pricing page, the dashboard, the docs and the README, and
 * the number a customer reads is by construction the number that blocks them
 * (the SQL function `workspace_action_allowance` owns both constants; the two
 * exports below mirror them for copy). Paid tiers still carry only a silent
 * abuse ceiling that never appears in customer-facing copy. See
 * docs/PLAN-free-action-cap-150.md.
 *
 * Four tiers: Free (1 inbox), Personal (3 inboxes, one person), Pro (10
 * inboxes, one person running a business), Business (10 inboxes included plus
 * a per-mailbox price above that, unlimited people, several workspaces).
 *
 * The internal ids stay `free` / `solo` / `pro` so `workspaces.plan` needs no
 * data migration, and `personal` was added later as the only id whose display
 * name matches it. The display names are:
 *
 *   free     -> "Free"
 *   personal -> "Personal"
 *   solo     -> "Pro"      (was "Agent", before that "Solo")
 *   pro      -> "Business" (was "Team", before that "Scale", before that "Team")
 *
 * Price IDs come from environment variables so test and production can differ:
 *
 *   STRIPE_PRICE_PERSONAL_MONTHLY_V2=price_... (Personal monthly, $9)
 *   STRIPE_PRICE_PERSONAL_YEARLY_V2=price_...  (Personal yearly, $86.40)
 *   STRIPE_PRICE_PERSONAL_MONTHLY=price_...    (RETIRED Personal $5, still billing)
 *   STRIPE_PRICE_PERSONAL_YEARLY=price_...     (RETIRED Personal $48, still billing)
 *   STRIPE_PRICE_SOLO_MONTHLY=price_...       (Pro monthly, $15)
 *   STRIPE_PRICE_SOLO_YEARLY=price_...        (Pro yearly, $144)
 *   STRIPE_PRICE_SOLO_MONTHLY_V2=price_...    (Pro monthly, $19, sold once
 *                                              PRO_PRICE_CHANGE.priceLive)
 *   STRIPE_PRICE_SOLO_YEARLY_V2=price_...     (Pro yearly, $182.40, same)
 *   STRIPE_PRICE_BUSINESS_MONTHLY=price_...          (Business monthly, $39)
 *   STRIPE_PRICE_BUSINESS_YEARLY=price_...           (Business yearly, $374.40)
 *   STRIPE_PRICE_BUSINESS_MAILBOX_MONTHLY=price_...  (extra mailbox, $3/mo)
 *   STRIPE_PRICE_BUSINESS_MAILBOX_YEARLY=price_...   (extra mailbox, $28.80/yr)
 *   STRIPE_PRICE_PRO_MONTHLY=price_...        (RETIRED Team $79, legacy only)
 *   STRIPE_PRICE_PRO_YEARLY=price_...         (RETIRED Team $756, legacy only)
 *
 * PRO REPRICED 2026-09-01: $29 -> $15/mo, $276 -> $144/yr.
 *
 * Pro at $29 had generated exactly ONE Stripe checkout session in its entire
 * life (created 2026-08-27, expired unpaid); that same workspace bought
 * Personal yearly 47 hours later. So $29 was never refused at volume, it was
 * never offered: `inboxCapOffer` routes every Free workspace hitting the
 * one-inbox cap to Personal, and all 36 `paywall_reached` events to date were
 * that cap. The price was still wrong on two counts. The ladder stepped $5 ->
 * $29, a 5.8x jump, to go from three mailboxes to the observed real need of
 * five; and the market rate for five mailboxes is about $5 to $11 (anymailmcp
 * sells five for EUR 4.99, MailMCP charges EUR 1.99 per mailbox), which made a
 * one-person plan cost the same as a competitor's unlimited-seat team plan.
 *
 * $15 is where three independent methods converge: 3x Personal as a ladder
 * step, five inboxes at a modest premium over Personal's per-inbox rate, and a
 * defensible premium over the mailbox-count competitors that still sits under
 * the adjacent AI-email tools (Inbox Zero $18, Drag $12-24). $144/yr keeps the
 * "save ~20%" annual discount exact. Personal deliberately stays at $5.
 *
 * PERSONAL REPRICED 2026-09-29: $5 -> $9/mo, $48 -> $86.40/yr, NEW CUSTOMERS
 * ONLY. Personal was two thirds of buyers at $1.67 an inbox, under both
 * mailbox-count competitors (MailMCP EUR 2.99, Mailbox MCP GBP 2.92 per
 * mailbox). $9 is $3 an inbox, still under both, and the ladder becomes
 * $9 -> $15 for three inboxes -> unlimited. $86.40 is 12 x $9 less exactly
 * 20%, the same discount every other annual price carries. The read-out is
 * docs/PLAN-personal-reprice-900.md.
 *
 * Existing subscribers are not migrated, prorated or emailed. Their
 * subscriptions keep billing on the $5 / $48 prices, whose ids stay in
 * STRIPE_PRICE_PERSONAL_MONTHLY / _YEARLY and are read below as Personal's
 * legacy pair. The prices sold from now on come from the _V2 variables. New
 * names rather than overwritten values so the retired ids never have to be
 * copied by hand: the renewal mapping is correct from the first deploy.
 *
 * GRANDFATHERING. Every user who existed before the repricing keeps unlimited
 * inboxes at no cost, permanently. That protection is user-level and lives in
 * `user_usage_entitlements.unlimited_inboxes`, so it follows an owner into any
 * workspace they create later. It is resolved through `resolvePlanLimits`.
 *
 * PRO $15 -> $19 FOR NEW CUSTOMERS (announced, behind a switch). See
 * pro-price-change.ts. Same shape as the Personal _V2 change: while
 * `priceLive` is off Pro sells the unsuffixed pair and the _V2 ids are read as
 * legacy (nobody can buy them, and a rollback after the cutover keeps every $19
 * subscription mapped); once it is on, Pro sells _V2 and the unsuffixed $15 /
 * $144 pair becomes the legacy pair. Every Pro subscriber at the cutover keeps
 * their price for as long as the subscription stays active, including across
 * a monthly / yearly switch (`retainedPriceGenerationId`).
 *
 * PRO CAPPED AT 10, TEAM REPLACED BY BUSINESS (2026-10-19). Pro sold unlimited
 * mailboxes for $15, which made it the right plan for the heaviest operators
 * and left Team ($79, priced per person) with nothing to sell: the business
 * buyer is one person running many mailboxes, not a team. So:
 *
 *   - Pro is capped at PRO_INBOX_CAP for new customers. Every workspace on Pro
 *     at the cutover holds `workspaces.pro_unlimited_inboxes_exempt` and keeps
 *     unlimited; it arrives here as `proUnlimitedInboxes`. The same value is
 *     the kill switch: `pricing_switches.pro_inbox_cap = false` makes it true
 *     for every workspace (see effective_workspace_plan, 20261019150000).
 *   - Business (slug `pro`) is $39 with BUSINESS_INCLUDED_INBOXES included and
 *     BUSINESS_EXTRA_INBOX_* per mailbox above that, billed as a second
 *     subscription item kept in sync by src/lib/stripe/mailbox-addon.ts. It is
 *     never capped: more mailboxes cost more, they are never refused.
 *   - The retired $79 / $756 Team prices stay resolvable as Business legacy
 *     ids, so a stray subscription on them still maps.
 */

import { PRO_PRICE_CHANGE, proSoldAmounts } from './pro-price-change.ts';

// ---------------------------------------------------------------------------
// Plan identifiers: must match the `plan` column values in `workspaces`.
// ---------------------------------------------------------------------------
export type PlanId = 'free' | 'personal' | 'solo' | 'pro';

// ---------------------------------------------------------------------------
// Billing interval
// ---------------------------------------------------------------------------
export type BillingInterval = 'month' | 'year';

// ---------------------------------------------------------------------------
// Support tiers
// ---------------------------------------------------------------------------
export type SupportTier = 'community' | 'email' | 'priority';

// ---------------------------------------------------------------------------
// Feature limits per plan.
// ---------------------------------------------------------------------------
export interface PlanLimits {
  /** Maximum connected inboxes. THE value metric. Infinity = unlimited. */
  maxInboxes: number;
  /** Legacy daily burst cap. Infinity = unlimited (all tiers). */
  maxDailyBurstCalls: number;
  /**
   * Billable email actions per billing period.
   *
   * Two different things, depending on the tier:
   *
   *   Free   THE PUBLIC ALLOWANCE (FREE_ACTION_ALLOWANCE). It is stated on the
   *          pricing page, in the Free feature list, on the dashboard and in
   *          the docs, and the MCP edge function refuses at exactly this
   *          number once the first FREE_ACTION_GRACE_DAYS days have passed.
   *          Workspaces that existed before 2026-09-12 are exempt for good
   *          (`workspaces.free_action_cap_exempt`).
   *
   *   Paid   A SILENT ABUSE CEILING. Not a pricing lever; it must never appear
   *          on the pricing page, in a feature list, in the dashboard or in the
   *          docs. It exists so a runaway or malicious agent cannot burn
   *          unbounded provider quota, and every ceiling sits far above any
   *          observed real usage (the highest month any external workspace has
   *          ever recorded is 3,105 actions). Copy says "no monthly action
   *          cap", never a number.
   *
   * The SQL function `workspace_action_allowance` is the definition every
   * enforcing and displaying caller reads; these values mirror it.
   *
   * Infinity = a comped entitlement.
   */
  maxMonthlyToolCalls: number;
  /** Maximum API keys. Infinity = unlimited (all tiers). */
  maxApiKeys: number;
  /** Maximum workspace members. */
  maxMembers: number;
  /** Whether the customer portal (billing self-service) is available. */
  billingPortalEnabled: boolean;
  /** Whether the usage analytics page is available. */
  analyticsEnabled: boolean;
  /** Per-minute fair-use rate-limit ceiling enforced in the MCP edge function. */
  maxRequestsPerMinute: number;
  /** How many days of usage history the analytics dashboard exposes. */
  analyticsRetentionDays: number;
  /** Team roles and multiple workspaces (one workspace per client or business). */
  teamRolesEnabled: boolean;
  /** SSO (SAML / OIDC). */
  ssoEnabled: boolean;
  /** Audit log. */
  auditLogEnabled: boolean;
  /** Support tier. */
  supportTier: SupportTier;
}

// ---------------------------------------------------------------------------
// The Free action allowance, for copy.
//
// The SQL function `workspace_action_allowance` (migration
// 20260912200000_free_action_cap_150) holds the enforced cap as c_free_cap,
// and free_action_grace_ends_at() (20261017160000) the grace: 3 days for
// workspaces created from 2026-10-17 16:00 UTC, 7 before. These two are the copy-side mirror: every sentence
// that quotes the allowance derives from them, and plans-copy-parity.test.ts
// checks that the pricing page's translated copy agrees. Change all three
// together or the number a customer reads stops being the number that blocks
// them.
// ---------------------------------------------------------------------------
export const FREE_ACTION_ALLOWANCE = 150;
export const FREE_ACTION_GRACE_DAYS = 3;

// ---------------------------------------------------------------------------
// Mailbox numbers quoted in copy. plans-copy-parity.test.ts pins the pricing
// page's translated copy to these, as it does for the Free allowance.
// ---------------------------------------------------------------------------
/** Pro's connected-inbox cap for workspaces without the cutover exemption. */
export const PRO_INBOX_CAP = 10;
/** Mailboxes the Business base price includes. */
export const BUSINESS_INCLUDED_INBOXES = 10;
/** Each Business mailbox above the included ones, per month, in USD cents. */
export const BUSINESS_EXTRA_INBOX_MONTHLY_CENTS = 300;
/** The same, per year: 12 x $3 less the 20% every annual price carries. */
export const BUSINESS_EXTRA_INBOX_YEARLY_CENTS = 2880;

// ---------------------------------------------------------------------------
// Plan definition
// ---------------------------------------------------------------------------
export interface Plan {
  id: PlanId;
  /** Display name shown to customers. */
  name: string;
  description: string;
  limits: PlanLimits;
  /** Monthly price in USD cents. 0 = free. */
  monthlyPriceCents: number;
  /** Yearly price in USD cents. 0 = free. null = not offered. */
  yearlyPriceCents: number | null;
  /** Stripe price ID for monthly billing. null = not applicable (free plan). */
  stripePriceIdMonthly: string | null;
  /** Stripe price ID for yearly billing. null = not applicable. */
  stripePriceIdYearly: string | null;
  /**
   * Retired live Stripe price IDs that still map to this plan.
   *
   * Subscriptions created before the 2026-08-19 repricing keep billing on their
   * original price. The webhook must still resolve those prices to a plan, or a
   * renewal would look like an unknown price and silently drop the customer's
   * entitlement. Never remove an id from this list while a subscription is on it.
   */
  legacyStripePriceIds: string[];
  /** Features to display in the pricing table (marketing copy). */
  features: string[];
  /** Whether this is the recommended plan (highlighted in pricing UI). */
  highlighted: boolean;
}

// ---------------------------------------------------------------------------
// A retired monthly/yearly pair read from the environment.
//
// `getPlanByStripePriceId` tells a legacy monthly id from a yearly one by its
// POSITION in `legacyStripePriceIds`, so a pair must always occupy two slots,
// even when one side is unset. An empty string holds the slot and can never
// match: the lookup returns null for an empty price id before it gets here.
// ---------------------------------------------------------------------------
function legacyPricePair(
  monthly: string | undefined,
  yearly: string | undefined,
): string[] {
  return [monthly?.trim() || '', yearly?.trim() || ''];
}

// ---------------------------------------------------------------------------
// Pro's two price generations: [monthly, yearly] each.
//
// `PRO_SOLD_PAIR` is what checkout sells; `PRO_RETAINED_PAIR` is the generation
// that stopped being sold at the cutover and that every subscriber on it keeps.
// Before the cutover the retained pair is the not-yet-sold _V2 pair: mapping
// it is harmless and keeps a rollback safe. No fallback from _V2 to the
// unsuffixed variables once live: an unset _V2 must fail as
// `price_not_configured`, never sell $15 under copy that says $19.
// ---------------------------------------------------------------------------
const PRO_CURRENT_PAIR = legacyPricePair(
  process.env.STRIPE_PRICE_SOLO_MONTHLY,
  process.env.STRIPE_PRICE_SOLO_YEARLY,
);
const PRO_NEXT_PAIR = legacyPricePair(
  process.env.STRIPE_PRICE_SOLO_MONTHLY_V2,
  process.env.STRIPE_PRICE_SOLO_YEARLY_V2,
);
const PRO_SOLD_PAIR = PRO_PRICE_CHANGE.priceLive ? PRO_NEXT_PAIR : PRO_CURRENT_PAIR;
const PRO_RETAINED_PAIR = PRO_PRICE_CHANGE.priceLive ? PRO_CURRENT_PAIR : PRO_NEXT_PAIR;
const PRO_SOLD = proSoldAmounts();

// ---------------------------------------------------------------------------
// Plan catalogue
// ---------------------------------------------------------------------------
export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    description: 'Connect one inbox and give your agent a real mailbox.',
    limits: {
      maxInboxes: 1,
      maxDailyBurstCalls: Infinity,
      maxMonthlyToolCalls: FREE_ACTION_ALLOWANCE,
      maxApiKeys: Infinity,
      maxMembers: 1,
      billingPortalEnabled: false,
      analyticsEnabled: true,
      maxRequestsPerMinute: 60,
      // 30, not 7. Free already showed 30 days before the window was enforced,
      // and cutting a live tier down to make a blog sentence true would be
      // taking something away from users to win an argument about copy. The
      // sentence was changed instead. 30 is the floor every tier starts from;
      // the paid tiers buy MORE history, they do not buy back the default.
      // Storage follows these windows through the pg_cron job
      // `activity-log-retention` (migration 20261020153742), which keeps every
      // row at least 90 days for now, so Free rows past 30 days are hidden by
      // the dashboard rather than deleted.
      analyticsRetentionDays: 30,
      teamRolesEnabled: false,
      ssoEnabled: false,
      auditLogEnabled: false,
      supportTier: 'community',
    },
    monthlyPriceCents: 0,
    yearlyPriceCents: 0,
    stripePriceIdMonthly: null,
    stripePriceIdYearly: null,
    legacyStripePriceIds: [],
    features: [
      '1 connected inbox',
      // The public allowance, from the constants above so this sentence, the
      // pricing table and the enforcing SQL cannot quote three numbers.
      `${FREE_ACTION_ALLOWANCE} email actions a month, first ${FREE_ACTION_GRACE_DAYS} days uncounted`,
      'Read, search, organise, draft, schedule and send',
      // Named here, not on Personal. Scheduled sends and the per-inbox send
      // review / approval hold have never had a plan gate, and the usage
      // analytics dashboard is on every tier. They were listed as Personal
      // features until 2026-09-12, which made the card contradict the
      // comparison table on the same page. Keep them on Free.
      'Send review and approval hold',
      'Usage analytics',
      'Gmail, Outlook, iCloud, Fastmail and any IMAP',
      'Unlimited API keys',
      'Community support',
    ],
    highlighted: false,
  },

  // "Personal" tier; the only internal id that matches its display name.
  personal: {
    id: 'personal',
    name: 'Personal',
    description: 'Three mailboxes for one person or one small business: work, personal, or your first company addresses.',
    limits: {
      maxInboxes: 3,
      maxDailyBurstCalls: Infinity,
      maxMonthlyToolCalls: 100_000,
      maxApiKeys: Infinity,
      maxMembers: 1,
      billingPortalEnabled: true,
      analyticsEnabled: true,
      maxRequestsPerMinute: 120,
      // 30 -> 90 on 2026-10-20 (owner decision). Personal had always stored 90
      // days, so the longer view is backed by data from day one.
      analyticsRetentionDays: 90,
      teamRolesEnabled: false,
      ssoEnabled: false,
      auditLogEnabled: false,
      supportTier: 'email',
    },
    // THE Personal price. Every surface that quotes it (pricing page, paywall,
    // upgrade dialogs, JSON-LD, emails, translated copy) derives from these two
    // numbers or is pinned to them by a test. $9 / $86.40 since 2026-09-29.
    monthlyPriceCents: 900,
    yearlyPriceCents: 8640,
    // No fallback to the unsuffixed variables. Those now hold the RETIRED $5 /
    // $48 prices, and falling back to them would charge $5 under copy that says
    // $9. An unset _V2 variable fails loudly as `price_not_configured`.
    stripePriceIdMonthly: process.env.STRIPE_PRICE_PERSONAL_MONTHLY_V2 ?? null,
    stripePriceIdYearly: process.env.STRIPE_PRICE_PERSONAL_YEARLY_V2 ?? null,
    // The $5 / $48 prices every Personal subscriber before 2026-09-29 is on.
    // Never unset those two variables while a subscription bills on them: a
    // renewal on an unmapped price keeps the plan but loses its name on the
    // revenue board, its direction on a plan change and its lifecycle emails.
    legacyStripePriceIds: legacyPricePair(
      process.env.STRIPE_PRICE_PERSONAL_MONTHLY,
      process.env.STRIPE_PRICE_PERSONAL_YEARLY,
    ),
    // ONLY real deltas over Free belong here. The enforced ones are: maxInboxes
    // 1 -> 3, the monthly action cap (Free's public 150 -> none that a
    // customer can reach; the paid ceiling stays a silent abuse guard and is
    // never quoted as a number), maxRequestsPerMinute 60 -> 120, supportTier
    // community -> email, billingPortalEnabled, and analyticsRetentionDays
    // 30 -> 90. The history window is left out on purpose: this array ships in
    // the purchase confirmation email, which nothing re-checks when a window
    // moves; the pricing page's comparison table carries it. Pro and Business
    // inherit "no cap" through "Everything in Personal" and must not restate it.
    features: [
      'Everything in Free',
      '3 connected inboxes',
      'No monthly action cap',
      '2x higher burst rate limit',
      'Email support',
    ],
    highlighted: false,
  },

  // "Pro" tier; internal id stays `solo`.
  solo: {
    id: 'solo',
    name: 'Pro',
    description: 'For one person running a business: up to 10 mailboxes on one agent, from finance and sales to support and your own.',
    limits: {
      // New customers only. A workspace on Pro at the 2026-10 cutover keeps
      // unlimited through `proUnlimitedInboxes` in resolvePlanLimits.
      maxInboxes: PRO_INBOX_CAP,
      maxDailyBurstCalls: Infinity,
      maxMonthlyToolCalls: 100_000,
      maxApiKeys: Infinity,
      maxMembers: 1,
      billingPortalEnabled: true,
      analyticsEnabled: true,
      maxRequestsPerMinute: 300,
      // 90 -> 730 on 2026-10-20 (owner decision). Rows older than 90 days were
      // deleted on every plan until that date, so the two years build up from
      // then: copy promises the window, never history that already exists.
      analyticsRetentionDays: 730,
      teamRolesEnabled: false,
      ssoEnabled: false,
      auditLogEnabled: false,
      supportTier: 'email',
    },
    // $15 / $144 until PRO_PRICE_CHANGE.priceLive, then $19 / $182.40.
    monthlyPriceCents: PRO_SOLD.monthlyCents,
    yearlyPriceCents: PRO_SOLD.yearlyCents,
    stripePriceIdMonthly: PRO_SOLD_PAIR[0] || null,
    stripePriceIdYearly: PRO_SOLD_PAIR[1] || null,
    legacyStripePriceIds: [
      'price_1TcQBDARrgumc6cqy1Z9AAEw', // Agent monthly, $12
      'price_1TcQBEARrgumc6cq6MGFktzy', // Agent yearly, $120
      'price_1U69IuARrgumc6cqLGFI2FLR', // Pro monthly, $29 (retired 2026-09-01)
      'price_1U69J5ARrgumc6cqmIIP8DAw', // Pro yearly, $276 (retired 2026-09-01)
      // The generation not sold right now: $19 / $182.40 before the cutover,
      // $15 / $144 after it. A pair, so it keeps the monthly-then-yearly order.
      ...PRO_RETAINED_PAIR,
    ],
    features: [
      'Everything in Personal',
      `${PRO_INBOX_CAP} connected inboxes`,
      '5x higher burst rate limit',
      // Longer than Personal's 90 days (730). Deliberately unnumbered: a window
      // quoted in a feature list is quoted in the purchase confirmation email,
      // which nothing re-checks when the window moves. The pricing page's
      // comparison table carries the exact days.
      'Longer analytics history',
    ],
    highlighted: true,
  },

  // "Business" tier; internal id stays `pro` (sold as "Team" until 2026-10-19).
  pro: {
    id: 'pro',
    name: 'Business',
    description: 'For a business with many mailboxes or several people: 10 mailboxes included, more at a fixed price each.',
    limits: {
      // Never capped. Mailboxes above BUSINESS_INCLUDED_INBOXES are billed per
      // mailbox (src/lib/stripe/mailbox-addon.ts), not refused.
      maxInboxes: Infinity,
      maxDailyBurstCalls: Infinity,
      maxMonthlyToolCalls: 500_000,
      maxApiKeys: Infinity,
      maxMembers: Infinity,
      billingPortalEnabled: true,
      analyticsEnabled: true,
      maxRequestsPerMinute: 1000,
      // 730, the same as Pro (owner decision 2026-10-20). Team said 365, but a
      // pg_cron job deleted activity_log after 90 days on every plan until
      // that date, so 365 was never delivered; the per-plan job that replaced
      // it keeps this plan's rows for 730 days. Comped workspaces resolve to
      // this plan, so they get 730 too.
      analyticsRetentionDays: 730,
      teamRolesEnabled: true,
      // Nothing reads either flag and neither feature exists. They stay false
      // until the feature does, so no copy can be generated from them.
      ssoEnabled: false,
      auditLogEnabled: false,
      // There is no priority queue behind "priority"; email support is what
      // every paid plan actually gets.
      supportTier: 'email',
    },
    monthlyPriceCents: 3900,
    yearlyPriceCents: 37440,
    // New variables rather than overwritten STRIPE_PRICE_PRO_*: those hold the
    // retired $79 / $756 Team prices and are read below as legacy, so the day
    // this deploys a stray Team subscription still resolves to this plan.
    stripePriceIdMonthly: process.env.STRIPE_PRICE_BUSINESS_MONTHLY ?? null,
    stripePriceIdYearly: process.env.STRIPE_PRICE_BUSINESS_YEARLY ?? null,
    legacyStripePriceIds: [
      'price_1TcQBFARrgumc6cqmaRTXJ5Q', // Scale monthly, $49
      'price_1TcQBGARrgumc6cqmy0LeLSL', // Scale yearly, $490
      'price_1Tb0HfARrgumc6cqMeQSsMNr', // Team monthly, $19 (archived)
      'price_1Tb0HfARrgumc6cqQR33xYAN', // Team yearly, $152 (archived)
      // Team $79 / $756, retired 2026-10-19.
      ...legacyPricePair(
        process.env.STRIPE_PRICE_PRO_MONTHLY,
        process.env.STRIPE_PRICE_PRO_YEARLY,
      ),
    ],
    // Only what works today, each checked against the code on 2026-10-19:
    // members and roles (invite + members routes, teamRolesEnabled), admins
    // approving held sends (send_approvals, approve is admin-gated), several
    // workspaces on one subscription (create_workspace requires this plan and
    // the webhook projects the plan onto every owned workspace), and the
    // per-mailbox price. No SSO, no audit export, no longer history.
    features: [
      'Everything in Pro',
      `${BUSINESS_INCLUDED_INBOXES} connected inboxes included, $${BUSINESS_EXTRA_INBOX_MONTHLY_CENTS / 100} a month for each extra mailbox`,
      'Unlimited members with roles, at no extra cost',
      'Admins approve held sends',
      'Several workspaces on one subscription',
    ],
    highlighted: false,
  },
} as const;

// ---------------------------------------------------------------------------
// Helper: look up limits for a plan name stored in DB.
// Falls back to 'free' limits for an unrecognised value (covers legacy
// 'enterprise' rows).
// ---------------------------------------------------------------------------
export function getPlanLimits(planId: string): PlanLimits {
  const plan = PLANS[planId as PlanId];
  return plan?.limits ?? PLANS.free.limits;
}

// ---------------------------------------------------------------------------
// Helper: user-facing display name for a plan slug stored in `workspaces.plan`.
// The DB stores internal ids ('free' | 'personal' | 'solo' | 'pro'); customers
// only ever see "Free", "Personal", "Pro", and "Business". Use this everywhere a
// plan is shown to a user so the dashboard never leaks an internal id.
// ---------------------------------------------------------------------------
export function planDisplayName(planId: string | null | undefined): string {
  if (!planId) return PLANS.free.name;
  const plan = PLANS[planId as PlanId];
  if (plan) return plan.name;
  return planId.charAt(0).toUpperCase() + planId.slice(1);
}

// ---------------------------------------------------------------------------
// Helper: resolve the EFFECTIVE limits for a specific workspace.
//
// Two protections stack on top of the base plan, both user-level so they follow
// an owner into every workspace they own:
//
//   compedScale       a permanent comped grant: Team features, no action ceiling.
//   unlimitedInboxes  the 2026-08-19 repricing grandfather: every user who
//                     existed before the change keeps unlimited inboxes for
//                     free, permanently, on whatever plan they are on.
//
// And one workspace-level protection that applies to Pro only:
//
//   proUnlimitedInboxes  the 2026-10 Pro cap cutover: a workspace on Pro at the
//                        cutover keeps unlimited inboxes while it stays on Pro
//                        (effective_workspace_plan().pro_unlimited_inboxes,
//                        which is also true for everyone when the kill switch
//                        is off). It does nothing on any other plan, so it
//                        cannot widen Free or Personal.
//
// The historical `workspaces.grandfathered` flag is deliberately not consulted:
// it marks only the 7 accounts from the August 3rd migration, not this cohort.
// ---------------------------------------------------------------------------
export function resolvePlanLimits(
  planId: string,
  opts?: {
    compedScale?: boolean;
    unlimitedInboxes?: boolean;
    proUnlimitedInboxes?: boolean;
  },
): PlanLimits {
  const base = getPlanLimits(opts?.compedScale ? 'pro' : planId);
  const needsComp = Boolean(opts?.compedScale);
  const needsInboxes =
    Boolean(opts?.unlimitedInboxes) ||
    (planId === 'solo' && !needsComp && Boolean(opts?.proUnlimitedInboxes));
  if (!needsComp && !needsInboxes) return base;
  return {
    ...base,
    ...(needsComp ? { maxMonthlyToolCalls: Infinity } : {}),
    ...(needsInboxes ? { maxInboxes: Infinity } : {}),
  };
}

// ---------------------------------------------------------------------------
// Helper: resolve a Stripe price ID to its plan and interval.
// Used in the webhook handler to map incoming subscription events to plans.
//
// Current prices are matched first, then retired prices that pre-date the
// 2026-08-19 repricing. A legacy yearly id is detected by its position in the
// list, so each plan lists monthly before yearly.
//
// Returns null for an unknown, archived, or unconfigured price (rather than
// throwing) so the webhook can log-and-continue without crashing.
// ---------------------------------------------------------------------------
export function getPlanByStripePriceId(
  priceId: string | null | undefined,
): { plan: Plan; interval: BillingInterval } | null {
  if (!priceId || typeof priceId !== 'string') {
    return null;
  }
  for (const plan of Object.values(PLANS)) {
    if (plan.stripePriceIdMonthly && plan.stripePriceIdMonthly === priceId) {
      return { plan, interval: 'month' };
    }
    if (plan.stripePriceIdYearly && plan.stripePriceIdYearly === priceId) {
      return { plan, interval: 'year' };
    }
  }
  for (const plan of Object.values(PLANS)) {
    const idx = plan.legacyStripePriceIds.indexOf(priceId);
    if (idx !== -1) {
      // Legacy ids are listed monthly-then-yearly in pairs.
      return { plan, interval: idx % 2 === 0 ? 'month' : 'year' };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helper: the price an in-place Pro interval switch should move to, for a
// subscriber who keeps a price Pro no longer sells.
//
// The Pro price change promises everyone subscribed before the cutover that
// they keep $15 / $144 for as long as the subscription stays active, including
// across a monthly / yearly switch. Checkout would otherwise quote the sold
// $182.40 to a $15 monthly subscriber moving to yearly. So: when the current
// price is one half of the retained pair and the target is Pro, the target is
// the other half of that same pair.
//
// Null in every other case (another plan, a sold price, an unset half), which
// leaves checkout on the sold price exactly as before.
// ---------------------------------------------------------------------------
export function retainedPriceGenerationId(
  currentPriceId: string | null | undefined,
  targetPlanId: PlanId,
  targetInterval: BillingInterval,
  retainedPair: readonly string[] = PRO_PRICE_CHANGE.priceLive ? PRO_RETAINED_PAIR : [],
): string | null {
  if (targetPlanId !== 'solo' || !currentPriceId) return null;
  if (!retainedPair.includes(currentPriceId)) return null;
  const target = retainedPair[targetInterval === 'year' ? 1 : 0];
  return target || null;
}

// ---------------------------------------------------------------------------
// The Business per-mailbox add-on.
//
// A Business subscription carries TWO items: the plan's base price (quantity
// 1) and, once the owner connects more than BUSINESS_INCLUDED_INBOXES
// mailboxes across their workspaces, the per-mailbox price with quantity =
// the mailboxes above that. The add-on is not a plan: getPlanByStripePriceId
// returns null for it, and every reader that used to take `items.data[0]` as
// "the plan" must take `basePlanItem(items)` instead, because Stripe does not
// promise the base item comes first.
//
// The ids are read at call time rather than at module load, so a test can set
// them after import.
// ---------------------------------------------------------------------------
export function mailboxAddonPriceId(interval: BillingInterval): string | null {
  const raw =
    interval === 'year'
      ? process.env.STRIPE_PRICE_BUSINESS_MAILBOX_YEARLY
      : process.env.STRIPE_PRICE_BUSINESS_MAILBOX_MONTHLY;
  return raw?.trim() || null;
}

/** The interval of an add-on price id, or null when the id is not one. */
export function mailboxAddonInterval(
  priceId: string | null | undefined,
): BillingInterval | null {
  if (!priceId) return null;
  if (priceId === mailboxAddonPriceId('month')) return 'month';
  if (priceId === mailboxAddonPriceId('year')) return 'year';
  return null;
}

export function isMailboxAddonPriceId(priceId: string | null | undefined): boolean {
  return mailboxAddonInterval(priceId) !== null;
}

/** Mailboxes billed on top of the Business base price. Never negative. */
export function extraMailboxQuantity(connectedInboxes: number): number {
  const count = Number.isFinite(connectedInboxes) ? Math.floor(connectedInboxes) : 0;
  return Math.max(0, count - BUSINESS_INCLUDED_INBOXES);
}

/**
 * The subscription item that carries the PLAN: the first item whose price maps
 * to a catalogue plan, else the first item that is not the mailbox add-on,
 * else the first item. The fallbacks keep an unmapped legacy price behaving
 * exactly as `items[0]` did before the add-on existed.
 */
export function basePlanItem<T extends { price?: { id?: string | null } | null }>(
  items: readonly T[] | null | undefined,
): T | undefined {
  const list = items ?? [];
  return (
    list.find((item) => getPlanByStripePriceId(item.price?.id ?? null) !== null) ??
    list.find((item) => !isMailboxAddonPriceId(item.price?.id ?? null)) ??
    list[0]
  );
}

/** The add-on item, when the subscription has one. */
export function mailboxAddonItem<T extends { price?: { id?: string | null } | null }>(
  items: readonly T[] | null | undefined,
): T | undefined {
  return (items ?? []).find((item) => isMailboxAddonPriceId(item.price?.id ?? null));
}

// ---------------------------------------------------------------------------
// Helper: the one total order over (plan, interval) pairs.
//
// This is what decides whether an in-place plan change was an UPGRADE or a
// DOWNGRADE, and it exists because neither half of the pair can answer that on
// its own. It is deliberately NOT a comparison of what the two prices bill over
// a year: every annual price in the catalogue is discounted (Personal is $86.40
// a year against $108 of monthlies), so by yearly revenue a customer committing to
// twelve months up front would be recorded as contracting. Nobody means that by
// "downgrade".
//
// TIER FIRST, then commitment length. Moving up a tier is an upgrade at any
// interval; at the same tier, a year is more than a month. So:
//
//   personal/month -> personal/year : upgrade (same tier, longer commitment)
//   personal/year  -> solo/month    : upgrade (a tier up beats an interval down)
//   pro/month      -> solo/year     : downgrade (a tier down is a tier down)
//
// The tier order is read off the catalogue rather than written out, so adding
// or repricing a plan reorders it without a second place to remember.
// ---------------------------------------------------------------------------
const TIER_ORDER: readonly PlanId[] = (Object.keys(PLANS) as PlanId[]).sort(
  (a, b) => PLANS[a].monthlyPriceCents - PLANS[b].monthlyPriceCents,
);

export function planCommitmentRank(
  planId: PlanId,
  interval: BillingInterval,
): number {
  // Doubled so the interval can never reach across a tier boundary.
  return TIER_ORDER.indexOf(planId) * 2 + (interval === 'year' ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Helper: get or create a Stripe Customer for a workspace.
// Idempotent: returns the existing customer ID if already stored.
// Call only from server-side code (Route Handlers / Server Actions).
// ---------------------------------------------------------------------------
export type GetOrCreateCustomerResult =
  | { customerId: string; created: false }
  | { customerId: string; created: true };

// The actual implementation lives in @/lib/stripe/customer.ts to keep this
// file free of Supabase imports (plans.ts is imported in both server and
// build-time contexts such as the pricing page).
