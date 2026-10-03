// ---------------------------------------------------------------------------
// IMAP phase timings.
//
// After 2026-10-02 the database side of a tools/call is about 0.7 s and the
// rest is the mailbox, and until now nothing recorded where in the mailbox the
// time went. These tests hold the record to the three things it has to be:
//
//   1. COMPLETE. Every command a connection issues is charged to a phase, a
//      connection-limit retry shows up as attempts and back-off, and a call
//      that never touched IMAP adds nothing to its log line.
//   2. VALUE-FREE. Numbers only. A folder name, a subject, an address or a
//      hostname must not be able to reach the log line through it.
//   3. PER REQUEST. Two calls in one isolate do not see each other's numbers.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import { ImapClient, ImapConnectionLimitError } from "./imap-client.ts";
import { FakeImapServer, fakeTextMessage } from "./imap-fake-server.ts";
import { currentImapTimings, ImapCallTimings, imapTimingStore } from "./imap-timing.ts";

const SECRET_FOLDER = "Zebra Quartz Ledger 7731";
const SECRET_SUBJECT = "Walrus Invoice 55210";

function secretServer(): FakeImapServer {
  return new FakeImapServer({
    mailboxes: [
      { name: "INBOX", messages: [] },
      {
        name: SECRET_FOLDER,
        messages: [1, 2, 3, 4, 5].map((uid) =>
          fakeTextMessage(uid, { subject: SECRET_SUBJECT, seen: uid % 2 === 0 })
        ),
      },
    ],
  });
}

Deno.test("every command is charged to its phase, with search hits and fetch bytes", async () => {
  const timings = new ImapCallTimings();
  const server = secretServer();
  await imapTimingStore.run(timings, async () => {
    const client = server.client();
    await client.selectMailbox(SECRET_FOLDER);
    const uids = await client.uidSearch("ALL");
    await client.fetchSummaries(uids);
    await client.fetchMessageRaw(3);
    await client.listMailboxes();
    await client.mailboxStatus("INBOX");
    await client.markSeen(1).catch(() => {});
    await client.logout();
  });

  assertEquals(timings.commands, 8, "one entry per command on the wire");
  assertEquals(timings.commands, server.commands.length);
  assertEquals(timings.searchUidCount, 5);
  // Two FETCH replies went by: five summaries with their previews, then one
  // whole message. Both are far larger than any other reply in this exchange.
  const rawBytes = server.mailboxes[1].messages[2].raw.length;
  assert(timings.fetchBytes > rawBytes, `fetch_bytes ${timings.fetchBytes} covers the raw message`);
  assert(timings.fetchBytes < rawBytes + 5 * 2048, "and nothing but the two FETCH replies");
  for (const phase of ["select", "search", "fetch", "list", "status", "logout", "other"] as const) {
    assert(timings.phaseMs(phase) >= 0, `${phase} is recorded`);
  }
});

Deno.test("a call that never opened an IMAP connection adds nothing to the log line", () => {
  assertEquals(new ImapCallTimings().logFields(), null);
});

Deno.test("outside a request nothing is recorded and nothing breaks", async () => {
  assertEquals(currentImapTimings(), null);
  const server = secretServer();
  const client = server.client();
  await client.selectMailbox("INBOX");
  await client.logout();
  assert(server.closed, "the connection still closes");
});

Deno.test("the log fields are numbers under fixed names, and carry no mailbox data", async () => {
  const timings = new ImapCallTimings();
  const server = secretServer();
  await imapTimingStore.run(timings, async () => {
    const client = server.client();
    await client.selectMailbox(SECRET_FOLDER);
    await client.fetchSummaries(await client.uidSearch("ALL"));
    await client.logout();
  });
  // A connect is what turns the record on; these clients were built on a fake
  // socket, so say one happened.
  timings.connectAttempts = 1;
  timings.connects = 1;

  const fields = timings.logFields();
  assert(fields !== null);
  assertEquals(Object.keys(fields).sort(), [
    "connect_attempts",
    "connect_auth_ms",
    "connect_backoff_ms",
    "connect_dial_ms",
    "connect_ms",
    "connect_tls_ms",
    "fetch_bytes",
    "fetch_ms",
    "imap_commands",
    "imap_connects",
    "list_ms",
    "logout_deferred",
    "logout_ms",
    "other_ms",
    "search_ms",
    "search_uid_count",
    "select_ms",
    "status_ms",
  ]);
  for (const [name, value] of Object.entries(fields)) {
    assertEquals(typeof value, "number", name);
    assert(Number.isInteger(value) && value >= 0, `${name} is a non-negative integer`);
  }
  const line = JSON.stringify(fields);
  for (const secret of [SECRET_FOLDER, SECRET_SUBJECT, "example.com", "sender", "Zebra", "Walrus"]) {
    assert(!line.includes(secret), `the log fields must not contain ${secret}`);
  }
});

Deno.test("two requests in one isolate keep separate records", async () => {
  const first = new ImapCallTimings();
  const second = new ImapCallTimings();
  const run = (timings: ImapCallTimings, searches: number) =>
    imapTimingStore.run(timings, async () => {
      const client = secretServer().client();
      await client.selectMailbox(SECRET_FOLDER);
      for (let i = 0; i < searches; i++) await client.uidSearch("ALL");
      await client.logout();
    });
  await Promise.all([run(first, 1), run(second, 3)]);
  assertEquals(first.searchUidCount, 5);
  assertEquals(second.searchUidCount, 15);
  assertEquals(first.commands, 3);
  assertEquals(second.commands, 5);
});

Deno.test("a command queued behind another is timed from when it gets the socket", async () => {
  const timings = new ImapCallTimings();
  await imapTimingStore.run(timings, async () => {
    const client = secretServer().client();
    // Issued without awaiting in between: the second waits on the first.
    const select = client.selectMailbox(SECRET_FOLDER);
    const search = client.uidSearch("ALL");
    await Promise.all([select, search]);
    await client.logout();
  });
  assertEquals(timings.commands, 3);
  assertEquals(timings.searchUidCount, 5);
});

// -- connect: attempts and back-off -------------------------------------------
//
// ImapClient.connect dials a real socket, so the one-attempt step is replaced
// and the 5 s and 10 s sleeps are shortened. What is under test is the
// bookkeeping around the loop, which is untouched by either substitution.

type ConnectOnce = (cfg: unknown, timing: unknown) => Promise<ImapClient>;

async function withStubbedConnect<T>(
  connectOnce: ConnectOnce,
  fn: () => Promise<T>,
): Promise<T> {
  const holder = ImapClient as unknown as { connectOnce: ConnectOnce };
  const realConnectOnce = holder.connectOnce;
  const realSetTimeout = globalThis.setTimeout;
  holder.connectOnce = connectOnce;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).setTimeout = (handler: () => void, ms?: number) =>
    realSetTimeout(handler, ms !== undefined && ms >= 5000 ? 20 : ms);
  try {
    return await fn();
  } finally {
    holder.connectOnce = realConnectOnce;
    globalThis.setTimeout = realSetTimeout;
  }
}

const CONFIG = { host: "imap.example.com", port: 993, email: "owner@example.com", password: "x" };

Deno.test("a connection-limit refusal that is retried and then succeeds is visible", async () => {
  const timings = new ImapCallTimings();
  let calls = 0;
  const server = secretServer();
  await withStubbedConnect(
    () => {
      calls++;
      if (calls === 1) {
        return Promise.reject(new ImapConnectionLimitError("IMAP connection refused at greeting"));
      }
      return Promise.resolve(server.client());
    },
    () =>
      imapTimingStore.run(timings, async () => {
        const client = await ImapClient.connect(CONFIG);
        await client.logout();
      }),
  );

  const fields = timings.logFields();
  assert(fields !== null);
  assertEquals(fields.connect_attempts, 2);
  assertEquals(fields.imap_connects, 1);
  assert(fields.connect_backoff_ms >= 10, `the sleep is recorded (${fields.connect_backoff_ms} ms)`);
  assert(fields.connect_ms >= fields.connect_backoff_ms, "and is inside connect_ms");
  // The record has no string field at all, so it cannot carry the host.
  assert(
    Object.values(fields).every((value) => typeof value === "number"),
    "the host is not in the record: every field is a number",
  );
});

Deno.test("retries that run out are recorded too, and the error is unchanged", async () => {
  const timings = new ImapCallTimings();
  let message = "";
  await withStubbedConnect(
    () => Promise.reject(new ImapConnectionLimitError("IMAP connection refused at auth")),
    () =>
      imapTimingStore.run(timings, async () => {
        try {
          await ImapClient.connect(CONFIG);
        } catch (err) {
          assert(err instanceof ImapConnectionLimitError);
          message = err.message;
        }
      }),
  );
  assert(message.startsWith("IMAP connection limit reached for imap.example.com after 3 attempts"));
  const fields = timings.logFields();
  assert(fields !== null);
  assertEquals(fields.connect_attempts, 3);
  assertEquals(fields.imap_connects, 0);
});

Deno.test("an auth failure is one attempt, no back-off, and is rethrown as it was", async () => {
  const timings = new ImapCallTimings();
  const failure = new Error("IMAP authentication failed: nope");
  let caught: unknown = null;
  await withStubbedConnect(
    () => Promise.reject(failure),
    () =>
      imapTimingStore.run(timings, async () => {
        try {
          await ImapClient.connect(CONFIG);
        } catch (err) {
          caught = err;
        }
      }),
  );
  assert(caught === failure, "the very same error object");
  const fields = timings.logFields();
  assert(fields !== null);
  assertEquals(fields.connect_attempts, 1);
  assertEquals(fields.connect_backoff_ms, 0);
});

// -- wiring -------------------------------------------------------------------
// index.ts boots the server at import, so its handlers cannot be run from a
// test. The two lines that connect this module to the log are pinned as text,
// the same way search-phase-wiring.test.ts pins the session wiring.

const INDEX = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("handleRequest opens one timing record per request", () => {
  assert(
    /imapTimingStore\.run\(new ImapCallTimings\(\), \(\) => handleMeteredRequest\(req\)\)/.test(INDEX),
  );
});

Deno.test("the tools/call log line carries the record and nothing else from it", () => {
  const logLine = /console\.log\("\[mcp-server\] tools\/call", \{[\s\S]*?\n  \}\);/.exec(INDEX);
  assert(logLine, "the tools/call log line");
  assert(logLine[0].includes("...(imapTimingStore.getStore()?.logFields() ?? {})"));
  // The code of the statement, without the comments that describe it.
  const code = logLine[0].split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  for (const forbidden of ["imap_host", "email_address", "folder", "subject"]) {
    assert(!code.includes(forbidden), `the log line must not name ${forbidden}`);
  }
});
