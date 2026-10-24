/**
 * Copy for the one Black Week 2026 email (see black-week-email.ts for who gets
 * it and when).
 *
 * LIFECYCLE, NOT TRANSACTIONAL. Same rules as the paywall follow-up: a
 * one-click List-Unsubscribe header, a visible opt-out link built from the
 * reader's own unsubscribe token, the postal line, and no email at all when
 * there is no token. English only, like every other lifecycle email.
 *
 * EVERY AMOUNT IS LIVE. The first-year price, the renewal price and the saving
 * come from the SeasonalOffer objects that getActiveSeasonalOffers() built from
 * Stripe at send time, so nothing here can disagree with checkout.
 *
 * COPY RULES (Black Week contract): the product is MCPEmails; no em dashes; no
 * countdown, no "hurry" or "last chance"; no "was $X"; the renewal price sits
 * in the same sentence as the first-year price; straight apostrophes; plan
 * names from planDisplayName. Every version carries the sentence about
 * switching from monthly, and it describes what the switch path really does:
 * checkout-core.ts swaps the price with proration_behavior 'always_invoice',
 * so Stripe credits the unused part of the current month on the same invoice
 * that charges the discounted annual price.
 */

import { formatPriceCents } from '@/lib/stripe/annual-offer';
import { planDisplayName } from '@/lib/stripe/plans';
import type { SeasonalOffer, SeasonalOffers } from '@/lib/stripe/seasonal-offer';
import { pricingCompareHref, upgradeDestination } from '@/lib/billing/upgrade-intent.mjs';
import { appUrl, unsubscribeUrl } from '@/lib/email/lifecycle';
import { POSTAL_ADDRESS_LINE } from '@/lib/email/legal';
import { lifecycleParagraph as p, lifecycleShell } from '@/lib/email/paywall-followup-templates';

/** Who the email is written for. */
export type BlackWeekSegment = 'free' | 'monthly_personal' | 'monthly_pro';

export const BLACK_WEEK_EMAIL_CATEGORY = 'lifecycle' as const;

/** The public end of the offer, as every surface states it. */
export const BLACK_WEEK_ENDS_LINE = 'The offer ends 1 December 2026, 23:59 Oslo time.';

/** The sentence every version carries (the Free version verbatim). */
export const SWITCH_SENTENCE =
  'Already paying monthly? Switch to annual and the unused days of your current month are taken off, so you pay a bit less than that today.';

const UNSUBSCRIBE_REASON =
  'You are getting this because you asked for product tips and offers when you signed up.';

export interface BlackWeekEmailInput {
  segment: BlackWeekSegment;
  offers: SeasonalOffers;
  unsubscribeToken: string | null | undefined;
}

export interface ComposedBlackWeekEmail {
  subject: string;
  text: string;
  html: string;
  ctaUrl: string;
  unsubscribeUrl: string;
  headers: Record<string, string>;
}

function money(cents: number): string {
  return formatPriceCents(cents);
}

/** "Personal annual is $59 for your first year, then $86.40 a year. You save $27.40." */
function offerLine(offer: SeasonalOffer): string {
  return (
    `${planDisplayName(offer.planId)} annual is ${money(offer.firstYearCents)} for your first year, ` +
    `then ${money(offer.normalYearlyCents)} a year. You save ${money(offer.savingCents)}.`
  );
}

/**
 * Compose the email for one segment. Null when it must not be sent: no
 * unsubscribe token, or an offer the segment needs is not live.
 */
export function composeBlackWeekEmail(input: BlackWeekEmailInput): ComposedBlackWeekEmail | null {
  const token = typeof input.unsubscribeToken === 'string' ? input.unsubscribeToken.trim() : '';
  if (!token) return null;
  const personal = input.offers.personal;
  const pro = input.offers.solo;
  if (!personal || !pro) return null;

  const base = appUrl();
  const unsub = unsubscribeUrl(token, BLACK_WEEK_EMAIL_CATEGORY);
  const personalName = planDisplayName('personal');
  const proName = planDisplayName('solo');

  let subject: string;
  let title: string;
  let paragraphs: string[];
  let ctaLabel: string;
  let ctaUrl: string;

  switch (input.segment) {
    case 'free': {
      // No first-year price in a subject line: it could not carry the renewal
      // price next to it. The monthly versions name the saving instead.
      subject = 'Black Week: a lower first year on MCPEmails annual plans';
      title = 'Black Week: a lower first year on annual plans';
      paragraphs = [
        'For Black Week, the annual MCPEmails plans cost less for your first year.',
        offerLine(personal),
        offerLine(pro),
        'Choose annual at checkout and the first-year price is applied for you. Monthly prices stay as they are.',
        SWITCH_SENTENCE,
        BLACK_WEEK_ENDS_LINE,
        'If you have a question first, reply to this email. I read every reply.',
      ];
      ctaLabel = 'See the annual plans';
      ctaUrl = `${base}${pricingCompareHref('personal', true)}`;
      break;
    }
    case 'monthly_personal': {
      subject = `Black Week: switch ${personalName} to annual and save ${money(personal.savingCents)} on your first year`;
      title = `Switch ${personalName} to annual for less`;
      paragraphs = [
        `You pay for ${personalName} monthly. For Black Week, you can switch to ${personalName} annual for ${money(personal.firstYearCents)} for your first year, then ${money(personal.normalYearlyCents)} a year. You save ${money(personal.savingCents)}.`,
        `Switch to annual and the unused days of your current month are taken off, so you pay a bit less than ${money(personal.firstYearCents)} today.`,
        `If you want more inboxes, ${proName} annual is ${money(pro.firstYearCents)} for your first year, then ${money(pro.normalYearlyCents)} a year.`,
        'Nothing changes unless you switch. You see the exact amount in your dashboard before you confirm.',
        BLACK_WEEK_ENDS_LINE,
        'If you have a question first, reply to this email. I read every reply.',
      ];
      ctaLabel = 'Switch to annual';
      ctaUrl = `${base}${upgradeDestination('personal', true)}`;
      break;
    }
    case 'monthly_pro': {
      subject = `Black Week: switch ${proName} to annual and save ${money(pro.savingCents)} on your first year`;
      title = `Switch ${proName} to annual for less`;
      paragraphs = [
        `You pay for ${proName} monthly. For Black Week, you can switch to ${proName} annual for ${money(pro.firstYearCents)} for your first year, then ${money(pro.normalYearlyCents)} a year. You save ${money(pro.savingCents)}.`,
        `Switch to annual and the unused days of your current month are taken off, so you pay a bit less than ${money(pro.firstYearCents)} today.`,
        'Nothing changes unless you switch. You see the exact amount in your dashboard before you confirm.',
        BLACK_WEEK_ENDS_LINE,
        'If you have a question first, reply to this email. I read every reply.',
      ];
      ctaLabel = 'Switch to annual';
      ctaUrl = `${base}${upgradeDestination('solo', true)}`;
      break;
    }
    default:
      return null;
  }

  const text = [
    'Hi,',
    '',
    ...paragraphs.flatMap((para) => [para, '']),
    `${ctaLabel}: ${ctaUrl}`,
    '',
    'Asgeir',
    'MCPEmails',
    '',
    `${UNSUBSCRIBE_REASON} Unsubscribe: ${unsub}`,
    'Billing and account notices are separate and are not affected.',
    '',
    POSTAL_ADDRESS_LINE,
  ].join('\n');

  const html = lifecycleShell({
    title,
    html: p('Hi,') + paragraphs.map((para) => p(para)).join('') + p('Asgeir'),
    ctaUrl,
    ctaLabel,
    footerNote: 'Replies come straight to me, not a ticket queue.',
    unsubscribeUrl: unsub,
    unsubscribeReason: UNSUBSCRIBE_REASON,
  });

  return {
    subject,
    text,
    html,
    ctaUrl,
    unsubscribeUrl: unsub,
    headers: {
      'List-Unsubscribe': `<${unsub}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}
