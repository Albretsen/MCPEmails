// The inbox privacy model in client-api (visibility.ts): a member sees an
// inbox iff it is company-wide or theirs. client-api runs as the service role,
// so these are the only things standing between member B and member A's
// private inbox. In-memory fakes; no network, no database.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { firstPartyContext } from "../../mcp-server/first-party.ts";
import { createApp } from "../app.ts";
import { JwtVerifier, type Membership, WorkspaceGate } from "../auth.ts";
import { ImapPool, type PoolableClient } from "../imap-pool.ts";
import { InboxRowCache, type MailEnv, runExecutor } from "../mail/run.ts";
import { type Recipient, supabasePushStore, visibleRecipients } from "../push/store.ts";
import { RateLimiter } from "../rate-limit.ts";
import type { InboxRow } from "../seam.ts";
import { supabaseStore } from "../store.ts";
import { HOST_CONCURRENCY, PROVIDER_CONCURRENCY } from "../push/dispatch.ts";
import { runSends, type WebhookDeps } from "../webhooks/deliver.ts";
import { supabaseWebhookStore } from "../webhooks/store.ts";
import { keyInboxIds, NO_INBOX_ID, parseCredentialScope, scopeAllows, scopeFromAcl } from "../visibility.ts";
import {
  fakeSeam,
  fakeStore,
  JWT_SECRET,
  keyRow,
  membership,
  mintHs256,
  ok,
  OTHER_USER_ID,
  request,
  SUPABASE_URL,
  USER_ID,
  WORKSPACE_ID,
} from "./helpers.ts";
import { fakeMail } from "./push-fakes.ts";
import { fakeDecrypt, fakeTransport, fakeWebhookStore } from "./webhook-fakes.ts";

// A = USER_ID, B = OTHER_USER_ID, both members of WORKSPACE_ID.
const PRIVATE_A = "a0000000-0000-4000-8000-00000000000a";
const PRIVATE_B = "b0000000-0000-4000-8000-00000000000b";
const COMPANY = "c0000000-0000-4000-8000-00000000000c";
const ALL = [PRIVATE_A, PRIVATE_B, COMPANY];

const listed = (id: string) => ({
  inbox_id: id,
  email_address: `${id.slice(0, 1)}@example.test`,
  display_name: id.slice(0, 1),
  provider: "imap",
  service: null,
  sender_identities: [],
  sender_identity_status: "available",
});

const row = (id: string, overrides: Record<string, unknown> = {}): InboxRow =>
  ({ id, workspace_id: WORKSPACE_ID, provider: "imap", status: "active", email_address: `${id[0]}@example.test`, ...overrides }) as unknown as InboxRow;

/**
 * Two members of one workspace. The fake executor is the WORST case: it
 * ignores the key's inbox_ids and lists and serves every inbox, so anything
 * these tests see refused was refused by client-api itself.
 */
function rig(options: { rowsFor?: (userId: string) => Membership[]; inboxes?: InboxRowCache } = {}) {
  const seam = fakeSeam();
  seam.respond = (call) => call.tool === "inbox_list" ? ok({ inboxes: ALL.map(listed) }) : ok({ tool: call.tool });
  const store = fakeStore([membership({ role: "member" })]);
  store.scopes.set(`${WORKSPACE_ID}:${USER_ID}`, { restricted: true, ids: [PRIVATE_A, COMPANY] });
  store.scopes.set(`${WORKSPACE_ID}:${OTHER_USER_ID}`, { restricted: true, ids: [PRIVATE_B, COMPANY] });
  if (options.rowsFor) {
    const rowsFor = options.rowsFor;
    store.memberships = (userId) => Promise.resolve(rowsFor(userId));
  }
  const handle = createApp({
    mcp: seam,
    store,
    verifier: new JwtVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: JWT_SECRET }),
    gate: new WorkspaceGate(store),
    limiter: new RateLimiter(),
    pool: new ImapPool<PoolableClient>(),
    inboxes: options.inboxes,
    env: () => undefined,
    log: () => {},
  });
  return { seam, store, handle };
}

const tokenA = await mintHs256({ sub: USER_ID });
const tokenB = await mintHs256({ sub: OTHER_USER_ID, email: "b@client-api-test.example" });

const mail = (token: string, op: string, inboxId: string, args: Record<string, unknown> = {}) =>
  request("/mail", { token, body: { op, inbox_id: inboxId, args } });

const OPS: Array<[string, Record<string, unknown>]> = [
  ["list", {}],
  ["read", { message_id: "INBOX:1" }],
  ["search", { text: "invoice" }],
  ["send", { to: ["x@example.test"], subject: "s", body: "b", idempotency_key: "k-1" }],
  ["attachment", { message_id: "INBOX:1", attachment_index: 0 }],
];

Deno.test("member B cannot list, read, search, send from or download from A's private inbox", async () => {
  const { seam, handle } = rig();
  for (const [op, args] of OPS) {
    const response = await handle(mail(tokenB, op, PRIVATE_A, args));
    assertEquals(response.status, 404, op);
    const body = await response.json();
    // Exactly what a mailbox that does not exist gets.
    assertEquals(body.error.code, "inbox_not_found", op);
    assertEquals(body.error.tool_code, "inbox_not_found", op);
  }
  assertEquals(seam.calls.filter((c) => c.args["inbox_id"] === PRIVATE_A), [], "the executor was never asked");
});

Deno.test("an uppercased id and a batch slot are refused the same way", async () => {
  const { seam, handle } = rig();
  const upper = await handle(mail(tokenB, "list", PRIVATE_A.toUpperCase()));
  assertEquals(upper.status, 404);
  const batch = await handle(request("/mail/batch", {
    token: tokenB,
    body: { calls: [{ op: "list", inbox_id: PRIVATE_A, args: {} }, { op: "list", inbox_id: COMPANY, args: {} }] },
  }));
  assertEquals(batch.status, 200);
  const { results } = await batch.json();
  assertEquals(results[0].ok, false);
  assertEquals(results[0].error.code, "inbox_not_found");
  assertEquals(results[1].ok, true);
  assertEquals(seam.calls.filter((c) => c.args["inbox_id"] === PRIVATE_A).length, 0);
});

Deno.test("a company inbox works for both members; the owner still uses their own private inbox", async () => {
  const { seam, handle } = rig();
  for (const token of [tokenA, tokenB]) {
    assertEquals((await handle(mail(token, "list", COMPANY))).status, 200);
  }
  assertEquals((await handle(mail(tokenA, "list", PRIVATE_A))).status, 200);
  assertEquals((await handle(mail(tokenB, "list", PRIVATE_B))).status, 200);
  // The executor's key acts as the person, with the person's inboxes as its allow-list.
  const keys = seam.calls.filter((c) => c.tool === "email_list").map((c) => c.apiKey);
  assertEquals(keys.map((k) => k.created_by), [USER_ID, OTHER_USER_ID, USER_ID, OTHER_USER_ID]);
  assertEquals(keys[0].inbox_ids, [PRIVATE_A, COMPANY]);
  assertEquals(keys[1].inbox_ids, [PRIVATE_B, COMPANY]);
});

Deno.test("/session lists only the member's own inboxes, from a list cached per person", async () => {
  const { seam, handle } = rig();
  const a = await (await handle(request("/session", { token: tokenA }))).json();
  const b = await (await handle(request("/session", { token: tokenB }))).json();
  assertEquals(a.inboxes.map((i: { inbox_id: string }) => i.inbox_id), [PRIVATE_A, COMPANY]);
  assertEquals(b.inboxes.map((i: { inbox_id: string }) => i.inbox_id), [PRIVATE_B, COMPANY]);
  // B's list was not served from A's cache entry: two listings.
  assertEquals(seam.calls.filter((c) => c.tool === "inbox_list").length, 2);
  // And each cache entry is reused by its own person.
  await handle(request("/session", { token: tokenB }));
  assertEquals(seam.calls.filter((c) => c.tool === "inbox_list").length, 2);
});

Deno.test("/session never reports someone else's private inbox as an error row", async () => {
  const errorRow = row(PRIVATE_A, { status: "error" });
  const { handle } = rig({
    rowsFor: (userId) => [membership({
      role: "member",
      // Even if the load handed B the row, B's scope keeps it out.
      inbox_rows: [errorRow],
      inbox_scope: userId === USER_ID
        ? { restricted: true, ids: [PRIVATE_A, COMPANY] }
        : { restricted: true, ids: [PRIVATE_B, COMPANY] },
    })],
  });
  const b = await (await handle(request("/session", { token: tokenB }))).json();
  assert(!b.inboxes.some((i: { inbox_id: string }) => i.inbox_id === PRIVATE_A));
  const a = await (await handle(request("/session", { token: tokenA }))).json();
  assertEquals(a.inboxes.find((i: { inbox_id: string }) => i.inbox_id === PRIVATE_A)?.status, "reconnect_required");
});

Deno.test("a removed member reaches nothing", async () => {
  const { seam, store, handle } = rig();
  store.scopes.set(`${WORKSPACE_ID}:${OTHER_USER_ID}`, { restricted: true, ids: [] });
  const session = await (await handle(request("/session", { token: tokenB }))).json();
  assertEquals(session.inboxes, []);
  for (const id of ALL) assertEquals((await handle(mail(tokenB, "list", id))).status, 404);
  const listing = seam.calls.find((c) => c.tool === "inbox_list" && c.apiKey.created_by === OTHER_USER_ID)!;
  // Never [] (several executors read an empty allow-list as "all").
  assertEquals(listing.apiKey.inbox_ids, [NO_INBOX_ID]);
});

Deno.test("a workspace where nothing is hidden keeps the key unrestricted", async () => {
  const { seam, store, handle } = rig();
  store.scopes.delete(`${WORKSPACE_ID}:${USER_ID}`);
  assertEquals((await handle(mail(tokenA, "list", PRIVATE_B))).status, 200);
  assertEquals(seam.calls.at(-1)!.apiKey.inbox_ids, null);
});

Deno.test("visibility that cannot be read refuses the request: never 'everything'", async () => {
  const { seam, store, handle } = rig();
  store.scopes.set(`${WORKSPACE_ID}:${OTHER_USER_ID}`, "fail");
  const session = await handle(request("/session", { token: tokenB }));
  assertEquals(session.status, 503);
  assertEquals((await handle(mail(tokenB, "list", COMPANY))).status, 503);
  assertEquals(seam.calls.length, 0);
});

Deno.test("the scope from the membership load is used without a second query", async () => {
  const { store, handle } = rig({
    rowsFor: () => [membership({ role: "member", inbox_scope: { restricted: true, ids: [PRIVATE_B, COMPANY] } })],
  });
  assertEquals((await handle(mail(tokenB, "list", PRIVATE_A))).status, 404);
  assertEquals(store.scopeCalls, 0);
});

Deno.test("the shared inbox-row cache never hands A's row to B's request", async () => {
  const inboxes = new InboxRowCache();
  const seen: Array<unknown> = [];
  const { seam, handle } = rig({
    inboxes,
    rowsFor: (userId) => [membership({
      role: "member",
      // A's load carries A's private row; it lands in the shared cache.
      inbox_rows: userId === USER_ID ? [row(PRIVATE_A), row(COMPANY)] : [row(COMPANY)],
      inbox_scope: userId === USER_ID
        ? { restricted: true, ids: [PRIVATE_A, COMPANY] }
        : { restricted: true, ids: [PRIVATE_B, COMPANY] },
    })],
  });
  await handle(mail(tokenA, "list", PRIVATE_A));
  assert(inboxes.get(PRIVATE_A, WORKSPACE_ID) !== null, "A's row is cached");
  // B's executor asks the first-party hook for A's row: it gets nothing.
  seam.respond = () => {
    const store = firstPartyContext.getStore();
    seen.push(store?.inboxRow?.(PRIVATE_A, WORKSPACE_ID) ?? null);
    store?.rememberInboxRow?.(row(PRIVATE_A, { status: "active", email_address: "planted@example.test" }));
    return ok({});
  };
  assertEquals((await handle(mail(tokenB, "list", COMPANY))).status, 200);
  assertEquals(seen, [null]);
  // ...and cannot overwrite it either.
  assertEquals((inboxes.get(PRIVATE_A, WORKSPACE_ID) as unknown as { email_address: string }).email_address, "a@example.test");
});

Deno.test("an assistant tool call naming a hidden inbox never reaches the executor", async () => {
  const seam = fakeSeam();
  const env: MailEnv = {
    mcp: seam,
    pool: new ImapPool<PoolableClient>(),
    inboxes: new InboxRowCache(),
    apiKey: { ...keyRow(), created_by: OTHER_USER_ID, inbox_ids: [PRIVATE_B, COMPANY] },
    canWrite: true,
    canSee: (id) => scopeAllows({ restricted: true, ids: [PRIVATE_B, COMPANY] }, id),
  };
  const timings = { providerMs: 0, connectMs: 0, imapDials: 0, imapReuses: 0 };
  const error = await assertRejects(() =>
    runExecutor(env, { tool: "email_read", args: {} }, { inboxId: PRIVATE_A.toUpperCase(), flow: {}, timings })
  );
  assertEquals((error as { body?: { code?: string } }).body?.code, "inbox_not_found");
  assertEquals(seam.calls.length, 0);
});

// ── visibility.ts ───────────────────────────────────────────────────────────

Deno.test("scopeFromAcl: company for all, private for its owner, ownerless private for nobody", () => {
  const acl = [
    { id: PRIVATE_A, visibility: "private", owner_user_id: USER_ID },
    { id: PRIVATE_B, visibility: "private", owner_user_id: OTHER_USER_ID },
    { id: COMPANY, visibility: "company", owner_user_id: USER_ID },
    { id: "d0000000-0000-4000-8000-00000000000d", visibility: "private", owner_user_id: null },
  ];
  assertEquals(scopeFromAcl(acl, OTHER_USER_ID), { restricted: true, ids: [PRIVATE_B, COMPANY] });
  assertEquals(scopeFromAcl(acl.slice(0, 1).concat(acl[2]), USER_ID), { restricted: false });
  assertEquals(scopeFromAcl([{ id: COMPANY }], USER_ID), null, "no ACL columns: no guess");
  assertEquals(keyInboxIds({ restricted: false }), null);
  assertEquals(keyInboxIds({ restricted: true, ids: [] }), [NO_INBOX_ID]);
});

Deno.test("parseCredentialScope: anything unexpected reaches nothing", () => {
  assertEquals(parseCredentialScope({ restricted: false, inbox_ids: null }), { restricted: false });
  assertEquals(parseCredentialScope({ restricted: true, inbox_ids: [COMPANY.toUpperCase(), "nope"] }), {
    restricted: true,
    ids: [COMPANY],
  });
  for (const bad of [null, "x", {}, { restricted: "false" }, { restricted: true }]) {
    assertEquals(parseCredentialScope(bad), { restricted: true, ids: [] });
  }
});

// ── store.ts ────────────────────────────────────────────────────────────────

type Answer = { data: unknown; error: { code?: string } | null };

function fakeDb(answers: Answer[]) {
  const recorded: Array<{ table?: string; rpc?: string; args?: unknown; ops: Array<[string, unknown[]]> }> = [];
  const builder = (record: (typeof recorded)[number]): unknown =>
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
    rpc(name: string, args: unknown) {
      const record = { rpc: name, args, ops: [] as Array<[string, unknown[]]> };
      recorded.push(record);
      return builder(record);
    },
  };
}

Deno.test("store.memberships: B's load keeps only B's inboxes and carries B's scope", async () => {
  const db = fakeDb([{
    data: [{
      workspace_id: WORKSPACE_ID,
      role: "member",
      joined_at: "2026-01-01T00:00:00Z",
      workspaces: {
        display_name: "W",
        plan: "pro",
        web_client_enabled: true,
        api_keys: [keyRow()],
        inboxes: ALL.map((id) => row(id)),
        inbox_acl: [
          { id: PRIVATE_A, workspace_id: WORKSPACE_ID, visibility: "private", owner_user_id: USER_ID },
          { id: PRIVATE_B, workspace_id: WORKSPACE_ID, visibility: "private", owner_user_id: OTHER_USER_ID },
          { id: COMPANY, workspace_id: WORKSPACE_ID, visibility: "company", owner_user_id: USER_ID },
        ],
      },
    }],
    error: null,
  }]);
  const [m] = await supabaseStore(db, { inboxColumns: "id, workspace_id, status" }).memberships(OTHER_USER_ID);
  assertEquals(m.inbox_scope, { restricted: true, ids: [PRIVATE_B, COMPANY] });
  assertEquals(m.inbox_rows?.map((r) => r.id), [PRIVATE_B, COMPANY]);
});

Deno.test("store.memberships: an embed without the ACL caches no inbox rows and sets no scope", async () => {
  const db = fakeDb([{
    data: [{
      workspace_id: WORKSPACE_ID,
      role: "member",
      joined_at: "2026-01-01T00:00:00Z",
      workspaces: { display_name: "W", plan: "pro", web_client_enabled: true, api_keys: [], inboxes: ALL.map((id) => row(id)) },
    }],
    error: null,
  }]);
  const [m] = await supabaseStore(db, { inboxColumns: "id, workspace_id, status" }).memberships(OTHER_USER_ID);
  assertEquals(m.inbox_rows, []);
  assertEquals(m.inbox_scope, undefined);
});

Deno.test("store.inboxScope: asks credential_inbox_scope as the person, and throws on an error", async () => {
  const db = fakeDb([{ data: { restricted: true, inbox_ids: [COMPANY] }, error: null }, { data: null, error: { code: "42883" } }]);
  const store = supabaseStore(db);
  assertEquals(await store.inboxScope(WORKSPACE_ID, OTHER_USER_ID), { restricted: true, ids: [COMPANY] });
  assertEquals(db.recorded[0].rpc, "credential_inbox_scope");
  assertEquals(db.recorded[0].args, { p_workspace_id: WORKSPACE_ID, p_user_id: OTHER_USER_ID, p_inbox_ids: null });
  await assertRejects(() => store.inboxScope(WORKSPACE_ID, OTHER_USER_ID));
});

// ── push ────────────────────────────────────────────────────────────────────

const recipient = (userId: string): Recipient => ({
  subscription_id: `sub-${userId.slice(0, 4)}`,
  user_id: userId,
  endpoint: `https://push.example/${userId.slice(0, 4)}`,
  p256dh: "p",
  auth: "a",
  payload_mode: "rich",
  quiet_start: null,
  quiet_end: null,
  quiet_timezone: null,
});

Deno.test("push: a private inbox notifies its owner only; a company inbox every listed member", () => {
  const both = [recipient(USER_ID), recipient(OTHER_USER_ID)];
  assertEquals(visibleRecipients(both, { visibility: "private", owner_user_id: USER_ID }).map((r) => r.user_id), [USER_ID]);
  assertEquals(visibleRecipients(both, { visibility: "company", owner_user_id: USER_ID }).length, 2);
  assertEquals(visibleRecipients(both, { visibility: "private", owner_user_id: null }), []);
  assertEquals(visibleRecipients(both, null), []);
  assertEquals(visibleRecipients(both, {}), [], "no readable visibility: nobody");
});

Deno.test("push store: recipients are cut to who may see the inbox; a failed read throws", async () => {
  const both = [recipient(USER_ID), recipient(OTHER_USER_ID)];
  const db = fakeDb([
    { data: both, error: null },
    { data: { visibility: "private", owner_user_id: OTHER_USER_ID }, error: null },
    { data: both, error: null },
    { data: null, error: { code: "42703" } },
  ]);
  const store = supabasePushStore(db);
  assertEquals((await store.recipients(PRIVATE_B)).map((r) => r.user_id), [OTHER_USER_ID]);
  await assertRejects(() => store.recipients(PRIVATE_B));
});

// ── webhooks ────────────────────────────────────────────────────────────────

function webhookRig() {
  let clock = Date.UTC(2026, 10, 11, 12, 0, 0);
  const now = () => clock;
  const hooks = fakeWebhookStore(now);
  const transport = fakeTransport();
  const deps: WebhookDeps = { store: hooks, transport, decrypt: fakeDecrypt, now, log: () => {} };
  hooks.allowed.add(WORKSPACE_ID);
  for (const id of ALL) hooks.inboxes.set(id, { workspace_id: WORKSPACE_ID, provider: "imap" });
  const enqueue = (endpointId: string, inboxId: string) =>
    hooks.deliveries.push({
      id: `d-${endpointId}-${inboxId.slice(0, 1)}`,
      endpoint_id: endpointId,
      workspace_id: WORKSPACE_ID,
      event_id: `evt_${inboxId.slice(0, 1)}${"a".repeat(31)}`,
      inbox_id: inboxId,
      message_ids: ["INBOX:7"],
      message_count: 1,
      attempt: 0,
      status: "pending",
      response_code: null,
      error_code: null,
      next_attempt_at: clock,
      lease_id: null,
      leased_until: null,
      created_at: new Date(clock).toISOString(),
    });
  const send = () =>
    runSends(deps, fakeMail(), {
      deadlineMs: clock + 40_000,
      limits: {
        providerConcurrency: PROVIDER_CONCURRENCY,
        hostConcurrency: HOST_CONCURRENCY,
        providerKey: (p: string) => (p === "gmail" || p === "outlook" ? p : "imap"),
      },
    });
  return { hooks, transport, enqueue, send, advance: (ms: number) => void (clock += ms) };
}

Deno.test("webhooks: B's endpoint never gets A's private inbox; it still gets the company inbox", async () => {
  const r = webhookRig();
  r.hooks.endpoint({ id: "ep-b", workspace_id: WORKSPACE_ID });
  r.hooks.hidden.add(`ep-b:${PRIVATE_A}`);
  r.enqueue("ep-b", PRIVATE_A);
  r.enqueue("ep-b", COMPANY);
  const report = await r.send();
  assertEquals(report.delivered, 1);
  assertEquals(report.abandoned, 1);
  assertEquals(r.transport.sent.length, 1);
  assert(r.transport.sent[0].body.includes(COMPANY));
  assert(!r.transport.sent.some((q) => q.body.includes(PRIVATE_A)));
  const hidden = r.hooks.deliveries.find((d) => d.inbox_id === PRIVATE_A)!;
  assertEquals([hidden.status, hidden.error_code, hidden.message_ids], ["abandoned", "inbox_not_visible", null]);
});

Deno.test("webhooks: a failed visibility read sends nothing and counts no attempt", async () => {
  const r = webhookRig();
  r.hooks.endpoint({ id: "ep-b", workspace_id: WORKSPACE_ID });
  r.hooks.visibilityFails = true;
  r.enqueue("ep-b", COMPANY);
  await r.send();
  assertEquals(r.transport.sent.length, 0);
  const d = r.hooks.deliveries[0];
  assertEquals([d.status, d.attempt], ["pending", 0]);
});

Deno.test("webhook store: an endpoint acts as its creator (null: the owner, inside the SQL)", async () => {
  const db = fakeDb([
    { data: { workspace_id: WORKSPACE_ID, created_by: OTHER_USER_ID }, error: null },
    { data: { restricted: true, inbox_ids: [PRIVATE_B, COMPANY] }, error: null },
    { data: { workspace_id: WORKSPACE_ID, created_by: null }, error: null },
    { data: { restricted: false, inbox_ids: null }, error: null },
    { data: null, error: null },
  ]);
  const store = supabaseWebhookStore(db);
  assertEquals(await store.endpointSeesInbox("ep-b", PRIVATE_A), false);
  assertEquals(db.recorded[1].args, { p_workspace_id: WORKSPACE_ID, p_user_id: OTHER_USER_ID, p_inbox_ids: null });
  assertEquals(await store.endpointSeesInbox("ep-old", PRIVATE_A), true);
  assertEquals((db.recorded[3].args as { p_user_id: unknown }).p_user_id, null);
  assertEquals(await store.endpointSeesInbox("ep-gone", COMPANY), false, "no endpoint row: nothing");
});
