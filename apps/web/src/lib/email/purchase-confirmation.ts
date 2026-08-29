/**
 * Purchase confirmation email.
 *
 * Sent once, on the initial purchase only, when a customer completes Stripe
 * Checkout for a paid plan. Stripe does not fill this gap: it sends no receipt
 * at all for a $0 invoice (a 100%-off comp or a fully discounted first period),
 * and even when it does send one, a Stripe receipt is a finance document, not a
 * welcome that tells the customer what they can now do.
 *
 * HOW IT SENDS: Resend, the same provider and the same verified
 * @mcpemails.com domain that already carries the workspace invite email (see
 * send-invite.ts). Nothing new has to be configured for this to work.
 *
 * WHY NOT OUR OWN MCP ENDPOINT. An earlier version of this file dogfooded the
 * product by sending through https://mcpemails.com/api/mcp. Two things killed
 * that. First, it needed a `send:email` API key that has never existed in
 * production, so in practice it sent nothing at all. Second, the brand address
 * hello@mcpemails.com sits on Migadu, which has a measured ~5.6% intermittent
 * raw-SMTP failure rate (documented in
 * supabase/functions/synthetic-monitor/index.ts, and the reason that monitor
 * deliberately alerts from a Gmail-connected inbox instead). Roughly 1 paying
 * customer in 300 silently receiving no confirmation is not an acceptable
 * transactional path. Resend keeps the brand From address without the Migadu
 * SMTP hop.
 *
 * ONE ATTEMPT, DELIBERATELY. The old two-attempt loop existed to paper over
 * Migadu's SMTP flakiness. Resend is an HTTPS API call, so that reason is gone,
 * and a blind retry after a lost response is how a paying customer gets two
 * confirmations. Duplicate suppression is therefore Stripe-side: the
 * `stripe_webhook_events` ledger rejects a redelivered event id, and this send
 * is the last thing the webhook handler does, so a redelivery never reaches it
 * (see the idempotency note in app/api/stripe/webhook/route.ts). As a second
 * layer that costs nothing, the send also carries a Resend `Idempotency-Key`
 * derived from the Checkout session id. A missed confirmation is recoverable; a
 * duplicate charge-confirmation is not.
 *
 * ENVIRONMENT (all read at call time, never at module load):
 *   RESEND_API_KEY             Resend API key. Already set in Vercel Production
 *                              and Preview. Missing key = no send, logged,
 *                              never thrown.
 *   PURCHASE_EMAIL_FROM        OPTIONAL override for the sender.
 *                              Default: MCP Emails <hello@mcpemails.com>.
 *                              Deliberately NOT RESEND_FROM_EMAIL, which is
 *                              the invite sender (invites@mcpemails.com) and
 *                              is wrong on a purchase confirmation.
 *   NEXT_PUBLIC_APP_URL        Base URL for the dashboard links.
 *
 * LOCALE. English only, deliberately. The customer's chosen interface language
 * is persisted to localStorage by AppLocaleProvider and never reaches the
 * server, and a Stripe webhook has no request context to read it from anyway.
 * `workspaces.acquisition_locale` is the one server-side signal that exists,
 * but it records the locale of the landing page at signup, not a language
 * choice, and it is nullable. Rather than infer a language from an attribution
 * field, this email is English and says nothing it cannot back up.
 *
 * NEVER MENTION the monthly tool-call ceiling. It is a silent abuse ceiling,
 * not a pricing lever, and it must not appear in customer-facing copy.
 */

import { Resend } from 'resend';

import { PLANS, planDisplayName, type BillingInterval, type PlanId } from '@/lib/stripe/plans';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SUPPORT_ADDRESS = 'hello@mcpemails.com';
const DEFAULT_FROM = `MCP Emails <${SUPPORT_ADDRESS}>`;
const DEFAULT_APP_URL = 'https://mcpemails.com';

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? DEFAULT_APP_URL).replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Composition (pure, and unit-testable without sending anything)
// ---------------------------------------------------------------------------

export interface PurchaseConfirmationInput {
  /** Paid plan the customer actually bought. `free` is not a purchase. */
  planId: Exclude<PlanId, 'free'>;
  /** Billing interval, resolved from the Stripe price where possible. */
  interval: BillingInterval;
  /** What Stripe actually charged, in minor units. Null falls back to the catalogue. */
  amountTotalCents: number | null;
  /** ISO currency from the Stripe session. Null defaults to USD. */
  currency: string | null;
}

export interface ComposedEmail {
  subject: string;
  body: string;
  htmlBody: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Format minor units as a currency string, e.g. 500 + 'usd' -> "$5.00". */
export function formatAmount(amountCents: number, currency: string): string {
  const code = (currency || 'usd').toUpperCase();
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(
      amountCents / 100,
    );
  } catch {
    // Unknown currency code: never fail composition over formatting.
    return `${(amountCents / 100).toFixed(2)} ${code}`;
  }
}

/**
 * The one line that explains the value metric in the customer's own terms.
 * Inboxes are what they are paying for, so the jump from Free is stated
 * explicitly rather than left for them to work out.
 */
function inboxHeadline(planId: Exclude<PlanId, 'free'>): string {
  const max = PLANS[planId].limits.maxInboxes;
  const free = PLANS.free.limits.maxInboxes;
  const now = Number.isFinite(max) ? `${max} connected inboxes` : 'Unlimited connected inboxes';
  return `${now}, up from ${free} on Free.`;
}

/**
 * Build the confirmation email.
 *
 * Everything customer-visible about the plan comes from the catalogue:
 * `planDisplayName` because the internal ids do not match what we sell
 * (`solo` is sold as "Pro", `pro` is sold as "Team"), and `plan.features`
 * because that copy is already reviewed, already consistent with the pricing
 * page, and already free of the silent action ceiling.
 */
export function buildPurchaseConfirmationEmail(input: PurchaseConfirmationInput): ComposedEmail {
  const { planId, interval } = input;
  const plan = PLANS[planId];
  const name = planDisplayName(planId);

  const catalogueCents =
    interval === 'year' ? plan.yearlyPriceCents ?? plan.monthlyPriceCents : plan.monthlyPriceCents;
  const cents = input.amountTotalCents ?? catalogueCents;
  const price = `${formatAmount(cents, input.currency ?? 'usd')} per ${interval === 'year' ? 'year' : 'month'}`;

  const base = appUrl();
  const inboxesUrl = `${base}/dashboard/inboxes`;
  const billingUrl = `${base}/dashboard/settings`;

  const subject = `Your MCPEmails ${name} subscription is active`;

  const features = plan.features;

  const body = [
    `Thanks for subscribing. Your ${name} plan is active now, so there is nothing to wait for.`,
    '',
    'WHAT YOU BOUGHT',
    `Plan: ${name}`,
    `Price: ${price}`,
    '',
    'WHAT YOU GET',
    inboxHeadline(planId),
    ...features.map((feature) => `- ${feature}`),
    '',
    'CONNECT YOUR NEXT INBOX',
    'Your agent can only reach the mailboxes you connect, so the plan is worth',
    'what you plug into it. Add the next one here:',
    inboxesUrl,
    '',
    'MANAGE YOUR SUBSCRIPTION',
    'Change plan, update your card, or cancel at any time. No email to us needed,',
    'and cancelling takes effect at the end of the period you have already paid for:',
    billingUrl,
    '',
    `Questions, or something looks wrong? Reply to this email or write to ${SUPPORT_ADDRESS}.`,
    'A person reads it.',
    '',
    'MCPEmails',
    base,
  ].join('\n');

  const featureItems = features
    .map(
      (feature) =>
        `<li style="margin:0 0 6px;font-size:15px;color:#334155;line-height:1.5;">${escapeHtml(feature)}</li>`,
    )
    .join('');

  const htmlBody = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
          <tr>
            <td style="background:#0f172a;padding:28px 40px;">
              <span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:-0.3px;">MCPEmails</span>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 40px 8px;">
              <p style="margin:0 0 6px;font-size:22px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">
                Your ${escapeHtml(name)} plan is active
              </p>
              <p style="margin:0 0 24px;font-size:15px;color:#64748b;line-height:1.5;">
                Thanks for subscribing. It is live on your account now, so there is nothing to wait for.
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;margin:0 0 24px;">
                <tr>
                  <td style="padding:14px 18px;font-size:14px;color:#64748b;">Plan</td>
                  <td style="padding:14px 18px;font-size:14px;color:#0f172a;font-weight:600;" align="right">${escapeHtml(name)}</td>
                </tr>
                <tr>
                  <td style="padding:0 18px 14px;font-size:14px;color:#64748b;">Price</td>
                  <td style="padding:0 18px 14px;font-size:14px;color:#0f172a;font-weight:600;" align="right">${escapeHtml(price)}</td>
                </tr>
              </table>
              <p style="margin:0 0 8px;font-size:16px;font-weight:700;color:#0f172a;">What you get</p>
              <p style="margin:0 0 10px;font-size:15px;color:#0f172a;line-height:1.5;font-weight:600;">
                ${escapeHtml(inboxHeadline(planId))}
              </p>
              <ul style="margin:0 0 26px;padding:0 0 0 20px;">${featureItems}</ul>
              <p style="margin:0 0 8px;font-size:16px;font-weight:700;color:#0f172a;">Connect your next inbox</p>
              <p style="margin:0 0 18px;font-size:15px;color:#64748b;line-height:1.5;">
                Your agent can only reach the mailboxes you connect, so the plan is worth what you plug into it.
              </p>
              <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
                <tr>
                  <td style="background:#0f172a;border-radius:8px;">
                    <a href="${inboxesUrl}" style="display:inline-block;padding:12px 28px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">
                      Connect an inbox
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 8px;font-size:16px;font-weight:700;color:#0f172a;">Manage your subscription</p>
              <p style="margin:0 0 28px;font-size:15px;color:#64748b;line-height:1.5;">
                Change plan, update your card, or cancel at any time from
                <a href="${billingUrl}" style="color:#3b82f6;">your dashboard</a>.
                Cancelling takes effect at the end of the period you have already paid for.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #e2e8f0;">
              <p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">
                Questions, or something looks wrong? Reply to this email or write to
                <a href="mailto:${SUPPORT_ADDRESS}" style="color:#3b82f6;">${SUPPORT_ADDRESS}</a>. A person reads it.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, body, htmlBody };
}

// ---------------------------------------------------------------------------
// Sending (via Resend)
// ---------------------------------------------------------------------------

/**
 * Same construction as send-invite.ts: the key is read at call time, never at
 * module load, so a missing key is a runtime decision here rather than an
 * import-time crash.
 */
function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  return key ? new Resend(key) : null;
}

/** Keep anything unexpected out of the logs verbatim; short safe strings only. */
function safeCode(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9_.:\- ]{1,120}$/i.test(value)
    ? value
    : 'unexpected_response';
}

export interface SendPurchaseConfirmationInput extends PurchaseConfirmationInput {
  /** The purchaser's email address, from the Stripe Checkout session. */
  to: string;
  /** Stripe Checkout session id. Logged so a send can be traced to a purchase. */
  sessionId: string;
}

/**
 * Send the confirmation. NEVER THROWS, and never rejects.
 *
 * Every failure path here (missing key, unusable recipient, Resend error,
 * network failure) is logged and swallowed. A customer must get the plan they
 * paid for whether or not the welcome mail lands, so this function is
 * deliberately incapable of failing the caller.
 *
 * It also never retries; see the "ONE ATTEMPT, DELIBERATELY" note at the top of
 * this file. Duplicate suppression is the webhook's event ledger, backed up by
 * the per-session Resend Idempotency-Key sent below.
 */
export async function sendPurchaseConfirmationEmail(
  input: SendPurchaseConfirmationInput,
): Promise<void> {
  try {
    const resend = getResend();
    if (!resend) {
      console.error('[purchase-email] no RESEND_API_KEY configured; skipping confirmation email');
      return;
    }

    const to = input.to?.trim() ?? '';
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
      console.error('[purchase-email] no usable recipient on the checkout session; skipping');
      return;
    }

    const from = process.env.PURCHASE_EMAIL_FROM ?? DEFAULT_FROM;
    const { subject, body, htmlBody } = buildPurchaseConfirmationEmail(input);

    const { error } = await resend.emails.send(
      {
        from,
        to,
        replyTo: SUPPORT_ADDRESS,
        subject,
        html: htmlBody,
        text: body,
      },
      // Belt and braces on top of the Stripe-side guard: Resend collapses two
      // sends carrying the same Idempotency-Key, so even a replay from some
      // other code path within its window delivers one email, not two.
      { idempotencyKey: `purchase-confirmation-${input.sessionId}`.slice(0, 256) },
    );

    if (error) {
      // Loud, but contained. A confirmation path failing is otherwise
      // completely invisible, and this is the only signal that it is.
      console.error(
        `[purchase-email] confirmation FAILED (session ${input.sessionId}, plan ${input.planId}): ${safeCode(error.message)}`,
      );
      return;
    }

    console.log(
      `[purchase-email] confirmation sent for plan "${input.planId}" (session ${input.sessionId})`,
    );
  } catch (err) {
    // Belt and braces: nothing in this module may escape to the webhook.
    console.error('[purchase-email] unexpected failure, swallowed:', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
