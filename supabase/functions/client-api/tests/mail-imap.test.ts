// Mail ops against the REAL tool layer on IMAP, with the session pool and the
// scripted fake IMAP server. No socket is opened.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fakeMessageWithAttachment, fakeTextMessage, type FakeMailbox } from "../../mcp-server/imap-fake-server.ts";
import { request } from "./helpers.ts";
import { FakeDialPool, harness, imapInbox, imapServer, INBOX_ID, realApp } from "./real-seam.ts";

function mailboxes(): FakeMailbox[] {
  const flagged = fakeTextMessage(3, { subject: "Starred on the server" });
  flagged.flags = ["\\Flagged"];
  return [
    {
      name: "INBOX",
      attrs: ["\\HasNoChildren"],
      modSeq: 100,
      messages: [fakeTextMessage(1, { seen: true }), fakeTextMessage(2), flagged, fakeMessageWithAttachment(4, { filename: "notes.txt", content: "attached bytes æø" })],
    },
    { name: "Archive", attrs: ["\\HasNoChildren", "\\Archive"], modSeq: 7, messages: [fakeTextMessage(9, { seen: true })] },
  ];
}

const noHandler: harness.ProviderHandler = (call) => harness.json({ error: `unexpected provider call ${call.url}` }, 500);

async function rig() {
  const boxes = mailboxes();
  const pool = new FakeDialPool(imapServer(boxes));
  const app = await realApp({ pool });
  const inbox = await imapInbox();
  const run = <T>(body: () => Promise<T>) => harness.runTool(inbox, noHandler, body);
  return { boxes, pool, app, run };
}

Deno.test("list (imap): rows carry is_flagged from \\Flagged, newest first", async () => {
  const { app, pool, run } = await rig();
  const { value } = await run(() => app.mail("list", { folder: "inbox", limit: 10 }));
  assertEquals(value.status, 200, JSON.stringify(value.body));
  assertEquals(
    value.body.messages.map((m: { id: string; is_flagged: boolean; is_read: boolean }) => [m.id, m.is_flagged, m.is_read]),
    [["INBOX:4", false, false], ["INBOX:3", true, false], ["INBOX:2", false, false], ["INBOX:1", false, true]],
  );
  await pool.closeAll();
});

Deno.test("pool: three requests, one IMAP connection, no LOGOUT in between", async () => {
  const { app, pool, run } = await rig();
  await run(async () => {
    for (let i = 0; i < 3; i++) assertEquals((await app.mail("list", { folder: "inbox", limit: 10 })).status, 200);
  });
  assertEquals(pool.servers.length, 1, "dialled once");
  assertEquals(pool.connects, 3, "the tool layer asked for a connection on every request");
  assertEquals(pool.servers[0].logoutReceived, false);
  assertEquals(pool.stats.reuses, 2);
  const lines = app.logs.filter((l) => l.event === "request").map((l) => [l.fields["imap_dials"], l.fields["imap_reuses"]]);
  assertEquals(lines, [[1, 0], [0, 1], [0, 1]], "the log line says which requests dialled");
  await pool.closeAll();
  assertEquals(pool.servers[0].logoutReceived, true);
});

Deno.test("read (imap): the message body, without marking it read", async () => {
  const { app, pool, run, boxes } = await rig();
  const { value } = await run(() => app.mail("read", { message_id: "INBOX:2", include_html: false }));
  assertEquals(value.status, 200, JSON.stringify(value.body));
  assertEquals([value.body.id, value.body.subject, value.body.body_text?.trim()], ["INBOX:2", "Message 2", "Body of message 2."]);
  assertEquals(boxes[0].messages.find((m) => m.uid === 2)!.flags, [], "reading did not set \\Seen");
  await pool.closeAll();
});

Deno.test("flag (imap): read and starred are stored on the server, on the pooled connection", async () => {
  const { app, pool, run, boxes } = await rig();
  const { value } = await run(async () => {
    await app.mail("list", { folder: "inbox" });
    return await app.mail("flag", { message_ids: ["INBOX:2"], read: true, starred: true });
  });
  assertEquals(value.status, 200, JSON.stringify(value.body));
  assertEquals(boxes[0].messages.find((m) => m.uid === 2)!.flags.slice().sort(), ["\\Flagged", "\\Seen"]);
  assertEquals(pool.servers.length, 1, "list and both flag calls shared one connection");
  const after = await run(() => app.mail("list", { folder: "inbox" }));
  const row = after.value.body.messages.find((m: { id: string }) => m.id === "INBOX:2");
  assertEquals([row.is_read, row.is_flagged], [true, true]);
  await pool.closeAll();
});

Deno.test("status (imap): fingerprints are stable when nothing changes and move on a new message, a read and a star", async () => {
  const { app, pool, run, boxes } = await rig();
  const status = async () => (await run(() => app.mail("status", { folders: ["inbox", "Archive"] }))).value;

  const first = await status();
  assertEquals(first.status, 200, JSON.stringify(first.body));
  assertEquals(first.body.provider, "imap");
  assertEquals(first.body.folders.map((f: { folder: string; id: string; total: number; unread: number }) => [f.folder, f.id, f.total, f.unread]), [
    ["inbox", "INBOX", 4, 3],
    ["Archive", "Archive", 1, 0],
  ]);
  const [inbox1, archive1] = first.body.folders.map((f: { fingerprint: string }) => f.fingerprint);
  assert(inbox1 !== archive1);

  const second = await status();
  assertEquals(second.body.folders.map((f: { fingerprint: string }) => f.fingerprint), [inbox1, archive1], "unchanged mailbox, same fingerprints");

  // A star (no change to any counter) still moves the fingerprint via HIGHESTMODSEQ.
  await run(() => app.mail("flag", { message_ids: ["INBOX:1"], starred: true }));
  const third = await status();
  const inbox3 = third.body.folders[0].fingerprint;
  assert(inbox3 !== inbox1, "a star moved INBOX's fingerprint");
  assertEquals(third.body.folders[1].fingerprint, archive1, "Archive did not move");
  assertEquals([third.body.folders[0].total, third.body.folders[0].unread], [4, 3]);

  // New mail.
  boxes[0].messages.push(fakeTextMessage(5));
  const fourth = await status();
  assert(fourth.body.folders[0].fingerprint !== inbox3);
  assertEquals([fourth.body.folders[0].total, fourth.body.folders[0].unread], [5, 4]);

  // The whole poll sequence used one connection and never re-listed the mailbox.
  assertEquals(pool.servers.length, 1);
  assertEquals(pool.servers[0].commands.filter((c) => /FETCH/.test(c)).length, 0, "status never fetches a message");
  await pool.closeAll();
});

Deno.test("status (imap): a folder that does not exist reports an error for that folder only", async () => {
  const { app, pool, run } = await rig();
  const { value } = await run(() => app.mail("status", { folders: ["inbox", "No Such Folder"] }));
  assertEquals(value.status, 200, JSON.stringify(value.body));
  assertEquals(value.body.folders[0].total, 4);
  assertEquals([value.body.folders[1].fingerprint, typeof value.body.folders[1].error], [null, "string"]);
  await pool.closeAll();
});

Deno.test("status (imap): without CONDSTORE the fingerprint still follows counters and UIDNEXT", async () => {
  const boxes = mailboxes();
  for (const box of boxes) delete box.modSeq;
  const pool = new FakeDialPool(imapServer(boxes));
  const app = await realApp({ pool });
  const inbox = await imapInbox();
  const status = async () => (await harness.runTool(inbox, noHandler, () => app.mail("status", { folders: ["inbox"] }))).value.body.folders[0];
  const a = await status();
  // No HIGHESTMODSEQ ("-"), then the flags digest of the newest messages.
  assert(/:-:[a-z0-9]+$/.test(a.fingerprint), a.fingerprint);
  boxes[0].messages.find((m) => m.uid === 2)!.flags = ["\\Seen"];
  const b = await status();
  assert(b.fingerprint !== a.fingerprint, "a read elsewhere changes UNSEEN");
  await pool.closeAll();
});

Deno.test("attachment (imap): the decoded bytes, as a download", async () => {
  const { app, pool, run } = await rig();
  const { value } = await run(() => app.mail("attachment", { message_id: "INBOX:4", attachment_index: 0 }));
  assertEquals(value.status, 200);
  assertEquals(value.response.headers.get("content-type"), "application/octet-stream");
  assert((value.response.headers.get("content-disposition") ?? "").includes('filename="notes.txt"'));
  assertEquals(new TextDecoder("latin1").decode(value.body as Uint8Array), "attached bytes æø");
  await pool.closeAll();
});

Deno.test("batch (imap): calls for one inbox share ONE session and run in order", async () => {
  const { app, pool, run } = await rig();
  const calls = [
    { op: "list", inbox_id: INBOX_ID, args: { folder: "inbox", limit: 2 } },
    { op: "read", inbox_id: INBOX_ID, args: { message_id: "INBOX:1", include_html: false } },
    { op: "status", inbox_id: INBOX_ID, args: { folders: ["inbox"] } },
    { op: "read", inbox_id: INBOX_ID, args: { message_id: "Archive:9", include_html: false } },
    { op: "read", inbox_id: INBOX_ID, args: { message_id: "INBOX:999", include_html: false } },
    { op: "list", inbox_id: INBOX_ID, args: { folder: "Archive" } },
  ];
  const { value } = await run(async () => {
    const response = await app.handle(request("/mail/batch", { token: app.token, body: { calls } }));
    return { status: response.status, body: await response.json() };
  });
  assertEquals(value.status, 200);
  const results = value.body.results;
  assertEquals(results.map((r: { ok: boolean }) => r.ok), [true, true, true, true, false, true]);
  assertEquals(results[0].result.messages.map((m: { id: string }) => m.id), ["INBOX:4", "INBOX:3"]);
  assertEquals(results[1].result.id, "INBOX:1");
  assertEquals(results[2].result.folders[0].total, 4);
  assertEquals(results[3].result.id, "Archive:9");
  assertEquals(results[5].result.messages.map((m: { id: string }) => m.id), ["Archive:9"]);

  assertEquals(pool.connects, 6, "every call asked for a connection");
  const live = pool.servers.filter((s) => !s.closed);
  assert(pool.servers.length <= 2, `at most one replacement after the failed read, got ${pool.servers.length}`);
  assertEquals(live.length, 1, "exactly one connection is left open, idle in the pool");
  assertEquals(pool.stats.overflows, 0, "never two connections at once for the inbox");
  // In order: the first server saw the list's SELECT before the read's FETCH BODY.
  const first = pool.servers[0].commands;
  assert(first.findIndex((c) => c.startsWith("SELECT")) < first.findIndex((c) => /BODY\.PEEK\[\]/.test(c)));
  await pool.closeAll();
});

Deno.test("an IMAP auth failure is reconnect_required, and the dead credentials are not pooled", async () => {
  const pool = new FakeDialPool(() => {
    throw new Error("imap_auth_failed");
  });
  const app = await realApp({ pool });
  const { value } = await harness.runTool(await imapInbox(), noHandler, () => app.mail("list", { folder: "inbox" }));
  assertEquals([value.status, value.body.error.code], [409, "reconnect_required"]);
  assertEquals(pool.stats.idle, 0);
  await pool.closeAll();
});
