import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { encryptToken } from '@/lib/crypto';
import { checkInboxLimit, inboxExistsForEmail } from '@/lib/plans/check-inbox-limit';
import { validateImapCredential } from '@/lib/email/validate-imap';

/**
 * POST /api/inboxes/imap
 *
 * Connects an arbitrary IMAP/SMTP mailbox with user-supplied host/port settings
 * (the generic catch-all connector). The credential is validated against the
 * given IMAP server before anything is persisted.
 *
 * Stored with provider = 'imap', service = 'generic'. The edge function infers
 * implicit-TLS vs STARTTLS for sending from smtp_port (587 → STARTTLS).
 *
 * Body: { email, appPassword, imapHost, imapPort, smtpHost, smtpPort }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Authenticate.
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Resolve the active workspace.
  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
  }

  // 3. Parse and validate the request body.
  let email: string;
  let appPassword: string;
  let imapHost: string;
  let smtpHost: string;
  let imapPort: number;
  let smtpPort: number;

  try {
    const body = (await request.json()) as Record<string, unknown>;
    email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    appPassword = typeof body.appPassword === 'string' ? body.appPassword.trim() : '';
    imapHost = typeof body.imapHost === 'string' ? body.imapHost.trim().toLowerCase() : '';
    smtpHost = typeof body.smtpHost === 'string' ? body.smtpHost.trim().toLowerCase() : '';
    imapPort = typeof body.imapPort === 'number' ? body.imapPort : Number(body.imapPort);
    smtpPort = typeof body.smtpPort === 'number' ? body.smtpPort : Number(body.smtpPort);
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  if (!email || !email.includes('@')) {
    return NextResponse.json({ error: 'A valid email address is required.' }, { status: 422 });
  }
  if (!appPassword) {
    return NextResponse.json({ error: 'A password is required.' }, { status: 422 });
  }
  if (!isValidHost(imapHost) || !isValidHost(smtpHost)) {
    return NextResponse.json({ error: 'A valid IMAP and SMTP host is required.' }, { status: 422 });
  }
  if (!isValidPort(imapPort) || !isValidPort(smtpPort)) {
    return NextResponse.json({ error: 'IMAP and SMTP ports must be between 1 and 65535.' }, { status: 422 });
  }

  // 4. Enforce the plan inbox cap for brand-new addresses only.
  const alreadyConnected = await inboxExistsForEmail(supabase, workspaceId, email);
  if (!alreadyConnected) {
    const inboxLimit = await checkInboxLimit(supabase, workspaceId);
    if (inboxLimit.atLimit) {
      const capLabel = inboxLimit.maxInboxes === 1 ? '1 inbox' : `${inboxLimit.maxInboxes} inboxes`;
      return NextResponse.json(
        {
          error: `Your ${inboxLimit.plan} plan allows ${capLabel}. ` +
            `Upgrade at mcpemails.com/pricing to connect more.`,
          error_code: 'inbox_limit_reached',
          plan: inboxLimit.plan,
          current_count: inboxLimit.currentCount,
          max_inboxes: inboxLimit.maxInboxes,
        },
        { status: 402 }
      );
    }
  }

  // 5. Validate the credential against the supplied IMAP server.
  const validation = await validateImapCredential({
    host: imapHost,
    port: imapPort,
    email,
    password: appPassword,
  });

  if (!validation.ok) {
    return NextResponse.json({ error: validation.message }, { status: 422 });
  }

  // 6. Encrypt the password: never store plaintext.
  const encryptedPassword = encryptToken(appPassword);

  // 7. Upsert.
  const { error: upsertError } = await supabase.from('inboxes').upsert(
    {
      workspace_id: workspaceId,
      provider: 'imap',
      service: 'generic',
      email_address: email,
      imap_host: imapHost,
      imap_port: imapPort,
      imap_tls: true,
      smtp_host: smtpHost,
      smtp_port: smtpPort,
      smtp_tls: true,
      imap_password: encryptedPassword,
      oauth_access_token: null,
      oauth_refresh_token: null,
      oauth_token_expires_at: null,
      oauth_scope: null,
      status: 'active',
      last_error: null,
      deleted_at: null,
      updated_at: new Date().toISOString(),
    },
    {
      onConflict: 'workspace_id, email_address',
      ignoreDuplicates: false,
    }
  );

  if (upsertError) {
    console.error('[imap] Upsert failed:', upsertError.message);
    return NextResponse.json({ error: 'Failed to save inbox. Please try again.' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

/** Basic hostname sanity check: non-empty, no spaces, has a dot. */
function isValidHost(host: string): boolean {
  return host.length > 0 && host.length <= 253 && !/\s/.test(host) && host.includes('.');
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}
