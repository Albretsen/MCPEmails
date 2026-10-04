// Conversation threading: the thread headers and `thread_key` on rows, and the
// `thread` op, against the REAL tool layer (fake IMAP server, fake fetch).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { firstPartyContext, messageIdsOf, referencesOfHeaderBlock } from "../../mcp-server/first-party.ts";
import { type FakeMailbox, type FakeMessage, FakeImapServer } from "../../mcp-server/imap-fake-server.ts";
import { headerSearchCriteria, imapDate, keepLinked, searchIds } from "../mail/thread.ts";
import { normalizeSubject, threadKeyOf } from "../mail/thread-key.ts";
import { FakeDialPool, harness, imapInbox, INBOX_ID, mcp, realApp } from "./real-seam.ts";

const CRLF = "\r\n";

function mail(uid: number, o: {
  id?: string | null;
  subject: string;
  from?: string;
  to?: string;
  date: string;
  inReplyTo?: string;
  references?: string[];
  seen?: boolean;
  flagged?: boolean;
}): FakeMessage {
  const lines = [
    `Date: ${o.date}`,
    `From: ${o.from ?? '"Maya" <maya@example.com>'}`,
    `To: ${o.to ?? "<owner@example.com>"}`,
    `Subject: ${o.subject}`,
  ];
  if (o.id !== null) lines.push(`Message-ID: <${o.id ?? `m${uid}@example.com`}>`);
  if (o.inReplyTo) lines.push(`In-Reply-To: <${o.inReplyTo}>`);
  if (o.references?.length) lines.push(`References: ${o.references.map((r) => `<${r}>`).join(" ")}`);
  lines.push("Content-Type: text/plain; charset=utf-8", "", `Body ${uid}.`);
  const flags = [...(o.seen ? ["\\Seen"] : []), ...(o.flagged ? ["\\Flagged"] : [])];
  return { uid, flags, raw: lines.join(CRLF) };
}

/**
 * One conversation across three folders, plus look-alikes that must stay out:
 *   INBOX    1 root (Maya)            3 Maya's reply to our answer   5 "Re: Invoice" from someone else
 *            6 a fork of the root     7 an unrelated mail
 *   Sent     1 our answer to the root 2 our "Re: Invoice" to a third party
 *   Archive  4 an older reply, filed
 */
function world(): FakeMailbox[] {
  return [
    {
      name: "INBOX",
      attrs: ["\\HasNoChildren"],
      messages: [
        mail(1, { id: "root@example.com", subject: "Invoice", date: "01 Sep 2026 10:00:00 +0000", seen: true }),
        mail(3, {
          id: "c@example.com",
          subject: "Re: Invoice",
          date: "03 Sep 2026 10:00:00 +0000",
          inReplyTo: "b@example.com",
          references: ["root@example.com", "b@example.com"],
          flagged: true,
        }),
        mail(5, { id: "other@example.com", subject: "Re: Invoice", from: '"Odd" <odd@example.com>', date: "04 Sep 2026 10:00:00 +0000", inReplyTo: "elsewhere@example.com", references: ["elsewhere@example.com"] }),
        mail(6, { id: "fork@example.com", subject: "Re: Invoice (new question)", from: '"Ida" <ida@example.com>', date: "05 Sep 2026 10:00:00 +0000", inReplyTo: "root@example.com", references: ["root@example.com"] }),
        mail(7, { id: "lone@example.com", subject: "Lunch", date: "06 Sep 2026 10:00:00 +0000" }),
      ],
    },
    {
      name: "Sent",
      attrs: ["\\HasNoChildren", "\\Sent"],
      messages: [
        mail(1, { id: "b@example.com", subject: "Re: Invoice", from: "<owner@example.com>", to: "<maya@example.com>", date: "02 Sep 2026 10:00:00 +0000", inReplyTo: "root@example.com", references: ["root@example.com"], seen: true }),
        mail(2, { id: "x@example.com", subject: "Re: Invoice", from: "<owner@example.com>", to: "<odd@example.com>", date: "04 Sep 2026 12:00:00 +0000", inReplyTo: "other@example.com", references: ["elsewhere@example.com", "other@example.com"], seen: true }),
      ],
    },
    {
      name: "Archive",
      attrs: ["\\HasNoChildren", "\\Archive"],
      messages: [
        mail(4, { id: "d@example.com", subject: "RE: Invoice", date: "02 Sep 2026 18:00:00 +0000", inReplyTo: "b@example.com", references: ["root@example.com", "b@example.com"], seen: true }),
      ],
    },
  ];
}

const noHandler: harness.ProviderHandler = (call) => harness.json({ error: `unexpected provider call ${call.url}` }, 500);

async function rig(options: { headerSearchBroken?: boolean; boxes?: FakeMailbox[] } = {}) {
  const boxes = options.boxes ?? world();
  const advertised = ["IMAP4REV1"];
  const pool = new FakeDialPool(() =>
    Object.assign(new FakeImapServer({ mailboxes: boxes, capabilities: advertised, headerSearchBroken: options.headerSearchBroken }), { advertised })
  );
  const app = await realApp({ pool });
  const inbox = await imapInbox();
  const run = <T>(body: () => Promise<T>) => harness.runTool(inbox, noHandler, body);
  return { boxes, pool, app, run, inbox };
}

// ── Pure pieces ─────────────────────────────────────────────────────────────

Deno.test("thread_key: the documented rule, in order", () => {
  // 1. provider thread ids.
  assertEquals(threadKeyOf({ id: "a", thread_id: "T1", message_id_header: "x@y" }, "gmail"), "g:T1");
  assertEquals(threadKeyOf({ id: "a", thread_id: "C1" }, "outlook"), "o:C1");
  // Outlook's fallback (`thread_id` = the message's own id) is not a conversation.
  assertEquals(threadKeyOf({ id: "a", thread_id: "a", message_id_header: "x@y" }, "outlook"), "m:x@y");
  // 2. root: References[0], else In-Reply-To, else own.
  assertEquals(threadKeyOf({ id: "INBOX:3", thread_id: "3", message_id_header: "c@x", in_reply_to: "b@x", references: ["root@x", "b@x"] }, "imap"), "m:root@x");
  assertEquals(threadKeyOf({ id: "INBOX:3", message_id_header: "c@x", in_reply_to: "b@x", references: [] }, "imap"), "m:b@x");
  assertEquals(threadKeyOf({ id: "INBOX:3", message_id_header: "c@x" }, "imap"), "m:c@x");
  // 3. no header at all: subject + participants.
  const a = threadKeyOf({ id: "1", subject: "Re: Invoice", from: { email: "Maya@x.example" }, to: [{ email: "me@x.example" }] }, "imap");
  const b = threadKeyOf({ id: "2", subject: "SV: RE[2]:  invoice", from: { email: "me@x.example" }, to: [{ email: "maya@x.example" }] }, "imap");
  const c = threadKeyOf({ id: "3", subject: "Re: Invoice", from: { email: "odd@x.example" }, to: [{ email: "me@x.example" }] }, "imap");
  assert(a.startsWith("s:"));
  assertEquals(a, b, "same normalised subject, same people");
  assert(a !== c, "same subject, different people: not the same conversation");
  // 4. nothing to go on.
  assertEquals(threadKeyOf({ id: "INBOX:9", subject: "(no subject)", from: { email: "" }, to: [] }, "imap"), "u:INBOX:9");
});

Deno.test("normalizeSubject strips reply and forward prefixes in several languages", () => {
  assertEquals(normalizeSubject("Re: RE: Fwd:  Hello  World"), "hello world");
  assertEquals(normalizeSubject("SV: VS: AW: WG: Antw: Budsjett"), "budsjett");
  assertEquals(normalizeSubject("Re[3]: x"), "x");
  assertEquals(normalizeSubject("Regarding: x"), "regarding: x");
  assertEquals(normalizeSubject("(no subject)"), "");
});

Deno.test("header parsing: ids without brackets; a folded References block", () => {
  assertEquals(messageIdsOf("<a@x>  <b@y>"), ["a@x", "b@y"]);
  assertEquals(messageIdsOf("a@x"), ["a@x"]);
  assertEquals(messageIdsOf(""), []);
  assertEquals(referencesOfHeaderBlock("References: <a@x>\r\n <b@y>\r\n\t<c@z>\r\n\r\n"), ["a@x", "b@y", "c@z"]);
  assertEquals(referencesOfHeaderBlock("\r\n"), []);
});

Deno.test("search ids and criteria are bounded and quote-safe", () => {
  const refs = Array.from({ length: 30 }, (_, i) => `r${i}@x`);
  assertEquals(searchIds("own@x", "r29@x", refs), ["own@x", "r29@x", "r0@x", "r28@x", "r27@x", "r26@x"]);
  const criteria = headerSearchCriteria("own@x", "p@x", ["root@x", "p@x"])!;
  assert(criteria.startsWith("OR "));
  assert(criteria.includes('HEADER Message-ID "<own@x>"') && criteria.includes('HEADER References "<root@x>"'));
  // A control character cannot reach a command line.
  assertEquals(headerSearchCriteria("bad\r\nA1 LOGOUT", "", []), null);
  assertEquals(headerSearchCriteria('q"uote@x', "", []), 'OR OR HEADER Message-ID "<q\\"uote@x>" HEADER References "<q\\"uote@x>" HEADER In-Reply-To "<q\\"uote@x>"');
  assertEquals(imapDate(Date.UTC(2026, 0, 5)), "5-Jan-2026");
});

Deno.test("keepLinked is transitive and never links by anything but ids", () => {
  const known = new Set(["root"]);
  const candidates = [
    { n: "grandchild", own: "g", inReplyTo: "child", references: [] as string[] },
    { n: "stranger", own: "s", inReplyTo: "zzz", references: ["yyy"] },
    { n: "child", own: "child", inReplyTo: "root", references: ["root"] },
  ];
  const kept = keepLinked(candidates, (c) => c, known);
  assertEquals(kept.map((c) => c.n).sort(), ["child", "grandchild"]);
  assert(known.has("g") && !known.has("s"));
});

// ── Rows ────────────────────────────────────────────────────────────────────

Deno.test("list (imap): rows carry the thread headers and thread_key, in the SAME fetch command", async () => {
  const { app, pool, run } = await rig();
  const { value } = await run(() => app.mail("list", { folder: "inbox", limit: 10 }));
  assertEquals(value.status, 200, JSON.stringify(value.body));
  const rows = value.body.messages as Array<Record<string, unknown>>;
  const byId = new Map(rows.map((r) => [r["id"], r]));
  assertEquals(
    [byId.get("INBOX:3")!["message_id_header"], byId.get("INBOX:3")!["in_reply_to"], byId.get("INBOX:3")!["references"], byId.get("INBOX:3")!["thread_key"]],
    ["c@example.com", "b@example.com", ["root@example.com", "b@example.com"], "m:root@example.com"],
  );
  assertEquals(byId.get("INBOX:1")!["thread_key"], "m:root@example.com");
  assertEquals([byId.get("INBOX:1")!["in_reply_to"], byId.get("INBOX:1")!["references"]], [null, []]);
  // Same subject, unrelated headers: a different conversation.
  assertEquals(byId.get("INBOX:5")!["thread_key"], "m:elsewhere@example.com");
  assertEquals(byId.get("INBOX:7")!["thread_key"], "m:lone@example.com");

  const commands = pool.servers[0].commands;
  const fetches = commands.filter((c) => /FETCH/.test(c));
  assertEquals(fetches.length, 1, "one FETCH for the page, as before");
  assert(/^FETCH 1:5 \(UID FLAGS ENVELOPE BODYSTRUCTURE BODY\.PEEK\[1\]<0\.\d+> BODY\.PEEK\[HEADER\.FIELDS \(REFERENCES\)\]\)$/.test(fetches[0]), fetches[0]);
  assertEquals(commands.filter((c) => /SEARCH/.test(c)).length, 0);
  await pool.closeAll();
});

Deno.test("read (imap): message_id_header and thread_key beside the in_reply_to/references it always had", async () => {
  const { app, pool, run } = await rig();
  const { value } = await run(() => app.mail("read", { message_id: "INBOX:3", include_html: false }));
  assertEquals(value.status, 200, JSON.stringify(value.body));
  assertEquals(
    [value.body.message_id_header, value.body.in_reply_to, value.body.references, value.body.thread_key],
    ["c@example.com", "b@example.com", ["root@example.com", "b@example.com"], "m:root@example.com"],
  );
  await pool.closeAll();
});

Deno.test("MCP list (imap): the FETCH command and the rows are what they were (no References item, no thread keys)", async () => {
  const boxes = world();
  const server = new FakeImapServer({ mailboxes: boxes });
  const client = server.client();
  assertEquals(firstPartyContext.getStore(), undefined);
  await client.selectMailbox("INBOX");
  const summaries = await client.fetchSummariesBySequence(1, 5);
  assertEquals(server.commands.at(-1), "FETCH 1:5 (UID FLAGS ENVELOPE BODYSTRUCTURE BODY.PEEK[1]<0.2048>)");
  assertEquals(Object.keys(summaries![0]), ["uid", "flags", "envelope", "hasAttachments", "preview"]);
  assertEquals(Object.keys(summaries![0].envelope), ["subject", "from", "to", "date", "messageId"]);

  // And through the real MCP entry point: no new key on a row.
  const inbox = await imapInbox();
  const pool = new FakeDialPool(() => Object.assign(new FakeImapServer({ mailboxes: boxes }), { advertised: ["IMAP4REV1"] }));
  const app = await realApp({ pool });
  const viaClient = await harness.runTool(inbox, noHandler, () => app.mail("list", { folder: "inbox", limit: 10 }));
  const keys = Object.keys(viaClient.value.body.messages[0]);
  assertEquals(keys.slice(-5), ["is_flagged", "message_id_header", "in_reply_to", "references", "thread_key"]);
  await pool.closeAll();
});

Deno.test("list (imap): what the References item costs on the wire (printed)", async () => {
  const boxes: FakeMailbox[] = [{
    name: "INBOX",
    messages: Array.from({ length: 50 }, (_, i) =>
      mail(i + 1, {
        subject: `Re: Thread ${i % 7}`,
        date: "01 Sep 2026 10:00:00 +0000",
        inReplyTo: i % 2 ? `m${i}@example.com` : undefined,
        // Half the page are replies four deep.
        references: i % 2 ? [`r1-${i}@example.com`, `r2-${i}@example.com`, `r3-${i}@example.com`, `m${i}@example.com`] : undefined,
      })),
  }];
  const measure = async (threadHeaders: boolean) => {
    const server = new FakeImapServer({ mailboxes: boxes });
    let bytes = 0;
    const conn = server.conn();
    const counted = { ...conn, read: async (p: Uint8Array) => {
      const n = await conn.read(p);
      bytes += n ?? 0;
      return n;
    } };
    const ctor = (await import("../../mcp-server/imap-client.ts")).ImapClient as unknown as { new (conn: unknown): import("../../mcp-server/imap-client.ts").ImapClient };
    const client = new ctor(counted);
    await client.selectMailbox("INBOX");
    const before = bytes;
    const trips = server.roundTrips;
    const started = performance.now();
    const rows = await firstPartyContext.run({ threadHeaders }, () => client.fetchSummariesBySequence(1, 50));
    return { ms: performance.now() - started, bytes: bytes - before, roundTrips: server.roundTrips - trips, rows: rows!.length };
  };
  await measure(true);
  const without = await measure(false);
  const withRefs = await measure(true);
  console.log(
    `list of 50 (fake IMAP): without References ${without.bytes} B / ${without.ms.toFixed(2)} ms / ${without.roundTrips} round trip; ` +
      `with ${withRefs.bytes} B / ${withRefs.ms.toFixed(2)} ms / ${withRefs.roundTrips} round trip ` +
      `(+${withRefs.bytes - without.bytes} B, +${((withRefs.bytes / without.bytes - 1) * 100).toFixed(1)}%)`,
  );
  assertEquals([without.roundTrips, withRefs.roundTrips, withRefs.rows], [1, 1, 50], "no extra round trip");
  assert(withRefs.bytes - without.bytes < 50 * 400, "under 400 octets per row on a page where half are deep replies");
});

// ── The thread op: IMAP ─────────────────────────────────────────────────────

Deno.test("thread (imap): Inbox + Sent + Archive, date ascending, look-alikes left out, on one pooled connection", async () => {
  const { app, pool, run } = await rig();
  const { value } = await run(async () => {
    await app.mail("list", { folder: "inbox", limit: 10 });
    return await app.mail("thread", { message_id: "INBOX:3" });
  });
  assertEquals(value.status, 200, JSON.stringify(value.body));
  const body = value.body;
  assertEquals(body.messages.map((m: { id: string }) => m.id), ["INBOX:1", "Sent:1", "Archive:4", "INBOX:3", "INBOX:6"]);
  assertEquals([body.partial, body.strategy, body.thread_key], [false, "imap_header_search", "m:root@example.com"]);
  assertEquals(body.folders, ["INBOX", "Sent", "Archive"]);
  const sent = body.messages[1];
  assertEquals([sent.folder, sent.is_read, sent.is_flagged, sent.thread_key, sent.from.email], ["Sent", true, false, "m:root@example.com", "owner@example.com"]);
  assertEquals(body.messages[3].is_flagged, true);
  assert(!("body_text" in sent) && !("body_html" in sent), "no bodies");
  assertEquals(typeof sent.preview, "string");

  assertEquals(pool.servers.length, 1, "the list's connection, reused");
  const commands = pool.servers[0].commands;
  const afterList = commands.slice(commands.findIndex((c) => /^FETCH 1:5/.test(c)) + 1);
  assertEquals(afterList.filter((c) => /^UID SEARCH/.test(c)).length, 3, "one search per folder");
  assert(afterList.filter((c) => /^UID SEARCH/.test(c)).every((c) => /HEADER Message-ID/.test(c)));
  assert(afterList.filter((c) => /FETCH/.test(c)).length <= 4, "the anchor, then one fetch per folder with hits");
  assert(!commands.some((c) => /BODY\.PEEK\[\]/.test(c)), "never a full message");
  await pool.closeAll();
});

Deno.test("thread (imap): a server whose SEARCH HEADER finds nothing (Migadu) falls back to subject + date, filtered by headers", async () => {
  const { app, pool, run } = await rig({ headerSearchBroken: true });
  const { value } = await run(() => app.mail("thread", { message_id: "INBOX:3" }));
  assertEquals(value.status, 200, JSON.stringify(value.body));
  // Same answer as the header search: INBOX:5 and Sent:2 share the subject
  // "Re: Invoice" and are NOT linked by any header, so they stay out.
  assertEquals(value.body.messages.map((m: { id: string }) => m.id), ["INBOX:1", "Sent:1", "Archive:4", "INBOX:3", "INBOX:6"]);
  assertEquals([value.body.strategy, value.body.partial], ["imap_subject_fallback", false]);
  const searches = pool.servers[0].commands.filter((c) => /^UID SEARCH/.test(c));
  assertEquals(searches[0].includes("HEADER Message-ID"), true, "the header search is tried first, in the anchor's folder");
  assertEquals(searches.slice(1), Array(3).fill('UID SEARCH SUBJECT "Invoice" SINCE 7-Mar-2026'));
  // Candidates are fetched without a preview; only the kept ones with.
  const fetches = pool.servers[0].commands.filter((c) => /^UID FETCH/.test(c));
  assert(fetches.some((c) => !/BODY\.PEEK\[1\]/.test(c)) && fetches.some((c) => /BODY\.PEEK\[1\]/.test(c)));
  await pool.closeAll();
});

Deno.test("thread (imap): a message with no Message-ID, In-Reply-To or References is a conversation of one", async () => {
  const boxes: FakeMailbox[] = [{
    name: "INBOX",
    messages: [
      mail(1, { id: null, subject: "Re: Invoice", date: "01 Sep 2026 10:00:00 +0000" }),
      mail(2, { id: null, subject: "Re: Invoice", date: "02 Sep 2026 10:00:00 +0000" }),
    ],
  }];
  const { app, pool, run } = await rig({ boxes });
  const { value } = await run(() => app.mail("thread", { message_id: "INBOX:2" }));
  assertEquals(value.status, 200, JSON.stringify(value.body));
  assertEquals([value.body.messages.map((m: { id: string }) => m.id), value.body.strategy], [["INBOX:2"], "single"]);
  assert(value.body.thread_key.startsWith("s:"));
  assertEquals(pool.servers[0].commands.filter((c) => /SEARCH/.test(c)).length, 0);
  await pool.closeAll();
});

Deno.test("thread (imap): the same message filed in two folders comes back once; limit keeps the newest and says partial", async () => {
  const boxes = world();
  // A copy of the Sent answer also sits in Archive (Gmail-over-IMAP's All Mail does this).
  boxes[2].messages.push({ ...boxes[1].messages[0], uid: 40 });
  const { app, pool, run } = await rig({ boxes });
  const all = await run(() => app.mail("thread", { message_id: "INBOX:1" }));
  assertEquals(all.value.body.messages.map((m: { id: string }) => m.id), ["INBOX:1", "Sent:1", "Archive:4", "INBOX:3", "INBOX:6"]);
  const two = await run(() => app.mail("thread", { message_id: "INBOX:1", limit: 2 }));
  assertEquals([two.value.body.messages.map((m: { id: string }) => m.id), two.value.body.partial, two.value.body.partial_reason], [["INBOX:3", "INBOX:6"], true, "limit"]);
  await pool.closeAll();
});

Deno.test("thread (imap): a folder the server refuses is skipped and reported as partial; a missing anchor is not_found", async () => {
  const boxes = world();
  const advertised = ["IMAP4REV1"];
  const pool = new FakeDialPool(() =>
    Object.assign(
      new FakeImapServer({ mailboxes: boxes, refuse: (command) => (/^SELECT "?Sent/.test(command) ? "NO [SERVERBUG] try later" : null) }),
      { advertised },
    )
  );
  const app = await realApp({ pool });
  const inbox = await imapInbox();
  const { value } = await harness.runTool(inbox, noHandler, () => app.mail("thread", { message_id: "INBOX:3" }));
  assertEquals(value.status, 200, JSON.stringify(value.body));
  assertEquals([value.body.partial, value.body.partial_reason], [true, "folder_error"]);
  assertEquals(value.body.messages.map((m: { id: string }) => m.id), ["INBOX:1", "Archive:4", "INBOX:3", "INBOX:6"]);

  const gone = await harness.runTool(inbox, noHandler, () => app.mail("thread", { message_id: "INBOX:999" }));
  assertEquals([gone.value.status, gone.value.body.error.code], [404, "not_found"]);
  await pool.closeAll();
});

Deno.test("thread: argument validation, and a viewer may call it (it is a read)", async () => {
  const { app, pool, run } = await rig();
  const bad = await run(() => app.mail("thread", { message_id: "INBOX:3", folder: "x" }));
  assertEquals([bad.value.status, bad.value.body.error.code], [400, "invalid_request"]);
  const none = await run(() => app.mail("thread", {}));
  assertEquals(none.value.status, 400);
  const big = await run(() => app.mail("thread", { message_id: "INBOX:3", limit: 101 }));
  assertEquals(big.value.status, 400);
  await pool.closeAll();

  const viewerPool = new FakeDialPool(() => Object.assign(new FakeImapServer({ mailboxes: world() }), { advertised: ["IMAP4REV1"] }));
  const viewer = await realApp({ pool: viewerPool, role: "viewer" });
  const ok = await harness.runTool(await imapInbox(), noHandler, () => viewer.mail("thread", { message_id: "INBOX:3" }));
  assertEquals(ok.value.status, 200);
  await viewerPool.closeAll();
});

// ── The thread op: Gmail and Outlook ────────────────────────────────────────

Deno.test("thread (gmail): threads.get metadata, one request with the key, drafts and trash left out", async () => {
  const urls: string[] = [];
  const message = (id: string, ms: number, labelIds: string[], extra: Record<string, string> = {}) => ({
    id,
    threadId: "T9",
    labelIds,
    snippet: `snippet ${id}`,
    internalDate: String(ms),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: id === "g2" ? "owner@gmail-harness.example" : "Maya <maya@north.example>" },
        { name: "To", value: "owner@gmail-harness.example" },
        { name: "Subject", value: "Re: Plan" },
        { name: "Message-ID", value: `<${id}@mail.example>` },
        ...Object.entries(extra).map(([name, value]) => ({ name, value })),
      ],
    },
  });
  const handler: harness.ProviderHandler = (call) => {
    urls.push(call.url);
    const url = new URL(call.url);
    if (url.pathname.endsWith("/threads/T9")) {
      return harness.json({
        id: "T9",
        messages: [
          message("g2", 2000, ["SENT"], { "In-Reply-To": "<g1@mail.example>", References: "<g1@mail.example>" }),
          message("g1", 1000, ["INBOX", "STARRED"]),
          message("g3", 3000, ["INBOX", "UNREAD"]),
          message("g4", 4000, ["DRAFT"]),
          message("g5", 5000, ["TRASH"]),
        ],
      });
    }
    if (url.pathname.endsWith("/messages/g3")) return harness.json({ id: "g3", threadId: "T9" });
    return harness.json({ error: { code: 404, message: "unscripted" } }, 404);
  };
  const app = await realApp();
  const inbox = await harness.inboxRow("gmail");
  const keyed = await harness.runTool(inbox, handler, () => app.mail("thread", { message_id: "g3", thread_key: "g:T9" }));
  assertEquals(keyed.value.status, 200, JSON.stringify(keyed.value.body));
  const body = keyed.value.body;
  assertEquals(body.messages.map((m: { id: string; folder: string; is_read: boolean; is_flagged: boolean }) => [m.id, m.folder, m.is_read, m.is_flagged]), [
    ["g1", "INBOX", true, true],
    ["g2", "SENT", true, false],
    ["g3", "INBOX", false, false],
  ]);
  assertEquals([body.thread_key, body.strategy, body.partial, body.folders], ["g:T9", "gmail_thread", false, ["*"]]);
  assertEquals([body.messages[1].in_reply_to, body.messages[1].references, body.messages[1].message_id_header, body.messages[1].thread_key], ["g1@mail.example", ["g1@mail.example"], "g2@mail.example", "g:T9"]);
  const toGmail = (u: string) => new URL(u).hostname === "gmail.googleapis.com";
  const gmailCalls = urls.filter(toGmail).map((u) => new URL(u));
  assertEquals(gmailCalls.length, 1, "one request when the key is given");
  assertEquals(gmailCalls[0].pathname, "/gmail/v1/users/me/threads/T9");
  assert(gmailCalls[0].searchParams.get("format") === "metadata" && gmailCalls[0].searchParams.getAll("metadataHeaders").includes("References"));

  urls.length = 0;
  const unkeyed = await harness.runTool(inbox, handler, () => app.mail("thread", { message_id: "g3" }));
  assertEquals(unkeyed.value.body.messages.length, 3);
  assertEquals(urls.filter(toGmail).map((u) => new URL(u).pathname), ["/gmail/v1/users/me/messages/g3", "/gmail/v1/users/me/threads/T9"], "the anchor lookup, then the thread");
});

Deno.test("list (gmail): the thread headers ride the metadata get client-api already makes; MCP asks for the four it always did", async () => {
  const seen: string[] = [];
  const handler: harness.ProviderHandler = (call) => {
    const url = new URL(call.url);
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    if (path === "/messages") return harness.json({ messages: [{ id: "g1", threadId: "T1" }], resultSizeEstimate: 1 });
    if (path.startsWith("/labels")) return harness.json({ id: "INBOX", name: "INBOX", messagesTotal: 1, messagesUnread: 0, labels: [] });
    if (path === "/messages/g1") {
      seen.push(url.searchParams.getAll("metadataHeaders").join(","));
      return harness.json({
        id: "g1",
        threadId: "T1",
        labelIds: ["INBOX"],
        snippet: "s",
        internalDate: "1767225600000",
        payload: { mimeType: "text/plain", headers: [
          { name: "From", value: "A <a@x.example>" },
          { name: "Subject", value: "Re: x" },
          { name: "Message-ID", value: "<g1@x.example>" },
          { name: "In-Reply-To", value: "<g0@x.example>" },
          { name: "References", value: "<root@x.example> <g0@x.example>" },
        ] },
      });
    }
    return harness.json({ error: { code: 404, message: "unscripted" } }, 404);
  };
  const app = await realApp();
  const inbox = await harness.inboxRow("gmail");
  const { value } = await harness.runTool(inbox, handler, () => app.mail("list", { folder: "inbox", limit: 5 }));
  assertEquals(value.status, 200, JSON.stringify(value.body));
  const row = value.body.messages[0];
  assertEquals([row.thread_key, row.message_id_header, row.in_reply_to, row.references], ["g:T1", "g1@x.example", "g0@x.example", ["root@x.example", "g0@x.example"]]);
  assertEquals(seen, ["From,To,Subject,Date,Message-ID,In-Reply-To,References"]);

  seen.length = 0;
  const viaMcp = await harness.runTool(inbox, handler, () =>
    mcp.handleToolsCall(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "email_read", arguments: { action: "list", inbox_id: INBOX_ID, folder: "inbox", limit: 5 } } },
      1,
      { ...harness.API_KEY, scopes: ["read:email", "search:email"] },
      { ipAddress: null, userAgent: "thread-test" },
    ) as Promise<{ result?: { structuredContent?: { messages: Record<string, unknown>[] } } }>);
  assertEquals(seen, ["From,To,Subject,Date"]);
  const mcpRow = viaMcp.value.result!.structuredContent!.messages[0];
  for (const key of ["message_id_header", "in_reply_to", "references", "thread_key", "is_flagged"]) assert(!(key in mcpRow), key);
});

Deno.test("thread (outlook): filter by conversationId, sorted here, drafts and Deleted Items left out", async () => {
  const urls: string[] = [];
  const handler: harness.ProviderHandler = (call) => {
    urls.push(call.url);
    const url = new URL(call.url);
    const path = url.pathname.replace("/v1.0", "");
    if (path === "/me/messages" && url.searchParams.get("$filter") === "conversationId eq 'C''1'") {
      const m = (id: string, at: string, folder: string, extra: Record<string, unknown> = {}) => ({
        id,
        conversationId: "C'1",
        from: { emailAddress: { name: "Maya", address: "maya@north.example" } },
        toRecipients: [{ emailAddress: { name: "Owner", address: "owner@outlook-harness.example" } }],
        subject: "RE: Plan",
        receivedDateTime: at,
        bodyPreview: `preview ${id}`,
        isRead: true,
        hasAttachments: false,
        parentFolderId: folder,
        internetMessageId: `<${id}@outlook.example>`,
        ...extra,
      });
      return harness.json({
        value: [
          m("o3", "2026-09-03T10:00:00Z", "f-inbox", { isRead: false, flag: { flagStatus: "flagged" } }),
          m("o1", "2026-09-01T10:00:00Z", "f-inbox"),
          m("o2", "2026-09-02T10:00:00Z", "f-sent"),
          m("o4", "2026-09-04T10:00:00Z", "f-drafts", { isDraft: true }),
          m("o5", "2026-09-05T10:00:00Z", "f-trash"),
        ],
      });
    }
    const wellKnown: Record<string, string> = { inbox: "f-inbox", sentitems: "f-sent", drafts: "f-drafts", deleteditems: "f-trash", junkemail: "f-junk", archive: "f-archive" };
    const folder = /^\/me\/mailFolders\/([^/]+)$/.exec(path)?.[1];
    if (folder && wellKnown[folder]) return harness.json({ id: wellKnown[folder] });
    if (folder) {
      const names: Record<string, string> = { "f-inbox": "Inbox", "f-sent": "Sent Items", "f-trash": "Deleted Items" };
      return harness.json({ id: folder, displayName: names[folder] ?? folder, parentFolderId: "root" });
    }
    if (path === "/$batch") {
      const body = JSON.parse(call.body ?? "{}") as { requests: Array<{ id: string; url: string }> };
      return harness.json({
        responses: body.requests.map((r) => {
          const id = /mailFolders\/([^?/]+)/.exec(r.url)?.[1] ?? "";
          return { id: r.id, status: 200, body: { id, displayName: id === "f-inbox" ? "Inbox" : id === "f-sent" ? "Sent Items" : id, parentFolderId: "root" } };
        }),
      });
    }
    return harness.json({ error: { code: "ErrorItemNotFound", message: "unscripted" } }, 404);
  };
  const app = await realApp();
  const { value } = await harness.runTool(await harness.inboxRow("outlook"), handler, () => app.mail("thread", { message_id: "o3", thread_key: "o:C'1" }));
  assertEquals(value.status, 200, JSON.stringify(value.body));
  assertEquals(value.body.messages.map((m: { id: string; is_read: boolean; is_flagged: boolean }) => [m.id, m.is_read, m.is_flagged]), [
    ["o1", true, false],
    ["o2", true, false],
    ["o3", false, true],
  ]);
  assertEquals([value.body.thread_key, value.body.strategy], ["o:C'1", "outlook_conversation"]);
  assertEquals(value.body.messages[0].message_id_header, "o1@outlook.example");
  assert(value.body.messages.every((m: { thread_key: string; folder: string }) => m.thread_key === "o:C'1" && m.folder.length > 0));
  assert(!urls.some((u) => /\$orderby/.test(u) && /conversationId/.test(u)), "Graph refuses this filter with $orderby");
});

// ── With the byte-exact IMAP reader (the read fixes of 2026-10-04) ──────────
//
// The reader hands every literal back as a byte string (one character per
// octet). The References literal is a header value, so it is decoded like every
// ENVELOPE string before an id is taken from it: no byte string reaches
// `references`, `thread_key` or the JSON.

/** Text as it is on the wire: its UTF-8 octets, one character each. */
function wire(text: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(text)) out += String.fromCharCode(byte);
  return out;
}

/** A message whose header lines are given verbatim (folding and all). */
function rawMail(uid: number, headers: string[], flags: string[] = []): FakeMessage {
  return { uid, flags, raw: [...headers, "Content-Type: text/plain; charset=utf-8", "", `Body ${uid}.`].join(CRLF) };
}

function assertNoByteStrings(value: unknown, what: string): void {
  const json = JSON.stringify(value);
  // Mojibake of UTF-8 read one octet at a time ("Ã˜", "Ã¥", "â€“"), and U+FFFD.
  assert(!/[ÂÃâ][\u0080-¿˜€“”]/.test(json), `${what}: a byte string leaked: ${json}`);
  assert(!json.includes("�"), `${what}: U+FFFD: ${json}`);
}

Deno.test("list (imap): a folded References header gives the same ids and thread_key as an unfolded one", async () => {
  const ids = Array.from({ length: 14 }, (_, i) => `ref-${i}.${"x".repeat(40)}@mail.example.com`);
  const date = "Date: 03 Sep 2026 10:00:00 +0000";
  const common = [date, 'From: "Maya" <maya@example.com>', "To: <owner@example.com>", "Subject: Re: Invoice"];
  const boxes: FakeMailbox[] = [{
    name: "INBOX",
    messages: [
      // One line.
      rawMail(1, [...common, "Message-ID: <one@example.com>", `In-Reply-To: <${ids[13]}>`, `References: ${ids.map((id) => `<${id}>`).join(" ")}`]),
      // Folded after every id, with a space, a tab, and several of each.
      rawMail(2, [...common, "Message-ID: <two@example.com>", `In-Reply-To: <${ids[13]}>`, `References: <${ids[0]}>`, ...ids.slice(1).map((id, i) => `${[" ", "\t", "   ", "\t \t"][i % 4]}<${id}>`)]),
      // Folded straight after the colon, the first id on the continuation line.
      rawMail(3, [...common, "Message-ID: <three@example.com>", `In-Reply-To: <${ids[13]}>`, "References:", ...ids.map((id) => `\t<${id}>`)]),
    ],
  }];
  const { app, pool, run } = await rig({ boxes });
  const { value } = await run(() => app.mail("list", { folder: "inbox", limit: 10 }));
  assertEquals(value.status, 200, JSON.stringify(value.body));
  const rows = value.body.messages as Array<Record<string, unknown>>;
  assertEquals(rows.length, 3);
  // The root and the newest nine (MAX_ROW_REFERENCES), whatever the folding.
  const expected = [ids[0], ...ids.slice(-9)];
  for (const row of rows) {
    assertEquals(row["references"], expected, String(row["id"]));
    assertEquals(row["in_reply_to"], ids[13]);
    assertEquals(row["thread_key"], `m:${ids[0]}`);
    for (const id of row["references"] as string[]) assert(!/[\s<>]/.test(id), `whitespace or a bracket in an id: ${JSON.stringify(id)}`);
  }
  assertNoByteStrings(rows, "rows");
  await pool.closeAll();
});

Deno.test("list (imap): References with odd whitespace, no whitespace, comments and raw 8-bit octets yields clean ids only", async () => {
  const common = ["Date: 03 Sep 2026 10:00:00 +0000", 'From: "Maya" <maya@example.com>', "To: <owner@example.com>", "Subject: Re: Odd"];
  const boxes: FakeMailbox[] = [{
    name: "INBOX",
    messages: [
      // Tabs, runs of spaces, trailing whitespace, ids with nothing between them.
      rawMail(1, [...common, "Message-ID:   <a1@example.com>  ", "In-Reply-To: \t <p@example.com>\t", "References:\t<root@example.com>   <b@example.com><c@example.com>\t\t<p@example.com>   "]),
      // A no-break space (UTF-8 C2 A0 on the wire) between ids, and a raw 8-bit
      // UTF-8 id: both arrive as octets and must come out as text.
      rawMail(2, [...common, "Message-ID: <a2@example.com>", `References: <root@example.com>${wire(" ")}<${wire("blåbær")}@example.com>`]),
      // Commas, a comment, and an id broken by folding (dropped, not glued).
      rawMail(3, [...common, "Message-ID: <a3@example.com>", "References: <root@example.com>, <b@example.com> (was: <not-an-id>),", " <broken@", " example.com> <c@example.com>"]),
      // An empty References field.
      rawMail(4, [...common, "Message-ID: <a4@example.com>", "References:  "]),
    ],
  }];
  const { app, pool, run } = await rig({ boxes });
  const { value } = await run(() => app.mail("list", { folder: "inbox", limit: 10 }));
  assertEquals(value.status, 200, JSON.stringify(value.body));
  const byId = new Map((value.body.messages as Array<Record<string, unknown>>).map((r) => [r["id"], r]));

  assertEquals(byId.get("INBOX:1")!["references"], ["root@example.com", "b@example.com", "c@example.com", "p@example.com"]);
  assertEquals([byId.get("INBOX:1")!["message_id_header"], byId.get("INBOX:1")!["in_reply_to"]], ["a1@example.com", "p@example.com"]);
  assertEquals(byId.get("INBOX:2")!["references"], ["root@example.com", "blåbær@example.com"], "decoded text, not octets");
  assertEquals(byId.get("INBOX:3")!["references"], ["root@example.com", "b@example.com", "not-an-id", "c@example.com"]);
  assertEquals(byId.get("INBOX:4")!["references"], []);
  assertEquals(byId.get("INBOX:4")!["thread_key"], "m:a4@example.com");
  for (const n of [1, 2, 3]) assertEquals(byId.get(`INBOX:${n}`)!["thread_key"], "m:root@example.com");
  assertNoByteStrings(value.body, "rows");
  // What the client receives is valid, round-trippable JSON text.
  assertEquals(JSON.parse(JSON.stringify(value.body)), value.body);
  await pool.closeAll();
});

Deno.test("thread (imap): the subject fallback sends a non-ASCII subject as a UTF-8 literal with CHARSET, in the sender's case", async () => {
  const subject = "Faktura – Ødegård & Sønn";
  const mk = (uid: number, id: string, subjectHeader: string, o: { inReplyTo?: string; references?: string[]; from?: string } = {}) =>
    rawMail(uid, [
      `Date: 0${uid} Sep 2026 10:00:00 +0000`,
      `From: ${o.from ?? '"Maya" <maya@example.com>'}`,
      "To: <owner@example.com>",
      `Subject: ${subjectHeader}`,
      `Message-ID: <${id}>`,
      ...(o.inReplyTo ? [`In-Reply-To: <${o.inReplyTo}>`] : []),
      ...(o.references ? [`References: ${o.references.map((r) => `<${r}>`).join(" ")}`] : []),
    ]);
  const boxes: FakeMailbox[] = [
    {
      name: "INBOX",
      attrs: ["\\HasNoChildren"],
      messages: [
        // Raw 8-bit UTF-8 in the header (no RFC 2047), as some senders write it.
        mk(1, "root@example.com", wire(subject)),
        // RFC 2047, base64.
        mk(3, "c@example.com", `=?UTF-8?B?${btoa(wire(`SV: ${subject}`))}?=`, { inReplyTo: "b@example.com", references: ["root@example.com", "b@example.com"] }),
        // The same subject from someone else, linked to nothing: stays out.
        mk(5, "other@example.com", wire(`Re: ${subject}`), { from: '"Odd" <odd@example.com>', inReplyTo: "elsewhere@example.com", references: ["elsewhere@example.com"] }),
      ],
    },
    {
      name: "Sent",
      attrs: ["\\HasNoChildren", "\\Sent"],
      messages: [
        // RFC 2047, quoted-printable, split over two encoded words.
        mk(2, "b@example.com", "=?UTF-8?Q?Re:_Faktura_=E2=80=93_=C3=98deg=C3=A5rd?= =?UTF-8?Q?_&_S=C3=B8nn?=", { from: "<owner@example.com>", inReplyTo: "root@example.com", references: ["root@example.com"] }),
      ],
    },
  ];
  const { app, pool, run } = await rig({ headerSearchBroken: true, boxes });
  const { value } = await run(() => app.mail("thread", { message_id: "INBOX:3" }));
  assertEquals(value.status, 200, JSON.stringify(value.body));
  assertEquals(value.body.messages.map((m: { id: string }) => m.id), ["INBOX:1", "Sent:2", "INBOX:3"]);
  assertEquals([value.body.strategy, value.body.partial, value.body.thread_key], ["imap_subject_fallback", false, "m:root@example.com"]);
  assertEquals(value.body.messages.map((m: { subject: string }) => m.subject), [subject, `Re: ${subject}`, `SV: ${subject}`]);
  assertNoByteStrings(value.body, "thread");

  // The fake records a literal as the quoted text its octets spell.
  const searches = pool.servers[0].commands.filter((c) => /^UID SEARCH/.test(c));
  const fallback = searches.filter((c) => /SUBJECT/.test(c));
  assert(fallback.length >= 2, searches.join(" | "));
  for (const command of fallback) {
    assertEquals(command, `UID SEARCH CHARSET UTF-8 SUBJECT "${subject}" SINCE 7-Mar-2026`, "CHARSET named, the subject whole and in its own case");
  }
  await pool.closeAll();
});

Deno.test("thread (imap): a server that refuses CHARSET and a subject with no ASCII folding: the anchor alone, reported partial", async () => {
  const mk = (uid: number, id: string, subject: string, refs?: string[]) =>
    rawMail(uid, [`Date: 0${uid} Sep 2026 10:00:00 +0000`, 'From: "Maya" <maya@example.com>', "To: <owner@example.com>", `Subject: ${wire(subject)}`, `Message-ID: <${id}>`, ...(refs ? [`References: ${refs.map((r) => `<${r}>`).join(" ")}`] : [])]);
  // A CJK subject has no ASCII folding: the search is not run for something else.
  const boxes: FakeMailbox[] = [{ name: "INBOX", messages: [mk(1, "r@example.com", "請求書"), mk(2, "s@example.com", "Re: 請求書", ["r@example.com"])] }];
  const advertised = ["IMAP4REV1"];
  const pool = new FakeDialPool(() =>
    Object.assign(new FakeImapServer({ mailboxes: boxes, capabilities: advertised, headerSearchBroken: true, rejectCharset: true }), { advertised })
  );
  const app = await realApp({ pool });
  const inbox = await imapInbox();
  const { value } = await harness.runTool(inbox, noHandler, () => app.mail("thread", { message_id: "INBOX:2" }));
  assertEquals(value.status, 200, JSON.stringify(value.body));
  assertEquals(value.body.messages.map((m: { id: string }) => m.id), ["INBOX:2"], "the anchor alone");
  assertEquals([value.body.partial, value.body.partial_reason], [true, "folder_error"]);
  assertEquals(value.body.messages[0].subject, "Re: 請求書");
  await pool.closeAll();
});
