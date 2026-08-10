/**
 * Stripe plan definitions for MCPEmails.
 *
 * Pricing strategy: every tier includes unlimited inboxes and API keys. A
 * successful billable MCP operation consumes an action from the plan's billing
 * period allowance; failed calls and inbox_list do not consume actions.
 *
 * Three tiers: Free, Agent, Scale. (The "Scale" tier keeps the internal id
 * `pro` to avoid a workspaces.plan data migration; only its display name is
 * "Scale".)
 *
 * Price IDs are loaded from environment variables so they can differ between
 * test and production without code changes:
 *
 *   STRIPE_PRICE_SOLO_MONTHLY=price_...
 *   STRIPE_PRICE_SOLO_YEARLY=price_...
 *   STRIPE_PRICE_PRO_MONTHLY=price_...   (Scale)
 *   STRIPE_PRICE_PRO_YEARLY=price_...    (Scale)
 *
 * See Documents/pricing-strategy.md for the full strategy.
 */

// ---------------------------------------------------------------------------
// Plan identifiers: must match the `plan` column values in `workspaces`.
// `pro` is the internal id for the "Scale" tier (display name only).
// ---------------------------------------------------------------------------
export type PlanId = 'free' | 'solo' | 'pro';

// ---------------------------------------------------------------------------
// Billing interval
// ---------------------------------------------------------------------------
export type BillingInterval = 'month' | 'year';

// ---------------------------------------------------------------------------
// Support tiers
// ---------------------------------------------------------------------------
export type SupportTier = 'community' | 'email' | 'priority';

// ---------------------------------------------------------------------------
// Feature limits per plan
//
// Inboxes and API keys are unlimited. Monthly tool calls represent billable
// actions in the current billing period; the live meter and edge enforcement
// both read the versioned action_usage ledger.
// ---------------------------------------------------------------------------
export interface PlanLimits {
  /** Maximum connected inboxes. Infinity = unlimited (all tiers). */
  maxInboxes: number;
  /** Legacy daily burst cap. Infinity = unlimited (all tiers). */
  maxDailyBurstCalls: number;
  /** Billable action cap per billing period. Infinity = a comped entitlement. */
  maxMonthlyToolCalls: number;
  /** Maximum API keys. Infinity = unlimited (all tiers). */
  maxApiKeys: number;
  /** Maximum workspace members. Infinity = unlimited (all tiers). */
  maxMembers: number;
  /** Whether the customer portal (billing self-service) is available. */
  billingPortalEnabled: boolean;
  /** Whether the usage analytics page is available. */
  analyticsEnabled: boolean;

  // ── Real differentiators ────────────────────────────────────────────────
  /** Per-minute fair-use rate-limit ceiling enforced in the MCP edge function. */
  maxRequestsPerMinute: number;
  /** How many days of usage history the analytics dashboard exposes. */
  analyticsRetentionDays: number;
  /** Team roles / multiple workspaces. */
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
  /** Display name (e.g. "Scale" for the `pro` id). */
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
    description: 'Explore MCPEmails with 2,500 actions each billing period.',
    limits: {
      maxInboxes: Infinity,
      maxDailyBurstCalls: Infinity,
      maxMonthlyToolCalls: 2_500,
      maxApiKeys: Infinity,
      // Team collaboration is a paid capability: Free is single-user (owner
      // only).
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
    features: [
      'Unlimited connected inboxes',
      '2,500 actions per billing period',
      'Unlimited API keys',
      'Single user (owner only)',
      'Gmail, Fastmail & IMAP',
      'Basic usage analytics (7-day)',
      'Community support',
    ],
    highlighted: false,
  },

  solo: {
    id: 'solo',
    name: 'Agent',
    description: 'For power users running agents around the clock.',
    limits: {
      maxInboxes: Infinity,
      maxDailyBurstCalls: Infinity,
      maxMonthlyToolCalls: 50_000,
      maxApiKeys: Infinity,
      maxMembers: Infinity,
      billingPortalEnabled: true,
      analyticsEnabled: true,
      maxRequestsPerMinute: 300,
      analyticsRetentionDays: 90,
      teamRolesEnabled: false,
      ssoEnabled: false,
      auditLogEnabled: false,
      supportTier: 'email',
    },
    monthlyPriceCents: 1200,  // $12 / month
    yearlyPriceCents: 12000,  // $120 / year (~17% off)
    stripePriceIdMonthly: process.env.STRIPE_PRICE_SOLO_MONTHLY ?? null,
    stripePriceIdYearly: process.env.STRIPE_PRICE_SOLO_YEARLY ?? null,
    features: [
      '50,000 actions per billing period',
      '5× higher burst rate limit',
      'Full usage analytics (90-day history)',
      'Gmail, Fastmail & IMAP',
      'Email support',
    ],
    highlighted: false,
  },

  // "Scale" tier; internal id stays `pro`.
  pro: {
    id: 'pro',
    name: 'Scale',
    description: 'For businesses and teams. Practically limitless.',
    limits: {
      maxInboxes: Infinity,
      maxDailyBurstCalls: Infinity,
      maxMonthlyToolCalls: 300_000,
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
    monthlyPriceCents: 4900,   // $49 / month
    yearlyPriceCents: 49000,   // $490 / year (~17% off)
    stripePriceIdMonthly: process.env.STRIPE_PRICE_PRO_MONTHLY ?? null,
    stripePriceIdYearly: process.env.STRIPE_PRICE_PRO_YEARLY ?? null,
    features: [
      '300,000 actions per billing period',
      'Highest burst rate limit',
      'Team roles & multiple workspaces',
      'SSO (SAML / OIDC) + audit log',
      'Full usage analytics (1-year history)',
      'Priority support',
    ],
    highlighted: true,
  },
} as const;

// ---------------------------------------------------------------------------
// Helper: look up limits for a plan name stored in DB.
// Falls back to 'free' limits if an unrecognised value is encountered
// (this also covers any legacy 'enterprise' rows).
// ---------------------------------------------------------------------------
export function getPlanLimits(planId: string): PlanLimits {
  const plan = PLANS[planId as PlanId];
  return plan?.limits ?? PLANS.free.limits;
}

// ---------------------------------------------------------------------------
// Helper: user-facing display name for a plan slug stored in `workspaces.plan`.
//
// The DB stores internal ids ('free' | 'solo' | 'pro'); the public pricing page
// only ever shows "Free", "Agent", and "Scale" (the `pro` id's display name). Use
// this everywhere a plan is shown to a user so the dashboard never leaks the
// internal "pro" id (which read as "Pro plan" and didn't match the pricing
// page). Unknown/legacy slugs (e.g. 'enterprise') are Title-cased as a fallback.
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
// A permanent comped Scale entitlement resolves to Scale features and an
// unlimited action allowance. The historical workspaces.grandfathered flag is
// deliberately not consulted: protected access is user-level and follows an
// owner across every workspace.
// ---------------------------------------------------------------------------
export function resolvePlanLimits(
  planId: string,
  opts?: { compedScale?: boolean },
): PlanLimits {
  const base = getPlanLimits(opts?.compedScale ? 'pro' : planId);
  if (!opts?.compedScale) return base;
  return {
    ...base,
    maxMonthlyToolCalls: Infinity,
  };
}

// ---------------------------------------------------------------------------
// Helper: resolve a Stripe price ID to its plan and interval.
// Used in the webhook handler to map incoming subscription events to plans.
//
// Returns null for an unknown, archived, or unconfigured price (rather than
// throwing) so the webhook can log-and-continue without crashing. The empty /
// non-string guard prevents a falsy `priceId` from spuriously matching a plan
// whose own price-id env var is unset (and therefore also null).
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
