import { beforeAll, describe, expect, it } from "vitest";
import { type InboxPage, mergeInboxPages } from "./merge";
import { MockMailApi } from "./mock/mock-mail-api";
import { setLatency } from "./mock/latency";
import { FILLER_COUNT, SEED, THREADS, generateFiller } from "./mock/seed";
import {
  type MessageRow,
  type PageCursor,
  allowanceFraction,
  folderRefId,
  formatAllowance,
  isAllowanceExhausted,
  makeKey,
  parseAddressList,
  parseFolderRefId,
  parseKey,
  planDisplayName,
  roleOfFolder,
} from "./types";

beforeAll(() => setLatency({ read: [0, 0], write: [0, 0], failWrites: false }));

const row = (inbox_id: string, id: string, minutesAgo: number): MessageRow => ({
  key: makeKey(inbox_id, id),
  inbox_id,
  id,
  from: { name: "", email: "a@b.c" },
  to: [],
  subject: id,
  date: new Date(Date.UTC(2026, 9, 3, 12, 0) - minutesAgo * 60_000).toISOString(),
  preview: "",
  is_read: true,
  has_attachments: false,
  folder: "INBOX",
  thread_id: id,
  is_starred: false,
  folder_role: "inbox",
});

describe("types helpers", () => {
  it("maps plan slugs to the names they are sold under", () => {
    expect(["free", "personal", "solo", "pro"].map((p) => planDisplayName(p as never))).toEqual(["Free", "Personal", "Pro", "Team"]);
  });

  it("never renders a null cap as a number", () => {
    expect(formatAllowance({ used: 312, cap: 1000 })).toBe("312 / 1,000");
    expect(formatAllowance({ used: 1312, cap: null })).toBe("1,312 used");
    expect(allowanceFraction({ used: 5, cap: null })).toBeNull();
    expect(allowanceFraction({ used: 75, cap: 50 })).toBe(1);
    expect(isAllowanceExhausted({ cap: null, remaining: null })).toBe(false);
    expect(isAllowanceExhausted({ cap: 50, remaining: 0 })).toBe(true);
  });

  it("splits message keys on the first colon only", () => {
    expect(parseKey(makeKey("gmail", "a:b:c"))).toEqual({ inbox_id: "gmail", id: "a:b:c" });
  });

  it("round-trips folder refs through their ids", () => {
    for (const ref of [{ role: "trash" as const }, { name: "Receipts" }, { inbox_id: "imap", folder_id: "INBOX/A:B" }]) {
      expect(parseFolderRefId(folderRefId(ref))).toEqual(ref);
    }
    expect(parseFolderRefId("bogus")).toBeNull();
  });

  it("recognises provider folder names", () => {
    expect(roleOfFolder("INBOX")).toBe("inbox");
    expect(roleOfFolder("[Gmail]/Sent Mail")).toBe("sent");
    expect(roleOfFolder("Deleted Items")).toBe("trash");
    expect(roleOfFolder("Junk Email")).toBe("spam");
    expect(roleOfFolder("Receipts")).toBeNull();
  });

  it("parses address lists", () => {
    expect(parseAddressList('Maya Chen <maya@x.io>, kenji@y.co; "A, B" <ab@z.com>').map((a) => a.email)).toContain("maya@x.io");
    expect(parseAddressList(" ")).toEqual([]);
    expect(parseAddressList("a@b.c")).toEqual([{ name: "", email: "a@b.c" }]);
  });
});

describe("mergeInboxPages", () => {
  // Inbox A has mail every minute, inbox B every 7 minutes.
  const A = Array.from({ length: 23 }, (_, i) => row("a", `a${i}`, i));
  const B = Array.from({ length: 9 }, (_, i) => row("b", `b${i}`, i * 7 + 0.5));
  const source: Record<string, MessageRow[]> = { a: A, b: B };
  const fetch = async (inbox_id: string, offset: number, limit: number): Promise<InboxPage> => {
    const all = source[inbox_id] ?? [];
    return { inbox_id, rows: all.slice(offset, offset + limit), total: all.length, has_more: offset + limit < all.length };
  };

  it("yields every row exactly once, newest first, across pages", async () => {
    const seen: MessageRow[] = [];
    let cursor: PageCursor | null = null;
    let pages = 0;
    do {
      const page = await mergeInboxPages(["a", "b"], cursor, 5, fetch);
      seen.push(...page.rows);
      cursor = page.next_cursor;
      expect(page.has_more).toBe(cursor != null);
      if (++pages > 50) throw new Error("did not terminate");
    } while (cursor);

    expect(seen).toHaveLength(A.length + B.length);
    expect(new Set(seen.map((r) => r.key)).size).toBe(seen.length);
    const dates = seen.map((r) => r.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it("holds back rows older than what another inbox may still have", async () => {
    const page = await mergeInboxPages(["a", "b"], null, 5, fetch);
    // A's 5th row is 4 minutes old; B's rows older than that must wait.
    expect(page.rows.every((r) => r.date >= (A[4] as MessageRow).date)).toBe(true);
    expect(page.next_cursor).toEqual({ a: 5, b: 1 });
  });

  it("sums totals, and reports null when any inbox cannot count", async () => {
    expect((await mergeInboxPages(["a", "b"], null, 5, fetch)).total).toBe(32);
    const page = await mergeInboxPages(["a", "b"], null, 5, async (id, o, l) => ({ ...(await fetch(id, o, l)), total: id === "b" ? null : 23 }));
    expect(page.total).toBeNull();
  });
});

describe("MockMailApi", () => {
  it("generates deterministic filler", () => {
    const a = generateFiller();
    expect(a).toHaveLength(FILLER_COUNT);
    expect(generateFiller()).toEqual(a);
  });

  it("seeds three inboxes for pro and one for first run", async () => {
    expect((await new MockMailApi("pro").listInboxes()).map((i) => i.inbox_id)).toEqual(["gmail", "outlook", "imap"]);
    const first = new MockMailApi("first");
    expect((await first.listInboxes()).map((i) => i.email_address)).toEqual(["jordan@gmail.com"]);
    expect(first.getMessage("gmail:maya")?.subject).toContain("Q4 renewal");
  });

  it("computes real ISO dates from the prototype's minutes-ago", () => {
    const now = Date.UTC(2026, 9, 3, 9, 52);
    const api = new MockMailApi("pro", now);
    expect(api.getMessage("outlook:maya")?.date).toBe(new Date(now - 11 * 60_000).toISOString());
  });

  it("keeps assistant hints off the wire types, in a side table", async () => {
    const api = new MockMailApi("pro");
    expect(api.getHints("outlook:maya")?.ask).toBe("Confirm the Thursday 2pm call");
    expect(api.getHints("gmail:stripe")).toMatchObject({ receipt: true, amount: 96 });
    const page = await api.listMessages({ scope: "all", folder: { role: "inbox" }, limit: 5 });
    expect(Object.keys(page.rows[0] ?? {})).not.toContain("ask");
    const detail = await api.readMessage("outlook", "maya", { include_html: false });
    expect(Object.keys(detail)).not.toContain("reply");
  });

  it("pages the unified inbox through every message once", async () => {
    const api = new MockMailApi("pro");
    const expected = [...SEED, ...THREADS].filter((e) => e.folder === "inbox").length + FILLER_COUNT;
    const keys: string[] = [];
    let cursor: PageCursor | null = null;
    let first = true;
    do {
      const page = await api.listMessages({ scope: "all", folder: { role: "inbox" }, limit: 50, cursor });
      if (first) expect(page.total).toBe(expected);
      first = false;
      keys.push(...page.rows.map((r) => r.key));
      cursor = page.next_cursor;
    } while (cursor);
    expect(keys).toHaveLength(expected);
    expect(new Set(keys).size).toBe(expected);
    expect(keys[0]).toBe("outlook:maya");
  });

  it("does not mark a message read when it is read", async () => {
    const api = new MockMailApi("pro");
    await api.readMessage("outlook", "maya", { include_html: true });
    expect(api.getMessage("outlook:maya")?.is_read).toBe(false);
    await api.setFlags(["outlook:maya"], { read: true, starred: true });
    expect(api.getMessage("outlook:maya")).toMatchObject({ is_read: true, is_starred: true });
  });

  it("lists starred as a flagged search and custom folders by name", async () => {
    const api = new MockMailApi("pro");
    await api.setFlags(["gmail:delta"], { starred: true });
    const starred = await api.listMessages({ scope: "all", folder: { role: "starred" }, limit: 10 });
    expect(starred.rows.map((r) => r.key)).toEqual(["gmail:delta"]);
    const receipts = await api.listMessages({ scope: "all", folder: { name: "Receipts" }, limit: 10 });
    expect(receipts.rows.map((r) => r.key)).toEqual(["gmail:uber"]);
  });

  it("moves, archives and trashes, reporting the keys messages have afterwards", async () => {
    const api = new MockMailApi("pro");
    const res = await api.moveMessages(["outlook:aws", "gmail:stripe"], { name: "Receipts" });
    expect(res.moved).toEqual([
      { key: "outlook:aws", new_key: "outlook:aws" },
      { key: "gmail:stripe", new_key: "gmail:stripe" },
    ]);
    expect(api.getMessage("outlook:aws")?.folder).toBe("Receipts");
    await api.archiveMessages(["gmail:delta"]);
    expect(api.toRow(api.getMessage("gmail:delta")!).folder_role).toBe("archive");
    await api.deleteMessages(["gmail:delta"]);
    expect(api.toRow(api.getMessage("gmail:delta")!).folder_role).toBe("trash");
    await api.deleteMessages(["gmail:delta"], { permanent: true });
    expect(api.getMessage("gmail:delta")).toBeUndefined();
  });

  it("refuses to move a message into another inbox's folder", async () => {
    const api = new MockMailApi("pro");
    await expect(api.moveMessages(["outlook:aws"], { inbox_id: "gmail", folder_id: "Receipts" })).rejects.toThrow("folder_not_found");
  });

  it("changes the draft id on update for IMAP only", async () => {
    const api = new MockMailApi("pro");
    const input = { to: [{ name: "", email: "a@b.c" }], subject: "Hi", body_text: "one" };
    const imap = await api.createDraft({ ...input, inbox_id: "imap" });
    const imap2 = await api.updateDraft("imap", imap.draft_id, { ...input, inbox_id: "imap", body_text: "two" });
    expect(imap2.draft_id).not.toBe(imap.draft_id);
    await expect(api.readDraft("imap", imap.draft_id)).rejects.toThrow("draft_not_found");
    expect((await api.readDraft("imap", imap2.draft_id)).body_text).toBe("two");

    const gmail = await api.createDraft({ ...input, inbox_id: "gmail" });
    expect((await api.updateDraft("gmail", gmail.draft_id, { ...input, inbox_id: "gmail" })).draft_id).toBe(gmail.draft_id);
    // Draft list rows carry no body.
    expect(Object.keys((await api.listDrafts("gmail"))[0] ?? {})).not.toContain("body_text");
  });

  it("lists scheduled sends with plain-string recipients", async () => {
    const api = new MockMailApi("pro");
    const s = await api.scheduleSend({
      inbox_id: "gmail",
      to: [{ name: "K", email: "k@x.co" }],
      subject: "Later",
      body_text: "…",
      send_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect((await api.listScheduled())[0]?.to).toEqual(["k@x.co"]);
    const rows = await api.listMessages({ scope: "all", folder: { role: "scheduled" }, limit: 10 });
    expect(rows.rows[0]).toMatchObject({ id: s.id, folder_role: "scheduled" });
    await api.cancelScheduled("gmail", s.id);
    expect(await api.listScheduled()).toEqual([]);
  });

  it("reports a null total for IMAP search", async () => {
    const api = new MockMailApi("pro");
    expect((await api.searchMessages({ scope: "imap", query: "coffee", limit: 10 })).total).toBeNull();
    const all = await api.searchMessages({ scope: "all", query: "maya", limit: 10 });
    expect(all.rows.some((r) => r.key === "outlook:maya")).toBe(true);
  });

  it("emits new_mail from the simulator and aborts reads", async () => {
    const api = new MockMailApi("pro");
    const events: string[] = [];
    const off = api.subscribe((e) => events.push(e.type));
    const rows = api.simulateIncoming();
    expect(rows[0]).toMatchObject({ inbox_id: "outlook", is_read: false, folder_role: "inbox" });
    expect(events).toEqual(["new_mail"]);
    off();
    api.simulateIncoming();
    expect(events).toHaveLength(1);

    setLatency({ read: [50, 50] });
    const c = new AbortController();
    const p = api.listInboxes(c.signal);
    c.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    setLatency({ read: [0, 0] });
  });

  it("rejects writes when asked to fail", async () => {
    const api = new MockMailApi("pro");
    setLatency({ failWrites: true });
    await expect(api.archiveMessages(["gmail:delta"])).rejects.toThrow();
    expect(api.toRow(api.getMessage("gmail:delta")!).folder_role).toBe("inbox");
    setLatency({ failWrites: false });
  });
});

describe("MockMailApi: conversations", () => {
  it("seeds conversations in every mailbox, keyed the way each provider's server keys them", async () => {
    const api = new MockMailApi("pro");
    const key = (inbox: string, id: string) => api.toRow(api.getMessage(`${inbox}:${id}`)!).thread_key;
    // Outlook: the conversation id. Gmail: the thread id. IMAP: the root Message-ID.
    expect([key("outlook", "limits-1"), key("outlook", "limits-3")]).toEqual(["o:t-limits-1", "o:t-limits-1"]);
    expect([key("gmail", "gh-1"), key("gmail", "gh-3")]).toEqual(["g:t-gh-1", "g:t-gh-1"]);
    expect([key("imap", "dana-1"), key("imap", "dana-4")]).toEqual(["m:dana-1@mock.mail", "m:dana-1@mock.mail"]);
    const reply = api.toRow(api.getMessage("imap:dana-3")!);
    expect([reply.in_reply_to, reply.references]).toEqual(["dana-2@mock.mail", ["dana-1@mock.mail", "dana-2@mock.mail"]]);
    // Everything else is a conversation of one.
    expect(key("outlook", "maya")).toBe("o:t-maya");
  });

  it("getThread returns the conversation across Inbox and Sent, oldest first; a sent reply joins it", async () => {
    const api = new MockMailApi("pro");
    const thread = await api.getThread("imap:dana-3");
    expect(thread.rows.map((r) => [r.id, r.folder])).toEqual([
      ["dana-1", "INBOX"],
      ["dana-2", "Sent"],
      ["dana-3", "INBOX"],
      ["dana-4", "Sent"],
    ]);
    expect([thread.thread_key, thread.partial]).toEqual(["m:dana-1@mock.mail", false]);
    // Only two of the four are in the inbox list.
    const inbox = await api.listMessages({ scope: "imap", folder: { role: "inbox" }, limit: 50 });
    expect(inbox.rows.filter((r) => r.thread_key === thread.thread_key).map((r) => r.id)).toEqual(["dana-3", "dana-1"]);

    await api.replyToMessage({ key: "imap:dana-3", body_text: "Signed." });
    const after = await api.getThread("imap:dana-1");
    expect(after.rows).toHaveLength(5);
    const sent = after.rows[4]!;
    expect([sent.folder, sent.thread_key, sent.in_reply_to]).toEqual(["Sent", "m:dana-1@mock.mail", "dana-3@mock.mail"]);
    // A trashed message leaves the thread.
    await api.deleteMessages(["imap:dana-1"]);
    expect((await api.getThread("imap:dana-3")).rows.map((r) => r.id)).not.toContain("dana-1");
  });
});
