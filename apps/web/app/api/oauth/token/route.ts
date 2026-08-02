import { NextRequest } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { generateApiKey } from '@/lib/api-keys/generate';
import { getActiveApiKeyNames, disambiguateApiKeyName } from '@/lib/api-keys/unique-name';
import { recordProductFunnelEvent } from '@/lib/analytics/product-funnel';
import { sha256hex, computeS256Challenge, generateRefreshToken } from '@/lib/oauth/crypto';
import { oauthError } from '@/lib/oauth/errors';
import { checkRateLimit } from '@/lib/rate-limit';
import type { Json } from '@/types/database.types';

/**
 * POST /api/oauth/token
 *
 * Exchanges an authorization code or refresh token for an access token.
 * Implements RFC 6749 §4.1.3 (authorization_code) and §6 (refresh_token).
 * PKCE S256 is mandatory for authorization_code (RFC 7636).
 *
 * Access tokens are short-lived mcpe_ API keys (1 hour).
 * Refresh tokens are mcpr_ values stored as SHA-256 hashes in oauth_refresh_tokens.
 * Refresh token rotation is enforced: each refresh issues a new pair and revokes the old one.
 *
 * Machine-to-machine: no user session required. Service-role client throughout.
 */

// ── CORS ─────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// ── Body parsing ──────────────────────────────────────────────────────────────

async function parseBody(req: NextRequest): Promise<Record<string, string> | null> {
  const ct = req.headers.get('content-type') ?? '';
  try {
    if (ct.includes('application/x-www-form-urlencoded')) {
      const params = new URLSearchParams(await req.text());
      return Object.fromEntries(params.entries());
    }
    const json = await req.json() as unknown;
    if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Audit logging ─────────────────────────────────────────────────────────────

async function logEvent(
  req: NextRequest,
  eventType: string,
  meta: Json
): Promise<void> {
  try {
    const service = createServiceRoleClient();
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null;
    await service.from('auth_logs').insert({
      event_type: eventType,
      metadata: meta,
      ip_address: ip,
      user_agent: req.headers.get('user-agent') ?? null,
    });
  } catch {
    // Non-fatal; never let logging break the token response.
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';
  if (await checkRateLimit(`oauth:token:${ip}`, 10, 60_000)) {
    return oauthError('access_denied', 'Too many requests.', 429, { 'Retry-After': '60' });
  }

  const body = await parseBody(req);
  if (!body) {
    return oauthError('invalid_request', 'Body must be application/x-www-form-urlencoded or JSON.');
  }

  const grantType = body['grant_type'];
  const clientId  = body['client_id']?.trim() ?? '';

  if (!grantType) return oauthError('invalid_request', 'grant_type is required.');
  if (!clientId)  return oauthError('invalid_request', 'client_id is required.');

  const service = createServiceRoleClient();

  // ── Client status check ────────────────────────────────────────────────────
  // Re-verify the client hasn't been deactivated between authorization and token exchange.
  const { data: oauthClient } = await service
    .from('oauth_clients')
    .select('deactivated_at')
    .eq('client_id', clientId)
    .maybeSingle();

  if (!oauthClient || oauthClient.deactivated_at) {
    return oauthError('invalid_client', 'Unknown or deactivated application.');
  }

  // ── Authorization Code grant ────────────────────────────────────────────────

  if (grantType === 'authorization_code') {
    const code         = body['code']?.trim() ?? '';
    const codeVerifier = body['code_verifier']?.trim() ?? '';
    const redirectUri  = body['redirect_uri']?.trim() ?? '';

    if (!code)         return oauthError('invalid_request', 'code is required.');
    if (!codeVerifier) return oauthError('invalid_request', 'code_verifier is required (PKCE S256).');
    if (!redirectUri)  return oauthError('invalid_request', 'redirect_uri is required.');

    const codeHash = sha256hex(code);

    const { data: authCode, error: lookupErr } = await service
      .from('oauth_auth_codes')
      .select('id, client_id, workspace_id, user_id, client_name, redirect_uri, code_challenge, code_challenge_method, scopes, inbox_ids')
      .eq('code_hash', codeHash)
      .eq('client_id', clientId)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (lookupErr) {
      console.error('oauth_token_lookup_error', lookupErr.message);
      return oauthError('server_error', 'Failed to validate authorization code.', 500);
    }
    if (!authCode) {
      return oauthError('invalid_grant', 'Authorization code is invalid or has expired.');
    }

    // redirect_uri exact match (RFC 6749 §4.1.3)
    if (authCode.redirect_uri !== redirectUri) {
      return oauthError('invalid_grant', 'redirect_uri does not match the code.');
    }

    // Re-enforce S256 from stored method (never trust the incoming request for this)
    if (authCode.code_challenge_method !== 'S256') {
      return oauthError('invalid_grant', 'Only S256 PKCE is supported.');
    }

    // PKCE verification: BASE64URL(SHA-256(code_verifier)) must equal stored challenge
    const computedChallenge = computeS256Challenge(codeVerifier);
    if (computedChallenge !== authCode.code_challenge) {
      return oauthError('invalid_grant', 'PKCE code_verifier does not match the code_challenge.');
    }

    // Single-use: hard-delete before issuing token (prevents replay even if insert fails)
    const { error: deleteErr } = await service
      .from('oauth_auth_codes')
      .delete()
      .eq('id', authCode.id);

    if (deleteErr) {
      console.error('oauth_token_code_delete_error', deleteErr.message);
      return oauthError('server_error', 'Failed to consume authorization code. Restart the flow.');
    }

    // Issue 1-hour access token. This single api_keys row is the durable
    // identity of the connection: every later refresh rotates it in place
    // (see the refresh_token grant) rather than inserting a new row.
    const { rawKey, keyHash, keyPrefix } = generateApiKey();
    const accessExpiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

    // Keep OAuth-issued key names distinguishable in the audit log: when the
    // same client is authorized more than once, suffix " (2)", " (3)", … rather
    // than minting another indistinguishable "OAuth: <client>" row.
    const existingNames = await getActiveApiKeyNames(service, authCode.workspace_id);
    const keyName = disambiguateApiKeyName(existingNames, `OAuth: ${authCode.client_name}`);

    const { data: keyRow, error: keyInsertErr } = await service
      .from('api_keys')
      .insert({
        workspace_id: authCode.workspace_id,
        created_by:   authCode.user_id,
        name:         keyName,
        key_prefix:   keyPrefix,
        key_hash:     keyHash,
        scopes:       authCode.scopes,
        inbox_ids:    authCode.inbox_ids ?? null,
        expires_at:   accessExpiresAt,
      })
      .select('id')
      .single();

    if (keyInsertErr || !keyRow) {
      console.error('oauth_token_key_insert_error', keyInsertErr?.message);
      return oauthError('server_error', 'Failed to issue access token. Restart the flow.');
    }

    // Issue refresh token, linked to the access-token row above. Sliding
    // 180-day window: as long as the client keeps refreshing, the connection
    // never expires; only 6 continuous months of inactivity ends it.
    const refreshToken = generateRefreshToken();
    const refreshHash  = sha256hex(refreshToken);
    const refreshExpiresAt = new Date(Date.now() + 180 * 24 * 3600 * 1000).toISOString();

    await service.from('oauth_refresh_tokens').insert({
      refresh_hash: refreshHash,
      client_id:    clientId,
      workspace_id: authCode.workspace_id,
      user_id:      authCode.user_id,
      client_name:  authCode.client_name,
      scopes:       authCode.scopes,
      inbox_ids:    authCode.inbox_ids ?? null,
      expires_at:   refreshExpiresAt,
      api_key_id:   keyRow.id,
    });

    await recordProductFunnelEvent(service, { workspaceId: authCode.workspace_id, stage: 'credential_created', outcome: 'success', category: 'oauth' });

    void logEvent(req, 'oauth_token_issued', {
      client_id:  clientId,
      key_prefix: keyPrefix,
      scopes:     authCode.scopes,
      workspace_id: authCode.workspace_id,
    });

    return Response.json(
      {
        access_token:  rawKey,
        token_type:    'bearer',
        expires_in:    3600,
        refresh_token: refreshToken,
        scope:         authCode.scopes.join(' '),
      },
      { headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store', Pragma: 'no-cache' } }
    );
  }

  // ── Refresh Token grant ─────────────────────────────────────────────────────

  if (grantType === 'refresh_token') {
    const refreshToken = body['refresh_token']?.trim() ?? '';
    if (!refreshToken) return oauthError('invalid_request', 'refresh_token is required.');

    const refreshHash = sha256hex(refreshToken);

    const { data: rt, error: rtLookupErr } = await service
      .from('oauth_refresh_tokens')
      .select('id, client_id, workspace_id, user_id, client_name, scopes, inbox_ids, expires_at, api_key_id')
      .eq('refresh_hash', refreshHash)
      .eq('client_id', clientId)
      .is('revoked_at', null)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (rtLookupErr) {
      console.error('oauth_refresh_lookup_error', rtLookupErr.message);
      return oauthError('server_error', 'Failed to validate refresh token.', 500);
    }
    if (!rt) {
      return oauthError('invalid_grant', 'Refresh token is invalid, revoked, or expired.');
    }

    // Crash-safe rotation: we mint the new pair and persist the new refresh
    // token FIRST, then rotate the access token in place, and only revoke the
    // old refresh token last. If any earlier step fails, the old refresh token
    // is still valid, so the client can simply retry; the connection never
    // ends up in a state where it holds a token the server doesn't recognise.
    const { rawKey, keyHash, keyPrefix } = generateApiKey();
    const accessExpiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

    const newRefreshToken = generateRefreshToken();
    const newRefreshHash  = sha256hex(newRefreshToken);
    // Sliding window: each refresh pushes the idle deadline 180 days out, so an
    // actively-used connection stays open indefinitely.
    const newRefreshExpiresAt = new Date(Date.now() + 180 * 24 * 3600 * 1000).toISOString();

    const { data: newRtRow, error: newRtErr } = await service
      .from('oauth_refresh_tokens')
      .insert({
        refresh_hash: newRefreshHash,
        client_id:    clientId,
        workspace_id: rt.workspace_id,
        user_id:      rt.user_id,
        client_name:  rt.client_name,
        scopes:       rt.scopes,
        inbox_ids:    rt.inbox_ids ?? null,
        expires_at:   newRefreshExpiresAt,
        api_key_id:   rt.api_key_id,
      })
      .select('id')
      .single();

    if (newRtErr || !newRtRow) {
      console.error('oauth_refresh_insert_error', newRtErr?.message);
      return oauthError('server_error', 'Failed to rotate refresh token. Try again.');
    }

    // Rotate the access token. Normally this updates the connection's existing
    // api_keys row in place (one row per connection, no dashboard flooding).
    // The deleted_at guard means a connection revoked from the dashboard can
    // NOT be silently resurrected here.
    if (rt.api_key_id) {
      const { data: rotated, error: rotateErr } = await service
        .from('api_keys')
        .update({ key_hash: keyHash, key_prefix: keyPrefix, expires_at: accessExpiresAt })
        .eq('id', rt.api_key_id)
        .is('deleted_at', null)
        .select('id');

      if (rotateErr) {
        console.error('oauth_refresh_key_rotate_error', rotateErr.message);
        await service.from('oauth_refresh_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', newRtRow.id);
        return oauthError('server_error', 'Failed to issue access token. Try again.');
      }
      if (!rotated || rotated.length === 0) {
        // The api_keys row was revoked/deleted: the connection is gone. Roll
        // back the refresh token we just issued and reject.
        await service.from('oauth_refresh_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', newRtRow.id);
        return oauthError('invalid_grant', 'This connection has been revoked.');
      }
    } else {
      // Legacy refresh token (issued before connections were linked to a single
      // api_keys row): create the row now and point this chain at it so all
      // future refreshes rotate in place.
      const legacyExistingNames = await getActiveApiKeyNames(service, rt.workspace_id);
      const legacyKeyName = disambiguateApiKeyName(legacyExistingNames, `OAuth: ${rt.client_name}`);
      const { data: keyRow, error: keyInsertErr } = await service
        .from('api_keys')
        .insert({
          workspace_id: rt.workspace_id,
          created_by:   rt.user_id,
          name:         legacyKeyName,
          key_prefix:   keyPrefix,
          key_hash:     keyHash,
          scopes:       rt.scopes,
          inbox_ids:    rt.inbox_ids ?? null,
          expires_at:   accessExpiresAt,
        })
        .select('id')
        .single();

      if (keyInsertErr || !keyRow) {
        console.error('oauth_refresh_key_insert_error', keyInsertErr?.message);
        await service.from('oauth_refresh_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', newRtRow.id);
        return oauthError('server_error', 'Failed to issue access token. Try again.');
      }

      await service.from('oauth_refresh_tokens').update({ api_key_id: keyRow.id }).eq('id', newRtRow.id);
    }

    // Success: revoke the old refresh token (rotation complete).
    const { error: revokeErr } = await service
      .from('oauth_refresh_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', rt.id);

    if (revokeErr) {
      // Non-fatal: the new token is already valid and returned below. A
      // lingering old token expires on its own; worst case it is usable once.
      console.warn('oauth_refresh_old_revoke_failed', revokeErr.message);
    }

    void logEvent(req, 'oauth_token_refreshed', {
      client_id:  clientId,
      key_prefix: keyPrefix,
      scopes:     rt.scopes,
      workspace_id: rt.workspace_id,
    });

    return Response.json(
      {
        access_token:  rawKey,
        token_type:    'bearer',
        expires_in:    3600,
        refresh_token: newRefreshToken,
        scope:         rt.scopes.join(' '),
      },
      { headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store', Pragma: 'no-cache' } }
    );
  }

  return oauthError('unsupported_grant_type', `grant_type "${grantType}" is not supported.`);
}
