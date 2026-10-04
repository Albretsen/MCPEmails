// Conversation threading: the thread headers and `thread_key` on rows, and the
// `thread` op, against the REAL tool layer (fake IMAP server, fake fetch).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { firstPartyContext, messageIdsOf, referencesOfHeaderBlock } from "../../mcp-server/first-party.ts";
import { type FakeMailbox, type FakeMessage, type FakeServerOptions, FakeImapServer } from "../../mcp-server/imap-fake-server.ts";
import { isSearchThrottle, searchThrottleWaitMs } from "../imap-pool.ts";
import { imapDate, keepLinked, MAX_CANDIDATES, ThreadMemory, threadSearchCriteria } from "../mail/thread.ts";
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

async function rig(
  options: {
    headerSearchBroken?: boolean;
    boxes?: FakeMailbox[];
    /** Anything else the fake server models (rate limit, slow search, Migadu's HEADER quirk). */
    server?: Partial<FakeServerOptions>;
    advertised?: string[];
    threads?: ThreadMemory;
    now?: () => number;
  } = {},
) {
  const boxes = options.boxes ?? world();
  const advertised = options.advertised ?? ["IMAP4REV1"];
  // One options object for every connection: a rate limit counts across them.
  const shared = { ...(options.server ?? {}) };
  const pool = new FakeDialPool(() =>
    Object.assign(
      new FakeImapServer(Object.assign(shared, { mailboxes: boxes, capabilities: advertised, headerSearchBroken: options.headerSearchBroken })),
      { advertised },
    )
  );
  const app = await realApp({ pool, threads: options.threads, now: options.now });
  const inbox = await imapInbox();
  const run = <T>(body: () => Promise<T>) => harness.runTool(inbox, noHandler, body);
  return { boxes, pool, app, run, inbox };
}

const ids = (body: { messages: Array<{ id: string }> }) => body.messages.map((m) => m.id);
const searchesOf = (pool: FakeDialPool) => pool.servers.flatMap((s) => s.commands).filter((c) => /^UID SEARCH/.test(c));

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

Deno.test("the one search: SINCE + SUBJECT of the base subject, bounded and quote-safe; a date window when there is no subject", () => {
  const at = Date.UTC(2026, 8, 3, 10);
  assertEquals(threadSearchCriteria("SV: Re: Fwd: Invoice", at), { criteria: 'SINCE 7-Mar-2026 SUBJECT "Invoice"', bySubject: true });
  assertEquals(threadSearchCriteria('Re: a "quoted" \\ thing', at).criteria, 'SINCE 7-Mar-2026 SUBJECT "a \\"quoted\\" \\\\ thing"');
  // Nothing to narrow by: the window alone, and a shorter one.
  assertEquals(threadSearchCriteria("(no subject)", at), { criteria: "SINCE 4-Aug-2026", bySubject: false });
  assertEquals(threadSearchCriteria("Re: ", at).bySubject, false);
  // A control character cannot reach a command line.
  assertEquals(threadSearchCriteria("bad\u0007subject", at), { criteria: "SINCE 4-Aug-2026", bySubject: false });
  // A long subject is searched by its start (SUBJECT is a substring match), whole code points only.
  const long = threadSearchCriteria(`Re: ${"😀".repeat(300)}`, at).criteria;
  assertEquals(long, `SINCE 7-Mar-2026 SUBJECT "${"😀".repeat(120)}"`);
  assertEquals(imapDate(Date.UTC(2026, 0, 5)), "5-Jan-2026");
});

Deno.test("isSearchThrottle: a rate-limit NO, and nothing else", () => {
  assert(isSearchThrottle(new Error("UID SEARCH failed: [LIMIT] Search rate limit exceeded, try again later")));
  assert(isSearchThrottle(new Error("UID SEARCH failed: Too many requests")));
  // Migadu, verbatim (live 2026-10-04).
  const migadu = new Error("UID SEARCH failed: search rate limit exceeded: 60 searches in 1m0s, please wait 12s before trying again");
  assert(isSearchThrottle(migadu));
  assertEquals([searchThrottleWaitMs(migadu), searchThrottleWaitMs(new Error("UID SEARCH failed: [LIMIT] slow down")), searchThrottleWaitMs(new Error("nope, wait 5s"))], [12_000, null, null]);
  assert(isSearchThrottle(new Error("UID SEARCH failed: [UNAVAILABLE] Temporary failure")));
  assert(!isSearchThrottle(new Error("UID SEARCH failed: [BADCHARSET (US-ASCII)] Unsupported charset")));
  assert(!isSearchThrottle(new Error("UID SEARCH failed: Unknown argument FOO")));
  assert(!isSearchThrottle(new Error("UID FETCH failed: [LIMIT] too many")), "only a search");
  assert(!isSearchThrottle(new Error("IMAP read timeout")));
  assert(!isSearchThrottle("UID SEARCH failed: [LIMIT]"));
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
  assertEquals([body.partial, body.strategy, body.thread_key], [false, "imap_subject_search", "m:root@example.com"]);
  assertEquals(body.folders, ["INBOX", "Sent", "Archive"]);
  const sent = body.messages[1];
  assertEquals([sent.folder, sent.is_read, sent.is_flagged, sent.thread_key, sent.from.email], ["Sent", true, false, "m:root@example.com", "owner@example.com"]);
  assertEquals(body.messages[3].is_flagged, true);
  assert(!("body_text" in sent) && !("body_html" in sent), "no bodies");
  assertEquals(typeof sent.preview, "string");

  assertEquals(pool.servers.length, 1, "the list's connection, reused");
  const commands = pool.servers[0].commands;
  const afterList = commands.slice(commands.findIndex((c) => /^FETCH 1:5/.test(c)) + 1);
  assertEquals(afterList.filter((c) => /^UID SEARCH/.test(c)), Array(3).fill('UID SEARCH SINCE 7-Mar-2026 SUBJECT "Invoice"'), "ONE search per folder, the same one");
  assert(!afterList.some((c) => /HEADER/.test(c) && /SEARCH/.test(c)), "no HEADER search");
  assertEquals(afterList.filter((c) => /FETCH/.test(c)).length, 4, "the anchor, then ONE fetch per folder");
  assertEquals(afterList.filter((c) => /^SELECT/.test(c)).length, 2, "Sent and Archive: the anchor's folder is already selected");
  assert(!commands.some((c) => /BODY\.PEEK\[\]/.test(c)), "never a full message");
  await pool.closeAll();
});

// ── What Migadu does (live, 2026-10-04) ─────────────────────────────────────
// `HEADER Message-ID` matches; `HEADER References` / `HEADER In-Reply-To`
// silently match nothing. The op used to pass its "does header search work"
// check on such a server and then miss every later reply, `partial: false`.

/** A four-message conversation as a self-send leaves it, plus a same-subject stranger. */
function selfSent(): FakeMailbox[] {
  const me = "<owner@example.com>";
  const chain = (n: number) => Array.from({ length: n }, (_, i) => `t${i}@example.com`);
  const msg = (uid: number, i: number, subject: string) =>
    mail(uid, {
      id: `t${i}@example.com`,
      subject,
      from: me,
      to: me,
      date: `0${i + 1} Sep 2026 10:00:00 +0000`,
      inReplyTo: i > 0 ? `t${i - 1}@example.com` : undefined,
      references: i > 0 ? chain(i) : undefined,
    });
  return [
    {
      name: "INBOX",
      attrs: ["\\HasNoChildren"],
      messages: [
        msg(11, 0, "Plan"),
        msg(12, 1, "Re: Plan"),
        // t2 has NO inbox copy: it exists only in Sent.
        msg(14, 3, "Re: Plan"),
        // Same subject, no header in common with the thread.
        mail(15, { id: "stranger@example.com", subject: "Re: Plan", from: me, to: me, date: "05 Sep 2026 10:00:00 +0000" }),
      ],
    },
    {
      name: "Sent",
      attrs: ["\\HasNoChildren", "\\Sent"],
      messages: [msg(21, 0, "Plan"), msg(22, 1, "Re: Plan"), msg(23, 2, "Re: Plan"), msg(24, 3, "Re: Plan"), mail(25, { id: "stranger@example.com", subject: "Re: Plan", from: me, to: me, date: "05 Sep 2026 10:00:00 +0000" })],
    },
  ];
}

Deno.test("thread (imap, Migadu's HEADER quirk): EVERY anchor returns the whole conversation, the Sent-only reply included, the stranger never", async () => {
  const anchors = ["INBOX:11", "INBOX:12", "INBOX:14", "Sent:21", "Sent:22", "Sent:23", "Sent:24"];
  for (const anchor of anchors) {
    // A fresh app per anchor: nothing is answered from memory.
    const { app, pool, run } = await rig({ boxes: selfSent(), server: { headerReferencesSearchBroken: true } });
    const { value } = await run(() => app.mail("thread", { message_id: anchor }));
    assertEquals(value.status, 200, JSON.stringify(value.body));
    const body = value.body;
    assertEquals(body.messages.map((m: { message_id_header: string }) => m.message_id_header), ["t0@example.com", "t1@example.com", "t2@example.com", "t3@example.com"], anchor);
    assertEquals([body.partial, body.strategy], [false, "imap_subject_search"], anchor);
    // One row per logical message: the copy in the anchor's folder, else the other folder's.
    const fromInbox = anchor.startsWith("INBOX");
    assertEquals(ids(body), fromInbox ? ["INBOX:11", "INBOX:12", "Sent:23", "INBOX:14"] : ["Sent:21", "Sent:22", "Sent:23", "Sent:24"], anchor);
    assert(ids(body).includes(anchor), "the anchor keeps the id it was asked by");
    const searches = searchesOf(pool);
    assertEquals(searches, Array(2).fill('UID SEARCH SINCE ' + imapDate(Date.parse(body.messages.find((m: { id: string }) => m.id === anchor).date) - 180 * 86_400_000) + ' SUBJECT "Plan"'), "one search per folder (Inbox, Sent); no Archive here");
    await pool.closeAll();
  }
});

Deno.test("thread (imap): a server whose SEARCH HEADER finds nothing at all answers the same (no header search is sent)", async () => {
  const { app, pool, run } = await rig({ headerSearchBroken: true });
  const { value } = await run(() => app.mail("thread", { message_id: "INBOX:3" }));
  assertEquals(value.status, 200, JSON.stringify(value.body));
  // INBOX:5 and Sent:2 share the subject "Re: Invoice" and are NOT linked by
  // any header, so they stay out.
  assertEquals(ids(value.body), ["INBOX:1", "Sent:1", "Archive:4", "INBOX:3", "INBOX:6"]);
  assertEquals([value.body.strategy, value.body.partial], ["imap_subject_search", false]);
  assertEquals(searchesOf(pool), Array(3).fill('UID SEARCH SINCE 7-Mar-2026 SUBJECT "Invoice"'));
  // Few candidates: their preview rides the one FETCH.
  const fetches = pool.servers[0].commands.filter((c) => /^UID FETCH/.test(c));
  assertEquals(fetches.length, 4);
  assert(fetches.every((c) => /BODY\.PEEK\[1\]/.test(c) && /HEADER\.FIELDS \(REFERENCES\)/.test(c)));
  await pool.closeAll();
});

Deno.test("thread (imap): the root is gone (deleted, never received): the replies still find each other, in both directions", async () => {
  const boxes: FakeMailbox[] = [
    {
      name: "INBOX",
      attrs: ["\\HasNoChildren"],
      messages: [
        mail(2, { id: "b@example.com", subject: "Re: Offer", date: "02 Sep 2026 10:00:00 +0000", inReplyTo: "gone@example.com", references: ["gone@example.com"] }),
        // Truncated References: only its parent, which lives in Sent.
        mail(4, { id: "d@example.com", subject: "RE: Offer", date: "04 Sep 2026 10:00:00 +0000", inReplyTo: "c@example.com", references: ["c@example.com"] }),
        mail(9, { id: "z@example.com", subject: "Re: Offer", date: "05 Sep 2026 10:00:00 +0000", inReplyTo: "y@example.com", references: ["y@example.com"] }),
      ],
    },
    {
      name: "Sent",
      attrs: ["\\HasNoChildren", "\\Sent"],
      messages: [
        mail(3, { id: "c@example.com", subject: "Re: Offer", from: "<owner@example.com>", to: "<maya@example.com>", date: "03 Sep 2026 10:00:00 +0000", inReplyTo: "b@example.com", references: ["gone@example.com", "b@example.com"] }),
      ],
    },
  ];
  for (const anchor of ["INBOX:2", "INBOX:4", "Sent:3"]) {
    const { app, pool, run } = await rig({ boxes });
    const { value } = await run(() => app.mail("thread", { message_id: anchor }));
    assertEquals(value.status, 200, JSON.stringify(value.body));
    // INBOX:4 links only through Sent:3, a candidate of ANOTHER folder.
    assertEquals([ids(value.body), value.body.partial], [["INBOX:2", "Sent:3", "INBOX:4"], false], anchor);
    await pool.closeAll();
  }
});

Deno.test("thread (imap): an empty subject scans a date window, still linked by headers only", async () => {
  const boxes: FakeMailbox[] = [{
    name: "INBOX",
    attrs: ["\\HasNoChildren"],
    messages: [
      mail(1, { id: "e1@example.com", subject: "", date: "01 Sep 2026 10:00:00 +0000" }),
      mail(2, { id: "e2@example.com", subject: "Re:", date: "02 Sep 2026 10:00:00 +0000", inReplyTo: "e1@example.com", references: ["e1@example.com"] }),
      mail(3, { id: "e3@example.com", subject: "", date: "03 Sep 2026 10:00:00 +0000" }),
      mail(4, { id: "e4@example.com", subject: "Something else", date: "03 Sep 2026 11:00:00 +0000" }),
    ],
  }];
  const { app, pool, run } = await rig({ boxes });
  const { value } = await run(() => app.mail("thread", { message_id: "INBOX:1" }));
  assertEquals(value.status, 200, JSON.stringify(value.body));
  assertEquals([ids(value.body), value.body.partial, value.body.strategy], [["INBOX:1", "INBOX:2"], false, "imap_window_scan"]);
  assertEquals(searchesOf(pool), ["UID SEARCH SINCE 2-Aug-2026"]);
  await pool.closeAll();
});

Deno.test("thread (imap): a subject too generic to narrow by is bounded and says so (partial: candidates)", async () => {
  const many = Array.from({ length: MAX_CANDIDATES + 30 }, (_, i) =>
    mail(i + 1, { id: `h${i + 1}@example.com`, subject: "Hello", date: "01 Sep 2026 10:00:00 +0000" }));
  // The anchor's one real reply is among the newest.
  many.push(mail(900, { id: "reply@example.com", subject: "Re: Hello", date: "02 Sep 2026 10:00:00 +0000", inReplyTo: "h5@example.com", references: ["h5@example.com"] }));
  const { app, pool, run } = await rig({ boxes: [{ name: "INBOX", attrs: ["\\HasNoChildren"], messages: many }] });
  const { value } = await run(() => app.mail("thread", { message_id: "INBOX:5" }));
  assertEquals(value.status, 200, JSON.stringify(value.body));
  assertEquals([ids(value.body), value.body.partial, value.body.partial_reason], [["INBOX:5", "INBOX:900"], true, "candidates"]);
  const fetches = pool.servers[0].commands.filter((c) => /^UID FETCH/.test(c));
  // The anchor; MAX_CANDIDATES candidates without a preview; the one kept row with.
  assertEquals(fetches.length, 3);
  assertEquals(fetches[1].split(" ")[2].split(",").length, MAX_CANDIDATES);
  assert(!/BODY\.PEEK\[1\]/.test(fetches[1]) && /BODY\.PEEK\[1\]/.test(fetches[2]));
  assertEquals(fetches[2].split(" ")[2], "900");
  await pool.closeAll();
});

// ── Rate limits, the time budget, the memo ──────────────────────────────────

Deno.test("thread (imap): a throttled search answers what was found, partial: rate_limited; the connection is KEPT and the inbox is not searched again for a while", async () => {
  let skew = 0;
  const clock = () => Date.now() + skew;
  // The server allows one search; the second (Sent) is answered NO [LIMIT].
  const { app, pool, run } = await rig({ server: { searchLimit: 1 }, now: clock });
  const first = await run(() => app.mail("thread", { message_id: "INBOX:3" }));
  assertEquals(first.value.status, 200, JSON.stringify(first.value.body));
  assertEquals([first.value.body.partial, first.value.body.partial_reason], [true, "rate_limited"]);
  // The anchor's folder was searched before the limit hit.
  assertEquals(ids(first.value.body), ["INBOX:1", "INBOX:3", "INBOX:6"]);
  assertEquals(searchesOf(pool).length, 2);
  assertEquals([pool.servers.length, pool.stats.drops, pool.stats.throttles], [1, 0, 1], "no redial");
  assert(!pool.servers[0].closed);

  // Inside the back-off: the anchor alone, no search sent, still 200.
  const second = await run(() => app.mail("thread", { message_id: "INBOX:1" }));
  assertEquals([second.value.status, ids(second.value.body), second.value.body.partial_reason], [200, ["INBOX:1"], "rate_limited"]);
  assertEquals(searchesOf(pool).length, 2, "no search during the back-off");

  // The `search` op meets the same limit: 429 rate_limited (was 502), same connection.
  const search = await run(() => app.mail("search", { subject: "Invoice", limit: 5 }));
  assertEquals([search.value.status, search.value.body.error.code, search.value.body.error.retryable, search.value.body.error.tool_code], [429, "rate_limited", true, "imap_search_throttled"]);
  assert(!/LIMIT|UID SEARCH/.test(search.value.body.error.message), "the server's wording is not passed on");
  assertEquals([pool.servers.length, pool.stats.drops], [1, 0], "still no redial");

  // After the back-off the op searches again (and is throttled again here).
  skew += 16_000;
  const third = await run(() => app.mail("thread", { message_id: "INBOX:1" }));
  assertEquals(third.value.body.partial_reason, "rate_limited");
  assert(searchesOf(pool).length > 3);
  assertEquals(pool.servers.length, 1);
  await pool.closeAll();
});

Deno.test("thread (imap): a complete answer is remembered: re-opening, or stepping to another message of it, sends nothing; a write forgets it; so does time", async () => {
  let skew = 0;
  const clock = () => Date.now() + skew;
  const threads = new ThreadMemory();
  const { app, pool, run } = await rig({ threads, now: clock });
  const count = () => pool.servers.flatMap((s) => s.commands).length;
  const first = await run(() => app.mail("thread", { message_id: "INBOX:3" }));
  assertEquals(first.value.status, 200);
  const after = count();
  const again = await run(() => app.mail("thread", { message_id: "INBOX:3" }));
  const other = await run(() => app.mail("thread", { message_id: "Sent:1" }));
  assertEquals([again.value.body, other.value.body], [first.value.body, first.value.body]);
  assertEquals([count(), threads.hits], [after, 2], "nothing was sent");
  // A message that is not part of a remembered answer is asked for.
  await run(() => app.mail("thread", { message_id: "INBOX:7" }));
  assert(count() > after);

  // A write on the inbox forgets its answers (a flag changed; an id may have).
  const flagged = await run(() => app.mail("flag", { message_ids: ["INBOX:1"], read: false }));
  assertEquals(flagged.value.status, 200, JSON.stringify(flagged.value.body));
  const before = count();
  const fresh = await run(() => app.mail("thread", { message_id: "INBOX:3" }));
  assert(count() > before, "asked again after a write");
  assertEquals(fresh.value.body.messages.find((m: { id: string }) => m.id === "INBOX:1").is_read, false);

  // And it expires.
  const idle = count();
  skew += 46_000;
  await run(() => app.mail("thread", { message_id: "INBOX:3" }));
  assert(count() > idle, "asked again after THREAD_MEMO_MS");
  await pool.closeAll();
});

Deno.test("thread (imap): a search that outlives the budget is abandoned: the anchor comes back, partial: time_budget, and that inbox is not searched again for a while", async () => {
  const threads = new ThreadMemory({ timeBudgetMs: 60 });
  const { app, pool, run } = await rig({ threads, server: { searchDelayMs: 400 } });
  const started = performance.now();
  const { value } = await run(() => app.mail("thread", { message_id: "INBOX:3" }));
  const took = performance.now() - started;
  assertEquals(value.status, 200, JSON.stringify(value.body));
  assertEquals([ids(value.body), value.body.partial, value.body.partial_reason], [["INBOX:3"], true, "time_budget"]);
  assert(took < 350, `answered at the budget, not when the search finished (${took.toFixed(0)} ms)`);
  assertEquals(searchesOf(pool).length, 1, "one search was sent, none after it");
  // The connection still owed a reply: it is not reused.
  assertEquals(pool.stats.drops, 1);

  // Held off: the next call sends no search at all and answers at once.
  const next = await run(() => app.mail("thread", { message_id: "INBOX:1" }));
  assertEquals([ids(next.value.body), next.value.body.partial_reason], [["INBOX:1"], "time_budget"]);
  assertEquals(searchesOf(pool).length, 1);
  // Let the fake's delayed reply timer run out before the test ends.
  await new Promise((resolve) => setTimeout(resolve, 450));
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

// ── Gmail over IMAP (X-GM-EXT-1) ────────────────────────────────────────────

const GM_CAPS = ["IMAP4REV1", "X-GM-EXT-1", "SPECIAL-USE"];
const ALL_MAIL = "[Gmail]/All Mail";
const GM_SENT = "[Gmail]/Sent Mail";

/**
 * A Gmail mailbox as IMAP shows it: one message per label folder, a different
 * UID in each, the same X-GM-MSGID. Thread 77 has four messages (two in the
 * Inbox, one sent, one archived) and a draft; thread 88 shares its subject.
 */
function gmailWorld(): FakeMailbox[] {
  const g = (uid: number, n: number, thread: string, labels: string[], o: Parameters<typeof mail>[1]): FakeMessage => ({
    ...mail(uid, o),
    gmThreadId: thread,
    gmMessageId: String(5000 + n),
    gmLabels: labels,
  });
  const m1 = { id: "g1@example.com", subject: "Roadmap", date: "01 Sep 2026 10:00:00 +0000", seen: true };
  const m2 = { id: "g2@example.com", subject: "Re: Roadmap", from: "<owner@example.com>", to: "<maya@example.com>", date: "02 Sep 2026 10:00:00 +0000", inReplyTo: "g1@example.com", references: ["g1@example.com"], seen: true };
  const m3 = { id: "g3@example.com", subject: "Re: Roadmap", date: "03 Sep 2026 10:00:00 +0000", inReplyTo: "g2@example.com", references: ["g1@example.com", "g2@example.com"] };
  // Archived (no \Inbox), and its headers link to nothing: only Gmail knows it is this thread.
  const m4 = { id: "g4@example.com", subject: "A new subject", date: "04 Sep 2026 10:00:00 +0000", seen: true };
  const draft = { id: "g5@example.com", subject: "Re: Roadmap", from: "<owner@example.com>", date: "05 Sep 2026 10:00:00 +0000", inReplyTo: "g3@example.com", references: ["g1@example.com", "g3@example.com"] };
  const other = { id: "x1@example.com", subject: "Re: Roadmap", from: '"Odd" <odd@example.com>', date: "03 Sep 2026 12:00:00 +0000" };
  return [
    {
      name: "INBOX",
      attrs: ["\\HasNoChildren"],
      messages: [g(11, 1, "77", ["\\Important"], m1), g(13, 3, "77", [], m3), g(14, 9, "88", [], other)],
    },
    {
      name: ALL_MAIL,
      attrs: ["\\HasNoChildren", "\\All"],
      messages: [
        g(101, 1, "77", ["\\Inbox", "\\Important"], m1),
        g(102, 2, "77", ["\\Sent"], m2),
        g(103, 3, "77", ["\\Inbox"], m3),
        g(104, 4, "77", ["Projects"], m4),
        g(105, 5, "77", ["\\Draft"], draft),
        g(106, 9, "88", ["\\Inbox"], other),
      ],
    },
    { name: GM_SENT, attrs: ["\\HasNoChildren", "\\Sent"], messages: [g(31, 2, "77", [], m2)] },
    { name: "[Gmail]", attrs: ["\\Noselect", "\\HasChildren"], messages: [] },
  ];
}

Deno.test("list (Gmail over IMAP): rows carry g:<X-GM-THRID>, fetched in the SAME list FETCH; the hand-over field is not on the row", async () => {
  const { app, pool, run } = await rig({ boxes: gmailWorld(), advertised: GM_CAPS });
  const { value } = await run(() => app.mail("list", { folder: "inbox", limit: 10 }));
  assertEquals(value.status, 200, JSON.stringify(value.body));
  const rows = value.body.messages as Array<Record<string, unknown>>;
  assertEquals(rows.map((r) => [r["id"], r["thread_key"]]), [["INBOX:14", "g:88"], ["INBOX:13", "g:77"], ["INBOX:11", "g:77"]]);
  assert(rows.every((r) => !("gm_thread_id" in r)));
  assertEquals(Object.keys(rows[0]).slice(-5), ["is_flagged", "message_id_header", "in_reply_to", "references", "thread_key"]);
  const fetches = pool.servers[0].commands.filter((c) => /FETCH/.test(c));
  assertEquals(fetches.length, 1, "no extra round trip");
  assert(/^FETCH 1:3 \(UID FLAGS ENVELOPE BODYSTRUCTURE BODY\.PEEK\[1\]<0\.\d+> BODY\.PEEK\[HEADER\.FIELDS \(REFERENCES\)\] X-GM-THRID X-GM-MSGID\)$/.test(fetches[0]), fetches[0]);
  await pool.closeAll();
});

Deno.test("MCP on a Gmail-over-IMAP server: the list FETCH command and the summary keys are unchanged (no X-GM item)", async () => {
  const server = new FakeImapServer({ mailboxes: gmailWorld(), capabilities: GM_CAPS });
  const client = server.client();
  (client as unknown as { capabilities: Set<string> }).capabilities = new Set(GM_CAPS);
  assertEquals(firstPartyContext.getStore(), undefined);
  await client.selectMailbox("INBOX");
  const bySequence = await client.fetchSummariesBySequence(1, 3);
  assertEquals(server.commands.at(-1), "FETCH 1:3 (UID FLAGS ENVELOPE BODYSTRUCTURE BODY.PEEK[1]<0.2048>)");
  const byUid = await client.fetchSummaries([11, 13]);
  assertEquals(server.commands.at(-1), "UID FETCH 11,13 (UID FLAGS ENVELOPE BODYSTRUCTURE BODY.PEEK[1]<0.2048>)");
  // Even a caller that asks for labels gets nothing outside the first-party context.
  await client.fetchSummaries([11], { gmailLabels: true });
  assertEquals(server.commands.at(-1), "UID FETCH 11 (UID FLAGS ENVELOPE BODYSTRUCTURE BODY.PEEK[1]<0.2048>)");
  for (const s of [...bySequence!, ...byUid]) assertEquals(Object.keys(s), ["uid", "flags", "envelope", "hasAttachments", "preview"]);

  // And through the real MCP entry point: the row has the keys it always had.
  const inbox = await imapInbox();
  let mcpServer: FakeImapServer | null = null;
  const viaMcp = await harness.runTool(inbox, noHandler, () =>
    firstPartyContext.run(
      // ONLY the dial is replaced (there is no socket in a test); no first-party option is set.
      { imapConnect: <C>() => {
        mcpServer = new FakeImapServer({ mailboxes: gmailWorld(), capabilities: GM_CAPS });
        const c = mcpServer.client();
        (c as unknown as { capabilities: Set<string> }).capabilities = new Set(GM_CAPS);
        return Promise.resolve(c as unknown as C);
      } },
      () =>
        mcp.handleToolsCall(
          { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "email_read", arguments: { action: "list", inbox_id: INBOX_ID, folder: "inbox", limit: 5 } } },
          1,
          { ...harness.API_KEY, scopes: ["read:email", "search:email"] },
          { ipAddress: null, userAgent: "thread-test" },
        ) as Promise<{ result?: { structuredContent?: { messages: Record<string, unknown>[] } } }>,
    ));
  const mcpRows = viaMcp.value.result!.structuredContent!.messages;
  assertEquals(mcpRows.length, 3);
  for (const key of ["gm_thread_id", "thread_key", "message_id_header", "in_reply_to", "references", "is_flagged"]) assert(!(key in mcpRows[0]), key);
  assertEquals(mcpRows[0]["thread_id"], "14");
  const mcpFetches = mcpServer!.commands.filter((c: string) => /FETCH/.test(c));
  assertEquals(mcpFetches, ["FETCH 1:3 (UID FLAGS ENVELOPE BODYSTRUCTURE BODY.PEEK[1]<0.2048>)"]);
});

Deno.test("thread (Gmail over IMAP): X-GM-THRID decides; one search and one fetch per folder (the anchor's, All Mail); ids the client can act on", async () => {
  const { app, pool, run } = await rig({ boxes: gmailWorld(), advertised: GM_CAPS });
  const { value } = await run(async () => {
    await app.mail("list", { folder: "inbox", limit: 10 });
    return await app.mail("thread", { message_id: "INBOX:13", thread_key: "g:77" });
  });
  assertEquals(value.status, 200, JSON.stringify(value.body));
  const body = value.body;
  assertEquals([body.strategy, body.partial, body.thread_key, body.folders], ["imap_gmail_thrid", false, "g:77", ["INBOX", ALL_MAIL]]);
  // Inbox messages keep their INBOX ids (what the list has, and what an
  // archive must be issued against); the rest carry their All Mail id. The
  // archived message with unrelated headers is IN (Gmail says so); the draft
  // and the same-subject thread 88 are OUT.
  assertEquals(body.messages.map((m: ThreadRowLite) => [m.id, m.folder, m.thread_key]), [
    ["INBOX:11", "INBOX", "g:77"],
    [`${ALL_MAIL}:102`, GM_SENT, "g:77"],
    ["INBOX:13", "INBOX", "g:77"],
    [`${ALL_MAIL}:104`, ALL_MAIL, "g:77"],
  ]);
  assertEquals(body.messages[1].from.email, "owner@example.com");
  assert(body.messages.every((m: ThreadRowLite) => typeof m.preview === "string" && !("gm_thread_id" in m)));

  // Two connections: the list's own (it stays in the Inbox) and the inbox's
  // second pooled one, which does All Mail at the same time and stays there.
  assertEquals(pool.servers.length, 2);
  const commands = pool.servers[0].commands;
  const mine = commands.slice(commands.findIndex((c) => /^FETCH 1:3/.test(c)) + 1);
  const aside = pool.servers[1].commands;
  const shape = (list: string[]) => list.map((c) => c.split(" ")[0] === "UID" ? c.split(" ").slice(0, 2).join(" ") : c.split(" ")[0]);
  assertEquals(shape(mine), ["NOOP", "UID SEARCH", "UID FETCH", "LIST"], "the anchor's folder: ONE search, ONE fetch, no SELECT");
  assertEquals(shape(aside), ["LIST", "SELECT", "UID SEARCH", "UID FETCH"], "All Mail: ONE search, ONE fetch");
  const all = [...mine, ...aside];
  assertEquals(all.filter((c) => /^UID SEARCH/.test(c)), ["UID SEARCH X-GM-THRID 77", "UID SEARCH X-GM-THRID 77"], "by thread id");
  assert(!all.some((c) => /SUBJECT|HEADER (Message-ID|References|In-Reply-To)/.test(c) && /SEARCH/.test(c)), "never a subject or header search");
  const fetches = all.filter((c) => /FETCH/.test(c));
  assertEquals(fetches.map((c) => c.split(" (")[0]), ["UID FETCH 13,11", "UID FETCH 105,104,103,102,101"], "the anchor rides the first");
  assert(fetches.every((c) => / X-GM-THRID X-GM-MSGID X-GM-LABELS\)$/.test(c)));

  // The next conversation: both connections are where they were left. No SELECT at all.
  const before = [commands.length, aside.length];
  const next = await run(() => app.mail("thread", { message_id: "INBOX:14", thread_key: "g:88" }));
  assertEquals([ids(next.value.body), next.value.body.partial], [["INBOX:14"], false]);
  assertEquals(pool.servers.length, 2);
  assertEquals(shape(pool.servers[0].commands.slice(before[0])), ["NOOP", "UID SEARCH", "UID FETCH"]);
  assertEquals(shape(pool.servers[1].commands.slice(before[1])), ["NOOP", "UID SEARCH"], "as many hits as the Inbox had: nothing to fetch");
  await pool.closeAll();
});

interface ThreadRowLite {
  id: string;
  folder: string;
  thread_key: string;
  preview: string;
}

Deno.test("thread (Gmail over IMAP): no key, a wrong key, an anchor in Sent, a thread of one, All Mail hidden", async () => {
  // No key and a wrong key: the anchor's own X-GM-THRID is read (one tiny FETCH) and searched.
  for (const args of [{ message_id: "INBOX:11" }, { message_id: "INBOX:11", thread_key: "g:999" }, { message_id: "INBOX:11", thread_key: "m:g1@example.com" }]) {
    const { app, pool, run } = await rig({ boxes: gmailWorld(), advertised: GM_CAPS });
    const { value } = await run(() => app.mail("thread", args));
    assertEquals([value.status, value.body.thread_key, ids(value.body)], [200, "g:77", ["INBOX:11", `${ALL_MAIL}:102`, "INBOX:13", `${ALL_MAIL}:104`]], JSON.stringify(args));
    const wrong = "thread_key" in args && args.thread_key === "g:999";
    // A wrong key costs one wasted search on each connection; no key costs none.
    // With a `g:` key the two connections are dialled at the same time, and
    // which of them is `servers[0]` is not promised: each connection is
    // checked on its own, whatever its index.
    assertEquals(pool.servers.length, 2, JSON.stringify(args));
    const expected = wrong ? ["UID SEARCH X-GM-THRID 999", "UID SEARCH X-GM-THRID 77"] : ["UID SEARCH X-GM-THRID 77"];
    for (const server of pool.servers) {
      assertEquals(server.commands.filter((c) => /^UID SEARCH/.test(c)), expected, `searches of one connection, ${JSON.stringify(args)}`);
    }
    const idFetches = pool.servers.flatMap((s) => s.commands).filter((c) => c === "UID FETCH 11 (X-GM-THRID X-GM-MSGID)");
    assertEquals(idFetches.length, 1, `the anchor's thread id is read exactly once, on one connection, ${JSON.stringify(args)}`);
    await pool.closeAll();
  }

  // Opened from Sent: the anchor keeps its Sent id; Inbox messages come from All Mail, labelled INBOX.
  const sent = await rig({ boxes: gmailWorld(), advertised: GM_CAPS });
  const fromSent = await sent.run(() => sent.app.mail("thread", { message_id: `${GM_SENT}:31` }));
  assertEquals(fromSent.value.body.messages.map((m: ThreadRowLite) => [m.id, m.folder]), [
    [`${ALL_MAIL}:101`, "INBOX"],
    [`${GM_SENT}:31`, GM_SENT],
    [`${ALL_MAIL}:103`, "INBOX"],
    [`${ALL_MAIL}:104`, ALL_MAIL],
  ]);
  await sent.pool.closeAll();

  // A thread of one: still exact, still no subject search.
  const one = await rig({ boxes: gmailWorld(), advertised: GM_CAPS });
  const single = await one.run(() => one.app.mail("thread", { message_id: "INBOX:14" }));
  assertEquals([ids(single.value.body), single.value.body.partial, single.value.body.strategy], [["INBOX:14"], false, "imap_gmail_thrid"]);
  // All Mail has as many hits as the Inbox did: the same messages, so nothing is fetched there.
  assertEquals(one.pool.servers.flatMap((s) => s.commands).filter((c) => /^UID FETCH/.test(c)).map((c) => c.split(" (")[0]), ["UID FETCH 14", "UID FETCH 14"]);
  await one.pool.closeAll();

  // A long thread: All Mail is asked for ids first, and only the new messages are fetched.
  const longBoxes = gmailWorld();
  for (let i = 0; i < 8; i++) {
    const m = { id: `L${i}@example.com`, subject: "Re: Roadmap", date: `1${i} Sep 2026 10:00:00 +0000`, seen: true };
    longBoxes[0].messages.push({ ...mail(40 + i, m), gmThreadId: "77", gmMessageId: String(6000 + i), gmLabels: [] });
    longBoxes[1].messages.push({ ...mail(140 + i, m), gmThreadId: "77", gmMessageId: String(6000 + i), gmLabels: ["\\Inbox"] });
  }
  const long = await rig({ boxes: longBoxes, advertised: GM_CAPS });
  const longThread = await long.run(() => long.app.mail("thread", { message_id: "INBOX:13", thread_key: "g:77" }));
  assertEquals(longThread.value.body.messages.length, 12, "ten in the Inbox, the sent one, the archived one");
  // The two connections are dialled at the same time: which is `servers[0]`
  // is not promised, so each is recognised by the mailbox it selected.
  assertEquals(long.pool.servers.length, 2, "the anchor's folder and All Mail, one connection each");
  const allMailServer = long.pool.servers.find((s) => s.commands.some((c) => /^SELECT .*All Mail/.test(c)));
  const anchorServer = long.pool.servers.find((s) => s !== allMailServer);
  assert(allMailServer !== undefined && anchorServer !== undefined, "one connection selected All Mail, the other did not");
  const fetchesOf = (s: FakeImapServer) => s.commands.filter((c) => /^UID FETCH/.test(c));
  assertEquals(fetchesOf(anchorServer).length, 1, "the anchor's folder: one fetch");
  const allMailFetches = fetchesOf(allMailServer);
  assertEquals(allMailFetches.length, 2, "All Mail: the id probe, then the new messages");
  assert(/\(X-GM-THRID X-GM-MSGID\)$/.test(allMailFetches[0]), `the first All Mail fetch asks for ids only: ${allMailFetches[0]}`);
  // What the Inbox did not have: the sent one, the archived one, and the draft (fetched, then dropped).
  assertEquals(allMailFetches[1].split(" (")[0], "UID FETCH 105,104,102");
  await long.pool.closeAll();

  // All Mail is not shown in IMAP: the anchor's folder alone, and it says so.
  const hidden = await rig({ boxes: gmailWorld().filter((box) => box.name !== ALL_MAIL), advertised: GM_CAPS });
  const partial = await hidden.run(() => hidden.app.mail("thread", { message_id: "INBOX:13" }));
  assertEquals([ids(partial.value.body), partial.value.body.partial, partial.value.body.partial_reason], [["INBOX:11", "INBOX:13"], true, "folder_error"]);
  await hidden.pool.closeAll();

  // A missing anchor.
  const gone = await rig({ boxes: gmailWorld(), advertised: GM_CAPS });
  const missing = await gone.run(() => gone.app.mail("thread", { message_id: "INBOX:999", thread_key: "g:77" }));
  assertEquals([missing.value.status, missing.value.body.error.code], [404, "not_found"]);
  await gone.pool.closeAll();
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
  assertEquals([value.body.strategy, value.body.partial, value.body.thread_key], ["imap_subject_search", false, "m:root@example.com"]);
  assertEquals(value.body.messages.map((m: { subject: string }) => m.subject), [subject, `Re: ${subject}`, `SV: ${subject}`]);
  assertNoByteStrings(value.body, "thread");

  // The fake records a literal as the quoted text its octets spell.
  const searches = pool.servers[0].commands.filter((c) => /^UID SEARCH/.test(c));
  assertEquals(searches.length, 2, searches.join(" | "));
  for (const command of searches) {
    assertEquals(command, `UID SEARCH CHARSET UTF-8 SINCE 7-Mar-2026 SUBJECT "${subject}"`, "CHARSET named, the subject whole and in its own case");
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
