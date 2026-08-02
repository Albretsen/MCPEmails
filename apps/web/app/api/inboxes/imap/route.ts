import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { encryptToken } from '@/lib/crypto';
import { checkInboxLimit, inboxExistsForEmail } from '@/lib/plans/check-inbox-limit';
import { validateImapCredential } from '@/lib/email/validate-imap';
import { findConflictingInbox } from '@/lib/email/imap-login-collision';
import { captureError } from '@/lib/errors/capture';
import { recordProductFunnelEvent } from '@/lib/analytics/product-funnel';

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
 * Body: { email, username?, appPassword, imapHost, imapPort, smtpHost, smtpPort }
 *
 * `username` is the optional SASL login username for hosts that issue one
 * distinct from the email address (e.g. domeneshop). When blank, the email
 * address is used as the username — the common case.
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
  const db = createServiceRoleClient();

  // 3. Parse and validate the request body.
  let email: string;
  let username: string;
  let appPassword: string;
  let imapHost: string;
  let smtpHost: string;
  let imapPort: number;
  let smtpPort: number;

  try {
    const body = (await request.json()) as Record<string, unknown>;
    email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    // Usernames may be case-sensitive — trim only, never lowercase.
    username = typeof body.username === 'string' ? body.username.trim() : '';
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
      await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'failure', category: 'generic_imap', errorCategory: 'plan_limit' });
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
    username: username || undefined,
    password: appPassword,
  });

  if (!validation.ok) {
    await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'failure', category: 'generic_imap', errorCategory: validation.code === 'AUTH_FAILED' ? 'auth_failed' : 'validation_failed' });
    // AUTH_FAILED means the mail server rejected the credentials. Surface a
    // structured error_code so the client can distinguish a credential
    // rejection from other 422 causes (missing/invalid fields, bad host,
    // etc.). Network/TLS errors keep their own messages without error_code.
    const body: Record<string, string> = { error: validation.message };
    if (validation.code === 'AUTH_FAILED') body.error_code = 'auth_failed';
    // A wrong password is expected, user-driven, and not worth recording. The
    // other codes (bad host, connection refused/timeout, TLS/protocol errors)
    // indicate either a real product/infra issue or a config mistake we could
    // proactively warn users about, so they're worth tracking frequency of —
    // this table previously had zero writes anywhere in the codebase.
    if (validation.code !== 'AUTH_FAILED') {
      await captureError(new Error(validation.message), {
        severity: 'low',
        route: 'api/inboxes/imap',
        reason: validation.code,
        workspaceId,
      });
    }
    return NextResponse.json(body, { status: 422 });
  }

  // 6. Defense-in-depth: reject if another active inbox in this workspace
  //    already uses the same IMAP server + same effective login (imap_username
  //    || email_address) but a DIFFERENT address. Guards against the
  //    bonussok1 incident, where an autofilled login pointed a new address at
  //    an existing mailbox. Runs AFTER validation (so we only block real
  //    credentials) and BEFORE the upsert. Uses the service-role `db` (created
  //    here, also reused for the upsert) so the read sees every workspace row.
  const conflict = await findConflictingInbox(db, workspaceId, {
    host: imapHost,
    effectiveLogin: username || email,
    email,
  });
  if (conflict.conflict) {
    await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'failure', category: 'generic_imap', errorCategory: 'conflict' });
    return NextResponse.json(
      {
        error: `This mailbox login is already connected as ${conflict.address}. ` +
          `Each email address needs its own IMAP login — check the username field (it may have been autofilled with another account's login).`,
        error_code: 'login_already_connected',
      },
      { status: 422 },
    );
  }

  // 7. Encrypt the password: never store plaintext.
  const encryptedPassword = encryptToken(appPassword);

  // 8. Upsert with the service-role client (bypasses RLS).
  //    Reconnecting a previously-disconnected address conflicts with the
  //    soft-deleted row on the (workspace_id, email_address) unique index, and
  //    the resulting ON CONFLICT DO UPDATE targets a row with deleted_at set —
  //    which the user RLS policy (USING deleted_at IS NULL) forbids, surfacing
  //    as "new row violates row-level security policy". The workspace was
  //    already authorised above, so the scoped admin write is safe.
  const { error: upsertError } = await db.from('inboxes').upsert(
    {
      workspace_id: workspaceId,
      provider: 'imap',
      service: 'generic',
      email_address: email,
      imap_host: imapHost,
      imap_port: imapPort,
      imap_tls: true,
      imap_username: username || null,
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
    await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'failure', category: 'generic_imap', errorCategory: 'persistence_failed' });
    console.error('[imap] Upsert failed:', upsertError.message);
    await captureError(new Error(upsertError.message), {
      severity: 'high',
      route: 'api/inboxes/imap',
      reason: 'inbox_upsert_failed',
      workspaceId,
    });
    return NextResponse.json({ error: 'Failed to save inbox. Please try again.' }, { status: 500 });
  }

  await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'success', category: 'generic_imap' });
  return NextResponse.json({ success: true });
}

/** Basic hostname sanity check: non-empty, no spaces, has a dot. */
function isValidHost(host: string): boolean {
  return host.length > 0 && host.length <= 253 && !/\s/.test(host) && host.includes('.');
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}
