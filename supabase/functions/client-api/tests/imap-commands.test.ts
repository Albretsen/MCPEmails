// The IMAP command budget of the hot ops on a WARM pooled connection.
//
// Measured live (2026-10-04, Migadu, one round trip ~33 ms, a SELECT ~90 ms, a
// LIST ~57 ms, a database round trip ~70 ms): every command is a round trip, so
// the commands an op sends ARE its latency. These tests pin the transcript of
// each hot op, so a redundant SELECT, LIST or database write cannot creep back
// in unnoticed, and they pin the two things the shortcuts must never break:
// a listing always sees new mail, and the folder listing is always fresh.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fakeTextMessage, type FakeMailbox } from "../../mcp-server/imap-fake-server.ts";
import { FakeDialPool, harness, imapInbox, imapServer, realApp } from "./real-seam.ts";

function mailboxes(): FakeMailbox[] {
  return [
    {
      name: "INBOX",
      attrs: ["\\HasNoChildren"],
      modSeq: 100,
      messages: [fakeTextMessage(1, { seen: true }), fakeTextMessage(2), fakeTextMessage(3), fakeTextMessage(4)],
    },
    { name: "Archive", attrs: ["\\HasNoChildren", "\\Archive"], modSeq: 7, messages: [fakeTextMessage(9, { seen: true })] },
    { name: "Sent", attrs: ["\\HasNoChildren", "\\Sent"], modSeq: 3, messages: [fakeTextMessage(11, { seen: true })] },
    { name: "Trash", attrs: ["\\HasNoChildren", "\\Trash"], modSeq: 2, messages: [] },
  ];
}

const noHandler: harness.ProviderHandler = (call) => harness.json({ error: `unexpected provider call ${call.url}` }, 500);

async function rig(options: { warm?: boolean; pool?: Record<string, unknown> } = {}) {
  const boxes = mailboxes();
  const pool = new FakeDialPool(imapServer(boxes), options.pool ?? {});
  const app = await realApp({ pool });
  const inbox = await imapInbox();
  const run = <T>(body: () => Promise<T>) => harness.runTool(inbox, noHandler, body);
  /** What the op sent on the pooled connection, what it wrote to the database, and its answer. */
  const op = async (name: string, args: Record<string, unknown>) => {
    const before = pool.servers[0]?.commands.length ?? 0;
    const { value, world } = await run(() => app.mail(name, args));
    assertEquals(value.status, 200, JSON.stringify(value.body));
    assertEquals(pool.servers.length, 1, `${name} stayed on the one pooled connection`);
    const commands = pool.servers[0].commands.slice(before);
    return {
      commands,
      verbs: commands.map((c) => c.replace(/^UID /, "UID_").split(" ")[0]),
      tables: world.db.map((d) => `${d.method} ${d.target}`),
      body: value.body,
    };
  };
  // Warm the connection the way a client does: one list of the inbox.
  if (options.warm !== false) await run(() => app.mail("list", { folder: "inbox", limit: 25 }));
  return { boxes, pool, app, run, op };
}

Deno.test("command budget: transcripts of the hot ops (DUMP_IMAP=1 prints them)", async () => {
  const { pool, op } = await rig();
  const dump: Record<string, string[]> = {};
  dump["list"] = (await op("list", { folder: "inbox", limit: 25 })).commands;
  dump["read"] = (await op("read", { message_id: "INBOX:2", include_html: true })).commands;
  dump["status x3"] = (await op("status", { folders: ["inbox", "archive", "sent"] })).commands;
  dump["status x3 again"] = (await op("status", { folders: ["inbox", "archive", "sent"] })).commands;
  dump["flag read"] = (await op("flag", { message_ids: ["INBOX:2"], read: true })).commands;
  dump["move"] = (await op("move", { message_ids: ["INBOX:3"], destination_folder_id: "archive" })).commands;
  dump["archive"] = (await op("archive", { message_ids: ["INBOX:4"] })).commands;
  dump["delete"] = (await op("delete", { message_ids: ["INBOX:2"] })).commands;
  dump["folders"] = (await op("folders", {})).commands;
  if (Deno.env.get("DUMP_IMAP")) {
    for (const [name, commands] of Object.entries(dump)) console.log(`${name} (${commands.length}):\n  ${commands.map((c) => c.slice(0, 150)).join("\n  ")}`);
  }
  assert(Object.values(dump).every((c) => c.length > 0));
  await pool.closeAll();
});

Deno.test("read: re-entering the selected mailbox costs a NOOP, not a SELECT; another mailbox is SELECTed", async () => {
  const { pool, op } = await rig();
  assertEquals((await op("read", { message_id: "INBOX:2", include_html: false })).verbs, ["NOOP", "UID_FETCH"]);
  assertEquals((await op("read", { message_id: "INBOX:3", include_html: false })).verbs, ["NOOP", "UID_FETCH"]);
  // A different mailbox: a real SELECT, and the connection now has THAT one selected.
  assertEquals((await op("read", { message_id: "Archive:9", include_html: false })).verbs, ["SELECT", "UID_FETCH"]);
  assertEquals((await op("read", { message_id: "Archive:9", include_html: false })).verbs, ["NOOP", "UID_FETCH"]);
  const back = await op("read", { message_id: "INBOX:2", include_html: false });
  assertEquals(back.verbs, ["SELECT", "UID_FETCH"], "back in INBOX: selected again, never assumed");
  assertEquals(back.body.id, "INBOX:2");
  assertEquals(back.body.folder, "INBOX");
  await pool.closeAll();
});

Deno.test("read: a message that arrived after the mailbox was selected is found (NOOP delivers it)", async () => {
  const { pool, op, boxes } = await rig();
  boxes[0].messages.push(fakeTextMessage(5, { subject: "Arrived later" }));
  const read = await op("read", { message_id: "INBOX:5", include_html: false });
  assertEquals(read.verbs, ["NOOP", "UID_FETCH"]);
  assertEquals(read.body.subject, "Arrived later");
  await pool.closeAll();
});

Deno.test("list: ALWAYS a real SELECT, so a listing on a long-selected connection still shows new mail", async () => {
  const { pool, op, boxes } = await rig();
  await op("read", { message_id: "INBOX:2", include_html: false });
  boxes[0].messages.push(fakeTextMessage(5));
  const listed = await op("list", { folder: "inbox", limit: 25 });
  assertEquals(listed.verbs, ["SELECT", "FETCH"]);
  assertEquals(listed.body.messages.map((m: { id: string }) => m.id), ["INBOX:5", "INBOX:4", "INBOX:3", "INBOX:2", "INBOX:1"]);
  assertEquals(listed.body.total, 5);
  await pool.closeAll();
});

Deno.test("flag / move / archive / delete: NOOP + presence probe + the one mutating command, and no bulk_runs row for a human", async () => {
  const { pool, op, boxes } = await rig();
  // The first op that needs an alias resolves it with one LIST; nothing after it lists again.
  await op("status", { folders: ["inbox", "archive", "trash"] });

  const flag = await op("flag", { message_ids: ["INBOX:2"], read: true });
  assertEquals(flag.verbs, ["NOOP", "UID_SEARCH", "UID_STORE"]);
  assertEquals(boxes[0].messages.find((m) => m.uid === 2)!.flags, ["\\Seen"]);

  const both = await op("flag", { message_ids: ["INBOX:2"], read: false, starred: true });
  assertEquals(both.verbs, ["NOOP", "UID_SEARCH", "UID_STORE", "NOOP", "UID_SEARCH", "UID_STORE"]);
  assertEquals(boxes[0].messages.find((m) => m.uid === 2)!.flags, ["\\Flagged"]);

  const move = await op("move", { message_ids: ["INBOX:3"], destination_folder_id: "archive" });
  assertEquals(move.verbs, ["NOOP", "UID_SEARCH", "UID_MOVE"]);
  assertEquals(move.body.succeeded, 1);
  assert(typeof move.body.results[0].new_message_id === "string" && move.body.results[0].new_message_id.startsWith("Archive:"));

  const archive = await op("archive", { message_ids: ["INBOX:4"] });
  assertEquals(archive.verbs, ["NOOP", "UID_SEARCH", "UID_MOVE"]);

  const del = await op("delete", { message_ids: ["INBOX:2"] });
  assertEquals(del.verbs, ["NOOP", "UID_SEARCH", "UID_MOVE"]);
  assertEquals(del.body.succeeded, 1);

  for (const result of [flag, both, move, archive, del]) {
    assertEquals(result.tables.filter((t) => /bulk_runs/.test(t)), [], "a person's click is not recorded as a bulk run");
  }
  assertEquals(boxes[0].messages.map((m) => m.uid), [1]);
  await pool.closeAll();
});

Deno.test("a human selection above the unrecorded size still gets its bulk run (observable, stoppable)", async () => {
  const { pool, run, app } = await rig();
  const ids = Array.from({ length: 51 }, (_, i) => `INBOX:${i + 1}`);
  const { value, world } = await run(() => app.mail("flag", { message_ids: ids, read: true }));
  assert(value.status === 200 || value.status >= 400);
  assert(world.db.some((d) => d.target === "bulk_runs"), "51 ids: the run is recorded");
  await pool.closeAll();
});

Deno.test("status: three folders cost three STATUS commands; the folder list is asked for once, then remembered", async () => {
  const { pool, op } = await rig();
  const first = await op("status", { folders: ["inbox", "archive", "sent"] });
  assertEquals(first.verbs, ["STATUS", "LIST", "STATUS", "STATUS"]);
  const second = await op("status", { folders: ["inbox", "archive", "sent"] });
  assertEquals(second.verbs, ["STATUS", "STATUS", "STATUS"]);
  assertEquals(second.body.folders.map((f: { id: string }) => f.id), ["INBOX", "Archive", "Sent"]);
  assertEquals(pool.stats.listHits >= 2, true);
  await pool.closeAll();
});

Deno.test("folders: never served from memory, and what it learns is what alias resolution then uses", async () => {
  const { pool, op, boxes } = await rig();
  await op("status", { folders: ["inbox", "archive"] });
  // Another mail client creates a folder.
  boxes.push({ name: "Receipts", attrs: ["\\HasNoChildren"], modSeq: 1, messages: [fakeTextMessage(21)] });
  const folders = await op("folders", {});
  assertEquals(folders.verbs[0], "LIST", "the folder listing asks the server");
  assert(folders.body.folders.some((f: { id: string }) => f.id === "Receipts"));
  const again = await op("folders", {});
  assertEquals(again.verbs[0], "LIST", "every time");
  // The list op resolves the new folder from what `folders` just learnt: no LIST of its own.
  const listed = await op("list", { folder: "Receipts", limit: 5 });
  assertEquals(listed.verbs.filter((v) => v === "LIST"), []);
  assertEquals(listed.body.messages.map((m: { id: string }) => m.id), ["Receipts:21"]);
  await pool.closeAll();
});

Deno.test("the remembered folder list expires: after listTtlMs the server is asked again", async () => {
  let now = 1_000_000;
  const { pool, op } = await rig({ pool: { now: () => now, listTtlMs: 60_000, idleTtlMs: 10 * 60_000, validateAfterIdleMs: 10 * 60_000 } });
  assertEquals((await op("status", { folders: ["archive"] })).verbs, ["LIST", "STATUS"]);
  now += 59_000;
  assertEquals((await op("status", { folders: ["archive"] })).verbs, ["STATUS"]);
  now += 2_000;
  assertEquals((await op("status", { folders: ["archive"] })).verbs, ["LIST", "STATUS"]);
  await pool.closeAll();
});

Deno.test("listTtlMs: 0 turns the folder-list memory off", async () => {
  const { pool, op } = await rig({ pool: { listTtlMs: 0 } });
  assertEquals((await op("status", { folders: ["archive"] })).verbs, ["LIST", "STATUS"]);
  assertEquals((await op("status", { folders: ["archive"] })).verbs, ["LIST", "STATUS"]);
  await pool.closeAll();
});

Deno.test("the request log line carries the method trace: names and milliseconds, nothing from the mailbox", async () => {
  const { pool, op, app } = await rig();
  await op("read", { message_id: "INBOX:2", include_html: false });
  const line = app.logs.filter((l) => l.event === "request").at(-1)!;
  const calls = String(line.fields["imap_calls"]);
  assert(/^reselect:\d+,fetchMessageRaw:\d+$/.test(calls), calls);
  assert(!/INBOX|Message 2|@|\s/.test(calls));
  await pool.closeAll();
});
