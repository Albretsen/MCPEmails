/**
 * Copy for the first-30-days retention loop (Documents/plans/first-30-days,
 * sections M2 and M3). Pure: no network, no database, no clock.
 *
 * M2, THE STUCK NOTE, IS NOT AN EMAIL WE SEND. It is a plain-text draft that
 * lands in Asgeir's own mailbox (or, as a fallback, an internal notice to that
 * mailbox), addressed to the owner, for him to read, edit and send himself.
 * It therefore carries no opt-out link and no List-Unsubscribe header: it is a
 * 1:1 customer-service note about a paid service that is not working.
 *
 * M3, THE WEEK-1 SUMMARY, IS A SERVICE MESSAGE. An account activity report on
 * the paid service: no promotion, no price, no plan comparison, no upsell. It
 * is still suppressible through its own category (`activity_summary`), carries
 * List-Unsubscribe One-Click, a visible "Stop these activity summaries" link
 * and the postal line from legal.ts. Composition returns null without an
 * unsubscribe token: a summary somebody cannot stop is a summary we do not
 * send.
 *
 * RULES FOR EVERY STRING HERE. Never estimate time saved. Never mention the
 * action cap, a price, a plan name or slug, or a refund window other than 14
 * days. No em dashes. The product is "MCPEmails". English only, for the same
 * reason as purchase-confirmation.ts: the server does not know the reader's
 * language.
 */

import { appUrl, unsubscribeUrl } from '@/lib/email/lifecycle';
import { POSTAL_ADDRESS_LINE } from '@/lib/email/legal';

/** Suppression category for M3. Must be one of LIFECYCLE_CATEGORIES. */
export const ACTIVITY_SUMMARY_CATEGORY = 'activity_summary' as const;

export const STUCK_NOTE_SUBJECT = 'Your MCPEmails setup';
export const WEEK1_SUBJECT = 'Your first week with MCPEmails';

/** Calls in week 1 at or above which no tip line is shown (no nagging heavy users). */
export const TIP_SUPPRESS_AT_CALLS = 100;
/** Fewer active days than this in week 1 earns the daily-question tip. */
export const TIP_ACTIVE_DAYS_BELOW = 3;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The first word of a display name, when it plausibly is a first name. An
 * address, a handle with digits, or anything long is dropped and the greeting
 * becomes a plain "Hi,".
 */
export function firstNameFrom(displayName: string | null | undefined): string | null {
  if (!displayName) return null;
  const first = displayName.trim().split(/\s+/)[0] ?? '';
  if (first.length < 2 || first.length > 30) return null;
  if (!/^[\p{L}][\p{L}'-]*$/u.test(first)) return null;
  return first;
}

function greeting(firstName: string | null): string {
  return firstName ? `Hi ${firstName},` : 'Hi,';
}

/** "24 October 2026", in UTC, so the date never depends on the server's zone. */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function times(n: number): string {
  if (n === 1) return 'once';
  if (n === 2) return 'twice';
  return `${n} times`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------------------
// M2: error codes in plain language
// ---------------------------------------------------------------------------

export interface ErrorExplanation {
  /** Lower-case clause that completes "The last attempts failed with: ...". */
  plain: string;
  /** One fix line, or null when there is nothing useful to say. */
  fix: ((base: string) => string) | null;
}

const RECONNECT = (base: string) =>
  `Reconnecting the inbox from the dashboard usually clears this: ${base}/dashboard/inboxes`;

/**
 * activity_log.error_code values seen in production, mapped to what a person
 * would understand. Unknown codes fall through to explainErrorCode's default,
 * which names the code so Asgeir can look it up before sending.
 */
const ERROR_EXPLANATIONS: Record<string, ErrorExplanation> = {
  auth_failed: {
    plain: 'the mail server rejected the password',
    fix: (base) =>
      `Many providers, including Yahoo, iCloud and Gmail, need an app password instead of your normal password. This explains how to make one: ${base}/blog/what-is-an-app-password`,
  },
  imap_auth_failed: {
    plain: 'the mail server rejected the password',
    fix: (base) =>
      `Many providers, including Yahoo, iCloud and Gmail, need an app password instead of your normal password. This explains how to make one: ${base}/blog/what-is-an-app-password`,
  },
  connection_limit: {
    plain: 'the mail server refused more connections',
    fix: () =>
      'Your mail server limits how many apps can be connected at the same time. Closing other mail apps for a while usually clears it.',
  },
  provider_error: { plain: 'your mail provider returned an error', fix: RECONNECT },
  token_expired: { plain: 'the sign-in to your mail account expired', fix: RECONNECT },
  oauth_token_expired: { plain: 'the sign-in to your mail account expired', fix: RECONNECT },
  inbox_inactive: { plain: 'the inbox is switched off or needs attention', fix: RECONNECT },
  inbox_not_found: {
    plain: 'no connected inbox matched what your assistant asked for',
    fix: (base) => `You can check which inboxes are connected here: ${base}/dashboard/inboxes`,
  },
  scope_denied: {
    plain: 'the key your assistant uses is not allowed to do that',
    fix: (base) => `You can create a key with full access under API keys: ${base}/dashboard/keys`,
  },
  quota_exceeded: { plain: "your mail provider's sending limit was reached", fix: null },
  search_timeout: { plain: 'searches took too long to finish', fix: null },
  '-32602': { plain: 'your assistant sent a request MCPEmails could not read', fix: null },
};

export function explainErrorCode(code: string): ErrorExplanation {
  const known = ERROR_EXPLANATIONS[code] ?? ERROR_EXPLANATIONS[code.toLowerCase()];
  if (known) return known;
  return { plain: `an error (code ${code})`, fix: null };
}

// ---------------------------------------------------------------------------
// M2: the stuck note
// ---------------------------------------------------------------------------

export interface StuckNoteInput {
  firstName: string | null;
  /** ISO time of the first checkout_completed. */
  paidAt: string;
  /** Every activity_log row since payment, any status. */
  totalCalls: number;
  /** Top error codes since payment, most frequent first. */
  topErrorCodes: Array<{ code: string; count: number }>;
  /** mcp_client_capabilities.client_name values for the workspace. */
  clientNames: string[];
  /** Connected (not deleted) inboxes: provider names only. */
  inboxProviders: string[];
}

export interface ComposedStuckNote {
  subject: string;
  /** Plain text body, ready to send as written. */
  text: string;
}

/** A client name fit for a sentence, or null. */
function readableClient(names: string[]): string | null {
  const name = names.find((n) => /^[\p{L}\p{N} ._-]{2,40}$/u.test(n.trim()));
  return name ? name.trim() : null;
}

export function composeStuckNote(input: StuckNoteInput): ComposedStuckNote {
  const base = appUrl();
  const date = formatDate(input.paidAt);
  const lines: string[] = [];

  let situation: string;
  if (input.totalCalls === 0) {
    const client = readableClient(input.clientNames) ?? 'your AI app';
    situation = `It looks like the connector hasn't been added to ${client} yet.`;
  } else if (input.topErrorCodes.length > 0) {
    const plains = [...new Set(input.topErrorCodes.slice(0, 3).map((e) => explainErrorCode(e.code).plain))];
    situation = `The last attempts failed with: ${plains.join('; ')}.`;
  } else {
    situation = 'The attempts so far have not succeeded.';
  }

  lines.push(
    greeting(input.firstName),
    '',
    `I'm Asgeir, I build MCPEmails. I noticed your assistant hasn't been able to use your inbox since you subscribed on ${date}. ${situation}`,
    '',
  );

  const fixes: string[] = [];
  if (input.inboxProviders.length === 0) {
    fixes.push(`There is no inbox connected yet. You can connect one here: ${base}/dashboard/inboxes`);
  }
  if (input.totalCalls === 0) {
    fixes.push(`The setup steps for each AI app are here: ${base}/docs/clients`);
  }
  for (const { code } of input.topErrorCodes.slice(0, 3)) {
    const fix = explainErrorCode(code).fix?.(base);
    if (fix && !fixes.includes(fix)) fixes.push(fix);
  }
  for (const fix of fixes) lines.push(fix, '');

  lines.push(
    "If you'd rather reply with what you're seeing, I read every reply myself. And if it's not for you, you can get a full refund within 14 days of your first payment from the billing page.",
    '',
    'Asgeir',
  );

  return { subject: STUCK_NOTE_SUBJECT, text: lines.join('\n') };
}

/**
 * mailto: link that opens the note, addressed to the owner, in any mail app.
 * Used by the internal fallback notice. The address is validated by the
 * caller; encodeURIComponent keeps the subject and body from adding headers.
 */
export function mailtoFor(to: string, note: ComposedStuckNote): string {
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(note.subject)}&body=${encodeURIComponent(note.text)}`;
}

// ---------------------------------------------------------------------------
// M3: the week-1 summary
// ---------------------------------------------------------------------------

export interface Week1Counts {
  search: number;
  opened: number;
  drafts: number;
  sent: number;
  scheduled: number;
}

export interface Week1Input {
  firstName: string | null;
  /** Start of the window (the first payment), ISO. */
  from: string;
  /** Last moment inside the window, ISO. */
  to: string;
  counts: Week1Counts;
  /** sum(triage_runs.succeeded) inside the window. */
  automationsSorted: number;
  /** Connected, not deleted, inbox addresses. */
  inboxAddresses: string[];
  /** Every successful call in the window. */
  totalCalls: number;
  /** Distinct days with a successful call in the window, 0 to 7. */
  activeDays: number;
  /** At least one triage_rules row that is not deleted. */
  hasAutomation: boolean;
  /** The recipient's users.unsubscribe_token. Required; null = no email. */
  unsubscribeToken: string | null | undefined;
}

export interface ComposedWeek1 {
  subject: string;
  text: string;
  html: string;
  unsubscribeUrl: string;
  headers: Record<string, string>;
  /** Which tip was shown, for tests and the dry-run report. */
  tip: 'automation' | 'daily' | null;
}

/** The activity lines with a count above zero, in the plan's order. */
export function week1Lines(input: Pick<Week1Input, 'counts' | 'automationsSorted' | 'inboxAddresses'>): string[] {
  const { counts } = input;
  const lines: string[] = [];

  const searchPart = counts.search > 0 ? `searched your mail ${times(counts.search)}` : null;
  const openPart = counts.opened > 0 ? `opened ${plural(counts.opened, 'email', 'emails')}` : null;
  const first = [searchPart, openPart].filter(Boolean).join(' and ');
  if (first) lines.push(capitalise(first));

  const draftPart = counts.drafts > 0 ? `wrote ${plural(counts.drafts, 'draft', 'drafts')}` : null;
  const sentPart = counts.sent > 0 ? `sent ${plural(counts.sent, 'email', 'emails')}` : null;
  const second = [draftPart, sentPart].filter(Boolean).join(' and ');
  if (second) lines.push(capitalise(second));

  if (counts.scheduled > 0) lines.push(`Scheduled ${plural(counts.scheduled, 'email', 'emails')}`);
  if (input.automationsSorted > 0) {
    lines.push(`Your automations sorted ${plural(input.automationsSorted, 'message', 'messages')} on their own`);
  }
  if (input.inboxAddresses.length > 0) lines.push(`Connected inboxes: ${input.inboxAddresses.join(', ')}`);
  return lines;
}

/** Which tip, if any: the plan's rule, in its order. */
export function week1Tip(input: Pick<Week1Input, 'totalCalls' | 'activeDays' | 'hasAutomation'>): 'automation' | 'daily' | null {
  if (input.totalCalls >= TIP_SUPPRESS_AT_CALLS) return null;
  if (!input.hasAutomation) return 'automation';
  if (input.activeDays < TIP_ACTIVE_DAYS_BELOW) return 'daily';
  return null;
}

function tipText(tip: 'automation' | 'daily', inboxAddresses: string[]): string {
  if (tip === 'automation') {
    const inbox = inboxAddresses[0] ?? 'your inbox';
    return `Automations can do the sorting without you asking each time. Ask your assistant: "Every hour, move newsletters from ${inbox} to a folder called Later."`;
  }
  return 'People who get the most out of it ask a quick question most days. One to try tomorrow: "What needs a reply today?"';
}

export function composeWeek1Summary(input: Week1Input): ComposedWeek1 | null {
  const token = typeof input.unsubscribeToken === 'string' ? input.unsubscribeToken.trim() : '';
  if (!token) return null;

  const lines = week1Lines(input);
  if (lines.length === 0) return null;

  const base = appUrl();
  const unsub = unsubscribeUrl(token, ACTIVITY_SUMMARY_CATEGORY);
  const dashboardUrl = `${base}/dashboard/usage`;
  const tip = week1Tip(input);
  const intro = `Here's what your assistant did through MCPEmails from ${formatDate(input.from)} to ${formatDate(input.to)}:`;
  const closing = `You can see all of your activity in the dashboard: ${dashboardUrl}. You can manage or cancel your subscription from the billing page at any time.`;
  const tipLine = tip ? tipText(tip, input.inboxAddresses) : null;

  const text = [
    greeting(input.firstName),
    '',
    intro,
    '',
    ...lines.map((l) => `- ${l}`),
    '',
    ...(tipLine ? [tipLine, ''] : []),
    closing,
    '',
    'Asgeir',
    '',
    `Stop these activity summaries: ${unsub}`,
    POSTAL_ADDRESS_LINE,
  ].join('\n');

  const para = (t: string) => `<p style="margin:0 0 16px;font-size:15px;color:#1f2937;line-height:1.6;">${escapeHtml(t)}</p>`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${escapeHtml(WEEK1_SUBJECT)}</title>
</head>
<body style="margin:0;padding:24px;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:560px;">
    ${para(greeting(input.firstName))}
    ${para(intro)}
    <ul style="margin:0 0 16px;padding-left:20px;font-size:15px;color:#1f2937;line-height:1.6;">
      ${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('\n      ')}
    </ul>
    ${tipLine ? para(tipLine) : ''}
    <p style="margin:0 0 16px;font-size:15px;color:#1f2937;line-height:1.6;">You can see all of your activity in the <a href="${escapeHtml(dashboardUrl)}" style="color:#1f2937;">dashboard</a>. You can manage or cancel your subscription from the billing page at any time.</p>
    ${para('Asgeir')}
    <p style="margin:24px 0 0;font-size:12px;color:#6b7280;line-height:1.6;"><a href="${escapeHtml(unsub)}" style="color:#6b7280;text-decoration:underline;">Stop these activity summaries</a>. Billing and account notices are not affected.</p>
    <p style="margin:8px 0 0;font-size:11px;color:#9ca3af;line-height:1.6;">${escapeHtml(POSTAL_ADDRESS_LINE)}</p>
  </div>
</body>
</html>`;

  return {
    subject: WEEK1_SUBJECT,
    text,
    html,
    unsubscribeUrl: unsub,
    headers: {
      'List-Unsubscribe': `<${unsub}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    tip,
  };
}
