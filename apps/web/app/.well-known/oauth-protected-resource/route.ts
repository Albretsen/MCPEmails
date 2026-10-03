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
import { canonicalResource, oauthIssuerBase } from '@/lib/oauth/resource';

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
  const base = oauthIssuerBase();

  return Response.json(
    {
      // The single resource this AS issues tokens for. The same helper backs
      // RFC 8707 `resource` validation on /authorize and /api/oauth/token.
      resource: canonicalResource(),
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
        // s-maxage lets Vercel's CDN keep the document for the same hour the
        // browser already may. Safe because the body is the same for every
        // requester (the handler takes no request; see discovery-documents.test.ts).
        // Vercel strips s-maxage before the response leaves the CDN, so clients
        // still receive exactly `max-age=3600`.
        'Cache-Control': 'max-age=3600, s-maxage=3600',
      },
    }
  );
}
