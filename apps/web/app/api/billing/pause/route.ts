/**
 * POST /api/billing/pause
 *
 * Pause a monthly Personal or Pro subscription for 1 to 3 months, extend a
 * pause, or resume early. Behind BILLING_PAUSE_ENABLED (internal accounts
 * always), 404 for everyone else.
 *
 * Body: { action, months?, keepInboxIds?, confirm? }
 *   quote                         read only: state, eligibility, the lengths
 *                                 on offer with their resume date and amount,
 *                                 and the inbox picker for Free's one inbox
 *   pause { months, keepInboxIds } start a pause at the current period end
 *   extend { months }             add months to the current pause
 *   resume_early                  scheduled: remove the pause; running: the
 *                                 plan returns at the next renewal (D7)
 *
 * Every action but quote answers a quote unless `confirm === true`, the same
 * two-call handshake as runCheckout. Nothing is charged here: a pause starts
 * at a renewal already paid for, and billing resumes at a normal renewal.
 *
 * A pause from a scheduled cancel clears cancel_at in the same update (Stripe
 * test T12) and cancels the open cancellation emails.
 *
 * Auth and ownership: src/lib/billing/plan-change-route.ts. Mechanics:
 * src/lib/billing/pause.ts. Entitlement is projected by the Stripe webhook,
 * not here.
 */
import { NextResponse, type NextRequest } from 'next/server';
import type Stripe from 'stripe';

import { stripe } from '@/lib/stripe/client';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { pauseEnabledFor } from '@/lib/billing/plan-change-flags';
import {
  currentUser,
  inboxChoice,
  isoOf,
  loadOwnSubscription,
  readBody,
} from '@/lib/billing/plan-change-route';
import {
  extendEligibility,
  extendUpdate,
  pauseEligibility,
  pauseFacts,
  pauseResumesAt,
  pauseUpdate,
  resumeBoundary,
  resumeEarlyUpdate,
  type PauseUpdate,
} from '@/lib/billing/pause';
import { sanitizeKeepOrder, writePlanChangeColumns } from '@/lib/billing/plan-change-sync';
import {
  cancelOpenSequence,
  cancelPauseReminders,
  cancelUnsentPauseReceipt,
  isGrandfathered,
  queuePauseEmails,
  queuePauseReminder,
  resolveRecipient,
} from '@/lib/billing/lifecycle-queue';
import { lifecycleQueueingEnabled } from '@/lib/billing/lifecycle-mode';
import { primaryWorkspaceId } from '@/lib/analytics/billing-funnel';
import { recordProductFunnelEvent } from '@/lib/analytics/product-funnel';
import type { LifecyclePayload } from '@/lib/email/billing-lifecycle';

const ACTIONS = new Set(['quote', 'pause', 'extend', 'resume_early']);

function fail(status: number, error: string, code: string) {
  return NextResponse.json({ error, error_code: code }, { status });
}

function quoteBody(subscription: Stripe.Subscription, now: Date) {
  const facts = pauseFacts(subscription, now);
  const start = pauseEligibility(subscription, now);
  const extend = extendEligibility(subscription, now);
  const offerFor = (months: number, from: number | null, total: number) =>
    from == null
      ? null
      : {
          months,
          billsAt: isoOf(resumeBoundary(pauseResumesAt(from, total, facts.anchor))),
        };
  return {
    state: facts.pause.state,
    pausedFrom: isoOf(facts.pause.pausedFrom),
    billsAt: facts.pause.resumesAt != null ? isoOf(resumeBoundary(facts.pause.resumesAt)) : null,
    months: facts.pause.months,
    planId: facts.planId,
    interval: facts.interval,
    amountCents: facts.amountCents,
    currency: facts.currency,
    periodEnd: isoOf(facts.periodEnd),
    cancelScheduled: facts.cancelScheduled,
    canPause: start.eligible,
    pauseRefusal: start.reason,
    pauseOptions: start.lengths.map((n) => offerFor(n, facts.periodEnd, n)).filter(Boolean),
    canExtend: extend.eligible,
    extendOptions: extend.lengths
      .map((n) => offerFor(n, facts.pause.pausedFrom, facts.pause.months + n))
      .filter(Boolean),
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = await currentUser();
  if (!user) return fail(401, 'Unauthorized', 'unauthenticated');
  if (!pauseEnabledFor(user.email)) return fail(404, 'Not found', 'not_found');

  const body = await readBody(request);
  const action = typeof body.action === 'string' ? body.action : 'quote';
  if (!ACTIONS.has(action)) return fail(400, 'Unknown action.', 'invalid_action');
  const confirmed = body.confirm === true;

  const own = await loadOwnSubscription(user);
  if (!own.ok) return fail(own.status, own.error, own.code);
  const { subscription, customerId } = own.value;
  const now = new Date();
  const quote = quoteBody(subscription, now);

  if (action === 'quote') {
    const choice = await inboxChoice(user.id, 'free', sanitizeKeepOrder(body.keepInboxIds) ?? []);
    return NextResponse.json({ ...quote, inboxes: choice }, { status: 200 });
  }

  const months = typeof body.months === 'number' && Number.isInteger(body.months) ? body.months : null;

  let update: { params: PauseUpdate; billsAt: number | null; pausedFrom: number | null; stage: 'pause_started' | 'pause_extended' | 'pause_resumed' };
  try {
    if (action === 'pause') {
      if (months == null) return fail(400, 'Choose how many months.', 'invalid_months');
      const result = pauseUpdate(subscription, months, now);
      update = { params: result.params, billsAt: resumeBoundary(result.resumesAt), pausedFrom: result.pausedFrom, stage: 'pause_started' };
    } else if (action === 'extend') {
      if (months == null) return fail(400, 'Choose how many months.', 'invalid_months');
      const result = extendUpdate(subscription, months, now);
      update = { params: result.params, billsAt: resumeBoundary(result.resumesAt), pausedFrom: result.pausedFrom, stage: 'pause_extended' };
    } else {
      const result = resumeEarlyUpdate(subscription, now);
      update = { params: result.params, billsAt: result.billsAt, pausedFrom: null, stage: 'pause_resumed' };
    }
  } catch (err) {
    const reason = (err instanceof Error ? err.message : '').split(': ')[1] ?? 'not_eligible';
    return NextResponse.json({ ...quote, error: 'This change is not available for your subscription.', error_code: reason }, { status: 409 });
  }

  // The handshake: no Stripe write without an explicit yes.
  if (!confirmed) {
    return NextResponse.json(
      { ...quote, confirmation_required: true, action, months, billsAt: isoOf(update.billsAt) },
      { status: 200 },
    );
  }

  let updated: Stripe.Subscription;
  try {
    // The SDK types `pause_collection` and `cancel_at` as Emptyable, which is
    // exactly what PauseUpdate builds ('' clears a field).
    updated = await stripe.subscriptions.update(subscription.id, update.params as Stripe.SubscriptionUpdateParams);
  } catch (err) {
    console.error('[billing/pause] stripe update failed:', err instanceof Error ? err.message : String(err));
    return fail(502, 'Could not change your subscription. Nothing was changed; please try again.', 'stripe_error');
  }

  const db = createServiceRoleClient();
  const facts = pauseFacts(updated, now);

  if (action === 'pause') {
    const keep = sanitizeKeepOrder(body.keepInboxIds);
    if (keep) await writePlanChangeColumns(db, user.id, { inbox_keep_order: keep });
  }

  // Email: receipt + reminder on pause; the reminder moves on extend; an early
  // resume cancels it. And a pause that replaced a cancel kills that series.
  if (lifecycleQueueingEnabled()) {
    try {
      if (quote.cancelScheduled && action === 'pause') {
        await cancelOpenSequence({
          db,
          stripeCustomerId: customerId,
          templates: ['cancel_ask', 'winback_14', 'winback_30'],
          reason: 'subscription_reactivated',
        });
      }
      // An unsent receipt carries the old dates: drop it on any change. An
      // extension then sends a fresh one, but only if the old one never went.
      const receiptReplaced =
        action === 'pause' ? 0 : await cancelUnsentPauseReceipt(db, customerId, 'pause_changed');
      if (action === 'resume_early') {
        await cancelPauseReminders(db, customerId, 'pause_changed');
      } else if (update.billsAt != null && update.pausedFrom != null) {
        const recipient = await resolveRecipient(db, user.email, user.id);
        if (recipient) {
          const payload: LifecyclePayload = {
            planId: facts.planId,
            amountCents: facts.amountCents,
            currency: facts.currency,
            pauseStartsAt: isoOf(update.pausedFrom),
            billingResumesAt: isoOf(update.billsAt),
            replacedCancel: action === 'pause' && quote.cancelScheduled,
            grandfathered: await isGrandfathered(db, user.id),
          };
          const target = { stripeCustomerId: customerId, userId: user.id, recipient };
          if (action === 'pause' || receiptReplaced > 0) {
            await queuePauseEmails({ db, target, subscriptionId: subscription.id, pausedFromSeconds: update.pausedFrom, billsAtSeconds: update.billsAt, payload, now });
          } else {
            await queuePauseReminder({ db, target, subscriptionId: subscription.id, billsAtSeconds: update.billsAt, payload, now });
          }
        }
      }
    } catch (err) {
      console.error('[billing/pause] email queue failed, swallowed:', err instanceof Error ? err.message : String(err));
    }
  }

  const workspaceId = await primaryWorkspaceId(db, user.id);
  if (workspaceId) {
    try {
      await recordProductFunnelEvent(db, {
        workspaceId,
        stage: update.stage,
        outcome: 'success',
        category: update.stage === 'pause_resumed' ? 'early' : facts.planId ?? 'unknown',
      });
    } catch (err) {
      console.error('[billing/pause] funnel write failed, swallowed:', err instanceof Error ? err.message : String(err));
    }
  }

  return NextResponse.json({ ...quoteBody(updated, now), changed: true, action, billsAt: isoOf(update.billsAt) }, { status: 200 });
}
