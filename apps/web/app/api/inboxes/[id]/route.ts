import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { decryptToken } from '@/lib/crypto';

/**
 * DELETE /api/inboxes/[id]
 *
 * Disconnects an inbox:
 *  1. Authenticate the user.
 *  2. Fetch the inbox via the RLS-scoped client. The inboxes SELECT policy
 *     guarantees the row is in a workspace the user belongs to and is not
 *     already soft-deleted, so a returned row is proof of authorization.
 *  3. Best-effort revoke the OAuth grant with the email provider. Failures
 *     are logged but never block local cleanup.
 *  4. Clear all credential columns, set status = 'revoked', and soft-delete
 *     (deleted_at = now()) in a single update.
 *  5. Write a token_revoked event to auth_logs.
 *
 * Steps 4 and 5 use the service-role client. They cannot run under the user's
 * RLS context: setting deleted_at moves the row out of the inboxes SELECT
 * policy (deleted_at IS NULL), which Postgres rejects as "new row violates
 * row-level security policy"; and auth_logs has no INSERT policy for
 * authenticated users (all writes are service-role). Authorization is already
 * established in step 2, and every service-role write is scoped to the inbox
 * id AND its workspace_id.
 *
 * Soft-delete (rather than hard delete) lets the same email address be
 * reconnected later via a fresh OAuth flow, and preserves activity_log rows
 * that reference the inbox id.
 */

// ─── Provider revocation helpers ─────────────────────────────────────────────
// Each is best-effort: awaited, but all errors are caught at the call site so a
// provider outage never blocks local cleanup.

async function revokeGoogleGrant(token: string): Promise<void> {
  // Google's revocation endpoint revokes the entire grant when given the
  // refresh token (preferred) or just the one access token. Either is accepted
  // as the `token` query parameter.
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

async function revokeOutlookToken(): Promise<void> {
  // Microsoft offers no token revocation endpoint; tokens are invalidated by
  // expiry (1 hour). The logout endpoint is called for completeness only.
  await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/logout', {
    method: 'GET',
  });
}

async function revokeFastmailToken(token: string): Promise<void> {
  await fetch('https://www.fastmail.com/oauth/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  });
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function DELETE(
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

  // 2. Fetch the inbox via the RLS-scoped client. The SELECT policy enforces
  //    that the row belongs to one of the user's workspaces and is not already
  //    deleted, so a returned row authorizes the disconnect. Encrypted
  //    credential columns are read here only to revoke the provider grant; they
  //    are NEVER logged.
  const { data: inbox, error: fetchError } = await supabase
    .from('inboxes')
    .select('id, workspace_id, provider, oauth_access_token, oauth_refresh_token, imap_host')
    .eq('id', inboxId)
    .is('deleted_at', null)
    .single();

  if (fetchError || !inbox) {
    return NextResponse.json({ error: 'Inbox not found.' }, { status: 404 });
  }

  const workspaceId = inbox.workspace_id;

  // 3. Best-effort provider revocation for OAuth inboxes. App-password inboxes
  //    (imap_host set, no OAuth token) have nothing to revoke. Prefer the
  //    refresh token so the whole grant is revoked, not just one access token.
  if (!inbox.imap_host && (inbox.oauth_refresh_token || inbox.oauth_access_token)) {
    try {
      const encrypted = inbox.oauth_refresh_token ?? inbox.oauth_access_token;
      const token = decryptToken(encrypted as string);

      if (inbox.provider === 'gmail') {
        await revokeGoogleGrant(token);
      } else if (inbox.provider === 'outlook') {
        await revokeOutlookToken();
      } else if (inbox.provider === 'fastmail') {
        await revokeFastmailToken(token);
      }
    } catch (err) {
      // Local cleanup proceeds regardless; the provider token expires naturally
      // if revocation failed.
      console.error(
        `[disconnect-inbox] Provider revocation failed for inbox ${inboxId}:`,
        (err as Error).message
      );
    }
  }

  const service = createServiceRoleClient();
  const now = new Date().toISOString();

  // 4. Clear credentials, mark revoked, and soft-delete in one update.
  //    Scoped to id AND workspace_id as defence-in-depth even though step 2
  //    already proved authorization.
  const { error: updateError } = await service
    .from('inboxes')
    .update({
      oauth_access_token: null,
      oauth_refresh_token: null,
      oauth_token_expires_at: null,
      oauth_scope: null,
      imap_password: null,
      status: 'revoked',
      deleted_at: now,
      updated_at: now,
    })
    .eq('id', inboxId)
    .eq('workspace_id', workspaceId);

  if (updateError) {
    console.error('[disconnect-inbox] Failed to disconnect inbox:', updateError.message);
    return NextResponse.json({ error: 'Failed to disconnect inbox.' }, { status: 500 });
  }

  // 5. Audit log: best-effort (a logging failure does not fail the request).
  const { error: auditError } = await service.from('auth_logs').insert({
    event_type: 'token_revoked',
    provider: inbox.provider,
    user_id: user.id,
    workspace_id: workspaceId,
    metadata: { inbox_id: inboxId },
  });

  if (auditError) {
    console.error('[disconnect-inbox] Failed to write audit log:', auditError.message);
  }

  return NextResponse.json({ success: true });
}
