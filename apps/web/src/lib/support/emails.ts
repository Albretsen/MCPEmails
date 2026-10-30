/**
 * The two emails a ticket sends, via Resend.
 *
 *  1. To support@mcpemails.com, Reply-To the customer, so answering is just
 *     "Reply" in the support mailbox. Subject `[MCPE-1001] Billing: <subject>`.
 *     Body: the customer's message first, then a plain context block.
 *  2. A confirmation to the customer, Reply-To support@, giving the ref.
 *
 * THE CONFIRMATION NEVER ECHOES THE SUBJECT OR MESSAGE. The signed-out form
 * sends it to whatever address was typed, so echoing visitor text would let
 * anyone use our domain to deliver their words to a third party. It says only
 * that we received a request, its ref, and when we reply.
 *
 * ENGLISH ONLY, like purchase-confirmation.ts and for a similar reason: the
 * request carries no reliable language (the interface locale lives in
 * localStorage), and a support reply comes from a person who answers in the
 * customer's language anyway.
 *
 * Same transport rules as purchase-confirmation.ts: RESEND_API_KEY read at call
 * time, one attempt, an Idempotency-Key derived from the ticket ref, and the
 * send functions NEVER THROW. They return whether Resend accepted the message
 * so the caller can record it on the row.
 */
import type { Resend } from 'resend';
import { createResend } from '@/lib/email/resend';
import { appEnv } from '@/lib/env/app-env';

import { planDisplayName } from '@/lib/stripe/plans';
import type { TicketContext } from '@/lib/support/context';
import { SUPPORT_CATEGORY_LABELS, type SupportCategory, type SupportTicketSource } from '@/lib/support/validation';

// SUPPORT_INBOX and SUPPORT_FROM env vars exist for staging, so its tickets
// never land in the real support mailbox. Production leaves both unset.
export const SUPPORT_INBOX = process.env.SUPPORT_INBOX || 'support@mcpemails.com';
export const SUPPORT_FROM = process.env.SUPPORT_FROM || `MCPEmails Support <${SUPPORT_INBOX}>`;

export interface ComposedEmail {
  subject: string;
  body: string;
  htmlBody: string;
}

export interface TicketEmailInput {
  ref: string;
  email: string;
  category: SupportCategory;
  subject: string;
  message: string;
  source: SupportTicketSource;
  context: TicketContext;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One line: CR/LF and other controls become spaces. Header injection guard. */
export function oneLine(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function contextLines(input: TicketEmailInput): string[] {
  const c = input.context;
  const mailboxes = c.mailboxes.length
    ? c.mailboxes.map((m) =>
        `  - ${[m.provider, m.service, m.host, m.status, m.last_error_code ? `error: ${m.last_error_code}` : null]
          .filter(Boolean)
          .join(' | ')}`,
      )
    : ['  (none)'];
  return [
    `Ref: ${input.ref}`,
    `Email: ${input.email}`,
    `Category: ${SUPPORT_CATEGORY_LABELS[input.category]} (${input.category})`,
    `Source: ${input.source}`,
    `Workspace: ${c.workspace_id ?? '-'}`,
    // Display name for reading, slug in brackets for support lookups.
    `Plan: ${c.plan ? `${planDisplayName(c.plan)} (${c.plan})` : '-'}`,
    'Mailboxes:',
    ...mailboxes,
    `From: ${c.from ?? '-'}`,
    `Provider: ${c.provider ?? '-'}`,
    `Code: ${c.code ?? '-'}`,
  ];
}

export function buildSupportTicketEmail(input: TicketEmailInput): ComposedEmail {
  const subject = oneLine(`[${input.ref}] ${SUPPORT_CATEGORY_LABELS[input.category]}: ${input.subject}`);
  const ctx = contextLines(input);
  const body = `${input.message}\n\n-- \n${ctx.join('\n')}\n`;
  const htmlBody = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
<div style="white-space:pre-wrap;font-size:15px;line-height:1.6;">${escapeHtml(input.message)}</div>
<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
<pre style="font-size:12px;color:#475569;line-height:1.5;white-space:pre-wrap;">${escapeHtml(ctx.join('\n'))}</pre>
</body></html>`;
  return { subject, body, htmlBody };
}

/** Takes ONLY the ref: there is no way to pass visitor text into this email. */
export function buildSupportConfirmationEmail(input: { ref: string }): ComposedEmail {
  const ref = oneLine(input.ref);
  const subject = `We received your request (${ref})`;
  const body = [
    'Hi,',
    '',
    `We received your support request. Its reference is ${ref}.`,
    '',
    'We reply by email within one business day. If you want to add anything, reply to this email and keep the reference in the subject.',
    '',
    'If you did not contact MCPEmails, you can ignore this email.',
    '',
    'MCPEmails Support',
    SUPPORT_INBOX,
  ].join('\n');
  const htmlBody = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;font-size:15px;line-height:1.6;">
<p>Hi,</p>
<p>We received your support request. Its reference is <strong>${escapeHtml(ref)}</strong>.</p>
<p>We reply by email within one business day. If you want to add anything, reply to this email and keep the reference in the subject.</p>
<p style="color:#64748b;font-size:13px;">If you did not contact MCPEmails, you can ignore this email.</p>
<p>MCPEmails Support<br><a href="mailto:${SUPPORT_INBOX}" style="color:#3b82f6;">${SUPPORT_INBOX}</a></p>
</body></html>`;
  return { subject, body, htmlBody };
}

/**
 * Resend Idempotency-Key for a ticket or contract email. Staging and production
 * share one Resend account and both number refs from MCPE-1001, so the key
 * carries the environment: without it production's first tickets reused keys
 * staging had spent that day and Resend refused them (409 within 24 hours).
 */
export function supportIdempotencyKey(prefix: string, kind: string, ref: string): string {
  return `${prefix}-${appEnv()}-${kind}-${ref}`.slice(0, 256);
}

function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  return key ? createResend(key) : null;
}

function safeCode(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9_.:\- ]{1,120}$/i.test(value) ? value : 'unexpected_response';
}

async function send(
  kind: string,
  ref: string,
  message: { to: string; replyTo: string } & ComposedEmail,
): Promise<boolean> {
  try {
    const resend = getResend();
    if (!resend) {
      console.error(`[support-email] no RESEND_API_KEY configured; ${kind} for ${ref} not sent`);
      return false;
    }
    const { error } = await resend.emails.send(
      {
        from: SUPPORT_FROM,
        to: message.to,
        replyTo: message.replyTo,
        subject: message.subject,
        html: message.htmlBody,
        text: message.body,
      },
      { idempotencyKey: supportIdempotencyKey('support', kind, ref) },
    );
    if (error) {
      console.error(`[support-email] ${kind} FAILED for ${ref}: ${safeCode(error.message)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[support-email] ${kind} for ${ref} threw, swallowed:`, err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** To the support inbox, Reply-To the customer. Never throws. */
export function sendSupportTicketEmail(input: TicketEmailInput): Promise<boolean> {
  return send('ticket', input.ref, { to: SUPPORT_INBOX, replyTo: input.email, ...buildSupportTicketEmail(input) });
}

/** To the customer, Reply-To support. Never throws. */
export function sendSupportConfirmationEmail(input: { ref: string; email: string }): Promise<boolean> {
  return send('confirmation', input.ref, {
    to: input.email,
    replyTo: SUPPORT_INBOX,
    ...buildSupportConfirmationEmail({ ref: input.ref }),
  });
}
