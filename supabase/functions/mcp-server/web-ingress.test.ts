// ---------------------------------------------------------------------------
// The mcpemails.com/api/mcp contract, now served by /mcp-server/web behind a
// Vercel rewrite. Expected values are the removed Next.js route's responses as
// measured on production 2026-10-20, so a drift here is a client-visible
// change. Two deliberate additions: `error="invalid_token"` on a refused token
// (RFC 6750) and `Allow` on the 405.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  discoveryChallenge,
  handleWebIngress,
  isWebIngress,
  WEB_CORS_HEADERS,
} from "./web-ingress.ts";

const APP = "https://mcpemails.com";
const URL_WEB = "https://x.supabase.co/functions/v1/mcp-server/web";
const NO_TOKEN_CHALLENGE =
  'Bearer realm="MCPEmails", resource_metadata="https://mcpemails.com/.well-known/oauth-protected-resource", scope="read:email"';
const BAD_TOKEN_CHALLENGE =
  'Bearer realm="MCPEmails", error="invalid_token", resource_metadata="https://mcpemails.com/.well-known/oauth-protected-resource", scope="read:email"';
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type, MCP-Protocol-Version, Accept",
  "access-control-expose-headers": "WWW-Authenticate, MCP-Protocol-Version, Mcp-Session-Id",
};

function headersOf(res: Response): Record<string, string> {
  return Object.fromEntries(res.headers.entries());
}

type Seen = { url: string; auth: string | null; body: string; headers: Headers };
function recorder(reply: () => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const inner = async (req: Request) => {
    seen.push({ url: req.url, auth: req.headers.get("authorization"), body: await req.text(), headers: req.headers });
    return await reply();
  };
  return { seen, inner };
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Max-Age": "86400", "X-Internal": "1", ...extra },
  });

Deno.test("only the /web path is the ingress", () => {
  assert(isWebIngress(new Request(URL_WEB)));
  assert(!isWebIngress(new Request("https://x.supabase.co/functions/v1/mcp-server")));
  assert(!isWebIngress(new Request("https://x.supabase.co/functions/v1/mcp-server/dispatch")));
});

Deno.test("challenge strings", () => {
  assertEquals(discoveryChallenge(APP), NO_TOKEN_CHALLENGE);
  assertEquals(discoveryChallenge(APP, true), BAD_TOKEN_CHALLENGE);
});

Deno.test("OPTIONS preflight is the old route's 204", async () => {
  const { seen, inner } = recorder(() => json({}));
  const res = await handleWebIngress(new Request(URL_WEB, { method: "OPTIONS" }), inner, { appUrl: APP });
  assertEquals(res.status, 204);
  assertEquals(headersOf(res), CORS);
  assertEquals(await res.text(), "");
  assertEquals(seen.length, 0);
});

Deno.test("GET and DELETE get 405 with Allow and never reach the server", async () => {
  for (const method of ["GET", "DELETE", "PUT"]) {
    const { seen, inner } = recorder(() => json({}));
    const res = await handleWebIngress(new Request(URL_WEB, { method }), inner, { appUrl: APP });
    assertEquals(res.status, 405);
    assertEquals(res.headers.get("allow"), "POST, OPTIONS");
    assertEquals(await res.text(), "");
    assertEquals(seen.length, 0);
  }
});

Deno.test("no credential: the old 401 body and discovery challenge, no error param", async () => {
  const { seen, inner } = recorder(() => json({}));
  const res = await handleWebIngress(
    new Request(URL_WEB, { method: "POST", body: "{}" }),
    inner,
    { appUrl: APP },
  );
  assertEquals(res.status, 401);
  assertEquals(await res.text(), '{"error":"unauthorized","error_description":"Bearer token required."}');
  assertEquals(headersOf(res), { ...CORS, "content-type": "application/json", "www-authenticate": NO_TOKEN_CHALLENGE });
  assertEquals(seen.length, 0);
});

Deno.test("refused token: server 401 passes through with invalid_token challenge", async () => {
  const upstream = { jsonrpc: "2.0", id: 1, error: { code: -32001, message: "Invalid or revoked API key." } };
  const { inner } = recorder(() => json(upstream, 401));
  const res = await handleWebIngress(
    new Request(URL_WEB, { method: "POST", headers: { Authorization: "Bearer mcpe_bad" }, body: "{}" }),
    inner,
    { appUrl: APP },
  );
  assertEquals(res.status, 401);
  assertEquals(headersOf(res), { ...CORS, "content-type": "application/json", "www-authenticate": BAD_TOKEN_CHALLENGE });
  assertEquals(await res.json(), upstream);
});

Deno.test("server's own challenge (403 step-up) wins and other headers are dropped", async () => {
  const own = 'Bearer error="insufficient_scope", scope="manage:drafts read:email"';
  const { inner } = recorder(() => json({ jsonrpc: "2.0", id: 8, error: {} }, 403, { "WWW-Authenticate": own }));
  const res = await handleWebIngress(
    new Request(URL_WEB, { method: "POST", headers: { Authorization: "Bearer k" }, body: "{}" }),
    inner,
    { appUrl: APP },
  );
  assertEquals(res.status, 403);
  assertEquals(headersOf(res), { ...CORS, "content-type": "application/json", "www-authenticate": own });
});

Deno.test("?key= and ?api_key= become Bearer; the query string is dropped", async () => {
  for (const param of ["key", "api_key"]) {
    const { seen, inner } = recorder(() => json({ ok: 1 }));
    const res = await handleWebIngress(
      new Request(`${URL_WEB}?${param}=mcpe_abc&other=1`, { method: "POST", body: '{"id":1}' }),
      inner,
      { appUrl: APP },
    );
    assertEquals(res.status, 200);
    assertEquals(seen[0].auth, "Bearer mcpe_abc");
    assertEquals(seen[0].url, URL_WEB);
    assertEquals(seen[0].body, '{"id":1}');
  }
});

Deno.test("Authorization header wins over a query key", async () => {
  const { seen, inner } = recorder(() => json({ ok: 1 }));
  await handleWebIngress(
    new Request(`${URL_WEB}?key=mcpe_query`, { method: "POST", headers: { Authorization: "Bearer mcpe_header" }, body: "{}" }),
    inner,
    { appUrl: APP },
  );
  assertEquals(seen[0].auth, "Bearer mcpe_header");
});

Deno.test("client headers (Accept, protocol version, UA, client IP) reach the server", async () => {
  const { seen, inner } = recorder(() => json({ ok: 1 }));
  await handleWebIngress(
    new Request(URL_WEB, {
      method: "POST",
      headers: {
        Authorization: "Bearer k",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
        "User-Agent": "claude-code/2.0",
        "X-Forwarded-For": "203.0.113.9, 10.0.0.1",
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
    inner,
    { appUrl: APP },
  );
  const h = seen[0].headers;
  assertEquals(h.get("accept"), "application/json, text/event-stream");
  assertEquals(h.get("mcp-protocol-version"), "2025-06-18");
  assertEquals(h.get("user-agent"), "claude-code/2.0");
  assertEquals(h.get("x-forwarded-for"), "203.0.113.9, 10.0.0.1");
  assertEquals(h.get("content-type"), "application/json");
});

Deno.test("202 and 204 carry no body", async () => {
  for (const status of [202, 204]) {
    const { inner } = recorder(() => new Response(null, { status }));
    const res = await handleWebIngress(
      new Request(URL_WEB, { method: "POST", headers: { Authorization: "Bearer k" }, body: "{}" }),
      inner,
      { appUrl: APP },
    );
    assertEquals(res.status, status);
    assertEquals(res.body, null);
    assertEquals(res.headers.get("content-type"), "application/json");
  }
});

Deno.test("a fast call is answered as plain JSON even when SSE is accepted", async () => {
  const { inner } = recorder(() => json({ jsonrpc: "2.0", id: 1, result: {} }));
  const res = await handleWebIngress(
    new Request(URL_WEB, { method: "POST", headers: { Authorization: "Bearer k", Accept: "application/json, text/event-stream" }, body: '{"id":1}' }),
    inner,
    { appUrl: APP, sseUpgradeAfterMs: 1000 },
  );
  assertEquals(res.headers.get("content-type"), "application/json");
  assertEquals(await res.json(), { jsonrpc: "2.0", id: 1, result: {} });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("a slow call upgrades to SSE: comment at once, heartbeats, then the response", async () => {
  const { inner } = recorder(async () => {
    await sleep(120);
    return json({ jsonrpc: "2.0", id: 5, result: { content: [{ type: "text", text: "a\nb" }] } });
  });
  const res = await handleWebIngress(
    new Request(URL_WEB, { method: "POST", headers: { Authorization: "Bearer k", Accept: "application/json, text/event-stream" }, body: '{"id":5}' }),
    inner,
    { appUrl: APP, sseUpgradeAfterMs: 20, heartbeatMs: 30 },
  );
  assertEquals(res.status, 200);
  assertEquals(headersOf(res), { ...CORS, "content-type": "text/event-stream" });
  const text = await res.text();
  assert(text.startsWith(": working\n\n"));
  assert(text.split(": working\n\n").length >= 3, text);
  const data = text.split("\n").filter((l) => l.startsWith("data: "));
  assertEquals(data.length, 1);
  assertEquals(JSON.parse(data[0].slice(6)).id, 5);
  assert(text.endsWith("\n\n"));
});

Deno.test("a slow SSE response is piped through after the heartbeat", async () => {
  const sse = 'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\ndata: {"jsonrpc":"2.0","id":3,"result":{}}\n\n';
  const { inner } = recorder(async () => {
    await sleep(60);
    return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
  });
  const res = await handleWebIngress(
    new Request(URL_WEB, { method: "POST", headers: { Authorization: "Bearer k", Accept: "text/event-stream, application/json" }, body: '{"id":3}' }),
    inner,
    { appUrl: APP, sseUpgradeAfterMs: 10, heartbeatMs: 1000 },
  );
  assertEquals(await res.text(), ": working\n\n" + sse);
});

Deno.test("a slow call from a JSON-only client stays JSON", async () => {
  const { inner } = recorder(async () => {
    await sleep(50);
    return json({ jsonrpc: "2.0", id: 1, result: {} });
  });
  const res = await handleWebIngress(
    new Request(URL_WEB, { method: "POST", headers: { Authorization: "Bearer k", Accept: "application/json" }, body: '{"id":1}' }),
    inner,
    { appUrl: APP, sseUpgradeAfterMs: 10 },
  );
  assertEquals(res.headers.get("content-type"), "application/json");
  assertEquals((await res.json()).id, 1);
});

// Wiring: the real handleRequest routes /web through the ingress and leaves
// the bare function URL alone (it still refuses a query-string key itself).
Deno.test({
  name: "handleRequest: /web gets the old contract, the bare URL keeps its own",
  // index.ts starts module-level timers on import.
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  // Only requests answered before any database or mode-dependent path, so
  // the result does not depend on which suite imported index.ts first (the
  // module is cached per process, with that suite's environment).
  Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
  if (!Deno.env.get("SUPABASE_URL")) Deno.env.set("SUPABASE_URL", "http://127.0.0.1:9");
  if (!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "placeholder");
  const { handleRequest } = await import("./index.ts");
  const pre = await handleRequest(new Request(URL_WEB, { method: "OPTIONS" }));
  assertEquals(headersOf(pre), CORS);
  const noAuth = await handleRequest(new Request(URL_WEB, { method: "POST", body: "{}" }));
  assertEquals(noAuth.status, 401);
  assertEquals(noAuth.headers.get("www-authenticate"), NO_TOKEN_CHALLENGE);
  assertEquals((await noAuth.json()).error, "unauthorized");
  const get = await handleRequest(new Request(URL_WEB, { method: "GET" }));
  assertEquals(get.status, 405);
  assertEquals(get.headers.get("allow"), "POST, OPTIONS");
  // The bare URL keeps the server's own preflight (its wider header list and
  // Max-Age, no Expose-Headers).
  const barePre = await handleRequest(
    new Request("https://x.supabase.co/functions/v1/mcp-server", { method: "OPTIONS" }),
  );
  assertEquals(barePre.headers.get("access-control-max-age"), "86400");
  assertEquals(barePre.headers.get("access-control-expose-headers"), null);
});

Deno.test("WEB_CORS_HEADERS is exactly the old route's set", () => {
  assertEquals(
    Object.fromEntries(Object.entries(WEB_CORS_HEADERS).map(([k, v]) => [k.toLowerCase(), v])),
    CORS,
  );
});
