import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { isValidRedirectUri } from '@/lib/oauth/redirect-uri';
import { checkRateLimit } from '@/lib/rate-limit';
import type { Json } from '@/types/database.types';

/**
 * POST /api/oauth/register
 *
 * RFC 7591 Dynamic Client Registration. Allows OAuth clients to register
 * themselves without a pre-issued client_id. Dynamically registered clients
 * are capped to the minimal read/search/send scope set; manage:* access
 * requires first-party registration.
 *
 * Security controls:
 * - IP rate limiting: 10 registrations / IP / hour
 * - SSRF: all redirect_uris validated via isValidRedirectUri
 * - Scope cap: dynamic clients never get manage:* permissions
 * - Audit log: every registration recorded with IP + submitted metadata
 * - deactivated_at: malicious clients can be deactivated without losing audit trail
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const DYNAMIC_SCOPES = ['read:email', 'search:email', 'send:email'];

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';

  if (await checkRateLimit(`oauth:register:${ip}`, 10, 3_600_000)) {
    return Response.json(
      {
        error: 'rate_limit_exceeded',
        error_description: 'Too many registration requests from this IP. Try again in 1 hour.',
      },
      { status: 429, headers: { ...CORS_HEADERS, 'Retry-After': '3600' } }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: 'invalid_client_metadata', error_description: 'Request body must be valid JSON.' },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json(
      { error: 'invalid_client_metadata', error_description: 'Request body must be a JSON object.' },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const raw = body as Record<string, unknown>;

  // client_name: optional, truncated to 80 chars
  const clientName =
    typeof raw['client_name'] === 'string' && raw['client_name'].trim()
      ? raw['client_name'].trim().slice(0, 80)
      : 'Dynamic Client';

  // redirect_uris: required non-empty array of strings
  const redirectUris = Array.isArray(raw['redirect_uris'])
    ? (raw['redirect_uris'] as unknown[]).filter((u): u is string => typeof u === 'string')
    : [];

  if (redirectUris.length === 0) {
    return Response.json(
      {
        error: 'invalid_client_metadata',
        error_description: 'redirect_uris is required and must be a non-empty array of strings.',
      },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  // SSRF: validate every redirect URI before storing
  for (const uri of redirectUris) {
    const safe = await isValidRedirectUri(uri);
    if (!safe) {
      return Response.json(
        {
          error: 'invalid_redirect_uri',
          error_description: `Redirect URI is not allowed. Use HTTPS or a custom scheme; private IP ranges are blocked.`,
        },
        { status: 400, headers: CORS_HEADERS }
      );
    }
  }

  const clientUri =
    typeof raw['client_uri'] === 'string' ? raw['client_uri'].trim().slice(0, 255) : null;

  // Generate a unique dynamic client_id: dyn_ + 24 hex chars (96 bits of entropy)
  const clientId = `dyn_${crypto.randomBytes(12).toString('hex')}`;

  const service = createServiceRoleClient();

  const { error: insertErr } = await service.from('oauth_clients').insert({
    client_id:      clientId,
    client_name:    clientName,
    client_byline:  clientUri ?? '',
    redirect_uris:  redirectUris,
    scopes_allowed: DYNAMIC_SCOPES,
    is_first_party: false,
  });

  if (insertErr) {
    console.error('oauth_register_insert_error', insertErr.message);
    return Response.json(
      { error: 'server_error', error_description: 'Failed to register client. Try again.' },
      { status: 500, headers: CORS_HEADERS }
    );
  }

  const logMeta: Json = {
    client_id:     clientId,
    client_name:   clientName,
    redirect_uris: redirectUris,
  };
  void service.from('auth_logs').insert({
    event_type: 'oauth_client_registered',
    metadata:   logMeta,
    ip_address: ip,
    user_agent: req.headers.get('user-agent') ?? null,
  });

  return Response.json(
    {
      client_id:                  clientId,
      client_name:                clientName,
      redirect_uris:              redirectUris,
      grant_types:                ['authorization_code', 'refresh_token'],
      response_types:             ['code'],
      token_endpoint_auth_method: 'none',
      scope:                      DYNAMIC_SCOPES.join(' '),
      ...(clientUri ? { client_uri: clientUri } : {}),
    },
    { status: 201, headers: CORS_HEADERS }
  );
}
