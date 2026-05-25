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
export async function GET() {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'https://mcpemails.com';

  return Response.json(
    {
      resource: `${base}/api/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
      scopes_supported: ['read:email', 'search:email', 'send:email'],
    },
    {
      headers: {
        'Cache-Control': 'max-age=3600',
      },
    }
  );
}
