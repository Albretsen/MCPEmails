import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import {
  basePlanItem,
  extraMailboxQuantity,
  getPlanByStripePriceId,
  mailboxAddonItem,
  mailboxAddonPriceId,
  type BillingInterval,
  type PlanId,
} from '@/lib/stripe/plans';

/**
 * Business bills mailboxes above the included ten as a second subscription
 * item, quantity = max(0, connected mailboxes - 10). This module keeps that
 * quantity in step with the mailboxes the owner actually has.
 *
 * WHAT IS COUNTED. Every non-deleted inbox in every non-deleted workspace the
 * subscription OWNER owns. A Business subscription covers all of them (the
 * webhook projects the plan onto each owned workspace), so the count is the
 * owner's, not one workspace's, and a member who connects a mailbox in the
 * owner's workspace adds to the owner's bill.
 *
 * WHEN IT RUNS. After a connect route adds an inbox, after an inbox or a
 * workspace is deleted, and when the webhook sees a Business subscription
 * change. Every run reads the live state and sets an absolute quantity, so
 * running twice, or out of order, converges on the same answer.
 *
 * ADDING bills now: `always_invoice` invoices the prorated remainder of the
 * period at once, the same rule checkout-core applies to a plan change, so
 * a mailbox used this month is paid for this month. A yearly subscription
 * would otherwise carry the charge to its renewal.
 *
 * REMOVING credits nothing: `proration_behavior: 'none'`. The lower quantity
 * applies from the next renewal and the current period, already paid, is not
 * refunded. Two reasons. A disconnect is often a reconnect a minute later (a
 * rotated password, a provider switch), and a credit-then-charge pair for each
 * would fill the invoice history with noise. And it is the conventional rule
 * for seat-style add-ons, so it reads as fair. The pricing copy says "$3 a
 * month for each extra mailbox", which this honours: nobody pays for a
 * mailbox for longer than the period in which it was connected.
 *
 * IDEMPOTENT. Quantities are absolute, so a repeated update is a no-op and is
 * skipped before Stripe is called. The one non-absolute call, creating the
 * add-on item, carries an idempotency key, so two concurrent first connects
 * past ten cannot create two items. The key names the intent (subscription,
 * price, target quantity) and a ten-minute window, not only the subscription
 * and price: Stripe replays a key's first response for 24 hours, so a key
 * that never changes would answer "created" for an add-on that was removed
 * since (a plan change away from Business and back) and the mailboxes would
 * go unbilled. Because a replay can still land inside one window, a create
 * is then checked against the live subscription and retried once with a
 * one-off key when the item is not there.
 *
 * NEVER BLOCKS. A connect or a delete has already happened by the time this
 * runs; a Stripe failure is logged and returned, never thrown, and the next
 * run repairs it.
 */

export type MailboxAddonItemChange = Stripe.SubscriptionUpdateParams.Item;

/** Interval of a subscription's PLAN, from its base item. */
export interface MailboxAddonState {
  /** The plan the subscription's base item resolves to, null when unmapped. */
  planId: PlanId | null;
  interval: BillingInterval | null;
  /** The add-on item, when present. */
  addonItem: { id: string; priceId: string; quantity: number } | null;
}

export function readMailboxAddonState(subscription: Pick<Stripe.Subscription, 'items'>): MailboxAddonState {
  const items = subscription.items?.data ?? [];
  const base = basePlanItem(items);
  const resolved = getPlanByStripePriceId(base?.price?.id ?? null);
  const addon = mailboxAddonItem(items);
  return {
    planId: resolved?.plan.id ?? null,
    interval: resolved?.interval ?? null,
    addonItem: addon
      ? { id: addon.id, priceId: addon.price.id, quantity: addon.quantity ?? 0 }
      : null,
  };
}

/**
 * The add-on half of a subscription update, as Stripe item params. Pure.
 *
 *   target Business  set the add-on to `extra` at the target interval's price,
 *                    creating it only when there is something to bill;
 *   target anything else  delete the add-on if the subscription has one.
 *
 * An empty array means no add-on change. Throws `addon_price_not_configured`
 * when the target is Business and the per-mailbox price for its interval is
 * not set, because billing ten mailboxes for thirty is the silent failure this
 * must never have.
 */
export function mailboxAddonItemChanges(args: {
  targetPlan: PlanId;
  interval: BillingInterval;
  extra: number;
  addonItem: MailboxAddonState['addonItem'];
}): MailboxAddonItemChange[] {
  const { targetPlan, interval, extra, addonItem } = args;

  if (targetPlan !== 'pro') {
    return addonItem ? [{ id: addonItem.id, deleted: true }] : [];
  }

  // Required for every Business change, not only one with extras today: the
  // next connect past ten would otherwise have no price to bill against.
  const priceId = mailboxAddonPriceId(interval);
  if (!priceId) throw new Error('addon_price_not_configured');

  if (addonItem) {
    if (addonItem.priceId === priceId && addonItem.quantity === extra) return [];
    return [{ id: addonItem.id, price: priceId, quantity: extra }];
  }
  return extra > 0 ? [{ price: priceId, quantity: extra }] : [];
}

/** Non-deleted inboxes across every non-deleted workspace the user owns. */
export async function countOwnedInboxes(
  db: SupabaseClient<Database>,
  ownerId: string,
): Promise<number | null> {
  const { data: owned, error: wsError } = await db
    .from('workspaces')
    .select('id')
    .eq('owner_id', ownerId)
    .is('deleted_at', null);
  if (wsError) {
    console.error('[mailbox-addon] workspace lookup failed', { error: wsError.message });
    return null;
  }
  const ids = (owned ?? []).map((w) => w.id);
  if (ids.length === 0) return 0;

  const { count, error } = await db
    .from('inboxes')
    .select('id', { count: 'exact', head: true })
    .in('workspace_id', ids)
    .is('deleted_at', null);
  if (error) {
    console.error('[mailbox-addon] inbox count failed', { error: error.message });
    return null;
  }
  return count ?? 0;
}

export type MailboxAddonSyncResult =
  | { status: 'skipped'; reason: 'no_owner' | 'not_business' | 'no_subscription' | 'not_entitled' | 'count_failed' }
  | { status: 'unchanged'; quantity: number }
  | { status: 'updated'; from: number; to: number }
  | { status: 'failed'; reason: string };

const ENTITLED = new Set(['active', 'trialing', 'past_due', 'unpaid']);

export interface MailboxAddonDeps {
  db: SupabaseClient<Database>;
  stripe: Pick<Stripe, 'subscriptions'>;
}

/** Sync the add-on for the user who owns `workspaceId`. */
export async function syncMailboxAddonForWorkspace(
  workspaceId: string,
  deps?: Partial<MailboxAddonDeps>,
): Promise<MailboxAddonSyncResult> {
  try {
    const resolved = await resolveDeps(deps);
    const { data, error } = await resolved.db
      .from('workspaces')
      .select('owner_id')
      .eq('id', workspaceId)
      .maybeSingle();
    if (error || !data?.owner_id) return { status: 'skipped', reason: 'no_owner' };
    return await syncMailboxAddon(data.owner_id, resolved);
  } catch (err) {
    return failed(err);
  }
}

/** Sync the add-on for a subscription owner. Never throws. */
export async function syncMailboxAddon(
  ownerId: string,
  deps?: Partial<MailboxAddonDeps>,
): Promise<MailboxAddonSyncResult> {
  try {
    const { db, stripe } = await resolveDeps(deps);

    // Cheap exit first: only a Business subscriber has anything to sync, and
    // this runs after every connect on every plan.
    const { data: billing } = await db
      .from('user_billing')
      .select('plan, stripe_subscription_id, subscription_status')
      .eq('user_id', ownerId)
      .maybeSingle();
    if (!billing || billing.plan !== 'pro') return { status: 'skipped', reason: 'not_business' };
    // A comped or hand-seeded Business plan has no subscription to bill.
    if (!billing.stripe_subscription_id) return { status: 'skipped', reason: 'no_subscription' };

    const count = await countOwnedInboxes(db, ownerId);
    if (count === null) return { status: 'skipped', reason: 'count_failed' };
    const extra = extraMailboxQuantity(count);

    const subscription = await stripe.subscriptions.retrieve(billing.stripe_subscription_id);
    if (!ENTITLED.has(subscription.status)) return { status: 'skipped', reason: 'not_entitled' };

    // The live subscription decides, not user_billing: a plan change still in
    // flight must not be billed for the plan it is leaving.
    const state = readMailboxAddonState(subscription);
    if (state.planId !== 'pro' || !state.interval) return { status: 'skipped', reason: 'not_business' };

    const from = state.addonItem?.quantity ?? 0;
    const items = mailboxAddonItemChanges({
      targetPlan: 'pro',
      interval: state.interval,
      extra,
      addonItem: state.addonItem,
    });
    if (items.length === 0) return { status: 'unchanged', quantity: extra };

    const params: Stripe.SubscriptionUpdateParams = {
      items,
      proration_behavior: extra > from ? 'always_invoice' : 'none',
    };
    if (state.addonItem) {
      await stripe.subscriptions.update(subscription.id, params);
    } else {
      const priceId = String(items[0].price);
      await stripe.subscriptions.update(subscription.id, params, {
        idempotencyKey: mailboxAddonCreateKey(subscription.id, priceId, extra, Date.now()),
      });
      // A replayed response describes the subscription as it was when the key
      // was first used, so only the live subscription proves the item exists.
      if (!(await hasAddonItem(stripe, subscription.id, priceId))) {
        await stripe.subscriptions.update(subscription.id, params, {
          idempotencyKey: `mailbox-addon-create:${subscription.id}:${priceId}:${extra}:retry:${randomUUID()}`,
        });
        if (!(await hasAddonItem(stripe, subscription.id, priceId))) {
          return failed(new Error('addon_item_missing_after_create'));
        }
      }
    }
    console.log('[mailbox-addon] quantity synced', {
      subscription: subscription.id,
      from,
      to: extra,
    });
    return { status: 'updated', from, to: extra };
  } catch (err) {
    return failed(err);
  }
}

/** Ten minutes: wide enough to cover concurrent and retried calls of one sync. */
const CREATE_KEY_WINDOW_MS = 10 * 60_000;

/**
 * The idempotency key for creating the add-on item. Pure. The same intent in
 * the same window gives the same key; a later creation, after the item was
 * removed, gives a new one.
 */
export function mailboxAddonCreateKey(
  subscriptionId: string,
  priceId: string,
  quantity: number,
  atMs: number,
): string {
  const window = Math.floor(atMs / CREATE_KEY_WINDOW_MS);
  return `mailbox-addon-create:${subscriptionId}:${priceId}:${quantity}:${window}`;
}

async function hasAddonItem(
  stripe: Pick<Stripe, 'subscriptions'>,
  subscriptionId: string,
  priceId: string,
): Promise<boolean> {
  const live = await stripe.subscriptions.retrieve(subscriptionId);
  return mailboxAddonItem(live.items?.data)?.price?.id === priceId;
}

function failed(err: unknown): MailboxAddonSyncResult {
  const reason = err instanceof Error ? err.message : String(err);
  console.error('[mailbox-addon] sync failed', { error: reason });
  return { status: 'failed', reason };
}

async function resolveDeps(deps?: Partial<MailboxAddonDeps>): Promise<MailboxAddonDeps> {
  // Imported lazily so a caller that injects both never loads the real
  // clients, which throw at import time without their environment.
  const db = deps?.db ?? (await import('@/lib/supabase/service')).createServiceRoleClient();
  const stripe = deps?.stripe ?? (await import('@/lib/stripe/client')).stripe;
  return { db, stripe };
}
