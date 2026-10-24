/**
 * The referral half of the Stripe webhook (app/api/stripe/webhook/route.ts).
 *
 *   invoice.payment_succeeded   the friend's FIRST paid subscription invoice
 *                               (billing_reason 'subscription_create', at least
 *                               MIN_CHARGE_CENTS) moves their referral from
 *                               'attached' to 'charged' and starts the 14 days.
 *   charge.refunded             before qualification: 'voided'. After it: the
 *   charge.dispute.created      unspent part of each Stripe credit is clawed
 *                               back and the referral is 'voided'.
 *
 * A partial refund voids a referral that has not qualified yet (the dispatcher
 * would void it anyway), but claws back nothing once it has: a goodwill refund
 * of a few dollars does not undo a month someone earned. A full refund or any
 * dispute does. A Personal month already granted is not shortened; there is
 * no way to take back days of service, and the cap bounds the exposure.
 *
 * Idempotent per event: the charged update filters on status 'attached', the
 * void on the pre-reward statuses, and each clawback is a unique
 * (referral_id, clawback_<side>) row plus a Stripe idempotency key.
 */

import type Stripe from 'stripe';

import { MIN_CHARGE_CENTS, QUALIFY_DAYS } from './constants.ts';
import { clawbackReferralCredit, creditCurrency, type RewardSide } from './stripe-credit.ts';
import { recordReferralEvent, referralsEnabledForOwner, type Db, type ReferralStripeApi } from './server.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

function idOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}

/**
 * The charge behind a paid invoice. The live endpoint is pinned to an older
 * API version than the SDK, so the payload's `charge` is tried first (free);
 * on the SDK's own version the charge sits under invoice.payments, which has
 * to be expanded (see invoiceDeclineCode in the webhook for the same dance).
 */
export async function chargeIdForInvoice(
  stripe: ReferralStripeApi,
  invoice: Stripe.Invoice,
): Promise<string | null> {
  const direct = idOf((invoice as unknown as { charge?: unknown }).charge);
  if (direct) return direct;
  if (!invoice.id) return null;
  const full = await stripe.invoices.retrieve(invoice.id, {
    expand: ['payments.data.payment.payment_intent'],
  });
  const payments = (full as unknown as { payments?: { data?: unknown[] } }).payments;
  for (const entry of payments?.data ?? []) {
    const payment = (entry as { payment?: Record<string, unknown> }).payment;
    const charge = idOf(payment?.charge);
    if (charge) return charge;
    const intent = payment?.payment_intent;
    if (intent && typeof intent === 'object') {
      const latest = idOf((intent as { latest_charge?: unknown }).latest_charge);
      if (latest) return latest;
    }
  }
  return null;
}

/** invoice.payment_succeeded. Never throws for a non-referral invoice. */
export async function recordReferralCharge(
  db: Db,
  stripe: ReferralStripeApi,
  invoice: Stripe.Invoice,
  friendUserId: string | null,
  now: Date = new Date(),
): Promise<'charged' | 'skipped'> {
  if (invoice.billing_reason !== 'subscription_create') return 'skipped';
  if ((invoice.amount_paid ?? 0) < MIN_CHARGE_CENTS) return 'skipped';
  if (!friendUserId) return 'skipped';

  const { data: referral, error } = await db
    .from('referrals')
    .select('id, referrer_user_id, friend_workspace_id, status')
    .eq('friend_user_id', friendUserId)
    .eq('status', 'attached')
    .maybeSingle();
  if (error) throw new Error(`referrals read failed: ${error.message}`);
  if (!referral) return 'skipped';
  if (!(await referralsEnabledForOwner(db, referral.referrer_user_id))) return 'skipped';

  const chargeId = await chargeIdForInvoice(stripe, invoice);
  const paidAtSeconds = invoice.status_transitions?.paid_at ?? null;
  const chargedAt = paidAtSeconds ? new Date(paidAtSeconds * 1000) : now;

  const { data: updated, error: updateError } = await db
    .from('referrals')
    .update({
      status: 'charged',
      first_invoice_id: invoice.id ?? null,
      first_charge_id: chargeId,
      first_charge_at: chargedAt.toISOString(),
      qualifies_at: new Date(chargedAt.getTime() + QUALIFY_DAYS * DAY_MS).toISOString(),
    })
    .eq('id', referral.id)
    .eq('status', 'attached')
    .select('id');
  if (updateError) throw new Error(`referrals update failed: ${updateError.message}`);
  if ((updated ?? []).length === 0) return 'skipped';

  await recordReferralEvent(db, referral.friend_workspace_id, 'referral_charged');
  return 'charged';
}

const BEFORE_REWARD = ['charged', 'held'];
const AFTER_REWARD = ['qualified', 'capped'];

export type ReversalKind = 'refund' | 'dispute';

/**
 * charge.refunded / charge.dispute.created for the friend's first charge.
 * Throws on a database or Stripe failure so the webhook answers 500 and
 * Stripe redelivers; every step is safe to repeat.
 */
export async function reverseReferralCharge(
  db: Db,
  stripe: ReferralStripeApi,
  input: { chargeId: string; kind: ReversalKind; fullyRefunded: boolean },
): Promise<'voided' | 'clawed_back' | 'skipped'> {
  const { data: referral, error } = await db
    .from('referrals')
    .select('id, status, friend_workspace_id')
    .eq('first_charge_id', input.chargeId)
    .maybeSingle();
  if (error) throw new Error(`referrals read failed: ${error.message}`);
  if (!referral) return 'skipped';

  const reason = input.kind === 'dispute' ? 'disputed' : input.fullyRefunded ? 'refunded' : 'partially_refunded';

  if (BEFORE_REWARD.includes(referral.status)) {
    const { error: voidError } = await db
      .from('referrals')
      .update({ status: 'voided', void_reason: reason, ip_hash: null })
      .eq('id', referral.id)
      .in('status', BEFORE_REWARD);
    if (voidError) throw new Error(`referrals void failed: ${voidError.message}`);
    await recordReferralEvent(db, referral.friend_workspace_id, 'referral_voided', { failure: true });
    return 'voided';
  }

  if (!AFTER_REWARD.includes(referral.status)) return 'skipped';
  if (input.kind === 'refund' && !input.fullyRefunded) return 'skipped';

  const { data: rewards, error: rewardsError } = await db
    .from('referral_rewards')
    .select('side, kind, amount_cents, currency, stripe_customer_id, stripe_balance_txn_id')
    .eq('referral_id', referral.id);
  if (rewardsError) throw new Error(`referral_rewards read failed: ${rewardsError.message}`);
  const rows = rewards ?? [];
  const done = new Set(rows.map((r) => r.side));

  for (const reward of rows) {
    if (reward.kind !== 'stripe_credit') continue;
    if (reward.side !== 'referrer' && reward.side !== 'friend') continue;
    const side = reward.side as RewardSide;
    if (done.has(`clawback_${side}`)) continue;
    if (!reward.stripe_customer_id || !reward.stripe_balance_txn_id || !reward.amount_cents) continue;
    // The clawback is written in the currency the credit was issued in.
    const currency = creditCurrency(reward.currency);
    if (!currency) {
      console.error('[referrals] clawback skipped: reward currency is not one we credit in; reverse it by hand', {
        referral: referral.id,
        side,
      });
      continue;
    }
    const clawed = await clawbackReferralCredit(stripe, {
      customerId: reward.stripe_customer_id,
      referralId: referral.id,
      side,
      maxCents: reward.amount_cents,
      currency,
    });
    const { error: insertError } = await db.from('referral_rewards').insert({
      referral_id: referral.id,
      side: `clawback_${side}`,
      kind: 'stripe_credit',
      amount_cents: clawed?.amountCents ?? 0,
      currency,
      stripe_customer_id: reward.stripe_customer_id,
      stripe_balance_txn_id: clawed?.id ?? null,
    });
    if (insertError && insertError.code !== '23505') {
      throw new Error(`referral_rewards clawback insert failed: ${insertError.message}`);
    }
  }

  const { error: voidError } = await db
    .from('referrals')
    .update({ status: 'voided', void_reason: `${reason}_after_reward` })
    .eq('id', referral.id);
  if (voidError) throw new Error(`referrals void failed: ${voidError.message}`);
  await recordReferralEvent(db, referral.friend_workspace_id, 'referral_voided', { failure: true });
  return 'clawed_back';
}
