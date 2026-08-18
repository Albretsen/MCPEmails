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
 * API keys may be sent in the Authorization header or, for backwards
 * compatibility with existing integrations, as a `key` or `api_key` query
 * parameter. Prefer the Authorization header: URL credentials can be retained
 * in browser history, logs, referrers, and monitoring systems.
 */

const MCP_FUNCTION_URL =
  'https://swvaxorwumispmjaaszb.supabase.co/functions/v1/mcp-server';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://mcpemails.com';

const WWW_AUTHENTICATE =
  `Bearer realm="MCP Emails", resource_metadata="${APP_URL}/.well-known/oauth-protected-resource"`;

// CORS — allow browser-based MCP clients (e.g. claude.ai) to call this endpoint
// cross-origin. Auth is via the Authorization header (no cookies), so a wildcard
// origin is safe. WWW-Authenticate is exposed so clients can read the OAuth
// discovery pointer on a 401; MCP session/protocol headers are allowed/exposed.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, MCP-Protocol-Version, Mcp-Session-Id',
} as const;

// Vercel kills the function itself once the platform duration limit is reached,
// and that kill produces the same opaque 500 we are trying to eliminate. Giving
// fetch its own deadline slightly under the platform limit means we, not the
// platform, decide what the client sees when the upstream never answers.
//
// The ceiling cannot be tightened much: real, successful operations are slow.
// Production has observed email_organize search_and_move runs of ~152 seconds
// against large mailboxes, so anything near the two-minute mark would convert
// working (if slow) calls into failures. 270 seconds leaves those calls intact
// while still reserving headroom to serialise a response before the platform
// pulls the plug.
const UPSTREAM_TIMEOUT_MS = 270_000;

// JSON-RPC 2.0 reserves -32000 to -32099 for implementation-defined server
// errors. We use one of those for the timeout so a client can tell "the
// upstream never answered in time, retrying later may work" apart from the
// generic -32603 Internal error we return for a severed connection.
const JSONRPC_INTERNAL_ERROR = -32603;
const JSONRPC_UPSTREAM_TIMEOUT = -32001;

/**
 * Recover the JSON-RPC `id` from a request body we were unable to proxy.
 *
 * A JSON-RPC error response is only useful to the caller if it carries the id
 * of the request that failed: MCP clients match responses to in-flight calls by
 * id, and an unmatched response is silently dropped, leaving the client hanging
 * until its own timeout. The body has already been read as text by the time we
 * need this, so parsing it costs nothing extra.
 *
 * Anything we cannot confidently identify becomes `null`, which the spec
 * explicitly allows for errors detected before the id could be determined.
 * Batch requests (a top-level array) have no single id, so they fall back too.
 */
function recoverRequestId(body: string): string | number | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const id = (parsed as { id?: unknown }).id;
      if (typeof id === 'string' || typeof id === 'number') return id;
    }
  } catch {
    // A body that is not valid JSON cannot carry an id. Fall through to null.
  }
  return null;
}

/**
 * Distinguish "we gave up waiting" from every other transport failure.
 *
 * AbortSignal.timeout rejects with a DOMException named TimeoutError, but undici
 * does not always surface it at the top level: when the abort lands mid-request
 * the rejection can arrive as a TypeError whose `cause` is the original abort
 * reason. Checking both levels keeps a genuine timeout from being misreported as
 * a connection failure, which would send the client a misleading 502.
 */
function isTimeoutError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  const cause = (error as { cause?: unknown } | null)?.cause;
  const causeName = (cause as { name?: unknown } | null)?.name;
  return causeName === 'TimeoutError' || causeName === 'AbortError';
}

// Route segment config, NOT vercel.json. The repo-root vercel.json is not read
// for this project: the Vercel project's rootDirectory is apps/web, so Vercel
// looks for apps/web/vercel.json, which does not exist. Its "functions" block
// (and its headers) are therefore inert, which is why the duration has to be
// declared here, the same way app/api/stripe/webhook/route.ts already does it.
//
// This must stay above UPSTREAM_TIMEOUT_MS: if the platform kills the function
// first, we lose the ability to return the structured error below and the
// caller sees exactly the opaque 500 this handler exists to prevent.
export const maxDuration = 300;

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const queryKey =
    request.nextUrl.searchParams.get('key') ??
    request.nextUrl.searchParams.get('api_key');
  const headerAuthorization = request.headers.get('authorization');
  // Keep headers authoritative when both mechanisms are supplied. Query-string
  // support is only for legacy clients that cannot set request headers.
  const authorization = headerAuthorization ??
    (queryKey ? `Bearer ${queryKey}` : null);

  // Return 401 immediately for requests with no bearer token so MCP clients
  // can begin OAuth discovery without forwarding an empty request upstream.
  if (!authorization) {
    return new NextResponse(
      JSON.stringify({ error: 'unauthorized', error_description: 'Bearer token required.' }),
      {
        status: 401,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json',
          'WWW-Authenticate': WWW_AUTHENTICATE,
        },
      }
    );
  }

  const body = await request.text();
  const contentType = request.headers.get('content-type') ?? 'application/json';

  // Both the request and the body read are guarded. The Edge Function's isolate
  // is capped at 256MB and Supabase kills it on breach (HTTP 546,
  // WORKER_LIMIT); when the kill lands mid-response the socket is severed with
  // the body half-written, and undici surfaces that as `TypeError: terminated`
  // from either await. Left unhandled it escapes into Next.js as an opaque 500,
  // which tells the MCP client nothing and trips Vercel's error-anomaly alerts.
  try {
    const upstream = await fetch(MCP_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        Authorization: authorization,
      },
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    const responseHeaders: Record<string, string> = {
      ...CORS_HEADERS,
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
  } catch (error) {
    const timedOut = isTimeoutError(error);

    // Deliberately narrow logging. This handler holds live credentials (the
    // Authorization header and the legacy query-string key) and the request
    // body carries message content, recipients and search terms, so none of
    // those may reach the log sink. The failure mode, the error identity and
    // the JSON-RPC correlation id are enough to line a failure up with the
    // upstream's own logs without exporting anything sensitive.
    const requestId = recoverRequestId(body);
    console.error('[api/mcp] upstream proxy failure', {
      timedOut,
      timeoutMs: timedOut ? UPSTREAM_TIMEOUT_MS : undefined,
      errorName: (error as { name?: string } | null)?.name ?? 'UnknownError',
      errorMessage: (error as { message?: string } | null)?.message ?? String(error),
      causeName: (error as { cause?: { name?: string } } | null)?.cause?.name,
      jsonrpcId: requestId,
    });

    // Status choice: both are 5xx gateway codes because the fault is upstream,
    // not in the client's request, and because MCP clients (and the SDKs behind
    // them) treat 502/504 as transient and retryable while a bare 500 reads as
    // a permanent server bug that is not worth retrying. 504 Gateway Timeout
    // says specifically "the upstream was still working when we gave up", which
    // is the honest description of a slow mailbox operation; 502 Bad Gateway
    // says "the upstream connection broke", which is what an isolate kill or a
    // reset looks like from here. Keeping them distinct also lets our own
    // alerting separate memory-limit kills from genuinely long operations.
    return new NextResponse(
      JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        error: {
          code: timedOut ? JSONRPC_UPSTREAM_TIMEOUT : JSONRPC_INTERNAL_ERROR,
          message: timedOut
            ? 'Upstream MCP server did not respond in time. The operation may still be running; retry in a moment.'
            : 'Upstream MCP server connection failed. Please retry.',
        },
      }),
      {
        status: timedOut ? 504 : 502,
        // CORS headers are repeated on this path for the same reason they are
        // on every other one: browser-based MCP clients cannot read a response,
        // error or not, without them, and a CORS-blocked error is
        // indistinguishable from a network outage in the client.
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json',
        },
      }
    );
  }
}
