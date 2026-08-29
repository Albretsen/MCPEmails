import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { encryptToken } from '@/lib/crypto';
import { checkInboxLimit, inboxExistsForEmail, inboxLimitErrorBody } from '@/lib/plans/check-inbox-limit';
import { validateImapCredential } from '@/lib/email/validate-imap';
import { validateSmtpCredential } from '@/lib/email/validate-smtp';
import { normalizeSecurity } from '@/lib/email/connection-config';
import { detectTransport, transportPlan } from '@/lib/email/transport-autodetect';
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
 * The submitted port/security pair is a starting point, not a verdict. When an
 * attempt fails without ever establishing a usable session, the standard
 * alternatives are tried automatically and whichever combination works is what
 * gets persisted (see lib/email/transport-autodetect.ts for the policy, and in
 * particular for why a rejected password is never retried).
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
  let imapSecurity: 'tls' | 'starttls';
  let smtpSecurity: 'tls' | 'starttls';

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
    imapSecurity = normalizeSecurity(body.imapSecurity);
    smtpSecurity = normalizeSecurity(body.smtpSecurity);
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
  await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'started', category: 'generic_imap', phase: 'tcp', connectionType: alreadyConnected ? 'reconnect' : 'first_connect' });
  if (!alreadyConnected) {
    const inboxLimit = await checkInboxLimit(supabase, workspaceId);
    if (inboxLimit.atLimit) {
      await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'failure', category: 'generic_imap', errorCategory: 'plan_limit' });
      // 402 with a stable machine-readable body; the dashboard owns the
      // localised sentence. See inboxLimitErrorBody for why nothing here
      // interpolates the internal plan slug.
      return NextResponse.json(inboxLimitErrorBody(inboxLimit), { status: 402 });
    }
  }

  // 5. Validate the credential against the supplied IMAP server, falling back
  //    through the standard transports when the submitted one never gets far
  //    enough to present a credential. Twelve consecutive hand-made attempts
  //    against one host, alternating 993/TLS and 143/STARTTLS, is what this
  //    replaces; the loop does the same alternation in seconds and stops the
  //    moment a server actually answers, including when it answers "no".
  const imapDetection = await detectTransport(
    transportPlan('imap', { port: imapPort, security: imapSecurity }),
    (candidate, timeoutMs) =>
      validateImapCredential({
        host: imapHost,
        port: candidate.port,
        email,
        username: username || undefined,
        password: appPassword,
        security: candidate.security,
        timeoutMs,
      })
  );
  const validation = imapDetection.result;
  // Persist what worked, not what was asked for: leaving the user's guess on
  // the row would send every later sync back to the port that failed.
  const resolvedImapPort = validation.ok ? imapDetection.candidate.port : imapPort;
  const resolvedImapSecurity = validation.ok ? imapDetection.candidate.security : imapSecurity;

  if (!validation.ok) {
    await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'failure', category: 'generic_imap', errorCategory: validation.code === 'AUTH_FAILED' ? 'auth_failed' : 'validation_failed', phase: validation.phase, connectionType: alreadyConnected ? 'reconnect' : 'first_connect' });
    // Every validator code is surfaced, not just AUTH_FAILED, and in the same
    // lower-cased form the SMTP branch below already uses. A timeout or a TLS
    // failure is the case where the machine-readable code matters most: the fix
    // is a port or security mode in Advanced settings, and the client opens
    // that section only when it can tell a transport failure from a credential
    // one. Sending no code left those failures indistinguishable from a bad
    // password, which is the one cause Advanced settings cannot fix.
    const body: Record<string, string> = {
      error: validation.message,
      error_code: validation.code.toLowerCase(),
    };
    // AUTH_FAILED used to be skipped here on the theory that a wrong password
    // is user-driven noise. That reasoning does not survive contact with the
    // numbers: auth failures are the single largest bucket of generic IMAP
    // failures (49 of 101), and skipping them meant the largest failure mode on
    // the connector we most want to work left no trace at all. A mistyped
    // password and a host that rejects every login in the same way are only
    // distinguishable in aggregate, and only if the rows exist.
    //
    // Nothing secret is recorded. `detail` is the sanitized server rejection
    // (see sanitizeAuthDiagnostic: the submitted username, address, password
    // and the SASL token are stripped before it is stored), and the host/port/
    // security triple is server configuration the user typed into a form, not
    // a credential. The email address is deliberately NOT recorded.
    await captureError(new Error(validation.message), {
      severity: 'low',
      route: 'api/inboxes/imap',
      reason: validation.code,
      phase: validation.phase,
      detail: validation.detail ?? null,
      // The host/port/security combination is what distinguishes a genuinely
      // unreachable server from the port/security mismatch that produced most
      // of these failures, and it was the field whose absence made the earlier
      // rows unactionable.
      imapHost,
      imapPort,
      imapSecurity,
      // How many transports were tried before giving up. A failure at one
      // attempt is a credential or a name that does not resolve; a failure at
      // three means every standard transport was exhausted, which is the row
      // that says the host itself is the problem.
      attempts: imapDetection.attempts,
      workspaceId,
    });
    return NextResponse.json(body, { status: 422 });
  }

  // Authenticate to SMTP without sending a message. This verifies outbound
  // capability while preserving the existing read-only validation semantics.
  const smtpDetection = await detectTransport(
    transportPlan('smtp', { port: smtpPort, security: smtpSecurity }),
    (candidate, timeoutMs) =>
      validateSmtpCredential({
        host: smtpHost,
        port: candidate.port,
        email,
        username: username || undefined,
        password: appPassword,
        security: candidate.security,
        timeoutMs,
      })
  );
  const smtpValidation = smtpDetection.result;
  const resolvedSmtpPort = smtpValidation.ok ? smtpDetection.candidate.port : smtpPort;
  const resolvedSmtpSecurity = smtpValidation.ok ? smtpDetection.candidate.security : smtpSecurity;
  if (!smtpValidation.ok) {
    await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'failure', category: 'generic_imap', errorCategory: smtpValidation.code === 'AUTH_FAILED' ? 'auth_failed' : 'validation_failed', phase: `smtp_${smtpValidation.phase}`, connectionType: alreadyConnected ? 'reconnect' : 'first_connect' });
    // An inbox that authenticates over IMAP but fails on SMTP is a distinct and
    // more interesting failure than either half alone, and it had no diagnostic
    // record at all: the funnel counted it, nothing said why.
    await captureError(new Error(smtpValidation.message), {
      severity: 'low',
      route: 'api/inboxes/imap',
      reason: smtpValidation.code,
      phase: `smtp_${smtpValidation.phase}`,
      detail: smtpValidation.detail ?? null,
      smtpHost,
      smtpPort,
      smtpSecurity,
      attempts: smtpDetection.attempts,
      workspaceId,
    });
    return NextResponse.json({ error: smtpValidation.message, error_code: smtpValidation.code.toLowerCase() }, { status: 422 });
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
      imap_port: resolvedImapPort,
      imap_tls: true,
      imap_security: resolvedImapSecurity,
      imap_username: username || null,
      smtp_host: smtpHost,
      smtp_port: resolvedSmtpPort,
      smtp_tls: true,
      smtp_security: resolvedSmtpSecurity,
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

  await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'success', category: 'generic_imap', phase: 'complete', connectionType: alreadyConnected ? 'reconnect' : 'first_connect' });
  // Tell the client when the settings it submitted are not the ones now stored,
  // so the dashboard can say so rather than silently disagreeing with the form
  // the user is still looking at.
  return NextResponse.json({
    success: true,
    transport_adjusted: imapDetection.adjusted || smtpDetection.adjusted,
    imap_port: resolvedImapPort,
    imap_security: resolvedImapSecurity,
    smtp_port: resolvedSmtpPort,
    smtp_security: resolvedSmtpSecurity,
  });
}

/** Basic hostname sanity check: non-empty, no spaces, has a dot. */
function isValidHost(host: string): boolean {
  return host.length > 0 && host.length <= 253 && !/\s/.test(host) && host.includes('.');
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}
