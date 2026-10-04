// The IMAP session pool, driven with real ImapClient instances over the
// scripted fake server (no sockets). Each numbered rule in imap-pool.ts has a
// test here.

import { assert, assertEquals, assertNotStrictEquals, assertRejects } from "jsr:@std/assert@1";
import type { ImapClient } from "../../mcp-server/imap-client.ts";
import { FakeImapServer, fakeTextMessage } from "../../mcp-server/imap-fake-server.ts";
import { ImapPool, ImapPoolBusyError, poolKey } from "../imap-pool.ts";

function server(): FakeImapServer {
  return new FakeImapServer({
    mailboxes: [
      { name: "INBOX", messages: [fakeTextMessage(1), fakeTextMessage(2, { seen: true })] },
      { name: "Archive", messages: [fakeTextMessage(7)] },
    ],
  });
}

interface Dialer {
  servers: FakeImapServer[];
  dial: () => Promise<ImapClient>;
}

function dialer(): Dialer {
  const servers: FakeImapServer[] = [];
  return {
    servers,
    dial: () => {
      const s = server();
      servers.push(s);
      return Promise.resolve(s.client());
    },
  };
}

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

Deno.test("reuse: the second checkout gets the same connection, with no dial and no LOGOUT between", async () => {
  const pool = new ImapPool<ImapClient>();
  const d = dialer();
  const first = await pool.checkout("k", {}, d.dial);
  await first.selectMailbox("INBOX");
  await first.logout();
  assertEquals(d.servers[0].logoutReceived, false, "returning a lease is not a LOGOUT");

  const second = await pool.checkout("k", {}, d.dial);
  assertEquals(await second.uidSearch("ALL"), [1, 2], "the session is still authenticated and selected");
  await second.logout();

  assertEquals(d.servers.length, 1);
  assertEquals([pool.stats.dials, pool.stats.reuses], [1, 1]);
  await pool.closeAll();
  assertEquals(d.servers[0].logoutReceived, true, "closing the pool logs the idle connection out");
});

Deno.test("no cross-inbox reuse: a different key never receives another key's connection", async () => {
  const pool = new ImapPool<ImapClient>();
  const a = dialer();
  const b = dialer();
  const leaseA = await pool.checkout("inbox-a", {}, a.dial);
  await leaseA.logout();
  const leaseB = await pool.checkout("inbox-b", {}, b.dial);
  await leaseB.selectMailbox("INBOX");
  await leaseB.logout();
  assertEquals([a.servers.length, b.servers.length], [1, 1]);
  assertEquals(a.servers[0].commands, [], "inbox A's connection saw none of inbox B's commands");
  await pool.closeAll();
});

Deno.test("the key is the inbox AND the credentials: a changed password is a new key", async () => {
  const cfg = { host: "imap.example.test", port: 993, email: "owner@example.test", password: "one" };
  const same = await poolKey("inbox-1", cfg);
  assertEquals(await poolKey("inbox-1", { ...cfg }), same);
  const variants = [
    await poolKey("inbox-2", cfg),
    await poolKey("inbox-1", { ...cfg, password: "two" }),
    await poolKey("inbox-1", { ...cfg, email: "other@example.test" }),
    await poolKey("inbox-1", { ...cfg, host: "imap.other.test" }),
    await poolKey("inbox-1", { ...cfg, port: 143 }),
    await poolKey("inbox-1", { ...cfg, security: "starttls" }),
  ];
  assertEquals(new Set([same, ...variants]).size, 7, "every variant is a distinct key");
  assert(!same.includes("one"), "the key does not contain the password");
});

Deno.test("concurrent checkout: a second operation waits for the lease, then gets the SAME connection", async () => {
  const pool = new ImapPool<ImapClient>();
  const d = dialer();
  const first = await pool.checkout("k", { op: 1 }, d.dial);
  const order: string[] = [];
  const waiting = pool.checkout("k", { op: 2 }, d.dial).then(async (lease) => {
    order.push("second-acquired");
    await lease.selectMailbox("Archive");
    await lease.logout();
  });
  await tick(5);
  assertEquals(order, [], "the second checkout is still waiting while the first holds the lease");
  await first.selectMailbox("INBOX");
  order.push("first-done");
  await first.logout();
  await waiting;
  assertEquals(order, ["first-done", "second-acquired"]);
  assertEquals(d.servers.length, 1, "one connection served both operations");
  assertEquals(d.servers[0].commands.filter((c) => c.startsWith("SELECT")), ['SELECT "INBOX"', 'SELECT "Archive"']);
  assertEquals(pool.stats.waits >= 1, true);
  await pool.closeAll();
});

Deno.test("concurrent checkout: many waiters are served one at a time, never two on one connection", async () => {
  const pool = new ImapPool<ImapClient>();
  const d = dialer();
  let holders = 0;
  let maxHolders = 0;
  await Promise.all(Array.from({ length: 6 }, async (_, i) => {
    const lease = await pool.checkout("k", { op: i }, d.dial);
    holders++;
    maxHolders = Math.max(maxHolders, holders);
    await lease.selectMailbox("INBOX");
    await tick(1);
    holders--;
    await lease.logout();
  }));
  assertEquals(maxHolders, 1);
  assertEquals(d.servers.length, 1);
  await pool.closeAll();
});

Deno.test("same operation asking twice gets an overflow connection, not a deadlock", async () => {
  const pool = new ImapPool<ImapClient>();
  const d = dialer();
  const flow = {};
  const one = await pool.checkout("k", flow, d.dial);
  const two = await pool.checkout("k", flow, d.dial);
  assertEquals(d.servers.length, 2);
  await two.logout();
  assertEquals(d.servers[1].logoutReceived, true, "the overflow connection is really logged out");
  await one.logout();
  assertEquals(d.servers[0].logoutReceived, false, "the pooled one is kept");
  assertEquals(pool.stats.overflows, 1);
  await pool.closeAll();
});

Deno.test("bounded: never more than maxPerKey live connections for one inbox", async () => {
  const pool = new ImapPool<ImapClient>({ maxPerKey: 2, waitMs: 30 });
  const d = dialer();
  const flow = {};
  const one = await pool.checkout("k", flow, d.dial);
  const two = await pool.checkout("k", flow, d.dial);
  await assertRejects(() => pool.checkout("k", flow, d.dial), ImapPoolBusyError);
  assertEquals(d.servers.length, 2, "the third connection was never dialled");
  await two.logout();
  await one.logout();
  await pool.closeAll();
});

Deno.test("error recovery: a lease on which a command failed is destroyed, and the next checkout dials fresh", async () => {
  const pool = new ImapPool<ImapClient>();
  const d = dialer();
  const lease = await pool.checkout("k", {}, d.dial);
  await assertRejects(() => lease.selectMailbox("No Such Folder"));
  await lease.logout();
  assertEquals(d.servers[0].closed, true, "the tainted connection was closed, not pooled");
  assertEquals(pool.stats.drops, 1);

  const next = await pool.checkout("k", {}, d.dial);
  assertEquals(d.servers.length, 2);
  await next.selectMailbox("INBOX");
  await next.logout();
  await pool.closeAll();
});

Deno.test("error recovery: a connection the server dropped while idle is replaced, not surfaced", async () => {
  let now = 0;
  const pool = new ImapPool<ImapClient>({ validateAfterIdleMs: 10_000, idleTtlMs: 3_600_000, now: () => now });
  const d = dialer();
  const lease = await pool.checkout("k", {}, d.dial);
  await lease.logout();
  d.servers[0].hangUp();
  now += 11_000;
  const next = await pool.checkout("k", {}, d.dial);
  assertEquals(d.servers.length, 2, "NOOP failed on the dead connection, so a new one was dialled");
  assertEquals(await next.uidSearch("ALL").catch(() => "no mailbox selected"), "no mailbox selected");
  await next.selectMailbox("INBOX");
  assertEquals(await next.uidSearch("ALL"), [1, 2]);
  await next.logout();
  assertEquals(pool.stats.validations, 1);
  await pool.closeAll();
});

Deno.test("validation: NOOP only when idle longer than the threshold", async () => {
  let now = 0;
  const pool = new ImapPool<ImapClient>({ validateAfterIdleMs: 10_000, idleTtlMs: 3_600_000, now: () => now });
  const d = dialer();
  (await pool.checkout("k", {}, d.dial)).logout();
  now += 9_000;
  await (await pool.checkout("k", {}, d.dial)).logout();
  assertEquals(d.servers[0].commands.includes("NOOP"), false, "9 s idle: reused without a round trip");
  now += 10_001;
  await (await pool.checkout("k", {}, d.dial)).logout();
  assertEquals(d.servers[0].commands.filter((c) => c === "NOOP").length, 1, "over 10 s idle: one NOOP");
  assertEquals(d.servers.length, 1);
  await pool.closeAll();
});

Deno.test("idle eviction: an unused connection is logged out after the idle TTL", async () => {
  const pool = new ImapPool<ImapClient>({ idleTtlMs: 20 });
  const d = dialer();
  await (await pool.checkout("k", {}, d.dial)).logout();
  assertEquals(pool.stats.idle, 1);
  await tick(60);
  assertEquals(d.servers[0].logoutReceived, true);
  assertEquals([pool.stats.idle, pool.stats.evictions], [0, 1]);
  // And the next checkout dials again.
  await (await pool.checkout("k", {}, d.dial)).logout();
  assertEquals(d.servers.length, 2);
  await pool.closeAll();
});

Deno.test("idle eviction: reuse inside the TTL cancels the pending eviction", async () => {
  const pool = new ImapPool<ImapClient>({ idleTtlMs: 40 });
  const d = dialer();
  await (await pool.checkout("k", {}, d.dial)).logout();
  await tick(20);
  const lease = await pool.checkout("k", {}, d.dial);
  await tick(40);
  assertEquals(d.servers[0].logoutReceived, false, "a leased connection is never evicted by the idle timer");
  await lease.logout();
  await pool.closeAll();
});

Deno.test("a returned lease is inert: a late command cannot land on a connection someone else holds", async () => {
  const pool = new ImapPool<ImapClient>();
  const d = dialer();
  const stale = await pool.checkout("k", {}, d.dial);
  await stale.logout();
  const current = await pool.checkout("k", {}, d.dial);
  assertNotStrictEquals(stale, current, "each lease is its own handle");
  const before = d.servers[0].commands.length;
  const error = await assertRejects(() => stale.selectMailbox("Archive"));
  assertEquals((error as Error).message, "imap_lease_released");
  assertEquals(d.servers[0].commands.length, before, "nothing went on the wire");
  // Returning the stale lease again does not take the connection from its holder.
  await stale.logout();
  await current.selectMailbox("INBOX");
  await current.logout();
  assertEquals(pool.stats.idle, 1);
  await pool.closeAll();
});

Deno.test("returned while a command is still in flight: destroyed, not reused", async () => {
  const pool = new ImapPool<ImapClient>();
  const servers: FakeImapServer[] = [];
  const dial = () => {
    const s = new FakeImapServer({
      mailboxes: [{ name: "INBOX", messages: [] }],
      stall: (command) => command.startsWith("STATUS"),
      readTimeoutMs: 50,
    });
    servers.push(s);
    return Promise.resolve(s.client());
  };
  const lease = await pool.checkout("k", {}, dial);
  const pending = lease.mailboxStatus("INBOX").catch(() => "failed");
  await lease.logout();
  assertEquals(servers[0].closed, true);
  assertEquals(await pending, "failed");
  assertEquals(pool.stats.idle, 0);
  await pool.closeAll();
});

Deno.test("a leaked lease is reclaimed after maxLeaseMs and its connection destroyed", async () => {
  let now = 0;
  const pool = new ImapPool<ImapClient>({ maxLeaseMs: 60_000, waitMs: 5, now: () => now });
  const d = dialer();
  const leaked = await pool.checkout("k", { op: "leaker" }, d.dial);
  now += 61_000;
  const next = await pool.checkout("k", { op: "next" }, d.dial);
  assertEquals(d.servers[0].closed, true, "the leaked connection was destroyed");
  assertEquals(d.servers.length, 2);
  await assertRejects(() => leaked.selectMailbox("INBOX"));
  await leaked.logout();
  await next.selectMailbox("INBOX");
  await next.logout();
  assertEquals(pool.stats.idle, 1, "the leaker's late return did not disturb the new lease");
  await pool.closeAll();
});

Deno.test("a failed dial frees the slot and wakes a waiter", async () => {
  const pool = new ImapPool<ImapClient>();
  const d = dialer();
  let fail = true;
  // A connection-level failure. (A REFUSED LOGIN is rule 7: the waiter is
  // answered with it instead of dialling; see server-fixes.test.ts.)
  const flaky = () => (fail ? Promise.reject(new Error("connection reset")) : d.dial());
  const failing = pool.checkout("k", { op: 1 }, async () => {
    await tick(5);
    return await flaky();
  });
  const waiter = pool.checkout("k", { op: 2 }, () => {
    fail = false;
    return d.dial();
  });
  await assertRejects(() => failing, Error, "connection reset");
  const lease = await waiter;
  await lease.selectMailbox("INBOX");
  await lease.logout();
  assertEquals(d.servers.length, 1);
  await pool.closeAll();
});

Deno.test("closeAll: idle connections are logged out and later checkouts are plain dials", async () => {
  const pool = new ImapPool<ImapClient>();
  const d = dialer();
  await (await pool.checkout("a", {}, d.dial)).logout();
  await (await pool.checkout("b", {}, d.dial)).logout();
  await pool.closeAll();
  assertEquals(d.servers.map((s) => s.logoutReceived), [true, true]);
  const after = await pool.checkout("a", {}, d.dial);
  assertEquals(d.servers.length, 3);
  await after.logout();
});
