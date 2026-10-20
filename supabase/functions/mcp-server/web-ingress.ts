/**
 * The `https://mcpemails.com/api/mcp` contract, served by this function.
 *
 * WHY THIS EXISTS. Until 2026-10-20 `/api/mcp` was a Next.js route on Vercel
 * that buffered every request, forwarded it here and copied the answer back.
 * It held a 2 GB function open for the whole tool call (about 97% of the
 * Vercel bill) while doing four small things. Vercel now forwards the request
 * with an external rewrite (apps/web/vercel.json) to `/mcp-server/web`, so no
 * Vercel function runs, and those four things moved here, applied ONLY on that
 * path. The bare function URL keeps its own stricter behaviour unchanged.
 *
 *   1. Auth discovery. A request with no credential gets the old route's 401
 *      body, and every 401 carries the WWW-Authenticate challenge pointing at
 *      the mcpemails.com protected resource metadata with `scope="read:email"`.
 *      MCP clients (Claude, ChatGPT, Cursor, Codex) start OAuth from it. A
 *      challenge the server set itself (the 403 scope step-up) wins.
 *   2. Legacy `?key=` / `?api_key=` credentials become a Bearer header. The
 *      Authorization header wins when both are sent, as before.
 *      A token that was sent and refused also gets `error="invalid_token"`.
 *   3. The old route's CORS headers, byte for byte, on every answer, and its
 *      204 preflight. Other methods get its bare 405, plus `Allow`.
 *   4. The answer is rebuilt with only Content-Type, WWW-Authenticate and
 *      CORS from this function. That is all this code can control: Supabase's
 *      gateway and Cloudflare add their own headers after it (sb-project-ref,
 *      sb-request-id, x-sb-edge-region, x-deno-execution-id, a `__cf_bm`
 *      cookie scoped to supabase.co) and Vercel passes them on. None carries
 *      a credential, and the cookie's Domain makes browsers drop it on
 *      mcpemails.com.
 *
 * And one thing the old route did not need: Vercel gives an external rewrite
 * origin 120 seconds to send its first byte, then answers 502 itself
 * (ROUTER_EXTERNAL_TARGET_ERROR; vercel.com/docs/errors/ROUTER_EXTERNAL_TARGET_ERROR
 * and the changelog "CDN origin timeout increased to two minutes"). Once
 * a byte is out, the origin may keep streaming as long as it sends something
 * at least every 120 s. Real calls take longer (search_and_move on a large
 * mailbox, ~100 a month over 120 s). So:
 *
 *   - A call still running after SSE_UPGRADE_AFTER_MS, from a client that
 *     accepts `text/event-stream` (every Streamable HTTP client must), is
 *     answered as an SSE stream: headers and a comment at once, a comment
 *     every HEARTBEAT_MS, then the JSON-RPC response as one `data:` event.
 *     The HTTP status is already 200 by then, so an upstream error status
 *     and challenge travel inside the JSON-RPC error's `data` instead.
 *   - A client that only takes JSON cannot be kept waiting past 120 s. After
 *     JSON_ONLY_DEADLINE_MS it gets the old route's timeout answer (504,
 *     JSON-RPC -32001, the request id, "may still be running") instead of a
 *     bare Vercel 502, and the call keeps running to completion. The text
 *     says not to repeat a write blindly: a retry with the same
 *     idempotency_key is deduplicated by the server (it answers "in
 *     progress" or replays the result), one without it could act twice.
 *
 * Calls that finish sooner are answered exactly as before.
 */

import { clientLabel } from "./client-label.ts";

/** The old route's CORS set, verbatim (measured on production 2026-10-20). */
export const WEB_CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version, Accept",
  "Access-Control-Expose-Headers": "WWW-Authenticate, MCP-Protocol-Version, Mcp-Session-Id",
};

/** The scope a first-time connection consents to. See the long note that
 * lived on FIRST_CONSENT_SCOPE in the removed apps/web route: every read-only
 * tool resolves to `read:email`; everything else is reached by step-up. */
export const FIRST_CONSENT_SCOPE = "read:email";

export const SSE_UPGRADE_AFTER_MS = 90_000;
export const HEARTBEAT_MS = 15_000;
/** Under Vercel's 120 s first-byte limit, with room for the Supabase gateway
 * and the Vercel hop on the way out. */
export const JSON_ONLY_DEADLINE_MS = 105_000;

/** The removed route's JSON-RPC code for "upstream did not answer in time". */
export const JSONRPC_UPSTREAM_TIMEOUT = -32001;

/**
 * The old route's 504 text ("did not respond in time. The operation may
 * still be running"), with its "retry in a moment" made safe for writes.
 */
export const STILL_RUNNING_MESSAGE =
  "Upstream MCP server did not respond in time. The operation may still be running. " +
  "Do not repeat a send, move or delete blindly: retry with the same idempotency_key, " +
  "or check the mailbox first.";

/** Keep the isolate alive for a call whose answer the client no longer waits for. */
function keepRunning(pending: Promise<unknown>): void {
  const settled = pending.catch(() => {});
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  try {
    runtime?.waitUntil?.(settled);
  } catch {
    // The call is already running; losing the keep-alive only risks a cut-off tail.
  }
}

/** True when the request arrived through the mcpemails.com rewrite. */
export function isWebIngress(req: Request): boolean {
  return new URL(req.url).pathname.endsWith("/web");
}

/**
 * The discovery challenge. `invalidToken` adds RFC 6750's `error="invalid_token"`
 * for a credential that was sent and refused; a request that sent none gets no
 * error param (RFC 6750 section 3.1).
 */
export function discoveryChallenge(appUrl: string, invalidToken = false): string {
  return `Bearer realm="MCPEmails", ` +
    (invalidToken ? `error="invalid_token", ` : "") +
    `resource_metadata="${appUrl}/.well-known/oauth-protected-resource", ` +
    `scope="${FIRST_CONSENT_SCOPE}"`;
}

export interface WebIngressOptions {
  appUrl: string;
  sseUpgradeAfterMs?: number;
  heartbeatMs?: number;
  jsonOnlyDeadlineMs?: number;
}

/** JSON-RPC id of a body, or null (batch, notification, unparsable). */
function requestIdOf(body: string): string | number | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const id = (parsed as { id?: unknown }).id;
      if (typeof id === "string" || typeof id === "number") return id;
    }
  } catch {
    // not JSON: no id
  }
  return null;
}

export async function handleWebIngress(
  req: Request,
  inner: (req: Request) => Promise<Response>,
  opts: WebIngressOptions,
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: WEB_CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST, OPTIONS" } });
  }

  const url = new URL(req.url);
  const queryKey = url.searchParams.get("key") ?? url.searchParams.get("api_key");
  const authorization = req.headers.get("authorization") ??
    (queryKey ? `Bearer ${queryKey}` : null);
  const challenge = discoveryChallenge(opts.appUrl);

  if (!authorization) {
    return new Response(
      JSON.stringify({ error: "unauthorized", error_description: "Bearer token required." }),
      {
        status: 401,
        headers: {
          ...WEB_CORS_HEADERS,
          "Content-Type": "application/json",
          "WWW-Authenticate": challenge,
        },
      },
    );
  }

  // The query string is dropped entirely, as the old route never forwarded
  // one: the server refuses query-string keys on its own URL, and the key must
  // not reach a log line from here either.
  const body = await req.text();
  const headers = new Headers(req.headers);
  headers.set("Authorization", authorization);
  headers.delete("content-length");
  if (!headers.has("content-type")) headers.set("Content-Type", "application/json");
  const forwarded = new Request(`${url.origin}${url.pathname}`, {
    method: "POST",
    headers,
    body,
  });

  const pending = inner(forwarded);
  const wantsStream = (req.headers.get("accept") ?? "").toLowerCase().includes("text/event-stream");
  const rejected = discoveryChallenge(opts.appUrl, true);
  const waitMs = wantsStream
    ? opts.sseUpgradeAfterMs ?? SSE_UPGRADE_AFTER_MS
    : opts.jsonOnlyDeadlineMs ?? JSON_ONLY_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), waitMs);
  });
  const first = await Promise.race([pending, late]);
  clearTimeout(timer);
  if (first !== "late") return dress(first, rejected);

  keepRunning(pending);
  const requestId = requestIdOf(body);
  if (wantsStream) {
    return upgradeToStream(pending, requestId, opts.heartbeatMs ?? HEARTBEAT_MS);
  }

  // This client cannot take the SSE upgrade, and past 120 s Vercel would
  // answer a bare 502 for us. Answer as the old route did on its timeout.
  console.warn("[mcp-server] web_ingress_json_only_deadline", {
    ms: waitMs,
    jsonrpc_id_present: requestId !== null,
    client: clientLabel(req.headers.get("user-agent")),
  });
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      error: { code: JSONRPC_UPSTREAM_TIMEOUT, message: STILL_RUNNING_MESSAGE },
    }),
    { status: 504, headers: { ...WEB_CORS_HEADERS, "Content-Type": "application/json" } },
  );
}

/**
 * After the SSE upgrade the status line is already 200, so an upstream error
 * status and its WWW-Authenticate challenge would be lost. Carry them in the
 * JSON-RPC error's `data`, and give a non-JSON-RPC error body (for example a
 * bare `{"error": ...}`) a JSON-RPC envelope with the request id so the client
 * can match it.
 */
export function streamedPayload(
  parsed: unknown,
  status: number,
  wwwAuthenticate: string | null,
  requestId: string | number | null,
): unknown {
  if (status < 400) return parsed;
  const extra: Record<string, unknown> = { http_status: status };
  if (wwwAuthenticate) extra.www_authenticate = wwwAuthenticate;
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
  if (obj?.jsonrpc === "2.0") {
    const error = obj.error;
    if (!error || typeof error !== "object" || Array.isArray(error)) return parsed;
    const err = error as Record<string, unknown>;
    if (err.data !== undefined && (typeof err.data !== "object" || err.data === null || Array.isArray(err.data))) {
      return parsed;
    }
    return { ...obj, error: { ...err, data: { ...(err.data as Record<string, unknown> | undefined), ...extra } } };
  }
  const description = typeof obj?.error_description === "string"
    ? obj.error_description
    : typeof obj?.error === "string"
    ? obj.error
    : "Request failed.";
  return {
    jsonrpc: "2.0",
    id: requestId,
    error: { code: status === 401 || status === 403 ? -32001 : -32603, message: description, data: extra },
  };
}

/** Rebuild the response with exactly the headers the old route sent. */
function dress(upstream: Response, challenge: string): Response {
  const headers: Record<string, string> = {
    ...WEB_CORS_HEADERS,
    "Content-Type": upstream.headers.get("content-type") ?? "application/json",
  };
  const own = upstream.headers.get("www-authenticate");
  if (own) headers["WWW-Authenticate"] = own;
  else if (upstream.status === 401) headers["WWW-Authenticate"] = challenge;
  if (upstream.status === 202 || upstream.status === 204) {
    return new Response(null, { status: upstream.status, headers });
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

function upgradeToStream(
  pending: Promise<Response>,
  requestId: string | number | null,
  heartbeatMs: number,
): Response {
  const encoder = new TextEncoder();
  let interval: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // client went away; the call itself runs to completion regardless
        }
      };
      send(": working\n\n");
      interval = setInterval(() => send(": working\n\n"), heartbeatMs);
      try {
        const res = await pending;
        clearInterval(interval);
        if ((res.headers.get("content-type") ?? "").includes("text/event-stream") && res.body) {
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } else {
          const text = await res.text();
          let data: string;
          try {
            data = JSON.stringify(
              streamedPayload(JSON.parse(text), res.status, res.headers.get("www-authenticate"), requestId),
            );
          } catch {
            data = JSON.stringify({
              jsonrpc: "2.0",
              id: requestId,
              error: { code: -32603, message: "Internal error" },
            });
          }
          send(`data: ${data}\n\n`);
        }
      } catch (err) {
        clearInterval(interval);
        console.error("[mcp-server] web_ingress_stream_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        send(`data: ${
          JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            error: { code: -32603, message: "Internal error. Please retry." },
          })
        }\n\n`);
      }
      try {
        controller.close();
      } catch {
        // already closed by a disconnect
      }
    },
    cancel() {
      clearInterval(interval);
    },
  });
  console.info("[mcp-server] web_ingress_sse_upgrade", { jsonrpc_id_present: requestId !== null });
  return new Response(stream, {
    status: 200,
    headers: { ...WEB_CORS_HEADERS, "Content-Type": "text/event-stream" },
  });
}
