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
 *   the response includes WWW-Authenticate with a resource_metadata pointer
 *   and the minimum scope a new connection needs. MCP clients use this to
 *   auto-discover the authorization server and begin the OAuth 2.0
 *   Authorization Code + PKCE flow, asking only for that scope. A 403 scope
 *   denial from the upstream carries its own WWW-Authenticate
 *   (error="insufficient_scope" with the scope to step up to, plus the ones
 *   the token already holds) and is passed through untouched.
 *
 * API keys may be sent in the Authorization header or, for backwards
 * compatibility with existing integrations, as a `key` or `api_key` query
 * parameter. Prefer the Authorization header: URL credentials can be retained
 * in browser history, logs, referrers, and monitoring systems.
 */

const MCP_FUNCTION_URL =
  'https://swvaxorwumispmjaaszb.supabase.co/functions/v1/mcp-server';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://mcpemails.com';

/**
 * The scope a first-time connection consents to.
 *
 * WHY THIS PARAMETER EXISTS. Without a `scope` parameter on the challenge,
 * Claude asks for everything the protected resource metadata advertises in
 * `scopes_supported`: all nine of ours, `send:email` and `delete:email`
 * included. That put a nine-permission consent screen, two of them destructive,
 * in front of a user who had not yet read a single message. It is the worst
 * moment in the signup funnel to ask for the largest grant, and nothing about
 * the product needs it: the remaining scopes are reachable by step-up, when the
 * model first tries an action that needs one and the server answers HTTP 403
 * with `error="insufficient_scope"` (see scope-challenge.ts in the edge
 * function). The user then consents to send at the moment they asked to send.
 *
 * WHY `read:email` ALONE, verified against the tool registry rather than
 * assumed. Every tool a user needs to connect and do read-only work resolves to
 * `read:email` as its PRIMARY required scope:
 *
 *   inbox_list     read:email
 *   email_read     read:email (all seven actions: list, read, read_batch,
 *                  search, attachment, extract, original)
 *   folder_list    read:email
 *   signature_get  read:email
 *
 * `contact_search` is reachable too, through `read:email` as an ALTERNATIVE to
 * its primary `manage:contacts` (since 2026-09-11): it returns only the names
 * and addresses of correspondents, which reading the mail already exposes.
 *
 * `search:email` is deliberately NOT here. It exists only as an ALTERNATIVE
 * scope on `email_read{action:"search"}`, whose primary is already `read:email`,
 * so a token holding `read:email` can already search. Adding it would put a
 * second line on the consent screen that grants nothing the first does not,
 * which is the same over-asking in miniature. The other read-only tools
 * (draft_list, schedule_list, automation_read) are excluded on purpose: their
 * scopes (`manage:drafts`, `schedule:email`, `manage:automations`) all carry
 * write power too, so they belong to step-up, not to the first prompt.
 *
 * KNOWN COST, stated rather than hidden: this header is also attached when the
 * upstream rejects a token, so a user whose refresh chain has died entirely and
 * must re-authorize from scratch now re-consents to read first and steps back
 * up to their other scopes on next use, instead of getting them all back in one
 * screen. Routine expiry is unaffected: that is handled by the refresh_token
 * grant, which carries the connection's full scope set forward untouched.
 */
const FIRST_CONSENT_SCOPE = 'read:email';

const WWW_AUTHENTICATE =
  `Bearer realm="MCP Emails", ` +
  `resource_metadata="${APP_URL}/.well-known/oauth-protected-resource", ` +
  `scope="${FIRST_CONSENT_SCOPE}"`;

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
  // Streamable HTTP clients send the negotiated protocol version on every
  // request after initialize, and the upstream answers an unsupported value
  // with HTTP 400 (and logs the rest). Until 2026-09-08 this proxy dropped the
  // header, so the upstream had never seen a real client's value.
  const protocolVersion = request.headers.get('mcp-protocol-version');

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
        ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}),
      },
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    const responseHeaders: Record<string, string> = {
      ...CORS_HEADERS,
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
    };

    // The upstream's own challenge wins when it sends one. Today that is the
    // 403 scope denial (`Bearer error="insufficient_scope", scope=...`), which
    // an OAuth client reads to step up for the missing scope; replacing it
    // with the generic discovery pointer would lose the scope list.
    const upstreamChallenge = upstream.headers.get('www-authenticate');
    if (upstreamChallenge) {
      responseHeaders['WWW-Authenticate'] = upstreamChallenge;
    } else if (upstream.status === 401) {
      // If the upstream rejects the token, add the discovery header so the
      // client can re-initiate the OAuth flow rather than showing a generic
      // 401 error.
      responseHeaders['WWW-Authenticate'] = WWW_AUTHENTICATE;
    }

    // 202 Accepted is the notification acknowledgement and carries no body;
    // 204 No Content forbids one outright (Fetch throws "Invalid response
    // status code 204" if given one). Return before calling upstream.text()
    // for both.
    if (upstream.status === 202 || upstream.status === 204) {
      return new NextResponse(null, { status: upstream.status, headers: responseHeaders });
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
