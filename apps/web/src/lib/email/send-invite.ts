import { Resend } from 'resend';

/**
 * Thin wrapper around Resend for sending workspace invite emails.
 *
 * Requires:
 *   RESEND_API_KEY       — API key from resend.com
 *   RESEND_FROM_EMAIL    — Verified sender address (default: invites@mcpemails.com)
 *   NEXT_PUBLIC_APP_URL  — Base URL for building accept links (default: https://www.mcpemails.com)
 */

function getResend(): Resend {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not set');
  return new Resend(key);
}

const FROM =
  process.env.RESEND_FROM_EMAIL ?? 'MCP Emails <invites@mcpemails.com>';

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? 'https://www.mcpemails.com';

export interface SendInviteEmailParams {
  to: string;
  inviterName: string;
  workspaceName: string;
  role: string;
  /** Raw 64-char hex token — appended to the accept URL. */
  rawToken: string;
}

export async function sendInviteEmail(params: SendInviteEmailParams): Promise<void> {
  const { to, inviterName, workspaceName, role, rawToken } = params;
  const acceptUrl = `${APP_URL}/invite/${rawToken}`;

  const roleLabel =
    role === 'admin' ? 'Admin' : role === 'viewer' ? 'Viewer' : 'Member';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>You've been invited to ${workspaceName}</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">

          <!-- Header -->
          <tr>
            <td style="background:#0f172a;padding:28px 40px;">
              <span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:-0.3px;">MCP Emails</span>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 40px 32px;">
              <p style="margin:0 0 6px;font-size:22px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">
                You've been invited
              </p>
              <p style="margin:0 0 24px;font-size:15px;color:#64748b;line-height:1.5;">
                <strong style="color:#0f172a;">${inviterName}</strong> has invited you to join
                <strong style="color:#0f172a;">${workspaceName}</strong>
                on MCP Emails as a <strong style="color:#0f172a;">${roleLabel}</strong>.
              </p>

              <!-- CTA button -->
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#0f172a;border-radius:8px;">
                    <a href="${acceptUrl}"
                       style="display:inline-block;padding:12px 28px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;letter-spacing:-0.1px;">
                      Accept invitation →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:24px 0 0;font-size:13px;color:#94a3b8;line-height:1.5;">
                Or copy this link into your browser:<br/>
                <a href="${acceptUrl}" style="color:#3b82f6;word-break:break-all;">${acceptUrl}</a>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #e2e8f0;">
              <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;">
                This invite expires in 7 days. If you weren't expecting this email, you can safely ignore it.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    `You've been invited to join ${workspaceName} on MCP Emails`,
    '',
    `${inviterName} has invited you as a ${roleLabel}.`,
    '',
    `Accept the invitation here:`,
    acceptUrl,
    '',
    'This invite expires in 7 days.',
  ].join('\n');

  const resend = getResend();
  const { error } = await resend.emails.send({
    from: FROM,
    to,
    subject: `You've been invited to join ${workspaceName} on MCP Emails`,
    html,
    text,
  });

  if (error) {
    throw new Error(`Resend error: ${error.message}`);
  }
}
