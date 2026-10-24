/**
 * Referral rewards as Stripe customer balance credit.
 *
 * A negative balance transaction is credit that Stripe applies to the
 * customer's next invoice by itself. It is a fixed USD amount (every price we
 * sell is USD, Adaptive Pricing included), it stacks, and it sits in Stripe's
 * ledger with our metadata for the bookkeeping export.
 *
 * The Stripe client is a parameter so tests pass a fake; production passes
 * `stripe` from src/lib/stripe/client.ts. Both writes carry an idempotency key
 * derived from the referral and side, so a retried dispatch can never credit
 * or claw back twice.
 */

import type { stripe as stripeClient } from '../stripe/client.ts';
import { PLANS, type PlanId } from '../stripe/plans.ts';

type StripeClient = typeof stripeClient;

/** The slice of the Stripe client these helpers call. */
export interface ReferralStripe {
  customers: Pick<StripeClient['customers'], 'createBalanceTransaction' | 'retrieve'>;
}

export type RewardSide = 'referrer' | 'friend';

export const REFERRAL_PROGRAM = 'referral_v1';
export const REFERRAL_CREDIT_DESCRIPTION = 'Referral reward: one free month';
export const REFERRAL_CLAWBACK_DESCRIPTION = 'Referral reward reversed';

/**
 * One month of a plan at today's list price for new customers, in USD cents,
 * or null when the plan has nothing to credit (Free, or a slug we do not
 * sell). An annual subscriber gets the MONTHLY price, never a twelfth of the
 * annual one.
 *
 * Read from `PLANS[slug].monthlyPriceCents`, the number every pricing surface
 * quotes. It is already switched: Personal is the _V2 $9 price, Pro (`solo`)
 * follows PRO_PRICE_CHANGE.priceLive ($15 today, $19 once live), Business
 * (`pro`) is the $39 base without extra mailboxes. A customer still billed on
 * a retired, cheaper price gets the current list price: the reward is "one
 * month of your plan as we sell it", not a refund of what they paid.
 */
export function monthlyListPriceCents(planSlug: string): number | null {
  if (!Object.prototype.hasOwnProperty.call(PLANS, planSlug)) return null;
  const cents = PLANS[planSlug as PlanId].monthlyPriceCents;
  return cents > 0 ? cents : null;
}

function assertPositiveCents(amountCents: number, label: string): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`${label}: amountCents must be a positive integer, got ${amountCents}`);
  }
}

export async function issueReferralCredit(
  stripe: ReferralStripe,
  input: { customerId: string; referralId: string; side: RewardSide; amountCents: number },
): Promise<{ id: string }> {
  assertPositiveCents(input.amountCents, 'issueReferralCredit');
  const txn = await stripe.customers.createBalanceTransaction(
    input.customerId,
    {
      amount: -input.amountCents,
      currency: 'usd',
      description: REFERRAL_CREDIT_DESCRIPTION,
      metadata: { referral_id: input.referralId, side: input.side, program: REFERRAL_PROGRAM },
    },
    { idempotencyKey: `referral:${input.referralId}:${input.side}` },
  );
  return { id: txn.id };
}

/**
 * Take back up to `maxCents` of a reward after a refund or dispute. Only what
 * is still unspent is reversed: the clawback is capped at the customer's
 * remaining credit (the negative part of `balance`), so it never leaves them
 * owing money. Returns null, and writes nothing, when there is no credit left.
 */
export async function clawbackReferralCredit(
  stripe: ReferralStripe,
  input: { customerId: string; referralId: string; side: RewardSide; maxCents: number },
): Promise<{ id: string; amountCents: number } | null> {
  if (!Number.isFinite(input.maxCents) || input.maxCents <= 0) return null;
  const customer = await stripe.customers.retrieve(input.customerId);
  if ('deleted' in customer && customer.deleted) return null;
  const balance = typeof customer.balance === 'number' ? customer.balance : 0;
  const remainingCredit = balance < 0 ? -balance : 0;
  const amountCents = Math.min(Math.floor(input.maxCents), remainingCredit);
  if (amountCents <= 0) return null;
  const txn = await stripe.customers.createBalanceTransaction(
    input.customerId,
    {
      amount: amountCents,
      currency: 'usd',
      description: REFERRAL_CLAWBACK_DESCRIPTION,
      metadata: {
        referral_id: input.referralId,
        side: `clawback_${input.side}`,
        program: REFERRAL_PROGRAM,
      },
    },
    { idempotencyKey: `referral:${input.referralId}:clawback_${input.side}` },
  );
  return { id: txn.id, amountCents };
}
