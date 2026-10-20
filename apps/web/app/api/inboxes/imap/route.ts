import { NextRequest, NextResponse, after } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { encryptToken } from '@/lib/crypto';
import { checkInboxLimit, inboxExistsForEmail, inboxLimitErrorBody } from '@/lib/plans/check-inbox-limit';
import { recordInboxCapHit } from '@/lib/plans/inbox-cap-events';
import { syncMailboxAddonForWorkspace } from '@/lib/stripe/mailbox-addon';
import { findOtherProviderInbox, otherProviderErrorBody } from '@/lib/inboxes/provider-conflict';
import { validateImapCredential, type ImapValidationResult } from '@/lib/email/validate-imap';
import { validateSmtpCredential, type SmtpValidationResult } from '@/lib/email/validate-smtp';
import { normalizeSecurity, parseConnectionMode, usesImap, usesSmtp, type ConnectionMode } from '@/lib/email/connection-config';
import { mailRelayConfigFromEnv } from '@/lib/email/mail-relay';
import { detectWithRelay, refreshLearnedRelayHosts } from '@/lib/email/relay-fallback';
import { guardMailHost } from '@/lib/email/host-guard';
import { findConflictingInbox } from '@/lib/email/imap-login-collision';
import { explainAuthFailure } from '@/lib/email/auth-failure';
import { captureError } from '@/lib/errors/capture';
import { recordProductFunnelEvent } from '@/lib/analytics/product-funnel';
import { canManageInboxes, fetchWorkspaceRole, insufficientRoleBody } from '@/lib/workspace/roles';
import { isMicrosoftConsumerAddress, microsoftAccountErrorBody } from '@/lib/email-providers/microsoft-accounts';

// ---------------------------------------------------------------------------
// Route config
// ---------------------------------------------------------------------------

/**
 * Connecting a custom IMAP/SMTP account probes several host/port/security
 * combinations (see lib/email/transport-autodetect.ts); a slow or unresponsive
 * mail server can push a single attempt into the tens of seconds.
 *
 * Declared here rather than in a `functions` block in vercel.json: the Vercel
 * project's Root Directory is apps/web, so a repo-root vercel.json is never
 * loaded and its maxDuration values silently do nothing.
 *
 * 90 rather than 60 since the relay retry (lib/email/relay-fallback.ts): a host
 * that refuses our address can spend the direct detection budget and then one
 * relayed attempt, on each of IMAP and SMTP.
 */
export const maxDuration = 90;

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
 * Body: { email, username?, appPassword, mode?, imapHost, imapPort, smtpHost, smtpPort }
 *
 * `mode` is 'both' (the default), 'imap' or 'smtp'. A receive-only mailbox has
 * no SMTP server to give, and a send-only one (a transactional sender, a relay
 * account) has no IMAP server; requiring both locked either out entirely. Only
 * the halves the mode names are validated, dialled and stored. The other half
 * is persisted as a NULL host and port, which is how the MCP server and the
 * health checks tell "not part of this connection" from "broken".
 *
 * `username` is the optional SASL login username for hosts that issue one
 * distinct from the email address (e.g. domeneshop). When blank, the email
 * address is used as the username — the common case.
 */
/** mcpemails.com or any name under it, on label boundaries. */
function isOwnSiteHost(host: string): boolean {
  const target = host.replace(/\.$/, '');
  return target === 'mcpemails.com' || target.endsWith('.mcpemails.com');
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Authenticate.
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  // The dashboard can only tell an expired session from a broken mail server if
  // this answer is machine-readable. Without a code it fell through to the
  // client's generic "Connection failed. Please try again.", which is advice
  // that can never work: the fix is signing in again, and the user retried the
  // mailbox instead. The `error` sentence is unchanged.
  if (userError || !user) {
    return NextResponse.json({ error: 'Unauthorized', error_code: 'session_expired' }, { status: 401 });
  }

  // 2. Resolve the active workspace.
  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);
  if (!workspaceId) {
  // Same reason as the 401 above: a code the client can turn into a sentence
  // about the workspace rather than about the mail server.
    return NextResponse.json({ error: 'Workspace not found.', error_code: 'workspace_not_found' }, { status: 403 });
  }
  // 2b. Membership is not permission. resolveActiveWorkspaceId only proves the
  //     caller belongs to this workspace, and connecting a mailbox attaches a
  //     live credential that every other member of the workspace can then use
  //     through the MCP server. A real `viewer` member of somebody else's
  //     workspace was proven against production to get past authorization here
  //     (the route answered 422 on credential validation, which is an answer
  //     from well beyond the point where it should have been refused). Viewers
  //     are read-only. This runs before any funnel event and before any network
  //     call to a mail host, so a refused caller costs nothing and leaves no
  //     trace that would count as a real connection attempt.
  const callerRole = await fetchWorkspaceRole(supabase, workspaceId, user.id);
  if (!canManageInboxes(callerRole)) {
    return NextResponse.json(
      insufficientRoleBody('Workspace viewers cannot connect an inbox.'),
      { status: 403 },
    );
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
  let mode: ConnectionMode | null;

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
    mode = parseConnectionMode(body.mode);
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  if (!mode) {
    return NextResponse.json(
      { error: "Connection type must be 'both', 'imap' or 'smtp'.", error_code: 'invalid_mode' },
      { status: 422 },
    );
  }
  const withImap = usesImap(mode);
  const withSmtp = usesSmtp(mode);
  // A half the mode leaves out is ignored, not validated: the form may still
  // be holding values the user typed before switching the connection type, and
  // none of them are going to be dialled or stored.
  if (!withImap) {
    imapHost = '';
    imapPort = NaN;
  }
  if (!withSmtp) {
    smtpHost = '';
    smtpPort = NaN;
  }

  if (!email || !email.includes('@')) {
    return NextResponse.json({ error: 'A valid email address is required.' }, { status: 422 });
  }
  // A personal Microsoft address (outlook.com, hotmail.*, live.*, msn.com)
  // cannot log in with a password at all: Microsoft turned basic auth off for
  // those accounts on 2024-09-16. Refused before any mail server is dialled
  // or any funnel event is written, with a code the connect modal turns into a
  // pointer to the Outlook card. Custom domains are never matched here, even
  // when their mail is hosted by Microsoft.
  if (isMicrosoftConsumerAddress(email)) {
    return NextResponse.json(microsoftAccountErrorBody(), { status: 422 });
  }
  if (!appPassword) {
    return NextResponse.json({ error: 'A password is required.' }, { status: 422 });
  }

  // Our own domain is never anyone's mail server. It has arrived as an SMTP
  // host, put there by a browser or password manager filling this site's name
  // into the form, and the validator then spent every submission port on our
  // web host and reported that "the outgoing server never answered", which sent
  // the user to their provider about a server we had not dialled.
  for (const [field, host] of [['IMAP', imapHost], ['SMTP', smtpHost]] as const) {
    if (host && isOwnSiteHost(host)) {
      return NextResponse.json(
        {
          error:
            `The ${field} server is set to ${host}, which is MCP Emails itself, not your mail server. ` +
            'A browser or password manager may have filled it in. Enter the server name your email provider gave you.',
          error_code: 'own_site_host',
        },
        { status: 422 },
      );
    }
  }

  // SSRF guard. This is the only route where the mail host is fully attacker-
  // controlled, and before the guard existed the check was "non-empty, no
  // spaces, has a dot" — which 127.0.0.1, 10.0.0.7 and 169.254.169.254 all
  // pass. See lib/email/host-guard.ts for the full policy and for why the
  // returned ADDRESS, not the name, is what the validators below dial.
  //
  // It runs before the plan check and before any funnel event on purpose: a
  // refused host must cost nothing and leave no trace that could be counted as
  // a real connection attempt.
  const imapGuard = withImap ? await guardMailHost(imapHost, { protocol: 'imap', port: imapPort }) : null;
  if (imapGuard && !imapGuard.ok) {
    // Same 422 + { error, error_code } contract every other validation failure
    // on this route uses, so the dashboard's existing error handling applies
    // unchanged (an unrecognised code falls back to its generic headline and
    // shows `error` under "What to check").
    return NextResponse.json({ error: imapGuard.message, error_code: imapGuard.code }, { status: 422 });
  }
  const smtpGuard = withSmtp ? await guardMailHost(smtpHost, { protocol: 'smtp', port: smtpPort }) : null;
  if (smtpGuard && !smtpGuard.ok) {
    return NextResponse.json({ error: smtpGuard.message, error_code: smtpGuard.code }, { status: 422 });
  }

  // 4. Enforce the plan inbox cap for brand-new addresses only.
  const alreadyConnected = await inboxExistsForEmail(supabase, workspaceId, email);
  await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'started', category: 'generic_imap', phase: 'tcp', connectionType: alreadyConnected ? 'reconnect' : 'first_connect' });
  // Never convert another provider's inbox: the upsert keys on (workspace_id,
  // email_address), so an address connected through Gmail or Outlook OAuth
  // would be silently rewritten into an IMAP row. Checked before any login is
  // attempted. Another IMAP flavour of the same address is a normal reconnect.
  // See lib/inboxes/provider-conflict.ts.
  const otherProvider = await findOtherProviderInbox(db, workspaceId, email, 'imap');
  if (otherProvider.conflict) {
    await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'failure', category: 'generic_imap', errorCategory: 'conflict', phase: 'persistence' });
    return NextResponse.json(otherProviderErrorBody(otherProvider.existingProvider), { status: 409 });
  }
  if (!alreadyConnected) {
    const inboxLimit = await checkInboxLimit(supabase, workspaceId);
    if (inboxLimit.atLimit) {
      await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'failure', category: 'generic_imap', errorCategory: 'plan_limit' });
      await recordInboxCapHit(workspaceId, inboxLimit);
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
  //
  // Hosts that refuse this app's own address are the exception to the
  // alternation (lib/email/relay-fallback.ts). A relay-only host (mail-relay.ts)
  // or one the relay registry learned is validated through the relay, on the
  // one transport the relay carries; a relay-only host is never dialled
  // directly, because a direct attempt is known to be refused and would count
  // as a failed sign-in against the customer's account. Every other host is
  // dialled directly, and a failure that a different address can fix (a
  // timeout, a greeting that turned us away, a refusal naming where we connect
  // from) earns ONE more attempt through the relay. The host guard above still
  // ran on the name; the relay is asked for it by name and TLS is end to end.
  //
  // Skipped entirely for a send-only connection: there is no IMAP server to
  // validate, and nothing about one is stored.
  const relay = mailRelayConfigFromEnv();
  if (relay) await refreshLearnedRelayHosts(db);
  let resolvedImapPort: number | null = null;
  let resolvedImapSecurity = imapSecurity;
  let imapAdjusted = false;
  if (withImap) {
    const { detection: imapDetection, route: imapRoute } = await detectWithRelay<ImapValidationResult>({
      protocol: 'imap',
      host: imapHost,
      requested: { port: imapPort, security: imapSecurity },
      relay,
      db,
      authReasonOf: (result) =>
        !result.ok && result.code === 'AUTH_FAILED'
          ? explainAuthFailure({ detail: result.detail, email, host: imapHost, secret: appPassword, usernameProvided: Boolean(username) }).reason
          : null,
      attempt: (candidate, timeoutMs, tunnel) =>
        validateImapCredential({
          host: imapHost,
          pinnedAddress: tunnel ? undefined : imapGuard?.address,
          port: candidate.port,
          email,
          username: username || undefined,
          password: appPassword,
          security: candidate.security,
          timeoutMs,
          tunnel,
        }),
    });
    const validation = imapDetection.result;
    // Persist what worked, not what was asked for: leaving the user's guess on
    // the row would send every later sync back to the port that failed.
    resolvedImapPort = validation.ok ? imapDetection.candidate.port : imapPort;
    resolvedImapSecurity = validation.ok ? imapDetection.candidate.security : imapSecurity;
    imapAdjusted = imapDetection.adjusted;

    if (!validation.ok) {
      // Computed BEFORE the funnel row, not after, because the row now carries
      // the sub-case. `explainAuthFailure` is a pure classification of values
      // already in hand, so hoisting it changes nothing but the order.
      const authFailure =
        validation.code === 'AUTH_FAILED'
          ? explainAuthFailure({
              detail: validation.detail,
              email,
              host: imapHost,
              secret: appPassword,
              usernameProvided: Boolean(username),
            })
          : null;
      await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'failure', category: 'generic_imap', errorCategory: validation.code === 'AUTH_FAILED' ? 'auth_failed' : 'validation_failed', phase: validation.phase, connectionType: alreadyConnected ? 'reconnect' : 'first_connect', authReason: authFailure?.reason ?? null });
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
      // A rejected login is 72.9% of every connection failure here, and until now
      // every one of them produced the same "check your password". Which of the
      // four unrelated situations behind it this actually is decides what the
      // dashboard tells the user to do next, so the sub-case travels with the
      // code. Only an enum and the provider's public name cross the wire: the
      // server's own rejection text stays on this side (see auth-failure.ts).
      if (authFailure) Object.assign(body, authFailure.fields);
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
        // Which sub-case the rejection was classified as. This is the field that
        // makes the fix measurable: "did naming the app-password case reduce
        // repeat attempts" cannot be answered from a bare AUTH_FAILED count.
        authReason: authFailure?.reason ?? null,
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
        // True when the reported attempt went through the relay
        // (relay-fallback.ts), so a refusal here is the relay's address being
        // refused, not ours. relayRoute says why it was relayed.
        viaRelay: Boolean(imapRoute),
        relayRoute: imapRoute,
        workspaceId,
      });
      return NextResponse.json(body, { status: 422 });
    }
  }

  // Skipped entirely for a receive-only connection.
  let resolvedSmtpPort: number | null = null;
  let resolvedSmtpSecurity = smtpSecurity;
  let smtpAdjusted = false;
  if (withSmtp) {
    // Authenticate to SMTP without sending a message. This verifies outbound
    // capability while preserving the existing read-only validation semantics.
    // Relayed exactly like IMAP above; a host checked through the relay is
    // checked, and then stored, on 587 with STARTTLS whatever was submitted,
    // because the relay cannot carry 465 (relay-fallback.ts, RELAYED_TRANSPORTS).
    const { detection: smtpDetection, route: smtpRoute } = await detectWithRelay<SmtpValidationResult>({
      protocol: 'smtp',
      host: smtpHost,
      requested: { port: smtpPort, security: smtpSecurity },
      relay,
      db,
      authReasonOf: (result) =>
        !result.ok && result.code === 'AUTH_FAILED'
          ? explainAuthFailure({ detail: result.detail, email, host: smtpHost, secret: appPassword, usernameProvided: Boolean(username) }).reason
          : null,
      attempt: (candidate, timeoutMs, tunnel) =>
        validateSmtpCredential({
          host: smtpHost,
          pinnedAddress: tunnel ? undefined : smtpGuard?.address,
          port: candidate.port,
          email,
          username: username || undefined,
          password: appPassword,
          security: candidate.security,
          // Some hosts hold a refused AUTH for about eight seconds before they
          // answer (Orange), so a relayed check gets the full budget rather
          // than a retry-sized one.
          timeoutMs: tunnel ? Math.max(timeoutMs, 15_000) : timeoutMs,
          tunnel,
        }),
    });
    const smtpValidation = smtpDetection.result;
    resolvedSmtpPort = smtpValidation.ok ? smtpDetection.candidate.port : smtpPort;
    resolvedSmtpSecurity = smtpValidation.ok ? smtpDetection.candidate.security : smtpSecurity;
    smtpAdjusted = smtpDetection.adjusted;
    if (!smtpValidation.ok) {
      // Computed BEFORE the funnel row, not after, because the row now carries
      // the sub-case. `explainAuthFailure` is a pure classification of values
      // already in hand, so hoisting it changes nothing but the order.
      const smtpAuthFailure =
        smtpValidation.code === 'AUTH_FAILED'
          ? explainAuthFailure({
              detail: smtpValidation.detail,
              email,
              host: smtpHost,
              secret: appPassword,
              usernameProvided: Boolean(username),
            })
          : null;
      await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'failure', category: 'generic_imap', errorCategory: smtpValidation.code === 'AUTH_FAILED' ? 'auth_failed' : 'validation_failed', phase: `smtp_${smtpValidation.phase}`, connectionType: alreadyConnected ? 'reconnect' : 'first_connect', authReason: smtpAuthFailure?.reason ?? null });
      // Same treatment on the send half: an IMAP login that worked (or, on a
      // send-only connection, was never attempted) and an SMTP login that did not
      // is still a credential story, and the user is owed the same specific
      // answer rather than a second generic one.
      // An inbox that authenticates over IMAP but fails on SMTP is a distinct and
      // more interesting failure than either half alone, and it had no diagnostic
      // record at all: the funnel counted it, nothing said why.
      await captureError(new Error(smtpValidation.message), {
        severity: 'low',
        route: 'api/inboxes/imap',
        reason: smtpValidation.code,
        phase: `smtp_${smtpValidation.phase}`,
        detail: smtpValidation.detail ?? null,
        authReason: smtpAuthFailure?.reason ?? null,
        smtpHost,
        smtpPort,
        smtpSecurity,
        attempts: smtpDetection.attempts,
        viaRelay: Boolean(smtpRoute),
        relayRoute: smtpRoute,
        workspaceId,
      });
      return NextResponse.json(
        {
          error: smtpValidation.message,
          error_code: smtpValidation.code.toLowerCase(),
          ...(smtpAuthFailure?.fields ?? {}),
        },
        { status: 422 },
      );
    }
  }

  // 6. Defense-in-depth: reject if another active inbox in this workspace
  //    already uses the same IMAP server + same effective login (imap_username
  //    || email_address) but a DIFFERENT address. Guards against the
  //    company-161 incident, where an autofilled login pointed a new address at
  //    an existing mailbox. Runs AFTER validation (so we only block real
  //    credentials) and BEFORE the upsert. Uses the service-role `db` (created
  //    here, also reused for the upsert) so the read sees every workspace row.
  //    A send-only connection has no IMAP server and so no mailbox to collide
  //    with; the check is about reading someone else's mail.
  const conflict = withImap
    ? await findConflictingInbox(db, workspaceId, {
        host: imapHost,
        effectiveLogin: username || email,
        email,
      })
    : { conflict: false as const };
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
      // NULL host and port for the half this connection does not carry: that
      // is how every reader of the row tells "not configured" from "broken".
      imap_host: withImap ? imapHost : null,
      imap_port: resolvedImapPort,
      imap_tls: true,
      imap_security: resolvedImapSecurity,
      imap_username: username || null,
      smtp_host: withSmtp ? smtpHost : null,
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
    return NextResponse.json({ error: 'Failed to save inbox. Please try again.', error_code: 'save_failed' }, { status: 500 });
  }

  await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'success', category: 'generic_imap', phase: 'complete', connectionType: alreadyConnected ? 'reconnect' : 'first_connect' });
  // Business bills mailboxes past ten: bring the add-on quantity in step.
  // After the response, never awaited by it (src/lib/stripe/mailbox-addon.ts).
  if (!alreadyConnected) after(() => syncMailboxAddonForWorkspace(workspaceId).then(() => undefined));
  // Tell the client when the settings it submitted are not the ones now stored,
  // so the dashboard can say so rather than silently disagreeing with the form
  // the user is still looking at.
  return NextResponse.json({
    success: true,
    transport_adjusted: imapAdjusted || smtpAdjusted,
    mode,
    imap_port: resolvedImapPort,
    imap_security: resolvedImapSecurity,
    smtp_port: resolvedSmtpPort,
    smtp_security: resolvedSmtpSecurity,
  });
}
