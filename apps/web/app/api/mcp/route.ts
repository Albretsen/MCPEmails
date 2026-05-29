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
 *
 * API key via query parameter:
 *   As a simpler alternative to OAuth, the API key may be supplied in the URL
 *   as ?key=mcpe_... (mcpemails.com/api/mcp?key=mcpe_...). This lets users paste
 *   a single URL into any MCP client instead of configuring an auth header. The
 *   key is converted into a Bearer header before forwarding upstream, so the
 *   Edge Function's auth contract is unchanged. An Authorization header, when
 *   present, always takes precedence over the query parameter.
 */

const MCP_FUNCTION_URL =
  'https://swvaxorwumispmjaaszb.supabase.co/functions/v1/mcp-server';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://mcpemails.com';

const WWW_AUTHENTICATE =
  `Bearer realm="MCP Emails", resource_metadata="${APP_URL}/.well-known/oauth-protected-resource"`;

export async function POST(request: NextRequest): Promise<NextResponse> {
  // An explicit Authorization header (e.g. an OAuth access token) always wins.
  // Otherwise, accept the API key from the ?key= (or ?api_key=) query parameter
  // and turn it into a Bearer header so the upstream auth path is identical.
  let authorization = request.headers.get('authorization');
  if (!authorization) {
    const queryKey =
      request.nextUrl.searchParams.get('key') ??
      request.nextUrl.searchParams.get('api_key');
    if (queryKey) {
      authorization = `Bearer ${queryKey.trim()}`;
    }
  }

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

  const responseHeaders: Record<string, string> = {
    'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
  };

  // If the upstream rejects the token, add the discovery header so the client
  // can re-initiate the OAuth flow rather than showing a generic 401 error.
  if (upstream.status === 401) {
    responseHeaders['WWW-Authenticate'] = WWW_AUTHENTICATE;
  }

  // 204 No Content: Fetch spec forbids a body on this status. Return before
  // calling upstream.text() to avoid "Invalid response status code 204".
  if (upstream.status === 204) {
    return new NextResponse(null, { status: 204, headers: responseHeaders });
  }

  const responseBody = await upstream.text();

  return new NextResponse(responseBody, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
