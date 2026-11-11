/**
 * POST /api/billing/keep
 *
 * "Keep my plan": remove a scheduled stop (cancel_at, or
 * cancel_at_period_end) from the signed-in owner's subscription, so it renews
 * as before. The billing card's banner and the links in the plan-ending
 * reminder and the cancellation confirmation lead here. Behind
 * PLAN_ENDING_REMINDER_ENABLED=on (internal accounts always), 404 otherwise.
 *
 * Body: { action, confirm?, source? }
 *   quote   read only: is a stop scheduled, when, on which plan, can it be
 *           removed here
 *   keep    remove the scheduled stop. Answers a quote unless
 *           `confirm === true`, the same two-call handshake as
 *           /api/billing/pause, so nothing changes without a click.
 *   source  optional: plan_ending_email | cancel_email | billing_page,
 *           written to the plan_kept funnel row's entry_point.
 *
 * Nothing is charged here: the subscription simply renews at its next period
 * end, as it would have before the cancel. A paused subscription is refused
 * (a pause already replaced the cancel). Not part of /cancel or the Stripe
 * portal flow (PR #245): this only ever undoes a cancel.
 *
 * Auth and ownership: src/lib/billing/plan-change-route.ts. The webhook
 * projects the change; this route cancels the open cancellation emails and
 * the reminder at once so none of them goes out in between.
 */
import { NextResponse, type NextRequest } from 'next/server';
import type Stripe from 'stripe';

import { stripe } from '@/lib/stripe/client';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { keepPlanEnabledFor } from '@/lib/billing/plan-change-flags';
import { currentUser, isoOf, loadOwnSubscription, readBody } from '@/lib/billing/plan-change-route';
import { pauseFacts, type PausableSubscription } from '@/lib/billing/pause';
import { cancelOpenSequence } from '@/lib/billing/lifecycle-queue';
import { lifecycleQueueingEnabled } from '@/lib/billing/lifecycle-mode';
import { primaryWorkspaceId } from '@/lib/analytics/billing-funnel';
import { recordProductFunnelEvent } from '@/lib/analytics/product-funnel';
import { planActionSource } from '@/lib/billing/plan-action-links';
import { keepPlanQuote, keepPlanUpdate } from '@/lib/billing/keep-plan';

const ACTIONS = new Set(['quote', 'keep']);

function fail(status: number, error: string, code: string) {
  return NextResponse.json({ error, error_code: code }, { status });
}

function quoteBody(subscription: Stripe.Subscription, now: Date) {
  const pausable = subscription as unknown as PausableSubscription;
  const facts = pauseFacts(pausable, now);
  const quote = keepPlanQuote(pausable, now);
  return {
    cancelScheduled: quote.cancelScheduled,
    endsAt: isoOf(quote.endsAt),
    canKeep: quote.canKeep,
    keepRefusal: quote.refusal,
    planId: facts.planId,
    interval: facts.interval,
    amountCents: facts.amountCents,
    currency: facts.currency,
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = await currentUser();
  if (!user) return fail(401, 'Unauthorized', 'unauthenticated');
  if (!keepPlanEnabledFor(user.email)) return fail(404, 'Not found', 'not_found');

  const body = await readBody(request);
  const action = typeof body.action === 'string' ? body.action : 'quote';
  if (!ACTIONS.has(action)) return fail(400, 'Unknown action.', 'invalid_action');

  const own = await loadOwnSubscription(user);
  if (!own.ok) return fail(own.status, own.error, own.code);
  const { subscription, customerId } = own.value;
  const now = new Date();
  const quote = quoteBody(subscription, now);

  if (action === 'quote') return NextResponse.json(quote, { status: 200 });

  const params = keepPlanUpdate(subscription as unknown as PausableSubscription, now);
  if (!params) {
    return NextResponse.json(
      { ...quote, error: 'There is no scheduled end to remove on this subscription.', error_code: quote.keepRefusal ?? 'not_eligible' },
      { status: 409 },
    );
  }
  if (body.confirm !== true) {
    return NextResponse.json({ ...quote, confirmation_required: true, action }, { status: 200 });
  }

  let updated: Stripe.Subscription;
  try {
    updated = await stripe.subscriptions.update(subscription.id, params as Stripe.SubscriptionUpdateParams);
  } catch (err) {
    console.error('[billing/keep] stripe update failed:', err instanceof Error ? err.message : String(err));
    return fail(502, 'Could not change your subscription. Nothing was changed; please try again.', 'stripe_error');
  }

  const db = createServiceRoleClient();
  if (lifecycleQueueingEnabled()) {
    await cancelOpenSequence({
      db,
      stripeCustomerId: customerId,
      templates: ['cancel_ask', 'winback_14', 'winback_30', 'plan_ending_5d'],
      reason: 'subscription_reactivated',
    });
  }

  const workspaceId = await primaryWorkspaceId(db, user.id);
  if (workspaceId) {
    try {
      const plan = quote.planId;
      await recordProductFunnelEvent(db, {
        workspaceId,
        stage: 'plan_kept',
        outcome: 'success',
        category: plan === 'personal' || plan === 'solo' || plan === 'pro' ? plan : 'unknown',
        entryPoint: planActionSource(body.source),
      });
    } catch (err) {
      console.error('[billing/keep] funnel write failed, swallowed:', err instanceof Error ? err.message : String(err));
    }
  }

  return NextResponse.json({ ...quoteBody(updated, now), changed: true, action }, { status: 200 });
}
