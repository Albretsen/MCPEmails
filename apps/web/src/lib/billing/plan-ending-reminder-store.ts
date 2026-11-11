/**
 * The Supabase + Stripe store behind runPlanEndingReminder
 * (src/lib/billing/plan-ending-reminder.ts). Server only: service-role client.
 *
 * Candidates come from Stripe, not our tables: user_billing does not carry
 * cancel_at, and the cancel webhook's own rows are downstream of the event we
 * would be checking. One list call per 100 active subscriptions.
 *
 * The ledger is billing_email_sends: a `plan_ending_5d` row per subscription
 * and stop date, unique on (stripe_customer_id, template, scope_key). The
 * reminder arm's row is due now and the billing dispatcher sends it (with a
 * Stripe freshness check right before the send); the holdout arm's row is
 * inserted cancelled with cancel_reason 'holdout', so the same index stops
 * either arm from being handled twice.
 */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';

import { isInternalAccount } from '@/lib/analytics/internal-accounts';
import { primaryWorkspaceId } from '@/lib/analytics/billing-funnel';
import { recordProductFunnelEvent } from '@/lib/analytics/product-funnel';
import { accountState } from '@/lib/billing/deleted-account';
import { isGrandfathered, resolveRecipient, resolveUserId } from '@/lib/billing/lifecycle-queue';
import { pauseEligibility, pauseFacts, type PausableSubscription } from '@/lib/billing/pause';
import { pauseEnabledFor } from '@/lib/billing/plan-change-flags';
import { getExperimentDecision } from '@/lib/experiments';
import { createExperimentStore } from '@/lib/experiments/store';
import {
  PLAN_ENDING_EXPERIMENT,
  type LedgerRow,
  type OwnerFacts,
  type PlanEndingStore,
  type PlanEndingVariant,
  type StoppingSubscription,
} from '@/lib/billing/plan-ending-reminder';
import type { Database } from '@/types/database.types';
import type { Json } from '@/types/database.types';

type Db = SupabaseClient<Database>;

export const PLAN_ENDING_TEMPLATE = 'plan_ending_5d';
export const HOLDOUT_CANCEL_REASON = 'holdout';

/** The Stripe subscription, reduced to what the rules read. */
export function toStoppingSubscription(subscription: Stripe.Subscription, now: Date = new Date()): StoppingSubscription {
  const pausable = subscription as unknown as PausableSubscription;
  const facts = pauseFacts(pausable, now);
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  return {
    id: subscription.id,
    customerId,
    status: subscription.status ?? null,
    cancelAtPeriodEnd: subscription.cancel_at_period_end ?? null,
    cancelAt: subscription.cancel_at ?? null,
    currentPeriodEnd: facts.periodEnd,
    paused: facts.pause.state !== 'none',
    metadataUserId: subscription.metadata?.user_id ?? null,
    planId: facts.planId,
    interval: facts.interval,
    pauseEligible: pauseEligibility(pausable, now).eligible,
  };
}

export class SupabasePlanEndingStore implements PlanEndingStore {
  private readonly db: Db;
  private readonly stripe: Stripe;
  private readonly now: Date;

  constructor(db: Db, stripe: Stripe, now: Date = new Date()) {
    this.db = db;
    this.stripe = stripe;
    this.now = now;
  }

  async *listSubscriptions(): AsyncIterable<StoppingSubscription> {
    for (const status of ['active', 'trialing'] as const) {
      for await (const subscription of this.stripe.subscriptions.list({ status, limit: 100 })) {
        yield toStoppingSubscription(subscription, this.now);
      }
    }
  }

  async owner(sub: StoppingSubscription): Promise<OwnerFacts | null> {
    const userId = await resolveUserId(this.db, sub.customerId, sub.metadataUserId);
    if (!userId) return null;
    const state = await accountState(this.db, userId);
    if (state === 'unknown') throw new Error('auth read failed');

    const { data: user } = await this.db.from('users').select('email').eq('id', userId).maybeSingle();
    const email = user?.email ?? null;
    const workspaceId = await primaryWorkspaceId(this.db, userId);
    let freeCapExempt = true;
    if (workspaceId) {
      const { data: ws, error } = await this.db
        .from('workspaces')
        .select('free_action_cap_exempt')
        .eq('id', workspaceId)
        .maybeSingle();
      // Unreadable reads as exempt: the email then leaves the allowance out
      // rather than state a cap that may not apply.
      freeCapExempt = error ? true : ws?.free_action_cap_exempt ?? true;
    }
    return {
      userId,
      email,
      workspaceId,
      internal: isInternalAccount(email),
      deleted: state === 'deleted',
      grandfathered: await isGrandfathered(this.db, userId),
      freeCapExempt,
      pauseOffered: pauseEnabledFor(email),
    };
  }

  async recipient(sub: StoppingSubscription, owner: OwnerFacts): Promise<string | null> {
    let stripeEmail: string | null = null;
    try {
      const customer = await this.stripe.customers.retrieve(sub.customerId);
      stripeEmail = customer.deleted ? null : customer.email ?? null;
    } catch {
      stripeEmail = null;
    }
    return resolveRecipient(this.db, stripeEmail, owner.userId);
  }

  async hadSuccessfulCallSince(workspaceId: string, sinceIso: string): Promise<boolean> {
    const { data, error } = await this.db
      .from('activity_log')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('status', 'success')
      .gte('created_at', sinceIso)
      .limit(1);
    if (error) throw new Error(`activity read failed: ${error.message}`);
    return (data ?? []).length > 0;
  }

  async alreadyHandled(customerId: string, scopeKey: string): Promise<boolean> {
    const { data, error } = await this.db
      .from('billing_email_sends')
      .select('id')
      .eq('stripe_customer_id', customerId)
      .eq('template', PLAN_ENDING_TEMPLATE)
      .eq('scope_key', scopeKey)
      .limit(1);
    if (error) throw new Error(`ledger read failed: ${error.message}`);
    return (data ?? []).length > 0;
  }

  async assign(subjectId: string): Promise<PlanEndingVariant | null> {
    const decision = await getExperimentDecision(PLAN_ENDING_EXPERIMENT, subjectId, {
      fallback: 'holdout',
      store: createExperimentStore(this.db),
    });
    // Only a real assignment (or a concluded winner) counts. A draft or a
    // missing row would otherwise file everybody under holdout.
    if (decision.reason !== 'assigned' && decision.reason !== 'winner') return null;
    return decision.variantId === 'reminder' ? 'reminder' : decision.variantId === 'holdout' ? 'holdout' : null;
  }

  async queueReminder(row: LedgerRow): Promise<boolean> {
    return this.insert(row, false);
  }

  async recordHoldout(row: LedgerRow): Promise<boolean> {
    return this.insert(row, true);
  }

  async funnel(workspaceId: string, stage: 'plan_ending_reminder_holdout', planId: string): Promise<void> {
    await recordProductFunnelEvent(this.db, {
      workspaceId,
      stage,
      outcome: 'success',
      category: planId === 'personal' || planId === 'solo' || planId === 'pro' ? planId : 'unknown',
    });
  }

  private async insert(row: LedgerRow, holdout: boolean): Promise<boolean> {
    const nowIso = new Date().toISOString();
    const { data, error } = await this.db
      .from('billing_email_sends')
      .upsert(
        [
          {
            stripe_customer_id: row.stripeCustomerId,
            user_id: row.userId,
            recipient: row.recipient,
            template: PLAN_ENDING_TEMPLATE,
            scope_key: row.scopeKey,
            send_after: nowIso,
            payload: (row.payload ?? {}) as NonNullable<Json>,
            ...(holdout ? { cancelled_at: nowIso, cancel_reason: HOLDOUT_CANCEL_REASON } : {}),
          },
        ],
        { onConflict: 'stripe_customer_id,template,scope_key', ignoreDuplicates: true },
      )
      .select('id');
    if (error) throw new Error(`ledger insert failed: ${error.message}`);
    return (data ?? []).length > 0;
  }
}
