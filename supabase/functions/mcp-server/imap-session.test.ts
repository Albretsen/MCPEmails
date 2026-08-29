// ---------------------------------------------------------------------------
// IMAP session-reuse tests.
//
// Two things can go wrong when you stop opening a connection per unit of work,
// and both are worse than the slowness the reuse fixes:
//
//   1. CONCURRENCY. `ImapClient` multiplexes one socket with one shared read
//      buffer and one tag stream. Overlapping commands corrupt it — a
//      `Promise.allSettled` STATUS fan-out once caused 100% folder_list
//      failure, which is why `runExclusive` exists. The session must never be
//      the thing that reintroduces that.
//   2. WRONG MAILBOX. Skipping a "redundant" SELECT is only safe while the
//      session's idea of the selected mailbox is exactly the server's. Get that
//      wrong on a delete and mail disappears from a folder nobody named.
//
// The fake client below fails loudly on both: it throws if a second command
// starts before the first resolves, and it records every command against the
// mailbox that was actually selected at the time.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { ImapSession, withImapSession } from "./imap-session.ts";

interface Call {
  command: string;
  mailbox: string | null;
}

/**
 * Stands in for `ImapClient`. Deliberately does NOT serialize internally: the
 * real client does, and a fake that also did would hide a caller that issues
 * overlapping commands rather than expose it.
 */
class FakeImapClient {
  readonly calls: Call[] = [];
  selected: string | null = null;
  loggedOut = false;
  #inFlight = false;
  /** Mailboxes SELECT should reject, so failure handling can be exercised. */
  missingMailboxes = new Set<string>();
  /** Commands that should throw once, to exercise the invalidate-on-error path. */
  failCommandOnce = new Set<string>();

  async #exclusive<T>(command: string, fn: () => T | Promise<T>): Promise<T> {
    if (this.#inFlight) {
      throw new Error(
        `concurrent IMAP command: ${command} started while another was in flight`,
      );
    }
    this.#inFlight = true;
    try {
      // Yield so a genuinely concurrent caller has a turn to interleave and be
      // caught. Without this an overlapping call could complete synchronously
      // and slip past the guard.
      await Promise.resolve();
      return await fn();
    } finally {
      this.#inFlight = false;
    }
  }

  selectMailbox(mailbox: string): Promise<void> {
    return this.#exclusive("SELECT", () => {
      if (this.missingMailboxes.has(mailbox)) {
        // A real SELECT failure leaves the connection's selection undefined.
        this.selected = null;
        throw new Error(`Mailbox not found: ${mailbox}`);
      }
      this.selected = mailbox;
      this.calls.push({ command: "SELECT", mailbox });
    });
  }

  command(name: string): Promise<void> {
    return this.#exclusive(name, () => {
      if (this.failCommandOnce.delete(name)) throw new Error(`${name} failed`);
      this.calls.push({ command: name, mailbox: this.selected });
    });
  }

  logout(): Promise<void> {
    this.loggedOut = true;
    return Promise.resolve();
  }
}

Deno.test("a session opens one connection however many groups it serves", async () => {
  let opened = 0;
  const client = new FakeImapClient();
  const session = new ImapSession(() => {
    opened++;
    return Promise.resolve(client);
  });

  for (const folder of ["INBOX", "Archive", "Receipts"]) {
    const c = await session.select(folder);
    await c.command("UID MOVE");
  }
  await session.close();

  assertEquals(opened, 1, "three folder groups must share one handshake");
  assertEquals(session.connectCount, 1);
  assert(client.loggedOut, "the session must log out or it holds a connection slot");
});

Deno.test("a session is lazy: no ids, no connection", async () => {
  let opened = 0;
  await withImapSession(() => {
    opened++;
    return Promise.resolve(new FakeImapClient());
  }, () => Promise.resolve(undefined));
  assertEquals(opened, 0);
});

Deno.test("a redundant SELECT of the already-current mailbox is elided", async () => {
  const client = new FakeImapClient();
  const session = new ImapSession(() => Promise.resolve(client));

  // The email_read_batch shape: fifty reads, all out of INBOX.
  for (let i = 0; i < 50; i++) {
    const c = await session.select("INBOX");
    await c.command("UID FETCH");
  }
  await session.close();

  assertEquals(client.calls.filter((c) => c.command === "SELECT").length, 1);
  assertEquals(session.selectStats, { issued: 1, skipped: 49 });
});

Deno.test("every command runs against the mailbox its group actually asked for", async () => {
  // The correctness half of the SELECT skip. Grouping is not an optimisation on
  // IMAP — a UID is only meaningful inside its mailbox — so a command attributed
  // to the wrong SELECT is mail moved out of the wrong folder.
  const client = new FakeImapClient();
  const session = new ImapSession(() => Promise.resolve(client));

  const groups: [string, string][] = [
    ["INBOX", "MOVE-inbox"],
    ["INBOX", "MOVE-inbox-again"],
    ["Archive", "MOVE-archive"],
    ["INBOX", "MOVE-inbox-third"],
  ];
  for (const [folder, cmd] of groups) {
    const c = await session.select(folder);
    await c.command(cmd);
  }
  await session.close();

  const moves = client.calls.filter((c) => c.command.startsWith("MOVE"));
  assertEquals(moves, [
    { command: "MOVE-inbox", mailbox: "INBOX" },
    { command: "MOVE-inbox-again", mailbox: "INBOX" },
    { command: "MOVE-archive", mailbox: "Archive" },
    { command: "MOVE-inbox-third", mailbox: "INBOX" },
  ]);
  // Back to INBOX after Archive must re-SELECT; only the adjacent repeat is free.
  assertEquals(session.selectStats, { issued: 3, skipped: 1 });
});

Deno.test("a new connection never inherits the old one's selected mailbox", async () => {
  // The nastiest possible version of this bug: reconnect, believe INBOX is
  // still selected, and issue a UID command against whatever the fresh
  // connection actually has open.
  const first = new FakeImapClient();
  const second = new FakeImapClient();
  const clients = [first, second];
  const session = new ImapSession(() => Promise.resolve(clients.shift()!));

  const a = await session.select("INBOX");
  await a.command("UID MOVE");
  await session.invalidate();

  const b = await session.select("INBOX");
  await b.command("UID MOVE");
  await session.close();

  assertEquals(second.calls[0], { command: "SELECT", mailbox: "INBOX" });
  assertEquals(second.calls[1], { command: "UID MOVE", mailbox: "INBOX" });
});

Deno.test("a failed SELECT does not leave a stale selection behind", async () => {
  const client = new FakeImapClient();
  client.missingMailboxes.add("Nope");
  const session = new ImapSession(() => Promise.resolve(client));

  await session.select("INBOX");
  await assertRejects(() => session.select("Nope"));

  // If the failed SELECT had left "INBOX" memoised, the next INBOX group would
  // skip its SELECT while the server has nothing selected.
  const c = await session.select("INBOX");
  await c.command("UID STORE");
  await session.close();

  assertEquals(client.calls, [
    { command: "SELECT", mailbox: "INBOX" },
    { command: "SELECT", mailbox: "INBOX" },
    { command: "UID STORE", mailbox: "INBOX" },
  ]);
});

Deno.test("invalidate reconnects so one group's failure does not poison the rest", async () => {
  // Before connection reuse each folder group had its own connection and was
  // independently recoverable. Reuse must not turn one bad group into every
  // later group failing on a desynchronised socket.
  const first = new FakeImapClient();
  first.failCommandOnce.add("UID MOVE");
  const second = new FakeImapClient();
  const clients = [first, second];
  let opened = 0;
  const session = new ImapSession(() => {
    opened++;
    return Promise.resolve(clients.shift()!);
  });

  const a = await session.select("INBOX");
  let threw = false;
  try {
    await a.command("UID MOVE");
  } catch {
    threw = true;
    await session.invalidate();
  }
  assert(threw);

  const b = await session.select("Archive");
  await b.command("UID MOVE");
  await session.close();

  assertEquals(opened, 2);
  assert(first.loggedOut, "the failed connection must be released, not leaked");
  assertEquals(second.calls, [
    { command: "SELECT", mailbox: "Archive" },
    { command: "UID MOVE", mailbox: "Archive" },
  ]);
});

Deno.test("the session issues commands serially, never overlapping on one socket", async () => {
  // The regression guard for the incident that made runExclusive exist. The
  // fake throws on overlap, so this passes only if every command is awaited
  // before the next is issued.
  const client = new FakeImapClient();
  const session = new ImapSession(() => Promise.resolve(client));

  const folders = ["INBOX", "Archive", "Receipts", "INBOX", "Spam"];
  for (const folder of folders) {
    const c = await session.select(folder);
    await c.command("UID SEARCH");
    await c.command("UID FETCH");
  }
  await session.close();

  assertEquals(client.calls.filter((c) => c.command === "UID FETCH").length, 5);
});

Deno.test("a deliberately concurrent caller is caught by the fake, so the guard is real", async () => {
  // Proves the previous test is not vacuous: fan out on one client and the
  // overlap detector fires. This is the shape that must never appear in
  // index.ts — parallelism has to come from separate clients.
  const client = new FakeImapClient();
  const session = new ImapSession(() => Promise.resolve(client));
  const c = await session.client();

  const results = await Promise.allSettled([
    c.command("STATUS-a"),
    c.command("STATUS-b"),
    c.command("STATUS-c"),
  ]);
  await session.close();

  assert(
    results.some((r) => r.status === "rejected"),
    "overlapping commands on one client must be detectable",
  );
});

Deno.test("withImapSession closes the connection even when the body throws", async () => {
  const client = new FakeImapClient();
  await assertRejects(() =>
    withImapSession(() => Promise.resolve(client), async (session) => {
      await session.select("INBOX");
      throw new Error("boom");
    })
  );
  // A leaked connection counts against the account's simultaneous-connection
  // cap until the server times it out — which is what makes the NEXT call slow.
  assert(client.loggedOut);
});

Deno.test("a closed session refuses further work rather than silently reconnecting", async () => {
  const session = new ImapSession(() => Promise.resolve(new FakeImapClient()));
  await session.select("INBOX");
  await session.close();
  await assertRejects(() => session.client(), Error, "imap_session_closed");
});
