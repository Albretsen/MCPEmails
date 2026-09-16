/**
 * GET/POST /api/oauth/userinfo
 *
 * OpenID Connect UserInfo endpoint (OIDC Core 5.3), over the same access
 * tokens the MCP server accepts.
 *
 * WHY IT EXISTS. It is not for signing in: nothing in this product logs a user
 * in through us. It exists because a ChatGPT Business or Enterprise workspace
 * admin cannot restrict a connector to their own email domain unless the
 * authorization server can say, for a given token, which verified email it was
 * issued to. OpenAI's plugin portal reports the restriction as unavailable
 * until this endpoint answers, and Claude's connector flow never asks for it.
 * That is the whole scope of the feature — no ID tokens, no JWKS, no sign-in.
 *
 * WHAT IT WILL NOT DO. It returns the email ONLY when the token carries the
 * `email` or `openid` scope, which is granted only when the client asked for it
 * in the authorization request and the user went through consent. A token that
 * was minted before this existed, or for a client that never asks, gets `sub`
 * alone rather than an address it was not granted. `sub` is the user id, stable
 * across workspaces and reconnections, and is never the email.
 *
 * The bearer token is one of our own API keys (the OAuth token endpoint mints
 * an `api_keys` row per access token), so validation is the same three checks
 * the MCP server makes: the hash exists, the row is not soft-deleted, and it
 * has not expired. Access tokens live an hour, so an expired one here is
 * normal and the 401 tells the client to refresh rather than to reconnect.
 */
import { NextRequest } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { hashApiKey } from '@/lib/api-keys/generate';

// CORS: a browser-based client may call this during the OAuth flow, exactly as
// it may call the discovery documents. The response is scoped to whatever
// bearer token is presented, so there is nothing to protect with an origin.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
} as const;

/** The scopes that entitle a token to the email claims. */
const EMAIL_CLAIM_SCOPES = ['openid', 'email'];

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function unauthorized(description: string): Response {
  // RFC 6750 §3: the challenge is what tells a client whether to refresh the
  // token or start the flow again, so it carries the specific error code.
  return Response.json(
    { error: 'invalid_token', error_description: description },
    {
      status: 401,
      headers: {
        ...CORS_HEADERS,
        'WWW-Authenticate':
          `Bearer error="invalid_token", error_description="${description}"`,
        'Cache-Control': 'no-store',
      },
    },
  );
}

async function handle(req: NextRequest): Promise<Response> {
  const authorization = req.headers.get('authorization') ?? '';
  const [scheme, token] = authorization.split(' ');
  if (!token || scheme?.toLowerCase() !== 'bearer') {
    return Response.json(
      { error: 'invalid_request', error_description: 'Bearer token required.' },
      {
        status: 400,
        headers: { ...CORS_HEADERS, 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store' },
      },
    );
  }

  const service = createServiceRoleClient();
  const { data: key, error } = await service
    .from('api_keys')
    .select('created_by, scopes, expires_at, deleted_at')
    .eq('key_hash', hashApiKey(token))
    .is('deleted_at', null)
    .maybeSingle();

  if (error) {
    console.error('oauth_userinfo_lookup_error', error.message);
    return Response.json(
      { error: 'server_error' },
      { status: 500, headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' } },
    );
  }
  if (!key) return unauthorized('The access token is not valid.');
  if (key.expires_at && new Date(key.expires_at).getTime() <= Date.now()) {
    return unauthorized('The access token has expired.');
  }
  // A dashboard-issued key has no user behind it in the OIDC sense: it belongs
  // to a workspace and outlives whoever made it. Identity claims are for the
  // OAuth flow only.
  if (!key.created_by) return unauthorized('This token carries no user identity.');

  const claims: Record<string, unknown> = { sub: key.created_by };

  const scopes = key.scopes ?? [];
  if (EMAIL_CLAIM_SCOPES.some((scope) => scopes.includes(scope))) {
    const { data: account, error: accountError } = await service.auth.admin.getUserById(
      key.created_by,
    );
    if (accountError) {
      console.error('oauth_userinfo_account_error', accountError.message);
      return Response.json(
        { error: 'server_error' },
        { status: 500, headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' } },
      );
    }
    if (account?.user?.email) {
      claims.email = account.user.email;
      // Reported, never asserted. Supabase sets email_confirmed_at when the
      // address is actually confirmed, and a domain restriction that trusts an
      // unconfirmed address is worth nothing.
      claims.email_verified = Boolean(account.user.email_confirmed_at);
    }
  }

  return Response.json(claims, {
    headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store', Pragma: 'no-cache' },
  });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

/** OIDC Core 5.3.1 allows POST as well as GET; the token still comes in the header. */
export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
