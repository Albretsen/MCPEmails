/**
 * GET /.well-known/oauth-protected-resource
 *
 * RFC 8707 Protected Resource Metadata.
 *
 * MCP clients begin OAuth discovery here: they fetch this document to find
 * the authorization server(s) that can issue tokens for this resource.
 *
 * This is the first document in the discovery chain:
 *   401 on /api/mcp → fetch this document → fetch /.well-known/oauth-authorization-server
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
      resource: `${base}/api/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
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
    },
    {
      headers: {
        ...CORS_HEADERS,
        'Cache-Control': 'max-age=3600',
      },
    }
  );
}
