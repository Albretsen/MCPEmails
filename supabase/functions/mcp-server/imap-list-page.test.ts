// ---------------------------------------------------------------------------
// email_list without `UID SEARCH ALL`.
//
// The listing used to ask the server for every UID in the mailbox in order to
// keep the newest page of them. It now reads the message count SELECT already
// reported and fetches the page by sequence range. Three things are held here:
//
//   1. THE ANSWER IS THE SAME. `legacyPage` below is the implementation this
//      replaces, kept verbatim, and every mailbox shape, page size and offset
//      is run through both against identical mailbox state.
//   2. THE WIRE IS SHORTER. Commands are counted on a scripted server: an
//      INBOX listing was SELECT, UID SEARCH ALL, UID FETCH and is now SELECT,
//      FETCH.
//   3. DOUBT FALLS BACK. A mailbox that changed between SELECT and FETCH, a
//      server that refuses the range, and a server that never said EXISTS all
//      end on the old path, with the old path's answer.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import type { ImapClient, ImapMessageSummary } from "./imap-client.ts";
import { parseExists } from "./imap-client.ts";
import {
  FakeImapServer,
  type FakeMessage,
  fakeMessageWithAttachment,
  type FakeServerOptions,
  fakeTextMessage,
} from "./imap-fake-server.ts";
import { fetchImapListPage, type ImapListPage } from "./imap-list-page.ts";

/**
 * The listing exactly as index.ts had it before 2026-10-02 (listImapMessages,
 * from the UID SEARCH to the summaries). The reference every case is compared
 * against; do not "improve" it.
 */
async function legacyPage(
  client: ImapClient,
  limit: number,
  offset: number,
  unread: boolean | undefined,
): Promise<ImapListPage> {
  const allUids = await client.uidSearch(
    unread === true ? "UNSEEN" : unread === false ? "SEEN" : "ALL",
  );
  const total = allUids.length;
  const ordered = allUids.slice().sort((a, b) => b - a);
  const pageUids = ordered.slice(offset, offset + limit);
  const summaries = await client.fetchSummaries(pageUids);
  return { total, pageUids, summaries };
}

/** What the handler builds from a page: the summaries in page order. */
function rows(page: ImapListPage): ImapMessageSummary[] {
  const byUid = new Map(page.summaries.map((s) => [s.uid, s]));
  return page.pageUids.map((uid) => byUid.get(uid)).filter((s): s is ImapMessageSummary => !!s);
}

/** A mailbox of `count` messages with gaps in its UIDs, mixed flags and shapes. */
function mailbox(count: number): FakeMessage[] {
  const messages: FakeMessage[] = [];
  let uid = 3;
  for (let i = 0; i < count; i++) {
    uid += 1 + (i % 4 === 0 ? 5 : 0);
    if (i % 7 === 3) messages.push(fakeMessageWithAttachment(uid, { seen: i % 2 === 0 }));
    else if (i % 5 === 2) {
      messages.push(fakeTextMessage(uid, { seen: true, body: "Long body. ".repeat(400) }));
    } else {
      messages.push(fakeTextMessage(uid, {
        seen: i % 3 === 0,
        subject: i % 6 === 1 ? "=?UTF-8?B?SGVpIHDDpSBkZWc=?=" : undefined,
      }));
    }
  }
  return messages;
}

function serverWith(messages: FakeMessage[], extra: Partial<FakeServerOptions> = {}): FakeImapServer {
  return new FakeImapServer({ mailboxes: [{ name: "INBOX", messages }], ...extra });
}

async function listOn(
  server: FakeImapServer,
  limit: number,
  offset: number,
  unread: boolean | undefined,
  how: "new" | "legacy",
): Promise<ImapListPage> {
  const client = server.client();
  await client.selectMailbox("INBOX");
  return how === "new"
    ? await fetchImapListPage(client, { limit, offset, unread })
    : await legacyPage(client, limit, offset, unread);
}

// -- 1. the answer is the same ------------------------------------------------

Deno.test("every mailbox size, page size and offset lists exactly what it listed before", async () => {
  let compared = 0;
  for (const count of [0, 1, 2, 19, 20, 21, 57]) {
    for (const limit of [1, 5, 20, 50]) {
      for (const offset of [0, 1, 19, 20, 21, 56, 57, 100]) {
        for (const unread of [undefined, true, false]) {
          const before = await listOn(serverWith(mailbox(count)), limit, offset, unread, "legacy");
          const after = await listOn(serverWith(mailbox(count)), limit, offset, unread, "new");
          const label = `count=${count} limit=${limit} offset=${offset} unread=${unread}`;
          assertEquals(after.total, before.total, `total, ${label}`);
          assertEquals(after.pageUids, before.pageUids, `page order, ${label}`);
          assertEquals(rows(after), rows(before), `rows, ${label}`);
          compared++;
        }
      }
    }
  }
  assertEquals(compared, 7 * 4 * 8 * 3);
});

Deno.test("the rows carry what the tool returns: flags, attachments and the preview", async () => {
  const page = await listOn(serverWith(mailbox(21)), 20, 0, undefined, "new");
  const listed = rows(page);
  assertEquals(listed.length, 20);
  assert(listed.some((s) => s.hasAttachments), "an attachment is reported");
  assert(listed.some((s) => s.flags.includes("\\Seen")) && listed.some((s) => !s.flags.includes("\\Seen")));
  assert(listed.every((s) => s.preview.length > 0), "email_list returns a preview, so it is fetched");
  assert(listed.every((s) => s.preview.length <= 200));
});

// -- 2. the wire is shorter ---------------------------------------------------

Deno.test("an INBOX listing is SELECT + FETCH, where it was SELECT + UID SEARCH ALL + UID FETCH", async () => {
  const before = serverWith(mailbox(57));
  await listOn(before, 20, 0, undefined, "legacy");
  assertEquals(before.commands.map((c) => c.split(" (")[0]), [
    'SELECT "INBOX"',
    "UID SEARCH ALL",
    `UID FETCH ${mailbox(57).map((m) => m.uid).sort((a, b) => b - a).slice(0, 20).join(",")}`,
  ]);
  assertEquals(before.roundTrips, 3);

  const after = serverWith(mailbox(57));
  await listOn(after, 20, 0, undefined, "new");
  assertEquals(after.commands, [
    'SELECT "INBOX"',
    "FETCH 38:57 (UID FLAGS ENVELOPE BODYSTRUCTURE BODY.PEEK[1]<0.2048>)",
  ]);
  assertEquals(after.roundTrips, 2);
  assert(!after.commands.some((c) => c.includes("SEARCH")), "no UID is listed to find the page");
});

Deno.test("the second page is the range below the first, and the last page stops at 1", async () => {
  const second = serverWith(mailbox(57));
  await listOn(second, 20, 20, undefined, "new");
  assertEquals(second.commands[1].split(" (")[0], "FETCH 18:37");

  const last = serverWith(mailbox(57));
  const page = await listOn(last, 20, 40, undefined, "new");
  assertEquals(last.commands[1].split(" (")[0], "FETCH 1:17");
  assertEquals(page.pageUids.length, 17);
  assertEquals(page.total, 57);
});

Deno.test("an empty mailbox, and an offset past the end, issue no FETCH at all", async () => {
  const empty = serverWith([]);
  const none = await listOn(empty, 20, 0, undefined, "new");
  assertEquals(none, { total: 0, pageUids: [], summaries: [] });
  assertEquals(empty.commands, ['SELECT "INBOX"']);

  const past = serverWith(mailbox(5));
  const beyond = await listOn(past, 20, 5, undefined, "new");
  assertEquals(beyond, { total: 5, pageUids: [], summaries: [] });
  assertEquals(past.commands, ['SELECT "INBOX"']);
});

Deno.test("a read or unread filter still searches, exactly as before", async () => {
  for (const [unread, criteria] of [[true, "UNSEEN"], [false, "SEEN"]] as const) {
    const server = serverWith(mailbox(30));
    await listOn(server, 10, 0, unread, "new");
    assertEquals(server.commands[1], `UID SEARCH ${criteria}`);
    assert(server.commands[2].startsWith("UID FETCH "));
    assertEquals(server.commands.length, 3);
  }
});

// -- 3. doubt falls back ------------------------------------------------------

Deno.test("a message expunged between SELECT and FETCH: the old path answers (rows left out)", async () => {
  const messages = mailbox(30);
  const gone = messages[27].uid;
  const server = serverWith(messages);
  const client = server.client();
  await client.selectMailbox("INBOX");
  server.expungeBehindTheClient("INBOX", gone);

  const page = await fetchImapListPage(client, { limit: 10, offset: 0, unread: undefined });

  assertEquals(server.commands.map((c) => c.split(" ")[0] === "UID" ? c.split(" ").slice(0, 2).join(" ") : c.split(" ")[0]), [
    "SELECT",
    "FETCH",
    "UID SEARCH",
    "UID FETCH",
  ]);
  // The reference, run on a mailbox that never had the message.
  const expected = await listOn(
    serverWith(mailbox(30).filter((m) => m.uid !== gone)),
    10,
    0,
    undefined,
    "legacy",
  );
  assertEquals(page.total, 29);
  assertEquals(page.pageUids, expected.pageUids);
  assertEquals(rows(page), rows(expected));
  assert(!page.pageUids.includes(gone));
});

Deno.test("a message expunged between SELECT and FETCH: the old path answers (server says NO)", async () => {
  const messages = mailbox(30);
  const gone = messages[29].uid;
  const server = serverWith(messages, { expungedFetch: "no" });
  const client = server.client();
  await client.selectMailbox("INBOX");
  server.expungeBehindTheClient("INBOX", gone);

  const page = await fetchImapListPage(client, { limit: 10, offset: 0, unread: undefined });

  assertEquals(page.total, 29);
  assertEquals(page.pageUids.length, 10);
  assert(!page.pageUids.includes(gone));
  assert(server.commands.some((c) => c === "UID SEARCH ALL"));
});

Deno.test("a server that refuses the sequence FETCH outright is listed the old way", async () => {
  const server = serverWith(mailbox(12), {
    refuse: (command) => /^FETCH /.test(command) ? "BAD Command not permitted" : null,
  });
  const page = await listOn(server, 5, 0, undefined, "new");
  const expected = await listOn(serverWith(mailbox(12)), 5, 0, undefined, "legacy");
  assertEquals(page.pageUids, expected.pageUids);
  assertEquals(rows(page), rows(expected));
});

Deno.test("a server that never says EXISTS is listed the old way, with no sequence FETCH", async () => {
  const server = serverWith(mailbox(12), { omitExists: true });
  const page = await listOn(server, 5, 0, undefined, "new");
  const expected = await listOn(serverWith(mailbox(12)), 5, 0, undefined, "legacy");
  assertEquals(server.commands.map((c) => c.split(" (")[0].replace(/ \d[\d,]*$/, "")), [
    'SELECT "INBOX"',
    "UID SEARCH ALL",
    "UID FETCH",
  ]);
  assertEquals(page.total, expected.total);
  assertEquals(rows(page), rows(expected));
});

Deno.test("mail that arrives after the SELECT does not disturb the page", async () => {
  const messages = mailbox(10);
  const server = serverWith(messages);
  const client = server.client();
  await client.selectMailbox("INBOX");
  server.mailboxes[0].messages.push(fakeTextMessage(9999));

  const page = await fetchImapListPage(client, { limit: 5, offset: 0, unread: undefined });
  assertEquals(page.total, 10, "the count is the one SELECT reported");
  assertEquals(page.pageUids.length, 5);
  assert(!page.pageUids.includes(9999));
});

Deno.test("a search that fails still fails with the error it always had", async () => {
  const server = serverWith(mailbox(3), {
    refuse: (command) => command.startsWith("UID SEARCH") ? "NO [UNAVAILABLE] try later" : null,
  });
  const client = server.client();
  await client.selectMailbox("INBOX");
  let message = "";
  try {
    await fetchImapListPage(client, { limit: 5, offset: 0, unread: true });
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assertEquals(message, "UID SEARCH failed: [UNAVAILABLE] try later");
});

// -- the SELECT count ---------------------------------------------------------

Deno.test("the message count is read off the SELECT reply and reset by the next SELECT", async () => {
  const server = new FakeImapServer({
    mailboxes: [
      { name: "INBOX", messages: mailbox(7) },
      { name: "Archive", messages: [] },
    ],
  });
  const client = server.client();
  assertEquals(client.selectedMessageCount(), null, "nothing selected yet");
  await client.selectMailbox("INBOX");
  assertEquals(client.selectedMessageCount(), 7);
  await client.selectMailbox("Archive");
  assertEquals(client.selectedMessageCount(), 0);
  await client.selectMailbox("Missing").catch(() => {});
  assertEquals(client.selectedMessageCount(), null, "a failed SELECT leaves no stale count");
});

Deno.test("parseExists takes the last EXISTS line and ignores everything else", () => {
  assertEquals(parseExists([]), null);
  assertEquals(parseExists(["* FLAGS (\\Seen)", "* 0 RECENT"]), null);
  assertEquals(parseExists(["* 172 EXISTS", "* 1 RECENT"]), 172);
  assertEquals(parseExists(["* 3 EXISTS", "* OK [UIDVALIDITY 1]", "* 4 EXISTS"]), 4);
  assertEquals(parseExists(['* LIST () "/" "12 EXISTS"']), null);
});

// -- wiring -------------------------------------------------------------------

const INDEX = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("listImapMessages gets its page from fetchImapListPage and searches nothing itself", () => {
  const start = INDEX.indexOf("async function listImapMessages(");
  const body = INDEX.slice(start, INDEX.indexOf("\n}\n", start));
  assert(body.includes("await fetchImapListPage(client, {"));
  assert(!body.includes("uidSearch("), "the handler no longer lists every UID");
  assert(body.includes("preview: tidyPreview(s.preview)"), "the preview it fetches is returned");
  assert(body.includes("has_more: offset + limit < total"));
});
