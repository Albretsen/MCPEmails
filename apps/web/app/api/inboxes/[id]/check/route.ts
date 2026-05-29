import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { decryptToken } from '@/lib/crypto';
import { withFreshGmailToken, verifyGmailAccess, InboxAuthError } from '@/lib/email-providers/gmail';
import { withFreshOutlookToken, verifyOutlookAccess, OutlookAuthError } from '@/lib/email-providers/outlook';
import { withFreshFastmailToken, verifyFastmailAccess, FastmailAuthError } from '@/lib/email-providers/fastmail';
import { openImapSession, McpEmailsError, ImapAuthError } from '@/lib/email/imap';
import type { Tables } from '@/types/database.types';

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

  // 2. Resolve the user's workspace via workspace_members.
  const { data: member, error: memberError } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .single();

  if (memberError || !member) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
  }

  const workspaceId = member.workspace_id;

  // 3. Fetch the inbox (including credentials, which never leave this handler).
  const { data: inbox, error: fetchError } = await supabase
    .from('inboxes')
    .select('*')
    .eq('id', inboxId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .single<Tables<'inboxes'>>();

  if (fetchError || !inbox) {
    return NextResponse.json({ error: 'Inbox not found.' }, { status: 404 });
  }

  // 4. Run the credential check. `healthy` is null while inconclusive.
  let healthy: boolean | null = null;
  let reason: string | null = null;

  const isAppPassword =
    !!inbox.imap_host && !!inbox.imap_password && !inbox.oauth_access_token;

  try {
    if (isAppPassword) {
      const session = await openImapSession({
        host: inbox.imap_host!,
        port: inbox.imap_port ?? 993,
        email: inbox.email_address,
        authMethod: 'PLAIN',
        appPassword: decryptToken(inbox.imap_password!),
      });
      await session.logout();
      healthy = true;
    } else if (inbox.provider === 'gmail') {
      const token = await withFreshGmailToken(inbox);
      healthy = await verifyGmailAccess(token);
      if (!healthy) reason = `Google rejected the saved access. ${RECONNECT_HINT}`;
    } else if (inbox.provider === 'outlook') {
      const token = await withFreshOutlookToken(inbox);
      healthy = await verifyOutlookAccess(token);
      if (!healthy) reason = `Microsoft rejected the saved access. ${RECONNECT_HINT}`;
    } else if (inbox.provider === 'fastmail') {
      const token = await withFreshFastmailToken(inbox);
      healthy = await verifyFastmailAccess(token);
      if (!healthy) reason = `Fastmail rejected the saved access. ${RECONNECT_HINT}`;
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
      err instanceof FastmailAuthError ||
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
      // Network / TLS / provider-outage errors are inconclusive — leave the
      // inbox status untouched and ask the user to retry.
      console.error(`[check-inbox] Inconclusive check for inbox ${inboxId}:`, (err as Error).message);
      return NextResponse.json({
        ok: false,
        transient: true,
        status: inbox.status,
        lastError: inbox.last_error ?? null,
        message: 'Could not reach the mail provider — please try again.',
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

    return NextResponse.json({
      ok: true,
      status: 'active',
      lastError: null,
      message: 'Connection is healthy.',
    });
  }

  // Definitive failure — ensure the row reflects the errored state. (OAuth
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
