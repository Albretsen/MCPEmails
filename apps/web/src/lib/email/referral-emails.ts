/**
 * The three referral reward emails, sent once when a reward is issued by the
 * dispatcher (app/api/internal/referrals/dispatch/route.ts):
 *
 *   referral_referrer_credit    a paying referrer got a month of credit
 *   referral_referrer_personal  a Free referrer got a month of Personal
 *   referral_friend_credit      the friend got their second month as credit
 *
 * TRANSACTIONAL. Each one confirms a change to the recipient's own account
 * (credit on their next invoice, a plan turned on until a date), so they go
 * from the billing address with no unsubscribe, exactly like the billing
 * lifecycle notices, and through the same HTML shell. Nobody is ever emailed
 * about a voided, held or capped referral.
 *
 * HOW IT SENDS. Resend, one attempt, never throws, an Idempotency-Key per
 * referral and side, as src/lib/email/billing-lifecycle.ts. The dispatcher
 * skips deleted accounts before calling this (accountState).
 *
 * LOCALE. English only, like every billing email: the dispatcher has no
 * request and the interface language never reaches the server.
 *
 * COPY. Section 8 of the referral plan. Plan names through planDisplayName,
 * never a slug; no amounts in dollars (the credit is "one month of <plan>"),
 * no durations in days.
 */

import { Resend } from 'resend';

import { planDisplayName } from '@/lib/stripe/plans';
import { POSTAL_ADDRESS_LINE } from '@/lib/email/legal';
import { appUrl } from '@/lib/email/lifecycle';
import { p, shell } from '@/lib/email/billing-lifecycle';

const SUPPORT_ADDRESS = 'hello@mcpemails.com';
const DEFAULT_FROM = `MCPEmails <${SUPPORT_ADDRESS}>`;

export type ReferralEmailTemplate =
  | 'referral_referrer_credit'
  | 'referral_referrer_personal'
  | 'referral_friend_credit';

export interface ReferralEmailInput {
  template: ReferralEmailTemplate;
  to: string;
  referralId: string;
  /** Plan slug the credit is a month of (credit templates). */
  plan?: string | null;
  /** End of the Personal month, ISO (referral_referrer_personal). */
  until?: string | null;
}

export interface ComposedReferralEmail {
  subject: string;
  text: string;
  html: string;
}

function longDate(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

const FOOTER = `Questions? Reply to this email or write to <a href="mailto:${SUPPORT_ADDRESS}" style="color:#3b82f6;">${SUPPORT_ADDRESS}</a>.`;
const FOOTER_TEXT = `Questions? Reply to this email or write to ${SUPPORT_ADDRESS}.`;

/** Null when the input cannot make an honest email (no plan, no date). */
export function composeReferralEmail(input: ReferralEmailInput): ComposedReferralEmail | null {
  let subject: string;
  let paragraphs: string[];
  if (input.template === 'referral_referrer_credit' || input.template === 'referral_friend_credit') {
    if (!input.plan || input.plan === 'free') return null;
    const plan = planDisplayName(input.plan);
    if (input.template === 'referral_referrer_credit') {
      subject = 'You earned a free month of MCPEmails';
      paragraphs = [
        'A friend you invited is now an MCPEmails customer.',
        `We added one month of ${plan} as credit to your account. It applies to your next invoice.`,
      ];
    } else {
      subject = 'Your second month of MCPEmails is on us';
      paragraphs = [
        "Thanks for joining through a friend's invite.",
        `We added one month of ${plan} as credit; your next invoice uses it.`,
      ];
    }
  } else {
    const until = input.until ? longDate(input.until) : null;
    if (!until) return null;
    subject = 'You earned a free month of MCPEmails';
    paragraphs = [
      'A friend you invited is now an MCPEmails customer.',
      `We turned on a month of Personal for you, until ${until}.`,
    ];
  }

  const dashboard = `${appUrl()}/dashboard`;
  const ctaLabel = 'Open your dashboard';
  const text = [
    ...paragraphs.flatMap((para) => [para, '']),
    `${ctaLabel}: ${dashboard}`,
    '',
    FOOTER_TEXT,
    '',
    POSTAL_ADDRESS_LINE,
  ].join('\n');
  const html = shell({
    title: subject,
    html: paragraphs.map((para) => p(para)).join(''),
    ctaUrl: dashboard,
    ctaLabel,
    footerNote: FOOTER,
  });
  return { subject, text, html };
}

export type ReferralEmailResult = { ok: true } | { ok: false; reason: string };

/** Send one reward email. NEVER THROWS. */
export async function sendReferralEmail(input: ReferralEmailInput): Promise<ReferralEmailResult> {
  try {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      console.error('[referral-email] no RESEND_API_KEY configured; skipping send');
      return { ok: false, reason: 'no_api_key' };
    }
    const to = input.to?.trim() ?? '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { ok: false, reason: 'unusable_recipient' };
    const composed = composeReferralEmail(input);
    if (!composed) return { ok: false, reason: 'not_composable' };

    const { error } = await new Resend(key).emails.send(
      {
        from: process.env.BILLING_EMAIL_FROM ?? DEFAULT_FROM,
        to,
        replyTo: SUPPORT_ADDRESS,
        subject: composed.subject,
        html: composed.html,
        text: composed.text,
      },
      { idempotencyKey: `${input.template}-${input.referralId}` },
    );
    if (error) {
      console.error(`[referral-email] ${input.template} FAILED`, { referral: input.referralId });
      return { ok: false, reason: 'resend_error' };
    }
    console.log(`[referral-email] ${input.template} sent`, { referral: input.referralId });
    return { ok: true };
  } catch (err) {
    console.error('[referral-email] unexpected failure, swallowed:', {
      template: input.template,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: 'unexpected_error' };
  }
}
