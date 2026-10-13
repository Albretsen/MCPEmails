import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { decryptToken } from '@/lib/crypto';
import { withFreshGmailToken, verifyGmailAccess, InboxAuthError } from '@/lib/email-providers/gmail';
import { checkOutlookMailbox, OutlookAuthError } from '@/lib/email-providers/outlook';
import { OUTLOOK_NO_MAILBOX_REASON } from '@/lib/email-providers/outlook-oauth';
import { openImapSession, McpEmailsError, ImapAuthError } from '@/lib/email/imap';
import { guardMailHost } from '@/lib/email/host-guard';
import { validateSmtpCredential } from '@/lib/email/validate-smtp';
import { legacySecurityForPort } from '@/lib/email/connection-config';
import { openMailRelayTunnel, relayForMailHost, RELAY_ONLY_SMTP_TRANSPORT } from '@/lib/email/mail-relay';
import type { Tables } from '@/types/database.types';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { recordProductFunnelEvent } from '@/lib/analytics/product-funnel';

/**
 * POST /api/inboxes/[id]/check
 *
 * Verifies that an inbox's stored credentials still grant access right now.
 * This is the action behind the "Check connection" button on the Inboxes page.
 *
 * For OAuth inboxes (Gmail / Outlook / Fastmail): refresh the access token if
 * it is near expiry (which also detects a revoked refresh token), then make a
 * lightweight authenticated request to the provider to confirm the token is
 * still accepted server-side.
 *
 * For Fastmail app-password (IMAP) inboxes: open an IMAP session and log out.
 *
 * For a send-only (SMTP-only) inbox: authenticate to the SMTP server without
 * sending anything. There is no IMAP server to log in to, and answering
 * "Unsupported provider" for a mailbox that works was the old behaviour.
 *
 * Three outcomes:
 *  - healthy  → status set to 'active', last_error cleared, last_sync_at stamped.
 *  - rejected → status set to 'error', last_error set (user must reconnect).
 *  - inconclusive (network / provider outage) → status left unchanged; the
 *    client is told to try again rather than flipping a working inbox to error.
 */

const RECONNECT_HINT = 'Reconnect this inbox to restore access.';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: inboxId } = await params;

  if (!inboxId || typeof inboxId !== 'string' || inboxId.length > 100) {
    return NextResponse.json({ error: 'Invalid inbox ID.' }, { status: 400 });
  }

  const supabase = await createClient();

  // 1. Authenticate the requesting user.
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // 2. Fetch the inbox (including credentials, which never leave this handler).
  //    RLS on inboxes restricts SELECT to workspaces the user is a member of
  //    (and to non-deleted rows), so this both authorizes and scopes the read,
  //    correct even when the user belongs to multiple workspaces.
  const { data: inbox, error: fetchError } = await supabase
    .from('inboxes')
    .select('*')
    .eq('id', inboxId)
    .is('deleted_at', null)
    .single<Tables<'inboxes'>>();

  if (fetchError || !inbox) {
    return NextResponse.json({ error: 'Inbox not found.' }, { status: 404 });
  }

  const workspaceId = inbox.workspace_id;

  // 4. Run the credential check. `healthy` is null while inconclusive.
  let healthy: boolean | null = null;
  let reason: string | null = null;

  const isAppPassword =
    !!inbox.imap_host && !!inbox.imap_password && !inbox.oauth_access_token;
  const isSendOnly =
    !inbox.imap_host && !!inbox.smtp_host && !!inbox.imap_password && !inbox.oauth_access_token;

  try {
    if (isAppPassword) {
      // SSRF guard on a STORED host. The row was written by a request body, and
      // rows predating the guard were never checked at all; a name that was a
      // real mail host when it was saved can also be repointed at 127.0.0.1 or
      // 169.254.169.254 afterwards, and this button is a user-triggered way to
      // make the function dial it.
      //
      // Answered as a 422 rather than by flipping the inbox to 'error': a DNS
      // answer is transient, and a momentary bad resolution must not persist a
      // permanent failure onto an inbox that is otherwise fine.
      const guard = await guardMailHost(inbox.imap_host!, {
        protocol: 'imap',
        port: inbox.imap_port ?? 993,
      });
      if (!guard.ok) {
        return NextResponse.json({ error: guard.message, error_code: guard.code }, { status: 422 });
      }
      const session = await openImapSession({
        host: inbox.imap_host!,
        // Dial the address the guard approved, not the name: re-resolving here
        // would reopen the rebinding window the check just closed.
        pinnedAddress: guard.address,
        port: inbox.imap_port ?? 993,
        email: inbox.email_address,
        authMethod: 'PLAIN',
        appPassword: decryptToken(inbox.imap_password!),
      });
      await session.logout();
      healthy = true;
    } else if (isSendOnly) {
      const smtpHost = inbox.smtp_host!;
      // A relay-only host refuses this app's own address, so it is checked the
      // way it was connected: through the relay, on the one transport it
      // carries (see mail-relay.ts).
      const relay = relayForMailHost(smtpHost);
      const smtpPort = relay ? RELAY_ONLY_SMTP_TRANSPORT.port : inbox.smtp_port ?? 465;
      // Same SSRF guard as the IMAP branch, on the host this branch dials.
      const guard = await guardMailHost(smtpHost, { protocol: 'smtp', port: smtpPort });
      if (!guard.ok) {
        return NextResponse.json({ error: guard.message, error_code: guard.code }, { status: 422 });
      }
      const result = await validateSmtpCredential({
        host: smtpHost,
        pinnedAddress: relay ? undefined : guard.address,
        port: smtpPort,
        email: inbox.email_address,
        username: inbox.imap_username || undefined,
        password: decryptToken(inbox.imap_password!),
        security: relay
          ? RELAY_ONLY_SMTP_TRANSPORT.security
          : inbox.smtp_security === 'starttls' || inbox.smtp_security === 'tls'
            ? inbox.smtp_security
            : legacySecurityForPort(smtpPort, 'smtp'),
        timeoutMs: relay ? 15_000 : undefined,
        tunnel: relay ? () => openMailRelayTunnel(relay, smtpHost, smtpPort) : undefined,
      });
      if (result.ok) {
        healthy = true;
      } else if (result.code === 'AUTH_FAILED') {
        healthy = false;
        reason = `The SMTP server rejected the saved password. ${RECONNECT_HINT}`;
      } else {
        // Anything short of a rejected login is inconclusive, as for IMAP.
        throw new Error(result.message);
      }
    } else if (inbox.provider === 'gmail') {
      const token = await withFreshGmailToken(inbox);
      healthy = await verifyGmailAccess(token);
      if (!healthy) reason = `Google rejected the saved access. ${RECONNECT_HINT}`;
    } else if (inbox.provider === 'outlook') {
      // checkOutlookMailbox refreshes once and re-probes on a 401, and reads
      // a 401 that survives a fresh token as 'no_mailbox': an account with no
      // Exchange Online mailbox gets a valid token and a 401 on every mailbox
      // call. Only a failed refresh (invalid_grant) means the saved sign-in is
      // dead, and that arrives as an OutlookAuthError in the catch below.
      const access = await checkOutlookMailbox(inbox);
      healthy = access === 'ok';
      // A 403 or a missing mailbox come back identically after a reconnect, so
      // telling the user to reconnect would send them round in a loop; name the
      // real cause.
      if (access === 'unauthorized') {
        reason = `Microsoft rejected the saved access. ${RECONNECT_HINT}`;
      } else if (access === 'forbidden') {
        reason =
          'Microsoft accepted the sign-in but refused access to this mailbox. ' +
          'An administrator of this Microsoft 365 organisation may be blocking mailbox access for this app.';
      } else if (access === 'no_mailbox') {
        reason = OUTLOOK_NO_MAILBOX_REASON;
      }
    } else {
      return NextResponse.json(
        { error: `Unsupported provider: ${inbox.provider}` },
        { status: 422 }
      );
    }
  } catch (err) {
    // An auth-class error is a definitive failure: the credentials are no
    // longer valid and the user must reconnect. The token-refresh helpers
    // already mark the inbox as errored in the database for these cases.
    if (
      err instanceof InboxAuthError ||
      err instanceof OutlookAuthError ||
      err instanceof ImapAuthError ||
      (err instanceof McpEmailsError &&
        (err.code === 'AUTH_FAILED' ||
          err.code === 'AUTH_TOKEN_EXPIRED' ||
          err.code === 'AUTH_SCOPE_INSUFFICIENT'))
    ) {
      healthy = false;
      reason = isAppPassword
        ? `The app password was rejected. ${RECONNECT_HINT}`
        : `The saved sign-in is no longer valid. ${RECONNECT_HINT}`;
    } else {
      // Network / TLS / provider-outage errors are inconclusive: leave the
      // inbox status untouched and ask the user to retry.
      console.error(`[check-inbox] Inconclusive check for inbox ${inboxId}:`, (err as Error).message);
      return NextResponse.json({
        ok: false,
        transient: true,
        status: inbox.status,
        lastError: inbox.last_error ?? null,
        message: 'Could not reach the mail provider. Please try again.',
      });
    }
  }

  const now = new Date().toISOString();

  if (healthy) {
    await supabase
      .from('inboxes')
      .update({ status: 'active', last_error: null, last_sync_at: now, updated_at: now })
      .eq('id', inboxId)
      .eq('workspace_id', workspaceId);

    const service = createServiceRoleClient();
    const { data: claimed } = await service.from('workspaces').update({ onboarding_connection_verified_at: now }).eq('id', workspaceId).is('onboarding_connection_verified_at', null).select('id');
    const category = (inbox.provider === 'imap' ? 'generic_imap' : inbox.provider) as Parameters<typeof recordProductFunnelEvent>[1]['category'];
    if (claimed?.length) await recordProductFunnelEvent(service, { workspaceId, stage: 'connection_verified', outcome: 'success', category });

    return NextResponse.json({
      ok: true,
      status: 'active',
      lastError: null,
      message: 'Connection is healthy.',
    });
  }

  // Definitive failure: ensure the row reflects the errored state. (OAuth
  // refresh-token failures are already persisted by the provider helper; this
  // also covers live-ping rejections and IMAP auth failures.)
  await supabase
    .from('inboxes')
    .update({ status: 'error', last_error: reason, updated_at: now })
    .eq('id', inboxId)
    .eq('workspace_id', workspaceId);

  return NextResponse.json({
    ok: false,
    status: 'error',
    lastError: reason,
    message: reason ?? `Connection check failed. ${RECONNECT_HINT}`,
  });
}
