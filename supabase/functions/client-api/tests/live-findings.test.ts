// Regression tests for what the live verification of 2026-10-04 found.
//
//   1. `status` swallowed a refused IMAP credential as a per-folder
//      provider_error (200) when the only folder asked for was the inbox.
//   2. A failed op logged provider_ms 0 and imap_dials 0, which read as "it
//      failed before any network call" when the server had in fact refused AUTH.
//   3. Every request landed on a fresh isolate, so the cold path is the common
//      path: memberships, the hidden key and the inbox rows now come from ONE
//      query, started beside the JWKS fetch.
//   4. The mailbox was refusing every login; nothing stopped the next request
//      from trying again. The pool now remembers a refusal for a minute.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { JwtVerifier, type Membership, WorkspaceGate } from "../auth.ts";
import { createApp } from "../app.ts";
import { ImapPool, type PoolableClient } from "../imap-pool.ts";
import { InboxRowCache } from "../mail/run.ts";
import { RateLimiter } from "../rate-limit.ts";
import type { InboxRow } from "../seam.ts";
import { supabaseStore, WEB_CLIENT_KEY_KIND } from "../store.ts";
import {
  b64url,
  claimsFor,
  fakeSeam,
  fakeStore,
  keyRow,
  membership,
  request,
  SUPABASE_URL,
  USER_ID,
  WORKSPACE_ID,
} from "./helpers.ts";
import { FakeDialPool, harness, imapInbox, realApp } from "./real-seam.ts";

const noHandler: harness.ProviderHandler = (call) => harness.json({ error: `unexpected provider call ${call.url}` }, 500);

class NamedAuthError extends Error {
  constructor() {
    super("IMAP authentication failed: Authentication failed");
    this.name = "ImapAuthError";
  }
}

Deno.test("status (imap): a refused credential is reconnect_required even when only the inbox is asked for", async () => {
  const pool = new FakeDialPool(() => {
    throw new NamedAuthError();
  });
  const app = await realApp({ pool });
  const { value } = await harness.runTool(await imapInbox(), noHandler, () => app.mail("status", { folders: ["inbox"] }));
  assertEquals([value.status, value.body.error?.code, value.body.error?.tool_code], [409, "reconnect_required", "auth_failed"]);
  await pool.closeAll();
});

Deno.test("a failed op still logs the dial it attempted and the time it spent", async () => {
  const pool = new FakeDialPool(() => {
    throw new Error("imap_auth_failed");
  });
  const app = await realApp({ pool });
  await harness.runTool(await imapInbox(), noHandler, () => app.mail("list", { folder: "inbox" }));
  const line = app.logs.find((l) => l.event === "request")!;
  assertEquals([line.fields["status"], line.fields["imap_dials"], line.fields["imap_reuses"]], [409, 1, 0]);
  assert(typeof line.fields["provider_ms"] === "number");
  await pool.closeAll();
});

Deno.test("batch: a failed call's dial is counted in the batch log line", async () => {
  const pool = new FakeDialPool(() => {
    throw new Error("imap_auth_failed");
  });
  const app = await realApp({ pool });
  await harness.runTool(await imapInbox(), noHandler, async () => {
    const response = await app.handle(request("/mail/batch", {
      token: app.token,
      body: { calls: [{ op: "list", inbox_id: harness.INBOX_ID, args: { folder: "inbox" } }] },
    }));
    await response.json();
  });
  const line = app.logs.find((l) => l.event === "request")!;
  assertEquals([line.fields["ops"], line.fields["imap_dials"]], ["list:reconnect_required", 1]);
  await pool.closeAll();
});

// ── one query on a cold isolate ─────────────────────────────────────────────

type Answer = { data: unknown; error: { code?: string } | null };

function fakeDb(answers: Answer[]) {
  const recorded: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];
  const builder = (record: { ops: Array<[string, unknown[]]> }): unknown =>
    new Proxy(() => {}, {
      get(_target, prop) {
        if (prop === "then") {
          const answer = answers.shift() ?? { data: null, error: null };
          return (resolve: (value: Answer) => void) => resolve(answer);
        }
        return (...args: unknown[]) => {
          record.ops.push([String(prop), args]);
          return builder(record);
        };
      },
    });
  return {
    recorded,
    from(table: string) {
      const record = { table, ops: [] as Array<[string, unknown[]]> };
      recorded.push(record);
      return builder(record);
    },
  };
}

const INBOX_COLUMNS = "id, workspace_id, provider, imap_password, status";

function inboxRow(overrides: Partial<InboxRow> = {}): InboxRow {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    workspace_id: WORKSPACE_ID,
    provider: "imap",
    imap_password: "ciphertext",
    status: "active",
    ...overrides,
  } as unknown as InboxRow;
}

Deno.test("memberships: with the tool layer's inbox projection, the key row and inbox rows come in the same query", async () => {
  const db = fakeDb([{
    data: [{
      workspace_id: WORKSPACE_ID,
      role: "owner",
      joined_at: "2026-01-01T00:00:00Z",
      workspaces: {
        display_name: "One",
        plan: "solo",
        web_client_enabled: true,
        api_keys: [keyRow()],
        // A row for another workspace can never arrive through this embed;
        // if it did, it is dropped rather than cached under this membership.
        inboxes: [inboxRow(), inboxRow({ id: "x", workspace_id: "other" } as Partial<InboxRow>)],
      },
    }],
    error: null,
  }]);
  const rows = await supabaseStore(db, { inboxColumns: INBOX_COLUMNS }).memberships(USER_ID);
  assertEquals(db.recorded.length, 1, "one round trip");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].web_client_key?.id, keyRow().id);
  assertEquals(rows[0].inbox_rows?.map((r) => r.id), ["22222222-2222-4222-8222-222222222222"]);
  const ops = db.recorded[0].ops;
  const select = String(ops.find(([op]) => op === "select")![1][0]);
  assert(select.includes(`inboxes(${INBOX_COLUMNS})`), "the tool layer's own projection, not a narrower one");
  assert(ops.some(([op, a]) => op === "eq" && a[0] === "workspaces.api_keys.kind" && a[1] === WEB_CLIENT_KEY_KIND));
  assert(ops.some(([op, a]) => op === "is" && a[0] === "workspaces.api_keys.deleted_at" && a[1] === null));
  assert(ops.some(([op, a]) => op === "is" && a[0] === "workspaces.inboxes.deleted_at" && a[1] === null));
  assert(ops.some(([op, a]) => op === "is" && a[0] === "workspaces.deleted_at" && a[1] === null));
});

Deno.test("memberships: a refused embed falls back to the plain membership query", async () => {
  const db = fakeDb([
    { data: null, error: { code: "PGRST201" } },
    { data: [{ workspace_id: WORKSPACE_ID, role: "member", joined_at: "2026-01-01T00:00:00Z", workspaces: { display_name: "One", plan: "free", web_client_enabled: true } }], error: null },
  ]);
  const rows = await supabaseStore(db, { inboxColumns: INBOX_COLUMNS }).memberships(USER_ID);
  assertEquals(db.recorded.length, 2);
  assertEquals(rows, [{ workspace_id: WORKSPACE_ID, role: "member", joined_at: "2026-01-01T00:00:00Z", display_name: "One", plan: "free", web_client_enabled: true }]);
});

async function ecFixture() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "kid-1", alg: "ES256", use: "sig" };
  const sign = async (claims: Record<string, unknown>, key = pair.privateKey): Promise<string> => {
    const header = b64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "kid-1" }));
    const payload = b64url(JSON.stringify(claims));
    const signature = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${payload}`)),
    );
    return `${header}.${payload}.${b64url(signature)}`;
  };
  return { jwk, sign };
}

function coldApp(rows: Membership[], jwk: unknown) {
  const store = fakeStore(rows);
  const order: string[] = [];
  const inner = store.memberships.bind(store);
  store.memberships = (userId) => {
    order.push("memberships:start");
    return inner(userId);
  };
  let releaseJwks!: () => void;
  const jwksGate = new Promise<void>((resolve) => (releaseJwks = resolve));
  const verifier = new JwtVerifier({
    supabaseUrl: SUPABASE_URL,
    fetch: async () => {
      order.push("jwks:start");
      await jwksGate;
      order.push("jwks:done");
      return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });
    },
  });
  const inboxes = new InboxRowCache();
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const handle = createApp({
    mcp: fakeSeam(),
    store,
    verifier,
    gate: new WorkspaceGate(store),
    limiter: new RateLimiter(),
    pool: new ImapPool<PoolableClient>(),
    inboxes,
    env: () => undefined,
    log: (event, fields) => logs.push({ event, fields }),
  });
  return { handle, store, order, releaseJwks, inboxes, logs };
}

Deno.test("cold isolate: the membership load starts beside the JWKS fetch, and seeds the key and inbox caches", async () => {
  const { jwk, sign } = await ecFixture();
  const app = coldApp([membership({ web_client_key: keyRow(), inbox_rows: [inboxRow()] })], jwk);
  const token = await sign(claimsFor());
  const pending = app.handle(request("/session", { token }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assertEquals(app.order.slice().sort(), ["jwks:start", "memberships:start"], "the query did not wait for the keys");
  app.releaseJwks();
  const response = await pending;
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(app.store.calls.memberships, 1, "the speculative load is the only load");
  assertEquals(app.store.calls.ensureKey, 0, "the key row came with the memberships");
  assertEquals(app.inboxes.get("22222222-2222-4222-8222-222222222222", WORKSPACE_ID)?.provider, "imap");
  // Nothing that rode along is serialised to the browser.
  const text = JSON.stringify(body);
  assert(!text.includes("ciphertext") && !text.includes("key_hash") && !text.includes("inbox_rows") && !text.includes("web_client_key"));
  assertEquals(Object.keys(body.workspaces[0]).sort(), ["display_name", "id", "plan", "role", "web_client_enabled"]);

  // Warm: the keys are cached, so nothing is loaded for an unverified token.
  const second = await app.handle(request("/session", { token }));
  assertEquals(second.status, 200);
  assertEquals(app.store.calls.memberships, 1);
});

Deno.test("cold isolate: a forged token gets a 401 and none of what was loaded for the user it named", async () => {
  const { jwk } = await ecFixture();
  const other = await ecFixture();
  const app = coldApp([membership({ web_client_key: keyRow(), inbox_rows: [inboxRow()] })], jwk);
  const forged = await other.sign(claimsFor());
  const pending = app.handle(request("/session", { token: forged }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  app.releaseJwks();
  const response = await pending;
  assertEquals(response.status, 401);
  const text = await response.text();
  assert(!text.includes("Test Workspace") && !text.includes(WORKSPACE_ID));
  assertEquals(app.inboxes.get("22222222-2222-4222-8222-222222222222", WORKSPACE_ID), null, "nothing was seeded for an unverified caller");
});

Deno.test("cold isolate: an expired or non-user token starts no speculative load", async () => {
  const { jwk, sign } = await ecFixture();
  for (const claims of [claimsFor({ expiresIn: -600 }), claimsFor({ role: "service_role" }), claimsFor({ sub: "nope" })]) {
    const app = coldApp([membership()], jwk);
    const pending = app.handle(request("/session", { token: await sign(claims) }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    app.releaseJwks();
    assertEquals((await pending).status, 401);
    assertEquals(app.store.calls.memberships, 0);
  }
});

Deno.test("gate: concurrent cold requests for one user share one membership query", async () => {
  const store = fakeStore();
  const gate = new WorkspaceGate(store);
  const [a, b, c] = await Promise.all([gate.resolve(USER_ID, null), gate.resolve(USER_ID, null), gate.resolve(USER_ID, null)]);
  assertEquals(store.calls.memberships, 1);
  assertEquals([a.workspace.workspace_id, b.workspace.workspace_id, c.workspace.workspace_id], [WORKSPACE_ID, WORKSPACE_ID, WORKSPACE_ID]);
});

Deno.test("gate: a failed speculative load is not cached and raises nothing unhandled", async () => {
  const store = fakeStore();
  let fail = true;
  const inner = store.memberships.bind(store);
  store.memberships = (userId) => fail ? Promise.reject(new Error("memberships_failed:x")) : inner(userId);
  const gate = new WorkspaceGate(store);
  gate.prefetch(USER_ID);
  gate.prefetch("not-a-uuid");
  await new Promise((resolve) => setTimeout(resolve, 0));
  fail = false;
  assertEquals((await gate.resolve(USER_ID, null)).workspace.workspace_id, WORKSPACE_ID);
});

// ── a refused login is not retried ──────────────────────────────────────────

Deno.test("pool: a refused login is remembered for its credentials and not dialled again until the backoff ends", async () => {
  let clock = 0;
  let dials = 0;
  const pool = new ImapPool<PoolableClient>({ now: () => clock, authBackoffMs: 60_000 });
  const refuse = () => {
    dials++;
    return Promise.reject(new NamedAuthError());
  };
  const name = async (run: () => Promise<unknown>) => await run().then(() => "ok", (e) => (e as Error).name);

  assertEquals(await name(() => pool.checkout("inbox-a\u0000creds-1", {}, refuse)), "ImapAuthError");
  clock = 30_000;
  assertEquals(await name(() => pool.checkout("inbox-a\u0000creds-1", {}, refuse)), "ImapAuthError");
  assertEquals(dials, 1, "the second request did not log in again");
  assertEquals(pool.stats.refusals, 1);

  // New credentials are a new key: they dial at once.
  const good: PoolableClient = { logout: () => Promise.resolve() };
  const lease = await pool.checkout("inbox-a\u0000creds-2", {}, () => Promise.resolve(good));
  await lease.logout();

  clock = 61_000;
  assertEquals(await name(() => pool.checkout("inbox-a\u0000creds-1", {}, refuse)), "ImapAuthError");
  assertEquals(dials, 2, "after the backoff it is tried once more");
  await pool.closeAll();
});

Deno.test("pool: a network failure is not a login refusal and is retried on the next request", async () => {
  let dials = 0;
  const pool = new ImapPool<PoolableClient>();
  const fail = () => {
    dials++;
    return Promise.reject(new Error("connection reset"));
  };
  await pool.checkout("k", {}, fail).catch(() => {});
  await pool.checkout("k", {}, fail).catch(() => {});
  assertEquals([dials, pool.stats.refusals], [2, 0]);
  await pool.closeAll();
});
