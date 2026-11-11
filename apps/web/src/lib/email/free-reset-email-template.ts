/**
 * Copy for the monthly "your Free actions reset" email
 * (src/lib/email/free-reset-email.ts decides who gets it).
 *
 * English only, like the usage_warning_80 / usage_limit_reached notices in
 * billing-lifecycle.ts: the server never learns the reader's interface
 * language. The Free allowance is public and is printed from plans.ts; no paid
 * plan's ceiling is ever mentioned.
 *
 * TWO VERSIONS, picked by the arm (lifecycle-region.ts):
 *   promotional (consented, soft_opt_in)  adds the same Personal line and link
 *                                         the usage_limit_reached email uses,
 *                                         and the 3-month pass line when the
 *                                         pass experiment shows it
 *   service_notice                        the facts only: no price, no offer
 *
 * Same shell, footer, opt-out link and List-Unsubscribe headers as every
 * lifecycle email. No token, no email.
 */

import { FREE_ACTION_ALLOWANCE } from '@/lib/stripe/plans';
import { appUrl, unsubscribeUrl } from '@/lib/email/lifecycle';
import { POSTAL_ADDRESS_LINE } from '@/lib/email/legal';
import { personalMonthlyPrice, usageUpgradeUrl } from '@/lib/email/billing-lifecycle';
import { lifecycleParagraph as p, lifecycleShell as shell, passSentence, type PaywallPassLine } from '@/lib/email/paywall-followup-templates';
import { mayPromote, unsubscribeReasonFor, type LifecycleArm } from '@/lib/email/lifecycle-region';

export const FREE_RESET_CATEGORY = 'lifecycle' as const;

export interface FreeResetInput {
  arm: LifecycleArm;
  /** Distinct UTC days in the previous month with a refused action. */
  refusedDays: number;
  /** The first day of the month that just started (UTC). */
  resetOn: Date;
  unsubscribeToken: string | null | undefined;
  /** Promotional arms only; ignored for the service notice. */
  pass?: PaywallPassLine | null;
}

export interface ComposedFreeReset {
  subject: string;
  text: string;
  html: string;
  unsubscribeUrl: string;
  headers: Record<string, string>;
}

function dayMonth(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(date);
}

export function composeFreeReset(input: FreeResetInput): ComposedFreeReset | null {
  const token = typeof input.unsubscribeToken === 'string' ? input.unsubscribeToken.trim() : '';
  if (!token) return null;
  if (!Number.isFinite(input.refusedDays) || input.refusedDays < 1) return null;

  const base = appUrl();
  const unsub = unsubscribeUrl(token, FREE_RESET_CATEGORY);
  const reason = unsubscribeReasonFor(input.arm, 'reset');
  const usageUrl = `${base}/dashboard/usage`;
  const promote = mayPromote(input.arm);

  const subject = 'Your Free email actions have reset';
  const lead = `Your workspace's Free allowance of ${FREE_ACTION_ALLOWANCE} email actions started over on ${dayMonth(input.resetOn)}.`;
  const last = `Last month the workspace reached the limit, and email actions were refused on ${input.refusedDays} ${input.refusedDays === 1 ? 'day' : 'days'}.`;
  const usageLine = 'This month\'s count is on the usage page:';
  const upgradeLine = `Personal removes the monthly limit for ${personalMonthlyPrice()} a month.`;
  const upgradeUrl = usageUpgradeUrl(base);
  const pass = promote && input.pass ? input.pass : null;

  const text = [
    'Hi,',
    '',
    lead,
    '',
    last,
    '',
    usageLine,
    usageUrl,
    '',
    ...(promote ? [upgradeLine, upgradeUrl, ''] : []),
    ...(pass ? [passSentence(pass), pass.url, ''] : []),
    'MCPEmails',
    '',
    `${reason} Unsubscribe: ${unsub}`,
    'Billing and account notices are separate and are not affected.',
    '',
    POSTAL_ADDRESS_LINE,
  ].join('\n');

  const link = (label: string, url: string) =>
    `<p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">${escape(label)} <a href="${escape(url)}" style="color:#0f172a;">${escape(url)}</a></p>`;

  const html = shell({
    title: subject,
    html:
      p('Hi,') +
      p(lead) +
      p(last) +
      (promote ? link(upgradeLine, upgradeUrl) : '') +
      (pass ? link(passSentence(pass), pass.url) : ''),
    ctaUrl: usageUrl,
    ctaLabel: 'See the usage page',
    footerNote: promote ? 'Replies come straight to me, not a ticket queue.' : 'This is a monthly notice about your workspace.',
    unsubscribeUrl: unsub,
    unsubscribeReason: reason,
  });

  return {
    subject,
    text,
    html,
    unsubscribeUrl: unsub,
    headers: {
      'List-Unsubscribe': `<${unsub}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
