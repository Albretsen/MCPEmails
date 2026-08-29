/**
 * Stripe plan definitions for MCPEmails.
 *
 * PRICING STRATEGY (rebuilt 2026-08-19).
 *
 * The value metric is CONNECTED INBOXES, not actions. Inboxes are the scarce,
 * defensible asset: every workspace with two or more inboxes is active, and the
 * businesses that run three to seven mailboxes (hotels, agencies, publishers)
 * are the accounts worth pricing for. Action volume is abundant, invisible to
 * the customer, and was never reachable as a paywall, so it has been demoted to
 * a silent abuse ceiling that never appears in customer-facing copy.
 *
 * Four tiers: Free (1 inbox), Personal (3 inboxes, one person), Pro (unlimited
 * inboxes, one person), Team (unlimited inboxes, several people, separate
 * workspaces per client).
 *
 * The internal ids stay `free` / `solo` / `pro` so `workspaces.plan` needs no
 * data migration, and `personal` was added later as the only id whose display
 * name matches it. The display names are:
 *
 *   free     -> "Free"
 *   personal -> "Personal"
 *   solo     -> "Pro"    (was "Agent", before that "Solo")
 *   pro      -> "Team"   (was "Scale", before that "Team")
 *
 * Price IDs come from environment variables so test and production can differ:
 *
 *   STRIPE_PRICE_PERSONAL_MONTHLY=price_...   (Personal monthly)
 *   STRIPE_PRICE_PERSONAL_YEARLY=price_...    (Personal yearly)
 *   STRIPE_PRICE_SOLO_MONTHLY=price_...       (Pro monthly)
 *   STRIPE_PRICE_SOLO_YEARLY=price_...        (Pro yearly)
 *   STRIPE_PRICE_PRO_MONTHLY=price_...        (Team monthly)
 *   STRIPE_PRICE_PRO_YEARLY=price_...         (Team yearly)
 *
 * GRANDFATHERING. Every user who existed before the repricing keeps unlimited
 * inboxes at no cost, permanently. That protection is user-level and lives in
 * `user_usage_entitlements.unlimited_inboxes`, so it follows an owner into any
 * workspace they create later. It is resolved through `resolvePlanLimits`.
 */

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
   * SILENT ABUSE CEILING. Billable actions per billing period.
   *
   * This is deliberately NOT a pricing lever and must never appear on the
   * pricing page, in plan feature lists, in the dashboard, or in the docs. It
   * exists so a runaway or malicious agent cannot burn unbounded provider
   * quota. Every ceiling is set far above any observed real usage: the highest
   * month any external workspace has ever recorded is 3,105 actions.
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
      maxMonthlyToolCalls: 5_000,
      maxApiKeys: Infinity,
      maxMembers: 1,
      billingPortalEnabled: false,
      analyticsEnabled: true,
      maxRequestsPerMinute: 60,
      analyticsRetentionDays: 7,
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
      'Read, search, organise, draft and send',
      'Gmail, iCloud, Fastmail and any IMAP',
      'Unlimited API keys',
      'Single user',
      'Community support',
    ],
    highlighted: false,
  },

  // "Personal" tier; the only internal id that matches its display name.
  personal: {
    id: 'personal',
    name: 'Personal',
    description: 'Three mailboxes for one person: work, personal, and one more.',
    limits: {
      maxInboxes: 3,
      maxDailyBurstCalls: Infinity,
      maxMonthlyToolCalls: 25_000,
      maxApiKeys: Infinity,
      maxMembers: 1,
      billingPortalEnabled: true,
      analyticsEnabled: true,
      maxRequestsPerMinute: 120,
      analyticsRetentionDays: 30,
      teamRolesEnabled: false,
      ssoEnabled: false,
      auditLogEnabled: false,
      supportTier: 'email',
    },
    monthlyPriceCents: 500,
    yearlyPriceCents: 4800,
    stripePriceIdMonthly: process.env.STRIPE_PRICE_PERSONAL_MONTHLY ?? null,
    stripePriceIdYearly: process.env.STRIPE_PRICE_PERSONAL_YEARLY ?? null,
    legacyStripePriceIds: [],
    features: [
      '3 connected inboxes',
      'Scheduled sends and approvals',
      '2x higher burst rate limit',
      'Usage analytics',
      'Email support',
    ],
    highlighted: false,
  },

  // "Pro" tier; internal id stays `solo`.
  solo: {
    id: 'solo',
    name: 'Pro',
    description: 'Every mailbox you own, in one agent. Work, personal, and each side business.',
    limits: {
      maxInboxes: Infinity,
      maxDailyBurstCalls: Infinity,
      maxMonthlyToolCalls: 100_000,
      maxApiKeys: Infinity,
      maxMembers: 1,
      billingPortalEnabled: true,
      analyticsEnabled: true,
      maxRequestsPerMinute: 300,
      analyticsRetentionDays: 90,
      teamRolesEnabled: false,
      ssoEnabled: false,
      auditLogEnabled: false,
      supportTier: 'email',
    },
    monthlyPriceCents: 2900,
    yearlyPriceCents: 27600,
    stripePriceIdMonthly: process.env.STRIPE_PRICE_SOLO_MONTHLY ?? null,
    stripePriceIdYearly: process.env.STRIPE_PRICE_SOLO_YEARLY ?? null,
    legacyStripePriceIds: [
      'price_1TcQBDARrgumc6cqy1Z9AAEw', // Agent monthly, $12
      'price_1TcQBEARrgumc6cq6MGFktzy', // Agent yearly, $120
    ],
    features: [
      'Unlimited connected inboxes',
      'Scheduled sends and approvals',
      '5x higher burst rate limit',
      'Full usage analytics',
      'Email support',
    ],
    highlighted: true,
  },

  // "Team" tier; internal id stays `pro`.
  pro: {
    id: 'pro',
    name: 'Team',
    description: 'Shared inboxes for a team, with a separate workspace per client or business.',
    limits: {
      maxInboxes: Infinity,
      maxDailyBurstCalls: Infinity,
      maxMonthlyToolCalls: 500_000,
      maxApiKeys: Infinity,
      maxMembers: Infinity,
      billingPortalEnabled: true,
      analyticsEnabled: true,
      maxRequestsPerMinute: 1000,
      analyticsRetentionDays: 365,
      teamRolesEnabled: true,
      ssoEnabled: true,
      auditLogEnabled: true,
      supportTier: 'priority',
    },
    monthlyPriceCents: 7900,
    yearlyPriceCents: 75600,
    stripePriceIdMonthly: process.env.STRIPE_PRICE_PRO_MONTHLY ?? null,
    stripePriceIdYearly: process.env.STRIPE_PRICE_PRO_YEARLY ?? null,
    legacyStripePriceIds: [
      'price_1TcQBFARrgumc6cqmaRTXJ5Q', // Scale monthly, $49
      'price_1TcQBGARrgumc6cqmy0LeLSL', // Scale yearly, $490
      'price_1Tb0HfARrgumc6cqMeQSsMNr', // Team monthly, $19 (archived)
      'price_1Tb0HfARrgumc6cqQR33xYAN', // Team yearly, $152 (archived)
    ],
    features: [
      'Everything in Pro',
      'Unlimited members with roles',
      'A separate workspace per client or business',
      'SSO (SAML / OIDC) and audit log',
      'Full usage analytics',
      'Priority support',
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
// only ever see "Free", "Personal", "Pro", and "Team". Use this everywhere a
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
// The historical `workspaces.grandfathered` flag is deliberately not consulted:
// it marks only the 7 accounts from the August 3rd migration, not this cohort.
// ---------------------------------------------------------------------------
export function resolvePlanLimits(
  planId: string,
  opts?: { compedScale?: boolean; unlimitedInboxes?: boolean },
): PlanLimits {
  const base = getPlanLimits(opts?.compedScale ? 'pro' : planId);
  const needsComp = Boolean(opts?.compedScale);
  const needsInboxes = Boolean(opts?.unlimitedInboxes);
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
