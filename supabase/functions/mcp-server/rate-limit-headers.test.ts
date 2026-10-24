// ---------------------------------------------------------------------------
// RateLimit-* headers on an answered tools/call (developer API plan, F3).
//
// The decisions live in rate-limit-headers.ts and are tested directly. The
// wiring lives in index.ts, which binds a port at load, so it is checked
// against the shipped source (same tactic as plan-rate-limits.test.ts). The
// /api/mcp ingress rebuilds every answer with a fixed header set, so it is
// driven end to end to prove the headers survive it and are exposed by CORS.
//
// Run: deno test --allow-read supabase/functions/mcp-server/rate-limit-headers.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  headroom,
  RATE_LIMIT_HEADER_NAMES,
  rateLimitHeaders,
  tighterHeadroom,
  withRateLimitHeaders,
} from "./rate-limit-headers.ts";
import { handleWebIngress, WEB_CORS_HEADERS } from "./web-ingress.ts";

const SOURCE = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("headroom excludes the call being answered and never goes negative", () => {
  assertEquals(headroom(300, 10, 60_000), { limit: 300, remaining: 289, resetSeconds: 60 });
  assertEquals(headroom(100, 99, 60_000).remaining, 0);
  assertEquals(headroom(100, 500, 3_600_000), { limit: 100, remaining: 0, resetSeconds: 3600 });
});

Deno.test("the tighter of the key window and the workspace ceiling is reported", () => {
  const key = headroom(300, 5, 60_000); // 294 left
  const workspace = headroom(300, 250, 60_000); // 49 left: other keys are busy
  assertEquals(tighterHeadroom(key, workspace), workspace);
  assertEquals(rateLimitHeaders(key, workspace), {
    "RateLimit-Limit": "300",
    "RateLimit-Remaining": "49",
    "RateLimit-Reset": "60",
  });
  // A key near its day window is tighter than an idle workspace.
  const dayWindow = headroom(30_000, 29_990, 86_400_000);
  assertEquals(rateLimitHeaders(dayWindow, headroom(300, 0, 60_000)), {
    "RateLimit-Limit": "30000",
    "RateLimit-Remaining": "9",
    "RateLimit-Reset": "86400",
  });
});

Deno.test("one side missing reports the other; neither reports nothing", () => {
  const only = headroom(60, 1, 60_000);
  assertEquals(rateLimitHeaders(only, undefined)["RateLimit-Remaining"], "58");
  assertEquals(rateLimitHeaders(undefined, only)["RateLimit-Limit"], "60");
  assertEquals(rateLimitHeaders(undefined, undefined), {});
});

Deno.test("headers go on results, never on JSON-RPC errors", () => {
  const headers = rateLimitHeaders(headroom(100, 0, 60_000), undefined);
  const ok = withRateLimitHeaders(new Response("{}"), { jsonrpc: "2.0", id: 1, result: {} }, headers);
  assertEquals(ok.headers.get("RateLimit-Remaining"), "99");
  // An isError tool result is still a result: the call was answered.
  const toolError = withRateLimitHeaders(
    new Response("{}"),
    { jsonrpc: "2.0", id: 1, result: { isError: true } },
    headers,
  );
  assertEquals(toolError.headers.get("RateLimit-Limit"), "100");
  const rpcError = withRateLimitHeaders(
    new Response("{}"),
    { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "x" } },
    headers,
  );
  assertEquals(rpcError.headers.get("RateLimit-Limit"), null);
});

Deno.test("index.ts builds the headers from the counts the gates already hold, for tools/call only", () => {
  assert(
    /const successRateLimitHeaders: Record<string, string> = rpcRequest\.method === "tools\/call"/.test(SOURCE),
    "headers are built only for tools/call",
  );
  assert(
    /"tightest" in rateLimitResult \? rateLimitResult\.tightest : undefined/.test(SOURCE),
    "the per-key side comes from checkRateLimit's own counts",
  );
  assert(
    /headroom\(quotaResult\.perMinuteLimit, quotaResult\.usedThisMinute, PLAN_RPM_WINDOW_MS\)/.test(SOURCE),
    "the workspace side comes from checkPlanQuota's own count",
  );
  assert(
    /quotaResult\.counted === true/.test(SOURCE),
    "a fail-open quota answer (nothing counted) is not reported as room",
  );
  const stamped = SOURCE.match(/withRateLimitHeaders\(/g) ?? [];
  assert(stamped.length >= 3, "every answered tools/call response path is stamped");
  // No query of its own: the header block names no table and no RPC.
  const block = SOURCE.slice(
    SOURCE.indexOf("const successRateLimitHeaders"),
    SOURCE.indexOf("// ── Route to method handler"),
  );
  assert(block.length > 0 && !/\.from\(|\.rpc\(/.test(block), "the headers must not cost a query");
});

Deno.test("both CORS sets expose the headers to browser clients", () => {
  const bare = SOURCE.match(/"Access-Control-Expose-Headers":\s*\n?\s*("[^"]*"(?:\s*\+\s*"[^"]*")*)/);
  assert(bare !== null, "the bare function's CORS_HEADERS has an Expose-Headers entry");
  for (const name of RATE_LIMIT_HEADER_NAMES) {
    assert(bare![1].includes(name), `bare CORS exposes ${name}`);
    assert(WEB_CORS_HEADERS["Access-Control-Expose-Headers"].includes(name), `/api/mcp CORS exposes ${name}`);
  }
});

Deno.test("the /api/mcp ingress passes the headers through its rebuilt answer", async () => {
  const inner = (_req: Request) =>
    Promise.resolve(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "RateLimit-Limit": "300",
          "RateLimit-Remaining": "299",
          "RateLimit-Reset": "60",
          "X-Internal": "dropped",
        },
      }),
    );
  const res = await handleWebIngress(
    new Request("https://x.supabase.co/functions/v1/mcp-server/web", {
      method: "POST",
      headers: { Authorization: "Bearer mcpe_test", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "inbox_list" } }),
    }),
    inner,
    { appUrl: "https://mcpemails.example" },
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("RateLimit-Limit"), "300");
  assertEquals(res.headers.get("RateLimit-Remaining"), "299");
  assertEquals(res.headers.get("RateLimit-Reset"), "60");
  assertEquals(res.headers.get("X-Internal"), null, "the ingress still drops everything else");
  await res.body?.cancel();
});
