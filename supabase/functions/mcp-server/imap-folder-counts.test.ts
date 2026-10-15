// ---------------------------------------------------------------------------
// folder_list counts: LIST-STATUS, pipelined STATUS, and the old path behind
// both.
//
// A folder listing was one LIST and then up to 25 STATUS commands, each sent
// only after the previous one had answered. The counts now come with the LIST
// where the server offers LIST-STATUS (RFC 5819), and otherwise from the same
// STATUS commands written a batch at a time. Held here:
//
//   1. THE OUTPUT IS THE SAME. `legacyFolders` is the implementation this
//      replaces, kept verbatim, and every scenario is run through both.
//   2. THE WIRE IS SHORTER. 26 round trips become 1 (LIST-STATUS) or 4.
//   3. DOUBT FALLS BACK. A refused LIST-STATUS, a STATUS line for the wrong
//      mailbox, completions out of order: each ends on the original serial
//      STATUS, and each still gives the original answer.
//   4. THE MUTEX CONTRACT HOLDS. A pipelined batch is one command body; a
//      command issued while it runs waits for all of it.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import { capabilitiesAfterAuth, type ImapClient } from "./imap-client.ts";
import {
  type FakeMailbox,
  FakeImapServer,
  type FakeServerOptions,
  fakeTextMessage,
} from "./imap-fake-server.ts";
import { listImapFoldersWithCounts } from "./imap-folder-counts.ts";
import { ImapCallTimings, imapTimingStore } from "./imap-timing.ts";

interface FolderEntry {
  id: string;
  name: string;
  type: "folder";
  total_messages: number | null;
  unread_messages: number | null;
}

const COUNT_LIMIT = 25;

/**
 * imapListFolders exactly as index.ts had it before 2026-10-02, from the LIST
 * to the returned entries. The reference; do not "improve" it.
 */
async function legacyFolders(client: ImapClient): Promise<FolderEntry[]> {
  const mailboxes = await client.listMailboxes();
  const IMAP_FOLDER_COUNT_LIMIT = 25;
  const enrichCount = Math.min(mailboxes.length, IMAP_FOLDER_COUNT_LIMIT);
  const statuses = await Promise.allSettled(
    mailboxes.slice(0, enrichCount).map((mb) => client!.mailboxStatus(mb.name)),
  );
  return mailboxes.map((mb, i) => {
    const st = i < enrichCount ? statuses[i] : undefined;
    return {
      id: mb.name,
      name: mb.name,
      type: "folder" as const,
      total_messages: st?.status === "fulfilled" ? st.value.messages : null,
      unread_messages: st?.status === "fulfilled" ? st.value.unseen : null,
    };
  });
}

/** imapListFolders as it is now: the helper, then the same mapping. */
async function currentFolders(client: ImapClient): Promise<FolderEntry[]> {
  const { mailboxes, counts } = await listImapFoldersWithCounts(client, COUNT_LIMIT);
  return mailboxes.map((mb, i) => ({
    id: mb.name,
    name: mb.name,
    type: "folder" as const,
    total_messages: counts[i]?.messages ?? null,
    unread_messages: counts[i]?.unseen ?? null,
  }));
}

function box(name: string, total: number, unread: number, extra: Partial<FakeMailbox> = {}): FakeMailbox {
  const messages = [];
  for (let i = 0; i < total; i++) messages.push(fakeTextMessage(i + 1, { seen: i >= unread }));
  return { name, attrs: ["\\HasNoChildren"], messages, ...extra };
}

/** Thirty mailboxes: awkward names, a \Noselect parent, one that refuses STATUS. */
function account(): FakeMailbox[] {
  const boxes: FakeMailbox[] = [
    box("INBOX", 7, 3),
    box("Sent", 4, 0, { attrs: ["\\HasNoChildren", "\\Sent"] }),
    box("Drafts", 1, 1, { attrs: ["\\Drafts"] }),
    box("Archive (old)", 2, 1),
    box("Kunder & Avtaler", 3, 2),
    box("Fakturaer 2026", 5, 0),
    box("Søppel", 2, 2, { attrs: ["\\Trash"] }),
    box("Projects", 0, 0, { attrs: ["\\Noselect", "\\HasChildren"] }),
    box("Projects/Alpha", 6, 4),
    box("Locked", 9, 9, { statusFails: true }),
  ];
  // Sorted by name, the ten above land among the first 25 and five of the
  // "Zeta" mailboxes fall past the cap.
  for (let i = 0; i < 12; i++) boxes.push(box(`Folder ${String(i).padStart(2, "0")}`, i % 5, i % 3 === 0 ? 0 : 1));
  for (let i = 0; i < 8; i++) boxes.push(box(`Zeta ${i}`, i + 1, 1));
  return boxes;
}

function serverFor(extra: Partial<FakeServerOptions> = {}, mailboxes = account()): FakeImapServer {
  return new FakeImapServer({ mailboxes, ...extra });
}

/** The post-login capability list, as connectOnce would have recorded it. */
function withCapabilities(client: ImapClient, capabilities: string[] | null): ImapClient {
  (client as unknown as { capabilities: Set<string> | null }).capabilities = capabilities
    ? new Set(capabilities)
    : null;
  return client;
}

async function both(
  extra: Partial<FakeServerOptions>,
  capabilities: string[] | null,
  mailboxes: () => FakeMailbox[] = account,
): Promise<{ before: FolderEntry[]; after: FolderEntry[]; old: FakeImapServer; now: FakeImapServer }> {
  const old = serverFor(extra, mailboxes());
  const before = await legacyFolders(withCapabilities(old.client(), capabilities));
  const now = serverFor(extra, mailboxes());
  const after = await currentFolders(withCapabilities(now.client(), capabilities));
  return { before, after, old, now };
}

const STATUS_ITEMS = "(MESSAGES UNSEEN RECENT UIDNEXT UIDVALIDITY)";

// -- without LIST-STATUS: pipelined STATUS ------------------------------------

Deno.test("no LIST-STATUS: same output, 26 round trips become 4", async () => {
  const { before, after, old, now } = await both({}, null);
  assertEquals(after, before);
  assertEquals(before.length, 30, "every mailbox is listed");
  assertEquals(before.filter((f) => f.total_messages !== null).length, 23, "25 asked, 2 refused");
  assertEquals(before.slice(25).every((f) => f.total_messages === null), true, "none past the cap");

  assertEquals(old.roundTrips, 26, "LIST and 25 STATUS, one at a time");
  assertEquals(now.roundTrips, 4, "LIST and three pipelined writes (12 + 12 + 1)");
  assertEquals(now.commands, old.commands, "the very same commands, in the same order");
  assert(now.commands.slice(1).every((c) => c.startsWith("STATUS ") && c.endsWith(STATUS_ITEMS)));
});

Deno.test("a \\Noselect mailbox and a mailbox that refuses STATUS have null counts, as before", async () => {
  const { before, after } = await both({}, null);
  for (const name of ["Projects", "Locked"]) {
    const was = before.find((f) => f.name === name);
    const is = after.find((f) => f.name === name);
    assertEquals(was?.total_messages, null, name);
    assertEquals(is, was, name);
  }
  const inbox = after.find((f) => f.name === "INBOX");
  assertEquals([inbox?.total_messages, inbox?.unread_messages], [7, 3]);
  const awkward = after.find((f) => f.name === "Archive (old)");
  assertEquals([awkward?.total_messages, awkward?.unread_messages], [2, 1]);
  const nonAscii = after.find((f) => f.name === "Søppel");
  assertEquals([nonAscii?.total_messages, nonAscii?.unread_messages], [2, 2]);
});

Deno.test("fewer mailboxes than the cap, and none at all", async () => {
  const few = await both({}, null, () => account().slice(0, 3));
  assertEquals(few.after, few.before);
  assertEquals(few.now.roundTrips, 2, "LIST and one pipelined write");

  const none = await both({}, null, () => []);
  assertEquals(none.after, []);
  assertEquals(none.before, []);
  assertEquals(none.now.commands, ['LIST "" "*"']);
});

// -- with LIST-STATUS ---------------------------------------------------------

Deno.test("LIST-STATUS: same output from one command, plus one write for what it left out", async () => {
  const { before, after, old, now } = await both({ listStatus: true }, ["IMAP4REV1", "LIST-STATUS"]);
  assertEquals(after, before);
  assertEquals(old.roundTrips, 26);
  assertEquals(now.commands[0], 'LIST "" "*" RETURN (STATUS (MESSAGES UNSEEN))');
  // The server sent no STATUS line for the \Noselect parent or the mailbox it
  // will not STATUS. Those two are asked the old way, in one pipelined write,
  // and answer NO exactly as they did before.
  assertEquals(now.commands.slice(1).map((c) => c.split(" (")[0]).sort(), [
    'STATUS "Locked"',
    'STATUS "Projects"',
  ]);
  assertEquals(now.roundTrips, 2);
});

Deno.test("LIST-STATUS knows every mailbox, and still only the first 25 get counts", async () => {
  const { before, after } = await both({ listStatus: true }, ["LIST-STATUS"]);
  assertEquals(after.slice(25).map((f) => f.total_messages), [null, null, null, null, null]);
  assertEquals(after.slice(25), before.slice(25));
});

Deno.test("LIST-STATUS with every mailbox answered is a single round trip", async () => {
  const plain = () => account().filter((m) => !m.statusFails && !m.attrs?.includes("\\Noselect")).slice(0, 12);
  const { before, after, now } = await both({ listStatus: true }, ["LIST-STATUS"], plain);
  assertEquals(after, before);
  assertEquals(now.roundTrips, 1);
  assertEquals(now.commands.length, 1);
});

Deno.test("a server that advertises LIST-STATUS and then refuses it gets the plain LIST", async () => {
  // `listStatus: false` makes the scripted server answer BAD to RETURN.
  const { before, after, now } = await both({ listStatus: false }, ["LIST-STATUS"]);
  assertEquals(after, before);
  assertEquals(now.commands.slice(0, 2), [
    'LIST "" "*" RETURN (STATUS (MESSAGES UNSEEN))',
    'LIST "" "*"',
  ]);
  assertEquals(now.roundTrips, 5);
});

Deno.test("the pre-login capability list is not consulted: unknown means not used", async () => {
  const { after, before, now } = await both({ listStatus: true }, null);
  assertEquals(after, before);
  assertEquals(now.commands[0], 'LIST "" "*"');
});

// -- doubt falls back to the serial STATUS ------------------------------------

Deno.test("a STATUS line naming another mailbox is not trusted: each is asked again, serially", async () => {
  const mangle = { statusName: (name: string) => `${name}.x` };
  const { before, after, old, now } = await both(mangle, null);
  assertEquals(after, before, "the serial path never checked the name, and its answer stands");
  // 23 answered OK under a name that did not match, so 23 are asked again.
  assertEquals(now.commands.length, old.commands.length + 23);
  assertEquals(now.roundTrips, 4 + 23);
});

Deno.test("LIST-STATUS lines naming a mailbox the LIST did not: none trusted, all asked", async () => {
  const mangle = { listStatus: true, statusName: (name: string) => `${name}.x` };
  const { before, after, now } = await both(mangle, ["LIST-STATUS"]);
  assertEquals(after, before);
  assertEquals(now.commands.filter((c) => c.startsWith("STATUS ")).length, 25 + 23);
});

Deno.test("completions that come back out of order are not paired by position", async () => {
  const { before, after, now } = await both({ reversePipelined: true }, null);
  assertEquals(after, before);
  assert(now.commands.length > 26, "the doubtful batches were asked again one at a time");
});

Deno.test("a connection that drops mid-batch leaves null counts and still returns the list", async () => {
  let statuses = 0;
  const server = serverFor({
    onCommand: (command, srv) => {
      if (command.startsWith("STATUS ") && ++statuses === 14) srv.hangUp();
    },
  });
  const folders = await currentFolders(server.client());
  assertEquals(folders.length, 30, "every mailbox is still listed");
  assertEquals(folders.map((f) => f.name), (await legacyFolders(serverFor().client())).map((f) => f.name));
  assert(folders.slice(0, 12).some((f) => f.total_messages !== null), "the first batch was read");
  assert(folders.slice(12).every((f) => f.total_messages === null), "nothing after the drop is guessed");
});

Deno.test("doubt followed by a dropped connection is left unknown, not asked again on a dead socket", async () => {
  let statuses = 0;
  const server = serverFor({
    // The first batch comes back out of order (so it is in doubt), and the
    // server dies during the second.
    reversePipelined: true,
    onCommand: (command, srv) => {
      if (command.startsWith("STATUS ") && ++statuses === 14) srv.hangUp();
    },
  });
  const folders = await currentFolders(server.client());
  assertEquals(folders.length, 30);
  assert(folders.every((f) => f.total_messages === null), "no count is guessed");
  assertEquals(server.commands.filter((c) => c.startsWith("STATUS ")).length, 14, "and nothing was re-asked");
});

Deno.test("doubt followed by a timeout is left unknown: a late reply must not answer a re-ask", async () => {
  // The first batch comes back out of order, so it is in doubt. The second
  // batch gets no answer in time. Its replies are still on their way, and
  // would arrive in front of the answer to anything asked next, so a re-ask
  // of the first batch would read another mailbox's STATUS line as its own.
  let statuses = 0;
  const server = serverFor({
    reversePipelined: true,
    readTimeoutMs: 30,
    stall: (command) => command.startsWith("STATUS ") && ++statuses > 12,
  });
  const folders = await currentFolders(server.client());
  assertEquals(folders.length, 30);
  assert(folders.every((f) => f.total_messages === null), "no count is guessed");
  assertEquals(
    server.commands.filter((c) => c.startsWith("STATUS ")).length,
    24,
    "two batches were written and nothing was asked again",
  );
});

Deno.test("a LIST that fails still fails with the error it always had", async () => {
  for (const capabilities of [null, ["LIST-STATUS"]]) {
    const server = serverFor({
      listStatus: true,
      refuse: (command) => command.startsWith("LIST ") ? "NO [UNAVAILABLE] try later" : null,
    });
    let message = "";
    try {
      await currentFolders(withCapabilities(server.client(), capabilities));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    assertEquals(message, "LIST failed: [UNAVAILABLE] try later");
  }
});

// -- the mutex contract -------------------------------------------------------

Deno.test("a pipelined batch is one command body: nothing interleaves with it", async () => {
  const server = serverFor();
  const client = server.client();
  const names = (await client.listMailboxes()).slice(0, 25).map((m) => m.name);

  // Issued together, the way a careless caller would. The SELECT must not
  // reach the wire until every STATUS of the batch has been answered.
  const batch = client.mailboxStatusPipelined(names);
  const select = client.selectMailbox("INBOX");
  const [statuses] = await Promise.all([batch, select]);

  assertEquals(statuses.length, 25);
  const selectAt = server.commands.indexOf('SELECT "INBOX"');
  assertEquals(selectAt, server.commands.length - 1, "SELECT is the last command on the wire");
  assertEquals(server.commands.slice(1, selectAt).every((c) => c.startsWith("STATUS ")), true);
  assert(!client.busy);
});

Deno.test("the pipelined STATUS answers what the serial STATUS answers, mailbox by mailbox", async () => {
  const serial = serverFor().client();
  const names = (await serial.listMailboxes()).map((m) => m.name);
  const expected = [];
  for (const name of names) expected.push(await serial.mailboxStatus(name).catch(() => null));

  const piped = await serverFor().client().mailboxStatusPipelined(names);
  assertEquals(piped, expected);
});

Deno.test("a name that cannot go on the wire is null and does not sink the batch", async () => {
  const piped = await serverFor().client().mailboxStatusPipelined(["INBOX", "bad\r\nname", "Sent"]);
  assertEquals(piped[1], null);
  assert(piped[0] !== null && piped[0] !== "unsure" && piped[0].messages === 7);
  assert(piped[2] !== null && piped[2] !== "unsure" && piped[2].messages === 4);
});

Deno.test("the whole batch is charged to the status phase as one command", async () => {
  const timings = new ImapCallTimings();
  await imapTimingStore.run(timings, async () => {
    await currentFolders(serverFor().client());
  });
  assertEquals(timings.commands, 2, "one LIST, one pipelined batch");
  assert(timings.phaseMs("status") >= 0 && timings.phaseMs("list") >= 0);
});

// -- capabilities -------------------------------------------------------------

Deno.test("capabilities come from the reply to the authentication, in either form", () => {
  const tagged = capabilitiesAfterAuth({
    text: "[CAPABILITY IMAP4rev1 LITERAL+ LIST-EXTENDED LIST-STATUS MOVE] Logged in",
  });
  assert(tagged?.has("LIST-STATUS"));
  const untagged = capabilitiesAfterAuth({
    text: "owner@example.com authenticated (Success)",
    untagged: ["* CAPABILITY IMAP4rev1 UNSELECT IDLE NAMESPACE QUOTA ID XLIST"],
  });
  assert(untagged !== null && !untagged.has("LIST-STATUS") && untagged.has("XLIST"));
  assertEquals(capabilitiesAfterAuth({ text: "AUTHENTICATE completed" }), null);
});

// -- wiring -------------------------------------------------------------------

const INDEX = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("imapListFolders gets its counts from listImapFoldersWithCounts, with the 25 cap", () => {
  const start = INDEX.indexOf("async function imapListFolders(");
  const body = INDEX.slice(start, INDEX.indexOf("\n}\n", start));
  assert(body.includes("const IMAP_FOLDER_COUNT_LIMIT = 25;"));
  assert(/await listImapFoldersWithCounts\(\s*client,\s*IMAP_FOLDER_COUNT_LIMIT,\s*\)/.test(body));
  assert(!body.includes("Promise.allSettled"), "no STATUS fan-out in the handler");
  assert(body.includes("total_messages: counts[i]?.messages ?? null"));
  assert(body.includes("unread_messages: counts[i]?.unseen ?? null"));
});
