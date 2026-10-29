/**
 * POST /api/internal/billing-lifecycle/dispatch
 *
 * The billing lifecycle email dispatcher's cron entry point and fallback.
 *
 * WHEN EMAILS GO OUT. A row due immediately (cancel_ask, pause_started, the
 * first dunning email, the Free allowance notices) is sent right away: the web
 * request that queued it dispatches exactly those rows after its response
 * (src/lib/billing/dispatch-kick.ts), and the mcp-server POSTs here with
 * `?mode=emails` after it queues an allowance notice. pg_cron still calls this
 * route every five minutes (supabase/migrations/20260902130100_schedule_billing_lifecycle.sql)
 * and claims whatever is due, which sends the scheduled rows (reminders,
 * win-backs, later dunning steps) and retries anything a kick missed. Both
 * paths share src/lib/billing/lifecycle-dispatch.ts and claim atomically, so a
 * row is never sent twice.
 *
 * WHY IT LIVES IN THE WEB APP AND NOT IN THE EDGE FUNCTION
 * -------------------------------------------------------
 * The other two pg_cron dispatchers in this project (scheduled sends, triage)
 * poke the mcp-server Edge Function, and copying them would have been the
 * obvious move. It would also have put nine email templates, the plan
 * catalogue, the Resend client and the Stripe SDK into a Deno runtime that has
 * none of them, and left the copy for a dunning email in a different language
 * and a different deploy pipeline from the copy for the purchase confirmation
 * it has to sound like. Every dependency this route needs already exists here.
 *
 * THREE MODES
 *   POST (default)     re-project due plan changes, then claim and send
 *                      whatever is due.
 *   POST ?mode=emails  claim and send whatever is due, nothing else (the
 *                      mcp-server's kick).
 *   POST ?mode=sweep   scan active subscriptions for cards that are about to
 *                      expire and QUEUE the warnings. Sends nothing itself.
 *                      Runs once a day.
 *
 * AUTH. `X-Dispatch-Secret`, compared in constant time against DISPATCH_SECRET,
 * exactly as the Edge Function's /dispatch and /triage-dispatch routes. It
 * reuses the same secret value on purpose: both are cron-only entry points
 * owned by the same person, neither accepts a body that steers what it does,
 * and minting a second secret would mean a second out-of-band Vault
 * provisioning step that nothing can verify was done. See the WHY IT REUSES
 * THE EXISTING 'dispatch_secret' note in 20260819190000_schedule_triage_dispatch.sql.
 *
 * THE SEND IS GATED TWICE.
 *   BILLING_LIFECYCLE_EMAILS must be `on`. At `queue_only` this route reports
 *   exactly what it WOULD have sent and sends nothing, which is how the
 *   sequences get reviewed against real Stripe events before any customer sees
 *   one.
 *
 * FRESHNESS. Every claimed row is re-checked against Stripe immediately before
 * its send, and cancelled if the world has moved on. This is what makes the
 * schedule safe regardless of how Stripe's retry schedule is configured: the
 * question is never "has the retry probably happened by now", it is "is this
 * invoice still unpaid, right now". A dunning email that arrives after the
 * money was taken is worse than no dunning at all, and it is the one failure
 * mode a fixed calendar cannot rule out.
 *
 * TWO WAYS A ROW IS KEYED. The billing rows carry `stripe_customer_id` and are
 * unique on (customer, template, scope_key). The three Free allowance notices
 * (usage_warning_80, usage_limit_reached, automation_paused_limit) are queued
 * by the mcp-server edge function for owners who may have no Stripe customer
 * at all, so they carry `workspace_id` and `period_start` instead, with
 * `stripe_customer_id` NULL, and are unique on (workspace, template, period).
 * The recipient was frozen at queue time on both kinds, so this route resolves
 * nothing further; it only asks whether the notice is still true. For a usage
 * row that question goes to `workspace_action_allowance`, not to Stripe: if
 * the workspace has since been exempted or upgraded the cap is gone and the
 * email would tell a new Personal customer that their actions are refused.
 */

import { timingSafeEqual } from 'node:crypto';
import type Stripe from 'stripe';

import { stripe } from '@/lib/stripe/client';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { basePlanItem, getPlanByStripePriceId } from '@/lib/stripe/plans';
import {
  isGrandfathered,
  queueCardExpiryWarning,
  resolveRecipient,
  resolveUserId,
} from '@/lib/billing/lifecycle-queue';
import { dispatchBillingEmails } from '@/lib/billing/lifecycle-dispatch';
import { lifecycleMode } from '@/lib/billing/lifecycle-mode';
import { reprojectDuePlanChanges } from '@/lib/billing/plan-change-reproject';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function authorised(request: Request): boolean {
  const expected = process.env.DISPATCH_SECRET;
  if (!expected) {
    console.error('[lifecycle-dispatch] DISPATCH_SECRET is not set; refusing every request.');
    return false;
  }
  const provided = request.headers.get('x-dispatch-secret') ?? '';
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  // Length is not secret, and timingSafeEqual throws on a mismatch.
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<Response> {
  if (!authorised(request)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const mode = new URL(request.url).searchParams.get('mode');
  if (mode === 'sweep') return sweepExpiringCards();

  // The pause / downgrade fallback, before the email kill switch on purpose:
  // it moves entitlement, not mail, and must run with lifecycle email off.
  // Never throws. See src/lib/billing/plan-change-reproject.ts. Skipped for
  // `?mode=emails`, the mcp-server's kick after it queues an allowance notice:
  // that caller only wants the email out, and the cron still runs this.
  const planChanges =
    mode === 'emails' ? undefined : await reprojectDuePlanChanges(createServiceRoleClient(), stripe);

  // The claim, the freshness checks, the kill switch and the send all live
  // in src/lib/billing/lifecycle-dispatch.ts, shared with the immediate kick.
  const outcome = await dispatchBillingEmails({ db: createServiceRoleClient(), stripe });

  if (!outcome.ok) {
    return Response.json({ error: outcome.error }, { status: 500 });
  }
  if ('skipped' in outcome) {
    return Response.json({ skipped: outcome.skipped, planChanges }, { status: 200 });
  }

  const { wouldSend, ...result } = outcome;
  console.log('[lifecycle-dispatch]', JSON.stringify({ ...result, wouldSend }));
  return Response.json(
    { ...result, ...(wouldSend.length ? { wouldSend } : {}) },
    { status: 200 },
  );
}

// ---------------------------------------------------------------------------
// Card expiry sweep
// ---------------------------------------------------------------------------

/** Upper bound on one sweep, so a runaway pager cannot loop forever. */
const CARD_SWEEP_MAX_SCANNED = 5000;

/**
 * Queue card-expiry warnings. Runs daily.
 *
 * WHY A SWEEP AND NOT AN EVENT. Stripe emits `customer.source.expiring` for
 * legacy Sources, thirty days out, and every card in this account is a
 * PaymentMethod, for which no such event exists. There is no webhook that says
 * "this card expires next month", so the only honest implementation is to look.
 * One list call per 100 active subscriptions, auto-paginated.
 *
 * The two windows do not overlap: a card with five days left gets the seven-day
 * warning only, never both on the same morning.
 */
async function sweepExpiringCards(): Promise<Response> {
  if (lifecycleMode() === 'off') {
    return Response.json({ skipped: 'BILLING_LIFECYCLE_EMAILS=off' }, { status: 200 });
  }

  const db = createServiceRoleClient();
  const result = { scanned: 0, queued30: 0, queued7: 0, skipped: 0 };

  try {
    // Auto-pagination: one list call returns only its first page (100), and
    // there are more active subscriptions than that. The iterator fetches the
    // next page as the loop reaches it.
    const subscriptions = stripe.subscriptions.list({
      status: 'active',
      limit: 100,
      expand: ['data.default_payment_method'],
    });

    for await (const subscription of subscriptions) {
      if (result.scanned >= CARD_SWEEP_MAX_SCANNED) {
        console.warn('[lifecycle-dispatch] card sweep stopped at the scan cap', {
          cap: CARD_SWEEP_MAX_SCANNED,
        });
        break;
      }
      result.scanned += 1;

      const card = await resolveCard(subscription);
      if (!card?.exp_month || !card.exp_year) {
        result.skipped += 1;
        continue;
      }

      // A card is valid through the END of its expiry month.
      const expiresAt = Date.UTC(card.exp_year, card.exp_month, 1);
      const days = Math.floor((expiresAt - Date.now()) / 86_400_000);

      let template: 'card_expiry_30' | 'card_expiry_7' | null = null;
      if (days >= 0 && days <= 7) template = 'card_expiry_7';
      else if (days >= 8 && days <= 34) template = 'card_expiry_30';

      if (!template) {
        result.skipped += 1;
        continue;
      }

      const customerId =
        typeof subscription.customer === 'string'
          ? subscription.customer
          : subscription.customer.id;

      const userId = await resolveUserId(db, customerId, subscription.metadata?.user_id ?? null);
      const customer = await stripe.customers.retrieve(customerId);
      const email = customer.deleted ? null : customer.email;
      const recipient = await resolveRecipient(db, email, userId);
      if (!recipient) {
        result.skipped += 1;
        continue;
      }

      // The plan's own item: a Business subscription also carries the
      // per-mailbox add-on, and Stripe does not promise which comes first.
      const item = basePlanItem(subscription.items.data);
      const resolved = item?.price?.id ? getPlanByStripePriceId(item.price.id) : null;

      const queued = await queueCardExpiryWarning({
        db,
        target: { stripeCustomerId: customerId, userId, recipient },
        template,
        paymentMethodId: card.id,
        expiryKey: `${card.exp_month}/${card.exp_year}`,
        payload: {
          planId: resolved?.plan.id ?? null,
          amountCents: item?.price?.unit_amount ?? null,
          currency: subscription.currency ?? null,
          cardBrand: card.brand ? card.brand.charAt(0).toUpperCase() + card.brand.slice(1) : null,
          cardLast4: card.last4 ?? null,
          cardExpiry: `${String(card.exp_month).padStart(2, '0')}/${card.exp_year}`,
          grandfathered: await isGrandfathered(db, userId),
        },
      });

      if (queued > 0) {
        if (template === 'card_expiry_7') result.queued7 += 1;
        else result.queued30 += 1;
      } else {
        result.skipped += 1;
      }
    }
  } catch (err) {
    console.error('[lifecycle-dispatch] card expiry sweep failed:', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json({ error: 'sweep_failed', ...result }, { status: 500 });
  }

  console.log('[lifecycle-dispatch] card sweep', JSON.stringify(result));
  return Response.json({ ok: true, ...result }, { status: 200 });
}

interface ResolvedCard {
  id: string;
  brand?: string | null;
  last4?: string | null;
  exp_month?: number | null;
  exp_year?: number | null;
}

/**
 * The card that will actually be charged: the subscription's own default if it
 * has one, otherwise the customer's invoice default. Stripe falls back the same
 * way at charge time, so warning about any other card would be warning about a
 * card that is not the problem.
 */
async function resolveCard(subscription: Stripe.Subscription): Promise<ResolvedCard | null> {
  const direct = subscription.default_payment_method;
  if (direct && typeof direct !== 'string' && direct.card) {
    return { id: direct.id, ...direct.card };
  }
  if (typeof direct === 'string') {
    const pm = await stripe.paymentMethods.retrieve(direct);
    return pm.card ? { id: pm.id, ...pm.card } : null;
  }

  const customerId =
    typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) return null;
  const fallback = customer.invoice_settings?.default_payment_method;
  const id = typeof fallback === 'string' ? fallback : fallback?.id;
  if (!id) return null;
  const pm = await stripe.paymentMethods.retrieve(id);
  return pm.card ? { id: pm.id, ...pm.card } : null;
}
