import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { decryptToken } from '@/lib/crypto';
import type { Database } from '@/types/database.types';

type InboxUpdate = Database['public']['Tables']['inboxes']['Update'];

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

/**
 * PATCH /api/inboxes/[id]
 *
 * Updates the per-inbox email signature (Phase 3, dashboard editor). The send
 * paths in the MCP server append this signature on every send/reply/forward/
 * draft/scheduled message (see composeSignatureBlocks / applySignature).
 *
 * Authorization mirrors DELETE exactly:
 *  1. Authenticate the user.
 *  2. Fetch the inbox via the RLS-scoped client. The inboxes SELECT policy
 *     guarantees the row is in a workspace the user belongs to and is not
 *     soft-deleted, so a returned row is proof of authorization.
 *  3. Write via the service-role client, scoped to id AND workspace_id as
 *     defence-in-depth (the same two-key scoping DELETE uses).
 *
 * The dashboard edits the plain-text signature only; we write `signature_text`
 * and leave `signature_html` to be derived by the send path
 * (composeSignatureBlocks fills the missing half). Saving any edit stamps
 * `signature_source = 'manual'` and `signature_updated_at = now()`, which pins
 * the value so the Gmail auto-import gate never overwrites it.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: inboxId } = await params;

  if (!inboxId || typeof inboxId !== 'string' || inboxId.length > 100) {
    return NextResponse.json({ error: 'Invalid inbox ID.' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  const input = body as Record<string, unknown>;

  // Validate and collect the writable signature fields. A field omitted entirely
  // is left unchanged; an explicitly-provided value (including an empty string,
  // to clear the signature) is written.
  const update: InboxUpdate = {};

  const htmlProvided = 'signature_html' in input;

  if ('signature_text' in input) {
    if (typeof input.signature_text !== 'string' || input.signature_text.length > 10000) {
      return NextResponse.json(
        { error: 'signature_text must be a string of at most 10000 characters.' },
        { status: 400 }
      );
    }
    update.signature_text = input.signature_text;
    // Text-only edit (no `signature_html` key present): clear any imported HTML
    // so the send path derives a fresh HTML signature from the new text rather
    // than mixing the user's edit with a stale imported HTML block. When the
    // rich editor also sends `signature_html`, that branch below owns the HTML
    // column and we must NOT clobber it here.
    if (!htmlProvided) {
      update.signature_html = null;
    }
  }

  // `signature_html` from the rich editor. Three cases:
  //  - key absent            → leave/clear per the text rules above (handled).
  //  - key present, non-empty → sanitize (server is the authority) and store.
  //  - key present, ''        → a deliberate "clear my HTML signature"; store ''.
  //    (sanitizeSignatureHtml returns '' for '' without throwing, so this falls
  //     through the same path.)
  // We do NOT derive plain text from the HTML here: the edge send path's
  // stripHtmlToText fills signature_text from html at send time when text is
  // empty, so we simply persist whatever the client sent for each column.
  if (htmlProvided) {
    if (typeof input.signature_html !== 'string') {
      return NextResponse.json(
        { error: 'signature_html must be a string.' },
        { status: 400 }
      );
    }
    // The sanitizer is imported dynamically (not at module top-level) because it
    // pulls in isomorphic-dompurify → jsdom, whose ESM-only transitive deps break
    // Next's build-time page-data collection if evaluated eagerly. Loading it
    // inside the handler defers it to request time on the Node runtime.
    const { sanitizeSignatureHtml, SIGNATURE_HTML_MAX_LENGTH } = await import(
      '@/lib/sanitizeSignatureHtml'
    );
    // Defensive pre-check: reject an oversized payload before sanitizing.
    if (input.signature_html.length > SIGNATURE_HTML_MAX_LENGTH) {
      return NextResponse.json({ error: 'Signature is too large.' }, { status: 400 });
    }
    let cleanHtml: string;
    try {
      cleanHtml = sanitizeSignatureHtml(input.signature_html);
    } catch {
      // The only throw path here is the >100KB guard (input is a validated
      // string); surface it as a 400 and write nothing.
      return NextResponse.json({ error: 'Signature is too large.' }, { status: 400 });
    }
    // Defensive post-check in case sanitized output still exceeds the limit.
    if (cleanHtml.length > SIGNATURE_HTML_MAX_LENGTH) {
      return NextResponse.json({ error: 'Signature is too large.' }, { status: 400 });
    }
    update.signature_html = cleanHtml;
  }

  if ('signature_enabled' in input) {
    if (typeof input.signature_enabled !== 'boolean') {
      return NextResponse.json(
        { error: 'signature_enabled must be a boolean.' },
        { status: 400 }
      );
    }
    update.signature_enabled = input.signature_enabled;
  }

  if ('signature_reply_mode' in input) {
    const mode = input.signature_reply_mode;
    if (mode !== 'always' && mode !== 'first_only' && mode !== 'never') {
      return NextResponse.json(
        { error: "signature_reply_mode must be one of 'always', 'first_only', 'never'." },
        { status: 400 }
      );
    }
    update.signature_reply_mode = mode;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json(
      { error: 'Provide at least one of signature_text, signature_html, signature_enabled, signature_reply_mode.' },
      { status: 400 }
    );
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

  // 2. Fetch the inbox via the RLS-scoped client. A returned row authorizes the
  //    edit (the SELECT policy enforces workspace membership + not deleted).
  const { data: inbox, error: fetchError } = await supabase
    .from('inboxes')
    .select('id, workspace_id')
    .eq('id', inboxId)
    .is('deleted_at', null)
    .single();

  if (fetchError || !inbox) {
    return NextResponse.json({ error: 'Inbox not found.' }, { status: 404 });
  }

  const workspaceId = inbox.workspace_id;

  // 3. Any edit pins the signature as user-owned so Gmail auto-import never
  //    overwrites it on a later send.
  const now = new Date().toISOString();
  update.signature_source = 'manual';
  update.signature_updated_at = now;
  update.updated_at = now;

  const service = createServiceRoleClient();
  const { data: saved, error: updateError } = await service
    .from('inboxes')
    .update(update)
    .eq('id', inboxId)
    .eq('workspace_id', workspaceId)
    .select(
      'signature_text, signature_html, signature_enabled, signature_reply_mode, signature_source, signature_updated_at'
    )
    .single();

  if (updateError || !saved) {
    console.error('[update-inbox-signature] Failed to save signature:', updateError?.message);
    return NextResponse.json({ error: 'Failed to save signature.' }, { status: 500 });
  }

  return NextResponse.json({ success: true, signature: saved });
}
