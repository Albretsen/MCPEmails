/**
 * The daily referral dispatcher: every 'charged' referral whose 14 days are
 * up is re-checked against Stripe and either rewarded, voided or held.
 * Called by app/api/internal/referrals/dispatch/route.ts; everything it
 * touches is a parameter so the tests can run it against fakes.
 *
 * PER ROW
 *   1. The referrer's flag. Off: the row is left alone for a later run.
 *   2. The facts decideQualification (qualify.ts) needs: the friend's first
 *      charge re-read from Stripe (refunded, amount_refunded, disputed, card
 *      fingerprint), the card fingerprints on the referrer's customer, how many
 *      referrals of the same code reached 'charged' within 24 hours, whether
 *      the signup network matches, the referrer's rewards in 365 days and the
 *      friend's subscription status.
 *   3. The outcome. 'wait' changes nothing; 'voided' and 'held' set the status
 *      and reason; 'qualified' and 'capped' issue the rewards first and set
 *      the status only once they are in, so a failure leaves the row 'charged'
 *      for the next run.
 *
 * REWARDS ARE ISSUED AT MOST ONCE PER SIDE. referral_rewards is unique on
 * (referral_id, side), and the row is claimed before anything is granted.
 *   Stripe credit: the claim holds the amount; before creating a balance
 *     transaction the customer's recent ones are searched for this referral
 *     and side, so a run that died after Stripe answered never credits twice
 *     even after the 24-hour idempotency key has expired.
 *   Personal month: grant_referral_personal extends on every call, so it is
 *     called only by the run that inserted the claim; a failed call deletes
 *     the claim again.
 * A paying referrer (entitled subscription, a plan with a list price) gets
 * one month of their plan's list price as credit; anyone else gets 30 days of
 * Personal. The friend gets one month of their own plan as credit while their
 * subscription is still active.
 *
 * CURRENCY. A credit is written in the customer's billing currency (their
 * subscription's, else the customer's) at that currency's list price, and the
 * reward row stores it. A currency we do not price (anything but USD and EUR)
 * issues nothing: the referral is held with reason 'currency' for a person,
 * before either side is credited.
 *
 * RACE WITH A REFUND. The charge is read before the rewards go out, so a
 * refund or dispute webhook can void the row in between. The final status
 * write only moves a row that is still 'charged'; when it moves nothing, the
 * credits this run issued are clawed back (webhook.ts) and nobody is emailed.
 *
 * One row failing is logged and counted; the rest of the batch still runs.
 */

import type { ReferralEmailInput, ReferralEmailResult } from '@/lib/email/referral-emails';
import type { Database } from '@/types/database.types';
import { PERSONAL_MONTH_DAYS } from './constants.ts';
import { decideQualification, type QualificationDecision } from './qualify.ts';
import { clawBackReferralRewards } from './webhook.ts';
import {
  creditCurrency,
  issueReferralCredit,
  monthlyListPriceCents,
  type CreditCurrency,
  type RewardSide,
} from './stripe-credit.ts';
import {
  billingCurrency,
  billingRow,
  ENTITLED_STATUSES,
  recordReferralEvent,
  referralsEnabledForOwner,
  referrerRewardsLast365d,
  type BillingRow,
  type Db,
  type ReferralStripeApi,
} from './server.ts';

type ReferralUpdate = Database['public']['Tables']['referrals']['Update'];

const DAY_MS = 24 * 60 * 60 * 1000;
export const DISPATCH_BATCH_SIZE = 25;
const DISPATCH_BUDGET_MS = 45_000;

export interface DispatchDeps {
  db: Db;
  stripe: ReferralStripeApi;
  sendEmail: (input: ReferralEmailInput) => Promise<ReferralEmailResult>;
  /** 'deleted' accounts get no email. */
  accountState: (userId: string) => Promise<'live' | 'deleted' | 'unknown'>;
  now?: Date;
  batchSize?: number;
}

export interface DispatchSummary {
  due: number;
  qualified: number;
  capped: number;
  voided: number;
  held: number;
  waiting: number;
  skipped: number;
  failed: number;
}

interface DueRow {
  id: string;
  code: string;
  referrer_user_id: string;
  friend_user_id: string;
  friend_workspace_id: string | null;
  first_charge_id: string | null;
  first_charge_at: string | null;
  qualifies_at: string;
  ip_hash: string | null;
}

type RowOutcome = 'qualified' | 'capped' | 'voided' | 'held' | 'waiting' | 'skipped';

export async function dispatchReferrals(deps: DispatchDeps): Promise<DispatchSummary> {
  const now = deps.now ?? new Date();
  const started = Date.now();
  const summary: DispatchSummary = {
    due: 0, qualified: 0, capped: 0, voided: 0, held: 0, waiting: 0, skipped: 0, failed: 0,
  };

  const { data, error } = await deps.db
    .from('referrals')
    .select('id, code, referrer_user_id, friend_user_id, friend_workspace_id, first_charge_id, first_charge_at, qualifies_at, ip_hash')
    .eq('status', 'charged')
    .lte('qualifies_at', now.toISOString())
    .order('qualifies_at', { ascending: true })
    .limit(deps.batchSize ?? DISPATCH_BATCH_SIZE);
  if (error) throw new Error(`referrals select failed: ${error.message}`);
  const rows = (data ?? []) as DueRow[];
  summary.due = rows.length;

  for (const row of rows) {
    if (Date.now() - started > DISPATCH_BUDGET_MS) {
      console.log('[referral-dispatch] wall-clock budget reached; the rest waits for tomorrow.');
      break;
    }
    try {
      summary[await processRow(deps, row, now)] += 1;
    } catch (err) {
      summary.failed += 1;
      console.error('[referral-dispatch] row failed', {
        referral: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return summary;
}

async function processRow(deps: DispatchDeps, row: DueRow, now: Date): Promise<RowOutcome> {
  const { db, stripe } = deps;
  if (!(await referralsEnabledForOwner(db, row.referrer_user_id))) return 'skipped';

  if (!row.first_charge_id) {
    // The webhook could not tell which charge paid the first invoice. A
    // person can look it up; guessing would reward an unchecked payment.
    await setStatus(db, row, { status: 'held', hold_reason: 'charge_unknown' });
    await recordReferralEvent(db, row.friend_workspace_id, 'referral_held');
    return 'held';
  }

  const charge = await stripe.charges.retrieve(row.first_charge_id);
  const [referrerBilling, friendBilling] = await Promise.all([
    billingRow(db, row.referrer_user_id),
    billingRow(db, row.friend_user_id),
  ]);

  const decision = decideQualification({
    now,
    qualifiesAt: new Date(row.qualifies_at),
    chargeAmountCents: charge.amount,
    chargeRefunded: charge.refunded,
    chargeAmountRefunded: charge.amount_refunded,
    chargeDisputed: charge.disputed,
    friendFingerprint: charge.payment_method_details?.card?.fingerprint ?? null,
    referrerFingerprints: await cardFingerprints(stripe, referrerBilling?.stripe_customer_id ?? null),
    ipHashMatch: await ipHashMatches(db, row),
    velocityCount24h: await velocityCount(db, row),
    referrerRewardsLast365d: await referrerRewardsLast365d(db, row.referrer_user_id, now),
    friendSubscriptionActive: await subscriptionActive(stripe, friendBilling),
  });

  switch (decision.outcome) {
    case 'wait':
      return 'waiting';
    case 'voided':
      await setStatus(db, row, { status: 'voided', void_reason: decision.reason ?? null, ip_hash: null });
      await recordReferralEvent(db, row.friend_workspace_id, 'referral_voided', { failure: true });
      return 'voided';
    case 'held':
      await setStatus(db, row, { status: 'held', hold_reason: decision.reason ?? null });
      await recordReferralEvent(db, row.friend_workspace_id, 'referral_held');
      return 'held';
    default:
      return reward(deps, row, decision, referrerBilling, friendBilling, now);
  }
}

async function reward(
  deps: DispatchDeps,
  row: DueRow,
  decision: QualificationDecision,
  referrerBilling: BillingRow | null,
  friendBilling: BillingRow | null,
  now: Date,
): Promise<RowOutcome> {
  const { db, stripe } = deps;
  const emails: ReferralEmailInput[] = [];
  const emailTo: string[] = [];

  const referrerPlan = referrerBilling?.plan ?? 'free';
  const referrerPaying =
    decision.rewardReferrer &&
    referrerBilling?.stripe_customer_id != null &&
    referrerBilling.subscription_status != null &&
    ENTITLED_STATUSES.has(referrerBilling.subscription_status) &&
    monthlyListPriceCents(referrerPlan) != null;
  const friendCredited =
    decision.rewardFriend &&
    friendBilling?.stripe_customer_id != null &&
    monthlyListPriceCents(friendBilling.plan) != null;

  // Both currencies are settled before anything is issued, so an unpriced
  // currency on one side never leaves the other side half-rewarded.
  const currencyFor = async (side: RewardSide, billing: BillingRow | null): Promise<CreditCurrency | null> => {
    const claimed = creditCurrency((await readClaim(db, row.id, side))?.currency);
    if (claimed) return claimed;
    return creditCurrency(await billingCurrency(stripe, billing));
  };
  const referrerCurrency = referrerPaying ? await currencyFor('referrer', referrerBilling) : null;
  const friendCurrency = friendCredited ? await currencyFor('friend', friendBilling) : null;
  if ((referrerPaying && !referrerCurrency) || (friendCredited && !friendCurrency)) {
    console.warn('[referral-dispatch] unpriced billing currency; held for manual handling', {
      referral: row.id,
      side: referrerPaying && !referrerCurrency ? 'referrer' : 'friend',
    });
    await setStatus(db, row, { status: 'held', hold_reason: 'currency' });
    await recordReferralEvent(db, row.friend_workspace_id, 'referral_held');
    return 'held';
  }

  if (decision.rewardReferrer) {
    if (referrerPaying && referrerCurrency) {
      const amount = monthlyListPriceCents(referrerPlan, referrerCurrency) as number;
      const issued = await creditOnce(deps, row.id, 'referrer', referrerBilling?.stripe_customer_id as string, amount, referrerCurrency);
      if (issued) {
        emails.push({ template: 'referral_referrer_credit', to: '', referralId: row.id, plan: referrerPlan });
        emailTo.push(row.referrer_user_id);
      }
    } else {
      const granted = await personalMonthOnce(db, row.id, row.referrer_user_id);
      if (granted.issued && granted.until) {
        emails.push({ template: 'referral_referrer_personal', to: '', referralId: row.id, until: granted.until });
        emailTo.push(row.referrer_user_id);
      }
    }
  }

  if (friendCredited && friendCurrency && friendBilling?.stripe_customer_id) {
    const amount = monthlyListPriceCents(friendBilling.plan, friendCurrency) as number;
    const issued = await creditOnce(deps, row.id, 'friend', friendBilling.stripe_customer_id, amount, friendCurrency);
    if (issued) {
      emails.push({ template: 'referral_friend_credit', to: '', referralId: row.id, plan: friendBilling.plan });
      emailTo.push(row.friend_user_id);
    }
  }

  const status = decision.outcome === 'capped' ? 'capped' : 'qualified';
  const moved = await setStatus(db, row, {
    status,
    qualified_at: now.toISOString(),
    // The network signal is kept only until it has been used.
    ip_hash: null,
  });
  if (moved === 0) {
    // A refund or dispute webhook voided the row while the credits were being
    // issued (the charge was read before it). Take back what this run issued;
    // the webhook took back anything issued before its void. Nobody is emailed.
    console.warn('[referral-dispatch] row left charged during the reward; clawing back', { referral: row.id });
    await clawBackReferralRewards(db, stripe, row.id);
    return 'voided';
  }
  await recordReferralEvent(
    db,
    row.friend_workspace_id,
    status === 'capped' ? 'referral_capped' : 'referral_qualified',
  );

  for (let i = 0; i < emails.length; i += 1) {
    const userId = emailTo[i];
    if ((await deps.accountState(userId)) === 'deleted') continue;
    const { data: user } = await db.from('users').select('email').eq('id', userId).maybeSingle();
    const to = (user as { email?: string } | null)?.email;
    if (!to) continue;
    await deps.sendEmail({ ...emails[i], to });
  }
  return status;
}

/** Moves a row that is still 'charged'. Returns how many rows moved (0 or 1). */
async function setStatus(db: Db, row: DueRow, patch: ReferralUpdate): Promise<number> {
  const { data, error } = await db
    .from('referrals')
    .update(patch)
    .eq('id', row.id)
    .eq('status', 'charged')
    .select('id');
  if (error) throw new Error(`referrals update failed: ${error.message}`);
  return (data ?? []).length;
}

interface RewardClaim {
  stripe_balance_txn_id: string | null;
  stripe_customer_id: string | null;
  amount_cents: number | null;
  currency: string | null;
}

async function readClaim(db: Db, referralId: string, side: RewardSide): Promise<RewardClaim | null> {
  const { data, error } = await db
    .from('referral_rewards')
    .select('stripe_balance_txn_id, stripe_customer_id, amount_cents, currency')
    .eq('referral_id', referralId)
    .eq('side', side)
    .maybeSingle();
  if (error) throw new Error(`referral_rewards read failed: ${error.message}`);
  return data as RewardClaim | null;
}

/** True when this side's credit was issued by THIS run (so it gets the email). */
async function creditOnce(
  deps: DispatchDeps,
  referralId: string,
  side: RewardSide,
  customerId: string,
  amountCents: number,
  currency: CreditCurrency,
): Promise<boolean> {
  const { db, stripe } = deps;

  let claim = await readClaim(db, referralId, side);
  if (claim?.stripe_balance_txn_id) return false;
  if (!claim) {
    const { error } = await db.from('referral_rewards').insert({
      referral_id: referralId,
      side,
      kind: 'stripe_credit',
      amount_cents: amountCents,
      currency,
      stripe_customer_id: customerId,
    });
    if (error && error.code !== '23505') throw new Error(`referral_rewards claim failed: ${error.message}`);
    claim = await readClaim(db, referralId, side);
    if (claim?.stripe_balance_txn_id) return false;
  }
  // A claim from an earlier run keeps its own customer, amount and currency.
  const target = claim?.stripe_customer_id ?? customerId;
  const amount = claim?.amount_cents ?? amountCents;
  const claimCurrency = creditCurrency(claim?.currency) ?? currency;

  const recent = await stripe.customers.listBalanceTransactions(target, { limit: 100 });
  const found = recent.data.find(
    (txn) => txn.metadata?.referral_id === referralId && txn.metadata?.side === side,
  );
  const txnId =
    found?.id ??
    (await issueReferralCredit(stripe, { customerId: target, referralId, side, amountCents: amount, currency: claimCurrency })).id;

  const { error } = await db
    .from('referral_rewards')
    .update({ stripe_balance_txn_id: txnId })
    .eq('referral_id', referralId)
    .eq('side', side);
  if (error) throw new Error(`referral_rewards update failed: ${error.message}`);
  return true;
}

async function personalMonthOnce(
  db: Db,
  referralId: string,
  userId: string,
): Promise<{ issued: boolean; until: string | null }> {
  const { error: claimError } = await db.from('referral_rewards').insert({
    referral_id: referralId,
    side: 'referrer',
    kind: 'personal_month',
  });
  if (claimError) {
    if (claimError.code === '23505') return { issued: false, until: null };
    throw new Error(`referral_rewards claim failed: ${claimError.message}`);
  }
  const { data: until, error } = await db.rpc('grant_referral_personal', {
    p_user_id: userId,
    p_days: PERSONAL_MONTH_DAYS,
  });
  if (error) {
    await db.from('referral_rewards').delete().eq('referral_id', referralId).eq('side', 'referrer');
    throw new Error(`grant_referral_personal failed: ${error.message}`);
  }
  // NULL for a comped user: they already have more than Personal. The claim
  // stays, so the reward still counts and is never retried.
  const end = typeof until === 'string' ? until : null;
  if (end) {
    await db
      .from('referral_rewards')
      .update({ entitlement_until: end })
      .eq('referral_id', referralId)
      .eq('side', 'referrer');
  }
  return { issued: true, until: end };
}

async function cardFingerprints(stripe: ReferralStripeApi, customerId: string | null): Promise<string[]> {
  if (!customerId) return [];
  const methods = await stripe.customers.listPaymentMethods(customerId, { type: 'card', limit: 100 });
  return methods.data.map((pm) => pm.card?.fingerprint ?? '').filter(Boolean);
}

/**
 * The same salted network hash on another referral of this code, or on the
 * referrer's own signup (when they were referred themselves). Only signups are
 * hashed, so this is the comparison the stored data allows.
 */
async function ipHashMatches(db: Db, row: DueRow): Promise<boolean> {
  if (!row.ip_hash) return false;
  const { data: sameCode, error } = await db
    .from('referrals')
    .select('id')
    .eq('code', row.code)
    .eq('ip_hash', row.ip_hash)
    .neq('id', row.id)
    .limit(1);
  if (error) throw new Error(`referrals ip read failed: ${error.message}`);
  if ((sameCode ?? []).length > 0) return true;
  const { data: referrerOwn, error: ownError } = await db
    .from('referrals')
    .select('id')
    .eq('friend_user_id', row.referrer_user_id)
    .eq('ip_hash', row.ip_hash)
    .limit(1);
  if (ownError) throw new Error(`referrals ip read failed: ${ownError.message}`);
  return (referrerOwn ?? []).length > 0;
}

/** Referrals of this code that reached 'charged' in the 24 hours up to this one. */
async function velocityCount(db: Db, row: DueRow): Promise<number> {
  if (!row.first_charge_at) return 1;
  const at = Date.parse(row.first_charge_at);
  const { count, error } = await db
    .from('referrals')
    .select('id', { count: 'exact', head: true })
    .eq('code', row.code)
    .gte('first_charge_at', new Date(at - DAY_MS).toISOString())
    .lte('first_charge_at', new Date(at).toISOString());
  if (error) throw new Error(`referrals velocity count failed: ${error.message}`);
  return count ?? 1;
}

async function subscriptionActive(stripe: ReferralStripeApi, billing: BillingRow | null): Promise<boolean> {
  if (!billing) return false;
  if (billing.stripe_subscription_id) {
    const sub = await stripe.subscriptions.retrieve(billing.stripe_subscription_id);
    return ENTITLED_STATUSES.has(sub.status);
  }
  return billing.subscription_status != null && ENTITLED_STATUSES.has(billing.subscription_status);
}
