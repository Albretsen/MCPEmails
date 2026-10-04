// Warm-path overhead: what client-api itself adds to a request, excluding the
// time spent talking to the mail provider.
//
// The budget is 60 ms warm for auth + routing + bookkeeping (the MCP path pays
// about 700 ms of database overhead per call). This measures it three ways and
// asserts a generous ceiling so the test is not flaky on a slow CI runner; the
// printed numbers are the real result.
//
//   A. router only, HS256: verify the JWT, cached gate, rate limit, cached
//      key, op validation, an executor that returns at once.
//   B. the same with ES256 against a cached JWKS (the asymmetric-keys path).
//   C. the REAL tool layer on IMAP with the session pool and the fake server:
//      total wall time minus the `provider` phase of Server-Timing.

import { assert } from "jsr:@std/assert@1";
import { createApp } from "../app.ts";
import { JwtVerifier, WorkspaceGate } from "../auth.ts";
import { ImapPool, type PoolableClient } from "../imap-pool.ts";
import { RateLimiter } from "../rate-limit.ts";
import { fakeTextMessage } from "../../mcp-server/imap-fake-server.ts";
import { b64url, claimsFor, fakeSeam, fakeStore, INBOX_ID, membership, mintHs256, request, SUPABASE_URL, testApp } from "./helpers.ts";
import { FakeDialPool, harness, imapInbox, imapServer, realApp } from "./real-seam.ts";

const BUDGET_MS = 60;
const unlimited = () =>
  new RateLimiter(
    {
      read: { capacity: 1e9, refillPerSec: 1e9 },
      write: { capacity: 1e9, refillPerSec: 1e9 },
      send: { capacity: 1e9, refillPerSec: 1e9 },
      assistant: { capacity: 1e9, refillPerSec: 1e9 },
    },
    { limit: 1e9, windowMs: 10_000 },
  );

function stats(samples: number[]) {
  const sorted = samples.slice().sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return { n: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), p99: round(at(0.99)), max: round(sorted[sorted.length - 1]) };
}

function providerMs(response: Response): number {
  const match = /provider;dur=([\d.]+)/.exec(response.headers.get("server-timing") ?? "");
  return match ? Number(match[1]) : 0;
}

const listBody = { op: "list", inbox_id: INBOX_ID, args: { folder: "inbox", limit: 50 } };

Deno.test("bench A: router overhead, HS256, warm", async () => {
  const { handle } = testApp({ limiter: unlimited() });
  const token = await mintHs256();
  await (await handle(request("/mail", { token, body: listBody }))).body?.cancel();
  const samples: number[] = [];
  for (let i = 0; i < 500; i++) {
    const started = performance.now();
    const response = await handle(request("/mail", { token, body: listBody }));
    await response.text();
    samples.push(performance.now() - started);
  }
  const s = stats(samples);
  console.log(`[bench A] router + HS256 verify, warm, ms: ${JSON.stringify(s)}`);
  assert(s.p95 < BUDGET_MS, `p95 ${s.p95} ms`);
});

Deno.test("bench B: router overhead, ES256 with a cached JWKS, warm", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "bench", alg: "ES256" };
  const header = b64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "bench" }));
  const payload = b64url(JSON.stringify(claimsFor()));
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(`${header}.${payload}`)),
  );
  const token = `${header}.${payload}.${b64url(signature)}`;
  let jwksFetches = 0;
  const store = fakeStore([membership()]);
  const handle = createApp({
    mcp: fakeSeam(),
    store,
    verifier: new JwtVerifier({
      supabaseUrl: SUPABASE_URL,
      fetch: () => {
        jwksFetches++;
        return Promise.resolve(new Response(JSON.stringify({ keys: [jwk] })));
      },
    }),
    gate: new WorkspaceGate(store),
    limiter: unlimited(),
    pool: new ImapPool<PoolableClient>(),
    log: () => {},
  });
  await (await handle(request("/mail", { token, body: listBody }))).body?.cancel();
  const samples: number[] = [];
  for (let i = 0; i < 500; i++) {
    const started = performance.now();
    const response = await handle(request("/mail", { token, body: listBody }));
    await response.text();
    samples.push(performance.now() - started);
  }
  const s = stats(samples);
  console.log(`[bench B] router + ES256 verify (JWKS fetched ${jwksFetches}x), warm, ms: ${JSON.stringify(s)}`);
  assert(jwksFetches === 1);
  assert(s.p95 < BUDGET_MS, `p95 ${s.p95} ms`);
});

Deno.test("bench C: real tool layer on IMAP, pooled session: overhead outside the provider phase", async () => {
  const boxes = [{ name: "INBOX", messages: Array.from({ length: 60 }, (_, i) => fakeTextMessage(i + 1, { seen: i % 3 === 0 })) }];
  const pool = new FakeDialPool(imapServer(boxes));
  const app = await realApp({ pool });
  const inbox = await imapInbox();
  const cold: { wall: number; provider: number; overhead: number } = { wall: 0, provider: 0, overhead: 0 };
  const overhead: number[] = [];
  const wall: number[] = [];
  const provider: number[] = [];
  const { world } = await harness.runTool(inbox, () => harness.json({}, 500), async () => {
    for (let i = 0; i < 201; i++) {
      const started = performance.now();
      const response = await app.handle(request("/mail", { token: app.token, body: listBody }));
      await response.text();
      const total = performance.now() - started;
      const p = providerMs(response);
      if (i === 0) {
        cold.wall = total;
        cold.provider = p;
        cold.overhead = total - p;
        continue;
      }
      wall.push(total);
      provider.push(p);
      overhead.push(total - p);
    }
  });
  const o = stats(overhead);
  console.log(`[bench C] IMAP list of 50, warm (pooled session, cached inbox row), 200 requests`);
  console.log(`[bench C]   overhead outside provider phase, ms: ${JSON.stringify(o)}`);
  console.log(`[bench C]   provider phase (fake server, in-process), ms: ${JSON.stringify(stats(provider))}`);
  console.log(`[bench C]   total wall, ms: ${JSON.stringify(stats(wall))}`);
  console.log(`[bench C]   cold first request, ms: ${JSON.stringify({ wall: Math.round(cold.wall * 100) / 100, provider: Math.round(cold.provider * 100) / 100 })}`);
  console.log(`[bench C]   database round trips: ${world.db.length} for 201 requests; IMAP connections dialled: ${pool.servers.length}`);
  assert(o.p95 < BUDGET_MS, `p95 overhead ${o.p95} ms`);
  assert(pool.servers.length === 1, "every warm request reused the one pooled session");
  assert(world.db.length <= 2, `warm requests issue no database queries (saw ${world.db.length} in total)`);
  await pool.closeAll();
});
