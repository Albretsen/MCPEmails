/**
 * The one email announcing the Pro price change (pro-price-change.ts).
 *
 * ONE SEND, ONCE. Sent by scripts/pro-price-notice-send.ts on the announcement
 * day, never by a cron, never again: no reminder, no "last chance". Idempotent
 * through `lifecycle_email_sends` (template PRO_PRICE_NOTICE_TEMPLATE, trigger
 * key = the switch date), claimed before sending, plus a Resend
 * Idempotency-Key, exactly like the paywall follow-up.
 *
 * WHO. Owners of a live Free workspace who:
 *   - gave explicit marketing consent at signup (users.marketing_consent_at)
 *   - are not unsubscribed globally or from 'product_update'
 *   - have an unsubscribe token (no working opt-out, no email)
 *   - are not one of ours
 *   - have no active, trialing, past_due or unpaid subscription
 *   - were active in the last ACTIVE_DAYS days (an API key used, or a
 *     workspace created, in that window)
 * Pro subscribers are not emailed: nothing changes for them.
 *
 * WHAT. Plain text first, English, from the lifecycle sender. Every amount and
 * date comes from PRO_PRICE_CHANGE through pro-price-notice-copy.mjs. No "was"
 * price, no countdown, no percentage.
 */

import { PRO_PRICE_CHANGE, proPriceNoticeVisible } from '@/lib/stripe/pro-price-change';
import { PRO_INBOX_CAP } from '@/lib/stripe/plans';
import { proPriceNoticeValues } from '@/lib/stripe/pro-price-notice-copy.mjs';
import { appUrl, unsubscribeUrl, type LifecycleCategory } from '@/lib/email/lifecycle';
import { POSTAL_ADDRESS_LINE } from '@/lib/email/legal';
import {
  LIFECYCLE_UNSUBSCRIBE_REASON,
  lifecycleParagraph,
  lifecycleShell,
} from '@/lib/email/paywall-followup-templates';

export const PRO_PRICE_NOTICE_TEMPLATE = 'pro_price_notice';
export const PRO_PRICE_NOTICE_CATEGORY: LifecycleCategory = 'product_update';
export const ACTIVE_DAYS = 60;

/** The ledger key: one notice per person per announced switch date. */
export function proPriceNoticeTriggerKey(): string {
  return PRO_PRICE_CHANGE.switchDate;
}

export interface NoticeCandidate {
  userId: string;
  email: string | null;
  marketingConsentAt: string | null;
  unsubscribedAt: string | null;
  unsubscribedCategories: string[] | null;
  unsubscribeToken: string | null;
  internal: boolean;
  /** Plans of the user's live (not deleted) owned workspaces. */
  ownedPlans: string[];
  subscriptionStatus: string | null;
  /** Latest of: any owned workspace's API key last use, workspace creation. */
  lastActiveAt: string | null;
  /** A ledger row already exists for this notice. */
  alreadyClaimed: boolean;
}

export type NoticeDecision =
  | { send: true }
  | {
      send: false;
      reason:
        | 'no_email'
        | 'no_consent'
        | 'unsubscribed'
        | 'no_token'
        | 'internal'
        | 'not_free'
        | 'subscribed'
        | 'inactive'
        | 'already_sent';
    };

const PAYING = new Set(['active', 'trialing', 'past_due', 'unpaid']);

/** Pure: whether this person gets the notice. Order is cheapest-first. */
export function decideNotice(c: NoticeCandidate, now: Date = new Date()): NoticeDecision {
  if (!c.email) return { send: false, reason: 'no_email' };
  if (!c.marketingConsentAt) return { send: false, reason: 'no_consent' };
  if (c.unsubscribedAt || (c.unsubscribedCategories ?? []).includes(PRO_PRICE_NOTICE_CATEGORY)) {
    return { send: false, reason: 'unsubscribed' };
  }
  if (!c.unsubscribeToken) return { send: false, reason: 'no_token' };
  if (c.internal) return { send: false, reason: 'internal' };
  if (c.subscriptionStatus && PAYING.has(c.subscriptionStatus)) {
    return { send: false, reason: 'subscribed' };
  }
  if (c.ownedPlans.length === 0 || c.ownedPlans.some((plan) => plan !== 'free')) {
    return { send: false, reason: 'not_free' };
  }
  const since = now.getTime() - ACTIVE_DAYS * 86_400_000;
  if (!c.lastActiveAt || Date.parse(c.lastActiveAt) < since) {
    return { send: false, reason: 'inactive' };
  }
  if (c.alreadyClaimed) return { send: false, reason: 'already_sent' };
  return { send: true };
}

export interface ComposedNotice {
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
}

/** The email. Null without an unsubscribe token: no opt-out, no email. */
export function composeProPriceNotice(unsubscribeToken: string | null | undefined): ComposedNotice | null {
  if (!unsubscribeToken) return null;
  const v = proPriceNoticeValues('en');
  const pricingUrl = `${appUrl()}/pricing`;
  const unsub = unsubscribeUrl(unsubscribeToken, PRO_PRICE_NOTICE_CATEGORY);

  const subject = `Pro goes to ${v.next} on ${v.switchDate.replace(/ \d{4}$/, '')}`;
  const paragraphs = [
    'A short note because you signed up for MCPEmails and asked for product news.',
    `On ${v.switchDate} the Pro plan goes from ${v.cur} to ${v.next} a month (${v.nextYear} a year) for new subscriptions. Pro connects up to ${PRO_INBOX_CAP} inboxes to one agent.`,
    `If you subscribe before then, you keep ${v.cur} a month (${v.curYear} a year) for as long as your subscription stays active. Nothing changes on Free or Personal.`,
  ];
  const ctaLabel = 'See the plans';

  const text = [
    'Hi,',
    '',
    ...paragraphs.flatMap((para) => [para, '']),
    `${ctaLabel}: ${pricingUrl}`,
    '',
    'Asgeir',
    'MCPEmails',
    '',
    `${LIFECYCLE_UNSUBSCRIBE_REASON} Unsubscribe: ${unsub}`,
    'Billing and account notices are separate and are not affected.',
    '',
    POSTAL_ADDRESS_LINE,
  ].join('\n');

  const html = lifecycleShell({
    title: subject,
    html:
      lifecycleParagraph('Hi,') +
      paragraphs.map((para) => lifecycleParagraph(para)).join('') +
      lifecycleParagraph('Asgeir'),
    ctaUrl: pricingUrl,
    ctaLabel,
    footerNote: 'Replies come straight to me, not a ticket queue.',
    unsubscribeUrl: unsub,
    unsubscribeReason: LIFECYCLE_UNSUBSCRIBE_REASON,
  });

  return {
    subject,
    text,
    html,
    headers: {
      'List-Unsubscribe': `<${unsub}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

/** Sending is allowed only while the notice itself is on screen. */
export function noticeSendAllowed(now: number = Date.now()): boolean {
  return proPriceNoticeVisible(now);
}
