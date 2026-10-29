import { createResend } from '@/lib/email/resend';

/**
 * "We turned off your webhook": sent once to the workspace owner when the
 * delivery dispatcher (supabase/functions/client-api/webhooks/deliver.ts)
 * disables an endpoint after 24 hours of failed deliveries or 50 failures in
 * a row. Sent through Resend the same way the purchase confirmation is.
 *
 * The email names the endpoint's HOST only. A webhook path often carries a
 * token of the receiver's own, and an email is the wrong place to repeat it.
 *
 *   RESEND_API_KEY            Missing = no send, logged, not thrown.
 *   WEBHOOK_EMAIL_FROM        Optional sender override.
 */

const SUPPORT_ADDRESS = 'hello@mcpemails.com';
const DEFAULT_FROM = `MCPEmails <${SUPPORT_ADDRESS}>`;
const DEFAULT_APP_URL = 'https://mcpemails.com';

export interface WebhookDisabledEmailInput {
  endpointId: string;
  /** When the endpoint was disabled; part of the idempotency key, so a later disable mails again. */
  disabledAt: string;
  url: string;
  workspaceName: string;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function webhookHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'your endpoint';
  }
}

export function buildWebhookDisabledEmail(input: WebhookDisabledEmailInput): { subject: string; text: string; html: string } {
  const host = webhookHost(input.url);
  const link = `${(process.env.NEXT_PUBLIC_APP_URL ?? DEFAULT_APP_URL).replace(/\/$/, '')}/dashboard/keys`;
  const subject = 'A webhook in MCPEmails was turned off';
  const lines = [
    `Deliveries to your webhook at ${host} in the workspace ${input.workspaceName} kept failing, so MCPEmails turned the webhook off.`,
    '',
    'New mail is not sent to it while it is off. Check that the endpoint answers with a 2xx status, send a test event from the dashboard, then turn the webhook back on:',
    link,
  ];
  const html = `<p>Deliveries to your webhook at <strong>${escapeHtml(host)}</strong> in the workspace <strong>${escapeHtml(input.workspaceName)}</strong> kept failing, so MCPEmails turned the webhook off.</p>
<p>New mail is not sent to it while it is off. Check that the endpoint answers with a 2xx status, send a test event from the dashboard, then turn the webhook back on.</p>
<p><a href="${escapeHtml(link)}">Open API keys and webhooks</a></p>`;
  return { subject, text: lines.join('\n'), html };
}

export async function sendWebhookDisabledEmail(to: string, input: WebhookDisabledEmailInput): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error('[webhook-disabled-email] RESEND_API_KEY is not set; skipping');
    return false;
  }
  const { subject, text, html } = buildWebhookDisabledEmail(input);
  const { error } = await createResend(key).emails.send(
    { from: process.env.WEBHOOK_EMAIL_FROM ?? DEFAULT_FROM, to, replyTo: SUPPORT_ADDRESS, subject, text, html },
    { idempotencyKey: `webhook-disabled-${input.endpointId}-${input.disabledAt}`.slice(0, 256) },
  );
  if (error) {
    console.error(`[webhook-disabled-email] send failed for endpoint ${input.endpointId}`);
    return false;
  }
  return true;
}
