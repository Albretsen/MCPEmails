/**
 * The emails about rule forwards waiting for approval: one when a rule queues
 * them, one before they expire. Sent to the workspace's owners and admins, the
 * only people who can approve.
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

export const NOTICE_BATCH = 25;
export const NOTICE_MAX_ATTEMPTS = 5;
const MAX_ADDRESSES_SHOWN = 5;
export const APPROVAL_NOTICES_CATEGORY = 'approval_notices' as const;

export type NoticeKind = 'queued' | 'reminder';

export interface NoticeFacts {
  kind: NoticeKind;
  ruleId: string;
  ruleName: string;
  count: number;
  addresses: string[];
  deadline: string;
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
  const shown = addresses.slice(0, MAX_ADDRESSES_SHOWN).join(', ');
  const more = addresses.length - MAX_ADDRESSES_SHOWN;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

export function composeForwardNotice(facts: NoticeFacts, unsubscribeToken: string): ComposedNotice {
  const rule = cleanRuleName(facts.ruleName);
  const link = approvalsLinkForRule(facts.ruleId);
  const unsubscribe = unsubscribeUrl(unsubscribeToken, APPROVAL_NOTICES_CATEGORY);
  const one = facts.count === 1;
  const forwards = one ? '1 forward' : `${facts.count} forwards`;
  const deadline = formatDeadline(facts.deadline);
  const to = addressPhrase(facts.addresses);

  const subject = facts.kind === 'queued'
    ? `${forwards} from "${rule}" ${one ? 'needs' : 'need'} your approval`
    : `${forwards} from "${rule}" ${one ? 'expires' : 'expire'} soon`;

  const lead = facts.kind === 'queued'
    ? `Your automation "${rule}" has ${forwards} waiting for approval.`
    : `Your automation "${rule}" still has ${forwards} waiting for approval.`;
  const where = `${one ? 'It goes' : 'They go'} to ${to} once an owner or admin approves. Nothing has been sent.`;
  const when = one
    ? `Decide by ${deadline}. After that it expires and is not sent.`
    : `The first expires on ${deadline}. A forward nobody approves by its deadline is not sent.`;
  const footer = 'You get this because you are an owner or admin of this workspace. Replies reach support.';

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
      `Stop these emails: ${unsubscribe}`,
      '',
      'MCPEmails',
    ].join('\n'),
    html: shell({
      title: subject,
      html: p(lead) + p(where) + p(when),
      ctaUrl: link.replace(/&/g, '&amp;'),
      ctaLabel: one ? 'Review the forward' : 'Review the forwards',
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
  triage_rule_id: string;
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
  /** Owners and admins of a live workspace who have not opted out. */
  recipients(workspaceId: string): Promise<NoticeRecipient[]>;
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

async function dispatchOne(notice: ClaimedNotice, store: NoticeStore, send: NoticeSender): Promise<keyof Omit<DispatchSummary, 'claimed'>> {
  const waiting = await store.waiting(notice.triage_rule_id);
  if (!waiting || waiting.count === 0) {
    await store.finish(notice.id, { status: 'cancelled', error: 'nothing_waiting' });
    return 'cancelled';
  }
  const ruleName = await store.ruleName(notice.triage_rule_id);
  if (ruleName === null) {
    await store.finish(notice.id, { status: 'cancelled', error: 'rule_gone' });
    return 'cancelled';
  }
  const recipients = await store.recipients(notice.workspace_id);
  if (recipients.length === 0) {
    await store.finish(notice.id, { status: 'cancelled', error: 'no_recipients' });
    return 'cancelled';
  }

  const facts: NoticeFacts = {
    kind: notice.kind,
    ruleId: notice.triage_rule_id,
    ruleName,
    count: waiting.count,
    addresses: waiting.addresses,
    deadline: waiting.deadline,
  };

  let delivered = 0;
  let skipped = 0;
  let failedCount = 0;
  let lastReason = '';
  for (const recipient of recipients) {
    const composed = composeForwardNotice(facts, recipient.unsubscribeToken);
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
    kind: notice.kind,
    waiting: waiting.count,
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
