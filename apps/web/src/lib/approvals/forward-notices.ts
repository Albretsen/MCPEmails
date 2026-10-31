/**
 * The emails about rule forwards: one when a rule queues them, one before they
 * expire, one when an approved or unattended forward fails, and a receipt for what
 * a no-approval rule sent. Sent to the workspace's owners and admins, the only
 * people who can approve.
 *
 * TWO OPT-OUTS. Receipts have their own category. Everything else shares one, so
 * stopping receipts can never stop the emails saying a forward waits or failed.
 *
 * WHAT DECIDES A NOTICE EXISTS. supabase/migrations/20261031220000_forward_approval_notices.sql:
 * pg_cron stamps the approvals and writes one notice per rule, then posts to
 * app/api/internal/forward-notices/dispatch, which calls dispatchForwardNotices.
 * The rule run knows nothing about any of this, so nothing here can stop a run.
 *
 * WHAT THE EMAIL SAYS. Rule name, count, address, deadline, and a link to the
 * queue filtered to that rule. Never the subject, sender or text of the mail.
 * All of it is read from the live rows at send time, so the count is true when
 * the email leaves, and a notice whose forwards were all decided is cancelled.
 *
 * WHY NOT system-notify. It mails one fixed operator address through an inbox
 * connection. These go to customers, through the same Resend setup and sender as
 * the other account notices. A refused send still reaches the operator through
 * createResend's failure alert, which does go through system-notify. Every
 * finished notice writes a system_events row directly, already processed, so it
 * does not also mail the operator.
 *
 * LOCALE. English only, like the other server-sent account notices: no interface
 * language reaches the server. See src/lib/email/billing-lifecycle.ts.
 *
 * Never throws: a failure is recorded on the notice and retried by the next tick,
 * up to the 5 attempts the claim allows.
 */

import { shell, p } from '@/lib/email/billing-lifecycle';
import { appUrl, unsubscribeUrl } from '@/lib/email/lifecycle';
import { SKIPPED_ID_PREFIX } from '@/lib/email/resend';
import type { DeliveryReason } from '@/lib/approvals/delivery';

export const NOTICE_BATCH = 25;
export const NOTICE_MAX_ATTEMPTS = 5;
const MAX_ADDRESSES_SHOWN = 5;
export const APPROVAL_NOTICES_CATEGORY = 'approval_notices' as const;
export const APPROVAL_RECEIPTS_CATEGORY = 'approval_receipts' as const;
/**
 * A reminder covers every forward within this long of its deadline, the same 48
 * hours the database stamps (enqueue_forward_approval_notices), so each forward is
 * counted as expiring soon in the one reminder it ever gets.
 */
export const EXPIRES_SOON_MS = 48 * 60 * 60 * 1000;
/**
 * The same header a rule's own forward carries (RULE_FORWARD_HEADER in
 * mcp-server/triage-engine.ts). The body names the rule, so a forward rule with a
 * body filter could match this email; the engine refuses anything with this
 * header, so a notice can never queue a forward of itself.
 */
export const NOTICE_LOOP_GUARD_HEADER = 'X-MCPEmails-Rule-Forward';

export type NoticeKind = 'queued' | 'reminder' | 'receipt' | 'coverage_paused' | 'failed';

export interface NoticeFacts {
  kind: 'queued' | 'reminder';
  ruleId: string;
  ruleName: string;
  count: number;
  addresses: string[];
  deadline: string;
  /** Reminder only: how many are near their deadline. All of them when not given. */
  expiringSoon?: number;
  /** True when the forwards do not all go to the same addresses. */
  addressesVary?: boolean;
}

export interface ComposedNotice {
  subject: string;
  text: string;
  html: string;
  unsubscribe: string;
}

/** Rule names can come from an AI assistant. One line, bounded, in any header. */
export function cleanRuleName(name: string): string {
  const flat = name.replace(/[\r\n\t]+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

/** Stated in UTC and labelled: no reader's time zone reaches the server. */
export function formatDeadline(iso: string): string {
  const date = new Date(iso);
  return `${new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(date)} UTC`;
}

export function approvalsLinkForRule(ruleId: string): string {
  return `${appUrl()}/dashboard/approvals?rule=${encodeURIComponent(ruleId)}`;
}

function addressPhrase(addresses: string[]): string {
  const shown = addresses.slice(0, MAX_ADDRESSES_SHOWN);
  const more = addresses.length - MAX_ADDRESSES_SHOWN;
  if (more > 0) return `${shown.join(', ')} and ${more} more`;
  if (shown.length < 2) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/** Where they go, true for one address, several, or forwards that differ. */
function whereTheyGo(one: boolean, addresses: string[], vary: boolean): string {
  if (vary && !one) return `They go to different addresses: ${addressPhrase(addresses)}.`;
  return `${one ? 'It goes' : 'They go'} to ${addressPhrase(addresses)}.`;
}

/** What stopping these costs: a forward can then wait, fail or expire unseen. */
const NOTICES_STOP_NOTE = 'If you stop these emails, you will not hear when forwards wait, expire or fail. Check Approvals yourself.';

export function composeForwardNotice(facts: NoticeFacts, unsubscribeToken: string): ComposedNotice {
  const rule = cleanRuleName(facts.ruleName);
  const link = approvalsLinkForRule(facts.ruleId);
  const unsubscribe = unsubscribeUrl(unsubscribeToken, APPROVAL_NOTICES_CATEGORY);
  const one = facts.count === 1;
  const forwards = one ? '1 forward' : `${facts.count} forwards`;
  const deadline = formatDeadline(facts.deadline);
  const soon = Math.min(facts.expiringSoon ?? facts.count, facts.count);
  const later = facts.count - soon;
  const soonForwards = soon === 1 ? '1 forward' : `${soon} forwards`;

  // No rule name here. The email lands in the owner's own mailbox, and a rule
  // called "Invoices" that files mail with "invoice" in the subject would pick up
  // its own notice.
  const subject = facts.kind === 'queued'
    ? `${forwards} ${one ? 'needs' : 'need'} your approval`
    : later > 0
      ? `${soonForwards} ${soon === 1 ? 'expires' : 'expire'} soon, ${later} more waiting`
      : `${forwards} ${one ? 'expires' : 'expire'} soon`;

  const lead = facts.kind === 'queued'
    ? `Your automation "${rule}" has ${forwards} waiting for approval.`
    : later > 0
      ? `Your automation "${rule}" has ${soonForwards} that ${soon === 1 ? 'expires' : 'expire'} soon, and ${later} more waiting for approval.`
      : `Your automation "${rule}" still has ${forwards} waiting for approval.`;
  const where = `${whereTheyGo(one, facts.addresses, facts.addressesVary === true)} Only once an owner or admin approves. Nothing has been sent.`;
  const when = one
    ? `Decide by ${deadline}. After that it expires and is not sent.`
    : `The first expires on ${deadline}. A forward nobody approves by its deadline is not sent.`;
  const footer = 'You get this because you are an owner or admin of this workspace. Replies reach support.';
  const stop = NOTICES_STOP_NOTE;

  return {
    subject,
    text: [
      lead,
      '',
      where,
      when,
      '',
      'Review them here:',
      link,
      '',
      footer,
      stop,
      `Stop these emails: ${unsubscribe}`,
      '',
      'MCPEmails',
    ].join('\n'),
    html: shell({
      title: subject,
      html: p(lead) + p(where) + p(when),
      ctaUrl: link.replace(/&/g, '&amp;'),
      ctaLabel: one ? 'Review the forward' : 'Review the forwards',
      footerNote: `${footer} ${stop} <a href="${unsubscribe.replace(/&/g, '&amp;')}" style="color:#64748b;text-decoration:underline;">Stop these emails</a>.`,
    }),
    unsubscribe,
  };
}

export function runLogLink(ruleId: string): string {
  return `${appUrl()}/dashboard/automations?runs=${encodeURIComponent(ruleId)}`;
}

export interface ReceiptFacts {
  ruleId: string;
  ruleName: string;
  noApprovalRuleName: string | null;
  count: number;
  addresses: string[];
}

/**
 * What a no-approval rule sent. No rule name in the subject, for the reason above.
 * The opt-out line says what remains when these stop: the run log.
 */
export function composeReceipt(facts: ReceiptFacts, unsubscribeToken: string): ComposedNotice {
  const rule = cleanRuleName(facts.ruleName);
  const link = runLogLink(facts.ruleId);
  const unsubscribe = unsubscribeUrl(unsubscribeToken, APPROVAL_RECEIPTS_CATEGORY);
  const one = facts.count === 1;
  const forwards = one ? '1 forward' : `${facts.count} forwards`;
  const subject = `${forwards} sent without approval`;
  const lead = `Your automation "${rule}" sent ${forwards} to ${addressPhrase(facts.addresses)}.`;
  const why = facts.noApprovalRuleName
    ? `The no-approval rule "${cleanRuleName(facts.noApprovalRuleName)}" allowed ${one ? 'it' : 'them'}, so nobody reviewed ${one ? 'it' : 'them'} first.`
    : `A no-approval rule allowed ${one ? 'it' : 'them'}, so nobody reviewed ${one ? 'it' : 'them'} first.`;
  const footer = 'You get this because you are an owner or admin of this workspace. Replies reach support.';
  const stop = 'If you stop these receipts, the run log on the Automations page is the record of what was sent. You still hear when forwards wait or fail.';
  return {
    subject,
    text: [lead, '', why, '', 'See the run log here:', link, '', footer, stop, `Stop these receipts: ${unsubscribe}`, '', 'MCPEmails'].join('\n'),
    html: shell({
      title: subject,
      html: p(lead) + p(why),
      ctaUrl: link.replace(/&/g, '&amp;'),
      ctaLabel: 'See the run log',
      footerNote: `${footer} ${stop} <a href="${unsubscribe.replace(/&/g, '&amp;')}" style="color:#64748b;text-decoration:underline;">Stop these receipts</a>.`,
    }),
    unsubscribe,
  };
}

export interface FailedFacts {
  ruleId: string;
  ruleName: string;
  count: number;
  addresses: string[];
  /** Can be forwarded again: the record proves nothing went out, and the rule exists. */
  canRetry: number;
  /** May have gone out. Never offered again. */
  mayHaveSent: number;
  /** The one reason, when all of them failed for the same one. */
  reason: DeliveryReason | null;
}

/** Why, in the one language these emails have. Only what the record can show. */
const FAILED_REASON_TEXT: Partial<Record<DeliveryReason, string>> = {
  original_not_found: 'The original message is no longer in the mailbox.',
  original_ambiguous: 'More than one message in the mailbox has the same Message-ID.',
  original_too_large: 'The original message is too large to forward.',
  original_unavailable: 'The mail provider could not return the whole original message.',
  refused: 'It was refused before it left. The address or the mail server may be the cause.',
  recipient_refused: 'The address was refused.',
  provider_quota: 'The mail provider says the sending quota is used up.',
  mailbox: 'The mailbox could not be used. It may need reconnecting under Inboxes.',
  key: 'The API key behind this automation can no longer send from this mailbox.',
  allowance: 'This workspace has used its included usage for this period.',
};

/**
 * An approved or unattended forward ended in error. No rule name in the subject,
 * for the reason above. It says what the person can do, and only what the record
 * allows: a send that may have gone out is never offered again.
 */
export function composeFailedNotice(facts: FailedFacts, unsubscribeToken: string): ComposedNotice {
  const rule = cleanRuleName(facts.ruleName);
  const link = approvalsLinkForRule(facts.ruleId);
  const unsubscribe = unsubscribeUrl(unsubscribeToken, APPROVAL_NOTICES_CATEGORY);
  const one = facts.count === 1;
  const forwards = one ? '1 forward' : `${facts.count} forwards`;
  const subject = `${forwards} could not be sent`;
  const lead = `Your automation "${rule}" could not send ${forwards} to ${addressPhrase(facts.addresses)}.`;
  const why = facts.reason ? FAILED_REASON_TEXT[facts.reason] ?? null : null;
  const next: string[] = [];
  if (facts.canRetry > 0) {
    next.push(facts.canRetry === facts.count
      ? `Nothing was sent. Fix the cause, then open Approvals and choose Forward again. ${one ? 'It waits' : 'Each waits'} for approval once more.`
      : `For ${facts.canRetry} of them nothing was sent: fix the cause, then open Approvals and choose Forward again. Each waits for approval once more.`);
  }
  if (facts.mayHaveSent > 0) {
    next.push(facts.mayHaveSent === facts.count
      ? `${one ? 'It' : 'They'} may have gone out, so MCPEmails will not send ${one ? 'it' : 'them'} again. Check the Sent folder.`
      : `${facts.mayHaveSent} may have gone out, so MCPEmails will not send those again. Check the Sent folder.`);
  }
  if (next.length === 0) next.push('See Approvals for what happened.');
  const footer = 'You get this because you are an owner or admin of this workspace. Replies reach support.';
  const stop = NOTICES_STOP_NOTE;
  return {
    subject,
    text: [lead, ...(why ? ['', why] : []), '', ...next, '', 'See them here:', link, '', footer, stop, `Stop these emails: ${unsubscribe}`, '', 'MCPEmails'].join('\n'),
    html: shell({
      title: subject,
      html: p(lead) + (why ? p(why) : '') + next.map((line) => p(line)).join(''),
      ctaUrl: link.replace(/&/g, '&amp;'),
      ctaLabel: 'Open Approvals',
      footerNote: `${footer} ${stop} <a href="${unsubscribe.replace(/&/g, '&amp;')}" style="color:#64748b;text-decoration:underline;">Stop these emails</a>.`,
    }),
    unsubscribe,
  };
}

/** Repeated send failures stopped a no-approval rule. */
export function composeCoveragePaused(ruleName: string, unsubscribeToken: string): ComposedNotice {
  const rule = cleanRuleName(ruleName);
  const link = `${appUrl()}/dashboard/automations`;
  const unsubscribe = unsubscribeUrl(unsubscribeToken, APPROVAL_NOTICES_CATEGORY);
  const subject = 'A no-approval rule has been paused';
  const lead = `Several forwards in a row failed to send under the no-approval rule "${rule}", so MCPEmails paused it.`;
  const next = 'New forwards it covered now wait for approval, so nothing is lost. To resume it, switch it off and on again on the Automations page.';
  const footer = 'You get this because you are an owner or admin of this workspace. Replies reach support.';
  return {
    subject,
    text: [lead, '', next, '', link, '', footer, `Stop these emails: ${unsubscribe}`, '', 'MCPEmails'].join('\n'),
    html: shell({
      title: subject,
      html: p(lead) + p(next),
      ctaUrl: link,
      ctaLabel: 'Open Automations',
      footerNote: `${footer} <a href="${unsubscribe.replace(/&/g, '&amp;')}" style="color:#64748b;text-decoration:underline;">Stop these emails</a>.`,
    }),
    unsubscribe,
  };
}

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

export interface ClaimedNotice {
  id: string;
  workspace_id: string;
  triage_rule_id: string | null;
  no_approval_rule_id?: string | null;
  kind: NoticeKind;
  attempts: number;
}

export interface NoticeRecipient {
  userId: string;
  email: string;
  unsubscribeToken: string;
}

export interface WaitingForwards {
  count: number;
  addresses: string[];
  deadline: string;
  /** How many are within EXPIRES_SOON_MS of their deadline. */
  expiringSoon?: number;
  /** True when the forwards do not all go to the same addresses. */
  addressesVary?: boolean;
}

export interface FailedForwards {
  count: number;
  addresses: string[];
  canRetry: number;
  mayHaveSent: number;
  reason: DeliveryReason | null;
}

export type NoticeFinish =
  | { status: 'pending'; error: string }
  | { status: 'sent' }
  | { status: 'failed'; error: string }
  | { status: 'cancelled'; error: string };

export interface NoticeStore {
  claim(limit: number): Promise<ClaimedNotice[]>;
  ruleName(ruleId: string): Promise<string | null>;
  waiting(ruleId: string): Promise<WaitingForwards | null>;
  /** The forwards one receipt counts. */
  receipt?(noticeId: string): Promise<{ count: number; addresses: string[]; noApprovalRuleName: string | null } | null>;
  noApprovalRuleName?(ruleId: string): Promise<string | null>;
  /** The forwards one failed notice counts. */
  failed?(noticeId: string, workspaceId: string): Promise<FailedForwards | null>;
  /** Owners and admins of a live workspace who have not opted out of this category. */
  recipients(workspaceId: string, category: string): Promise<NoticeRecipient[]>;
  finish(id: string, outcome: NoticeFinish): Promise<void>;
  logEvent(event: {
    status: 'sent' | 'failed';
    error: string | null;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

export type NoticeSender = (email: {
  to: string;
  subject: string;
  text: string;
  html: string;
  unsubscribe: string;
  idempotencyKey: string;
}) => Promise<{ ok: true; id: string | null } | { ok: false; reason: string }>;

export interface DispatchSummary {
  claimed: number;
  sent: number;
  cancelled: number;
  retried: number;
  failed: number;
}

/** What this notice says, read live, or why there is nothing to say. */
async function noticeContent(
  notice: ClaimedNotice,
  store: NoticeStore,
): Promise<
  | { cancel: string }
  | { compose: (unsubscribeToken: string) => ComposedNotice; count: number }
> {
  if (notice.kind === 'coverage_paused') {
    const name = notice.no_approval_rule_id && store.noApprovalRuleName
      ? await store.noApprovalRuleName(notice.no_approval_rule_id)
      : null;
    if (name === null) return { cancel: 'rule_gone' };
    return { compose: (token) => composeCoveragePaused(name, token), count: 0 };
  }
  const ruleId = notice.triage_rule_id;
  if (!ruleId) return { cancel: 'rule_gone' };
  if (notice.kind === 'receipt') {
    const receipt = store.receipt ? await store.receipt(notice.id) : null;
    if (!receipt || receipt.count === 0) return { cancel: 'nothing_sent' };
    const ruleName = await store.ruleName(ruleId);
    if (ruleName === null) return { cancel: 'rule_gone' };
    return {
      compose: (token) => composeReceipt({
        ruleId,
        ruleName,
        noApprovalRuleName: receipt.noApprovalRuleName,
        count: receipt.count,
        addresses: receipt.addresses,
      }, token),
      count: receipt.count,
    };
  }
  if (notice.kind === 'failed') {
    const failed = store.failed ? await store.failed(notice.id, notice.workspace_id) : null;
    if (!failed || failed.count === 0) return { cancel: 'nothing_failed' };
    const ruleName = await store.ruleName(ruleId);
    if (ruleName === null) return { cancel: 'rule_gone' };
    return {
      compose: (token) => composeFailedNotice({ ruleId, ruleName, ...failed }, token),
      count: failed.count,
    };
  }
  const waiting = await store.waiting(ruleId);
  if (!waiting || waiting.count === 0) return { cancel: 'nothing_waiting' };
  // Everything near its deadline was decided: a reminder has nothing true to say.
  if (notice.kind === 'reminder' && waiting.expiringSoon === 0) return { cancel: 'nothing_expiring' };
  const ruleName = await store.ruleName(ruleId);
  if (ruleName === null) return { cancel: 'rule_gone' };
  const facts: NoticeFacts = {
    kind: notice.kind,
    ruleId,
    ruleName,
    count: waiting.count,
    addresses: waiting.addresses,
    deadline: waiting.deadline,
    expiringSoon: waiting.expiringSoon,
    addressesVary: waiting.addressesVary,
  };
  return { compose: (token) => composeForwardNotice(facts, token), count: waiting.count };
}

async function dispatchOne(notice: ClaimedNotice, store: NoticeStore, send: NoticeSender): Promise<keyof Omit<DispatchSummary, 'claimed'>> {
  const content = await noticeContent(notice, store);
  if ('cancel' in content) {
    await store.finish(notice.id, { status: 'cancelled', error: content.cancel });
    return 'cancelled';
  }
  const category = notice.kind === 'receipt' ? APPROVAL_RECEIPTS_CATEGORY : APPROVAL_NOTICES_CATEGORY;
  const recipients = await store.recipients(notice.workspace_id, category);
  if (recipients.length === 0) {
    await store.finish(notice.id, { status: 'cancelled', error: 'no_recipients' });
    return 'cancelled';
  }

  let delivered = 0;
  let skipped = 0;
  let failedCount = 0;
  let lastReason = '';
  for (const recipient of recipients) {
    const composed = content.compose(recipient.unsubscribeToken);
    const result = await send({
      to: recipient.email,
      subject: composed.subject,
      text: composed.text,
      html: composed.html,
      unsubscribe: composed.unsubscribe,
      // Per notice and per person: a retry after a partial failure or a crash
      // cannot reach anyone twice.
      idempotencyKey: `forward-notice-${notice.id}-${recipient.userId}`,
    });
    if (!result.ok) {
      failedCount += 1;
      lastReason = result.reason;
    } else if (result.id?.startsWith(SKIPPED_ID_PREFIX)) {
      skipped += 1;
    } else {
      delivered += 1;
    }
  }

  if (failedCount > 0 && notice.attempts < NOTICE_MAX_ATTEMPTS) {
    await store.finish(notice.id, { status: 'pending', error: lastReason });
    return 'retried';
  }

  const payload = {
    notice_id: notice.id,
    workspace_id: notice.workspace_id,
    rule_id: notice.triage_rule_id,
    no_approval_rule_id: notice.no_approval_rule_id ?? null,
    kind: notice.kind,
    waiting: content.count,
    recipients: recipients.length,
    delivered,
    skipped,
    failed: failedCount,
  };

  if (failedCount === recipients.length) {
    await store.finish(notice.id, { status: 'failed', error: lastReason });
    await store.logEvent({ status: 'failed', error: lastReason, payload });
    return 'failed';
  }
  await store.finish(notice.id, { status: 'sent' });
  await store.logEvent({ status: 'sent', error: null, payload });
  return 'sent';
}

export async function dispatchForwardNotices(store: NoticeStore, send: NoticeSender): Promise<DispatchSummary> {
  const summary: DispatchSummary = { claimed: 0, sent: 0, cancelled: 0, retried: 0, failed: 0 };
  let notices: ClaimedNotice[];
  try {
    notices = await store.claim(NOTICE_BATCH);
  } catch (error) {
    console.error('[forward-notices] claim failed:', error instanceof Error ? error.message : 'unknown');
    return summary;
  }
  summary.claimed = notices.length;
  for (const notice of notices) {
    try {
      summary[await dispatchOne(notice, store, send)] += 1;
    } catch (error) {
      // Left in 'sending': the lease runs out and the next tick retries it.
      console.error('[forward-notices] notice failed:', {
        notice: notice.id,
        error: error instanceof Error ? error.message : 'unknown',
      });
      summary.retried += 1;
    }
  }
  return summary;
}
