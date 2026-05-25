import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { decryptToken } from '@/lib/crypto';

/**
 * DELETE /api/inboxes/[id]
 *
 * Disconnects an inbox in four steps:
 *  1. Authenticate the user and resolve their workspace.
 *  2. Fetch the inbox row, confirming it belongs to this workspace.
 *  3. Best-effort revoke the OAuth access token with the email provider.
 *     Revocation failures are logged but never block local cleanup.
 *  4. Clear all credential columns (oauth_*, imap_password), set
 *     status = 'revoked', and soft-delete the row (deleted_at = now()).
 *  5. Write a token_revoked event to auth_logs for the audit trail.
 *
 * The soft-delete approach (deleted_at IS NOT NULL) lets the same email
 * address be reconnected later via a new OAuth flow, which upserts a fresh
 * row and un-sets deleted_at. Activity log rows are preserved because they
 * reference the inbox ID, not the email address.
 *
 * References:
 *   Documents/Architecture/email-provider-oauth-flows.md §9 (Revocation)
 */

// ─── Provider revocation helpers ─────────────────────────────────────────────
// Each function is fire-and-forget: we await it but catch all errors at the
// call site so a provider outage never blocks local cleanup.

async function revokeGmailToken(accessToken: string): Promise<void> {
  // Google's revocation endpoint accepts the token as a query parameter.
  await fetch(
    `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(accessToken)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
}

async function revokeOutlookToken(_accessToken: string): Promise<void> {
  // Microsoft does not offer a token revocation endpoint; the recommended
  // approach is to call the logout endpoint. This is best-effort only and
  // does not actually invalidate existing tokens server-side — Microsoft
  // relies on token expiry (1 hour). We call it for completeness.
  await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/logout', {
    method: 'GET',
  });
}

async function revokeFastmailToken(accessToken: string): Promise<void> {
  await fetch('https://www.fastmail.com/oauth/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: accessToken }),
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

  // 3. Fetch the inbox row — only the columns needed for revocation.
  //    Encrypted credential columns are selected here because we need to
  //    decrypt the access token to send the revocation request to the provider.
  //    They are NEVER logged.
  const { data: inbox, error: fetchError } = await supabase
    .from('inboxes')
    .select('id, workspace_id, provider, oauth_access_token, imap_host, status')
    .eq('id', inboxId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .single();

  if (fetchError || !inbox) {
    return NextResponse.json({ error: 'Inbox not found.' }, { status: 404 });
  }

  // 4. Best-effort provider revocation.
  //    Only attempt revocation when there is an OAuth access token.
  //    App-password inboxes (imap_host set, no oauth token) have no token to revoke.
  if (inbox.oauth_access_token && !inbox.imap_host) {
    try {
      const accessToken = decryptToken(inbox.oauth_access_token);

      if (inbox.provider === 'gmail') {
        await revokeGmailToken(accessToken);
      } else if (inbox.provider === 'outlook') {
        await revokeOutlookToken(accessToken);
      } else if (inbox.provider === 'fastmail') {
        await revokeFastmailToken(accessToken);
      }
    } catch (err) {
      // Log the failure but do not abort — local cleanup proceeds regardless.
      // The provider-side token will expire naturally if revocation failed.
      console.error(
        `[disconnect-inbox] Provider revocation failed for inbox ${inboxId}:`,
        (err as Error).message
      );
    }
  }

  const now = new Date().toISOString();

  // 5. Clear all credential columns and mark the row as revoked.
  const { error: updateError } = await supabase
    .from('inboxes')
    .update({
      oauth_access_token: null,
      oauth_refresh_token: null,
      oauth_token_expires_at: null,
      imap_password: null,
      status: 'revoked',
      updated_at: now,
    })
    .eq('id', inboxId)
    .eq('workspace_id', workspaceId);

  if (updateError) {
    console.error('[disconnect-inbox] Failed to clear credentials:', updateError.message);
    return NextResponse.json({ error: 'Failed to disconnect inbox.' }, { status: 500 });
  }

  // 6. Soft-delete the row so the same email address can be reconnected later.
  const { error: softDeleteError } = await supabase
    .from('inboxes')
    .update({ deleted_at: now })
    .eq('id', inboxId)
    .eq('workspace_id', workspaceId);

  if (softDeleteError) {
    console.error('[disconnect-inbox] Failed to soft-delete inbox:', softDeleteError.message);
    return NextResponse.json({ error: 'Failed to disconnect inbox.' }, { status: 500 });
  }

  // 7. Write an audit log entry — best-effort (failure does not affect the response).
  await supabase.from('auth_logs').insert({
    event_type: 'token_revoked',
    provider: inbox.provider,
    user_id: user.id,
    workspace_id: workspaceId,
    metadata: { inbox_id: inboxId },
  });

  return NextResponse.json({ success: true });
}
