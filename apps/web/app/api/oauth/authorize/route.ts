import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';

/**
 * POST /api/oauth/authorize
 *
 * Called by the AuthorizeApp client component when the user clicks "Allow access"
 * on the /authorize consent page. Generates a short-lived authorization code and
 * redirects the user's browser to the MCP client's redirect_uri with the code.
 *
 * Request body (JSON):
 *   client_id        string  — must match a registered oauth_clients row
 *   redirect_uri     string  — must exactly match one of the client's registered URIs
 *   state            string  — opaque value echoed back in the redirect (CSRF protection)
 *   code_challenge   string  — PKCE S256 challenge; validated at token exchange
 *   challenge_method string  — must be "S256"
 *   scopes           string[] — subset of the client's allowed scopes the user approved
 *   inbox_ids        string[] — inbox UUIDs the user granted access to; [] = all
 *   key_name         string  — display name for the eventual API key
 *
 * Response (JSON):
 *   { redirect_to: string }  — full redirect_uri with code and state appended
 *
 * The authorization code:
 *   - Is 32 bytes (256 bits) of CSPRNG output encoded as 64 lowercase hex characters
 *   - Is hashed with SHA-256 before storage; the plaintext is returned to the client
 *     via the redirect and never persisted
 *   - Has a 10-minute TTL enforced by the expires_at column default in the DB
 *   - Is single-use: the token endpoint hard-deletes it immediately after exchange
 *
 * Security:
 *   - Only S256 PKCE is accepted; plain challenge_method is rejected
 *   - redirect_uri is validated by exact match against registered URIs
 *   - Scopes are validated against the client's allowed scope list
 *   - oauth_auth_codes has RLS deny-all; inserts use the service-role client
 *   - The user must be authenticated; the workspace is resolved from their session
 *
 * References:
 *   Documents/Architecture/mcp-authentication-flow.md §7 (OAuth Authorize Flow)
 */

const VALID_SCOPES = new Set([
  'read:email',
  'search:email',
  'send:email',
  'manage:drafts',
  'manage:folders',
]);

/** Generate a hex-encoded 32-byte random authorization code. */
function generateAuthCode(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** SHA-256 hex digest of a string value. */
function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── 1. Authenticate the requesting user ────────────────────────────────────
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // ── 2. Parse request body ──────────────────────────────────────────────────
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
    client_id,
    redirect_uri,
    state,
    code_challenge,
    challenge_method,
    scopes,
    inbox_ids,
    key_name,
  } = body as Record<string, unknown>;

  // Validate required string fields
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
    return NextResponse.json(
      { error: 'Only code_challenge_method=S256 is supported.' },
      { status: 400 }
    );
  }

  const oauthState = typeof state === 'string' ? state : '';
  const keyLabel =
    typeof key_name === 'string' && key_name.trim().length > 0
      ? key_name.trim().slice(0, 255)
      : `OAuth: ${client_id}`;

  // Validate scopes array
  if (!Array.isArray(scopes)) {
    return NextResponse.json({ error: 'scopes must be an array.' }, { status: 400 });
  }
  const requestedScopes = (scopes as unknown[]).filter(
    (s): s is string => typeof s === 'string' && VALID_SCOPES.has(s)
  );

  // Validate inbox_ids array (may be empty)
  const requestedInboxIds =
    Array.isArray(inbox_ids)
      ? (inbox_ids as unknown[]).filter((id): id is string => typeof id === 'string')
      : [];

  // ── 3. Validate client_id and redirect_uri against registered clients ──────
  // oauth_clients has a public-read RLS policy; the user client is sufficient.
  const { data: oauthClient, error: clientError } = await supabase
    .from('oauth_clients')
    .select('client_id, client_name, redirect_uris, scopes_allowed')
    .eq('client_id', client_id)
    .single();

  if (clientError || !oauthClient) {
    return NextResponse.json(
      { error: 'Unknown client_id. This application is not registered.' },
      { status: 400 }
    );
  }

  if (!oauthClient.redirect_uris.includes(redirect_uri)) {
    return NextResponse.json(
      { error: 'redirect_uri does not match any registered URI for this client.' },
      { status: 400 }
    );
  }

  // Filter to only scopes the client is actually allowed to request
  const approvedScopes = requestedScopes.filter((s) =>
    oauthClient.scopes_allowed.includes(s)
  );

  // ── 4. Resolve the user's workspace ───────────────────────────────────────
  const { data: member, error: memberError } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1)
    .single();

  if (memberError || !member) {
    return NextResponse.json(
      { error: 'No workspace found for this user.' },
      { status: 400 }
    );
  }

  const workspaceId = member.workspace_id;

  // ── 5. Validate that requested inbox_ids belong to this workspace ──────────
  // Skip the check if no specific inboxes were selected (null means all inboxes).
  if (requestedInboxIds.length > 0) {
    const { data: ownedInboxes, error: inboxError } = await supabase
      .from('inboxes')
      .select('id')
      .eq('workspace_id', workspaceId)
      .in('id', requestedInboxIds)
      .is('deleted_at', null);

    if (inboxError) {
      return NextResponse.json(
        { error: 'Failed to validate inbox access.' },
        { status: 500 }
      );
    }

    const ownedIds = new Set((ownedInboxes ?? []).map((row: { id: string }) => row.id));
    const unauthorizedInboxes = requestedInboxIds.filter((id) => !ownedIds.has(id));

    if (unauthorizedInboxes.length > 0) {
      return NextResponse.json(
        { error: 'One or more requested inboxes do not belong to your workspace.' },
        { status: 400 }
      );
    }
  }

  // ── 6. Generate and store the authorization code ───────────────────────────
  // 32 bytes of CSPRNG output encoded as 64 lowercase hex characters.
  // Only the SHA-256 hash is persisted; the plaintext is returned via redirect.
  const plainCode = generateAuthCode();
  const codeHash = sha256Hex(plainCode);

  // oauth_auth_codes has RLS deny-all; must use service-role to insert.
  const serviceSupabase = createServiceRoleClient();

  const { error: insertError } = await serviceSupabase.from('oauth_auth_codes').insert({
    code_hash: codeHash,
    client_id: oauthClient.client_id,
    workspace_id: workspaceId,
    user_id: user.id,
    client_name: oauthClient.client_name,
    redirect_uri: redirect_uri,
    code_challenge: code_challenge,
    scopes: approvedScopes,
    // null means "all active inboxes in the workspace"; an empty selection also
    // maps to null so we remain consistent with the api_keys.inbox_ids convention.
    inbox_ids: requestedInboxIds.length > 0 ? requestedInboxIds : null,
    // key_name is not in the oauth_auth_codes schema; it will be used at token
    // exchange time (task 15.3) and is stored on the resulting api_keys row.
    // For now we embed it as extra context via a future migration if needed.
    // expires_at defaults to now() + 10 minutes (set by the DB column default).
  });

  if (insertError) {
    return NextResponse.json(
      { error: 'Failed to create authorization code. Please try again.' },
      { status: 500 }
    );
  }

  // ── 7. Build the redirect URL ──────────────────────────────────────────────
  // Append the plaintext code (not the hash) and the original state param.
  // The MCP client exchanges this code for an API key at POST /api/oauth/token.
  let redirectTo: string;
  try {
    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set('code', plainCode);
    if (oauthState) {
      redirectUrl.searchParams.set('state', oauthState);
    }
    redirectTo = redirectUrl.toString();
  } catch {
    return NextResponse.json(
      { error: 'redirect_uri is not a valid URL.' },
      { status: 400 }
    );
  }

  return NextResponse.json({ redirect_to: redirectTo }, { status: 200 });
}
