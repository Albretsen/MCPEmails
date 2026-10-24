// ---------------------------------------------------------------------------
// subscription-scan.ts and ImapClient.fetchHeaderFields: reading list headers
// from each provider's responses, and the limit / budget / junk rules.
//
// IMAP runs the real ImapClient over a scripted wire (the test writes the
// server's octets); Gmail and Graph run against a fake fetch. No real mailbox
// data: every address is under example.com / example.org.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createWorkBudget, type WorkBudget } from "./bulk-budget.ts";
import { ImapClient, parseHeaderFieldsFetchLine, parseInternalDate } from "./imap-client.ts";
import { type ScriptedCommand, ScriptedWire } from "./imap-scripted-wire.ts";
import { groupSenders } from "./list-unsubscribe.ts";
import {
  applyGraphHeaders,
  fetchListHeaderRecords,
  headerMapOfPairs,
  imapSinceCriteria,
  LIST_HEADER_FIELDS,
  recordFromGmailMessage,
  recordFromGraphListMessage,
} from "./subscription-scan.ts";

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
const CRLF = "\r\n";

function budget(): WorkBudget {
  return createWorkBudget(25_000, () => NOW);
}

/** A budget that is spent from its first check on. */
function spent(): WorkBudget {
  let started = false;
  return createWorkBudget(25_000, () => {
    if (started) return NOW + 60_000;
    started = true;
    return NOW;
  });
}

const HEADER_BLOCK = [
  'From: "=?UTF-8?Q?Example_News?=" <news@example.com>',
  "List-Id: Weekly news <weekly.example.com>",
  "List-Unsubscribe: <https://example.com/u/1>,",
  " <mailto:unsub@example.com?subject=unsubscribe>",
  "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
  "DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=s1;",
  "\th=from:list-unsubscribe:list-unsubscribe-post; bh=x; b=y",
  "DKIM-Signature: v=1; a=rsa-sha256; d=esp.example.org; s=s2; h=from; bh=x; b=y",
  "Authentication-Results: mx.example.net; dkim=pass header.d=example.com",
  "Authentication-Results: mx.example.org; dkim=fail header.d=example.com",
  "",
  "",
].join(CRLF);

// ── IMAP parsing ────────────────────────────────────────────────────────────

Deno.test("parseInternalDate: RFC 3501 date-time with offset, padded day", () => {
  assertEquals(parseInternalDate("17-Jul-1996 02:44:25 -0700"), "1996-07-17T09:44:25.000Z");
  assertEquals(parseInternalDate(" 7-Oct-2026 10:00:00 +0200"), "2026-10-07T08:00:00.000Z");
  assertEquals(parseInternalDate("garbage"), null);
});

Deno.test("parseHeaderFieldsFetchLine: items in any order, quoted header value", () => {
  const line = `* 3 FETCH (BODY[HEADER.FIELDS (FROM LIST-ID)] "From: a@example.com\\r\\n" ` +
    `INTERNALDATE "01-Oct-2026 10:00:00 +0000" FLAGS (\\Seen \\Flagged) UID 42)`;
  const row = parseHeaderFieldsFetchLine(line.replace(/\\r\\n/g, "\r\n"));
  assert(row);
  assertEquals(row.uid, 42);
  assertEquals(row.flags, ["\\Seen", "\\Flagged"]);
  assertEquals(row.internalDate, "2026-10-01T10:00:00.000Z");
  assert(row.headers.startsWith("From: a@example.com"));
});

Deno.test("parseHeaderFieldsFetchLine: no UID is null, NIL body is empty", () => {
  assertEquals(parseHeaderFieldsFetchLine("* 1 FETCH (FLAGS ())"), null);
  const row = parseHeaderFieldsFetchLine('* 1 FETCH (UID 5 FLAGS () BODY[HEADER.FIELDS (FROM)] NIL)');
  assertEquals(row?.headers, "");
  assertEquals(row?.internalDate, null);
});

function imapServer(opts: {
  mailboxes: Record<string, Array<{ uid: number; seen?: boolean; date?: string; headers?: string }>>;
  noJunk?: boolean;
}): ScriptedWire {
  let selected = "";
  return new ScriptedWire((command: ScriptedCommand) => {
    const { tag, text } = command;
    if (text.startsWith("SELECT ") || text.startsWith("EXAMINE ")) {
      const name = /"(.*)"/.exec(text)?.[1] ?? "";
      if (!(name in opts.mailboxes)) return `${tag} NO [NONEXISTENT] Unknown Mailbox${CRLF}`;
      selected = name;
      return `* ${opts.mailboxes[name].length} EXISTS${CRLF}${tag} OK [READ-WRITE] SELECT completed${CRLF}`;
    }
    if (text.startsWith("UID SEARCH ")) {
      const uids = opts.mailboxes[selected].map((m) => m.uid).join(" ");
      return `* SEARCH ${uids}${CRLF}${tag} OK SEARCH completed${CRLF}`;
    }
    if (text.startsWith("UID FETCH ")) {
      const set = text.split(" ")[2];
      const wanted = new Set<number>();
      for (const part of set.split(",")) {
        const [a, b] = part.split(":").map(Number);
        for (let u = a; u <= (b ?? a); u++) wanted.add(u);
      }
      let out = "";
      opts.mailboxes[selected].filter((m) => wanted.has(m.uid)).forEach((m, i) => {
        const headers = m.headers ?? HEADER_BLOCK;
        out += `* ${i + 1} FETCH (UID ${m.uid} FLAGS (${m.seen ? "\\Seen" : ""}) INTERNALDATE "${
          m.date ?? "20-Oct-2026 08:00:00 +0000"
        }" BODY[HEADER.FIELDS (FROM LIST-ID)] {${headers.length}}${CRLF}${headers})${CRLF}`;
      });
      return `${out}${tag} OK FETCH completed${CRLF}`;
    }
    return `${tag} BAD unexpected${CRLF}`;
  });
}

Deno.test("ImapClient.fetchHeaderFields: PEEK command and literal header block", async () => {
  const wire = imapServer({ mailboxes: { INBOX: [{ uid: 7, seen: true }, { uid: 9 }] } });
  const client = wire.client<ImapClient>(ImapClient);
  await client.selectMailbox("INBOX");
  const rows = await client.fetchHeaderFields([9, 7, 8], LIST_HEADER_FIELDS);
  const fetch = wire.commands.find((c) => c.text.startsWith("UID FETCH"));
  assertEquals(
    fetch?.text,
    "UID FETCH 7:9 (UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM LIST-ID LIST-UNSUBSCRIBE " +
      "LIST-UNSUBSCRIBE-POST DKIM-SIGNATURE AUTHENTICATION-RESULTS)])",
  );
  assertEquals(rows.map((r) => [r.uid, r.flags]), [[7, ["\\Seen"]], [9, []]]);
  assertEquals(rows[0].headers, HEADER_BLOCK);
});

Deno.test("ImapClient.fetchHeaderFields: refuses a field name that could inject", async () => {
  const wire = imapServer({ mailboxes: { INBOX: [] } });
  const client = wire.client<ImapClient>(ImapClient);
  await assertRejects(() => client.fetchHeaderFields([1], ["From)] UID STORE"]), Error, "invalid field name");
  assertEquals(wire.commands.length, 0);
});

function imapCtx(wire: ScriptedWire, junkFolder: string | null, b: WorkBudget = budget()) {
  const client = wire.client<ImapClient>(ImapClient);
  return {
    provider: "imap" as const,
    budget: b,
    now: () => NOW,
    junkFolder,
    select: async (folder: string) => {
      await client.selectMailbox(folder);
      return client;
    },
  };
}

Deno.test("IMAP scan: inbox and junk, ids, flags, all header instances", async () => {
  const wire = imapServer({
    mailboxes: { INBOX: [{ uid: 1, seen: true }, { uid: 2 }], Junk: [{ uid: 5 }] },
  });
  const result = await fetchListHeaderRecords(imapCtx(wire, "Junk"), { days: 90, limit: 2000 });
  assertEquals(result.scanned, 3);
  assertEquals(result.truncated, false);
  assertEquals(result.records.map((r) => [r.messageId, r.folder, r.seen, r.inJunk]), [
    ["INBOX:1", "INBOX", true, false],
    ["INBOX:2", "INBOX", false, false],
    ["Junk:5", "Junk", false, true],
  ]);
  const r = result.records[0];
  assertEquals(r.fromAddress, "news@example.com");
  assertEquals(r.fromName, "Example News");
  assertEquals(r.listId, "weekly.example.com");
  assertEquals(r.listUnsubscribe, "<https://example.com/u/1>, <mailto:unsub@example.com?subject=unsubscribe>");
  assertEquals(r.listUnsubscribePost, "List-Unsubscribe=One-Click");
  assertEquals(r.dkimSignatures.length, 2);
  assertEquals(r.authResults.length, 2);
  assertEquals(r.receivedAt, "2026-10-20T08:00:00.000Z");
  const search = wire.commands.find((c) => c.text.startsWith("UID SEARCH"));
  assertEquals(search?.text, "UID SEARCH SINCE 26-Jul-2026");
  // And the records classify end to end.
  const [candidate] = groupSenders(result.records);
  assertEquals(candidate.method, "one_click");
  assertEquals(candidate.messageCount, 3);
});

Deno.test("IMAP scan: newest UIDs first under the limit, truncated", async () => {
  const wire = imapServer({ mailboxes: { INBOX: [{ uid: 1 }, { uid: 2 }, { uid: 3 }], Junk: [{ uid: 9 }] } });
  const result = await fetchListHeaderRecords(imapCtx(wire, "Junk"), { days: 30, limit: 2 });
  assertEquals(result.records.map((r) => r.messageId), ["INBOX:2", "INBOX:3"]);
  assertEquals(result.truncated, true);
  // The limit was spent on the inbox; Junk is never selected.
  assert(!wire.commands.some((c) => c.text.includes('"Junk"')));
});

Deno.test("IMAP scan: messages before the window (by INTERNALDATE) are dropped", async () => {
  const wire = imapServer({
    mailboxes: { INBOX: [{ uid: 1, date: "01-Jan-2026 08:00:00 +0000" }, { uid: 2 }] },
  });
  const result = await fetchListHeaderRecords(imapCtx(wire, null), { days: 30, limit: 100 });
  assertEquals(result.records.map((r) => r.messageId), ["INBOX:2"]);
});

Deno.test("IMAP scan: a Junk folder the server refuses is skipped", async () => {
  const wire = imapServer({ mailboxes: { INBOX: [{ uid: 1 }] } });
  const result = await fetchListHeaderRecords(imapCtx(wire, "Junk"), { days: 30, limit: 100 });
  assertEquals(result.records.length, 1);
});

Deno.test("IMAP scan: a spent budget stops before fetching and reports truncated", async () => {
  const wire = imapServer({ mailboxes: { INBOX: [{ uid: 1 }] } });
  const result = await fetchListHeaderRecords(imapCtx(wire, null, spent()), { days: 30, limit: 100 });
  assertEquals(result.records, []);
  assertEquals(result.truncated, true);
});

Deno.test("imapSinceCriteria: UTC date", () => {
  assertEquals(imapSinceCriteria(Date.UTC(2026, 0, 5, 23, 59)), "SINCE 5-Jan-2026");
});

// ── Gmail ───────────────────────────────────────────────────────────────────

function gmailMessage(id: string, labels: string[], extra: Array<{ name: string; value: string }> = []) {
  return {
    id,
    labelIds: labels,
    internalDate: String(Date.UTC(2026, 9, 20)),
    payload: {
      headers: [
        { name: "From", value: "Example News <news@example.com>" },
        { name: "List-Id", value: "<weekly.example.com>" },
        { name: "List-Unsubscribe", value: "<https://example.com/u/1>" },
        { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
        { name: "DKIM-Signature", value: "v=1; d=example.com; h=list-unsubscribe:list-unsubscribe-post; b=x" },
        { name: "DKIM-Signature", value: "v=1; d=esp.example.org; h=from; b=x" },
        { name: "Authentication-Results", value: "mx.google.com; dkim=pass header.i=@example.com" },
        ...extra,
      ],
    },
  };
}

Deno.test("recordFromGmailMessage: labels, repeated headers, decoded names kept", () => {
  const r = recordFromGmailMessage(gmailMessage("m1", ["INBOX", "UNREAD"]));
  assert(r);
  assertEquals(r.messageId, "m1");
  assertEquals(r.folder, "INBOX");
  assertEquals(r.seen, false);
  assertEquals(r.inJunk, false);
  assertEquals(r.dkimSignatures.length, 2);
  assertEquals(r.receivedAt, "2026-10-20T00:00:00.000Z");
  const spam = recordFromGmailMessage(gmailMessage("m2", ["SPAM"]));
  assertEquals([spam?.folder, spam?.inJunk, spam?.seen], ["SPAM", true, true]);
  assertEquals(recordFromGmailMessage({}), null);
});

function fakeGmail(opts: { inbox: string[]; spam: string[]; failIds?: Record<string, number>; pageSize?: number }) {
  const calls: string[] = [];
  const fetchFn = (path: string): Promise<Response> => {
    calls.push(path);
    const url = new URL(`https://x${path}`);
    if (url.pathname === "/messages") {
      const label = url.searchParams.get("labelIds");
      const ids = label === "SPAM" ? opts.spam : opts.inbox;
      const size = Number(url.searchParams.get("maxResults"));
      const start = Number(url.searchParams.get("pageToken") ?? "0");
      const page = ids.slice(start, start + Math.min(size, opts.pageSize ?? 500));
      const next = start + page.length < ids.length ? String(start + page.length) : undefined;
      return Promise.resolve(Response.json({ messages: page.map((id) => ({ id, threadId: id })), nextPageToken: next }));
    }
    const id = decodeURIComponent(url.pathname.split("/")[2]);
    const status = opts.failIds?.[id];
    if (status) return Promise.resolve(new Response("{}", { status }));
    return Promise.resolve(Response.json(gmailMessage(id, opts.spam.includes(id) ? ["SPAM"] : ["INBOX"])));
  };
  return { calls, fetchFn };
}

Deno.test("Gmail scan: list INBOX and SPAM after the window, metadata headers asked for", async () => {
  const g = fakeGmail({ inbox: ["a", "b"], spam: ["s"] });
  const result = await fetchListHeaderRecords(
    { provider: "gmail", budget: budget(), now: () => NOW, fetch: g.fetchFn },
    { days: 90, limit: 2000 },
  );
  assertEquals(result.records.map((r) => [r.messageId, r.inJunk]), [["a", false], ["b", false], ["s", true]]);
  assertEquals(result.truncated, false);
  assertEquals(result.scanned, 3);
  const list = new URL(`https://x${g.calls[0]}`);
  assertEquals(list.searchParams.get("q"), `after:${Math.floor((NOW - 90 * 86_400_000) / 1000)}`);
  const spamList = new URL(`https://x${g.calls[1]}`);
  assertEquals(spamList.searchParams.get("includeSpamTrash"), "true");
  const meta = new URL(`https://x${g.calls[2]}`);
  assertEquals(meta.searchParams.get("format"), "metadata");
  assertEquals(meta.searchParams.getAll("metadataHeaders"), [...LIST_HEADER_FIELDS]);
});

Deno.test("Gmail scan: limit across pages truncates", async () => {
  const g = fakeGmail({ inbox: ["a", "b", "c", "d"], spam: [], pageSize: 2 });
  const result = await fetchListHeaderRecords(
    { provider: "gmail", budget: budget(), now: () => NOW, fetch: g.fetchFn },
    { days: 90, limit: 3 },
  );
  assertEquals(result.records.map((r) => r.messageId), ["a", "b", "c"]);
  assertEquals(result.truncated, true);
});

Deno.test("Gmail scan: 404 skipped, 429 stops and truncates, 401 throws", async () => {
  const g = fakeGmail({ inbox: ["a", "gone"], spam: [], failIds: { gone: 404 } });
  const ok = await fetchListHeaderRecords(
    { provider: "gmail", budget: budget(), now: () => NOW, fetch: g.fetchFn },
    { days: 90, limit: 10 },
  );
  assertEquals([ok.records.length, ok.truncated], [1, false]);

  const limited = fakeGmail({ inbox: ["a", "b"], spam: [], failIds: { a: 429 } });
  const r = await fetchListHeaderRecords(
    { provider: "gmail", budget: budget(), now: () => NOW, fetch: limited.fetchFn },
    { days: 90, limit: 10 },
  );
  assertEquals(r.truncated, true);

  const auth = fakeGmail({ inbox: ["a"], spam: [], failIds: { a: 401 } });
  await assertRejects(
    () => fetchListHeaderRecords({ provider: "gmail", budget: budget(), now: () => NOW, fetch: auth.fetchFn }, { days: 90, limit: 10 }),
    Error,
    "gmail_auth_failed",
  );
});

// ── Outlook ─────────────────────────────────────────────────────────────────

const GRAPH_HEADERS = [
  { name: "From", value: "news@example.com" },
  { name: "List-Id", value: "Weekly <weekly.example.com>" },
  { name: "List-Unsubscribe", value: "<https://example.com/u/1>, <mailto:u@example.com>" },
  { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
  { name: "DKIM-Signature", value: "v=1; d=example.com; h=List-Unsubscribe:List-Unsubscribe-Post; b=x" },
  { name: "Authentication-Results", value: "spf=pass smtp.mailfrom=example.com; dkim=pass (signature was verified) header.d=example.com" },
  { name: "Authentication-Results", value: "mx.example.org; dkim=fail header.d=example.com" },
];

Deno.test("headerMapOfPairs and applyGraphHeaders: order and repeats kept", () => {
  const map = headerMapOfPairs(GRAPH_HEADERS);
  assertEquals(map.get("authentication-results")?.length, 2);
  const r = recordFromGraphListMessage(
    { id: "g1", from: { emailAddress: { name: "Example News", address: "news@example.com" } }, receivedDateTime: "2026-10-20T08:00:00Z", isRead: false },
    "INBOX",
    false,
  );
  assert(r);
  applyGraphHeaders(r, GRAPH_HEADERS);
  assertEquals(r.listId, "weekly.example.com");
  assertEquals(r.dkimSignatures.length, 1);
  assertEquals(r.authResults[0].startsWith("spf=pass"), true);
  assertEquals(recordFromGraphListMessage({ id: "x" }, "INBOX", false), null);
});

function fakeGraph(opts: {
  inbox: Array<{ id: string; from: string; at: string; isRead?: boolean }>;
  junk?: Array<{ id: string; from: string; at: string }> | null;
  headerStatus?: Record<string, number>;
}) {
  const calls: string[] = [];
  const fetchFn = (pathOrUrl: string): Promise<Response> => {
    calls.push(pathOrUrl);
    const m = /^\/me\/mailFolders\/([^/]+)\/messages/.exec(pathOrUrl);
    if (m) {
      const list = m[1] === "junkemail" ? opts.junk : opts.inbox;
      if (list === null) return Promise.resolve(new Response('{"error":{"code":"ErrorItemNotFound"}}', { status: 404 }));
      return Promise.resolve(Response.json({
        value: (list ?? []).map((x) => ({ id: x.id, from: { emailAddress: { name: "N", address: x.from } }, receivedDateTime: x.at, isRead: "isRead" in x ? x.isRead : false })),
      }));
    }
    const id = decodeURIComponent(/^\/me\/messages\/([^?]+)/.exec(pathOrUrl)?.[1] ?? "");
    const status = opts.headerStatus?.[id];
    if (status) return Promise.resolve(new Response("{}", { status }));
    // Only the news sender is a list; everyone else sends plain mail.
    const headers = id.startsWith("n") ? GRAPH_HEADERS : [{ name: "From", value: "someone@example.org" }];
    return Promise.resolve(Response.json({ id, internetMessageHeaders: headers }));
  };
  return { calls, fetchFn };
}

Deno.test("Outlook scan: headers fetched once per sender, list id propagated", async () => {
  const g = fakeGraph({
    inbox: [
      { id: "n3", from: "news@example.com", at: "2026-10-22T08:00:00Z" },
      { id: "n2", from: "News@Example.com", at: "2026-10-21T08:00:00Z" },
      { id: "o1", from: "other@example.org", at: "2026-10-20T08:00:00Z" },
      { id: "n1", from: "news@example.com", at: "2026-10-19T08:00:00Z" },
    ],
    junk: [{ id: "j1", from: "news@example.com", at: "2026-10-23T08:00:00Z" }],
  });
  const result = await fetchListHeaderRecords(
    { provider: "outlook", budget: budget(), now: () => NOW, fetch: g.fetchFn },
    { days: 90, limit: 2000 },
  );
  assertEquals(result.scanned, 5);
  assertEquals(result.truncated, false);
  const headerGets = g.calls.filter((c) => c.startsWith("/me/messages/"));
  // One per distinct sender; the inbox copy wins over the newer Junk one.
  assertEquals(headerGets.sort(), [
    "/me/messages/n3?$select=internetMessageHeaders",
    "/me/messages/o1?$select=internetMessageHeaders",
  ]);
  const list = new URL(`https://x${g.calls[0]}`);
  assertEquals(list.searchParams.get("$filter"), "receivedDateTime ge 2026-07-26T12:00:00Z");
  assertEquals(list.searchParams.get("$orderby"), "receivedDateTime desc");
  const byId = new Map(result.records.map((r) => [r.messageId, r]));
  assertEquals(byId.get("n3")?.listUnsubscribe?.startsWith("<https://"), true);
  assertEquals(byId.get("n3")?.headersInferred, undefined);
  assertEquals(byId.get("n1")?.listId, "weekly.example.com");
  assertEquals(byId.get("n1")?.headersInferred, true);
  assertEquals(byId.get("n1")?.listUnsubscribe, null);
  assertEquals(byId.get("j1")?.inJunk, true);
  // Grouping keeps the news sender together under its list id.
  const groups = groupSenders(result.records);
  const news = groups.find((c) => c.senderKey === "list:weekly.example.com");
  assert(news);
  assertEquals(news.messageCount, 4);
  assertEquals(news.method, "one_click");
});

Deno.test("Outlook scan: header get cap truncates, 404 junk folder is fine", async () => {
  const g = fakeGraph({
    inbox: [
      { id: "a", from: "a@example.com", at: "2026-10-22T08:00:00Z" },
      { id: "b", from: "b@example.com", at: "2026-10-21T08:00:00Z" },
      { id: "c", from: "b@example.com", at: "2026-10-20T08:00:00Z" },
    ],
    junk: null,
  });
  const result = await fetchListHeaderRecords(
    { provider: "outlook", budget: budget(), now: () => NOW, fetch: g.fetchFn, maxHeaderGets: 1 },
    { days: 90, limit: 2000 },
  );
  assertEquals(result.truncated, true);
  // The sender with the most mail is the one that got its headers.
  assertEquals(g.calls.filter((c) => c.startsWith("/me/messages/")), ["/me/messages/b?$select=internetMessageHeaders"]);
});

Deno.test("Outlook scan: a failing header get truncates, a list error throws", async () => {
  const g = fakeGraph({ inbox: [{ id: "a", from: "a@example.com", at: "2026-10-22T08:00:00Z" }], junk: [], headerStatus: { a: 503 } });
  const result = await fetchListHeaderRecords(
    { provider: "outlook", budget: budget(), now: () => NOW, fetch: g.fetchFn },
    { days: 90, limit: 10 },
  );
  assertEquals(result.truncated, true);
  assertEquals(result.records[0].listUnsubscribe, null);

  const broken = (_: string) => Promise.resolve(new Response('{"error":{"code":"ErrorAccessDenied","message":"no"}}', { status: 403 }));
  await assertRejects(() =>
    fetchListHeaderRecords({ provider: "outlook", budget: budget(), now: () => NOW, fetch: broken }, { days: 90, limit: 10 })
  );
});
