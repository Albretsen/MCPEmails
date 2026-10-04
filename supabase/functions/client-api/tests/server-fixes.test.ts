// Regression tests for the 2026-10-04 server fixes: a forward that reads back
// whole, folder roles, the per-inbox queue, queued requests behind a refused
// login, and clean list previews. Real tool layer, scripted fake servers, no
// sockets. Every fixture is invented.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { firstPartyContext } from "../../mcp-server/first-party.ts";
import { buildRelayForwardMime } from "../../mcp-server/forward-relay.ts";
import type { ImapClient } from "../../mcp-server/imap-client.ts";
import { type FakeMailbox, FakeImapServer, type FakeMessage, fakeTextMessage } from "../../mcp-server/imap-fake-server.ts";
import { parseEmail, parseEmailJoined } from "../../mcp-server/mime.ts";
import { cleanPreviewFromBodyPart, htmlPreviewText } from "../../mcp-server/text-extract.ts";
import { ImapPool, nextInQueue, type QueueClass } from "../imap-pool.ts";
import { forgetOutlookRolesForTests, imapFolderRoles } from "../mail/roles.ts";
import { FakeDialPool, gmailHandler, harness, imapInbox, imapServer, INBOX_ID, mcp, realApp } from "./real-seam.ts";

const CRLF = "\r\n";
const none: harness.ProviderHandler = (call) => harness.json({ error: `unexpected ${call.url}` }, 500);
const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One character per octet, as the fake server stores a message. */
function octets(text: string): string {
  return String.fromCharCode(...new TextEncoder().encode(text));
}

function message(uid: number, headers: string[], body: string): FakeMessage {
  return {
    uid,
    flags: [],
    raw: [
      "Date: 01 Sep 2026 10:00:00 +0000",
      'From: "Sender" <sender@example.com>',
      "To: <owner@example.com>",
      `Subject: Fixture ${uid}`,
      `Message-ID: <fixture${uid}@example.com>`,
      ...headers,
      "",
      body,
    ].join(CRLF),
  };
}

// ── 1. forward ───────────────────────────────────────────────────────────────

const ORIGINAL_TEXT = "The original paragraph that must survive a forward.";

function forwardedMessage(uid: number, original: FakeMessage): FakeMessage {
  const built = buildRelayForwardMime({
    from: "Owner <owner@example.com>",
    to: ["owner@example.com"],
    subject: "Fwd: Fixture",
    messageId: "00000000-0000-4000-8000-000000000001",
    introText: "A note above.\n\n---------- Forwarded message ----------\nFrom: Sender\n",
    original: Uint8Array.from(original.raw, (c) => c.charCodeAt(0)),
    includeAttachments: true,
    asAttachment: false,
  });
  return { uid, flags: [], raw: String.fromCharCode(...built.bytes) };
}

Deno.test("forward: the relay carries the original's bytes; the fault was the read keeping only the first text part", () => {
  const forwarded = forwardedMessage(2, fakeTextMessage(1, { body: ORIGINAL_TEXT }));
  assert(forwarded.raw.includes(ORIGINAL_TEXT), "the original text is in what is sent");
  const first = parseEmail(forwarded.raw);
  assert(first.text!.includes("Forwarded message") && !first.text!.includes(ORIGINAL_TEXT), "first-part-wins drops it");
  const joined = parseEmailJoined(forwarded.raw, (html) => html);
  assert(joined.text!.includes("A note above.") && joined.text!.includes(ORIGINAL_TEXT));
  assert(joined.text!.indexOf("A note above.") < joined.text!.indexOf(ORIGINAL_TEXT), "in order");
});

Deno.test("read (imap): a forwarded message's body_text holds the note AND the original, for client-api and for the MCP read alike", async () => {
  const boxes: FakeMailbox[] = [{ name: "INBOX", messages: [forwardedMessage(2, fakeTextMessage(1, { body: ORIGINAL_TEXT }))] }];
  const inbox = await imapInbox();
  const pool = new FakeDialPool(imapServer(boxes));
  const app = await realApp({ pool });
  const viaClient = await harness.runTool(inbox, none, () => app.mail("read", { message_id: "INBOX:2" }));
  assertEquals(viaClient.value.status, 200, JSON.stringify(viaClient.value.body));
  const text = viaClient.value.body.body_text as string;
  assert(text.includes("A note above.") && text.includes("Forwarded message") && text.includes(ORIGINAL_TEXT), text);
  await pool.closeAll();

  // The executor as `handleToolsCall` runs it (the only hook swaps the socket).
  const plainPool = new FakeDialPool(imapServer(boxes));
  const plain = await harness.runTool(inbox, none, () =>
    firstPartyContext.run(
      { imapConnect: <C>() => plainPool.dial() as unknown as Promise<C> },
      () => mcp.dispatchExecutor("email_read", { inbox_id: INBOX_ID, message_id: "INBOX:2" }, harness.API_KEY),
    ));
  const mcpBody = (plain.value!.result as { structuredContent: { body_text: string } }).structuredContent.body_text;
  // Since 2026-10-04 the MCP read joins the inline parts too (it returned only
  // what parseEmail keeps, the note, before): one body, whoever asks.
  assertEquals(mcpBody, text, "the MCP read and the client-api read return the same body");
  assert(mcpBody !== parseEmail(boxes[0].messages[0].raw).text && mcpBody.includes(ORIGINAL_TEXT));
});

Deno.test("read: an HTML original under a text note joins into both body_text and body_html; alternatives are not doubled", () => {
  const html = message(1, ["Content-Type: text/html; charset=utf-8"], "<p>Original <b>markup</b></p>");
  const forwarded = forwardedMessage(2, html);
  const joined = parseEmailJoined(forwarded.raw, (h) => h.replace(/<[^>]+>/g, ""));
  assert(joined.text!.includes("A note above.") && joined.text!.includes("Original markup"));
  assert(joined.html!.includes("A note above.") && joined.html!.includes("<b>markup</b>"));

  const alt = message(3, ['Content-Type: multipart/alternative; boundary="b"'], [
    "--b", "Content-Type: text/plain; charset=utf-8", "", "plain form", "--b", "Content-Type: text/html; charset=utf-8", "", "<p>html form</p>", "--b--", "",
  ].join(CRLF));
  const one = parseEmailJoined(alt.raw, (h) => h);
  assertEquals([one.text, one.html], ["plain form", "<p>html form</p>"]);
  assertEquals([one.text, one.html], [parseEmail(alt.raw).text, parseEmail(alt.raw).html], "a plain alternative reads as it always did");
});

Deno.test("read (gmail): the inline text parts of a multipart/mixed are joined, for client-api and for the MCP read alike", async () => {
  const world = { historyId: "1", sent: [], modified: [], messages: [{ id: "g1", from: "A <a@x.example>", to: "owner@gmail-harness.example", subject: "Fwd", snippet: "s", labelIds: ["INBOX"] }] };
  const handler: harness.ProviderHandler = (call) => {
    if (new URL(call.url).pathname.endsWith("/messages/g1")) {
      return harness.json({
        id: "g1",
        threadId: "t1",
        labelIds: ["INBOX"],
        payload: {
          mimeType: "multipart/mixed",
          headers: [{ name: "Subject", value: "Fwd" }, { name: "From", value: "A <a@x.example>" }],
          parts: [
            { mimeType: "text/plain", body: { data: harness.b64url("The note."), size: 9 } },
            { mimeType: "text/plain", body: { data: harness.b64url(ORIGINAL_TEXT), size: ORIGINAL_TEXT.length } },
          ],
        },
      });
    }
    return gmailHandler(world)(call);
  };
  const app = await realApp();
  const viaClient = await harness.runTool(await harness.inboxRow("gmail"), handler, () => app.mail("read", { message_id: "g1" }));
  assertEquals(viaClient.value.body.body_text, `The note.\n\n${ORIGINAL_TEXT}`);
  const viaMcp = await harness.runTool(await harness.inboxRow("gmail"), handler, () =>
    mcp.dispatchExecutor("email_read", { inbox_id: INBOX_ID, message_id: "g1" }, harness.API_KEY));
  assertEquals((viaMcp.value!.result as { structuredContent: { body_text: string } }).structuredContent.body_text, `The note.\n\n${ORIGINAL_TEXT}`);
});

// ── 2. folder roles ──────────────────────────────────────────────────────────

Deno.test("folders (imap): role from SPECIAL-USE, else from the names the alias matcher knows; MCP folder_list has no role", async () => {
  const boxes: FakeMailbox[] = [
    { name: "INBOX", attrs: ["\\HasNoChildren"], messages: [fakeTextMessage(1)] },
    { name: "Gesendet-Ordner", attrs: ["\\Sent"], messages: [] },
    { name: "Drafts", attrs: [], messages: [] },
    { name: "Deleted Items", attrs: [], messages: [] },
    { name: "Bulk", attrs: ["\\Junk"], messages: [] },
    { name: "[Gmail]/All Mail", attrs: ["\\All"], messages: [] },
    { name: "Projects/Trash", attrs: [], messages: [] },
  ];
  const pool = new FakeDialPool(imapServer(boxes));
  const app = await realApp({ pool });
  const inbox = await imapInbox();
  const { value } = await harness.runTool(inbox, none, () => app.mail("folders"));
  assertEquals(value.status, 200, JSON.stringify(value.body));
  const roles = Object.fromEntries(value.body.folders.map((f: { id: string; role: string | null }) => [f.id, f.role]));
  assertEquals(roles, {
    "INBOX": "inbox",
    "Gesendet-Ordner": "sent",
    "Drafts": "drafts",
    "Deleted Items": "trash",
    "Bulk": "spam",
    "[Gmail]/All Mail": "archive",
    "Projects/Trash": null,
  });
  assertEquals(pool.servers.length, 1, "the roles came from the same connection");
  assertEquals(pool.servers[0].commands.filter((c) => c.startsWith("LIST")).length, 1, "and from the LIST the listing already made");
  await pool.closeAll();

  const plainPool = new FakeDialPool(imapServer(boxes));
  const plain = await harness.runTool(inbox, none, () =>
    firstPartyContext.run(
      { imapConnect: <C>() => plainPool.dial() as unknown as Promise<C> },
      () => mcp.dispatchExecutor("folder_list", { inbox_id: INBOX_ID }, harness.API_KEY),
    ));
  assert(!JSON.stringify(plain.value).includes('"role"'));
  assertEquals(
    (plain.value!.result as { structuredContent: { folders: Record<string, unknown>[] } }).structuredContent.folders,
    value.body.folders.map(({ role: _role, ...rest }: Record<string, unknown>) => rest),
    "identical entries once role is removed",
  );
});

Deno.test("folder roles (imap): a role two folders could equally claim is given to neither", () => {
  const roles = imapFolderRoles([
    { name: "INBOX", flags: [], delimiter: "/" },
    { name: "Sent Items", flags: [], delimiter: "/" },
    { name: "Sent Messages", flags: [], delimiter: "/" },
  ]);
  assertEquals([...roles.entries()], [["INBOX", "inbox"]]);
});

Deno.test("folders (gmail): system labels carry their role; nothing is the archive", async () => {
  const world = { historyId: "1", sent: [], modified: [], messages: [] };
  const handler: harness.ProviderHandler = (call) => {
    const url = new URL(call.url);
    if (url.pathname.endsWith("/labels")) {
      return harness.json({ labels: ["INBOX", "SENT", "DRAFT", "TRASH", "SPAM", "STARRED", "Label_7"].map((id) => ({ id, name: id })) });
    }
    return gmailHandler(world)(call);
  };
  const app = await realApp();
  const { value } = await harness.runTool(await harness.inboxRow("gmail"), handler, () => app.mail("folders"));
  assertEquals(value.status, 200, JSON.stringify(value.body));
  assertEquals(
    value.body.folders.map((f: { id: string; role: string | null }) => [f.id, f.role]),
    [["INBOX", "inbox"], ["SENT", "sent"], ["DRAFT", "drafts"], ["TRASH", "trash"], ["SPAM", "spam"], ["STARRED", null], ["Label_7", null]],
  );
});

/** A localised Outlook mailbox: opaque ids, German names. */
function outlookHandler(seen: string[]): harness.ProviderHandler {
  const folders = [
    { id: "AAA-inbox", displayName: "Posteingang", wellKnown: "inbox" },
    { id: "AAA-sent", displayName: "Gesendete Elemente", wellKnown: "sentitems" },
    { id: "AAA-drafts", displayName: "Entwürfe", wellKnown: "drafts" },
    { id: "AAA-trash", displayName: "Gelöschte Elemente", wellKnown: "deleteditems" },
    { id: "AAA-junk", displayName: "Junk-E-Mail", wellKnown: "junkemail" },
    { id: "AAA-custom", displayName: "Projekte", wellKnown: null },
  ];
  return (call) => {
    const url = new URL(call.url);
    const path = decodeURIComponent(url.pathname.replace("/v1.0", ""));
    seen.push(path);
    if (path === "/me/mailFolders") {
      return harness.json({ value: folders.map((f) => ({ id: f.id, displayName: f.displayName, childFolderCount: 0, totalItemCount: 3, unreadItemCount: 1 })) });
    }
    const one = /^\/me\/mailFolders\/([^/]+)$/.exec(path);
    if (one) {
      const folder = folders.find((f) => f.wellKnown === one[1] || f.id === one[1]);
      if (!folder) return harness.json({ error: { code: "ErrorItemNotFound", message: "not found" } }, 404);
      return harness.json({ id: folder.id, totalItemCount: 3, unreadItemCount: 1 });
    }
    if (/^\/me\/mailFolders\/[^/]+\/messages$/.test(path)) {
      return harness.json({ value: [{ id: "m1", lastModifiedDateTime: "2026-09-01T10:00:00Z" }] });
    }
    return harness.json({ value: [] });
  };
}

Deno.test("folders (outlook): role from Graph's well-known folders, whatever the display language", async () => {
  forgetOutlookRolesForTests();
  const app = await realApp();
  const seen: string[] = [];
  const first = await harness.runTool(await harness.inboxRow("outlook"), outlookHandler(seen), () => app.mail("folders"));
  assertEquals(first.value.status, 200, JSON.stringify(first.value.body));
  assertEquals(
    first.value.body.folders.map((f: { id: string; role: string | null }) => [f.id, f.role]),
    [["AAA-inbox", "inbox"], ["AAA-sent", "sent"], ["AAA-drafts", "drafts"], ["AAA-trash", "trash"], ["AAA-junk", "spam"], ["AAA-custom", null]],
  );
  assert(first.world.maxInFlight <= 4, `at most four Graph requests at once (saw ${first.world.maxInFlight})`);
  // The mailbox has no archive folder (404): that is an answer, and it is remembered.
  const lookups = () => seen.filter((p) => /^\/me\/mailFolders\/(inbox|sentitems|drafts|deleteditems|archive|junkemail)$/.test(p)).length;
  assertEquals(lookups(), 6);
  await harness.runTool(await harness.inboxRow("outlook"), outlookHandler(seen), () => app.mail("folders"));
  assertEquals(lookups(), 6, "the second listing looked nothing up again");
});

Deno.test("status (outlook): every alias resolves to its well-known folder (spam is junkemail), four requests at a time, no folder walk", async () => {
  const app = await realApp();
  const seen: string[] = [];
  const asked = ["inbox", "sent", "drafts", "trash", "archive", "spam", "junk"];
  const { value, world } = await harness.runTool(await harness.inboxRow("outlook"), outlookHandler(seen), () => app.mail("status", { folders: asked }));
  assertEquals(value.status, 200, JSON.stringify(value.body));
  assertEquals(
    value.body.folders.map((f: { folder: string; id: string | null; error?: string }) => [f.folder, f.id, f.error ?? null]),
    [
      ["inbox", "AAA-inbox", null],
      ["sent", "AAA-sent", null],
      ["drafts", "AAA-drafts", null],
      ["trash", "AAA-trash", null],
      ["archive", "archive", "folder_not_found"],
      ["spam", "AAA-junk", null],
      ["junk", "AAA-junk", null],
    ],
  );
  assert(seen.includes("/me/mailFolders/junkemail"));
  assert(!seen.includes("/me/mailFolders"), "no folder tree walk for an alias");
  assert(world.maxInFlight <= 4, `at most four Graph requests at once (saw ${world.maxInFlight})`);
});

// ── 3. the per-inbox queue ───────────────────────────────────────────────────

Deno.test("queue rule: first come first served, except interactive ahead of a background head", () => {
  const q = (items: Array<[number, QueueClass]>) => items.map(([seq, cls], sub) => ({ seq, sub, cls }));
  const order = (items: Array<[number, QueueClass]>) => {
    const left = q(items);
    const out: number[] = [];
    while (left.length) {
      const next = nextInQueue(left)!;
      out.push(next.seq);
      left.splice(left.indexOf(next), 1);
    }
    return out;
  };
  assertEquals(order([[3, "normal"], [1, "normal"], [2, "normal"]]), [1, 2, 3]);
  assertEquals(order([[1, "background"], [2, "background"], [3, "interactive"], [4, "interactive"]]), [3, 4, 1, 2]);
  // A write is never overtaken by a later list, and never overtakes an earlier poll's place.
  assertEquals(order([[1, "normal"], [2, "interactive"]]), [1, 2]);
  assertEquals(order([[1, "background"], [2, "normal"], [3, "interactive"]]), [3, 1, 2]);
  assertEquals(nextInQueue([]), null);
});

function poolDialer(delayMs = 0): { servers: FakeImapServer[]; dial: () => Promise<ImapClient> } {
  const servers: FakeImapServer[] = [];
  return {
    servers,
    dial: async () => {
      if (delayMs) await tick(delayMs);
      const s = new FakeImapServer({ mailboxes: [{ name: "INBOX", messages: [fakeTextMessage(1)] }] });
      servers.push(s);
      return s.client();
    },
  };
}

Deno.test("queue: requests for one inbox are served in ARRIVAL order, whatever order they reach the pool in", async () => {
  const pool = new ImapPool<ImapClient>();
  const d = poolDialer();
  const served: string[] = [];
  const holder = await pool.checkout("k", {}, d.dial, { order: { seq: pool.arrival(), cls: "normal" } });
  const a = pool.arrival(), b = pool.arrival(), c = pool.arrival();
  const run = (name: string, seq: number) =>
    pool.checkout("k", {}, d.dial, { order: { seq, cls: "normal" } }).then(async (lease) => {
      served.push(name);
      await tick(1);
      await lease.logout();
    });
  // They reach the pool as c, a, b (their database reads finished in that order).
  const all = [run("c", c), run("a", a), run("b", b)];
  await tick(2);
  await holder.logout();
  await Promise.all(all);
  assertEquals(served, ["a", "b", "c"]);
  assertEquals(d.servers.length, 1, "one connection throughout");
  await pool.closeAll();
});

Deno.test("queue: a list or read goes ahead of queued status/folders, and nothing else is reordered", async () => {
  const pool = new ImapPool<ImapClient>();
  const d = poolDialer();
  const served: string[] = [];
  const holder = await pool.checkout("k", {}, d.dial);
  const run = (name: string, cls: QueueClass) =>
    pool.checkout("k", {}, d.dial, { order: { seq: pool.arrival(), cls } }).then(async (lease) => {
      served.push(name);
      await tick(1);
      await lease.logout();
    });
  const all = [run("status", "background"), run("folders", "background"), run("flag", "normal"), run("list", "interactive"), run("read", "interactive")];
  await tick(2);
  await holder.logout();
  await Promise.all(all);
  assertEquals(served, ["list", "read", "status", "folders", "flag"]);
  await pool.closeAll();
});

Deno.test("queue: on a cold connection the list is served first even though the status poll dialled it", async () => {
  const pool = new ImapPool<ImapClient>();
  const d = poolDialer(15);
  const served: string[] = [];
  const run = (name: string, cls: QueueClass) =>
    pool.checkout("k", {}, d.dial, { order: { seq: pool.arrival(), cls } }).then(async (lease) => {
      served.push(name);
      await tick(1);
      await lease.logout();
    });
  const all = [run("status", "background"), run("folders", "background"), run("list", "interactive")];
  await Promise.all(all);
  assertEquals(served, ["list", "status", "folders"]);
  assertEquals(d.servers.length, 1, "nobody dialled a second connection to get ahead");
  assertEquals(pool.stats.handovers, 1);
  await pool.closeAll();
});

Deno.test("queue (end to end): status, folders and list sent together on a cold mailbox answer list first", async () => {
  const boxes: FakeMailbox[] = [
    { name: "INBOX", attrs: [], modSeq: 5, messages: [fakeTextMessage(1), fakeTextMessage(2)] },
    { name: "Sent", attrs: ["\\Sent"], modSeq: 2, messages: [] },
    { name: "Trash", attrs: ["\\Trash"], modSeq: 2, messages: [] },
  ];
  const pool = new FakeDialPool(imapServer(boxes));
  const app = await realApp({ pool });
  const answered: string[] = [];
  const call = (op: string, args: Record<string, unknown>) =>
    app.mail(op, args).then((r) => {
      answered.push(op);
      return r;
    });
  const { value } = await harness.runTool(await imapInbox(), none, () =>
    Promise.all([call("status", { folders: ["inbox", "sent", "trash"] }), call("folders", {}), call("list", { folder: "inbox", limit: 10 })]));
  assertEquals(value.map((r) => r.status), [200, 200, 200], JSON.stringify(value.map((r) => r.body)));
  assertEquals(answered[0], "list");
  assertEquals(pool.servers.length, 1, "one connection for all three");
  const commands = pool.servers[0].commands.map((c) => c.split(" ")[0]);
  assert(commands.indexOf("FETCH") < commands.lastIndexOf("STATUS"), `the listing ran before the poll finished: ${commands.join(",")}`);
  await pool.closeAll();
});

Deno.test("pool: an extended LIST (LIST-STATUS) is never what the alias matcher reads; the next plain LIST asks the server", async () => {
  const pool = new ImapPool<ImapClient>();
  const servers: FakeImapServer[] = [];
  const dial = () => {
    const s = new FakeImapServer({ listStatus: true, mailboxes: [{ name: "INBOX", messages: [] }, { name: "Sent", attrs: ["\\Sent"], messages: [] }] });
    servers.push(s);
    return Promise.resolve(s.client());
  };
  const first = await pool.checkout("k", {}, dial);
  await first.listMailboxes();
  await first.listMailboxes();
  assertEquals(pool.stats.listHits, 1, "a plain LIST is remembered");
  await first.listMailboxesWithStatus();
  const listed = await first.listMailboxes();
  assertEquals(pool.stats.listHits, 1, "but not across an extended LIST");
  assertEquals(listed.find((mb) => mb.name === "Sent")?.flags, ["\\Sent"]);
  assertEquals(servers[0].commands.filter((c) => c.startsWith("LIST")).length, 3);
  await first.logout();
  await pool.closeAll();
});

// ── 4. a refused login ───────────────────────────────────────────────────────

Deno.test("refused login: requests queued behind the refused dial are answered by it, without dialling again", async () => {
  const pool = new ImapPool<ImapClient>();
  let dials = 0;
  const refuse = async (): Promise<ImapClient> => {
    dials++;
    await tick(10);
    const error = new Error("IMAP authentication failed");
    error.name = "ImapAuthError";
    throw error;
  };
  const started = performance.now();
  const results = await Promise.allSettled([
    pool.checkout("k", {}, refuse, { order: { seq: pool.arrival(), cls: "background" } }),
    pool.checkout("k", {}, refuse, { order: { seq: pool.arrival(), cls: "background" } }),
    pool.checkout("k", {}, refuse, { order: { seq: pool.arrival(), cls: "interactive" } }),
  ]);
  assertEquals(results.map((r) => r.status), ["rejected", "rejected", "rejected"]);
  assertEquals(results.map((r) => (r as PromiseRejectedResult).reason.name), ["ImapAuthError", "ImapAuthError", "ImapAuthError"]);
  assertEquals(dials, 1, "one login attempt for three queued requests");
  assert(performance.now() - started < 500, "nobody waited out a pool timeout");
  assertEquals(pool.stats.refusals, 2);
  await assertRejects(() => pool.checkout("k", {}, refuse), Error, "IMAP authentication failed");
  assertEquals(dials, 1, "and the next request is answered from memory");
});

Deno.test("refused login (end to end): status + folders + list for a refused mailbox make ONE login and all answer 409", async () => {
  let dials = 0;
  const pool = new ImapPool();
  const app = await realApp({ pool });
  // realApp only wires imapDial for a FakeDialPool; build the refusal through the pool's own dial hook instead.
  const refusing = new (class extends FakeDialPool {
    override readonly dial = async () => {
      dials++;
      await tick(10);
      const error = new Error("IMAP authentication failed");
      error.name = "ImapAuthError";
      throw error;
    };
  })(imapServer([{ name: "INBOX", messages: [] }]));
  const refusedApp = await realApp({ pool: refusing });
  const { value } = await harness.runTool(await imapInbox(), none, () =>
    Promise.all([
      refusedApp.mail("status", { folders: ["inbox", "sent"] }),
      refusedApp.mail("folders"),
      refusedApp.mail("list", { folder: "inbox" }),
    ]));
  assertEquals(value.map((r) => [r.status, r.body.error.code]), [[409, "reconnect_required"], [409, "reconnect_required"], [409, "reconnect_required"]]);
  assertEquals(dials, 1);
  void app;
});

// ── 6. reply leaves flags alone ──────────────────────────────────────────────

Deno.test("reply (imap): the original is read with BODY.PEEK and no flag is stored on anything", async () => {
  const boxes: FakeMailbox[] = [
    { name: "INBOX", messages: [fakeTextMessage(1), fakeTextMessage(2)] },
    { name: "Sent", attrs: ["\\Sent"], messages: [] },
  ];
  const pool = new FakeDialPool(imapServer(boxes));
  const app = await realApp({ pool });
  // No SMTP server exists here, so the send itself fails; what is pinned is
  // everything the reply does to the MAILBOX on the way.
  const { value } = await harness.runTool(await imapInbox(), none, () =>
    app.mail("reply", { message_id: "INBOX:2", body: "Thanks.", idempotency_key: "reply-key-0001" }));
  assert(value.status !== 200, "nothing was sent in this test");
  const commands = pool.servers.flatMap((s) => s.commands);
  assert(commands.some((c) => /^UID FETCH 2 \(FLAGS BODY\.PEEK\[\]\)$/.test(c)), commands.join(" | "));
  assert(!commands.some((c) => /STORE/.test(c)), "no flag is written: not \\Seen, not \\Answered");
  assert(!commands.some((c) => /BODY\[/.test(c)), "and no fetch that sets \\Seen implicitly");
  assertEquals(boxes[0].messages.map((m) => m.flags), [[], []]);
  await pool.closeAll();
});

// ── 5. previews ──────────────────────────────────────────────────────────────

const html = { type: "text", subtype: "html", charset: "utf-8", encoding: "7bit" };
const hasCss = (preview: string) => preview.includes("{") && preview.includes(";");

Deno.test("preview: style, script, head and comments go with their content, closed or cut off", () => {
  const closed = "<html><head><title>T</title><style>.a{color:red;}</style></head><body><p>Hello&nbsp;there</p><script>var x={a:1};</script></body></html>";
  assertEquals(cleanPreviewFromBodyPart(closed, html), "Hello there");
  const cut = "<html><head><style>.a{color:red;} .b{margin:0;} @media(max-width:600px){.c{display:none;}";
  assertEquals(cleanPreviewFromBodyPart(cut, html), "");
  assert(!hasCss(cleanPreviewFromBodyPart(cut, null)), "nor when nothing described the part");
  assertEquals(cleanPreviewFromBodyPart("<body><p>Shown</p><!-- hidden {a;b}", html), "Shown");
  assertEquals(cleanPreviewFromBodyPart("<p>Shown</p><a href=\"https://example.com/very", html), "Shown");
  assertEquals(htmlPreviewText("Tom &amp; Jerry &nbs"), "Tom & Jerry ");
});

Deno.test("preview: the declared charset and transfer encoding decode it; a cut sequence is dropped, never U+FFFD", () => {
  // The fixtures are what the socket read yields: octets through TextDecoder("latin1").
  const wire = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);
  const utf8 = new TextEncoder().encode("Blåbærsyltetøy – Ødegård “quoted”");
  const plain = (charset: string | null, encoding: string) => ({ type: "text", subtype: "plain", charset, encoding });

  // 8bit UTF-8: 0x98 (in "Ø") and 0x80/0x93/0x9C (dash, quotes) are the octets windows-1252 remaps.
  assertEquals(cleanPreviewFromBodyPart(wire(utf8), plain("utf-8", "8bit")), "Blåbærsyltetøy – Ødegård “quoted”");
  assertEquals(cleanPreviewFromBodyPart(wire(utf8), null), "Blåbærsyltetøy – Ødegård “quoted”", "nor when nothing described the part");

  // Cut in the middle of a multi-byte character, for every cut point.
  for (let cut = 1; cut < utf8.length; cut++) {
    const preview = cleanPreviewFromBodyPart(wire(utf8.subarray(0, cut)), plain("utf-8", "8bit"));
    assert(!preview.includes("�"), `cut at ${cut}`);
    assert("Blåbærsyltetøy – Ødegård “quoted”".startsWith(preview), `cut at ${cut}: ${preview}`);
  }

  // ISO-8859-1 declared, 8bit.
  assertEquals(cleanPreviewFromBodyPart(wire(Uint8Array.from([0x42, 0x6c, 0xe5, 0x62, 0xe6, 0x72])), plain("iso-8859-1", "8bit")), "Blåbær");

  // Quoted-printable cut inside an escape and inside a soft break.
  const qp = "Bl=C3=A5b=C3=A6r og fl=C3=B8te";
  for (let cut = 1; cut <= qp.length; cut++) {
    const preview = cleanPreviewFromBodyPart(qp.slice(0, cut), plain("utf-8", "quoted-printable"));
    assert(!preview.includes("�") && !/=[0-9A-F]?$/.test(preview), `cut at ${cut}: ${preview}`);
    assert("Blåbær og fløte".startsWith(preview), `cut at ${cut}: ${preview}`);
  }
  assertEquals(cleanPreviewFromBodyPart("soft =\r\nbreak and a cut one =\r", plain("utf-8", "quoted-printable")), "soft break and a cut one");

  // base64 cut mid-quantum and mid-character.
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode("Blåbær og fløte")));
  for (let cut = 4; cut <= b64.length; cut++) {
    const preview = cleanPreviewFromBodyPart(b64.slice(0, cut), plain("utf-8", "base64"));
    assert(!preview.includes("�"), `cut at ${cut}`);
    assert("Blåbær og fløte".startsWith(preview), `cut at ${cut}: ${preview}`);
  }

  // No charset declared, UTF-8 inside; whitespace collapsed; capped at 200.
  assertEquals(cleanPreviewFromBodyPart(wire(new TextEncoder().encode("a \r\n\r\n  é\tb")), plain(null, "7bit")), "a é b");
  assertEquals(cleanPreviewFromBodyPart("x".repeat(500), plain("utf-8", "7bit")).length, 200);
  // Markup under a text/plain label is still markup; an address or a link in angle brackets is not.
  assertEquals(cleanPreviewFromBodyPart("Hello<br>there <b>now</b>", plain("utf-8", "7bit")), "Hello there now");
  assertEquals(cleanPreviewFromBodyPart("See <https://example.com/x> or write <a@b.example>", plain("utf-8", "7bit")), "See <https://example.com/x> or write <a@b.example>");
  // Not text at all.
  assertEquals(cleanPreviewFromBodyPart("JVBERi0xLjQK", { type: "application", subtype: "pdf", charset: null, encoding: "base64" }), "");
});

Deno.test("list (imap): previews are clean, and the same for client-api and for MCP", async () => {
  const css = "<html><head><style>.wrapper{margin:0;padding:0;} .x{color:#333;}</style></head><body><p>Visible sentence.</p></body></html>";
  const boxes: FakeMailbox[] = [{
    name: "INBOX",
    messages: [
      message(1, ["Content-Type: text/html; charset=utf-8"], css),
      message(2, ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit"], octets("Ødegård – “hei”")),
      fakeTextMessage(3, { body: "Plain and simple." }),
    ],
  }];
  const inbox = await imapInbox();
  const pool = new FakeDialPool(imapServer(boxes));
  const app = await realApp({ pool });
  const viaClient = await harness.runTool(inbox, none, () => app.mail("list", { folder: "INBOX", limit: 10 }));
  const clientRows = viaClient.value.body.messages as Array<Record<string, unknown>>;
  assertEquals(clientRows.map((r) => r["preview"]), ["Plain and simple.", "Ødegård – “hei”", "Visible sentence."]);

  const bare = await harness.runTool(inbox, none, () => app.mail("list", { folder: "INBOX", limit: 10, preview: false }));
  assertEquals(bare.value.body.messages.map((r: { preview: string }) => r.preview), ["", "", ""]);
  assert(
    pool.servers[0].commands.some((c) => /^FETCH .*BODYSTRUCTURE BODY\.PEEK\[HEADER\.FIELDS \(REFERENCES\)\]\)$/.test(c)),
    "preview:false fetches no body bytes (the References header is not body)",
  );
  await pool.closeAll();

  const plainPool = new FakeDialPool(imapServer(boxes));
  const plain = await harness.runTool(inbox, none, () =>
    firstPartyContext.run(
      { imapConnect: <C>() => plainPool.dial() as unknown as Promise<C> },
      () => mcp.dispatchExecutor("email_list", { inbox_id: INBOX_ID, folder: "INBOX", limit: 10 }, harness.API_KEY),
    ));
  const mcpRows = (plain.value!.result as { structuredContent: { messages: Record<string, unknown>[] } }).structuredContent.messages;
  // Since 2026-10-04 an MCP row carries the same preview: one generator, no flag.
  assertEquals(mcpRows.map((r) => r["preview"]), ["Plain and simple.", "Ødegård – “hei”", "Visible sentence."]);
  assert(!mcpRows.some((r) => hasCss(String(r["preview"])) || String(r["preview"]).includes("\ufffd")));
  assert(plainPool.servers[0].commands.some((c) => c.includes("BODY.PEEK[1]<0.2048>")), "and the FETCH MCP sends is the one it always sent");
  const strip = (rows: Record<string, unknown>[]) => rows.map(({ is_flagged: _f, message_id_header: _m, in_reply_to: _i, references: _r, thread_key: _k, ...rest }) => rest);
  assertEquals(JSON.stringify(strip(clientRows)), JSON.stringify(strip(mcpRows)), "nothing but is_flagged and the first-party thread fields differ");
});
