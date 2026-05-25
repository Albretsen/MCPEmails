import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { generateApiKey } from '@/lib/api-keys/generate';

/**
 * POST /api/oauth/token
 *
 * Authorization code → API key exchange (OAuth 2.0 with PKCE, RFC 6749 §4.1.3).
 *
 * Called by MCP clients after the user has approved access on /authorize.
 * Validates the authorization code, verifies the PKCE S256 code_verifier,
 * issues a new MCPEmails API key scoped to the approved inboxes and permissions,
 * and returns it as a bearer access token.
 *
 * Request body (application/x-www-form-urlencoded or application/json):
 *   grant_type      "authorization_code" (required)
 *   code            string — plaintext authorization code from the /authorize redirect
 *   code_verifier   string — PKCE plain verifier corresponding to the S256 challenge
 *   client_id       string — must match the client_id used at /authorize
 *   redirect_uri    string — must exactly match the redirect_uri used at /authorize
 *
 * Successful response (200 application/json, Cache-Control: no-store):
 *   { access_token: string, token_type: "bearer", scope: string }
 *
 * Error responses (400 application/json, Cache-Control: no-store):
 *   { error: string, error_description: string }
 *   - "unsupported_grant_type" — grant_type is not "authorization_code"
 *   - "invalid_request"        — missing or malformed required parameter
 *   - "invalid_grant"          — code not found, expired, PKCE failure, or redirect_uri mismatch
 *   - "server_error"           — unexpected failure during key issuance
 *
 * Security properties:
 *   - PKCE S256 is mandatory: code_verifier is validated against the stored
 *     code_challenge (BASE64URL(SHA-256(code_verifier)) must equal code_challenge).
 *   - The authorization code is single-use: it is hard-deleted immediately after
 *     successful validation, before the API key is inserted.
 *   - redirect_uri must exactly match the value submitted at /authorize time.
 *   - Expired codes (TTL = 10 minutes, enforced by DB column default + query filter)
 *     are rejected with the same "invalid_grant" error as missing codes to prevent
 *     oracle attacks.
 *   - All DB operations use the service-role client because oauth_auth_codes has
 *     RLS deny-all for all authenticated users.
 *   - No Supabase Auth session is required — this endpoint is machine-to-machine.
 *
 * References:
 *   RFC 6749 §4.1.3  — Authorization Code Exchange
 *   RFC 7636         — Proof Key for Code Exchange (PKCE)
 *   Documents/Architecture/mcp-authentication-flow.md §7 (OAuth Authorize Flow)
 *   Documents/Architecture/api-key-management.md §1 (Key Format and Generation)
 */

// ── Helpers ────────────────────────────────────────────────────────────────

/** SHA-256 hex digest of a UTF-8 string. */
function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Compute the PKCE S256 code_challenge from a plain code_verifier.
 *
 * Per RFC 7636 §4.2 and §4.6:
 *   code_challenge = BASE64URL(SHA-256(ASCII(code_verifier)))
 *
 * BASE64URL uses the URL-safe alphabet (+→-, /→_) with no padding characters.
 */
function computeS256Challenge(codeVerifier: string): string {
  const hashBytes = crypto.createHash('sha256').update(codeVerifier, 'ascii').digest();
  return hashBytes
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Return a standard OAuth 2.0 error JSON response with no-cache headers.
 * All error bodies follow RFC 6749 §5.2 format: { error, error_description }.
 */
function oauthError(
  error: string,
  description: string,
  status: number = 400
): NextResponse {
  return NextResponse.json(
    { error, error_description: description },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
      },
    }
  );
}

/**
 * Parse the request body as either application/x-www-form-urlencoded or
 * application/json. Returns a plain object of string values or null on error.
 */
async function parseBody(
  request: NextRequest
): Promise<Record<string, string> | null> {
  const contentType = request.headers.get('content-type') ?? '';

  try {
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const text = await request.text();
      const params = new URLSearchParams(text);
      const result: Record<string, string> = {};
      for (const [key, value] of params.entries()) {
        result[key] = value;
      }
      return result;
    }

    // Fall back to JSON (some MCP clients send JSON bodies)
    const json = await request.json() as unknown;
    if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
        if (typeof value === 'string') {
          result[key] = value;
        }
      }
      return result;
    }

    return null;
  } catch {
    return null;
  }
}

// ── Route Handler ──────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── 1. Parse request body ──────────────────────────────────────────────
  const body = await parseBody(request);

  if (!body) {
    return oauthError(
      'invalid_request',
      'Request body must be application/x-www-form-urlencoded or application/json.'
    );
  }

  const { grant_type, code, code_verifier, client_id, redirect_uri } = body;

  // ── 2. Validate grant_type ─────────────────────────────────────────────
  if (!grant_type) {
    return oauthError('invalid_request', 'grant_type is required.');
  }
  if (grant_type !== 'authorization_code') {
    return oauthError(
      'unsupported_grant_type',
      'Only grant_type=authorization_code is supported.'
    );
  }

  // ── 3. Validate required parameters ───────────────────────────────────
  if (!code || typeof code !== 'string' || code.trim() === '') {
    return oauthError('invalid_request', 'code is required.');
  }
  if (!code_verifier || typeof code_verifier !== 'string' || code_verifier.trim() === '') {
    return oauthError('invalid_request', 'code_verifier is required (PKCE S256).');
  }
  if (!client_id || typeof client_id !== 'string' || client_id.trim() === '') {
    return oauthError('invalid_request', 'client_id is required.');
  }
  if (!redirect_uri || typeof redirect_uri !== 'string' || redirect_uri.trim() === '') {
    return oauthError('invalid_request', 'redirect_uri is required.');
  }

  // ── 4. Look up the authorization code ─────────────────────────────────
  // oauth_auth_codes has RLS deny-all; must use service-role client.
  // The query filters expired codes inline so the same "invalid_grant" error
  // is returned for both "not found" and "expired" cases — no oracle attack.
  const service = createServiceRoleClient();

  const codeHash = sha256Hex(code.trim());

  const { data: authCode, error: lookupError } = await service
    .from('oauth_auth_codes')
    .select(
      'id, client_id, workspace_id, user_id, client_name, redirect_uri, code_challenge, scopes, inbox_ids'
    )
    .eq('code_hash', codeHash)
    .eq('client_id', client_id.trim())
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (lookupError) {
    console.error('oauth_token_lookup_error', { error: lookupError.message });
    return oauthError('server_error', 'Failed to validate authorization code.', 500);
  }

  if (!authCode) {
    // Intentionally identical error for not-found, expired, and wrong client_id
    // to prevent oracle attacks distinguishing these states.
    return oauthError(
      'invalid_grant',
      'Authorization code is invalid or has expired.'
    );
  }

  // ── 5. Validate redirect_uri exact match ───────────────────────────────
  // RFC 6749 §4.1.3 requires redirect_uri to match the one used at /authorize.
  if (authCode.redirect_uri !== redirect_uri.trim()) {
    return oauthError(
      'invalid_grant',
      'redirect_uri does not match the value used when the authorization code was issued.'
    );
  }

  // ── 6. Validate PKCE code_verifier (S256) ─────────────────────────────
  // Only S256 is accepted; plain verifiers are rejected (RFC 7636 §4.6).
  // Compute BASE64URL(SHA-256(code_verifier)) and compare to stored challenge.
  const computedChallenge = computeS256Challenge(code_verifier.trim());

  // Use a constant-time comparison to avoid timing oracles on the challenge value.
  const storedChallengeBytes = Buffer.from(authCode.code_challenge, 'utf8');
  const computedChallengeBytes = Buffer.from(computedChallenge, 'utf8');

  const pkceValid =
    storedChallengeBytes.length === computedChallengeBytes.length &&
    crypto.timingSafeEqual(storedChallengeBytes, computedChallengeBytes);

  if (!pkceValid) {
    return oauthError(
      'invalid_grant',
      'PKCE code_verifier does not match the code_challenge.'
    );
  }

  // ── 7. Delete the authorization code (single-use enforcement) ─────────
  // Hard-delete immediately after validation, before issuing the key.
  // If the delete fails, we do not proceed — a second exchange attempt would
  // otherwise succeed with the same code.
  const { error: deleteError } = await service
    .from('oauth_auth_codes')
    .delete()
    .eq('id', authCode.id);

  if (deleteError) {
    console.error('oauth_token_code_delete_error', { error: deleteError.message });
    return oauthError(
      'server_error',
      'Failed to consume authorization code. Please restart the authorization flow.'
    );
  }

  // ── 8. Generate and persist the API key ───────────────────────────────
  // generateApiKey() uses crypto.randomBytes(32) — 256 bits of CSPRNG entropy.
  // Only the SHA-256 hash and display prefix are stored; rawKey is returned once.
  const { rawKey, keyHash, keyPrefix } = generateApiKey();

  const keyName = `OAuth: ${authCode.client_name}`;

  const { error: insertError } = await service.from('api_keys').insert({
    workspace_id: authCode.workspace_id,
    created_by:   authCode.user_id,
    name:         keyName,
    key_prefix:   keyPrefix,
    key_hash:     keyHash,
    scopes:       authCode.scopes,
    // null means "all active inboxes in the workspace"; a non-empty array
    // restricts access to the specific inboxes the user approved.
    inbox_ids:    authCode.inbox_ids ?? null,
  });

  if (insertError) {
    console.error('oauth_token_key_insert_error', { error: insertError.message });
    return oauthError(
      'server_error',
      'Failed to issue API key. Please restart the authorization flow.'
    );
  }

  // ── 9. Return the access token ─────────────────────────────────────────
  // rawKey is the ONLY time the plaintext key exists outside memory.
  // After this response is serialised and sent, it is unrecoverable.
  // The MCP client must store it immediately.
  return NextResponse.json(
    {
      access_token: rawKey,
      token_type:   'bearer',
      scope:        authCode.scopes.join(' '),
    },
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        Pragma:          'no-cache',
      },
    }
  );
}
