// ---------------------------------------------------------------------------
// NetEase refuses SELECT until the client has sent ID (RFC 2971).
//
// A 163.com inbox connected on 2026-10-09 could send mail and list its folders
// with counts, and every list, search and read failed "SELECT failed: NO": the
// server answers `NO SELECT Unsafe Login` to a client that never identified
// itself. connectOnce now sends ID after authenticating to NetEase and
// Coremail servers (imap-id.ts). These tests pin which servers get it and that
// an identified session can SELECT where an unidentified one cannot.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { ImapSelectRefusedError } from "./imap-client.ts";
import { FakeImapServer, fakeTextMessage } from "./imap-fake-server.ts";
import { IMAP_CLIENT_ID, imapServerWantsId } from "./imap-id.ts";

Deno.test("NetEase hosts and Coremail greetings get ID; everyone else does not", () => {
  for (
    const host of [
      "imap.163.com",
      "IMAP.163.COM",
      "imap.163.com.",
      "imap.126.com",
      "imap.yeah.net",
      "imap.188.com",
      "imap.vip.163.com",
      "imap.qiye.163.com",
      "imap.netease.com",
    ]
  ) {
    assert(imapServerWantsId(host, "* OK IMAP ready"), host);
  }
  assert(
    imapServerWantsId("mail.example.cn", "* OK Coremail System IMap Server Ready(10.0.0.1)"),
    "a Coremail greeting under a company's own domain",
  );
  for (
    const host of [
      "imap.gmail.com",
      "imap.mail.yahoo.com",
      "imap.fastmail.com",
      "imap.qq.com",
      "imap.x163.com",
      "imap.163.com.evil.example",
    ]
  ) {
    assert(!imapServerWantsId(host, "* OK [CAPABILITY IMAP4rev1] Dovecot ready."), host);
  }
});

Deno.test("the ID parameter list is a well-formed RFC 2971 field/value list", () => {
  assert(IMAP_CLIENT_ID.startsWith("(") && IMAP_CLIENT_ID.endsWith(")"));
  const strings = [...IMAP_CLIENT_ID.matchAll(/"([^"\\]*)"/g)].map((m) => m[1]);
  assertEquals(strings.length % 2, 0, "pairs of field and value");
  assertEquals(strings[0], "name");
});

function netEase(): FakeImapServer {
  return new FakeImapServer({
    mailboxes: [
      { name: "INBOX", messages: [fakeTextMessage(1), fakeTextMessage(2)] },
      { name: "已发送", attrs: ["\\Sent"], messages: [fakeTextMessage(3)] },
    ],
    requireId: true,
  });
}

Deno.test("without ID, a NetEase SELECT is refused, as on the customer's inbox", async () => {
  const server = netEase();
  const client = server.client();
  const err = await assertRejects(() => client.selectMailbox("INBOX"), ImapSelectRefusedError);
  assertEquals(err.message, "SELECT failed: NO");
});

Deno.test("after identify(), the same server SELECTs INBOX and a non-ASCII folder", async () => {
  const server = netEase();
  const client = server.client();
  await client.identify();
  assertEquals(server.idReceived, IMAP_CLIENT_ID);
  await client.selectMailbox("INBOX");
  assertEquals(client.selectedMessageCount(), 2);
  await client.selectMailbox("已发送");
  assertEquals(client.selectedMessageCount(), 1);
  assertEquals(server.commands[0], `ID ${IMAP_CLIENT_ID}`);
});

Deno.test("a server that rejects ID leaves the session usable", async () => {
  const server = new FakeImapServer({
    mailboxes: [{ name: "INBOX", messages: [fakeTextMessage(1)] }],
    refuse: (command) => command.startsWith("ID ") ? "BAD Unknown command" : null,
  });
  const client = server.client();
  await client.identify();
  await client.selectMailbox("INBOX");
  assertEquals(client.selectedMessageCount(), 1);
});
