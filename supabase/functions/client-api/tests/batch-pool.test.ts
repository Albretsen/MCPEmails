// `/mail/batch` against the REAL session pool: what runs in parallel, what
// shares a connection, and what two concurrent batches for one inbox do to
// each other (the client's cold boot sends exactly that: lists + status in one
// batch, folders in another).
//
// Two rigs:
//   * "scripted": `runMailBatch` over a fake seam whose executor asks the
//     first-party context for an IMAP connection, as `ImapClient.connect`
//     does. Timing is fully under the test's control.
//   * "real": the real tool layer over the scripted fake IMAP server, through
//     `createApp`'s `/mail/batch` route.
// No socket is opened in either.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { firstPartyContext } from "../../mcp-server/first-party.ts";
import { FakeImapServer, fakeTextMessage, type FakeMailbox } from "../../mcp-server/imap-fake-server.ts";
import { ImapPool, type ImapPoolOptions, type PoolableClient } from "../imap-pool.ts";
import { runMailBatch } from "../mail/batch.ts";
import { InboxRowCache, type MailEnv, type MailRequest } from "../mail/run.ts";
import type { InboxRow } from "../seam.ts";
import { fakeSeam, INBOX_ID, keyRow, ok, request, SECOND_INBOX_ID, type SeamCall, WORKSPACE_ID } from "./helpers.ts";
import { FakeDialPool, harness, imapInbox, realApp } from "./real-seam.ts";

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(what: string, condition: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (condition()) return;
    await tick(1);
  }
  throw new Error(`never happened: ${what}`);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// ── scripted rig ────────────────────────────────────────────────────────────

interface ScriptedClient extends PoolableClient {
  id: number;
  wire: string[];
  loggedOut: boolean;
  destroyed: boolean;
  command(label: string, ms?: number): Promise<void>;
}

interface Scripted {
  env: MailEnv;
  pool: ImapPool<PoolableClient>;
  clients: ScriptedClient[];
  seam: ReturnType<typeof fakeSeam>;
  /** What `ImapClient.connect` does on this path: ask the context for a connection. */
  connect: (inbox: string) => Promise<ScriptedClient>;
}

function scripted(options: ImapPoolOptions = {}): Scripted {
  const pool = new ImapPool<PoolableClient>(options);
  const clients: ScriptedClient[] = [];
  const seam = fakeSeam();
  const env: MailEnv = {
    mcp: seam,
    pool,
    inboxes: new InboxRowCache(),
    apiKey: keyRow(),
    canWrite: true,
    imapDial: () => {
      const client: ScriptedClient = {
        id: clients.length + 1,
        wire: [],
        loggedOut: false,
        destroyed: false,
        logout() {
          client.loggedOut = true;
          return Promise.resolve();
        },
        destroy() {
          client.destroyed = true;
        },
        async command(label, ms = 1) {
          client.wire.push(`${label}>`);
          await tick(ms);
          client.wire.push(`${label}<`);
        },
      };
      clients.push(client);
      return Promise.resolve(client);
    },
  };
  const connect = async (inbox: string) => {
    const hook = firstPartyContext.getStore()?.imapConnect;
    if (!hook) throw new Error("no first-party context: the executor was not run through runMailOp");
    return await hook<ScriptedClient>(
      { host: "imap.example.com", port: 993, email: `${inbox}@example.com`, password: "invented" },
      () => Promise.reject(new Error("the socket dial must never run in a test")),
    );
  };
  return { env, pool, clients, seam, connect };
}

const read = (inbox: string, id: string): MailRequest => ({ op: "read", inbox_id: inbox, args: { message_id: id } });
const tagOf = (call: SeamCall) => `${call.args["inbox_id"] === INBOX_ID ? "A" : "B"}:${call.args["message_id"]}`;

/** Every command on a connection finished before the next one started. */
function assertNoInterleaving(wire: string[]): void {
  for (let i = 0; i < wire.length; i += 2) {
    assertEquals(wire[i + 1], wire[i].replace(">", "<"), `interleaved on the wire: ${wire.join(" ")}`);
  }
}

Deno.test("batch (imap): different inboxes run in parallel, each on its own single connection, each in order", async () => {
  const rig = scripted();
  let inFlight = 0;
  let maxInFlight = 0;
  const perInbox = { A: 0, B: 0 };
  const maxPerInbox = { A: 0, B: 0 };
  const started: string[] = [];
  const finished: string[] = [];
  rig.seam.respond = async (call) => {
    const tag = tagOf(call);
    const who = tag[0] as "A" | "B";
    started.push(tag);
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    maxPerInbox[who] = Math.max(maxPerInbox[who], ++perInbox[who]);
    const client = await rig.connect(String(call.args["inbox_id"]));
    // Inbox A's first call is by far the slowest: B must not sit behind it.
    await client.command(tag, tag === "A:1" ? 12 : 1);
    await client.logout();
    perInbox[who]--;
    inFlight--;
    finished.push(tag);
    return ok({ tag, connection: client.id });
  };

  const calls = [read(INBOX_ID, "1"), read(SECOND_INBOX_ID, "1"), read(INBOX_ID, "2"), read(SECOND_INBOX_ID, "2"), read(INBOX_ID, "3"), read(SECOND_INBOX_ID, "3")];
  const out = await runMailBatch(rig.env, calls, WORKSPACE_ID);

  assertEquals(out.results.map((r) => r.ok && (r.result as { tag: string }).tag), ["A:1", "B:1", "A:2", "B:2", "A:3", "B:3"]);
  assertEquals(maxInFlight, 2, "the two inboxes overlapped");
  assertEquals(maxPerInbox, { A: 1, B: 1 }, "never two calls at once on one inbox");
  assertEquals(started.filter((t) => t[0] === "A"), ["A:1", "A:2", "A:3"]);
  assertEquals(started.filter((t) => t[0] === "B"), ["B:1", "B:2", "B:3"]);
  assert(finished.indexOf("B:3") < finished.indexOf("A:1"), `inbox B finished all three while A:1 was still running: ${finished}`);

  assertEquals(rig.clients.length, 2, "one connection per inbox");
  assertEquals([rig.pool.stats.dials, rig.pool.stats.reuses, rig.pool.stats.overflows, rig.pool.stats.waits], [2, 4, 0, 0]);
  assertEquals([out.timings.imapDials, out.timings.imapReuses], [2, 4]);
  for (const client of rig.clients) assertNoInterleaving(client.wire);
  // A connection never served the other inbox.
  const byInbox = (who: string) => new Set(out.results.filter((r) => r.ok && (r.result as { tag: string }).tag[0] === who).map((r) => r.ok && (r.result as { connection: number }).connection));
  assertEquals([byInbox("A").size, byInbox("B").size], [1, 1]);
  assert([...byInbox("A")][0] !== [...byInbox("B")][0]);
  await rig.pool.closeAll();
});

Deno.test("batch (gmail/outlook): inboxes run in parallel; one inbox's calls run 4 at a time once its row is cached, in order when it is not", async () => {
  const run = async (cached: boolean) => {
    const rig = scripted();
    if (cached) {
      rig.env.inboxes.remember({ id: INBOX_ID, workspace_id: WORKSPACE_ID, provider: "gmail" } as unknown as InboxRow);
      rig.env.inboxes.remember({ id: SECOND_INBOX_ID, workspace_id: WORKSPACE_ID, provider: "outlook" } as unknown as InboxRow);
    }
    let inFlight = 0;
    let maxInFlight = 0;
    const perInbox = { A: 0, B: 0 };
    const maxPerInbox = { A: 0, B: 0 };
    rig.seam.respond = async (call) => {
      const who = tagOf(call)[0] as "A" | "B";
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      maxPerInbox[who] = Math.max(maxPerInbox[who], ++perInbox[who]);
      await tick(2);
      perInbox[who]--;
      inFlight--;
      return ok({ tag: tagOf(call) });
    };
    const calls: MailRequest[] = [];
    for (let i = 1; i <= 6; i++) calls.push(read(INBOX_ID, String(i)), read(SECOND_INBOX_ID, String(i)));
    const out = await runMailBatch(rig.env, calls, WORKSPACE_ID);
    assertEquals(
      out.results.map((r) => r.ok && (r.result as { tag: string }).tag),
      calls.map((c) => `${c.inbox_id === INBOX_ID ? "A" : "B"}:${c.args!["message_id"]}`),
      "results stay in request order",
    );
    assertEquals(rig.pool.stats.dials, 0, "no IMAP connection for an HTTP provider");
    return { maxInFlight, maxPerInbox };
  };

  assertEquals(await run(true), { maxInFlight: 8, maxPerInbox: { A: 4, B: 4 } });
  // Row not cached yet (the very first request of an isolate): the provider is
  // unknown, so each inbox's calls run one at a time. The inboxes still overlap.
  assertEquals(await run(false), { maxInFlight: 2, maxPerInbox: { A: 1, B: 1 } });
});

Deno.test("re-entrancy: one op that connects twice in sequence reuses its own connection; twice at once gets an overflow connection, never a deadlock", async () => {
  const rig = scripted();
  rig.seam.respond = async (call) => {
    const inbox = String(call.args["inbox_id"]);
    if (call.args["message_id"] === "sequential") {
      const first = await rig.connect(inbox);
      await first.command("first");
      await first.logout();
      const second = await rig.connect(inbox);
      await second.command("second");
      await second.logout();
      return ok({ connections: [first.id, second.id] });
    }
    const outer = await rig.connect(inbox);
    const inner = await rig.connect(inbox);
    await inner.command("inner");
    await inner.logout();
    await outer.command("outer");
    await outer.logout();
    return ok({ connections: [outer.id, inner.id] });
  };

  const sequential = await runMailBatch(rig.env, [read(INBOX_ID, "sequential")], WORKSPACE_ID);
  assertEquals(sequential.results[0], { ok: true, result: { connections: [1, 1] } });
  assertEquals([rig.pool.stats.dials, rig.pool.stats.reuses, rig.pool.stats.overflows, rig.pool.stats.waits], [1, 1, 0, 0]);

  const nested = await runMailBatch(rig.env, [read(INBOX_ID, "nested")], WORKSPACE_ID);
  assertEquals(nested.results[0], { ok: true, result: { connections: [1, 2] } }, "outer is the pooled connection, inner a second one");
  assertEquals([rig.pool.stats.dials, rig.pool.stats.overflows, rig.pool.stats.waits], [2, 1, 0], "the second connect did not wait for itself");
  assertEquals(rig.clients[1].loggedOut, true, "the overflow connection was really logged out");
  assertEquals([rig.clients[0].loggedOut, rig.pool.stats.idle], [false, 1], "the pooled one is idle again");
  await rig.pool.closeAll();
});

Deno.test("re-entrancy at the connection cap: a self-inflicted wait ends in a retryable 503 after waitMs, it does not hang", async () => {
  const rig = scripted({ maxPerKey: 1, waitMs: 3 });
  rig.seam.respond = async (call) => {
    const outer = await rig.connect(String(call.args["inbox_id"]));
    try {
      const inner = await rig.connect(String(call.args["inbox_id"]));
      await inner.logout();
    } finally {
      await outer.logout();
    }
    return ok({});
  };
  const out = await runMailBatch(rig.env, [read(INBOX_ID, "nested"), read(INBOX_ID, "nested")], WORKSPACE_ID);
  for (const entry of out.results) {
    assert(!entry.ok);
    assertEquals([entry.error.code, entry.error.retryable, entry.error.tool_code], ["provider_error", true, "imap_pool_busy"]);
  }
  assertEquals([rig.clients.length, rig.pool.stats.idle, rig.pool.stats.leased], [1, 1, 0], "the outer lease was returned and is reusable");
  await rig.pool.closeAll();
});

Deno.test("a lease that is never returned: the next calls wait waitMs then overflow, then 503 at the cap, and the pooled slot is reclaimed after maxLeaseMs", async () => {
  let skew = 0;
  const rig = scripted({ maxPerKey: 3, waitMs: 3, maxLeaseMs: 60_000, now: () => performance.now() + skew });
  rig.seam.respond = async (call) => {
    const client = await rig.connect(String(call.args["inbox_id"]));
    if (call.args["message_id"] === "leak") throw new Error("executor threw without releasing its connection");
    await client.command(String(call.args["message_id"]));
    await client.logout();
    return ok({ connection: client.id });
  };
  const codes = (out: Awaited<ReturnType<typeof runMailBatch>>) => out.results.map((r) => r.ok ? "ok" : `${r.error.code}/${r.error.tool_code}`);

  // Call 1 leaks the pooled connection. Call 2 is a different flow: it waits
  // waitMs for a lease nobody will return, then gets an overflow connection.
  const first = await runMailBatch(rig.env, [read(INBOX_ID, "leak"), read(INBOX_ID, "fine")], WORKSPACE_ID);
  assertEquals(codes(first), ["provider_error/unhandled", "ok"]);
  assertEquals([rig.clients.length, rig.pool.stats.overflows, rig.pool.stats.leased], [2, 1, 1]);
  assert(rig.pool.stats.waits >= 1);
  assertEquals(rig.clients[1].loggedOut, true);

  // Two more leaks take the two overflow slots: the inbox is at maxPerKey.
  const second = await runMailBatch(rig.env, [read(INBOX_ID, "leak"), read(INBOX_ID, "leak"), read(INBOX_ID, "fine")], WORKSPACE_ID);
  assertEquals(codes(second), ["provider_error/unhandled", "provider_error/unhandled", "provider_error/imap_pool_busy"]);
  assertEquals(second.results[2].ok === false && second.results[2].error.retryable, true);
  assertEquals(rig.clients.length, 4);

  // A minute on, the pooled lease is presumed leaked: destroyed and re-dialled.
  skew += 60_001;
  const third = await runMailBatch(rig.env, [read(INBOX_ID, "fine"), read(INBOX_ID, "fine")], WORKSPACE_ID);
  assertEquals(codes(third), ["ok", "ok"]);
  assertEquals(rig.clients[0].destroyed, true, "the leaked pooled connection was destroyed");
  assertEquals(rig.clients.length, 5, "one fresh dial, shared by both calls");
  assertEquals([rig.pool.stats.idle, rig.pool.stats.leased], [1, 0]);
  await rig.pool.closeAll();
});

// ── real rig ────────────────────────────────────────────────────────────────

function mailboxes(): FakeMailbox[] {
  return [
    { name: "INBOX", attrs: ["\\HasNoChildren"], modSeq: 100, messages: [fakeTextMessage(1, { seen: true }), fakeTextMessage(2), fakeTextMessage(3)] },
    { name: "Archive", attrs: ["\\HasNoChildren", "\\Archive"], modSeq: 7, messages: [fakeTextMessage(9, { seen: true })] },
  ];
}

/**
 * The real pool over scripted servers, recording a single timeline: `+` a
 * lease handed out, `-` a lease given back, and every command that reached
 * any server in between.
 */
class TracedPool extends FakeDialPool {
  readonly timeline: string[] = [];
  dialsStarted = 0;
  /** When set, a dial does not complete until it resolves. */
  gate: Promise<void> | null = null;
  /** Per dial (0-based): throw instead of connecting, or script the server. */
  failDial: (n: number) => boolean = () => false;
  hangUpOn: (n: number, command: string) => boolean = () => false;

  constructor(readonly boxes: FakeMailbox[], options: ImapPoolOptions = {}) {
    super(() => {
      throw new Error("unused");
    }, options);
  }

  override readonly dial = async (): Promise<PoolableClient> => {
    const n = this.dialsStarted++;
    if (this.gate) await this.gate;
    if (this.failDial(n)) throw new Error("connect ECONNREFUSED (scripted)");
    const advertised = ["IMAP4REV1", "CONDSTORE"];
    const server = new FakeImapServer({
      mailboxes: this.boxes,
      capabilities: advertised,
      readTimeoutMs: 50,
      onCommand: (command, self) => {
        this.timeline.push(`c${this.servers.indexOf(self)}:${command.split(" ").slice(0, 2).join(" ")}`);
        if (this.hangUpOn(n, command)) self.hangUp();
      },
    });
    this.servers.push(server);
    const client = server.client();
    (client as unknown as { capabilities: Set<string> }).capabilities = new Set(advertised);
    return client as unknown as PoolableClient;
  };

  override async checkout(key: string, flow: object, dial: () => Promise<PoolableClient>): Promise<PoolableClient> {
    const client = await super.checkout(key, flow, dial);
    this.timeline.push("+");
    let returned = false;
    const giveBack = () => {
      if (!returned) this.timeline.push("-");
      returned = true;
    };
    return new Proxy(client as object, {
      get: (target, prop) => {
        const value = Reflect.get(target, prop, target);
        if (prop !== "logout" && prop !== "destroy") return value;
        return (...args: unknown[]) => {
          giveBack();
          return (value as (...a: unknown[]) => unknown)(...args);
        };
      },
    }) as PoolableClient;
  }

  /** At most one lease open at any moment, and no command outside a lease. */
  assertExclusive(): void {
    let open = 0;
    for (const event of this.timeline) {
      if (event === "+") open++;
      else if (event === "-") open--;
      else assertEquals(open, 1, `a command arrived with ${open} leases open: ${this.timeline.join(" ")}`);
      assert(open === 0 || open === 1, `two leases at once: ${this.timeline.join(" ")}`);
    }
    assertEquals(open, 0, "every lease was returned");
  }
}

const noHandler: harness.ProviderHandler = (call) => harness.json({ error: `unexpected provider call ${call.url}` }, 500);

async function realRig(options: ImapPoolOptions = {}) {
  const pool = new TracedPool(mailboxes(), options);
  const app = await realApp({ pool });
  const inbox = await imapInbox();
  const post = async (calls: MailRequest[]) => {
    const response = await app.handle(request("/mail/batch", { token: app.token, body: { calls } }));
    return { status: response.status, body: await response.json() };
  };
  const run = async <T>(body: () => Promise<T>) => (await harness.runTool(inbox, noHandler, body)).value;
  const logged = () => app.logs.filter((l) => l.event === "request" && l.fields["imap_dials"] !== undefined).map((l) => [l.fields["imap_dials"], l.fields["imap_reuses"]]);
  return { pool, app, post, run, logged };
}

const LISTS: MailRequest[] = [
  { op: "list", inbox_id: INBOX_ID, args: { folder: "inbox", limit: 2 } },
  { op: "status", inbox_id: INBOX_ID, args: { folders: ["inbox", "Archive"] } },
];
const FOLDERS: MailRequest[] = [{ op: "folders", inbox_id: INBOX_ID, args: {} }];

function assertLists(body: { results: Array<{ ok: boolean; result: any }> }): void {
  assertEquals(body.results.map((r) => r.ok), [true, true], JSON.stringify(body));
  assertEquals(body.results[0].result.messages.map((m: { id: string }) => m.id), ["INBOX:3", "INBOX:2"]);
  assertEquals(body.results[1].result.folders.map((f: { id: string; total: number; unread: number }) => [f.id, f.total, f.unread]), [["INBOX", 3, 2], ["Archive", 1, 0]]);
}

function assertFolders(body: { results: Array<{ ok: boolean; result: unknown }> }): void {
  assertEquals(body.results.map((r) => r.ok), [true], JSON.stringify(body));
  const text = JSON.stringify(body.results[0].result);
  assert(text.includes("INBOX") && text.includes("Archive"), text);
}

Deno.test("batch (imap, real tool layer): one inbox's calls use ONE dial on a cold pool and none on a warm one, strictly one after another", async () => {
  const { pool, post, run, logged } = await realRig();
  const calls = [...LISTS, ...FOLDERS, { op: "read", inbox_id: INBOX_ID, args: { message_id: "Archive:9", include_html: false } }];

  const cold = await run(() => post(calls));
  assertEquals(cold.status, 200);
  assertEquals(cold.body.results.map((r: { ok: boolean }) => r.ok), [true, true, true, true], JSON.stringify(cold.body));
  assertLists({ results: cold.body.results.slice(0, 2) });
  assertEquals(cold.body.results[3].result.id, "Archive:9");
  assertEquals(pool.servers.length, 1, "one connection for the whole batch");
  assertEquals([pool.stats.dials, pool.stats.overflows, pool.stats.waits], [1, 0, 0]);
  assertEquals(pool.stats.reuses, pool.connects - 1, "every connect after the first was the pooled connection");
  pool.assertExclusive();

  const warm = await run(() => post(calls));
  assertEquals(warm.body.results.map((r: { ok: boolean }) => r.ok), [true, true, true, true]);
  assertEquals([pool.servers.length, pool.stats.dials, pool.stats.overflows, pool.stats.waits], [1, 1, 0, 0], "a warm batch dials nothing");
  assertEquals(logged().map((l) => l[0]), [1, 0], "the request log says which batch dialled");
  assertEquals(pool.servers[0].logoutReceived, false);
  pool.assertExclusive();

  // In order: the list's SELECT, then status's STATUS, then the folder LIST, then the read's SELECT of Archive.
  const wire = pool.servers[0].commands.slice(0, pool.servers[0].commands.length / 2);
  const at = (re: RegExp) => wire.findIndex((c) => re.test(c));
  assert(at(/^SELECT/) < at(/^STATUS/) && at(/^STATUS/) < at(/^LIST/) && at(/^LIST/) < wire.findLastIndex((c) => /^SELECT/.test(c)), wire.join(" | "));
  await pool.closeAll();
});

Deno.test("two concurrent batches for one inbox, COLD pool, same instant: one dial, the second queues, both answer correctly", async () => {
  const { pool, post, run, logged } = await realRig();
  const gate = deferred();
  pool.gate = gate.promise;

  const [lists, folders] = await run(async () => {
    const both = Promise.all([post(LISTS), post(FOLDERS)]);
    // Both batches have asked the pool for a connection; the only dial has not answered yet.
    await until("both batches reached checkout", () => pool.connects === 2);
    assertEquals([pool.dialsStarted, pool.servers.length], [1, 0]);
    await tick(2);
    assertEquals(pool.dialsStarted, 1, "the second batch is queued, not dialling");
    gate.resolve();
    return await both;
  });

  assertEquals([lists.status, folders.status], [200, 200]);
  assertLists(lists.body);
  assertFolders(folders.body);
  assertEquals([pool.dialsStarted, pool.servers.length, pool.stats.dials, pool.stats.overflows], [1, 1, 1, 0], "exactly one connection was ever opened");
  assert(pool.stats.waits >= 1, "the other batch waited on the pool");
  assertEquals(logged().map((l) => l[0]).sort(), [0, 1], "one request dialled, the other reused");
  assertEquals([pool.stats.idle, pool.stats.leased, pool.servers[0].logoutReceived], [1, 0, false]);
  pool.assertExclusive();
  await pool.closeAll();
});

Deno.test("two concurrent batches for one inbox, WARM pool: no dial, the leases alternate, never overlap", async () => {
  const { pool, post, run } = await realRig();
  const [lists, folders] = await run(async () => {
    await post(FOLDERS);
    return await Promise.all([post(LISTS), post(FOLDERS)]);
  });
  assertLists(lists.body);
  assertFolders(folders.body);
  assertEquals([pool.servers.length, pool.stats.dials, pool.stats.overflows], [1, 1, 0]);
  pool.assertExclusive();
  await pool.closeAll();
});

Deno.test("the first batch's DIAL throws while the second is queued: the queued batch dials afresh and succeeds", async () => {
  const { pool, post, run } = await realRig();
  const gate = deferred();
  pool.gate = gate.promise;
  pool.failDial = (n) => n === 0;

  const [lists, folders] = await run(async () => {
    const a = post(LISTS);
    await until("batch A is dialling", () => pool.dialsStarted === 1);
    const b = post(FOLDERS);
    await until("batch B is queued behind it", () => pool.connects === 2);
    gate.resolve();
    return await Promise.all([a, b]);
  });

  assertEquals(lists.status, 200);
  assertEquals(lists.body.results[0].ok, false, "the call whose dial failed reports it");
  assertEquals(lists.body.results[0].error.retryable, true, JSON.stringify(lists.body.results[0]));
  assertFolders(folders.body);
  assertEquals(pool.stats.overflows, 0);
  assertEquals(pool.servers.filter((s) => !s.closed).length, 1, "one connection is left, idle");
  assertEquals([pool.stats.idle, pool.stats.leased], [1, 0]);
  pool.assertExclusive();
  await pool.closeAll();
});

Deno.test("the first batch's call FAILS on the wire while the second is queued: the dead connection is dropped, the queued batch gets a fresh one", async () => {
  const { pool, post, run } = await realRig();
  const gate = deferred();
  pool.gate = gate.promise;
  // The first connection dies on its first command.
  pool.hangUpOn = (n) => n === 0;

  const [lists, folders] = await run(async () => {
    const a = post([LISTS[0]]);
    await until("batch A is dialling", () => pool.dialsStarted === 1);
    const b = post(FOLDERS);
    await until("batch B is queued behind it", () => pool.connects === 2);
    gate.resolve();
    return await Promise.all([a, b]);
  });

  assertEquals([lists.status, folders.status], [200, 200]);
  assertFolders(folders.body);
  assertEquals(pool.servers[0].closed, true, "the failed connection was destroyed, not pooled");
  assertEquals(pool.stats.overflows, 0);
  assertEquals(pool.servers.filter((s) => !s.closed).length, 1);
  assertEquals([pool.stats.idle, pool.stats.leased], [1, 0]);
  assert(pool.servers.at(-1)!.commands.some((c) => /^LIST/.test(c)), "the folder listing ran on the replacement connection");
  pool.assertExclusive();
  await pool.closeAll();
});
