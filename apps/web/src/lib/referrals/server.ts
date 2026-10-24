/**
 * Server-side reads and small writes shared by the referral routes, the
 * Stripe webhook and the dispatcher. Every function takes the database (and,
 * where it needs one, the Stripe client) as a parameter, so the routes pass
 * the service-role client and tests pass src/lib/billing/fake-supabase.ts.
 *
 * THE FLAG. `workspaces.referral_enabled` gates the program per workspace, like
 * chat_send_confirm_enabled. A friend's brand-new workspace is never flagged,
 * so everything the friend's side does (the /r/ cookie, attach at signup, the
 * charged transition, rewards) asks the CODE OWNER instead: the program is on
 * for a referral when the referrer owns a live workspace with the flag set.
 * Only the referrer's own surfaces (GET and POST /api/referrals) read the
 * caller's active workspace.
 */

import { createHmac } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';

import type { Database } from '@/types/database.types';
import { recordProductFunnelEvent, type BillingPlanCategory } from '@/lib/analytics/product-funnel';
import { REF_COOKIE, REF_COOKIE_DAYS } from './constants.ts';

export type Db = SupabaseClient<Database>;

/** The slice of the Stripe client the referral server code calls. */
export interface ReferralStripeApi {
  customers: Pick<
    Stripe['customers'],
    'retrieve' | 'list' | 'createBalanceTransaction' | 'listBalanceTransactions' | 'listPaymentMethods'
  >;
  invoices: Pick<Stripe['invoices'], 'list' | 'retrieve'>;
  charges: Pick<Stripe['charges'], 'retrieve'>;
  subscriptions: Pick<Stripe['subscriptions'], 'retrieve'>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Flag
// ---------------------------------------------------------------------------

/** True when the user owns a live workspace with referral_enabled set. */
export async function referralsEnabledForOwner(db: Db, userId: string): Promise<boolean> {
  const { data, error } = await db
    .from('workspaces')
    .select('id')
    .eq('owner_id', userId)
    .eq('referral_enabled', true)
    .is('deleted_at', null)
    .limit(1);
  if (error) {
    console.error('[referrals] flag read failed', { error: error.message });
    return false;
  }
  return (data ?? []).length > 0;
}

// ---------------------------------------------------------------------------
// Cookie
// ---------------------------------------------------------------------------

const COOKIE_PATTERN = new RegExp(`(?:^|;\\s*)${REF_COOKIE}=([^;]*)`);

/**
 * The `mcpe_ref` value from a Cookie header, or null when there is no such
 * cookie. Not validated: a mangled value comes back as-is, so the caller
 * still clears it and normalizeReferralCode refuses it.
 */
export function referralCookieFromHeader(header: string | null): string | null {
  if (!header) return null;
  const match = COOKIE_PATTERN.exec(header);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** Set-Cookie for the referral code: first-party, HttpOnly, Lax, 60 days. */
export function referralCookieString(code: string, options: { secure: boolean }): string {
  const parts = [
    `${REF_COOKIE}=${encodeURIComponent(code)}`,
    'Path=/',
    `Max-Age=${REF_COOKIE_DAYS * 24 * 60 * 60}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearReferralCookieString(options: { secure: boolean }): string {
  const parts = [`${REF_COOKIE}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// Network signal
// ---------------------------------------------------------------------------

/**
 * HMAC-SHA-256 of the client IP under REFERRAL_IP_SALT, or null. Without the
 * salt nothing is stored and the same-network check simply never fires: an
 * unsalted hash of an IPv4 address is reversible by enumeration, so storing
 * one would be storing the address.
 */
export function referralIpHash(ip: string | null): string | null {
  const salt = process.env.REFERRAL_IP_SALT;
  if (!ip || !salt) return null;
  return createHmac('sha256', salt).update(ip.trim().toLowerCase()).digest('hex');
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export type ReferralStage =
  | 'referral_link_viewed'
  | 'referral_link_copied'
  | 'referral_attached'
  | 'referral_attach_refused'
  | 'referral_charged'
  | 'referral_qualified'
  | 'referral_voided'
  | 'referral_held'
  | 'referral_capped';

function planCategoryOf(plan: unknown): BillingPlanCategory {
  return plan === 'personal' || plan === 'solo' || plan === 'pro' ? plan : 'free';
}

/**
 * One product_funnel_events row, best effort. No reason text is stored: the
 * reason lives on the referral row, and the vocabulary here is bounded.
 */
export async function recordReferralEvent(
  db: Db,
  workspaceId: string | null,
  stage: ReferralStage,
  options: { failure?: boolean; plan?: string | null } = {},
): Promise<void> {
  if (!workspaceId) return;
  try {
    let plan = options.plan;
    if (plan === undefined) {
      const { data } = await db.from('workspaces').select('plan').eq('id', workspaceId).maybeSingle();
      plan = (data as { plan?: string } | null)?.plan ?? null;
    }
    await recordProductFunnelEvent(db, {
      workspaceId,
      stage,
      outcome: options.failure ? 'failure' : 'success',
      category: planCategoryOf(plan),
    });
  } catch (err) {
    console.error('[referrals] event failed', {
      stage,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The user's oldest live owned workspace, with its plan. */
export async function primaryOwnedWorkspace(
  db: Db,
  userId: string,
): Promise<{ id: string; plan: string } | null> {
  const { data } = await db
    .from('workspaces')
    .select('id, plan, created_at')
    .eq('owner_id', userId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const row = data as { id?: string; plan?: string } | null;
  return row?.id ? { id: row.id, plan: row.plan ?? 'free' } : null;
}

export interface BillingRow {
  plan: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
}

export async function billingRow(db: Db, userId: string): Promise<BillingRow | null> {
  const { data, error } = await db
    .from('user_billing')
    .select('plan, stripe_customer_id, stripe_subscription_id, subscription_status')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`user_billing read failed: ${error.message}`);
  return (data as BillingRow | null) ?? null;
}

/** Subscription states that mean money moved (or is owed) at some point. */
const PAID_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'canceled']);

/** Statuses that keep the plan (webhook ENTITLED_STATUSES). */
export const ENTITLED_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid']);

/** Cheap, database-only: has this user ever held a paid subscription? */
export function billingShowsPaidHistory(row: BillingRow | null): boolean {
  if (!row) return false;
  if (row.plan && row.plan !== 'free') return true;
  return row.subscription_status != null && PAID_STATUSES.has(row.subscription_status);
}

async function customerHasPaidInvoice(stripe: ReferralStripeApi, customerId: string): Promise<boolean> {
  const invoices = await stripe.invoices.list({ customer: customerId, status: 'paid', limit: 10 });
  return invoices.data.some((inv) => (inv.amount_paid ?? 0) > 0);
}

/**
 * The attach-time "existing customer" rule: any paid subscription on record,
 * a paid invoice on the user's own Stripe customer, or a paid invoice on any
 * other Stripe customer under the same address. Throws on a Stripe failure so
 * the caller can refuse rather than guess.
 */
export async function friendHasPaidHistory(
  db: Db,
  stripe: ReferralStripeApi | null,
  friend: { id: string; email: string },
  normalizedEmail: string,
): Promise<boolean> {
  const billing = await billingRow(db, friend.id);
  if (billingShowsPaidHistory(billing)) return true;
  if (!stripe) return false;
  if (billing?.stripe_customer_id && (await customerHasPaidInvoice(stripe, billing.stripe_customer_id))) {
    return true;
  }
  const emails = [...new Set([friend.email.trim().toLowerCase(), normalizedEmail])].filter(Boolean);
  for (const email of emails) {
    const customers = await stripe.customers.list({ email, limit: 5 });
    for (const customer of customers.data) {
      if (customer.id === billing?.stripe_customer_id) continue;
      if (await customerHasPaidInvoice(stripe, customer.id)) return true;
    }
  }
  return false;
}

/**
 * True when the two users share a workspace either way round: the referrer
 * belongs to one the friend owns, or the friend to one the referrer owns. Both
 * are one team inviting itself.
 */
export async function usersShareWorkspace(db: Db, referrerId: string, friendId: string): Promise<boolean> {
  for (const [owner, member] of [
    [friendId, referrerId],
    [referrerId, friendId],
  ]) {
    const { data: owned, error } = await db.from('workspaces').select('id').eq('owner_id', owner);
    if (error) throw new Error(`workspaces read failed: ${error.message}`);
    const ids = (owned ?? []).map((w) => (w as { id: string }).id);
    if (ids.length === 0) continue;
    const { data: memberships, error: memberError } = await db
      .from('workspace_members')
      .select('workspace_id')
      .eq('user_id', member)
      .in('workspace_id', ids)
      .limit(1);
    if (memberError) throw new Error(`workspace_members read failed: ${memberError.message}`);
    if ((memberships ?? []).length > 0) return true;
  }
  return false;
}

/** Referrer-side rewards issued in the trailing 365 days (the yearly cap). */
export async function referrerRewardsLast365d(db: Db, referrerId: string, now: Date): Promise<number> {
  const { data: refs, error } = await db
    .from('referrals')
    .select('id')
    .eq('referrer_user_id', referrerId);
  if (error) throw new Error(`referrals read failed: ${error.message}`);
  const ids = (refs ?? []).map((r) => (r as { id: string }).id);
  if (ids.length === 0) return 0;
  const { count, error: countError } = await db
    .from('referral_rewards')
    .select('id', { count: 'exact', head: true })
    .in('referral_id', ids)
    .eq('side', 'referrer')
    .gte('issued_at', new Date(now.getTime() - 365 * DAY_MS).toISOString());
  if (countError) throw new Error(`referral_rewards count failed: ${countError.message}`);
  return count ?? 0;
}

/** Remaining Stripe credit in cents (the negative part of the balance). */
export async function creditBalanceCents(stripe: ReferralStripeApi, customerId: string): Promise<number> {
  const customer = await stripe.customers.retrieve(customerId);
  if ('deleted' in customer && customer.deleted) return 0;
  const balance = typeof customer.balance === 'number' ? customer.balance : 0;
  return balance < 0 ? -balance : 0;
}
