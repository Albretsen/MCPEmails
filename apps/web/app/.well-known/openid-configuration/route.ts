/**
 * GET /.well-known/openid-configuration
 *
 * OpenID Connect Discovery, published for exactly one consumer: the ChatGPT
 * plugin portal, which will not let a Business or Enterprise workspace admin
 * restrict this connector to their own email domain unless the authorization
 * server advertises OIDC, a userinfo endpoint and the `openid` and `email`
 * scopes.
 *
 * It is the same authorization server as /.well-known/oauth-authorization-
 * server, built from the same function, plus the handful of OIDC-only fields.
 * What it deliberately does NOT advertise is an `id_token`: this product has
 * no sign-in of its own to federate, so it mints no ID tokens, holds no
 * signing key and publishes no JWKS. See lib/oauth/metadata.ts and the header
 * of /api/oauth/userinfo.
 *
 * No authentication required. Cached for 1 hour.
 */
import { openIdConfiguration } from '@/lib/oauth/metadata';

// Same reasoning as the RFC 8414 document: a discovery document is read
// cross-origin by browser-based clients and carries nothing user-specific.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
} as const;

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET() {
  return Response.json(openIdConfiguration(), {
    headers: {
      ...CORS_HEADERS,
      // s-maxage lets Vercel's CDN keep the document for the same hour the
      // browser already may. Safe because the body is the same for every
      // requester (the handler takes no request; see discovery-documents.test.ts).
      // Vercel strips s-maxage before the response leaves the CDN, so clients
      // still receive exactly `max-age=3600`.
      'Cache-Control': 'max-age=3600, s-maxage=3600',
    },
  });
}
