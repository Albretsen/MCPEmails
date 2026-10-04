// The parts of the HTTP contract the web client depends on field by field:
// reply recipients, what `read` carries, the ONE move/archive/delete result
// shape, `status` without CONDSTORE, and the human's bulk move. Each has its
// MCP counterpart beside it: the same executor without the first-party
// context answers exactly as it did before.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { fakeTextMessage, type FakeMailbox } from "../../mcp-server/imap-fake-server.ts";
import { FakeImapServer } from "../../mcp-server/imap-fake-server.ts";
import { OPS, relocateResult } from "../mail/ops.ts";
import { decodeRaw, FakeDialPool, gmailHandler, type GmailWorld, harness, imapInbox, imapServer, INBOX_ID, mcp, realApp } from "./real-seam.ts";

function gmail(): GmailWorld {
  return {
    historyId: "1",
    sent: [],
    modified: [],
    messages: [
      {
        id: "g1",
        from: "Maya <maya@north.example>",
        to: "owner@gmail-harness.example, Odd <odd@fjord.example>",
        cc: "Ida <ida@fjell.example>",
        subject: "Renewal",
        text: "Original body",
        labelIds: ["INBOX", "STARRED"],
      },
      { id: "g2", from: "B <b@x.example>", to: "owner@gmail-harness.example", subject: "Archived", text: "x", labelIds: ["Label_7"] },
    ],
  };
}

const header = (raw: string, name: string) => new RegExp(`^${name}: (.*)$`, "mi").exec(raw)?.[1] ?? null;

Deno.test("reply: explicit to/cc/bcc are the whole recipient set, and the reply is still threaded", async () => {
  const w = gmail();
  const app = await realApp();
  const { value } = await harness.runTool(await harness.inboxRow("gmail"), gmailHandler(w), () =>
    app.mail("reply", {
      message_id: "g1",
      reply_all: true,
      to: ["someone.else@north.example"],
      cc: ["copy@north.example"],
      bcc: ["hidden@north.example"],
      body: "Edited recipients.",
      idempotency_key: "reply-key-0001",
    }));
  assertEquals(value.status, 200, JSON.stringify(value.body));
  assertEquals(w.sent.length, 1);
  const raw = decodeRaw(w.sent[0].raw);
  assertEquals(header(raw, "To"), "someone.else@north.example", "To is exactly what was given: nothing derived, even with reply_all");
  assertEquals(header(raw, "Cc"), "copy@north.example");
  assertStringIncludes(header(raw, "Bcc") ?? "", "hidden@north.example");
  assert(!raw.split("\n\n")[0].includes("maya@north.example"), "the original sender is not added back");
  assertEquals((w.sent[0] as unknown as { threadId?: string }).threadId, "thread-g1", "sent into the original's Gmail thread");
  assertEquals(header(raw, "Subject"), "Re: Renewal");
  assertEquals(value.body.to.map((a: { email: string }) => a.email), ["someone.else@north.example"]);
  assertEquals(value.body.in_reply_to, "g1");
});

Deno.test("reply: without `to` the recipients are derived, and cc/bcc are additions", async () => {
  const w = gmail();
  const app = await realApp();
  const { value } = await harness.runTool(await harness.inboxRow("gmail"), gmailHandler(w), () =>
    app.mail("reply", { message_id: "g1", reply_all: true, cc: ["copy@north.example"], body: "Derived.", idempotency_key: "reply-key-0002" }));
  assertEquals(value.status, 200, JSON.stringify(value.body));
  const raw = decodeRaw(w.sent[0].raw);
  const to = header(raw, "To") ?? "";
  for (const address of ["maya@north.example", "odd@fjord.example", "ida@fjell.example"]) assertStringIncludes(to, address);
  assert(!to.includes("owner@gmail-harness.example"), "this mailbox is not answered");
  assertEquals(header(raw, "Cc"), "copy@north.example");

  const plain = gmail();
  await harness.runTool(await harness.inboxRow("gmail"), gmailHandler(plain), () =>
    app.mail("reply", { message_id: "g1", body: "Sender only.", idempotency_key: "reply-key-0003" }));
  assertEquals(header(decodeRaw(plain.sent[0].raw), "To"), "Maya <maya@north.example>");
});

Deno.test("reply: an MCP caller cannot redirect a reply with `to` (the executor does not read it outside client-api)", async () => {
  const w = gmail();
  const key = { ...harness.API_KEY, scopes: ["send:email", "read:email"] };
  const { value } = await harness.runTool(await harness.inboxRow("gmail"), gmailHandler(w), () =>
    mcp.dispatchExecutor("email_reply", { inbox_id: INBOX_ID, message_id: "g1", to: ["attacker@elsewhere.example"], body: "Hi" }, key));
  assertEquals(value!.logStatus, "success", JSON.stringify(value));
  const raw = decodeRaw(w.sent[0].raw);
  assertEquals(header(raw, "To"), "Maya <maya@north.example>");
  assert(!raw.includes("attacker@elsewhere.example"));
});

Deno.test("reply: the op accepts `to` and still refuses unknown arguments", () => {
  const call = OPS["reply"].build({ message_id: "m", to: [{ email: "a@b.example" }], body: "x", idempotency_key: "k" })[0];
  assertEquals(call.args["to"], ["a@b.example"]);
  assertEquals("to" in OPS["reply"].build({ message_id: "m", to: [], body: "x" })[0].args, false, "an empty To means derive");
  let refused = false;
  try {
    OPS["reply"].build({ message_id: "m", body: "x", subject: "no" });
  } catch {
    refused = true;
  }
  assert(refused);
});

Deno.test("read (gmail): carries is_flagged and folder; the MCP result has neither and is otherwise byte-identical", async () => {
  const app = await realApp();
  const viaClient = await harness.runTool(await harness.inboxRow("gmail"), gmailHandler(gmail()), () =>
    app.mail("read", { message_id: "g1", include_html: false }));
  assertEquals(viaClient.value.status, 200, JSON.stringify(viaClient.value.body));
  assertEquals([viaClient.value.body.is_flagged, viaClient.value.body.folder], [true, "INBOX"]);

  const label = await harness.runTool(await harness.inboxRow("gmail"), gmailHandler(gmail()), () =>
    app.mail("read", { message_id: "g2", include_html: false }));
  assertEquals([label.value.body.is_flagged, label.value.body.folder], [false, "Label_7"]);

  const viaMcp = await harness.runTool(await harness.inboxRow("gmail"), gmailHandler(gmail()), () =>
    mcp.handleToolsCall(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "email_read", arguments: { action: "read", inbox_id: INBOX_ID, message_id: "g1", include_html: false, include_attachments: false } } },
      1,
      { ...harness.API_KEY, scopes: ["read:email", "search:email"] },
      { ipAddress: null, userAgent: "contract-test" },
    ));
  const result = viaMcp.value.result as { structuredContent: Record<string, unknown> };
  const wire = JSON.stringify(viaMcp.value);
  assert(!wire.includes("is_flagged"), "no is_flagged on the MCP wire");
  assert(!("folder" in result.structuredContent), "no folder on the MCP result");
  const stripped = { ...viaClient.value.body };
  delete stripped.is_flagged;
  delete stripped.folder;
  // Conversation threading: the Message-ID and the key computed from it.
  assertEquals(typeof stripped.thread_key, "string");
  delete stripped.message_id_header;
  delete stripped.thread_key;
  assertEquals(JSON.stringify(stripped), JSON.stringify(result.structuredContent), "identical bytes once the client-only keys are removed");
  assertEquals(harness.requestMultiset(viaClient.world), harness.requestMultiset(viaMcp.world), "same provider requests");
});

function imapBoxes(): FakeMailbox[] {
  const starred = fakeTextMessage(3);
  starred.flags = ["\\Flagged", "\\Seen"];
  return [
    { name: "INBOX", attrs: ["\\HasNoChildren"], messages: [fakeTextMessage(1), fakeTextMessage(2), starred, fakeTextMessage(4)] },
    { name: "Archive", attrs: ["\\HasNoChildren", "\\Archive"], messages: [fakeTextMessage(9, { seen: true })] },
    { name: "Trash", attrs: ["\\HasNoChildren", "\\Trash"], messages: [] },
    { name: "Receipts", attrs: ["\\HasNoChildren"], messages: [] },
  ];
}
const none: harness.ProviderHandler = (call) => harness.json({ error: `unexpected provider call ${call.url}` }, 500);

Deno.test("read (imap): is_flagged from \\Flagged and the folder the id names", async () => {
  const pool = new FakeDialPool(imapServer(imapBoxes()));
  const app = await realApp({ pool });
  const { value } = await harness.runTool(await imapInbox(), none, async () => [
    await app.mail("read", { message_id: "INBOX:3", include_html: false }),
    await app.mail("read", { message_id: "Archive:9", include_html: false }),
  ]);
  assertEquals(value.map((v) => [v.status, v.body.is_flagged, v.body.folder]), [[200, true, "INBOX"], [200, false, "Archive"]]);
  await pool.closeAll();
});

Deno.test("move / archive / delete (imap): one result shape, with the id each message has now", async () => {
  const boxes = imapBoxes();
  const pool = new FakeDialPool(imapServer(boxes));
  const app = await realApp({ pool });
  const { value } = await harness.runTool(await imapInbox(), none, async () => ({
    move: await app.mail("move", { message_ids: ["INBOX:1", "INBOX:77"], destination_folder_id: "Receipts" }),
    archiveOne: await app.mail("archive", { message_ids: ["INBOX:2"] }),
    trash: await app.mail("delete", { message_ids: ["INBOX:3"] }),
    gone: await app.mail("delete", { message_ids: ["INBOX:4"], permanent: true }),
  }));
  assertEquals(value.move.status, 200, JSON.stringify(value.move.body));
  assertEquals(value.move.body, {
    succeeded: 1,
    failed: 1,
    results: [
      { message_id: "INBOX:1", success: true, new_message_id: "Receipts:1" },
      { message_id: "INBOX:77", success: false, error: value.move.body.results[1].error },
    ],
  });
  assertEquals(typeof value.move.body.results[1].error, "string");
  assertEquals(value.archiveOne.body, { succeeded: 1, failed: 0, results: [{ message_id: "INBOX:2", success: true, new_message_id: "Archive:10" }] });
  assertEquals(value.trash.body, { succeeded: 1, failed: 0, results: [{ message_id: "INBOX:3", success: true, new_message_id: "Trash:1" }] });
  assertEquals(value.gone.body, { succeeded: 1, failed: 0, results: [{ message_id: "INBOX:4", success: true, new_message_id: null }] });
  // The scripted server has no EXPUNGE: the permanently deleted message is the one left, flagged \\Deleted.
  assertEquals(boxes[0].messages.map((m) => [m.uid, m.flags.includes("\\Deleted")]), [[4, true]]);
  // Undo: the id that came back is a working id.
  const back = await harness.runTool(await imapInbox(), none, () => app.mail("move", { message_ids: ["Trash:1"], destination_folder_id: "INBOX" }));
  assertEquals(back.value.body.results[0].success, true, JSON.stringify(back.value.body));
  await pool.closeAll();
});

Deno.test("move (imap without UIDPLUS): the move succeeds and new_message_id is null, never the stale id", async () => {
  const boxes = imapBoxes();
  const pool = new FakeDialPool(() => Object.assign(new FakeImapServer({ mailboxes: boxes, uidplus: false }), { advertised: ["IMAP4REV1"] }));
  const app = await realApp({ pool });
  const { value } = await harness.runTool(await imapInbox(), none, () => app.mail("move", { message_ids: ["INBOX:1"], destination_folder_id: "Receipts" }));
  assertEquals(value.body.results, [{ message_id: "INBOX:1", success: true, new_message_id: null }]);
  assertEquals(boxes[3].messages.length, 1);
  await pool.closeAll();
});

Deno.test("delete (imap): the MCP executor's rows gain no new_message_id", async () => {
  const boxes = imapBoxes();
  const pool = new FakeDialPool(imapServer(boxes));
  const { firstPartyContext } = await import("../../mcp-server/first-party.ts");
  const { value } = await harness.runTool(await imapInbox(), none, () =>
    firstPartyContext.run(
      { imapConnect: <C>() => pool.dial() as unknown as Promise<C> },
      () => mcp.dispatchExecutor("email_delete_batch", { inbox_id: INBOX_ID, message_ids: ["INBOX:1"] }, { ...harness.API_KEY, scopes: ["delete:email", "read:email", "send:email"] }),
    ));
  assertEquals(value!.logStatus, "success", JSON.stringify(value));
  assert(!JSON.stringify(value).includes("new_message_id"));
  assertEquals(boxes[2].messages.length, 1);
});

Deno.test("move / archive / delete (gmail): the same shape, ids unchanged", async () => {
  const w = gmail();
  const app = await realApp();
  const { value } = await harness.runTool(await harness.inboxRow("gmail"), gmailHandler(w), async () => ({
    move: await app.mail("move", { message_ids: ["g1", "g2"], destination_folder_id: "archive" }),
    archive: await app.mail("archive", { message_ids: ["g1"] }),
  }));
  assertEquals(value.move.status, 200, JSON.stringify(value.move.body));
  assertEquals(value.move.body.results, [
    { message_id: "g1", success: true, new_message_id: "g1" },
    { message_id: "g2", success: true, new_message_id: "g2" },
  ]);
  assertEquals(value.archive.body, { succeeded: 1, failed: 0, results: [{ message_id: "g1", success: true, new_message_id: "g1" }] });
});

Deno.test("relocateResult: an id the executor did not report is not_processed, never assumed moved", () => {
  const call = { tool: "email_move_batch", args: { message_ids: ["a", "b", "a"] } };
  assertEquals(relocateResult({ results: [{ message_id: "a", success: true }] }, call, { provider: "outlook" }), {
    succeeded: 1,
    failed: 1,
    results: [{ message_id: "a", success: true, new_message_id: "a" }, { message_id: "b", success: false, error: "not_processed" }],
  });
  assertEquals(relocateResult({ plan_id: "p", status: "pending" }, call, { provider: "gmail" }).succeeded, 0, "a plan moved nothing");
  assertEquals(relocateResult({ results: [{ message_id: "a", success: true }] }, call, { provider: null }).results[0], {
    message_id: "a",
    success: true,
    new_message_id: null,
  });
});

Deno.test("bulk review: the human's move runs now; the same call without the human marker becomes a plan", async () => {
  const inbox = () => harness.inboxRow("gmail", { bulk_review_mode: "plan" });
  const w = gmail();
  const app = await realApp();
  const human = await harness.runTool(await inbox(), gmailHandler(w), () =>
    app.mail("move", { message_ids: ["g1", "g2"], destination_folder_id: "archive" }));
  assertEquals(human.value.status, 200, JSON.stringify(human.value.body));
  assertEquals(human.value.body.succeeded, 2);
  assertEquals(w.modified.length, 2, "both messages were modified at the provider");
  assertEquals(human.world.db.filter((c) => c.target === "bulk_plans").length, 0, "no plan row");

  const w2 = gmail();
  const agent = await harness.runTool(await inbox(), gmailHandler(w2), () =>
    mcp.dispatchExecutor("email_move_batch", { inbox_id: INBOX_ID, message_ids: ["g1", "g2"], destination_folder_id: "archive" }, {
      ...harness.API_KEY,
      scopes: ["read:email", "send:email", "manage:folders", "write:email"],
    }));
  assertEquals(w2.modified.length, 0, "the gate itself is unchanged: nothing moved");
  assert(agent.world.db.some((c) => c.target === "bulk_plans" && c.method === "POST"), JSON.stringify(agent.value).slice(0, 400));
});

Deno.test("status (imap, no CONDSTORE): a star or a read/unread swap set elsewhere moves the fingerprint; an old message's does not", async () => {
  const boxes = imapBoxes();
  const pool = new FakeDialPool(imapServer(boxes));
  const app = await realApp({ pool });
  const inbox = await imapInbox();
  const status = async () => (await harness.runTool(inbox, none, () => app.mail("status", { folders: ["inbox", "Archive", "Receipts"] }))).value.body.folders;
  const a = await status();
  assertEquals(a.map((f: { error?: string }) => f.error), [undefined, undefined, undefined]);
  assertEquals((await status()).map((f: { fingerprint: string }) => f.fingerprint), a.map((f: { fingerprint: string }) => f.fingerprint), "stable");

  // A star from another client: no counter moves.
  boxes[0].messages.find((m) => m.uid === 1)!.flags = ["\\Flagged"];
  const b = await status();
  assert(b[0].fingerprint !== a[0].fingerprint, "the star moved INBOX's fingerprint");
  assertEquals([b[0].total, b[0].unread], [a[0].total, a[0].unread]);
  assertEquals(b[1].fingerprint, a[1].fingerprint);

  // One read, one unread: UNSEEN stays the same.
  boxes[0].messages.find((m) => m.uid === 2)!.flags = ["\\Seen"];
  boxes[0].messages.find((m) => m.uid === 3)!.flags = ["\\Flagged"];
  const c = await status();
  assertEquals(c[0].unread, b[0].unread);
  assert(c[0].fingerprint !== b[0].fingerprint);

  // The digest costs one SELECT and one FETCH of flags per digest folder, and
  // only the first two folders with mail get one (Receipts is empty).
  const commands = pool.servers[0].commands;
  assert(commands.filter((x) => /^FETCH \d+:\d+ \(UID FLAGS\)$/.test(x)).length >= 2);
  assert(!commands.some((x) => /BODY|ENVELOPE/.test(x)), "never a body or an envelope");
  assertEquals(pool.servers.length, 1);
  await pool.closeAll();
});

Deno.test("status (imap): a folder id that no longer exists is folder_not_found for that entry only", async () => {
  const boxes = imapBoxes();
  const pool = new FakeDialPool(imapServer(boxes));
  const app = await realApp({ pool });
  const inbox = await imapInbox();
  const first = await harness.runTool(inbox, none, () => app.mail("status", { folders: ["INBOX", "Receipts"] }));
  assertEquals(first.value.body.folders.map((f: { id: string }) => f.id), ["INBOX", "Receipts"]);
  boxes.splice(3, 1); // Receipts is deleted in another client
  const { value } = await harness.runTool(inbox, none, () => app.mail("status", { folders: ["INBOX", "Receipts"] }));
  assertEquals(value.status, 200);
  assertEquals(Object.keys(value.body).sort(), ["folders", "inbox_id", "provider"]);
  assertEquals(Object.keys(value.body.folders[0]).sort(), ["fingerprint", "folder", "id", "total", "unread"]);
  const gone = value.body.folders[1];
  assertEquals([gone.folder, gone.total, gone.unread, gone.fingerprint, gone.error], ["Receipts", null, null, null, "folder_not_found"]);
  await pool.closeAll();
});

Deno.test("schedule_list: with no inbox_id the op is accepted and spans the workspace", async () => {
  const app = await realApp();
  const { value, world } = await harness.runTool(await harness.inboxRow("gmail"), gmailHandler(gmail()), () => app.mail("schedule_list", { limit: 100 }, null));
  assertEquals(value.status, 200, JSON.stringify(value.body));
  assertEquals(value.body, { scheduled_sends: [], total: 0 });
  const query = world.db.find((c) => c.target === "scheduled_sends")!;
  assert(query.query.includes("workspace_id=eq."), query.query);
  assert(!query.query.includes("inbox_id=eq."), "no inbox filter without an inbox_id");
  assert(query.query.includes("inbox_id"), "every row carries its inbox_id");
});
