// ---------------------------------------------------------------------------
// A non-inbox email_list uses ONE connection.
//
// Resolving any folder but the inbox is an IMAP LIST. executeListInbox called
// resolveFolderId without a session, so that LIST opened, authenticated and
// logged out a connection of its own, and listImapMessages then opened a
// second one to do the listing: two TCP + TLS + AUTH handshakes, and two slots
// against the provider's per-account connection cap, to list one folder.
//
// The handler now resolves on a session and the lister takes that connection
// over (`ImapSession.take`). These tests pin the handover itself against a
// scripted server, then pin the handler's wiring as text, because index.ts
// boots the server at import and its handlers cannot be run from here.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import type { ImapClient } from "./imap-client.ts";
import { FakeImapServer, fakeTextMessage } from "./imap-fake-server.ts";
import { ImapSession } from "./imap-session.ts";

function account(): { servers: FakeImapServer[]; open: () => Promise<ImapClient> } {
  const servers: FakeImapServer[] = [];
  return {
    servers,
    // Every connection gets its own scripted server over the same mailboxes,
    // so "how many connections" is simply how many of these exist.
    open: () => {
      const server = new FakeImapServer({
        mailboxes: [
          { name: "INBOX", messages: [fakeTextMessage(1)] },
          {
            name: "Receipts",
            messages: [4, 5, 6, 9].map((uid) => fakeTextMessage(uid)),
          },
        ],
      });
      servers.push(server);
      return Promise.resolve(server.client());
    },
  };
}

/**
 * What listImapMessages does with the connection it is given or opens: select,
 * read, and close it itself. Which commands it reads with is another test's
 * business (imap-list-page.test.ts); this file counts connections.
 */
async function listOn(client: ImapClient, folder: string): Promise<number[]> {
  try {
    await client.selectMailbox(folder);
    return (await client.uidSearch("ALL")).sort((a, b) => b - a);
  } finally {
    await client.logout().catch(() => {});
  }
}

Deno.test("BEFORE: resolving a folder and then listing it cost two connections", async () => {
  const { servers, open } = account();

  // resolveFolderId without a session: its own connection for one LIST.
  const resolver = new ImapSession(open);
  const names = (await (await resolver.client()).listMailboxes()).map((m) => m.name);
  await resolver.close();
  // listImapMessages: a second connection for the listing.
  const uids = await listOn(await open(), "Receipts");

  assert(names.includes("Receipts"));
  assertEquals(uids, [9, 6, 5, 4]);
  assertEquals(servers.length, 2, "two handshakes");
  assertEquals(servers[0].commands, ['LIST "" "*"', "LOGOUT"]);
  assertEquals(servers[1].commands[0], 'SELECT "Receipts"');
});

Deno.test("AFTER: the lister takes over the connection the folder was resolved on", async () => {
  const { servers, open } = account();

  const session = new ImapSession(open);
  const names = (await (await session.client()).listMailboxes()).map((m) => m.name);
  const uids = await listOn(session.take() ?? await open(), "Receipts");
  await session.close();

  assert(names.includes("Receipts"));
  assertEquals(uids, [9, 6, 5, 4], "the same listing");
  assertEquals(servers.length, 1, "one handshake");
  assertEquals(servers[0].commands, [
    'LIST "" "*"',
    'SELECT "Receipts"',
    "UID SEARCH ALL",
    "LOGOUT",
  ]);
  assertEquals(servers[0].commands.filter((c) => c === "LOGOUT").length, 1, "logged out once");
  assert(servers[0].closed);
});

Deno.test("the inbox needs no LIST, so the session never connects and the lister opens its own", async () => {
  const { servers, open } = account();

  const session = new ImapSession(open);
  // resolveFolderId answers "INBOX" without touching the session.
  const taken = session.take();
  assertEquals(taken, null);
  assertEquals(servers.length, 0, "nothing was opened to resolve the inbox");

  const uids = await listOn(taken ?? await open(), "INBOX");
  await session.close();

  assertEquals(uids, [1]);
  assertEquals(servers.length, 1);
  assertEquals(servers[0].commands.map((c) => c.split(" ")[0]), ["SELECT", "UID", "LOGOUT"]);
});

Deno.test("take() ends the session: close() cannot log out a connection it gave away", async () => {
  const { servers, open } = account();
  const session = new ImapSession(open);
  await session.select("INBOX");

  const client = session.take();
  assert(client !== null);
  // Ended by the take itself, not by the close() that follows: a session that
  // could still connect here would open a second connection behind the first.
  await assertRejects(() => session.client(), Error, "imap_session_closed");
  await assertRejects(() => session.select("INBOX"), Error, "imap_session_closed");
  await session.close();
  await session.invalidate();

  assertEquals(servers[0].commands, ['SELECT "INBOX"'], "no LOGOUT from the session");
  assert(!servers[0].closed, "the connection is still the new owner's to use");
  await assertRejects(() => session.client(), Error, "imap_session_closed");
  assertEquals(session.take(), null, "and there is nothing left to take");

  await client.logout();
  assert(servers[0].closed);
});

Deno.test("a resolve that fails after connecting is still closed by the handler's close()", async () => {
  const { servers, open } = account();
  const session = new ImapSession(open);
  await (await session.client()).listMailboxes();
  // folder_not_found: the handler returns from its catch and never reaches
  // the lister, so nothing took the connection.
  await session.close();
  assertEquals(servers[0].commands, ['LIST "" "*"', "LOGOUT"]);
  assert(servers[0].closed);
});

// -- wiring -------------------------------------------------------------------

const INDEX = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function functionSource(name: string): string {
  const start = INDEX.indexOf(`async function ${name}(`);
  assert(start !== -1, `${name} not found in index.ts`);
  return INDEX.slice(start, INDEX.indexOf("\n}\n", start));
}

Deno.test("executeListInbox resolves on a session, passes it to the lister, and closes it on every path", () => {
  const body = functionSource("executeListInbox");
  const opened = body.indexOf("const imapSession = imapSessionFor(inbox);");
  const resolved = body.indexOf("listFolder = await resolveFolderId(");
  assert(opened !== -1 && opened < resolved, "the session exists before the folder is resolved");
  assert(/resolveFolderId\([^;]*?session: imapSession,\s*\}\);/.test(body), "and the resolve runs on it");
  assert(/listImapMessages\(\s*inbox,\s*listFolder,\s*limit,\s*offset,\s*unread,\s*imapSession,\s*\)/.test(body));
  assertEquals(body.split("await imapSession?.close();").length - 1, 2, "closed in the resolve catch and in the dispatch finally");
  assert(body.lastIndexOf("} finally {") > body.indexOf("await listImapMessages("));
});

Deno.test("listImapMessages takes the resolved connection, or opens one, and still owns the close", () => {
  const body = functionSource("listImapMessages");
  assert(body.includes("client = resolvedOn?.take() ?? await ImapClient.connect({"));
  assert(/\} finally \{[\s\S]*if \(client\) await /.test(body), "one owner, one close");
});

Deno.test("the folder resolve does its LIST on the session it is handed", () => {
  const resolve = functionSource("resolveFolderId");
  assert(resolve.includes("await imapMailboxListing(inbox, opts.session)"));
  const listing = functionSource("imapMailboxListing");
  assert(listing.includes("const session = shared ?? new ImapSession(imapSessionOpener(inbox));"));
  assert(listing.includes("if (!shared) await session.close();"), "and leaves a borrowed one open");
});
