/**
 * Stripe plan definitions for MCPEmails.
 *
 * Defines the Free, Pro, and Enterprise tiers with their feature limits and
 * Stripe price IDs. Price IDs are loaded from environment variables so they
 * can differ between test and production environments without code changes.
 *
 * After creating products and prices in the Stripe dashboard (or via the
 * setup script), copy the price IDs into your .env.local:
 *
 *   STRIPE_PRICE_PRO_MONTHLY=price_...
 *   STRIPE_PRICE_PRO_YEARLY=price_...
 *   STRIPE_PRICE_ENTERPRISE_MONTHLY=price_...
 *   STRIPE_PRICE_ENTERPRISE_YEARLY=price_...
 *
 * See Documents/Human-Input/STRIPE_SETUP_NEEDED.md for step-by-step instructions.
 */

// ---------------------------------------------------------------------------
// Plan identifiers — must match the `plan` column values in `workspaces`.
// ---------------------------------------------------------------------------
export type PlanId = 'free' | 'pro' | 'enterprise';

// ---------------------------------------------------------------------------
// Billing interval
// ---------------------------------------------------------------------------
export type BillingInterval = 'month' | 'year';

// ---------------------------------------------------------------------------
// Feature limits per plan
// ---------------------------------------------------------------------------
export interface PlanLimits {
  /** Maximum connected inboxes per workspace. */
  maxInboxes: number;
  /** Maximum MCP tool calls per day. */
  maxDailyToolCalls: number;
  /** Maximum MCP tool calls per month. */
  maxMonthlyToolCalls: number;
  /** Maximum API keys per workspace. */
  maxApiKeys: number;
  /** Whether the customer portal (billing self-service) is available. */
  billingPortalEnabled: boolean;
  /** Whether the usage analytics page is available. */
  analyticsEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Plan definition
// ---------------------------------------------------------------------------
export interface Plan {
  id: PlanId;
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
    description: 'Get started connecting your email to AI agents.',
    limits: {
      maxInboxes: 1,
      maxDailyToolCalls: 100,
      maxMonthlyToolCalls: 1_000,
      maxApiKeys: 2,
      billingPortalEnabled: false,
      analyticsEnabled: false,
    },
    monthlyPriceCents: 0,
    yearlyPriceCents: 0,
    stripePriceIdMonthly: null,
    stripePriceIdYearly: null,
    features: [
      '1 connected inbox',
      '1,000 MCP tool calls / month',
      '2 API keys',
      'Gmail, Outlook & Fastmail support',
      'Community support',
    ],
    highlighted: false,
  },

  pro: {
    id: 'pro',
    name: 'Pro',
    description: 'For power users and small teams who rely on email automation.',
    limits: {
      maxInboxes: 5,
      maxDailyToolCalls: 1_000,
      maxMonthlyToolCalls: 20_000,
      maxApiKeys: 10,
      billingPortalEnabled: true,
      analyticsEnabled: true,
    },
    monthlyPriceCents: 1900, // $19 / month
    yearlyPriceCents: 18240, // $152 / year (~20% off)
    stripePriceIdMonthly: process.env.STRIPE_PRICE_PRO_MONTHLY ?? null,
    stripePriceIdYearly: process.env.STRIPE_PRICE_PRO_YEARLY ?? null,
    features: [
      '5 connected inboxes',
      '20,000 MCP tool calls / month',
      '10 API keys',
      'Usage analytics dashboard',
      'Billing self-service portal',
      'Email support',
    ],
    highlighted: true,
  },

  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    description: 'Unlimited scale for teams with advanced compliance needs.',
    limits: {
      maxInboxes: Infinity,
      maxDailyToolCalls: Infinity,
      maxMonthlyToolCalls: Infinity,
      maxApiKeys: Infinity,
      billingPortalEnabled: true,
      analyticsEnabled: true,
    },
    monthlyPriceCents: 9900, // $99 / month
    yearlyPriceCents: 95040, // $792 / year (~20% off)
    stripePriceIdMonthly: process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY ?? null,
    stripePriceIdYearly: process.env.STRIPE_PRICE_ENTERPRISE_YEARLY ?? null,
    features: [
      'Unlimited inboxes',
      'Unlimited MCP tool calls',
      'Unlimited API keys',
      'Advanced usage analytics',
      'Priority support',
      'Custom SLA',
      'SSO / SAML (on request)',
    ],
    highlighted: false,
  },
} as const;

// ---------------------------------------------------------------------------
// Helper: look up limits for a plan name stored in DB.
// Falls back to 'free' limits if an unrecognised value is encountered.
// ---------------------------------------------------------------------------
export function getPlanLimits(planId: string): PlanLimits {
  const plan = PLANS[planId as PlanId];
  return plan?.limits ?? PLANS.free.limits;
}

// ---------------------------------------------------------------------------
// Helper: resolve a Stripe price ID to its plan and interval.
// Used in the webhook handler to map incoming subscription events to plans.
// ---------------------------------------------------------------------------
export function getPlanByStripePriceId(
  priceId: string,
): { plan: Plan; interval: BillingInterval } | null {
  for (const plan of Object.values(PLANS)) {
    if (plan.stripePriceIdMonthly === priceId) {
      return { plan, interval: 'month' };
    }
    if (plan.stripePriceIdYearly === priceId) {
      return { plan, interval: 'year' };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helper: get or create a Stripe Customer for a workspace.
// Idempotent — returns the existing customer ID if already stored.
// Call only from server-side code (Route Handlers / Server Actions).
// ---------------------------------------------------------------------------
export type GetOrCreateCustomerResult =
  | { customerId: string; created: false }
  | { customerId: string; created: true };

// The actual implementation lives in @/lib/stripe/customer.ts to keep this
// file free of Supabase imports (plans.ts is imported in both server and
// build-time contexts such as the pricing page).
