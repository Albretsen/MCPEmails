/**
 * Billing lifecycle email: dunning, card expiry, cancellation save, win-back,
 * and the Free allowance notices.
 *
 * Fourteen templates in two categories, and the split between them is the most
 * important thing in this file.
 *
 * TRANSACTIONAL (dunning_1/3/7/14, card_expiry_30/7, cancel_ask)
 *   Service messages about a broken or about-to-break payment on a contract the
 *   customer is already in. They need no opt-in and they are NOT suppressible.
 *   A customer who unsubscribed from a win-back in March must still be told in
 *   June that their card was declined; the alternative is taking their money,
 *   failing to take their money, and telling them neither.
 *
 * TRANSACTIONAL, WORKSPACE-KEYED (usage_warning_80, usage_limit_reached,
 * automation_paused_limit)
 *   Notices about the account's own state: the Free allowance of email actions
 *   is 80% used, used up, or has paused an unattended automation. Queued by the
 *   mcp-server edge function per workspace and per allowance period (the
 *   migration is 20260912200000_free_action_cap_150.sql, the plan is
 *   docs/PLAN-free-action-cap-150.md). The owner may have no Stripe customer
 *   at all, so these rows carry `workspace_id` and `period_start` instead of
 *   `stripe_customer_id`, and the Resend Idempotency-Key is built from those.
 *   "Your service is about to stop" is account status, so they are not
 *   suppressible and carry no unsubscribe header. The upgrade line in each is
 *   secondary to the numbers, which is what keeps them out of marketing.
 *
 * TRANSACTIONAL, PASS NOTICES (pass_ending_7d, pass_ended)
 *   The 3-month Personal pass ends in 7 days, or has ended. About the end of a
 *   fixed-term contract the customer bought, so no consent and no unsubscribe;
 *   queued at purchase by src/lib/billing/pass-notices.ts, two per pass.
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
 * Sender reputation is split by DOMAIN, not by address. Since 2026-10-30
 * production sets LIFECYCLE_EMAIL_FROM to asgeir@updates.mcpemails.com, a
 * sending-only subdomain verified in Resend with its own DKIM key, so spam
 * complaints on a win-back stay off the root domain that carries receipts and
 * the real Migadu mailboxes. Replies go to lifecycleReplyTo(), since the
 * subdomain has no mailbox. Without that env var both senders share the root
 * domain and one DKIM key again.
 *
 * ENVIRONMENT (all read at call time, never at module load):
 *   RESEND_API_KEY        Resend API key. Missing = no send, logged, not thrown.
 *   BILLING_EMAIL_FROM    OPTIONAL. Default: MCPEmails <hello@mcpemails.com>.
 *   LIFECYCLE_EMAIL_FROM  OPTIONAL, read via lifecycleFrom() in
 *                         src/lib/email/lifecycle.ts. The win-back sender.
 *   CANCEL_REPLY_TO       OPTIONAL. Where "what stopped working for you?" lands.
 *                         Default: support@mcpemails.com.
 *
 * The win-backs additionally require the recipient's `users.unsubscribe_token`
 * in the payload. Without one, composition returns null and nothing is sent:
 * no opt-out link means no marketing mail, which is the correct direction to
 * fail in.
 *   NEXT_PUBLIC_APP_URL   Base URL for the dashboard links.
 *
 * LOCALE. English only, for the same reason as the purchase confirmation: the
 * customer's interface language never reaches the server and a Stripe webhook
 * has no request context to read one from. The usage notices are queued by
 * the edge function, which has no interface locale either.
 *
 * THE FREE ALLOWANCE IS PUBLIC; THE PAID CEILINGS ARE NOT. Since 2026-09-12
 * the Free plan has a stated allowance of 150 email actions a month, and the
 * three usage templates print the numbers the edge function counted. The paid
 * plans still carry silent abuse ceilings that are not a pricing lever and must
 * not appear in customer-facing copy: the dunning and win-back templates never
 * mention them, and the usage templates only ever describe the Free number
 * they were handed in the payload.
 */

import type { Resend } from 'resend';
import { createResend } from '@/lib/email/resend';

import { FREE_ACTION_ALLOWANCE, PERSONAL_PASS_3M, PLANS, planDisplayName, type PlanId } from '@/lib/stripe/plans';
import { formatAmount } from '@/lib/email/purchase-confirmation';
import { lifecycleFrom, lifecycleReplyTo, unsubscribeUrl } from '@/lib/email/lifecycle';
import { CANCEL_PATH, POSTAL_ADDRESS_LINE, WITHDRAWAL_PATH } from '@/lib/email/legal';
import { CANCEL_REASONS, CANCEL_REASON_EMAIL_LABELS } from '@/lib/billing/cancel-reasons';
import { issueFeedbackToken } from '@/lib/billing/feedback-token';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Replies and "write to" links go to the support mailbox; the sender stays hello@.
const SUPPORT_ADDRESS = 'support@mcpemails.com';
const DEFAULT_BILLING_FROM = `MCPEmails <hello@mcpemails.com>`;
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
  'usage_warning_80',
  'usage_limit_reached',
  'automation_paused_limit',
  'pass_ending_7d',
  'pass_ended',
  'pause_started',
  'pause_ending_3',
] as const;

export type BillingTemplate = (typeof BILLING_TEMPLATES)[number];

/** The three notices keyed by workspace and allowance period, not by Stripe customer. */
export const USAGE_TEMPLATES = [
  'usage_warning_80',
  'usage_limit_reached',
  'automation_paused_limit',
] as const satisfies ReadonlyArray<BillingTemplate>;

export type UsageTemplate = (typeof USAGE_TEMPLATES)[number];

export function isUsageTemplate(template: string): template is UsageTemplate {
  return (USAGE_TEMPLATES as ReadonlyArray<string>).includes(template);
}

/**
 * The two service notices of a 3-month Personal pass (migration
 * 20261025010100, src/lib/billing/pass-notices.ts). Keyed on the Stripe
 * customer with scope_key = the user_passes id. Transactional: they are about
 * the end of a contract the customer bought, so no consent and no unsubscribe.
 */
export const PASS_TEMPLATES = ['pass_ending_7d', 'pass_ended'] as const satisfies ReadonlyArray<BillingTemplate>;

export type PassTemplate = (typeof PASS_TEMPLATES)[number];

export function isPassTemplate(template: string): template is PassTemplate {
  return (PASS_TEMPLATES as ReadonlyArray<string>).includes(template);
}

export type BillingCategory = 'transactional' | 'marketing';

/**
 * The category rule, mirrored from the GENERATED column in
 * 20260902130000_billing_lifecycle_emails.sql, re-declared unchanged in
 * 20260912200000_free_action_cap_150.sql. Both must agree. The database is
 * the authority; this exists so the sender can decide, without a round trip,
 * whether an unsubscribe header belongs on the message. Only winback_* is ever
 * marketing; the usage notices are transactional by the same rule.
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
export function declineCopy(
  code: string | null | undefined,
  currency?: string | null,
): DeclineCopy | null {
  if (!code) return null;
  // The one decline that names a currency names the one actually charged: a
  // EUR subscription is not refused "in US dollars".
  if (code === 'currency_not_supported' && (currency ?? 'usd').toLowerCase() === 'eur') {
    return {
      reason: 'the card cannot be charged in euros',
      fix: 'A card that accepts EUR will work. Most do, but some regional cards do not.',
    };
  }
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
 *
 * Declared as a TYPE ALIAS, not an interface, on purpose. This object is
 * written straight into a `jsonb` column whose generated type is `Json`, and
 * TypeScript only gives an implicit index signature to an object TYPE, never to
 * an interface. As an interface it failed to satisfy `Json`, and the only way
 * past that was `as unknown as Json` at the call site, which would have
 * switched off checking for the whole insert. Keep it a type alias, and keep
 * every member assignable to `Json`: no Date, no undefined-only unions, no
 * class instances.
 */
export type LifecyclePayload = {
  /** Paid plan the customer is on (or was on). */
  planId?: PlanId | null;
  /** What the failing or upcoming charge is, in minor units. */
  amountCents?: number | null;
  currency?: string | null;
  /** Stripe decline code from the failed payment intent, when there was one. */
  declineCode?: string | null;
  /**
   * The payment method on the failed attempt (a Stripe pm_ id), when known.
   * Never printed in an email: the webhook compares it with the method that
   * finally paid, to tell a customer fix from a silent retry (recovered_by).
   */
  failedPaymentMethodId?: string | null;
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

  // ── Usage notices ────────────────────────────────────────────────────────
  //
  // Written by the mcp-server edge function into `billing_email_sends.payload`
  // in snake_case, exactly as the keys land in the jsonb, so the composer reads
  // what was queued without a mapping layer in between. The numbers are the
  // ones the edge function counted at queue time; the composer prints them and
  // never re-derives them. `period_end` is EXCLUSIVE (the first instant of the
  // next period), which is why "resets on" prints that day.

  /** Billable email actions counted in the period, at queue time. */
  used?: number | null;
  /** The Free allowance the workspace is measured against. */
  cap?: number | null;
  /** ISO timestamp the allowance period began. */
  period_start?: string | null;
  /** ISO timestamp the allowance period ends and the count resets. */
  period_end?: string | null;
  /** Plan id at queue time. Informational; the copy never names it. */
  plan?: string | null;
  /** The triage rule that was paused (automation_paused_limit only). */
  rule_id?: string | null;
  rule_name?: string | null;

  // ── Pause ────────────────────────────────────────────────────────────────

  /** ISO: when the paid plan stops and the pause begins. */
  pauseStartsAt?: string | null;
  /** ISO: the renewal that bills again (pause_collection.resumes_at + 1h). */
  billingResumesAt?: string | null;
  /** True when the pause replaced a scheduled cancellation. */
  replacedCancel?: boolean;


  // ── Cancellation confirmation (cancel_ask) ─────────────────────────────
  //
  // All optional, so every row queued before these existed still composes.

  /** 'month' | 'year' when the queue wrote it; otherwise inferred from the amount. */
  interval?: 'month' | 'year' | null;
  /**
   * What led to the cancellation. 'billing_switch_free' (the Billing card's
   * switch to Free) leaves out the pause/smaller-plan paragraph: the customer
   * has just chosen the smallest option there is.
   */
  source?: string | null;
  /** ISO time of the subscription's first charge, when known (withdrawal window). */
  firstChargeAt?: string | null;
  /**
   * Decision D3 (src/lib/billing/park-on-cancel.ts). Set at queue time only
   * when this subscription's end will park inboxes: the largest number of
   * active inboxes in one workspace above Free's cap. Above 1, the
   * confirmation adds one factual sentence about parking. Absent on every row
   * queued before D3, and for anyone the marker does not cover.
   */
  parkInboxCount?: number | null;
  /**
   * The cancellation's identity for the signed /billing/feedback links. Not
   * stored in the queued payload: sendInputForQueueRow fills them from the
   * row's stripe_customer_id and scope_key (`${subscriptionId}:${periodEnd}`).
   */
  subscriptionId?: string | null;
  stripeCustomerId?: string | null;
  /** Unix seconds; the period end half of the scope key. */
  periodEndSeconds?: number | null;
};

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

// ---------------------------------------------------------------------------
// Usage notice helpers
// ---------------------------------------------------------------------------

/** "2026-10-01T00:00:00+00:00" to "2026-10-01" (UTC). Null on anything odd. */
function isoDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function wholeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/**
 * The facts every usage notice is built from, or null when the payload cannot
 * back them up. A notice that reads "undefined of undefined email actions" is
 * worse than no notice, so a payload without real numbers and a real reset date
 * composes to nothing and the dispatcher cancels the row as undeliverable.
 */
interface UsageFacts {
  used: number;
  cap: number;
  /** YYYY-MM-DD, UTC, the day the count resets. */
  resetsOn: string;
}

function usageFacts(payload: LifecyclePayload): UsageFacts | null {
  const used = wholeNumber(payload.used);
  const cap = wholeNumber(payload.cap);
  const resetsOn = isoDate(payload.period_end);
  if (used == null || cap == null || cap <= 0 || !resetsOn) return null;
  return { used, cap, resetsOn };
}

/**
 * "$5", read off the plan catalogue so a repricing of Personal cannot leave a
 * stale number in an email. Whole dollars when the price is whole, otherwise
 * the usual two decimals.
 */
// USD on purpose: these go to Free workspaces, which have never been charged,
// so there is no charged currency to follow.
function personalMonthlyPrice(): string {
  const cents = PLANS.personal.monthlyPriceCents;
  return cents % 100 === 0 ? `$${cents / 100}` : formatAmount(cents, 'usd');
}

/**
 * The dashboard link that starts the Personal upgrade.
 *
 * `upgrade` and `interval` are the pair components/dashboard/App.jsx validates
 * through parseUpgradeIntent; BOTH must be present or the intent is dropped and
 * the reader lands on a plain settings page. `interval=month` is deliberate: the
 * email quotes a monthly price, and the default at every in-product paywall
 * stays monthly. `offer=usage_cap` names the surface for attribution and is
 * ignored by consumers that do not read it.
 */
function usageUpgradeUrl(base: string): string {
  return `${base}/dashboard/settings?upgrade=personal&interval=month&offer=usage_cap`;
}

/** Nothing is ever deleted on a downgrade, and saying so removes real anxiety. */
const NOTHING_DELETED =
  'Nothing is deleted either way. Your inbox connections, API keys and settings stay exactly where they are, and reconnecting is one click if you come back.';

/** Decision D3: the one sentence about parking, stated as a fact. */
export const CANCEL_PARKING_SENTENCE =
  'When your plan ends, one inbox stays active on Free and the others are parked, not deleted. They come back if you subscribe again.';

/** True when the cancel confirmation carries the parking sentence. */
function cancelMentionsParking(payload: LifecyclePayload): boolean {
  return typeof payload.parkInboxCount === 'number' && payload.parkInboxCount > 1 && payload.grandfathered !== true;
}

// ---------------------------------------------------------------------------
// Pass notice helpers
// ---------------------------------------------------------------------------

/** "$9", "$86.40", "$29": whole dollars when whole, from the catalogue. */
function dollars(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : formatAmount(cents, 'usd');
}

/**
 * The three ways to keep Personal, as links to the checkout start route. A
 * Personal subscription bought by a pass holder is anchored to the pass end
 * by checkout-core, so nobody pays twice for the same days.
 */
function passOptions(base: string, firstChargeOn: string | null) {
  const monthly = dollars(PLANS.personal.monthlyPriceCents);
  const yearlyCents = PLANS.personal.yearlyPriceCents;
  const on = firstChargeOn ? `, first charge on ${firstChargeOn}` : '';
  const options: Array<{ label: string; url: string }> = [
    {
      label: `Subscribe monthly, ${monthly} a month${on}`,
      url: `${base}/api/stripe/checkout/start?plan=personal&interval=month`,
    },
  ];
  if (yearlyCents) {
    options.push({
      label: `Yearly, ${dollars(yearlyCents)} a year${on}`,
      url: `${base}/api/stripe/checkout/start?plan=personal&interval=year`,
    });
  }
  options.push({
    label: `Another 3 months, ${dollars(PERSONAL_PASS_3M.priceCents)}, paid once`,
    url: `${base}/api/stripe/checkout/start?product=personal_pass_3m&arm=holder&from=pass_reminder`,
  });
  return options;
}

/** What Free means after a pass, from the catalogue. */
function freeAfterPass(): string {
  const inboxes = PLANS.free.limits.maxInboxes;
  const inboxPhrase = inboxes === 1 ? 'one inbox' : `${inboxes} inboxes`;
  return `${FREE_ACTION_ALLOWANCE} email actions a month and ${inboxPhrase} for new connections`;
}

const PASS_KEEPS = 'Your inboxes, drafts and settings stay.';

// ---------------------------------------------------------------------------
// The HTML shell
// ---------------------------------------------------------------------------

/** Shared with src/lib/email/referral-emails.ts, so every transactional email looks alike. */
export interface ShellOptions {
  title: string;
  /** Blocks of already-escaped HTML. */
  html: string;
  ctaUrl?: string;
  ctaLabel?: string;
  footerNote: string;
  unsubscribe?: string | null;
}

export function shell(options: ShellOptions): string {
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
              <p style="margin:14px 0 0;font-size:11px;color:#94a3b8;line-height:1.6;">${escapeHtml(POSTAL_ADDRESS_LINE)}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function p(text: string): string {
  return `<p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">${escapeHtml(text)}</p>`;
}

function h(text: string): string {
  return `<p style="margin:0 0 8px;font-size:16px;font-weight:700;color:#0f172a;">${escapeHtml(text)}</p>`;
}

/**
 * A sentence followed by a real link, for the secondary URLs the CTA button
 * does not carry. The href is attribute-escaped, so a query string's `&`
 * renders as `&amp;` in the source and as `&` in the reader's browser.
 */
function pLink(text: string, url: string): string {
  return `<p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">${escapeHtml(text)} <a href="${escapeHtml(url)}" style="color:#3b82f6;word-break:break-all;">${escapeHtml(url)}</a></p>`;
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

/**
 * The human footers. Neither carries the postal address: `shell()` renders
 * POSTAL_ADDRESS_LINE beneath whichever of these it was given, and every
 * plain-text body ends with the same line, so the legal identifier reaches all
 * nine templates from one place instead of nine. Adding it to the copy here
 * would put a registration number in the middle of a sentence written to sound
 * like a person.
 */
const SUPPORT_FOOTER = `Something look wrong, or is this a bad time? Reply to this email or write to <a href="mailto:${SUPPORT_ADDRESS}" style="color:#3b82f6;">${SUPPORT_ADDRESS}</a>. We reply within one business day.`;

const SUPPORT_FOOTER_TEXT = `Something look wrong, or is this a bad time? Reply to this email or write to ${SUPPORT_ADDRESS}. We reply within one business day.`;

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
// Cancellation confirmation helpers (cancel_ask only)
// ---------------------------------------------------------------------------

const WITHDRAWAL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The withdrawal sentence, without its link, or null when it must not show.
 *
 * When the payload says when the first charge was (`firstChargeAt`), the line
 * shows only inside the 14-day window and says so plainly. When it does not
 * (every row queued today), the conditional wording stays, because the line is
 * also the customer's written pointer to the stronger remedy.
 */
function cancelWithdrawalSentence(payload: LifecyclePayload, nowMs: number): string | null {
  const first = payload.firstChargeAt ? new Date(payload.firstChargeAt).getTime() : Number.NaN;
  if (Number.isNaN(first)) {
    return 'If your first charge was less than 14 days ago, you can also withdraw from the contract and we refund that charge in full';
  }
  return nowMs - first < WITHDRAWAL_WINDOW_MS
    ? 'Your first charge was less than 14 days ago, so you can also withdraw from the contract and we refund that charge in full'
    : null;
}

/** Unix seconds of the cancelled period's end, from the queue scope or the payload. */
function cancelPeriodEndSeconds(payload: LifecyclePayload): number | null {
  if (typeof payload.periodEndSeconds === 'number' && Number.isInteger(payload.periodEndSeconds)) {
    return payload.periodEndSeconds;
  }
  if (!payload.periodEnd) return null;
  const ms = new Date(payload.periodEnd).getTime();
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/**
 * The seven one-tap reason links, or null when no signed token can be made
 * (no subscription id on the row, or no usable secret). The links only OPEN
 * /billing/feedback with the reason preselected; nothing is recorded until the
 * reader presses Send there, because mail scanners prefetch every link.
 */
function cancelReasonLinks(
  base: string,
  payload: LifecyclePayload,
): Array<{ label: string; url: string }> | null {
  if (!payload.subscriptionId) return null;
  const token = issueFeedbackToken({
    subscriptionId: payload.subscriptionId,
    customerId: payload.stripeCustomerId ?? null,
    periodEnd: cancelPeriodEndSeconds(payload),
  });
  if (!token) return null;
  return CANCEL_REASONS.map((reason) => ({
    label: CANCEL_REASON_EMAIL_LABELS[reason],
    url: `${base}/billing/feedback?t=${encodeURIComponent(token)}&r=${reason}`,
  }));
}

/**
 * Monthly or not. `interval` when the queue wrote it; otherwise read off the
 * charged amount, which is far below half a year's price on every monthly
 * price we have sold (including the older Personal and Pro prices) and above
 * it on every annual one. Unknown means not monthly: the paragraph is left out
 * rather than shown to an annual customer.
 */
function cancelIsMonthly(payload: LifecyclePayload): boolean {
  if (payload.interval) return payload.interval === 'month';
  if (!payload.planId || payload.amountCents == null || payload.amountCents <= 0) return false;
  const plan = PLANS[payload.planId];
  if (!plan?.yearlyPriceCents) return false;
  return payload.amountCents < plan.yearlyPriceCents / 2;
}

/**
 * The one neutral paragraph about pausing or a smaller plan, or null.
 *
 * Shown only when BILLING_PAUSE_ENABLED is 'on' (read at call time, so the
 * switch needs no deploy), on a monthly Personal or Pro plan, and never after a
 * cancellation that came from switching to Free (`source` 'billing_switch_free').
 * Pro gets both options; Personal is already the smallest paid plan, so it gets
 * the pause only. Business and annual plans get nothing.
 */
function cancelRetentionOffer(base: string, payload: LifecyclePayload): { text: string; url: string } | null {
  if (process.env.BILLING_PAUSE_ENABLED !== 'on') return null;
  if (payload.source === 'billing_switch_free') return null;
  if (payload.planId !== 'personal' && payload.planId !== 'solo') return null;
  if (!cancelIsMonthly(payload)) return null;
  const url = `${base}/dashboard/settings?src=cancel_email#billing`;
  const text =
    payload.planId === 'solo'
      ? `If you only need a break or a smaller plan: you can pause for up to 3 months, or switch to ${planDisplayName('personal')}, from your billing page. Either one replaces this cancellation.`
      : 'If you only need a break: you can pause for up to 3 months from your billing page. That replaces this cancellation.';
  return { text, url };
}

// ---------------------------------------------------------------------------
// Confirm-the-payment variant (SCA / 3DS)
// ---------------------------------------------------------------------------

/**
 * Stripe's code for a renewal the customer's bank wants them to approve in
 * person (EU Strong Customer Authentication). Set either by the decline code
 * on the failed payment intent or, forced, by `invoice.payment_action_required`.
 */
export const CONFIRM_PAYMENT_DECLINE_CODE = 'authentication_required';

/** True when this dunning payload is a bank approval, not a declined card. */
export function isConfirmPayment(payload: LifecyclePayload): boolean {
  return payload.declineCode === CONFIRM_PAYMENT_DECLINE_CODE;
}

const CONFIRM_CTA = 'Confirm the payment';

/**
 * dunning_1/3/7 for a renewal the bank wants approved.
 *
 * The card works, so nothing here asks for a new one, and Stripe's automatic
 * retries cannot answer a 3DS challenge, so nothing here promises a retry will
 * fix it. The CTA is the hosted invoice page, which runs the challenge.
 */
function composeConfirmPayment(
  template: 'dunning_1' | 'dunning_3' | 'dunning_7',
  ctx: {
    category: BillingCategory;
    base: string;
    payUrl: string;
    yourPlan: string;
    amount: string | null;
    consequence: string | null;
  },
): ComposedLifecycleEmail {
  const { category, base, payUrl, yourPlan, amount, consequence } = ctx;
  const signOff = ['', SUPPORT_FOOTER_TEXT, '', 'MCPEmails', base, '', POSTAL_ADDRESS_LINE];
  const collapse = (lines: string[]) =>
    lines.filter((line, i, all) => !(line === '' && all[i - 1] === '')).join('\n');

  if (template === 'dunning_1') {
    const lead = amount
      ? `Your bank asked you to approve the ${amount} renewal for ${yourPlan} before it goes through. Nothing is wrong with the card.`
      : `Your bank asked you to approve the renewal for ${yourPlan} before it goes through. Nothing is wrong with the card.`;
    const running =
      'Your plan is still running and your agent has not lost anything. We keep paid access on while the payment waits for you, so there is no rush in the next hour.';
    const why =
      'Automatic retries cannot confirm a payment for you, so this one needs one tap from you. Your bank usually asks in their app or by SMS. If it is never confirmed, the subscription closes.';
    const how = 'Open the payment here and approve it when your bank asks. You do not need to tell us:';
    const stop =
      'And if you meant to stop, you do not have to do anything or reply to this. Leave it and it closes itself.';

    return {
      subject: 'Confirm your MCPEmails payment with your bank',
      category,
      body: collapse([
        lead,
        '',
        'NOTHING HAS STOPPED WORKING',
        running,
        '',
        'WHY IT NEEDS YOU',
        why,
        consequence ?? '',
        '',
        'CONFIRM IT IN ABOUT A MINUTE',
        how,
        payUrl,
        '',
        stop,
        ...signOff,
      ]),
      htmlBody: shell({
        title: 'Confirm your payment with your bank',
        html:
          p(lead) +
          h('Nothing has stopped working') +
          p(running) +
          h('Why it needs you') +
          p(why) +
          (consequence ? p(consequence) : '') +
          h('Confirm it in about a minute') +
          p('Open the payment and approve it when your bank asks. You do not need to tell us.') +
          p(stop),
        ctaUrl: payUrl,
        ctaLabel: CONFIRM_CTA,
        footerNote: SUPPORT_FOOTER,
      }),
    };
  }

  if (template === 'dunning_3') {
    const lead = amount
      ? `Three days on, the ${amount} for ${yourPlan} is still waiting for you to approve it with your bank.`
      : `Three days on, the renewal for ${yourPlan} is still waiting for you to approve it with your bank.`;
    const running =
      'Your plan is still running. We do not cut access off while a payment is waiting, but the automatic retries cannot approve it for you.';
    const stop =
      'If you would rather stop paying for this, that is a completely fine answer and you can ignore this. It closes on its own.';

    return {
      subject: "Your MCPEmails payment still needs your bank's approval",
      category,
      body: collapse([
        lead,
        '',
        running,
        '',
        'Approving it with your bank is the whole fix:',
        payUrl,
        '',
        stop,
        ...signOff,
      ]),
      htmlBody: shell({
        title: 'Your payment still needs your approval',
        html: p(lead) + p(running) + p(stop),
        ctaUrl: payUrl,
        ctaLabel: CONFIRM_CTA,
        footerNote: SUPPORT_FOOTER,
      }),
    };
  }

  const lead = `It has been a week since your bank asked you to approve the renewal for ${yourPlan}. The automatic retries cannot approve it for you, and if it stays unconfirmed the subscription closes.`;
  const running = 'Your plan is still running today. Nothing has been taken away yet.';
  return {
    subject: 'Your MCPEmails payment is still waiting for your approval',
    category,
    body: collapse([
      lead,
      '',
      running,
      '',
      consequence ? 'WHEN IT CLOSES' : '',
      consequence ?? '',
      consequence ? NOTHING_DELETED : '',
      consequence ? '' : '',
      'One approval with your bank ends this:',
      payUrl,
      ...signOff,
    ]),
    htmlBody: shell({
      title: 'Your payment is still waiting for you',
      html:
        p(lead) +
        p(running) +
        (consequence ? h('When it closes') + p(consequence) + p(NOTHING_DELETED) : ''),
      ctaUrl: payUrl,
      ctaLabel: CONFIRM_CTA,
      footerNote: SUPPORT_FOOTER,
    }),
  };
}

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
  const decline = declineCopy(payload.declineCode, payload.currency);
  const consequence = consequenceLine(payload);
  const endsOn = longDate(payload.periodEnd);

  // A renewal the bank wants approved (EU SCA / 3DS) gets its own copy for the
  // first three dunning emails. The card is fine and Stripe's retries cannot
  // answer a 3DS challenge, so "update the card" and "the retry picks it up"
  // are both false here. dunning_14 is the same for every decline code.
  if (
    isConfirmPayment(payload) &&
    (template === 'dunning_1' || template === 'dunning_3' || template === 'dunning_7')
  ) {
    return composeConfirmPayment(template, {
      category,
      base,
      payUrl,
      yourPlan,
      amount,
      consequence,
    });
  }

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
        '',
        POSTAL_ADDRESS_LINE,
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
        '',
        POSTAL_ADDRESS_LINE,
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
        '',
        POSTAL_ADDRESS_LINE,
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
        '',
        POSTAL_ADDRESS_LINE,
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
        '',
        POSTAL_ADDRESS_LINE,
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
    // Cancellation confirmed. The template keeps its NAME (`cancel_ask`): the
    // unique index, the tombstones and cancelOpenSequence all key on it.
    //
    // Order is fixed (Documents/plans/pause-downgrade-20261024.md, section 5):
    // the confirmation, the withdrawal line, the optional one-tap reason, and
    // LAST, after a divider, one neutral paragraph about pausing or a smaller
    // plan. Nothing is keyed to a reason, nothing asks "are you sure", and no
    // discount: the email confirms what the customer did.
    // ─────────────────────────────────────────────────────────────────────
    case 'cancel_ask': {
      const subject = 'Your MCPEmails cancellation is confirmed';
      const until = endsOn
        ? `It stays active until ${endsOn}, which you have already paid for.`
        : 'It stays active until the end of the period you have already paid for.';
      const lead = `You cancelled ${yourPlan}. ${until}`;
      const parking = cancelMentionsParking(payload) ? CANCEL_PARKING_SENTENCE : null;

      const withdrawalUrl = `${base}${WITHDRAWAL_PATH}`;
      const withdrawalText = cancelWithdrawalSentence(payload, Date.now());

      const reasonLinks = cancelReasonLinks(base, payload);
      const reasonLead = reasonLinks
        ? 'If you want to tell us why, one tap is enough:'
        : 'If you want to tell us why, just reply to this email.';
      const replyLine = 'Or just reply to this email.';

      const offer = cancelRetentionOffer(base, payload);

      const body = [
        lead,
        ...(parking ? [parking] : []),
        NOTHING_DELETED,
        '',
        ...(withdrawalText ? [`${withdrawalText}: ${withdrawalUrl}`, ''] : []),
        reasonLead,
        ...(reasonLinks
          ? [...reasonLinks.map(({ label, url }) => `${label}: ${url}`), replyLine]
          : []),
        '',
        ...(offer ? ['----------', '', offer.text, offer.url, ''] : []),
        CANCEL_FOOTER,
        '',
        'MCPEmails',
        base,
        '',
        POSTAL_ADDRESS_LINE,
      ].join('\n');

      const reasonHtml = reasonLinks
        ? h(reasonLead) +
          `<ul style="margin:0 0 12px;padding:0 0 0 20px;font-size:15px;color:#334155;line-height:1.9;">${reasonLinks
            .map(
              ({ label, url }) =>
                `<li><a href="${escapeHtml(url)}" style="color:#3b82f6;">${escapeHtml(label)}</a></li>`,
            )
            .join('')}</ul>` +
          p(replyLine)
        : p(reasonLead);

      return {
        subject,
        category,
        body,
        htmlBody: shell({
          title: 'Your cancellation is confirmed',
          html:
            p(lead) +
            (parking ? p(parking) : '') +
            p(NOTHING_DELETED) +
            (withdrawalText ? pLink(`${withdrawalText}.`, withdrawalUrl) : '') +
            reasonHtml +
            (offer
              ? '<hr style="border:0;border-top:1px solid #e2e8f0;margin:24px 0;"/>' + pLink(offer.text, offer.url)
              : ''),
          footerNote: escapeHtml(CANCEL_FOOTER),
        }),
      };
    }

    // ─────────────────────────────────────────────────────────────────────
    // Pause. Both transactional: they are about money on a contract that is
    // still running. The receipt says what stays active and when billing
    // comes back; the reminder 3 days before says it again, with the cancel
    // route, so nobody is charged by surprise after a quiet few months.
    // ─────────────────────────────────────────────────────────────────────
    case 'pause_started': {
      const startsOn = longDate(payload.pauseStartsAt);
      const resumesOn = longDate(payload.billingResumesAt);
      const subject = startsOn
        ? `Your MCPEmails plan is paused from ${startsOn}`
        : 'Your MCPEmails plan is paused';
      const lead = `You paused ${yourPlan}. Here is what that means.`;
      const replaced = payload.replacedCancel
        ? 'This pause replaces the cancellation you had scheduled, so your subscription continues after it.'
        : null;
      const untilStart = startsOn
        ? `Until ${startsOn} nothing changes: you keep the plan you have already paid for.`
        : 'Until the end of the period you have already paid for, nothing changes.';
      const whileHeading = 'While the plan is paused';
      const whileLines = [
        payload.grandfathered
          ? null
          : 'One inbox stays active, the one you picked. Any others are parked, not deleted, and come back when billing resumes.',
        `You have the Free allowance of ${FREE_ACTION_ALLOWANCE} email actions a month, counted from the day the pause starts.`,
        'Scheduled sends you booked before the pause still go out as planned.',
        'Your API keys, connections and settings stay exactly as they are.',
      ].filter((line): line is string => line !== null);
      const resumes =
        resumesOn && amount
          ? `Billing resumes automatically on ${resumesOn} at ${amount}. We will email you 3 days before.`
          : resumesOn
            ? `Billing resumes automatically on ${resumesOn}. We will email you 3 days before.`
            : 'Billing resumes automatically at the end of the pause. We will email you 3 days before.';
      const options = `You can resume early, extend the pause or cancel at any time from your billing page: ${billingUrl}`;
      const cancelLine = `You can also cancel without signing in: ${base}${CANCEL_PATH}`;

      const factRows: Array<[string, string]> = [];
      if (name) factRows.push(['Plan', name]);
      if (startsOn) factRows.push(['Pause starts', startsOn]);
      if (resumesOn) factRows.push(['Billing resumes', resumesOn]);
      if (amount) factRows.push(['Then billed', amount]);

      const body = [
        lead,
        '',
        ...factRows.map(([label, value]) => `${label}: ${value}`),
        '',
        ...(replaced ? [replaced, ''] : []),
        untilStart,
        '',
        `${whileHeading}:`,
        ...whileLines.map((line) => `- ${line}`),
        '',
        resumes,
        '',
        options,
        cancelLine,
        '',
        SUPPORT_FOOTER_TEXT,
        '',
        'MCPEmails',
        base,
        '',
        POSTAL_ADDRESS_LINE,
      ].join('\n');

      return {
        subject,
        category,
        body,
        htmlBody: shell({
          title: 'Your plan is paused',
          html:
            p(lead) +
            (factRows.length > 0 ? facts(factRows) : '') +
            (replaced ? p(replaced) : '') +
            p(untilStart) +
            h(whileHeading) +
            whileLines.map((line) => p(line)).join('') +
            p(resumes) +
            pLink('You can resume early, extend the pause or cancel at any time from your billing page:', billingUrl) +
            pLink('You can also cancel without signing in:', `${base}${CANCEL_PATH}`),
          ctaUrl: billingUrl,
          ctaLabel: 'Open billing',
          footerNote: SUPPORT_FOOTER,
        }),
      };
    }

    case 'pause_ending_3': {
      const resumesOn = longDate(payload.billingResumesAt);
      const subject = resumesOn
        ? `Your MCPEmails plan resumes on ${resumesOn}`
        : 'Your MCPEmails plan resumes soon';
      const lead =
        resumesOn && amount
          ? `Your pause ends soon. Billing for ${yourPlan} resumes on ${resumesOn} at ${amount}.`
          : resumesOn
            ? `Your pause ends soon. Billing for ${yourPlan} resumes on ${resumesOn}.`
            : `Your pause ends soon, and billing for ${yourPlan} resumes at the end of it.`;
      const nothing =
        'There is nothing to do if you want to continue: your plan and any parked inboxes come back on their own.';
      const options = `If you would rather not continue yet, you can extend the pause or cancel before that date from your billing page: ${billingUrl}`;
      const cancelLine = `You can also cancel without signing in: ${base}${CANCEL_PATH}`;

      const factRows: Array<[string, string]> = [];
      if (name) factRows.push(['Plan', name]);
      if (resumesOn) factRows.push(['Billing resumes', resumesOn]);
      if (amount) factRows.push(['Amount', amount]);

      const body = [
        lead,
        '',
        nothing,
        '',
        options,
        cancelLine,
        '',
        SUPPORT_FOOTER_TEXT,
        '',
        'MCPEmails',
        base,
        '',
        POSTAL_ADDRESS_LINE,
      ].join('\n');

      return {
        subject,
        category,
        body,
        htmlBody: shell({
          title: 'Your plan resumes soon',
          html:
            p(lead) +
            (factRows.length > 0 ? facts(factRows) : '') +
            p(nothing) +
            pLink('If you would rather not continue yet, you can extend the pause or cancel before that date from your billing page:', billingUrl) +
            pLink('You can also cancel without signing in:', `${base}${CANCEL_PATH}`),
          ctaUrl: billingUrl,
          ctaLabel: 'Open billing',
          footerNote: SUPPORT_FOOTER,
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
        '',
        POSTAL_ADDRESS_LINE,
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
        '',
        POSTAL_ADDRESS_LINE,
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

    // ─────────────────────────────────────────────────────────────────────
    // 3-month Personal pass. Two service notices per pass, nothing after:
    // the date, what Free means, what stays, and the same three options.
    // No countdown, no urgency, no discount, never the word trial.
    // ─────────────────────────────────────────────────────────────────────
    case 'pass_ending_7d':
    case 'pass_ended': {
      if (!endsOn) {
        console.error(`[billing-email] ${template} not composed: no end date in the payload.`);
        return null;
      }
      const ending = template === 'pass_ending_7d';
      const subject = ending
        ? `Your MCPEmails Personal pass ends on ${endsOn}`
        : 'Your MCPEmails Personal pass has ended';
      const title = ending ? `Your Personal pass ends on ${endsOn}` : 'Your Personal pass has ended';
      const lead = ending
        ? `Your Personal pass ends on ${endsOn}. After that this workspace goes back to Free: ${freeAfterPass()}. ${PASS_KEEPS}`
        : `Your Personal pass ended on ${endsOn}, and the workspace is on Free: ${freeAfterPass()}. ${PASS_KEEPS}`;
      const ask = ending
        ? 'To keep Personal, pick one of these. Nothing happens unless you do.'
        : 'To go back to Personal, pick one of these. This is the only email about it.';
      // The first charge lands on the pass end only while the pass still runs.
      const options = passOptions(base, ending ? endsOn : null);
      const body = [
        lead,
        '',
        ask,
        '',
        ...options.flatMap((option) => [`${option.label}:`, option.url, '']),
        SUPPORT_FOOTER_TEXT,
        '',
        'MCPEmails',
        base,
        '',
        POSTAL_ADDRESS_LINE,
      ].join('\n');

      return {
        subject,
        category,
        body,
        htmlBody: shell({
          title,
          html:
            p(lead) +
            p(ask) +
            options.slice(1).map((option) => pLink(`${option.label}:`, option.url)).join(''),
          ctaUrl: options[0].url,
          ctaLabel: options[0].label,
          footerNote: SUPPORT_FOOTER,
        }),
      };
    }

    // ─────────────────────────────────────────────────────────────────────
    // Free allowance notices. Numbers first, declarative, no imperatives and
    // no exclamation marks: the reader is being told the state of their own
    // account, not sold to. The upgrade line is one sentence at the end and
    // is the same sentence in all three, so nobody reads two different
    // prices for the same thing.
    // ─────────────────────────────────────────────────────────────────────
    case 'usage_warning_80':
    case 'usage_limit_reached':
    case 'automation_paused_limit': {
      const usage = usageFacts(payload);
      if (!usage) {
        console.error(
          `[billing-email] ${template} not composed: payload is missing used, cap or period_end, so there are no numbers to print.`,
        );
        return null;
      }
      const usageUrl = `${base}/dashboard/usage`;
      const automationsUrl = `${base}/dashboard/automations`;
      const upgradeUrl = usageUpgradeUrl(base);
      const upgradeLine = `Personal removes the monthly cap for ${personalMonthlyPrice()} a month.`;
      const counted = `${usage.used} of ${usage.cap} email actions`;

      if (template === 'usage_warning_80') {
        const subject = `${counted} used this month`;
        const lead = `${counted} have been used on your Free workspace this month. The count resets on ${usage.resetsOn}.`;
        const stops =
          `At ${usage.cap}, email actions are refused until the reset, and any automations pause and resume automatically on ${usage.resetsOn}.`;
        const keeps =
          'The inbox list, the dashboard and your data are not affected. Nothing is deleted.';
        const body = [
          lead,
          '',
          `WHAT STOPS AT ${usage.cap}`,
          stops,
          '',
          'WHAT DOES NOT',
          keeps,
          '',
          'The current count is on the usage page:',
          usageUrl,
          '',
          upgradeLine,
          upgradeUrl,
          '',
          SUPPORT_FOOTER_TEXT,
          '',
          'MCPEmails',
          base,
          '',
          POSTAL_ADDRESS_LINE,
        ].join('\n');

        return {
          subject,
          category,
          body,
          htmlBody: shell({
            title: subject,
            html:
              p(lead) +
              facts([
                ['Used', `${usage.used} of ${usage.cap}`],
                ['Resets on', usage.resetsOn],
              ]) +
              h(`What stops at ${usage.cap}`) +
              p(stops) +
              h('What does not') +
              p(keeps) +
              pLink('The current count is on the usage page:', usageUrl) +
              pLink(upgradeLine, upgradeUrl),
            ctaUrl: usageUrl,
            ctaLabel: 'See the current count',
            footerNote: SUPPORT_FOOTER,
          }),
        };
      }

      if (template === 'usage_limit_reached') {
        const subject = `${counted} used, paused until ${usage.resetsOn}`;
        const lead = `${counted} have been used on your Free workspace this month, so email actions are refused until the count resets on ${usage.resetsOn}. Retrying will not help before then.`;
        const automations = `Any automations are paused and resume automatically on ${usage.resetsOn}.`;
        const keeps =
          'The inbox list, the dashboard and your data are not affected. Nothing is deleted.';
        const body = [
          lead,
          '',
          automations,
          keeps,
          '',
          'The count and the reset date are on the usage page:',
          usageUrl,
          '',
          upgradeLine,
          upgradeUrl,
          '',
          SUPPORT_FOOTER_TEXT,
          '',
          'MCPEmails',
          base,
          '',
          POSTAL_ADDRESS_LINE,
        ].join('\n');

        return {
          subject,
          category,
          body,
          htmlBody: shell({
            title: subject,
            html:
              p(lead) +
              facts([
                ['Used', `${usage.used} of ${usage.cap}`],
                ['Resets on', usage.resetsOn],
              ]) +
              p(automations) +
              p(keeps) +
              pLink('The count and the reset date are on the usage page:', usageUrl) +
              pLink(upgradeLine, upgradeUrl),
            ctaUrl: usageUrl,
            ctaLabel: 'See the usage page',
            footerNote: SUPPORT_FOOTER,
          }),
        };
      }

      // automation_paused_limit
      const ruleName = payload.rule_name?.trim() || 'Unnamed automation';
      const subject = `Automation "${ruleName}" paused until ${usage.resetsOn}`;
      const lead = `The automation "${ruleName}", and any other automation in this workspace, is paused because the workspace reached its monthly allowance (${counted}). They resume automatically on ${usage.resetsOn}.`;
      const keeps =
        'Nothing was deleted. Your rules, their settings and everything they already did are unchanged, and no other part of the account is affected.';
      const body = [
        lead,
        '',
        keeps,
        '',
        'The rule is on the automations page:',
        automationsUrl,
        '',
        upgradeLine,
        upgradeUrl,
        '',
        SUPPORT_FOOTER_TEXT,
        '',
        'MCPEmails',
        base,
        '',
        POSTAL_ADDRESS_LINE,
      ].join('\n');

      return {
        subject,
        category,
        body,
        htmlBody: shell({
          title: `Automation paused until ${usage.resetsOn}`,
          html:
            p(lead) +
            facts([
              ['Automation', ruleName],
              ['Used', `${usage.used} of ${usage.cap}`],
              ['Resumes on', usage.resetsOn],
            ]) +
            p(keeps) +
            pLink('The rule is on the automations page:', automationsUrl) +
            pLink(upgradeLine, upgradeUrl),
          ctaUrl: automationsUrl,
          ctaLabel: 'See the automation',
          footerNote: SUPPORT_FOOTER,
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
  return key ? createResend(key) : null;
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
  /**
   * Invoice id, subscription id or card key on the Stripe-keyed rows; the
   * period start (usage_*) or the rule id (automation_paused_limit) on the
   * workspace-keyed ones. Part of the Resend idempotency key for Stripe rows.
   */
  scopeKey: string;
  /**
   * Set on the workspace-keyed usage rows, where `stripe_customer_id` is NULL.
   * With `periodStart` and the template it forms the idempotency key, matching
   * the database's UNIQUE (workspace_id, template, period_start).
   */
  workspaceId?: string | null;
  periodStart?: string | null;
  payload: LifecyclePayload;
}

export type SendBillingEmailResult =
  | { ok: true; resendId: string | null }
  | { ok: false; reason: string };

/**
 * The minimum of a `billing_email_sends` row the dispatcher hands to the
 * sender. Declared here, next to the key derivation, so the route's QueueRow
 * and this module cannot disagree about which columns matter.
 */
export interface LifecycleQueueRowInput {
  stripe_customer_id: string | null;
  workspace_id?: string | null;
  period_start?: string | null;
  recipient: string;
  template: BillingTemplate;
  scope_key: string;
  payload: LifecyclePayload | null;
}

/** A claimed queue row to the sender's input. Pure; no resolution happens here. */
export function sendInputForQueueRow(row: LifecycleQueueRowInput): SendBillingEmailInput {
  return {
    to: row.recipient,
    template: row.template,
    scopeKey: row.scope_key,
    workspaceId: row.workspace_id ?? null,
    periodStart: row.period_start ?? null,
    payload: payloadForQueueRow(row),
  };
}

/**
 * The payload a queued row composes from. For `cancel_ask` it adds the
 * cancellation's identity, which the queue writer already put in the row
 * (queueCancellationSequence: scope_key `${subscriptionId}:${periodEndSeconds}`
 * or just the subscription id), so the signed reason links can be made without
 * storing anything new. Values already in the payload win. Pure.
 */
export function payloadForQueueRow(row: LifecycleQueueRowInput): LifecyclePayload {
  const payload = row.payload ?? {};
  if (row.template !== 'cancel_ask') return payload;
  const match = /^(sub_[A-Za-z0-9]+)(?::(\d+))?$/.exec(row.scope_key);
  if (!match) return payload;
  return {
    ...payload,
    subscriptionId: payload.subscriptionId ?? match[1],
    stripeCustomerId: payload.stripeCustomerId ?? row.stripe_customer_id,
    periodEndSeconds: payload.periodEndSeconds ?? (match[2] ? Number(match[2]) : null),
  };
}

/**
 * The Resend Idempotency-Key. Keyed on what the email is ABOUT, matching the
 * database's uniqueness, so a dispatcher retry after a lost response delivers
 * one email, not two.
 *
 *   Stripe-keyed rows      `${template}-${scope_key}`
 *                          (UNIQUE (stripe_customer_id, template, scope_key);
 *                          scope_key is already unique per customer).
 *   Workspace-keyed rows   `${template}-${workspace_id}-${period_start}`
 *                          (UNIQUE (workspace_id, template, period_start)).
 *
 * `period_start` is normalised to a UTC ISO string because Postgres serialises
 * a timestamptz as "+00:00" and JavaScript as "Z"; the key must not depend on
 * which side last touched the value. Resend caps the key at 256 characters.
 */
export function lifecycleIdempotencyKey(
  input: Pick<SendBillingEmailInput, 'template' | 'scopeKey' | 'workspaceId' | 'periodStart'>,
): string {
  const key =
    input.workspaceId && isUsageTemplate(input.template)
      ? `${input.template}-${input.workspaceId}-${normaliseIso(input.periodStart) ?? input.scopeKey}`
      : `${input.template}-${input.scopeKey}`;
  return key.slice(0, 256);
}

function normaliseIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

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

    // Win-backs go out from the founder sender, so a reply goes back to the
    // founder (lifecycleReplyTo), never to support@. Transactional mail keeps
    // support@. The cancellation question is the one transactional email whose
    // entire purpose is the reply, so it can be pointed elsewhere.
    const replyTo =
      category === 'marketing'
        ? lifecycleReplyTo()
        : input.template === 'cancel_ask'
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
      // Keyed on what the email is ABOUT, matching the database's uniqueness
      // for whichever way the row is keyed. See lifecycleIdempotencyKey.
      { idempotencyKey: lifecycleIdempotencyKey(input) },
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
