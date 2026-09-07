/**
 * Billing lifecycle email: dunning, card expiry, cancellation save, win-back.
 *
 * Nine templates in two categories, and the split between them is the most
 * important thing in this file.
 *
 * TRANSACTIONAL (dunning_1/3/7/14, card_expiry_30/7, cancel_ask)
 *   Service messages about a broken or about-to-break payment on a contract the
 *   customer is already in. They need no opt-in and they are NOT suppressible.
 *   A customer who unsubscribed from a win-back in March must still be told in
 *   June that their card was declined; the alternative is taking their money,
 *   failing to take their money, and telling them neither.
 *
 * MARKETING-ADJACENT (winback_14, winback_30)
 *   Sent to somebody who has already left. Carries List-Unsubscribe and
 *   List-Unsubscribe-Post for one-click opt-out, and the dispatcher checks
 *   `users.unsubscribed_at` / `unsubscribed_categories` before every send.
 *
 * The two categories cannot be confused by accident: `billing_email_sends`
 * derives `category` from the template name in a GENERATED column, so
 * `dunning_1` is structurally incapable of being marketing, and this module
 * refuses to attach an unsubscribe header to a transactional template.
 *
 * HOW IT SENDS. Resend, exactly as src/lib/email/purchase-confirmation.ts,
 * whose header comment is the reference for this one: one attempt, never a
 * retry, an Idempotency-Key derived from what the email is ABOUT, every failure
 * logged and swallowed. Read that file first. The reasoning there about why not
 * to send through our own MCP endpoint (a Migadu SMTP hop with a measured ~5.6%
 * failure rate) applies here with more force: a purchase confirmation that
 * silently fails costs goodwill, a dunning email that silently fails costs the
 * subscription.
 *
 * WHY BILLING NOTICES COME FROM hello@ AND WIN-BACKS DO NOT.
 * The transactional templates use the same brand address as the purchase
 * confirmation, deliberately. The customer has seen that From line before, on
 * the one email from us they definitely opened, and "the address that confirmed
 * your purchase" is the address you want on "your card was declined". The
 * win-backs go out from the lifecycle address instead, so a reply to one lands
 * with a person rather than in the support mailbox.
 *
 * THAT SPLIT DOES NOT ISOLATE SENDER REPUTATION, and an earlier version of this
 * comment claimed it did. Mailbox providers score the sending DOMAIN, and
 * Resend has only `mcpemails.com` verified (checked 2026-09-07), so hello@ and
 * asgeir@ share one domain and one DKIM key. Spam complaints on a win-back
 * would follow the purchase confirmation. Real isolation needs a separate
 * subdomain verified in Resend with its own DKIM. At two win-backs to a handful
 * of churned customers that is not yet worth the DNS, but nothing here should
 * be read as protection that exists.
 *
 * ENVIRONMENT (all read at call time, never at module load):
 *   RESEND_API_KEY        Resend API key. Missing = no send, logged, not thrown.
 *   BILLING_EMAIL_FROM    OPTIONAL. Default: MCP Emails <hello@mcpemails.com>.
 *   LIFECYCLE_EMAIL_FROM  OPTIONAL, read via lifecycleFrom() in
 *                         src/lib/email/lifecycle.ts. The win-back sender.
 *   CANCEL_REPLY_TO       OPTIONAL. Where "what stopped working for you?" lands.
 *                         Default: hello@mcpemails.com.
 *
 * The win-backs additionally require the recipient's `users.unsubscribe_token`
 * in the payload. Without one, composition returns null and nothing is sent:
 * no opt-out link means no marketing mail, which is the correct direction to
 * fail in.
 *   NEXT_PUBLIC_APP_URL   Base URL for the dashboard links.
 *
 * LOCALE. English only, for the same reason as the purchase confirmation: the
 * customer's interface language never reaches the server and a Stripe webhook
 * has no request context to read one from.
 *
 * NEVER MENTION the monthly tool-call ceiling. It is a silent abuse ceiling,
 * not a pricing lever, and it must not appear in customer-facing copy.
 */

import { Resend } from 'resend';

import { PLANS, planDisplayName, type PlanId } from '@/lib/stripe/plans';
import { formatAmount } from '@/lib/email/purchase-confirmation';
import { lifecycleFrom, unsubscribeUrl } from '@/lib/email/lifecycle';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SUPPORT_ADDRESS = 'hello@mcpemails.com';
const DEFAULT_BILLING_FROM = `MCP Emails <${SUPPORT_ADDRESS}>`;
const DEFAULT_APP_URL = 'https://mcpemails.com';

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? DEFAULT_APP_URL).replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const BILLING_TEMPLATES = [
  'dunning_1',
  'dunning_3',
  'dunning_7',
  'dunning_14',
  'card_expiry_30',
  'card_expiry_7',
  'cancel_ask',
  'winback_14',
  'winback_30',
] as const;

export type BillingTemplate = (typeof BILLING_TEMPLATES)[number];

export type BillingCategory = 'transactional' | 'marketing';

/**
 * The category rule, mirrored from the GENERATED column in
 * 20260902130000_billing_lifecycle_emails.sql. Both must agree. The database is
 * the authority; this exists so the sender can decide, without a round trip,
 * whether an unsubscribe header belongs on the message.
 */
export function categoryOf(template: BillingTemplate): BillingCategory {
  return template.startsWith('winback_') ? 'marketing' : 'transactional';
}

/** Offsets from the triggering event, in days. Row 0 is queued due immediately. */
export const DUNNING_SCHEDULE: ReadonlyArray<{ template: BillingTemplate; dayOffset: number }> = [
  { template: 'dunning_1', dayOffset: 0 },
  { template: 'dunning_3', dayOffset: 3 },
  { template: 'dunning_7', dayOffset: 7 },
  { template: 'dunning_14', dayOffset: 14 },
];

/** Offsets from the date the paid period ENDS, in days. */
export const WINBACK_SCHEDULE: ReadonlyArray<{ template: BillingTemplate; dayOffset: number }> = [
  { template: 'winback_14', dayOffset: 14 },
  { template: 'winback_30', dayOffset: 30 },
];

// ---------------------------------------------------------------------------
// Decline reasons
// ---------------------------------------------------------------------------

/**
 * Stripe decline code to a sentence a human wrote.
 *
 * Two rules govern this table.
 *
 * SAY ONLY WHAT THE BANK SAID. Stripe's decline codes are the issuer's own
 * reason, relayed. Where the code is specific and safe we repeat it, because a
 * customer who is told "not enough in the account" fixes it in a minute and a
 * customer told "your payment failed" has to go and find out why.
 *
 * NEVER ACCUSE. `lost_card`, `stolen_card`, `pickup_card` and the fraud codes
 * are deliberately mapped to neutral text. The issuer's classification can be
 * wrong, the person reading the email may not be the person who reported the
 * card, and being told by a vendor that your card is stolen is alarming in a
 * way that helps nobody pay an invoice. They are told the card cannot be used
 * and to try another one, which is the actionable part and is true either way.
 */
interface DeclineCopy {
  /** One sentence, lower case start, completes "Your bank said: ...". */
  reason: string;
  /** What the customer should actually do about it. */
  fix: string;
}

const DECLINE_COPY: Record<string, DeclineCopy> = {
  insufficient_funds: {
    reason: 'there was not enough in the account',
    fix: 'Topping the account up is usually enough, and the retry will pick it up on its own. If you would rather use a different card, you can swap it here.',
  },
  expired_card: {
    reason: 'the card has expired',
    fix: 'The card needs replacing with the current one. It takes about a minute.',
  },
  incorrect_cvc: {
    reason: 'the security code did not match',
    fix: 'Re-entering the card with the CVC from the back of it fixes this.',
  },
  invalid_cvc: {
    reason: 'the security code did not match',
    fix: 'Re-entering the card with the CVC from the back of it fixes this.',
  },
  incorrect_number: {
    reason: 'the card number was not recognised',
    fix: 'Re-entering the card number fixes this.',
  },
  invalid_expiry_month: {
    reason: 'the expiry date on the card did not match',
    fix: 'Re-entering the card with the correct expiry fixes this.',
  },
  invalid_expiry_year: {
    reason: 'the expiry date on the card did not match',
    fix: 'Re-entering the card with the correct expiry fixes this.',
  },
  authentication_required: {
    reason: 'they want you to confirm this one personally',
    fix: 'Your bank needs you to approve the charge, usually in their app or by SMS. Starting the payment again from the link below will trigger that prompt.',
  },
  card_not_supported: {
    reason: 'this card cannot be used for a recurring subscription',
    fix: 'Another card, or a card from a different issuer, will work. Some prepaid and virtual cards refuse subscriptions outright.',
  },
  currency_not_supported: {
    reason: 'the card cannot be charged in US dollars',
    fix: 'A card that accepts USD will work. Most do, but some regional cards do not.',
  },
  withdrawal_count_limit_exceeded: {
    reason: 'the card has hit a spending limit',
    fix: 'The limit usually resets on its own, and the retry will pick it up. A different card works immediately.',
  },
  do_not_honor: {
    reason: 'they declined it without giving a reason',
    fix: 'This one is worth a call to your bank, because we cannot see anything more than you can. A different card will also work.',
  },
  transaction_not_allowed: {
    reason: 'they declined it without giving a reason',
    fix: 'This one is worth a call to your bank, because we cannot see anything more than you can. A different card will also work.',
  },
  try_again_later: {
    reason: 'to try again shortly',
    fix: 'This one often clears itself on the next retry, so you may not need to do anything at all.',
  },
  processing_error: {
    reason: 'to try again shortly',
    fix: 'This one often clears itself on the next retry, so you may not need to do anything at all.',
  },
  // Neutral by design. See NEVER ACCUSE above.
  lost_card: {
    reason: 'this card can no longer be charged',
    fix: 'A different card will work.',
  },
  stolen_card: {
    reason: 'this card can no longer be charged',
    fix: 'A different card will work.',
  },
  pickup_card: {
    reason: 'this card can no longer be charged',
    fix: 'A different card will work.',
  },
  fraudulent: {
    reason: 'this card can no longer be charged',
    fix: 'A different card will work.',
  },
};

/**
 * Resolve the decline sentence, or null when Stripe gave us nothing specific.
 *
 * `generic_decline` and `card_declined` are deliberately NOT in the table. They
 * carry no information, and printing "your bank said: your card was declined"
 * under a heading that promises a reason is worse than printing no heading, so
 * the composer omits the whole block instead.
 */
export function declineCopy(code: string | null | undefined): DeclineCopy | null {
  if (!code) return null;
  return DECLINE_COPY[code] ?? null;
}

// ---------------------------------------------------------------------------
// Unsubscribe (marketing only): REUSED, NOT REBUILT
// ---------------------------------------------------------------------------
//
// An earlier draft of this file signed its own HMAC opt-out tokens. It was
// removed unrun, because src/lib/email/lifecycle.ts already owns this: a random
// uuid on the user row (`users.unsubscribe_token`), an RFC 8058 one-click
// endpoint at /api/email/unsubscribe that honours it, and an `isSuppressed`
// check the dispatcher calls before every marketing send.
//
// Two opt-out mechanisms would mean a reader who unsubscribed from one kind of
// email still receiving the other, which is the exact failure an unsubscribe
// link exists to prevent. So the win-backs here are category `lifecycle` on the
// shared columns, and this module signs nothing.
//
// The token is supplied by the caller in the payload, read fresh from the user
// row immediately before the send rather than frozen at queue time, so a
// rotated token never produces a dead link at the bottom of an email.

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/**
 * Everything a composer can read. Assembled at QUEUE time and frozen into
 * `billing_email_sends.payload`, so an email written on day 14 describes the
 * failure as it was on day 0 rather than re-deriving it from a Stripe account
 * that has moved on. The dispatcher's freshness check is what stops a stale
 * payload from being sent at all; see the dispatch route.
 */
export interface LifecyclePayload {
  /** Paid plan the customer is on (or was on). */
  planId?: PlanId | null;
  /** What the failing or upcoming charge is, in minor units. */
  amountCents?: number | null;
  currency?: string | null;
  /** Stripe decline code from the failed payment intent, when there was one. */
  declineCode?: string | null;
  /** Stripe hosted invoice page: lets them pay the exact invoice in one click. */
  hostedInvoiceUrl?: string | null;
  /** ISO date the paid period ends (cancellation) or ended (win-back). */
  periodEnd?: string | null;
  /** Card details for the expiry warnings. Never anything but brand and last4. */
  cardBrand?: string | null;
  cardLast4?: string | null;
  cardExpiry?: string | null;
  /**
   * The recipient's `users.unsubscribe_token`. REQUIRED on the win-back
   * templates and ignored on every other one. Injected by the dispatcher just
   * before the send, never stored in the queued payload, so a rotated token
   * cannot leave a dead opt-out link in an email that goes out a month later.
   */
  unsubscribeToken?: string | null;
  /**
   * True when the user carries the 2026-08-19 repricing grandfather
   * (`user_usage_entitlements.unlimited_inboxes`). They keep unlimited inboxes
   * on Free forever, so the "your agent loses inboxes 2 and 3" line is FALSE
   * for them and the composer must not print it.
   */
  grandfathered?: boolean;
}

export interface ComposedLifecycleEmail {
  subject: string;
  body: string;
  htmlBody: string;
  category: BillingCategory;
  /** Present on marketing templates only. */
  unsubscribeUrl?: string;
}

// ---------------------------------------------------------------------------
// Copy helpers
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The plan's display name, or null when the price could not be resolved to one.
 *
 * It used to default to `personal`. That is the wrong direction to fail in: an
 * unresolvable price is exactly what happens when a webhook endpoint is pinned
 * to an API version whose line-item shape we did not read, and the result was a
 * Team subscriber at $79 being told about their "Personal plan" in an email
 * about their money. Naming no plan is honest; naming the cheapest one is not.
 */
function planName(planId: PlanId | null | undefined): string | null {
  return planId ? planDisplayName(planId) : null;
}

/** "your Personal plan", or just "your plan" when the plan is unknown. */
function yourPlanPhrase(name: string | null): string {
  return name ? `your ${name} plan` : 'your plan';
}

function amountLabel(payload: LifecyclePayload): string | null {
  if (payload.amountCents == null || payload.amountCents <= 0) return null;
  return formatAmount(payload.amountCents, payload.currency ?? 'usd');
}

function longDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * The one sentence that says what actually stops working, computed from the
 * plan catalogue rather than written down, so a repricing cannot make it a lie.
 *
 * Returns null for a grandfathered user, whose inbox count does NOT drop on
 * Free. Telling 151 grandfathered users their agent is about to lose inboxes it
 * will in fact keep would be the single most damaging sentence in this file.
 */
function consequenceLine(payload: LifecyclePayload): string | null {
  // No resolved plan means no honest sentence about what is lost. Silence beats
  // describing the wrong plan's limits.
  if (!payload.planId) return null;
  const plan = PLANS[payload.planId as PlanId];
  if (!plan || plan.id === 'free') return null;

  const freeRpm = PLANS.free.limits.maxRequestsPerMinute;
  const paidRpm = plan.limits.maxRequestsPerMinute;
  const rateClause =
    paidRpm > freeRpm ? ` and the rate limit drops from ${paidRpm} to ${freeRpm} requests a minute` : '';

  if (payload.grandfathered) {
    // They keep unlimited inboxes free forever, so only the rate limit moves.
    return rateClause
      ? `Your account goes back to Free. Your connected inboxes stay (you are on the permanent grandfathered allowance)${rateClause}.`
      : null;
  }

  const paidInboxes = plan.limits.maxInboxes;
  const freeInboxes = PLANS.free.limits.maxInboxes;
  const inboxClause = Number.isFinite(paidInboxes)
    ? `your agent keeps ${freeInboxes} connected ${freeInboxes === 1 ? 'inbox' : 'inboxes'} instead of ${paidInboxes}`
    : `your agent keeps ${freeInboxes} connected ${freeInboxes === 1 ? 'inbox' : 'inboxes'} instead of as many as you like`;

  return `Your account goes back to Free: ${inboxClause}${rateClause}.`;
}

/** "09/2026" to "September 2026". Falls back to the input on anything odd. */
function monthName(expiry: string): string {
  const match = /^(\d{1,2})\/(\d{4})$/.exec(expiry.trim());
  if (!match) return expiry;
  const month = Number(match[1]);
  if (month < 1 || month > 12) return expiry;
  const names = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${names[month - 1]} ${match[2]}`;
}

/** Nothing is ever deleted on a downgrade, and saying so removes real anxiety. */
const NOTHING_DELETED =
  'Nothing is deleted either way. Your inbox connections, API keys and settings stay exactly where they are, and reconnecting is one click if you come back.';

// ---------------------------------------------------------------------------
// The HTML shell
// ---------------------------------------------------------------------------

interface ShellOptions {
  title: string;
  /** Blocks of already-escaped HTML. */
  html: string;
  ctaUrl?: string;
  ctaLabel?: string;
  footerNote: string;
  unsubscribe?: string | null;
}

function shell(options: ShellOptions): string {
  const cta =
    options.ctaUrl && options.ctaLabel
      ? `<table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
                <tr>
                  <td style="background:#0f172a;border-radius:8px;">
                    <a href="${options.ctaUrl}" style="display:inline-block;padding:12px 28px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">
                      ${escapeHtml(options.ctaLabel)}
                    </a>
                  </td>
                </tr>
              </table>`
      : '';

  const unsub = options.unsubscribe
    ? `<p style="margin:12px 0 0;font-size:12px;color:#94a3b8;line-height:1.6;">
                You are getting this because you had an MCPEmails subscription.
                <a href="${options.unsubscribe}" style="color:#94a3b8;text-decoration:underline;">Unsubscribe from these</a>
                and you will not hear from us again. Billing and account notices are not affected.
              </p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${escapeHtml(options.title)}</title>
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
              <p style="margin:0 0 18px;font-size:22px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">
                ${escapeHtml(options.title)}
              </p>
              ${options.html}
              ${cta}
            </td>
          </tr>
          <tr>
            <td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #e2e8f0;">
              <p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">${options.footerNote}</p>
              ${unsub}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function p(text: string): string {
  return `<p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">${escapeHtml(text)}</p>`;
}

function h(text: string): string {
  return `<p style="margin:0 0 8px;font-size:16px;font-weight:700;color:#0f172a;">${escapeHtml(text)}</p>`;
}

/** A quiet grey box for the facts (amount, card, date). Never the message. */
function facts(rows: Array<[string, string]>): string {
  const cells = rows
    .map(
      ([label, value], i) => `<tr>
                  <td style="padding:${i === 0 ? '14px' : '0'} 18px 14px;font-size:14px;color:#64748b;">${escapeHtml(label)}</td>
                  <td style="padding:${i === 0 ? '14px' : '0'} 18px 14px;font-size:14px;color:#0f172a;font-weight:600;" align="right">${escapeHtml(value)}</td>
                </tr>`,
    )
    .join('');
  return `<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;margin:0 0 24px;">${cells}</table>`;
}

const SUPPORT_FOOTER = `Something look wrong, or is this a bad time? Reply to this email or write to <a href="mailto:${SUPPORT_ADDRESS}" style="color:#3b82f6;">${SUPPORT_ADDRESS}</a>. A person reads it, and at our size that person is the one who wrote the software.`;

const SUPPORT_FOOTER_TEXT = `Something look wrong, or is this a bad time? Reply to this email or write to ${SUPPORT_ADDRESS}. A person reads it, and at our size that person is the one who wrote the software.`;

/**
 * The cancellation email gets its own footer, because the standard one ends in
 * a question ("is this a bad time?") and that email is asking exactly one
 * question on purpose. A second question mark in a message whose whole value is
 * the reply gives the reader two things to answer and reliably gets neither.
 * The unit test asserts the body contains one question mark, which is how this
 * was found.
 */
const CANCEL_FOOTER = `Replies come straight to a person, not a ticket queue. Written by Asgeir, who builds MCPEmails.`;

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Build one lifecycle email.
 *
 * Returns null when the email must not be sent at all. Today that is exactly
 * one case: a marketing template whose recipient has no
 * `users.unsubscribe_token`, so no one-click opt-out link can be offered.
 * Sending marketing mail without a working unsubscribe is worse than not
 * sending it.
 */
export function composeBillingEmail(
  template: BillingTemplate,
  payload: LifecyclePayload,
): ComposedLifecycleEmail | null {
  const category = categoryOf(template);
  const base = appUrl();
  const billingUrl = `${base}/dashboard/settings`;
  const payUrl = payload.hostedInvoiceUrl ?? billingUrl;

  let unsub: string | null = null;
  if (category === 'marketing') {
    // Category `lifecycle`, matching the CHECK on users.unsubscribed_categories
    // and the founder-email opt-out. Somebody who stopped one has stopped both,
    // which is what they meant.
    unsub = payload.unsubscribeToken
      ? unsubscribeUrl(payload.unsubscribeToken, 'lifecycle')
      : null;
    if (!unsub) {
      console.error(
        `[billing-email] ${template} not composed: no unsubscribe token for this recipient, so no one-click opt-out can be offered.`,
      );
      return null;
    }
  }

  const name = planName(payload.planId);
  const yourPlan = yourPlanPhrase(name);
  const amount = amountLabel(payload);
  const decline = declineCopy(payload.declineCode);
  const consequence = consequenceLine(payload);
  const endsOn = longDate(payload.periodEnd);

  switch (template) {
    // ─────────────────────────────────────────────────────────────────────
    // Dunning. Tone is help, not collections: the first email exists because
    // the customer's own bank notification is still on their phone, and the
    // job is to connect our name to that notification while it is, not to
    // tell them what they owe.
    // ─────────────────────────────────────────────────────────────────────
    case 'dunning_1': {
      const subject = 'Your MCPEmails payment did not go through';
      const lead = amount
        ? `Your bank declined the card we have on file, so the ${amount} renewal for ${yourPlan} did not go through.`
        : `Your bank declined the card we have on file, so the renewal for ${yourPlan} did not go through.`;

      const lines: string[] = [lead, ''];
      const blocks: string[] = [p(lead)];

      if (decline) {
        lines.push('WHY', `Your bank said: ${decline.reason}.`, decline.fix, '');
        blocks.push(h('Why'), p(`Your bank said: ${decline.reason}.`), p(decline.fix));
      }

      lines.push(
        'NOTHING HAS STOPPED WORKING',
        'Your plan is still running and your agent has not lost anything. We keep',
        'paid access on while the card is being retried, so there is no rush in the',
        'next hour.',
        '',
        'IF IT KEEPS FAILING',
        'The card gets retried automatically over the next two weeks. If it never',
        'goes through, the subscription closes.',
      );
      blocks.push(
        h('Nothing has stopped working'),
        p('Your plan is still running and your agent has not lost anything. We keep paid access on while the card is being retried, so there is no rush in the next hour.'),
        h('If it keeps failing'),
        p('The card gets retried automatically over the next two weeks. If it never goes through, the subscription closes.'),
      );
      if (consequence) {
        lines.push(consequence);
        blocks.push(p(consequence));
      }

      lines.push(
        '',
        'FIX IT IN ABOUT A MINUTE',
        'Update the card here. The next retry picks it up on its own, and you do not',
        'need to tell us:',
        payUrl,
        '',
        'And if you meant to stop, you do not have to do anything or reply to this.',
        'Leave it and it closes itself.',
        '',
        SUPPORT_FOOTER_TEXT,
        '',
        'MCPEmails',
        base,
      );
      blocks.push(
        h('Fix it in about a minute'),
        p('Update the card and the next retry picks it up on its own. You do not need to tell us.'),
      );

      return {
        subject,
        category,
        body: lines.join('\n'),
        htmlBody: shell({
          title: 'Your payment did not go through',
          html:
            blocks.join('') +
            p('And if you meant to stop, you do not have to do anything or reply to this. Leave it and it closes itself.'),
          ctaUrl: payUrl,
          ctaLabel: 'Update the card',
          footerNote: SUPPORT_FOOTER,
        }),
      };
    }

    case 'dunning_3': {
      const subject = 'The card on your MCPEmails account is still being declined';
      const lead = amount
        ? `Three days on, the ${amount} for ${yourPlan} still has not gone through.`
        : `Three days on, the renewal for ${yourPlan} still has not gone through.`;
      const body = [
        lead,
        '',
        'Your plan is still running. We do not cut access off while a card is being',
        'retried, and there are about eleven days of retries left.',
        '',
        decline ? `Your bank is still saying: ${decline.reason}.` : '',
        decline ? decline.fix : '',
        decline ? '' : '',
        'Updating the card is the whole fix, and the retry picks it up automatically:',
        payUrl,
        '',
        'If you would rather stop paying for this, that is a completely fine answer',
        'and you can just ignore this. It closes on its own.',
        '',
        SUPPORT_FOOTER_TEXT,
        '',
        'MCPEmails',
        base,
      ]
        .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
        .join('\n');

      return {
        subject,
        category,
        body,
        htmlBody: shell({
          title: 'The card is still being declined',
          html:
            p(lead) +
            p('Your plan is still running. We do not cut access off while a card is being retried, and there are about eleven days of retries left.') +
            (decline ? p(`Your bank is still saying: ${decline.reason}. ${decline.fix}`) : '') +
            p('If you would rather stop paying for this, that is a completely fine answer and you can ignore this. It closes on its own.'),
          ctaUrl: payUrl,
          ctaLabel: 'Update the card',
          footerNote: SUPPORT_FOOTER,
        }),
      };
    }

    case 'dunning_7': {
      const subject = 'A week of failed payments on your MCPEmails account';
      const lead = `It has been a week of the card being declined on ${yourPlan}, and there is about a week of retries left before the subscription closes.`;
      const body = [
        lead,
        '',
        'Your plan is still running today. Nothing has been taken away yet.',
        '',
        consequence ? 'WHEN IT CLOSES' : '',
        consequence ?? '',
        consequence ? NOTHING_DELETED : '',
        consequence ? '' : '',
        'One card update ends this:',
        payUrl,
        '',
        SUPPORT_FOOTER_TEXT,
        '',
        'MCPEmails',
        base,
      ]
        .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
        .join('\n');

      return {
        subject,
        category,
        body,
        htmlBody: shell({
          title: 'A week of failed payments',
          html:
            p(lead) +
            p('Your plan is still running today. Nothing has been taken away yet.') +
            (consequence ? h('When it closes') + p(consequence) + p(NOTHING_DELETED) : ''),
          ctaUrl: payUrl,
          ctaLabel: 'Update the card',
          footerNote: SUPPORT_FOOTER,
        }),
      };
    }

    case 'dunning_14': {
      const subject = 'Last note about your MCPEmails payment';
      const lead = `This is the last email about the declined card on ${yourPlan}. The retries are finished, so the subscription is closing.`;
      const body = [
        lead,
        '',
        consequence ?? '',
        NOTHING_DELETED,
        '',
        'If you still want the plan, this link starts it again and takes about a',
        'minute:',
        `${base}/pricing`,
        '',
        'And if the price is the thing that stopped working, say so in a reply. At',
        'the size we are, that is a conversation and not a form.',
        '',
        SUPPORT_FOOTER_TEXT,
        '',
        'MCPEmails',
        base,
      ]
        .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
        .join('\n');

      return {
        subject,
        category,
        body,
        htmlBody: shell({
          title: 'Last note about your payment',
          html:
            p(lead) +
            (consequence ? p(consequence) : '') +
            p(NOTHING_DELETED) +
            p('And if the price is the thing that stopped working, say so in a reply. At the size we are, that is a conversation and not a form.'),
          ctaUrl: `${base}/pricing`,
          ctaLabel: 'Start the plan again',
          footerNote: SUPPORT_FOOTER,
        }),
      };
    }

    // ─────────────────────────────────────────────────────────────────────
    // Card expiry. Preventing the failure beats recovering it, and this is
    // the only email here that costs the customer nothing to read: there is
    // no problem yet, which is exactly why it works.
    // ─────────────────────────────────────────────────────────────────────
    case 'card_expiry_30':
    case 'card_expiry_7': {
      const soon = template === 'card_expiry_7';
      const card =
        payload.cardBrand && payload.cardLast4
          ? `${payload.cardBrand} ending ${payload.cardLast4}`
          : 'the card on your account';
      // "expires at the end of 09/2026" reads like a form field. The fact box
      // below keeps the numeric form, which is what somebody comparing it
      // against the card in their hand actually wants; the sentence gets the
      // month by name.
      const when = payload.cardExpiry
        ? ` expires at the end of ${monthName(payload.cardExpiry)}`
        : ' is about to expire';
      const subject = soon
        ? 'Your MCPEmails card expires next week'
        : 'The card on your MCPEmails account expires next month';
      const lead = `Nothing is wrong. ${card.charAt(0).toUpperCase()}${card.slice(1)}${when}, and ${yourPlan} renews on it.`;
      const nudge = soon
        ? 'After that the renewal will be declined and we will have to email you about it, which is a worse email than this one.'
        : 'Replacing it now means the renewal simply goes through and you never hear from us about it.';

      const rows: Array<[string, string]> = [];
      if (payload.cardBrand && payload.cardLast4) rows.push(['Card', card]);
      if (payload.cardExpiry) rows.push(['Expires', payload.cardExpiry]);
      if (amount) rows.push(['Renews at', amount]);

      const body = [
        lead,
        '',
        nudge,
        '',
        'Update it here:',
        billingUrl,
        '',
        SUPPORT_FOOTER_TEXT,
        '',
        'MCPEmails',
        base,
      ].join('\n');

      return {
        subject,
        category,
        body,
        htmlBody: shell({
          title: soon ? 'Your card expires next week' : 'Your card expires next month',
          html: p(lead) + (rows.length ? facts(rows) : '') + p(nudge),
          ctaUrl: billingUrl,
          ctaLabel: 'Update the card',
          footerNote: SUPPORT_FOOTER,
        }),
      };
    }

    // ─────────────────────────────────────────────────────────────────────
    // Cancellation. ONE question, and no discount.
    //
    // A discount here buys a month and destroys the only thing worth having
    // from five customers, which is the sentence that explains why the sixth
    // one left. It also teaches the customer that the price is negotiable,
    // which is a bad thing to teach at $5.
    // ─────────────────────────────────────────────────────────────────────
    case 'cancel_ask': {
      const subject = 'What stopped working for you?';
      const until = endsOn
        ? `You keep everything until ${endsOn}, which you have already paid for.`
        : 'You keep everything until the end of the period you have already paid for.';
      const lead = `You cancelled ${yourPlan}, and that is fine. I am not going to try to talk you out of it.`;
      const ask =
        'I would like to know one thing though: what stopped working for you? One line is plenty. Reply straight to this email and it comes to me.';

      const body = [
        lead,
        '',
        ask,
        '',
        until,
        NOTHING_DELETED,
        '',
        CANCEL_FOOTER,
        '',
        'MCPEmails',
        base,
      ].join('\n');

      return {
        subject,
        category,
        body,
        htmlBody: shell({
          title: 'What stopped working for you?',
          html: p(lead) + p(ask) + p(until) + p(NOTHING_DELETED),
          footerNote: escapeHtml(CANCEL_FOOTER),
        }),
      };
    }

    // ─────────────────────────────────────────────────────────────────────
    // Win-back. Marketing-adjacent, so: unsubscribe link, suppression check,
    // and a hard stop after two. The day-30 email says out loud that it is
    // the last one, because that promise is the only reason the day-14 one
    // is not an imposition.
    // ─────────────────────────────────────────────────────────────────────
    case 'winback_14': {
      const subject = 'Your MCPEmails setup is still here';
      const lead = `It has been a couple of weeks since ${yourPlan} ended.`;
      const body = [
        lead,
        '',
        'Your inbox connections, API keys and settings are all still on the account.',
        'Nothing was deleted, so picking it back up is one click rather than a setup',
        'session:',
        `${base}/pricing`,
        '',
        'If it was not doing what you needed, I would genuinely rather hear that than',
        'have you back. Reply and tell me what was missing.',
        '',
        `Unsubscribe from these: ${unsub}`,
        'Billing and account notices are separate and are not affected.',
        '',
        'MCPEmails',
        base,
      ].join('\n');

      return {
        subject,
        category,
        unsubscribeUrl: unsub ?? undefined,
        body,
        htmlBody: shell({
          title: 'Your setup is still here',
          html:
            p(lead) +
            p('Your inbox connections, API keys and settings are all still on the account. Nothing was deleted, so picking it back up is one click rather than a setup session.') +
            p('If it was not doing what you needed, I would genuinely rather hear that than have you back. Reply and tell me what was missing.'),
          ctaUrl: `${base}/pricing`,
          ctaLabel: 'Pick it back up',
          footerNote: SUPPORT_FOOTER,
          unsubscribe: unsub,
        }),
      };
    }

    case 'winback_30': {
      const subject = 'Last email from MCPEmails';
      const lead = 'This is the last one. After this you will not hear from me again unless you write first, or something happens on your account that you need to know about.';
      const body = [
        lead,
        '',
        'Your account and your inbox connections stay where they are, at no cost, on',
        'the Free plan. There is no expiry on that and nothing to do about it.',
        '',
        'If you ever want the paid plan back it is here, and if you want to tell me',
        'what went wrong, that reply is still open:',
        `${base}/pricing`,
        '',
        `Unsubscribe from these: ${unsub}`,
        'Billing and account notices are separate and are not affected.',
        '',
        'MCPEmails',
        base,
      ].join('\n');

      return {
        subject,
        category,
        unsubscribeUrl: unsub ?? undefined,
        body,
        htmlBody: shell({
          title: 'Last email from MCPEmails',
          html:
            p(lead) +
            p('Your account and your inbox connections stay where they are, at no cost, on the Free plan. There is no expiry on that and nothing to do about it.') +
            p('If you ever want the paid plan back it is here, and if you want to tell me what went wrong, that reply is still open.'),
          ctaUrl: `${base}/pricing`,
          ctaLabel: 'See the plans',
          footerNote: SUPPORT_FOOTER,
          unsubscribe: unsub,
        }),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

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

export interface SendBillingEmailInput {
  to: string;
  template: BillingTemplate;
  /** Invoice id, subscription id or card key. Also the Resend idempotency key. */
  scopeKey: string;
  payload: LifecyclePayload;
}

export type SendBillingEmailResult =
  | { ok: true; resendId: string | null }
  | { ok: false; reason: string };

/**
 * Send one lifecycle email. NEVER THROWS.
 *
 * Unlike sendPurchaseConfirmationEmail this one RETURNS its outcome, because
 * the caller is a dispatcher holding a claimed queue row and it has to record
 * whether the row is sent or should be retried. It still cannot throw: a
 * failure comes back as {ok:false}, never as a rejection, so a Resend outage
 * can never take down the dispatcher or, through it, the webhook.
 *
 * ONE ATTEMPT, as in purchase-confirmation.ts. Retrying inside this function
 * after a lost response is how a customer gets two copies of "your payment
 * failed". Retrying is the queue's job, on the next tick, under the same
 * Idempotency-Key, which Resend collapses.
 */
export async function sendBillingLifecycleEmail(
  input: SendBillingEmailInput,
): Promise<SendBillingEmailResult> {
  try {
    const resend = getResend();
    if (!resend) {
      console.error('[billing-email] no RESEND_API_KEY configured; skipping send');
      return { ok: false, reason: 'no_api_key' };
    }

    const to = input.to?.trim() ?? '';
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
      return { ok: false, reason: 'unusable_recipient' };
    }

    const composed = composeBillingEmail(input.template, input.payload);
    if (!composed) return { ok: false, reason: 'not_composable' };

    const category = categoryOf(input.template);
    // lifecycleFrom() is the shared founder/lifecycle sender, deliberately a
    // different address from the transactional one: a spam complaint on a
    // win-back must not be able to take a payment-failure notice down with it.
    const from =
      category === 'marketing'
        ? lifecycleFrom()
        : process.env.BILLING_EMAIL_FROM ?? DEFAULT_BILLING_FROM;

    // The cancellation question is the one email whose entire purpose is the
    // reply, so it can be pointed somewhere other than the support address.
    const replyTo =
      input.template === 'cancel_ask'
        ? process.env.CANCEL_REPLY_TO ?? SUPPORT_ADDRESS
        : SUPPORT_ADDRESS;

    // List-Unsubscribe on MARKETING ONLY. Putting it on a payment-failure
    // notice would advertise an opt-out from a message the customer is not
    // permitted to opt out of, and some clients surface it as a one-tap button.
    const headers: Record<string, string> = {};
    if (category === 'marketing' && composed.unsubscribeUrl) {
      headers['List-Unsubscribe'] = `<${composed.unsubscribeUrl}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }

    const { data, error } = await resend.emails.send(
      {
        from,
        to,
        replyTo,
        subject: composed.subject,
        html: composed.htmlBody,
        text: composed.body,
        ...(Object.keys(headers).length ? { headers } : {}),
      },
      // Keyed on what the email is ABOUT, matching the database's
      // (customer, template, scope_key) uniqueness. A dispatcher retry after a
      // lost response therefore delivers one email, not two.
      { idempotencyKey: `${input.template}-${input.scopeKey}`.slice(0, 256) },
    );

    if (error) {
      console.error(
        `[billing-email] ${input.template} FAILED (scope ${input.scopeKey}): ${safeCode(error.message)}`,
      );
      return { ok: false, reason: safeCode(error.message) };
    }

    console.log(`[billing-email] ${input.template} sent (scope ${input.scopeKey})`);
    return { ok: true, resendId: data?.id ?? null };
  } catch (err) {
    console.error('[billing-email] unexpected failure, swallowed:', {
      template: input.template,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: 'unexpected_error' };
  }
}
