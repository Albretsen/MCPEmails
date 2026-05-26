/**
 * Stripe plan definitions for MCPEmails.
 *
 * Defines the Free, Solo, Pro, and Enterprise tiers with their feature limits
 * and Stripe price IDs. Price IDs are loaded from environment variables so
 * they can differ between test and production environments without code changes.
 *
 * After creating products and prices in the Stripe dashboard (or via the
 * setup script), copy the price IDs into your .env.local:
 *
 *   STRIPE_PRICE_SOLO_MONTHLY=price_...
 *   STRIPE_PRICE_SOLO_YEARLY=price_...
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
export type PlanId = 'free' | 'solo' | 'pro' | 'enterprise';

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
  /**
   * Maximum MCP tool calls in any single UTC calendar day (burst cap).
   * Prevents a single day spike from exhausting the monthly quota.
   */
  maxDailyBurstCalls: number;
  /** Maximum MCP tool calls per UTC calendar month. */
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
    description: 'For personal projects and experimenting with MCP agents.',
    limits: {
      maxInboxes: 1,
      maxDailyBurstCalls: 100,
      maxMonthlyToolCalls: 500,
      maxApiKeys: 1,
      billingPortalEnabled: false,
      analyticsEnabled: false,
    },
    monthlyPriceCents: 0,
    yearlyPriceCents: 0,
    stripePriceIdMonthly: null,
    stripePriceIdYearly: null,
    features: [
      '1 connected inbox',
      '500 MCP tool calls / month',
      '100 calls / day burst cap',
      '1 API key',
      'Gmail, Outlook, Fastmail & IMAP',
      'Community support',
    ],
    highlighted: false,
  },

  solo: {
    id: 'solo',
    name: 'Solo',
    description: 'For solo developers who want their agent working the inbox daily.',
    limits: {
      maxInboxes: 3,
      maxDailyBurstCalls: 500,
      maxMonthlyToolCalls: 3_000,
      maxApiKeys: 3,
      billingPortalEnabled: true,
      analyticsEnabled: false,
    },
    monthlyPriceCents: 900,   // $9 / month
    yearlyPriceCents: 8400,   // $84 / year ($7/mo, ~22% off)
    stripePriceIdMonthly: process.env.STRIPE_PRICE_SOLO_MONTHLY ?? null,
    stripePriceIdYearly: process.env.STRIPE_PRICE_SOLO_YEARLY ?? null,
    features: [
      '3 connected inboxes',
      '3,000 MCP tool calls / month',
      '500 calls / day burst cap',
      '3 API keys',
      'Gmail, Outlook, Fastmail & IMAP',
      '14-day free trial',
      'Email support',
    ],
    highlighted: false,
  },

  pro: {
    id: 'pro',
    name: 'Pro',
    description: 'For teams shipping agents that work the inbox every day.',
    limits: {
      maxInboxes: 10,
      maxDailyBurstCalls: 2_000,
      maxMonthlyToolCalls: 20_000,
      maxApiKeys: 10,
      billingPortalEnabled: true,
      analyticsEnabled: true,
    },
    monthlyPriceCents: 2900,   // $29 / month
    yearlyPriceCents: 27600,   // $276 / year ($23/mo, ~21% off)
    stripePriceIdMonthly: process.env.STRIPE_PRICE_PRO_MONTHLY ?? null,
    stripePriceIdYearly: process.env.STRIPE_PRICE_PRO_YEARLY ?? null,
    features: [
      '10 connected inboxes',
      '20,000 MCP tool calls / month',
      '2,000 calls / day burst cap',
      '10 API keys',
      'Gmail, Outlook, Fastmail & IMAP',
      'Usage analytics dashboard',
      '14-day free trial',
      'Email support',
    ],
    highlighted: true,
  },

  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    description: 'For organisations needing unlimited scale and compliance guarantees.',
    limits: {
      maxInboxes: Infinity,
      maxDailyBurstCalls: Infinity,
      maxMonthlyToolCalls: Infinity,
      maxApiKeys: Infinity,
      billingPortalEnabled: true,
      analyticsEnabled: true,
    },
    monthlyPriceCents: 0,   // custom — contact sales
    yearlyPriceCents: null,
    stripePriceIdMonthly: process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY ?? null,
    stripePriceIdYearly: process.env.STRIPE_PRICE_ENTERPRISE_YEARLY ?? null,
    features: [
      'Unlimited inboxes',
      'Custom MCP call volume',
      'Unlimited API keys',
      'Advanced usage analytics',
      'Audit log + SSO / SAML',
      'Custom data residency (EU / US)',
      'Dedicated Slack support',
      'Custom SLA',
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
