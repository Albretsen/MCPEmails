// ---------------------------------------------------------------------------
// IMAP cancellation tests.
//
// Handlers bound a slow provider search with `Promise.race` against a timer,
// and `Promise.race` abandons the loser without cancelling it. Two things were
// measured in production as a result:
//
//   1. `ImapSession.close()` calls `logout()`, `logout()` is an ordinary
//      command, and an ordinary command queues on `runExclusive` behind the
//      abandoned UID SEARCH or UID FETCH. Handlers with a 17-second budget were
//      returning at 25 to 36 seconds, waiting on work nobody wanted.
//   2. A handler that simply returns orphans the promise, so nothing closes the
//      socket until the abandoned command settles, and the isolate may be
//      recycled first. Yahoo caps an account at 5 simultaneous IMAP
//      connections, so each orphan burns a slot until the server times it out.
//
// `ImapClient.destroy()` is the primitive that fixes both, and its defining
// property is the one that is easiest to lose in a later refactor: it does NOT
// take the command lock. These tests hold it to that by parking the fake socket
// on a read that never answers, which is exactly the state a timed-out search
// leaves the connection in, and then asserting that destroy still gets out.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { ImapClient } from "./imap-client.ts";
import { ImapSession } from "./imap-session.ts";

const LATIN1 = new TextDecoder("latin1");
const UTF8 = new TextEncoder();

/**
 * A socket that answers only what the script gives it and otherwise parks, so a
 * command can be left mid-flight on purpose. `close()` releases a parked read
 * as end-of-connection, which is what a real close does to a pending read.
 */
class ParkedImapConn {
  readonly chunks: string[] = [];
  closes = 0;
  /** Set to make close() raise, standing in for an already-released socket. */
  throwOnClose = false;
  #inbound: number[] = [];
  #wake: (() => void) | null = null;
  #closed = false;
  readonly #onWrite: (chunk: string, conn: ParkedImapConn) => void;

  constructor(onWrite: (chunk: string, conn: ParkedImapConn) => void = () => {}) {
    this.#onWrite = onWrite;
  }

  write(p: Uint8Array): Promise<number> {
    if (this.#closed) return Promise.reject(new Deno.errors.BadResource("closed"));
    this.chunks.push(LATIN1.decode(p));
    this.#onWrite(this.chunks[this.chunks.length - 1], this);
    return Promise.resolve(p.length);
  }

  send(text: string): void {
    for (const b of UTF8.encode(text)) this.#inbound.push(b);
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  async read(p: Uint8Array): Promise<number | null> {
    while (this.#inbound.length === 0) {
      if (this.#closed) return null;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
    const n = Math.min(p.length, this.#inbound.length);
    for (let i = 0; i < n; i++) p[i] = this.#inbound[i];
    this.#inbound.splice(0, n);
    return n;
  }

  close(): void {
    this.closes++;
    if (this.throwOnClose) throw new Deno.errors.BadResource("already closed");
    this.#closed = true;
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }
}

/** See the note on the same helper in imap-search-charset.test.ts. */
function clientOn(conn: ParkedImapConn): ImapClient {
  const ctor = ImapClient as unknown as { new (conn: unknown): ImapClient };
  return new ctor(conn);
}

/** Let the client reach its parked read before the test does anything else. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// -- destroy() ----------------------------------------------------------------

Deno.test("destroy() cuts short a command that is parked on a read", async () => {
  const conn = new ParkedImapConn();
  const client = clientOn(conn);

  const search = client.uidSearch("ALL");
  await settle();
  assertEquals(conn.chunks, ["A00001 UID SEARCH ALL\r\n"], "the command did go out");
  assert(client.busy, "the command is still in flight");

  const started = Date.now();
  client.destroy();
  const err = await assertRejects(() => search, Error);
  const elapsed = Date.now() - started;

  assertStringIncludes(err.message, "IMAP connection was destroyed");
  assert(
    elapsed < 1500,
    `the abandoned read must settle at once, not on the 15s command timeout (took ${elapsed}ms)`,
  );
  assertEquals(conn.closes, 1);
});

Deno.test("destroy() does not queue behind the command it is cancelling", async () => {
  // The command lock is a promise chain, so a destroy that went through
  // runExclusive would not run until the parked command finished, which is
  // never. Reaching the assertions below at all is the proof it bypassed it.
  const conn = new ParkedImapConn();
  const client = clientOn(conn);

  const search = client.uidSearch("ALL");
  await settle();

  client.destroy();
  assertEquals(conn.closes, 1, "the socket is closed before the parked command settles");

  await assertRejects(() => search, Error);
});

Deno.test("destroy() is idempotent and closes the socket exactly once", () => {
  const conn = new ParkedImapConn();
  const client = clientOn(conn);

  client.destroy();
  client.destroy();
  client.destroy();

  assertEquals(conn.closes, 1);
});

Deno.test("destroy() does not throw when the socket is already gone", () => {
  const conn = new ParkedImapConn();
  conn.throwOnClose = true;
  const client = clientOn(conn);

  client.destroy();
  client.destroy();

  assertEquals(conn.closes, 1, "the second call short-circuits before touching the socket");
});

Deno.test("destroy() after a graceful logout is still safe", async () => {
  const conn = new ParkedImapConn((chunk, c) => {
    if (chunk.includes("LOGOUT")) c.send("* BYE\r\nA00001 OK LOGOUT completed\r\n");
  });
  const client = clientOn(conn);

  await client.logout();
  client.destroy();

  assertEquals(conn.closes, 2, "logout closed it, destroy tried again and was refused politely");
});

Deno.test("a command issued after destroy() fails without writing to the socket", async () => {
  const conn = new ParkedImapConn();
  const client = clientOn(conn);

  client.destroy();
  const err = await assertRejects(() => client.uidSearch("ALL"), Error);

  assertStringIncludes(err.message, "IMAP connection was destroyed");
  assertEquals(conn.chunks, [], "nothing may be written to a destroyed socket");
});

Deno.test("busy reports the socket's outstanding work, queued as well as running", async () => {
  const conn = new ParkedImapConn();
  const client = clientOn(conn);

  assert(!client.busy, "a fresh client owes nothing");

  const first = client.uidSearch("ALL");
  const second = client.uidSearch("UNSEEN");
  await settle();
  assert(client.busy, "one running and one queued command both count");

  client.destroy();
  await assertRejects(() => first, Error);
  await assertRejects(() => second, Error);
  await settle();

  assert(!client.busy, "the count has to come back down or close() never goes gracefully again");
});

Deno.test("logout() on a destroyed connection returns quietly instead of throwing", async () => {
  const conn = new ParkedImapConn();
  const client = clientOn(conn);

  const search = client.uidSearch("ALL");
  await settle();
  client.destroy();
  await assertRejects(() => search, Error);

  // The shutdown path must not become another error for a caller that is
  // already leaving under a deadline.
  await client.logout();
  assertEquals(conn.chunks, ["A00001 UID SEARCH ALL\r\n"], "no LOGOUT is written to a dead socket");
  assertEquals(conn.closes, 1);
});

// -- ImapSession.abort() and the close() preference ----------------------------

/** A session-shaped client that records which shutdown path was taken. */
class RecordingClient {
  logouts = 0;
  destroys = 0;
  busy = false;
  selected: string | null = null;

  selectMailbox(mailbox: string): Promise<void> {
    this.selected = mailbox;
    return Promise.resolve();
  }

  logout(): Promise<void> {
    this.logouts++;
    return Promise.resolve();
  }

  destroy(): void {
    this.destroys++;
  }
}

Deno.test("abort() destroys the connection instead of logging out", async () => {
  const client = new RecordingClient();
  const session = new ImapSession(() => Promise.resolve(client));
  await session.client();

  session.abort();

  assertEquals(client.destroys, 1);
  assertEquals(client.logouts, 0, "a LOGOUT would queue behind the command being abandoned");
});

Deno.test("abort() drops the cached client so the session cannot hand out a dead one", async () => {
  const opened: RecordingClient[] = [];
  const session = new ImapSession(() => {
    const client = new RecordingClient();
    opened.push(client);
    return Promise.resolve(client);
  });

  await session.select("INBOX");
  session.abort();
  const next = await session.select("INBOX");

  assertEquals(opened.length, 2, "the destroyed connection must not be reused");
  assert(next === opened[1]);
  assertEquals(
    session.selectStats,
    { issued: 2, skipped: 0 },
    "a fresh connection has nothing selected, so the SELECT must be reissued",
  );
});

Deno.test("abort() is safe on a session that never connected", () => {
  let opened = 0;
  const session = new ImapSession(() => {
    opened++;
    return Promise.resolve(new RecordingClient());
  });

  session.abort();

  assertEquals(opened, 0);
});

Deno.test("close() destroys rather than logs out while a command is still in flight", async () => {
  const client = new RecordingClient();
  const session = new ImapSession(() => Promise.resolve(client));
  await session.client();
  client.busy = true;

  await session.close();

  assertEquals(client.destroys, 1);
  assertEquals(client.logouts, 0, "this is the 8-to-19-second wait the fix exists to remove");
});

Deno.test("close() still logs out gracefully when the socket owes nothing", async () => {
  const client = new RecordingClient();
  const session = new ImapSession(() => Promise.resolve(client));
  await session.client();

  await session.close();

  assertEquals(client.logouts, 1, "an idle connection is returned to the provider politely");
  assertEquals(client.destroys, 0);
});

Deno.test("close() logs out for a client that does not implement cancellation", async () => {
  // The interface makes `busy` and `destroy` optional so older fakes and any
  // minimal client keep working. Such a client must take the old path.
  const client = {
    logouts: 0,
    selectMailbox: () => Promise.resolve(),
    logout(): Promise<void> {
      this.logouts++;
      return Promise.resolve();
    },
  };
  const session = new ImapSession(() => Promise.resolve(client));
  await session.client();

  await session.close();

  assertEquals(client.logouts, 1);
});
