/**
 * Copy for the three-step paywall follow-up sequence.
 *
 * LIFECYCLE, NOT TRANSACTIONAL. Every email here is suppressible, carries a
 * one-click List-Unsubscribe header and a visible opt-out link built from the
 * reader's own `users.unsubscribe_token`, and ends with the legal entity and
 * postal line from legal.ts. Composition returns null when there is no token:
 * marketing mail we cannot let someone stop is marketing mail we do not send.
 *
 * EVERY PLAN FACT IS READ FROM plans.ts. Prices, inbox counts, the Free
 * allowance and the "no monthly action cap" line all come from PLANS, and the
 * annual saving is computed by annualOfferFromPlan (never written down). The
 * test file checks the rendered text against the same catalogue, so a
 * repricing cannot leave a stale number in an email.
 *
 * Scheduled send and the approval hold are FREE features. They may appear in
 * an example, and when they do the copy says they are on every plan.
 *
 * DATA MINIMISATION. The body never contains mailbox content, a host name, or
 * any address other than the reader's own (and the reader's address is not
 * printed either; it is only the To header). The examples are generic asks,
 * not anything read from an inbox.
 *
 * STYLE. Plain, short, first person from Asgeir, matching the win-back emails.
 * No em dashes, no fake "Re:", no urgency.
 */

import { PLANS, FREE_ACTION_ALLOWANCE, type Plan } from '@/lib/stripe/plans';
import { annualOfferFromPlan, formatPriceCents } from '@/lib/stripe/annual-offer';
import { pricingCompareHref } from '@/lib/billing/upgrade-intent.mjs';
import { appUrl, unsubscribeUrl } from '@/lib/email/lifecycle';
import { POSTAL_ADDRESS_LINE } from '@/lib/email/legal';

// ---------------------------------------------------------------------------
// HTML shell
//
// A copy of the private `shell()` in billing-lifecycle.ts (same markup, same
// colours), so these emails look like every other email we send. It is copied
// rather than imported because billing-lifecycle.ts does not export it and the
// live billing sender is deliberately left untouched by this feature. If the
// billing shell changes, change this one with it.
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function p(text: string): string {
  return `<p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">${escapeHtml(text)}</p>`;
}

interface ShellOptions {
  title: string;
  /** Blocks of already-escaped HTML. */
  html: string;
  ctaUrl: string;
  ctaLabel: string;
  footerNote: string;
  unsubscribeUrl: string;
  unsubscribeReason: string;
}

function shell(o: ShellOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${escapeHtml(o.title)}</title>
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
                ${escapeHtml(o.title)}
              </p>
              ${o.html}
              <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
                <tr>
                  <td style="background:#0f172a;border-radius:8px;">
                    <a href="${escapeHtml(o.ctaUrl)}" style="display:inline-block;padding:12px 28px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">
                      ${escapeHtml(o.ctaLabel)}
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #e2e8f0;">
              <p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">${escapeHtml(o.footerNote)}</p>
              <p style="margin:12px 0 0;font-size:12px;color:#94a3b8;line-height:1.6;">
                ${escapeHtml(o.unsubscribeReason)}
                <a href="${escapeHtml(o.unsubscribeUrl)}" style="color:#94a3b8;text-decoration:underline;">Unsubscribe from these</a>.
                Billing and account notices are not affected.
              </p>
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

export const PAYWALL_FOLLOWUP_STEPS = [1, 2, 3] as const;
export type PaywallFollowupStep = (typeof PAYWALL_FOLLOWUP_STEPS)[number];

/** Which wall the reader hit first. Decides only the opening sentence. */
export type PaywallKind = 'inbox_cap' | 'action_cap' | 'unknown';

export interface PaywallFollowupInput {
  step: PaywallFollowupStep;
  paywallKind: PaywallKind;
  /** The recipient's own users.unsubscribe_token. Required; null = no email. */
  unsubscribeToken: string | null | undefined;
}

export interface ComposedPaywallFollowup {
  subject: string;
  text: string;
  html: string;
  unsubscribeUrl: string;
  /** The exact header values the sender attaches. */
  headers: Record<string, string>;
}

/** Suppression category. Must be one of LIFECYCLE_CATEGORIES. */
export const PAYWALL_FOLLOWUP_CATEGORY = 'lifecycle' as const;

/** Mirrors the signup checkbox (messages/en/auth.json, marketingConsent). */
const UNSUBSCRIBE_REASON =
  'You are getting this because you asked for product tips and offers when you signed up.';

const SIGN_OFF = ['Asgeir', 'MCPEmails'];

// ---------------------------------------------------------------------------
// Plan facts, from the catalogue
// ---------------------------------------------------------------------------

function monthly(plan: Plan): string {
  return formatPriceCents(plan.monthlyPriceCents);
}

/** "1 connected inbox", "3 connected inboxes", "Unlimited connected inboxes". */
export function inboxLine(plan: Plan): string {
  const n = plan.limits.maxInboxes;
  if (!Number.isFinite(n)) return 'Unlimited connected inboxes';
  return `${n} connected ${n === 1 ? 'inbox' : 'inboxes'}`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** Lower-case form for use mid-sentence. */
function inboxPhrase(plan: Plan): string {
  return lowerFirst(inboxLine(plan));
}

/** "3 inboxes", "1 inbox", "as many inboxes as you run". */
function coverage(plan: Plan): string {
  const n = plan.limits.maxInboxes;
  if (!Number.isFinite(n)) return 'as many inboxes as you run';
  return `${n} ${n === 1 ? 'inbox' : 'inboxes'}`;
}

/**
 * Read a feature line from the catalogue rather than retyping it, and fail
 * loudly if it is gone: a sentence about a feature the plan no longer lists
 * is exactly the stale claim this module exists to prevent.
 */
export function catalogueFeature(plan: Plan, needle: string): string {
  const hit = plan.features.find((f) => f.toLowerCase().includes(needle.toLowerCase()));
  if (!hit) throw new Error(`plans.ts no longer lists "${needle}" for ${plan.name}`);
  return hit;
}

/**
 * The annual sentence, or null when annual cannot be sold (no configured
 * yearly Stripe price) or saves nothing. Monthly is always the default; this
 * is a secondary mention only.
 */
export function annualSentence(): string | null {
  const personal = annualOfferFromPlan(PLANS.personal);
  const pro = annualOfferFromPlan(PLANS.solo);
  const parts: string[] = [];
  if (personal) parts.push(`${PLANS.personal.name} is ${formatPriceCents(personal.yearlyPriceCents)} a year`);
  if (pro) parts.push(`${PLANS.solo.name} is ${formatPriceCents(pro.yearlyPriceCents)} a year`);
  if (parts.length === 0) return null;

  const savings = [personal?.savingPercent, pro?.savingPercent].filter(
    (v): v is number => typeof v === 'number',
  );
  const same = savings.length > 0 && savings.every((v) => v === savings[0]);
  const saving = same ? `, which saves ${savings[0]}% against paying monthly` : '';
  return `If you would rather pay once a year: ${parts.join(' and ')}${saving}.`;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

function openingLine(kind: PaywallKind, step: PaywallFollowupStep): string {
  if (step === 1) {
    // Not "you tried to add an inbox": the inbox-cap row is written when the
    // upgrade panel is shown, which is not proof of an attempt.
    if (kind === 'inbox_cap') return `You recently reached the Free plan's limit of ${inboxPhrase(PLANS.free)}.`;
    if (kind === 'action_cap') {
      return `Your workspace recently used the Free plan's ${FREE_ACTION_ALLOWANCE} email actions for this month.`;
    }
    return 'You recently reached a limit on the Free plan.';
  }
  if (kind === 'inbox_cap') return `A few days ago you reached the Free plan's limit of ${inboxPhrase(PLANS.free)}.`;
  if (kind === 'action_cap') return `A few days ago your workspace used the Free plan's ${FREE_ACTION_ALLOWANCE} monthly email actions.`;
  return 'A few days ago you reached a limit on the Free plan.';
}

/**
 * Build one email of the sequence. Returns null when it must not be sent:
 * no unsubscribe token means no working opt-out, so no email.
 */
export function composePaywallFollowup(input: PaywallFollowupInput): ComposedPaywallFollowup | null {
  const token = typeof input.unsubscribeToken === 'string' ? input.unsubscribeToken.trim() : '';
  if (!token) return null;

  const base = appUrl();
  const unsub = unsubscribeUrl(token, PAYWALL_FOLLOWUP_CATEGORY);
  const compareUrl = `${base}${pricingCompareHref('personal', false)}`;
  const free = PLANS.free;
  const personal = PLANS.personal;
  const pro = PLANS.solo;
  const noCap = catalogueFeature(personal, 'no monthly action cap');

  let subject: string;
  let title: string;
  let paragraphs: string[];
  let ctaLabel: string;

  switch (input.step) {
    case 1: {
      subject = 'What a second inbox does in MCPEmails';
      title = 'What a second inbox does';
      paragraphs = [
        openingLine(input.paywallKind, 1),
        'Here is what changes with more than one. Your agent reaches every inbox you connect through the same connection, so in one conversation you can ask it to check your work and personal inboxes for anything that still needs a reply, draft answers in each, and tidy both.',
        `${personal.name} is ${monthly(personal)} a month for ${inboxPhrase(personal)}. ${pro.name} is ${monthly(pro)} a month for ${inboxPhrase(pro)}. Both have ${lowerFirst(noCap)}.`,
        'If something else got in the way, reply and tell me. I read every reply.',
      ];
      ctaLabel = 'Compare plans';
      break;
    }
    case 2: {
      subject = 'One way to use two inboxes with your agent';
      title = 'A two-inbox workflow';
      paragraphs = [
        openingLine(input.paywallKind, 2),
        'Here is one concrete way people use two inboxes. Say one is your business address and the other is your own. In a single conversation you can ask your agent to:',
        '1. Summarise what came into the business inbox since Friday and flag anything that needs you.',
        '2. Draft replies to the quote requests, sent from the business address.',
        '3. Schedule them for Monday at 8:00. Scheduled send is on every plan, Free included.',
        '4. Forward the invoices to your own inbox so they are in one place.',
        `${free.name} covers ${coverage(free)}. ${personal.name} (${monthly(personal)} a month) covers ${coverage(personal)}, and ${pro.name} (${monthly(pro)} a month) covers ${coverage(pro)}.`,
      ];
      ctaLabel = 'See the plans';
      break;
    }
    case 3: {
      subject = 'MCPEmails plans, side by side';
      title = 'The plans, side by side';
      const annual = annualSentence();
      paragraphs = [
        'This is the last email in this short series. Here is how the plans compare:',
        `${free.name}, ${monthly(free)}: ${inboxPhrase(free)}, ${FREE_ACTION_ALLOWANCE} email actions a month.`,
        `${personal.name}, ${monthly(personal)} a month: ${inboxPhrase(personal)}, ${lowerFirst(noCap)}, ${lowerFirst(catalogueFeature(personal, 'email support'))}.`,
        `${pro.name}, ${monthly(pro)} a month: ${inboxPhrase(pro)}, ${lowerFirst(catalogueFeature(pro, `everything in ${personal.name}`))}.`,
        ...(annual ? [annual] : []),
        'Scheduled send and the approval hold are on every plan, Free included. Your Free account stays as it is whatever you decide.',
      ];
      ctaLabel = 'Compare plans';
      break;
    }
    default:
      return null;
  }

  const text = [
    'Hi,',
    '',
    ...paragraphs.flatMap((para, i) => {
      // Numbered steps sit together without blank lines between them.
      const next = paragraphs[i + 1];
      const tight = /^\d\. /.test(para) && next !== undefined && /^\d\. /.test(next);
      return tight ? [para] : [para, ''];
    }),
    `${ctaLabel}: ${compareUrl}`,
    '',
    ...SIGN_OFF,
    '',
    `${UNSUBSCRIBE_REASON} Unsubscribe: ${unsub}`,
    'Billing and account notices are separate and are not affected.',
    '',
    POSTAL_ADDRESS_LINE,
  ].join('\n');

  const html = shell({
    title,
    html: p('Hi,') + paragraphs.map((para) => p(para)).join('') + p(SIGN_OFF[0]),
    ctaUrl: compareUrl,
    ctaLabel,
    footerNote: 'Replies come straight to me, not a ticket queue.',
    unsubscribeUrl: unsub,
    unsubscribeReason: UNSUBSCRIBE_REASON,
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
