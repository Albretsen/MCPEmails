// ---------------------------------------------------------------------------
// email_attachment downloads its message once.
//
// The tool reads its message in two passes (list the attachments, then encode
// the chosen one). On IMAP each pass used to open a connection and download
// the whole raw message, so one file cost two handshakes and two full
// downloads. The handler now gives both passes one map, and pass 2 parses the
// bytes pass 1 fetched.
//
// Held here:
//   1. ONE connection and ONE download where there were two of each.
//   2. THE SAME BYTES. Pass 2's attachment is identical, octet for octet, to
//      the one a second download would have produced: base64, quoted-printable
//      and a raw 8-bit part whose octets the latin1 read path maps specially.
//   3. NOT A CACHE. Nothing is kept unless the handler passes a map, the map
//      belongs to one call, and a missing message is never remembered.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import type { ImapClient } from "./imap-client.ts";
import { FakeImapServer, type FakeMessage, fakeTextMessage } from "./imap-fake-server.ts";
import { type ImapFetchedThisCall, imapRawMessageOnce } from "./imap-fetch-once.ts";
import { ImapSession } from "./imap-session.ts";
import { type MimeAttachment, parseEmail } from "./mime.ts";

const CRLF = "\r\n";

/** Every octet value, so the round trip through the wire is fully exercised. */
function allOctets(): string {
  let out = "";
  for (let round = 0; round < 3; round++) {
    for (let b = 0; b < 256; b++) out += String.fromCharCode(b);
  }
  return out;
}

function base64Part(name: string, content: string, type: string): string {
  return [
    `Content-Type: ${type}; name="${name}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${name}"`,
    "",
    btoa(content).replace(/(.{76})/g, `$1${CRLF}`),
  ].join(CRLF);
}

/** A message with a text body and four attachments of different kinds. */
function messageWithFourFiles(uid: number): FakeMessage {
  return {
    uid,
    flags: ["\\Seen"],
    raw: [
      "Date: 02 Sep 2026 09:00:00 +0000",
      'From: "Sender" <sender@example.com>',
      "To: <owner@example.com>",
      "Subject: Four files",
      `Message-ID: <three${uid}@example.com>`,
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="outer"',
      "",
      "--outer",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Four files attached.",
      "--outer",
      base64Part("octets.bin", allOctets(), "application/octet-stream"),
      "--outer",
      base64Part("notes.txt", "plain notes\n".repeat(40), "text/plain"),
      "--outer",
      [
        'Content-Type: text/csv; name="table.csv"',
        "Content-Transfer-Encoding: quoted-printable",
        'Content-Disposition: attachment; filename="table.csv"',
        "",
        "name;amount=0Aone;1=0Atwo;2",
      ].join(CRLF),
      "--outer",
      [
        'Content-Type: application/octet-stream; name="eightbit.dat"',
        "Content-Transfer-Encoding: 8bit",
        'Content-Disposition: attachment; filename="eightbit.dat"',
        "",
        // Raw octets 0x80 to 0xFF, unencoded: the range the latin1 read path
        // maps specially. Whatever the parser makes of them, it must make the
        // same of them on both paths.
        Array.from({ length: 128 }, (_, i) => String.fromCharCode(0x80 + i)).join(""),
      ].join(CRLF),
      "--outer--",
      "",
    ].join(CRLF),
  };
}

function account(): { servers: FakeImapServer[]; open: () => Promise<ImapClient> } {
  const servers: FakeImapServer[] = [];
  return {
    servers,
    open: () => {
      const server = new FakeImapServer({
        mailboxes: [
          { name: "INBOX", messages: [fakeTextMessage(4), messageWithFourFiles(5)] },
          { name: "Archive", messages: [fakeTextMessage(5, { subject: "Another message 5" })] },
        ],
      });
      servers.push(server);
      return Promise.resolve(server.client());
    },
  };
}

/**
 * One pass of the attachment tool, shaped like readImapMessage: its own
 * session, SELECT, the raw message, parse, close.
 */
async function readPass(
  open: () => Promise<ImapClient>,
  messageId: string,
  kept: ImapFetchedThisCall | undefined,
): Promise<MimeAttachment[]> {
  const at = messageId.lastIndexOf(":");
  const folder = messageId.slice(0, at);
  const uid = Number(messageId.slice(at + 1));
  const session = new ImapSession(open);
  try {
    const { message } = await imapRawMessageOnce(kept, messageId, uid, () => session.select(folder));
    if (!message) throw new Error("message_not_found");
    return parseEmail(message.raw).attachments;
  } finally {
    await session.close();
  }
}

const READ_ONE = ['SELECT "INBOX"', "UID FETCH 5 (FLAGS BODY.PEEK[])", "LOGOUT"];

Deno.test("BEFORE: the two passes cost two connections and two full downloads", async () => {
  const { servers, open } = account();
  await readPass(open, "INBOX:5", undefined);
  await readPass(open, "INBOX:5", undefined);
  assertEquals(servers.length, 2);
  assertEquals(servers[0].commands, READ_ONE);
  assertEquals(servers[1].commands, READ_ONE);
});

Deno.test("AFTER: one connection, one download, and pass 2 touches no network", async () => {
  const { servers, open } = account();
  const fetched: ImapFetchedThisCall = new Map();
  const listed = await readPass(open, "INBOX:5", fetched);
  const chosen = await readPass(open, "INBOX:5", fetched);

  assertEquals(servers.length, 1, "pass 2 opened no connection");
  assertEquals(servers[0].commands, READ_ONE);
  assertEquals(servers[0].commands.filter((c) => c.includes("BODY.PEEK[]")).length, 1);
  assert(servers[0].closed);
  assertEquals(listed.length, 4);
  assertEquals(chosen.length, 4);
});

Deno.test("pass 2 returns exactly what a second download returned, octet for octet", async () => {
  const twice = account();
  await readPass(twice.open, "INBOX:5", undefined);
  const downloadedAgain = await readPass(twice.open, "INBOX:5", undefined);

  const once = account();
  const fetched: ImapFetchedThisCall = new Map();
  await readPass(once.open, "INBOX:5", fetched);
  const fromFirstDownload = await readPass(once.open, "INBOX:5", fetched);

  assertEquals(fromFirstDownload.length, downloadedAgain.length);
  for (let i = 0; i < downloadedAgain.length; i++) {
    assertEquals(fromFirstDownload[i].filename, downloadedAgain[i].filename);
    assertEquals(fromFirstDownload[i].mimeType, downloadedAgain[i].mimeType);
    assertEquals(fromFirstDownload[i].size, downloadedAgain[i].size);
    assertEquals(fromFirstDownload[i].content, downloadedAgain[i].content);
  }
  // And the hard case is really in there: every octet value, three times.
  const octets = fromFirstDownload[0];
  assertEquals(octets.filename, "octets.bin");
  assertEquals(octets.size, 768);
  assertEquals(Array.from(octets.content.subarray(0, 256)), Array.from({ length: 256 }, (_, b) => b));
  assertEquals(fromFirstDownload[2].filename, "table.csv");
  assertEquals(new TextDecoder().decode(fromFirstDownload[2].content), "name;amount\none;1\ntwo;2");
  assertEquals(fromFirstDownload[3].filename, "eightbit.dat");
  assertEquals(fromFirstDownload[3].size, 128);
});

Deno.test("without a map every read downloads, exactly as before", async () => {
  const { servers, open } = account();
  for (let i = 0; i < 3; i++) await readPass(open, "INBOX:5", undefined);
  assertEquals(servers.length, 3);
  for (const server of servers) assertEquals(server.commands, READ_ONE);
});

Deno.test("the map is keyed by the whole message id: the same UID in another folder is another message", async () => {
  const { servers, open } = account();
  const fetched: ImapFetchedThisCall = new Map();
  const inbox = await readPass(open, "INBOX:5", fetched);
  const archive = await readPass(open, "Archive:5", fetched);
  assertEquals(inbox.length, 4);
  assertEquals(archive.length, 0, "the Archive message has no attachments");
  assertEquals(servers.length, 2, "a different message is fetched, not served from the map");
  assertEquals(servers[1].commands[0], 'SELECT "Archive"');
  assertEquals([...fetched.keys()].sort(), ["Archive:5", "INBOX:5"]);
});

Deno.test("a message the server does not have is not remembered", async () => {
  const { servers, open } = account();
  const fetched: ImapFetchedThisCall = new Map();
  for (let i = 0; i < 2; i++) {
    let message = "";
    try {
      await readPass(open, "INBOX:999", fetched);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    assertEquals(message, "message_not_found");
  }
  assertEquals(fetched.size, 0);
  assertEquals(servers.length, 2, "it was asked for both times");
});

Deno.test("a hit hands back no client, a miss hands back the one that fetched", async () => {
  const { open } = account();
  const fetched: ImapFetchedThisCall = new Map();
  const session = new ImapSession(open);
  const select = () => session.select("INBOX");
  const miss = await imapRawMessageOnce(fetched, "INBOX:5", 5, select);
  assert(miss.client !== null && miss.message !== null);
  const hit = await imapRawMessageOnce(fetched, "INBOX:5", 5, () => {
    throw new Error("a hit must not select");
  });
  assertEquals(hit.client, null);
  assert(hit.message === miss.message, "the very same object, not a copy");
  await session.close();
});

// -- wiring -------------------------------------------------------------------
// index.ts boots the server at import, so its handlers are pinned as text.

const INDEX = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const MODULE = await Deno.readTextFile(new URL("./imap-fetch-once.ts", import.meta.url));

function functionSource(name: string): string {
  const start = INDEX.indexOf(`async function ${name}(`);
  assert(start !== -1, `${name} not found in index.ts`);
  return INDEX.slice(start, INDEX.indexOf("\n}\n", start));
}

Deno.test("email_attachment gives both passes one map, created inside the handler", () => {
  const body = functionSource("executeReadAttachment");
  assertEquals(body.split("const imapFetched: ImapFetchedThisCall = new Map();").length - 1, 1);
  assertEquals(body.split("imap_fetched: imapFetched,").length - 1, 2, "pass 1 and pass 2");
});

Deno.test("no other tool passes a map, so every other read downloads as it did", () => {
  assertEquals(INDEX.split("imap_fetched: ").length - 1, 2, "only the two passes above");
  assertEquals(INDEX.split("opts.imap_fetched").length - 1, 1, "handed on in one place");
  for (const name of ["fetchReferencedAttachment", "executeReadEmail", "executeReadEmails"]) {
    assert(!functionSource(name).includes("imap_fetched"), name);
  }
  // email_original and the forward relay need the provider's own bytes, fetched
  // under their own ceiling. They do not go through this at all.
  const original = functionSource("readOriginalMessage");
  assert(!original.includes("imapRawMessageOnce") && !original.includes("fetchedThisCall"));
  assert(original.includes("client.fetchMessageRaw(uid, { maxLiteralBytes: maxBytes })"));
});

Deno.test("readImapMessage fetches through the map, and only selects on a miss", () => {
  const body = functionSource("readImapMessage");
  assert(body.includes("const select = () => session.select(imapMailboxForServerFolder(folder));"));
  assert(/await imapRawMessageOnce\(\s*fetchedThisCall,\s*messageId,\s*uid,\s*select,\s*\)/.test(body));
  assert(!body.includes("client.fetchMessageRaw("), "no second way to download");
  // Two parsers since 2026-10-04 (the read tools join the inline text parts,
  // see read-joined-body.test.ts), both on the bytes this call fetched once.
  assert(
    /const parsed = joinInlineParts\s*\? parseEmailJoined\(msg\.raw, htmlPartToBodyText\)\s*: parseEmail\(msg\.raw\);/.test(body),
    "parsed from the same bytes",
  );
});

Deno.test("there is no module-level state: nothing outlives the call that made the map", () => {
  const code = MODULE.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*")).join("\n");
  assert(!/^(?:const|let|var) /m.test(code), "no top-level binding");
  assert(!/new Map|new WeakMap|globalThis/.test(code), "the module creates no storage of its own");
});
