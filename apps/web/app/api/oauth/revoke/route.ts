import { NextRequest } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { sha256hex } from '@/lib/oauth/crypto';
import { hashApiKey } from '@/lib/api-keys/generate';
import type { Json } from '@/types/database.types';

/**
 * POST /api/oauth/revoke
 *
 * RFC 7009 Token Revocation. Accepts access tokens (mcpe_) and refresh tokens
 * (mcpr_). Per spec, always returns 200 regardless of whether the token existed.
 *
 * Access tokens: soft-deleted via api_keys.deleted_at
 * Refresh tokens: revoked via oauth_refresh_tokens.revoked_at
 *
 * Security:
 * - Origin header checked against an allowlist (CSRF defense-in-depth).
 *   Server-to-server calls (no Origin header) are always allowed.
 * - Token value is the primary CSRF defense: attacker needs the token to revoke it.
 */

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? '';

const ALLOWED_ORIGINS = new Set([
  APP_URL,
  'https://claude.ai',
  'https://platform.anthropic.com',
]);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

async function logRevocation(req: NextRequest, meta: Json): Promise<void> {
  try {
    const service = createServiceRoleClient();
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null;
    await service.from('auth_logs').insert({
      event_type: 'oauth_token_revoked',
      metadata:   meta,
      ip_address: ip,
      user_agent: req.headers.get('user-agent') ?? null,
    });
  } catch {
    // Non-fatal; never let logging block the 200 response.
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  // Origin validation: defense-in-depth against CSRF.
  // No Origin header (server-to-server calls) is always allowed.
  const origin = req.headers.get('origin');
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return new Response(null, { status: 403 });
  }

  // Parse body: accept application/x-www-form-urlencoded or JSON
  let token: string | null = null;
  let tokenTypeHint: string | null = null;

  const ct = req.headers.get('content-type') ?? '';
  try {
    if (ct.includes('application/x-www-form-urlencoded')) {
      const params = new URLSearchParams(await req.text());
      token = params.get('token');
      tokenTypeHint = params.get('token_type_hint');
    } else {
      const json = (await req.json()) as Record<string, unknown>;
      token = typeof json['token'] === 'string' ? json['token'] : null;
      tokenTypeHint =
        typeof json['token_type_hint'] === 'string' ? json['token_type_hint'] : null;
    }
  } catch {
    // RFC 7009 §2.2: always 200 — if we can't parse it, the token is already invalid.
    return new Response(null, { status: 200, headers: CORS_HEADERS });
  }

  // RFC 7009 §2.2: missing token → still 200 (client's goal is achieved)
  if (!token) {
    return new Response(null, { status: 200, headers: CORS_HEADERS });
  }

  const service = createServiceRoleClient();
  const now = new Date().toISOString();

  // Use the token prefix to route efficiently; fall back to trying both if unknown.
  const looksLikeAccess = token.startsWith('mcpe_');
  const looksLikeRefresh = token.startsWith('mcpr_');

  if (tokenTypeHint === 'refresh_token' || looksLikeRefresh) {
    // ── Revoke refresh token ───────────────────────────────────────────────────
    const refreshHash = sha256hex(token);
    const { data } = await service
      .from('oauth_refresh_tokens')
      .update({ revoked_at: now })
      .eq('refresh_hash', refreshHash)
      .is('revoked_at', null)
      .select('client_id, workspace_id');

    if (data && data.length > 0) {
      void logRevocation(req, {
        token_type:   'refresh_token',
        client_id:    data[0].client_id,
        workspace_id: data[0].workspace_id,
      } as Json);
    }
  } else if (tokenTypeHint === 'access_token' || looksLikeAccess) {
    // ── Revoke access token ────────────────────────────────────────────────────
    const keyHash = hashApiKey(token);
    const { data } = await service
      .from('api_keys')
      .update({ deleted_at: now })
      .eq('key_hash', keyHash)
      .is('deleted_at', null)
      .select('key_prefix, workspace_id');

    if (data && data.length > 0) {
      void logRevocation(req, {
        token_type:   'access_token',
        key_prefix:   data[0].key_prefix,
        workspace_id: data[0].workspace_id,
      } as Json);
    }
  } else {
    // Unknown prefix and no hint: try both per RFC 7009 §2.1 (server should
    // search across all supported token types when no hint is given).
    const keyHash = hashApiKey(token);
    await service
      .from('api_keys')
      .update({ deleted_at: now })
      .eq('key_hash', keyHash)
      .is('deleted_at', null);

    const refreshHash = sha256hex(token);
    await service
      .from('oauth_refresh_tokens')
      .update({ revoked_at: now })
      .eq('refresh_hash', refreshHash)
      .is('revoked_at', null);
  }

  // RFC 7009 §2.2: always 200, even if the token was not found.
  return new Response(null, { status: 200, headers: CORS_HEADERS });
}
