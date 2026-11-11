import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import {
  BUSINESS_PRIVATE_INBOXES_PER_PERSON,
  basePlanItem,
  isBusinessSeatPriceId,
} from '@/lib/stripe/plans';
import { businessSeatPricingOn } from '@/lib/stripe/business-seats';

/**
 * The per-person private mailbox cap of Business billed per person: each
 * person may own up to BUSINESS_PRIVATE_INBOXES_PER_PERSON private mailboxes
 * per workspace. Company-wide mailboxes are not capped (past the included ten
 * they are billed by the mailbox add-on).
 *
 * Applies only when ALL of these hold, and is otherwise `maxPrivateInboxes:
 * null` (no cap from here; the plan cap in check-inbox-limit.ts still applies):
 *
 *   - `pricing_switches.business_seat_pricing` is on;
 *   - the workspace owner is on Business with a subscription;
 *   - that subscription's base item is a seat price. A flat $39 / founder /
 *     Team subscription bills every mailbox through the add-on and was sold
 *     as uncapped, so it is never capped here.
 *
 * Every read fails OPEN (no cap): refusing a connect over a failed read would
 * lock a paying customer out, and the worst case of letting it through is an
 * eleventh private mailbox nobody bills for until the next connect is checked.
 *
 * A reconnect of an existing address adds no mailbox: callers skip this check
 * for it, exactly as for the plan cap (inboxExistsForEmail).
 *
 * Takes the SERVICE-ROLE client: it reads the owner's billing row, which the
 * connecting member cannot see under RLS.
 */
export interface PrivateInboxLimitResult {
  atLimit: boolean;
  /** Private mailboxes this person owns in this workspace. */
  currentCount: number;
  /** The cap, or null when none applies. */
  maxPrivateInboxes: number | null;
}

const NO_CAP: PrivateInboxLimitResult = { atLimit: false, currentCount: 0, maxPrivateInboxes: null };

export async function checkPrivateInboxLimit(args: {
  db: SupabaseClient<Database>;
  workspaceId: string;
  userId: string;
  stripe?: Pick<Stripe, 'subscriptions'>;
  /** Overrides the switch read (tests). */
  switchOn?: boolean;
}): Promise<PrivateInboxLimitResult> {
  const { db, workspaceId, userId } = args;
  try {
    const on = args.switchOn ?? (await businessSeatPricingOn({ db }));
    if (!on) return NO_CAP;

    const { data: workspace } = await db
      .from('workspaces')
      .select('owner_id')
      .eq('id', workspaceId)
      .maybeSingle();
    if (!workspace?.owner_id) return NO_CAP;

    const { data: billing } = await db
      .from('user_billing')
      .select('plan, stripe_subscription_id')
      .eq('user_id', workspace.owner_id)
      .maybeSingle();
    if (billing?.plan !== 'pro' || !billing.stripe_subscription_id) return NO_CAP;

    const stripe = args.stripe ?? (await import('@/lib/stripe/client')).stripe;
    const subscription = await stripe.subscriptions.retrieve(billing.stripe_subscription_id);
    if (!isBusinessSeatPriceId(basePlanItem(subscription.items?.data)?.price?.id ?? null)) return NO_CAP;

    const { count, error } = await db
      .from('inboxes')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('owner_user_id', userId)
      .eq('visibility', 'private')
      .is('deleted_at', null);
    if (error) return NO_CAP;

    const currentCount = count ?? 0;
    return {
      atLimit: currentCount >= BUSINESS_PRIVATE_INBOXES_PER_PERSON,
      currentCount,
      maxPrivateInboxes: BUSINESS_PRIVATE_INBOXES_PER_PERSON,
    };
  } catch (err) {
    console.error(
      '[private-inbox-limit] check failed, not capping',
      err instanceof Error ? err.message : String(err),
    );
    return NO_CAP;
  }
}
