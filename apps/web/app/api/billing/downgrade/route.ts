/**
 * POST /api/billing/downgrade
 *
 * Switch Pro to Personal at the end of the current period, undo that, or
 * switch to Free (a cancel at period end). Behind BILLING_DOWNGRADE_ENABLED
 * (internal accounts always), 404 for everyone else.
 *
 * Body: { action, keepInboxIds?, confirm? }
 *   quote                       read only: what is pending, whether Personal
 *                               and Free are on offer, the Personal price for
 *                               this interval, the date, the inbox picker
 *   confirm { keepInboxIds }    book Pro to Personal (price swap now with
 *                               proration none, entitlement stays Pro until the
 *                               period end; see src/lib/billing/downgrade.ts)
 *   undo                        keep Pro: swap back, proration none
 *   switch_free                 cancel at period end, the field the portal
 *                               sets, so the normal cancel flow follows
 *
 * confirm, undo and switch_free answer a quote unless `confirm === true`.
 * Nothing here charges a card: proration is 'none' in both directions, and a
 * cancel at period end charges nothing.
 */
import { NextResponse, type NextRequest } from 'next/server';
import type Stripe from 'stripe';

import { stripe } from '@/lib/stripe/client';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { downgradeEnabledFor } from '@/lib/billing/plan-change-flags';
import {
  currentUser,
  inboxChoice,
  isoOf,
  loadOwnSubscription,
  readBody,
} from '@/lib/billing/plan-change-route';
import {
  downgradeEligibility,
  downgradeState,
  downgradeUpdate,
  switchFreeEligibility,
  undoDowngradeUpdate,
  type DowngradeUpdate,
} from '@/lib/billing/downgrade';
import { sanitizeKeepOrder, writePlanChangeColumns } from '@/lib/billing/plan-change-sync';
import { billingTarget, primaryWorkspaceId, recordPlanChange } from '@/lib/analytics/billing-funnel';
import { recordProductFunnelEvent } from '@/lib/analytics/product-funnel';
import { SWITCH_FREE_METADATA_KEY } from '@/lib/billing/lifecycle-queue';

const ACTIONS = new Set(['quote', 'confirm', 'undo', 'switch_free']);

function fail(status: number, error: string, code: string) {
  return NextResponse.json({ error, error_code: code }, { status });
}

function quoteBody(subscription: Stripe.Subscription, now: Date) {
  const state = downgradeState(subscription, now);
  const verdict = downgradeEligibility(subscription, now);
  const free = switchFreeEligibility(subscription);
  return {
    pending: state.state === 'pending'
      ? { fromPlan: state.fromPlan, toPlan: state.toPlan, effectiveAt: isoOf(state.effectiveAt) }
      : null,
    canDowngrade: verdict.eligible,
    downgradeRefusal: verdict.eligible ? null : verdict.reason,
    downgrade: verdict.eligible
      ? {
          fromPlan: verdict.quote.fromPlan,
          toPlan: verdict.quote.toPlan,
          interval: verdict.quote.interval,
          amountCents: verdict.quote.amountCents,
          currency: verdict.quote.currency,
          effectiveAt: isoOf(verdict.quote.effectiveAt),
          inboxCap: verdict.quote.inboxCap,
        }
      : null,
    canSwitchFree: free.eligible,
    switchFreeRefusal: free.reason,
    cancelScheduled: subscription.cancel_at_period_end === true || subscription.cancel_at != null,
    periodEnd: isoOf(subscription.items.data[0]?.current_period_end ?? null),
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = await currentUser();
  if (!user) return fail(401, 'Unauthorized', 'unauthenticated');
  if (!downgradeEnabledFor(user.email)) return fail(404, 'Not found', 'not_found');

  const body = await readBody(request);
  const action = typeof body.action === 'string' ? body.action : 'quote';
  if (!ACTIONS.has(action)) return fail(400, 'Unknown action.', 'invalid_action');
  const confirmed = body.confirm === true;

  const own = await loadOwnSubscription(user);
  if (!own.ok) return fail(own.status, own.error, own.code);
  const { subscription } = own.value;
  const now = new Date();
  const quote = quoteBody(subscription, now);

  if (action === 'quote') {
    const inboxes = quote.downgrade
      ? await inboxChoice(user.id, quote.downgrade.toPlan, sanitizeKeepOrder(body.keepInboxIds) ?? [])
      : null;
    return NextResponse.json({ ...quote, inboxes }, { status: 200 });
  }

  let params: DowngradeUpdate | Stripe.SubscriptionUpdateParams;
  try {
    if (action === 'confirm') {
      params = downgradeUpdate(subscription, now).params;
    } else if (action === 'undo') {
      params = undoDowngradeUpdate(subscription, now).params;
    } else {
      const free = switchFreeEligibility(subscription);
      if (!free.eligible) throw new Error(`switch refused: ${free.reason}`);
      // The portal's own cancel shape: cancel at the end of the paid period.
      // The marker lets the webhook queue the cancel email's billing-card
      // variant (payload.source = 'billing_switch_free').
      const periodEnd = subscription.items.data[0]?.current_period_end ?? null;
      params = {
        cancel_at_period_end: true,
        metadata: { [SWITCH_FREE_METADATA_KEY]: periodEnd != null ? String(periodEnd) : '' },
      };
    }
  } catch (err) {
    const reason = (err instanceof Error ? err.message : '').split(': ')[1] ?? 'not_eligible';
    return NextResponse.json({ ...quote, error: 'This change is not available for your subscription.', error_code: reason }, { status: 409 });
  }

  if (!confirmed) {
    return NextResponse.json({ ...quote, confirmation_required: true, action }, { status: 200 });
  }

  let updated: Stripe.Subscription;
  try {
    updated = await stripe.subscriptions.update(subscription.id, params as Stripe.SubscriptionUpdateParams);
  } catch (err) {
    console.error('[billing/downgrade] stripe update failed:', err instanceof Error ? err.message : String(err));
    return fail(502, 'Could not change your subscription. Nothing was changed; please try again.', 'stripe_error');
  }

  const db = createServiceRoleClient();
  if (action === 'confirm') {
    const keep = sanitizeKeepOrder(body.keepInboxIds);
    if (keep) await writePlanChangeColumns(db, user.id, { inbox_keep_order: keep });
  }

  const workspaceId = await primaryWorkspaceId(db, user.id);
  if (workspaceId && action !== 'switch_free') {
    try {
      const fromPlan = quote.downgrade?.fromPlan ?? quote.pending?.fromPlan ?? 'solo';
      await recordProductFunnelEvent(db, {
        workspaceId,
        stage: action === 'confirm' ? 'downgrade_scheduled' : 'downgrade_undone',
        outcome: 'success',
        category: fromPlan ?? 'unknown',
      });
      if (action === 'confirm' && quote.downgrade) {
        // Closed with `success` by the webhook when the date passes.
        await recordPlanChange({
          workspaceId,
          direction: 'downgrade',
          target: billingTarget(quote.downgrade.toPlan as 'personal', quote.downgrade.interval),
          outcome: 'started',
        });
      }
    } catch (err) {
      console.error('[billing/downgrade] funnel write failed, swallowed:', err instanceof Error ? err.message : String(err));
    }
  }

  return NextResponse.json({ ...quoteBody(updated, now), changed: true, action }, { status: 200 });
}
