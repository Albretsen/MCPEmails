import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { validateCsrfToken } from '@/lib/oauth/csrf';
import { consumeStateNonce } from '@/lib/oauth/state';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';

/**
 * POST /api/oauth/authorize
 *
 * Called by the AuthorizeApp client component when the user clicks "Allow access"
 * on the /authorize consent page. Validates CSRF + state nonce, generates a
 * short-lived PKCE authorization code, upserts the consent record, and returns
 * the redirect URL for the client to follow.
 *
 * Security: CSRF token and state nonce are consumed (single-use) on success.
 */

const VALID_SCOPES = new Set([
  'read:email',
  'search:email',
  'send:email',
  'manage:folders',
  'delete:email',
  'manage:drafts',
  'manage:contacts',
  'schedule:email',
]);

function generateAuthCode(): string {
  return crypto.randomBytes(32).toString('hex');
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
  }

  const {
    csrf_token,
    client_id,
    redirect_uri,
    state,
    code_challenge,
    challenge_method,
    scopes,
    inbox_ids,
    all_inboxes,
    key_name,
  } = body as Record<string, unknown>;

  // ── CSRF token validation ─────────────────────────────────────────────────
  if (!csrf_token || typeof csrf_token !== 'string') {
    return NextResponse.json({ error: 'Missing CSRF token.' }, { status: 403 });
  }
  const csrfValid = await validateCsrfToken(csrf_token, user.id);
  if (!csrfValid) {
    return NextResponse.json({ error: 'Invalid or expired CSRF token.' }, { status: 403 });
  }

  // ── Required field validation ─────────────────────────────────────────────
  if (!client_id || typeof client_id !== 'string') {
    return NextResponse.json({ error: 'client_id is required.' }, { status: 400 });
  }
  if (!redirect_uri || typeof redirect_uri !== 'string') {
    return NextResponse.json({ error: 'redirect_uri is required.' }, { status: 400 });
  }
  if (!code_challenge || typeof code_challenge !== 'string') {
    return NextResponse.json({ error: 'code_challenge is required.' }, { status: 400 });
  }
  if (challenge_method !== 'S256') {
    return NextResponse.json({ error: 'Only code_challenge_method=S256 is supported.' }, { status: 400 });
  }

  const oauthState  = typeof state    === 'string' ? state    : '';
  const keyLabel    = typeof key_name === 'string' && key_name.trim()
    ? key_name.trim().slice(0, 255)
    : `OAuth: ${client_id}`;

  // ── State nonce validation ────────────────────────────────────────────────
  // Only validate if the client sent a state param (some clients omit it).
  if (oauthState) {
    const stateValid = await consumeStateNonce(user.id, oauthState);
    if (!stateValid) {
      return NextResponse.json({ error: 'Invalid or expired state parameter.' }, { status: 403 });
    }
  }

  // ── Scope validation ──────────────────────────────────────────────────────
  if (!Array.isArray(scopes)) {
    return NextResponse.json({ error: 'scopes must be an array.' }, { status: 400 });
  }
  const requestedScopes = (scopes as unknown[]).filter(
    (s): s is string => typeof s === 'string' && VALID_SCOPES.has(s)
  );

  const requestedInboxIds = Array.isArray(inbox_ids)
    ? (inbox_ids as unknown[]).filter((id): id is string => typeof id === 'string')
    : [];

  // Inbox access mode. "All inboxes" is stored as inbox_ids = null, which the MCP
  // server treats as access to every inbox in the workspace (including ones
  // connected later). In "specific" mode at least one inbox must be selected —
  // an empty list would otherwise be indistinguishable from "all" and silently
  // over-grant.
  const wantsAllInboxes = all_inboxes === true;
  if (!wantsAllInboxes && requestedInboxIds.length === 0) {
    return NextResponse.json(
      { error: 'Select at least one inbox, or choose all inboxes.' },
      { status: 400 },
    );
  }
  const effectiveInboxIds: string[] | null = wantsAllInboxes ? null : requestedInboxIds;

  // ── Client validation (re-validate server-side) ───────────────────────────
  const { data: oauthClient, error: clientError } = await supabase
    .from('oauth_clients')
    .select('client_id, client_name, redirect_uris, scopes_allowed, deactivated_at')
    .eq('client_id', client_id)
    .is('deactivated_at', null)
    .single();

  if (clientError || !oauthClient) {
    return NextResponse.json({ error: 'Unknown or deactivated client.' }, { status: 400 });
  }

  if (!oauthClient.redirect_uris.includes(redirect_uri)) {
    return NextResponse.json({ error: 'redirect_uri does not match registered URIs.' }, { status: 400 });
  }

  const approvedScopes = requestedScopes.filter((s) => oauthClient.scopes_allowed.includes(s));

  // At least one scope must be granted — a connection with no scopes can call
  // zero tools, so it is never a useful grant. (The consent UI also disables the
  // Allow button in this case; this is the server-side backstop.)
  if (approvedScopes.length === 0) {
    return NextResponse.json(
      { error: 'Select at least one permission to grant.' },
      { status: 400 },
    );
  }

  // ── Workspace resolution ──────────────────────────────────────────────────
  // Use the active workspace (cookie-aware) so the key is minted for the
  // workspace the user is actually viewing, not an arbitrary first one.
  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);

  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace found for this user.' }, { status: 400 });
  }

  // ── Inbox ownership validation ────────────────────────────────────────────
  if (requestedInboxIds.length > 0) {
    const { data: ownedInboxes } = await supabase
      .from('inboxes')
      .select('id')
      .eq('workspace_id', workspaceId)
      .in('id', requestedInboxIds)
      .is('deleted_at', null);

    const ownedIds = new Set((ownedInboxes ?? []).map((r: { id: string }) => r.id));
    if (requestedInboxIds.some((id) => !ownedIds.has(id))) {
      return NextResponse.json({ error: 'One or more inboxes do not belong to your workspace.' }, { status: 400 });
    }
  }

  // ── Generate and store auth code ──────────────────────────────────────────
  const plainCode = generateAuthCode();
  const codeHash  = sha256Hex(plainCode);
  const service   = createServiceRoleClient();

  const { error: insertError } = await service.from('oauth_auth_codes').insert({
    code_hash:            codeHash,
    client_id:            oauthClient.client_id,
    workspace_id:         workspaceId,
    user_id:              user.id,
    client_name:          oauthClient.client_name,
    redirect_uri,
    code_challenge:       code_challenge,
    code_challenge_method: 'S256',
    scopes:               approvedScopes,
    inbox_ids:            effectiveInboxIds,
  });

  if (insertError) {
    console.error('oauth_authorize_insert_error', insertError.message);
    return NextResponse.json({ error: 'Failed to create authorization code.' }, { status: 500 });
  }

  // ── Upsert consent record ─────────────────────────────────────────────────
  await service.from('oauth_consents').upsert(
    {
      user_id:   user.id,
      client_id: oauthClient.client_id,
      scopes:    approvedScopes,
      inbox_ids: effectiveInboxIds,
    },
    { onConflict: 'user_id, client_id' }
  );

  // ── Audit log ─────────────────────────────────────────────────────────────
  const ip        = request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null;
  const userAgent = request.headers.get('user-agent') ?? null;
  await service.from('auth_logs').insert({
    event_type:   'oauth_code_issued',
    user_id:      user.id,
    workspace_id: workspaceId,
    ip_address:   ip,
    user_agent:   userAgent,
    metadata: {
      client_id:  oauthClient.client_id,
      scopes:     approvedScopes,
      inbox_ids:  effectiveInboxIds,
    },
  });

  // ── Build redirect URL ────────────────────────────────────────────────────
  let redirectTo: string;
  try {
    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set('code', plainCode);
    if (oauthState) redirectUrl.searchParams.set('state', oauthState);
    redirectTo = redirectUrl.toString();
  } catch {
    return NextResponse.json({ error: 'redirect_uri is not a valid URL.' }, { status: 400 });
  }

  return NextResponse.json({ redirect_to: redirectTo });
}
