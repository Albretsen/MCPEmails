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
 *   request them up front during the authorization flow.
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
  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'https://mcpemails.com';

  return Response.json(
    {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/api/oauth/token`,
      registration_endpoint: `${base}/api/oauth/register`,
      revocation_endpoint: `${base}/api/oauth/revoke`,
      scopes_supported: [
        'read:email',
        'search:email',
        'send:email',
        'manage:folders',
        'delete:email',
        'manage:drafts',
        'manage:contacts',
        'schedule:email',
        'manage:automations',
      ],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
    },
    {
      headers: {
        ...CORS_HEADERS,
        'Cache-Control': 'max-age=3600',
      },
    }
  );
}
