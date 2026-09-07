/**
 * POST /api/internal/billing-lifecycle/dispatch
 *
 * The billing lifecycle email dispatcher. Called by pg_cron every five minutes
 * (see supabase/migrations/20260902130100_schedule_billing_lifecycle.sql), it
 * claims whatever is due in `billing_email_sends` and sends it.
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
 * TWO MODES
 *   POST (default)     claim and send whatever is due.
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
 */

import { timingSafeEqual } from 'node:crypto';
import type Stripe from 'stripe';

import { stripe } from '@/lib/stripe/client';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { getPlanByStripePriceId } from '@/lib/stripe/plans';
import {
  composeBillingEmail,
  sendBillingLifecycleEmail,
  type BillingTemplate,
  type LifecyclePayload,
} from '@/lib/email/billing-lifecycle';
import {
  isGrandfathered,
  queueCardExpiryWarning,
  resolveRecipient,
  resolveUserId,
} from '@/lib/billing/lifecycle-queue';
import { isSuppressed } from '@/lib/email/lifecycle';
import { lifecycleMode } from '@/lib/billing/lifecycle-mode';
import {
  BATCH_SIZE,
  RETRY_REASON,
  budgetExhausted,
  checkFreshness,
} from '@/lib/billing/dispatch-freshness';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

interface QueueRow {
  id: number;
  stripe_customer_id: string;
  user_id: string | null;
  recipient: string;
  template: BillingTemplate;
  category: 'transactional' | 'marketing';
  scope_key: string;
  payload: LifecyclePayload;
  attempts: number;
}

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

  // Read at call time, never captured at module load: a warm lambda would
  // otherwise keep the value it booted with and the kill switch would need a
  // redeploy to take effect. See src/lib/billing/lifecycle-mode.ts.
  const lifecycle = lifecycleMode();
  if (lifecycle === 'off') {
    return Response.json({ skipped: 'BILLING_LIFECYCLE_EMAILS=off' }, { status: 200 });
  }

  const started = Date.now();
  const db = createServiceRoleClient();

  const { data: claimed, error } = await db.rpc('claim_billing_emails', {
    p_limit: BATCH_SIZE,
  });

  if (error) {
    console.error('[lifecycle-dispatch] claim failed:', error.message);
    return Response.json({ error: 'claim_failed' }, { status: 500 });
  }

  const rows = (claimed ?? []) as QueueRow[];
  const result = { claimed: rows.length, sent: 0, cancelled: 0, failed: 0, dryRun: 0 };

  // What `queue_only` is FOR. A count answers "did anything happen"; reviewing
  // a sequence before a customer sees one needs to know which email, to which
  // address, about which invoice. Recipients are masked because this lands in
  // a Vercel log line and a cron response body, neither of which is a place to
  // put a customer's address in full.
  const wouldSend: Array<{
    id: number;
    template: BillingTemplate;
    scope: string;
    to: string;
    subject: string | null;
  }> = [];

  for (const row of rows) {
    if (budgetExhausted(started, Date.now())) {
      // Leave the rest claimed; the lease expires and the next tick takes them.
      console.log('[lifecycle-dispatch] wall-clock budget reached; yielding.');
      break;
    }

    // ── Suppression + opt-out link, MARKETING ONLY ────────────────────────
    //
    // The `category` column is GENERATED from the template name in the
    // database, so a transactional row cannot reach this branch at all, no
    // matter what preferences the recipient has set. That is the whole point: a
    // customer who opted out of win-backs must still be told their card failed.
    //
    // The check reuses src/lib/email/lifecycle.ts rather than owning a second
    // opt-out mechanism, and it reads the preference HERE rather than trusting
    // the one that held when the row was queued, because the gap between
    // queueing a win-back and sending it is two weeks and that is exactly where
    // somebody clicks unsubscribe.
    if (row.category === 'marketing') {
      if (!row.user_id) {
        // No user row means no preferences to honour and no token to sign a
        // link with. Fail closed: marketing mail we cannot let them stop is
        // marketing mail we do not send.
        await finish(db, row.id, { cancelled: 'suppressed', error: 'no_user_row' });
        result.cancelled += 1;
        continue;
      }
      if (await isSuppressed(db, row.user_id, 'lifecycle')) {
        await finish(db, row.id, { cancelled: 'suppressed' });
        result.cancelled += 1;
        continue;
      }
      const { data: profile } = await db
        .from('users')
        .select('unsubscribe_token')
        .eq('id', row.user_id)
        .maybeSingle();
      if (!profile?.unsubscribe_token) {
        await finish(db, row.id, { cancelled: 'suppressed', error: 'no_unsubscribe_token' });
        result.cancelled += 1;
        continue;
      }
      // Injected fresh, never frozen into the queued payload, so a rotated
      // token cannot leave a dead opt-out link in an email sent a month later.
      row.payload = { ...(row.payload ?? {}), unsubscribeToken: profile.unsubscribe_token };
    }

    const fresh = await checkFreshness(stripe, row);
    if (!fresh.send) {
      if (fresh.reason === RETRY_REASON) continue; // leave it; lease expires
      await finish(db, row.id, { cancelled: fresh.reason });
      result.cancelled += 1;
      continue;
    }

    if (lifecycle !== 'on') {
      // queue_only: everything above ran for real against real Stripe data, and
      // this is where a customer would have received something. Compose it
      // anyway, so the subject line in the report is the one that would have
      // been used and a template that cannot compose shows up here rather than
      // on the day the switch is flipped.
      const composed = composeBillingEmail(row.template, row.payload ?? {});
      wouldSend.push({
        id: row.id,
        template: row.template,
        scope: row.scope_key,
        to: maskAddress(row.recipient),
        subject: composed?.subject ?? null,
      });
      // Release the claim so the row stays visible and due for inspection.
      await db
        .from('billing_email_sends')
        .update({ claimed_at: null, attempts: Math.max(0, row.attempts - 1) })
        .eq('id', row.id);
      result.dryRun += 1;
      continue;
    }

    const send = await sendBillingLifecycleEmail({
      to: row.recipient,
      template: row.template,
      scopeKey: row.scope_key,
      payload: row.payload ?? {},
    });

    if (send.ok) {
      await finish(db, row.id, { sent: send.resendId });
      result.sent += 1;
    } else if (send.reason === 'unusable_recipient' || send.reason === 'not_composable') {
      // Permanent. Retrying cannot help, so stop rather than burn five attempts.
      await finish(db, row.id, { cancelled: 'undeliverable', error: send.reason });
      result.cancelled += 1;
    } else {
      await db
        .from('billing_email_sends')
        .update({ last_error: send.reason, claimed_at: null })
        .eq('id', row.id);
      result.failed += 1;
    }
  }

  console.log('[lifecycle-dispatch]', JSON.stringify({ ...result, wouldSend }));
  return Response.json(
    { ok: true, mode: lifecycle, ...result, ...(wouldSend.length ? { wouldSend } : {}) },
    { status: 200 },
  );
}

/**
 * `asgeir@mcpemails.com` to `a****r@mcpemails.com`. Enough to recognise an
 * address you already know, not enough to be a customer list in a log file.
 */
function maskAddress(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '****';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 2) return `${local[0] ?? '*'}****${domain}`;
  return `${local[0]}****${local[local.length - 1]}${domain}`;
}

async function finish(
  db: ReturnType<typeof createServiceRoleClient>,
  id: number,
  outcome: { sent?: string | null } | { cancelled: string; error?: string },
): Promise<void> {
  const patch =
    'cancelled' in outcome
      ? {
          cancelled_at: new Date().toISOString(),
          cancel_reason: outcome.cancelled,
          ...(outcome.error ? { last_error: outcome.error } : {}),
        }
      : { sent_at: new Date().toISOString(), resend_id: outcome.sent ?? null };

  const { error } = await db.from('billing_email_sends').update(patch).eq('id', id);
  if (error) {
    // The email is already gone. Loud, because a row stuck unsent-but-delivered
    // is the one state that could produce a duplicate on a later lease expiry.
    // The Resend Idempotency-Key is what stops that becoming a second email.
    console.error(`[lifecycle-dispatch] could not finish row ${id}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Card expiry sweep
// ---------------------------------------------------------------------------

/**
 * Queue card-expiry warnings. Runs daily.
 *
 * WHY A SWEEP AND NOT AN EVENT. Stripe emits `customer.source.expiring` for
 * legacy Sources, thirty days out, and every card in this account is a
 * PaymentMethod, for which no such event exists. There is no webhook that says
 * "this card expires next month", so the only honest implementation is to look.
 * At the current subscription count that is one API call.
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
    const subs = await stripe.subscriptions.list({
      status: 'active',
      limit: 100,
      expand: ['data.default_payment_method'],
    });

    for (const subscription of subs.data) {
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

      const item = subscription.items.data[0];
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
