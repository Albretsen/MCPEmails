import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/mcp
 *
 * Transparent proxy to the MCP server Supabase Edge Function.
 *
 * Clients (Claude Desktop, Claude Code CLI) send JSON-RPC requests to this
 * endpoint with a Bearer token in the Authorization header. This handler
 * forwards the request body and Authorization header to the Edge Function
 * and streams the response back unchanged.
 *
 * Using this proxy instead of the raw Supabase URL gives us:
 *   - A stable, branded URL (mcpemails.com/api/mcp)
 *   - No dependency on Supabase custom domain configuration
 *   - The ability to add request logging or rate-limiting at the edge later
 *
 * OAuth 2.0 discovery (RFC 8707):
 *   When a request arrives with no bearer token, or the upstream returns 401,
 *   the response includes WWW-Authenticate with a resource_metadata pointer.
 *   MCP clients use this to auto-discover the authorization server and begin
 *   the OAuth 2.0 Authorization Code + PKCE flow.
 */

const MCP_FUNCTION_URL =
  'https://swvaxorwumispmjaaszb.supabase.co/functions/v1/mcp-server';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://mcpemails.com';

const WWW_AUTHENTICATE =
  `Bearer realm="MCP Emails", resource_metadata="${APP_URL}/.well-known/oauth-protected-resource"`;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authorization = request.headers.get('authorization');

  // Return 401 immediately for requests with no bearer token so MCP clients
  // can begin OAuth discovery without forwarding an empty request upstream.
  if (!authorization) {
    return new NextResponse(
      JSON.stringify({ error: 'unauthorized', error_description: 'Bearer token required.' }),
      {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': WWW_AUTHENTICATE,
        },
      }
    );
  }

  const body = await request.text();
  const contentType = request.headers.get('content-type') ?? 'application/json';

  const upstream = await fetch(MCP_FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      Authorization: authorization,
    },
    body,
  });

  const responseBody = await upstream.text();

  const responseHeaders: Record<string, string> = {
    'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
  };

  // If the upstream rejects the token, add the discovery header so the client
  // can re-initiate the OAuth flow rather than showing a generic 401 error.
  if (upstream.status === 401) {
    responseHeaders['WWW-Authenticate'] = WWW_AUTHENTICATE;
  }

  return new NextResponse(responseBody, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
