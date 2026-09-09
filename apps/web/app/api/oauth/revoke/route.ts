import { NextRequest } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { loggableClientId, revokeGrantByToken } from '@/lib/oauth/revocation';
import type { Json } from '@/types/database.types';

/**
 * POST /api/oauth/revoke
 *
 * RFC 7009 Token Revocation. Accepts an access token (mcpe_) or a refresh
 * token (mcpr_), with or without `token_type_hint`, and revokes the WHOLE
 * grant either way: the api_keys row AND every live row of the refresh chain
 * bound to it. The two-row shape of a connection, and why revoking one half is
 * not revocation, is the header of src/lib/oauth/revocation.ts.
 *
 * ALWAYS 200. Per §2.2 an unknown, malformed or already-revoked token is
 * indistinguishable from a successful revocation, so this endpoint cannot be
 * used as an oracle for whether a token is valid. Only a bad Origin is
 * answered differently, and that decision is made before the token is read.
 *
 * ── No client authentication ────────────────────────────────────────────────
 *
 * Our authorization server advertises `token_endpoint_auth_methods_supported:
 * ["none"]`: every client here is a PUBLIC client and has no secret to
 * present. RFC 7009 §2.1 allows a server to require client authentication, and
 * requiring it would mean rejecting every revocation any of our clients could
 * ever make. So possession of the token IS the authorisation, which is the
 * same standard the rest of this server holds a bearer token to.
 *
 * `client_id`, when a client sends one, is read for the audit log and NOT used
 * as a filter. A mismatch must never turn revocation into a silent no-op: the
 * failure mode we are guarding against is a live credential surviving a
 * disconnect, and "the client spelled its own id differently this time" is not
 * a reason to keep somebody's mailbox open. It is normalised on the way into
 * the log because a CIMD client_id is an HTTPS URL
 * (draft-ietf-oauth-client-id-metadata-document), not a `dyn_` id, and the
 * same client can spell that URL more than one way.
 *
 * Security:
 * - Origin header checked against an allowlist (CSRF defense-in-depth).
 *   Server-to-server calls (no Origin header) are always allowed, and that is
 *   the path every real client takes: claude.ai revokes from its backend.
 * - Token value is the primary defence: an attacker needs the token to revoke it.
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
  let clientId: string | null = null;

  const ct = req.headers.get('content-type') ?? '';
  try {
    if (ct.includes('application/x-www-form-urlencoded')) {
      const params = new URLSearchParams(await req.text());
      token = params.get('token');
      tokenTypeHint = params.get('token_type_hint');
      clientId = params.get('client_id');
    } else {
      const json = (await req.json()) as Record<string, unknown>;
      token = typeof json['token'] === 'string' ? json['token'] : null;
      tokenTypeHint =
        typeof json['token_type_hint'] === 'string' ? json['token_type_hint'] : null;
      clientId = typeof json['client_id'] === 'string' ? json['client_id'] : null;
    }
  } catch {
    // RFC 7009 §2.2: always 200. If we can't parse it, the token is already invalid.
    return new Response(null, { status: 200, headers: CORS_HEADERS });
  }

  // RFC 7009 §2.2: missing token → still 200 (client's goal is achieved)
  if (!token) {
    return new Response(null, { status: 200, headers: CORS_HEADERS });
  }

  const service = createServiceRoleClient();
  const outcome = await revokeGrantByToken(service, { token, tokenTypeHint });

  // Only a call that actually ended something is worth a log line. A scanner
  // POSTing garbage must not be able to fill auth_logs.
  if (outcome.revoked) {
    void logRevocation(req, {
      token_type:    outcome.matchedAs,
      presented_as:  tokenTypeHint,
      api_key_id:    outcome.apiKeyId,
      key_prefix:    outcome.keyPrefix,
      client_id:     loggableClientId(clientId) ?? outcome.clientId,
      workspace_id:  outcome.workspaceId,
      access_tokens_revoked:  outcome.accessTokensRevoked,
      refresh_tokens_revoked: outcome.refreshTokensRevoked,
    } as Json);
  }

  // RFC 7009 §2.2: always 200, even if the token was not found.
  return new Response(null, { status: 200, headers: CORS_HEADERS });
}
