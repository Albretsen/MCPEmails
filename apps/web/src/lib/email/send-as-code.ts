import { Resend } from 'resend';

/**
 * The Send As verification mail: a 6-digit code sent TO the address being
 * added, which proves mail for it reaches the person adding it. See
 * lib/inboxes/send-as.ts.
 *
 * Carries nothing the requester typed except the two addresses, both of which
 * have passed the From-header address check, so it cannot be turned into a
 * way to mail arbitrary text to a third party.
 *
 * Requires RESEND_API_KEY; sends from RESEND_FROM_EMAIL like the invite mail.
 */

const FROM = process.env.RESEND_FROM_EMAIL ?? 'MCPEmails <invites@mcpemails.com>';

export interface SendAsCodeEmail {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function buildSendAsCodeEmail(params: { to: string; inboxAddress: string; code: string }): SendAsCodeEmail {
  const { to, inboxAddress, code } = params;
  const subject = `${code} is your MCPEmails verification code`;
  const text = [
    `Someone asked to send email as ${to} from the mailbox ${inboxAddress} on MCPEmails.`,
    '',
    `Your code: ${code}`,
    '',
    'Enter it in the dashboard to finish. It expires in 15 minutes.',
    '',
    "If this wasn't you, ignore this email. Nothing changes until the code is entered.",
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:32px 16px;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
    <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">
      Someone asked to send email as <strong>${escapeHtml(to)}</strong> from the mailbox
      <strong>${escapeHtml(inboxAddress)}</strong> on MCPEmails.
    </p>
    <p style="margin:0 0 16px;font-size:32px;font-weight:700;letter-spacing:6px;font-family:ui-monospace,Menlo,monospace;">${escapeHtml(code)}</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">Enter it in the dashboard to finish. It expires in 15 minutes.</p>
    <p style="margin:0;font-size:13px;line-height:1.5;color:#64748b;">If this wasn't you, ignore this email. Nothing changes until the code is entered.</p>
  </div>
</body>
</html>`;

  return { subject, text, html };
}

export async function sendSendAsCode(params: { to: string; inboxAddress: string; code: string }): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not set');
  const email = buildSendAsCodeEmail(params);
  const { error } = await new Resend(key).emails.send({
    from: FROM,
    to: params.to,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });
  if (error) throw new Error(`Resend error: ${error.message}`);
}
