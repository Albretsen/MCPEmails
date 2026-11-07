// ---------------------------------------------------------------------------
// Summary FETCHes never hold a whole body part in memory.
//
// A listing asks for `BODY.PEEK[1]<0.2048>`. On 2026-11-04 a mail.ru inbox's
// email_search and email_list pages came back at 11-31 MB, and larger ones
// killed the edge isolate ("Memory limit exceeded" / "CPU Time exceeded",
// 546) under every other request sharing it: a reply that carries the whole
// part was escaped into the line, tokenized and decoded in full to show 2 KB.
// The reader now keeps the first SUMMARY_LITERAL_TRUNCATE_BYTES of a summary
// literal, and the preview is cut to the octets that were asked for.
//
// Every fixture is invented; every address is under example.com.
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import { FakeImapServer, type FakeMessage } from "./imap-fake-server.ts";
import { SUMMARY_LITERAL_TRUNCATE_BYTES } from "./imap-client.ts";

const CRLF = "\r\n";

function message(uid: number, body: string, contentType = "text/plain; charset=us-ascii"): FakeMessage {
  return {
    uid,
    flags: [],
    raw: [
      "Date: 01 Sep 2026 10:00:00 +0000",
      'From: "Sender" <sender@example.com>',
      "To: <owner@example.com>",
      `Subject: Fixture ${uid}`,
      `Content-Type: ${contentType}`,
      "",
      body,
    ].join(CRLF),
  };
}

async function list(messages: FakeMessage[], ignorePartial: boolean) {
  const server = new FakeImapServer({ mailboxes: [{ name: "INBOX", messages }], ignorePartial });
  const client = server.client();
  await client.selectMailbox("INBOX");
  const rows = await client.fetchSummaries(messages.map((m) => m.uid));
  return { rows, client, server };
}

const BIG = 3 * 1024 * 1024;

Deno.test("summary literal cap: a server that ignores <0.2048> gives the same previews as one that honours it", async () => {
  const messages = [
    message(1, "Your invoice is attached. " + "x".repeat(BIG)),
    message(2, "Short note, nothing more."),
    message(3, "<html><body><p>Hello from HTML.</p>" + "<br>".repeat(BIG / 4) + "</body></html>", "text/html; charset=utf-8"),
  ];
  const compliant = await list(messages, false);
  const ignoring = await list(messages, true);
  const byUid = (rows: { uid: number; preview: string; envelope: { subject: string } }[]) =>
    rows.map((r) => [r.uid, r.preview, r.envelope.subject]).sort();
  assertEquals(byUid(ignoring.rows), byUid(compliant.rows));
  assertEquals(ignoring.rows.find((r) => r.uid === 2)?.preview, "Short note, nothing more.");
  assert(ignoring.rows.find((r) => r.uid === 1)?.preview.startsWith("Your invoice is attached."));
});

Deno.test("summary literal cap: no preview string past the cap, and the session stays in sync", async () => {
  const messages = [message(1, "Start. " + "y".repeat(BIG)), message(2, "Second.")];
  const { rows, client } = await list(messages, true);
  for (const row of rows) assert(row.preview.length <= 200, `uid ${row.uid}: preview ${row.preview.length} chars`);
  // The drained remainder must not leak into the next command's reply.
  await client.selectMailbox("INBOX");
  const again = await client.fetchSummaries([2]);
  assertEquals(again.map((r) => r.preview), ["Second."]);
  const raw = await client.fetchMessageRaw(1);
  assert(raw !== null && raw.raw.length > BIG, "a full read is untouched by the summary cut");
});

Deno.test("summary literal cap: the cut sits well above any compliant reply and below a page of whole parts", () => {
  assert(SUMMARY_LITERAL_TRUNCATE_BYTES >= 32 * 1024, "covers the 32 KB preview extension");
  assert(SUMMARY_LITERAL_TRUNCATE_BYTES * 100 < 16 * 1024 * 1024, "a 100-row page stays far under the isolate");
});
