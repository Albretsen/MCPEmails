/**
 * GET /.well-known/oauth-authorization-server
 *
 * RFC 8414 Authorization Server Metadata.
 *
 * MCP clients fetch this after reading the Protected Resource Metadata to
 * discover all endpoints needed for the OAuth 2.0 Authorization Code + PKCE
 * flow: authorization, token exchange, dynamic registration, and revocation.
 *
 * Key properties:
 * - Only S256 PKCE is supported; "plain" is intentionally omitted.
 * - Only public clients (token_endpoint_auth_method: "none") are supported.
 * - All scopes the MCP server enforces are advertised here so clients can
 *   request them up front during the authorization flow, plus the two OIDC
 *   identity scopes (`openid`, `email`) that grant no mailbox access and only
 *   unlock the claims at `userinfo_endpoint`. See that route for why a
 *   product with no sign-in of its own publishes a userinfo endpoint.
 * - There is no `id_token`: the claims are served from the userinfo endpoint
 *   only, so there is no signing key and no JWKS to rotate. Nothing that
 *   consumes this metadata has asked for one.
 * - Both client identification schemes are advertised, and the client picks:
 *   `registration_endpoint` for RFC 7591 Dynamic Client Registration, and
 *   `client_id_metadata_document_supported` for a client_id that is itself an
 *   HTTPS URL (draft-ietf-oauth-client-id-metadata-document). Claude only
 *   selects CIMD when it sees that flag AND "none" in
 *   token_endpoint_auth_methods_supported, since its CIMD client authenticates
 *   as a public client, so the pair below is the switch. The registration
 *   endpoint stays because every client that already registered through it
 *   keeps working, and clients that do not implement CIMD still need it.
 *
 * No authentication required. Cached for 1 hour.
 */
import { authorizationServerMetadata } from '@/lib/oauth/metadata';

// CORS — discovery documents must be readable cross-origin by browser-based
// MCP clients during the OAuth flow. Unauthenticated, no cookies → wildcard.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
} as const;

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET() {
  // The document itself lives in lib/oauth/metadata.ts, shared with
  // /.well-known/openid-configuration so the two cannot drift apart.
  return Response.json(authorizationServerMetadata(), {
    headers: {
      ...CORS_HEADERS,
      'Cache-Control': 'max-age=3600',
    },
  });
}
