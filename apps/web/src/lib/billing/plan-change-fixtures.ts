/**
 * TEST SUPPORT ONLY. Price ids and a subscription builder shared by the pause
 * and downgrade tests. Call `setPlanChangeTestPrices()` BEFORE importing
 * anything that loads src/lib/stripe/plans.ts: the catalogue reads price ids
 * from the environment at load time.
 */

export const PRICES = {
  personalMonth: 'price_test_personal_m',
  personalYear: 'price_test_personal_y',
  proMonth: 'price_test_pro_m',
  proYear: 'price_test_pro_y',
  businessMonth: 'price_test_business_m',
} as const;

export function setPlanChangeTestPrices(): void {
  process.env.STRIPE_PRICE_PERSONAL_MONTHLY_V2 = PRICES.personalMonth;
  process.env.STRIPE_PRICE_PERSONAL_YEARLY_V2 = PRICES.personalYear;
  process.env.STRIPE_PRICE_SOLO_MONTHLY = PRICES.proMonth;
  process.env.STRIPE_PRICE_SOLO_YEARLY = PRICES.proYear;
  process.env.STRIPE_PRICE_SOLO_MONTHLY_V2 = PRICES.proMonth;
  process.env.STRIPE_PRICE_SOLO_YEARLY_V2 = PRICES.proYear;
  process.env.STRIPE_PRICE_BUSINESS_MONTHLY = PRICES.businessMonth;
}

/** Unix seconds for an ISO date. */
export function sec(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

export interface FixtureOptions {
  price?: string;
  status?: string;
  periodStart?: string;
  periodEnd?: string;
  anchor?: string;
  metadata?: Record<string, string>;
  pauseResumesAt?: number | null;
  cancelAt?: number | null;
  cancelAtPeriodEnd?: boolean;
  amount?: number;
  extraItem?: boolean;
  customer?: string;
  id?: string;
}

/** A Stripe-shaped subscription with one plan item (two with `extraItem`). */
export function subscriptionFixture(options: FixtureOptions = {}) {
  const price = options.price ?? PRICES.proMonth;
  const items = [
    {
      id: 'si_plan',
      price: {
        id: price,
        unit_amount: options.amount ?? 1500,
        recurring: { interval: price.endsWith('_y') ? 'year' : 'month', interval_count: 1 },
      },
      quantity: 1,
      current_period_start: sec(options.periodStart ?? '2026-10-10T12:00:00Z'),
      current_period_end: sec(options.periodEnd ?? '2026-11-10T12:00:00Z'),
    },
  ];
  if (options.extraItem) {
    items.push({ ...items[0], id: 'si_extra', price: { ...items[0].price, id: 'price_test_addon' } });
  }
  return {
    id: options.id ?? 'sub_test',
    object: 'subscription' as const,
    customer: options.customer ?? 'cus_test',
    status: options.status ?? 'active',
    currency: 'usd',
    billing_cycle_anchor: sec(options.anchor ?? options.periodStart ?? '2026-10-10T12:00:00Z'),
    cancel_at: options.cancelAt ?? null,
    cancel_at_period_end: options.cancelAtPeriodEnd ?? false,
    canceled_at: null,
    ended_at: null,
    created: sec('2026-06-10T12:00:00Z'),
    pause_collection:
      options.pauseResumesAt !== undefined && options.pauseResumesAt !== null
        ? { behavior: 'void' as const, resumes_at: options.pauseResumesAt }
        : null,
    metadata: { user_id: 'user-owner', ...(options.metadata ?? {}) },
    items: { object: 'list' as const, data: items },
  };
}
