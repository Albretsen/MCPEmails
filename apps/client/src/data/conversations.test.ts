import { describe, expect, it } from "vitest";
import { type MessageKey, type MessageRow, makeKey } from "../api/types";
import { ConversationGrouper, linkTokens, mergeThread, participantNames } from "./conversations";

let clock = 0;

/** A header-keyed (IMAP-style) row. Later calls are OLDER unless `date` is given. */
function row(id: string, o: Partial<MessageRow> & { refs?: string[]; irt?: string; mid?: string | null; inbox?: string } = {}): MessageRow {
  const inbox_id = o.inbox ?? "imap";
  const mid = o.mid === null ? null : (o.mid ?? `${id}@x`);
  const references = o.refs ?? [];
  const in_reply_to = o.irt ?? null;
  const root = references[0] ?? in_reply_to ?? mid;
  const date = o.date ?? new Date(Date.UTC(2026, 8, 30) - clock++ * 60_000).toISOString();
  return {
    key: makeKey(inbox_id, id),
    inbox_id,
    id,
    from: { name: "Maya Chen", email: "maya@x.example" },
    to: [{ name: "Me", email: "me@x.example" }],
    subject: "Re: Invoice",
    preview: "",
    is_read: true,
    has_attachments: false,
    folder: "INBOX",
    thread_id: id,
    is_starred: false,
    folder_role: "inbox",
    message_id_header: mid,
    in_reply_to,
    references,
    thread_key: root ? `m:${root}` : `s:same-subject-hash`,
    ...o,
    date,
  };
}

const shape = (g: ConversationGrouper, rows: MessageRow[], enabled = true) =>
  g.group(rows, enabled).conversations.map((c) => c.rows.map((r) => r.id));

describe("ConversationGrouper", () => {
  it("groups a root and its replies; the newest row is the head", () => {
    const rows = [row("c", { refs: ["a@x", "b@x"], irt: "b@x" }), row("lone"), row("b", { refs: ["a@x"], irt: "a@x" }), row("a")];
    const g = new ConversationGrouper();
    const list = g.group(rows);
    expect(list.conversations.map((c) => c.rows.map((r) => r.id))).toEqual([["c", "b", "a"], ["lone"]]);
    const conv = list.conversations[0]!;
    expect([conv.head.id, conv.count, conv.keys.length]).toEqual(["c", 3, 3]);
    expect(list.byKey.get(makeKey("imap", "a"))).toBe(conv);
  });

  it("aggregates: unread, starred and attachment if ANY message has it", () => {
    const rows = [row("b", { refs: ["a@x"] }), row("a", { is_read: false, is_starred: true, has_attachments: true })];
    const conv = new ConversationGrouper().group(rows).conversations[0]!;
    expect([conv.unread, conv.starred, conv.hasAttachment]).toEqual([true, true, true]);
    expect(conv.head.is_read).toBe(true);
  });

  it("never merges on subject: two unrelated 'Re: Invoice' mails from different senders stay apart", () => {
    const rows = [
      row("x", { irt: "elsewhere@x", refs: ["elsewhere@x"], from: { name: "Odd", email: "odd@y.example" } }),
      row("y", { irt: "root@x", refs: ["root@x"] }),
    ];
    expect(shape(new ConversationGrouper(), rows)).toEqual([["x"], ["y"]]);
  });

  it("merges same-subject mails only when headers link them", () => {
    const rows = [row("y", { irt: "x@x", refs: ["x@x"], from: { name: "Odd", email: "odd@y.example" } }), row("x")];
    expect(shape(new ConversationGrouper(), rows)).toEqual([["y", "x"]]);
  });

  it("rows without any header carry the server's subject key and group only by that key", () => {
    // The server gives `s:` keys only to messages with no Message-ID at all,
    // and puts the participants in the hash: same key = same subject AND people.
    const a = row("a", { mid: null, thread_key: "s:h1" });
    const b = row("b", { mid: null, thread_key: "s:h1" });
    const c = row("c", { mid: null, thread_key: "s:h2" });
    expect(shape(new ConversationGrouper(), [a, b, c])).toEqual([["a", "b"], ["c"]]);
  });

  it("a row with no thread_key (older server), a draft and a scheduled send stand alone", () => {
    const rows = [
      row("old1", { thread_key: undefined }),
      row("old2", { thread_key: undefined }),
      row("d", { folder_role: "drafts", refs: ["a@x"] }),
      row("s", { folder_role: "scheduled", refs: ["a@x"] }),
      row("a"),
    ];
    expect(shape(new ConversationGrouper(), rows)).toEqual([["old1"], ["old2"], ["d"], ["s"], ["a"]]);
  });

  it("forks: two replies to the same root are one conversation", () => {
    const rows = [row("fork2", { refs: ["a@x"], irt: "a@x" }), row("fork1", { refs: ["a@x"], irt: "a@x" }), row("a")];
    expect(shape(new ConversationGrouper(), rows)).toEqual([["fork2", "fork1", "a"]]);
  });

  it("a reply whose References were cut short still joins through In-Reply-To", () => {
    // c only names its parent b; b names the root. The server keys c as m:b@x.
    const rows = [row("c", { irt: "b@x" }), row("b", { refs: ["a@x"], irt: "a@x" }), row("a")];
    expect(rows[0]!.thread_key).toBe("m:b@x");
    expect(shape(new ConversationGrouper(), rows)).toEqual([["c", "b", "a"]]);
  });

  it("duplicate Message-IDs: both rows are members, the count is of distinct messages", () => {
    const rows = [row("copy2", { mid: "same@x", refs: ["a@x"] }), row("copy1", { mid: "same@x", refs: ["a@x"] }), row("a")];
    const conv = new ConversationGrouper().group(rows).conversations[0]!;
    expect([conv.rows.length, conv.count]).toEqual([3, 2]);
  });

  it("never merges across mailboxes, even with identical keys and ids", () => {
    const rows = [row("a", { inbox: "one" }), row("a", { inbox: "two" }), row("b", { inbox: "one", refs: ["a@x"] }), row("b", { inbox: "two", refs: ["a@x"] })];
    const list = new ConversationGrouper().group(rows);
    expect(list.conversations.map((c) => c.rows.map((r) => r.key))).toEqual([
      ["one:a", "one:b"],
      ["two:a", "two:b"],
    ]);
  });

  it("Gmail and Outlook rows group by the provider's key alone, not by headers", () => {
    const a = row("a", { thread_key: "g:T1", mid: "a@x" });
    const b = row("b", { thread_key: "g:T2", irt: "a@x", refs: ["a@x"] });
    const c = row("c", { thread_key: "g:T1", mid: "c@x" });
    expect(shape(new ConversationGrouper(), [a, b, c])).toEqual([["a", "c"], ["b"]]);
    expect(linkTokens(b)).toHaveLength(1);
  });

  it("a reply that arrives before its parent's page: one conversation once the parent loads, same id, same head", () => {
    const g = new ConversationGrouper();
    const page1 = [row("reply", { refs: ["parent@x"], irt: "parent@x" }), row("other")];
    const first = g.group(page1);
    expect(first.conversations.map((c) => c.rows.length)).toEqual([1, 1]);
    const id = first.conversations[0]!.id;
    const page2 = [row("filler"), row("parent")];
    const second = g.group([...page1, ...page2]);
    expect(second.conversations.map((c) => c.rows.map((r) => r.id))).toEqual([["reply", "parent"], ["other"], ["filler"]]);
    expect(second.conversations[0]!.id).toBe(id);
    expect(second.conversations[0]!.head.id).toBe("reply");
    // The untouched conversation is the same object: its row does not re-render.
    expect(second.conversations[1]).toBe(first.conversations[1]);
  });

  it("two conversations found to be one (a later page links them) keep the id of the one seen first", () => {
    const g = new ConversationGrouper();
    const top = row("top", { irt: "mid@x" }); // keyed m:mid@x
    const bottom = row("bottom", { refs: ["root@x"], irt: "root@x" }); // keyed m:root@x
    const before = g.group([top, bottom]);
    expect(before.conversations).toHaveLength(2);
    const bridge = row("mid", { refs: ["root@x"], irt: "root@x" });
    const after = g.group([top, bottom, bridge]);
    expect(after.conversations.map((c) => c.rows.map((r) => r.id))).toEqual([["top", "bottom", "mid"]]);
    expect(after.conversations[0]!.id).toBe(before.conversations[0]!.id);
  });

  it("paging with conversations spanning pages: no duplicates, no lost rows, order of heads kept", () => {
    const g = new ConversationGrouper();
    const all: MessageRow[] = [];
    for (let i = 0; i < 300; i++) {
      const thread = i % 37;
      all.push(row(`r${i}`, i < 37 ? {} : { refs: [`r${thread}@x`], irt: `r${thread}@x` }));
    }
    // Rows are newest first; the roots (r0..r36) are the newest here, replies older.
    let list = g.group([]);
    for (let end = 50; end <= 300; end += 50) list = g.group(all.slice(0, end));
    const members = list.conversations.flatMap((c) => c.rows.map((r) => r.key));
    expect(members).toHaveLength(300);
    expect(new Set(members).size).toBe(300);
    expect(list.conversations).toHaveLength(37);
    expect(list.conversations.map((c) => c.head.id)).toEqual(Array.from({ length: 37 }, (_, i) => `r${i}`));
    expect(list.byKey.size).toBe(300);
  });

  it("a flag change replaces one row object: only its conversation is rebuilt", () => {
    const g = new ConversationGrouper();
    const rows = [row("b", { refs: ["a@x"], is_read: false }), row("z"), row("a")];
    const first = g.group(rows);
    const next = [{ ...rows[0]!, is_read: true }, rows[1]!, rows[2]!];
    const second = g.group(next);
    expect(second.conversations[0]).not.toBe(first.conversations[0]);
    expect(second.conversations[0]!.unread).toBe(false);
    expect(second.conversations[0]!.id).toBe(first.conversations[0]!.id);
    expect(second.conversations[1]).toBe(first.conversations[1]);
  });

  it("rows leaving (archive) shrink the conversation; the last one leaving removes it", () => {
    const g = new ConversationGrouper();
    const rows = [row("b", { refs: ["a@x"] }), row("z"), row("a")];
    g.group(rows);
    expect(shape(g, [rows[1]!, rows[2]!])).toEqual([["z"], ["a"]]);
    expect(shape(g, [rows[1]!])).toEqual([["z"]]);
  });

  it("conversation view off: one conversation per row, objects reused", () => {
    const g = new ConversationGrouper();
    const rows = [row("b", { refs: ["a@x"] }), row("a")];
    const off = g.group(rows, false);
    expect(off.conversations.map((c) => c.rows.length)).toEqual([1, 1]);
    expect(g.group(rows, false).conversations[0]).toBe(off.conversations[0]);
    expect(shape(g, rows, true)).toEqual([["b", "a"]]);
  });

  it("benchmark: grouping 5,000 rows incrementally, a page at a time, stays under a few ms per page", () => {
    const all: MessageRow[] = [];
    for (let i = 0; i < 5000; i++) {
      // A third are replies in threads of varying depth, with real-looking reference chains.
      const depth = i % 3 === 0 ? 1 + (i % 9) : 0;
      const root = `t${i % 611}@bench`;
      const refs = depth ? [root, ...Array.from({ length: depth - 1 }, (_, d) => `t${i % 611}-${d}@bench`)] : [];
      all.push(row(`m${i}`, depth ? { refs, irt: refs[refs.length - 1] } : { mid: i < 611 ? `t${i}@bench` : `m${i}@bench` }));
    }
    const run = () => {
      const g = new ConversationGrouper();
      const times: number[] = [];
      let list = g.group([]);
      for (let end = 50; end <= 5000; end += 50) {
        const rows = all.slice(0, end);
        const started = performance.now();
        list = g.group(rows);
        times.push(performance.now() - started);
      }
      return { times, list };
    };
    run(); // warm the JIT
    const { times, list } = run();
    const sorted = [...times].sort((a, b) => a - b);
    const mean = times.reduce((n, t) => n + t, 0) / times.length;
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
    const last = times[times.length - 1]!;
    console.log(
      `conversations bench: 5,000 rows in 100 pages -> ${list.conversations.length} conversations; ` +
        `per page mean ${mean.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms, last page (all 5,000 rows) ${last.toFixed(3)} ms`,
    );
    expect(list.byKey.size).toBe(5000);
    // Generous for a loaded CI runner; the printed numbers are the result.
    expect(mean).toBeLessThan(4);
    expect(p95).toBeLessThan(8);

    // A flag change on one row of the full list: the same single pass.
    const g = new ConversationGrouper();
    g.group(all);
    const changed = all.slice();
    changed[2500] = { ...changed[2500]!, is_read: false };
    const started = performance.now();
    g.group(changed);
    expect(performance.now() - started).toBeLessThan(8);
  });
});

describe("participantNames", () => {
  const from = (name: string, email: string, o: Partial<MessageRow> = {}) => row(`${email}-${clock}`, { from: { name, email }, ...o });
  it("first names, oldest first, 'me' for the mailbox's own address", () => {
    const rows = [from("Jordan Reyes", "ME@x.example"), from("Maya Chen", "maya@x.example"), from("Jordan Reyes", "me@x.example")];
    // rows are newest first: me (oldest), Maya, me again.
    expect(participantNames(rows, "me@x.example")).toBe("me, Maya");
  });
  it("falls back to the address and shortens more than three", () => {
    const rows = [from("E", "e@x"), from("D D", "d@x"), from("", "carol@x"), from("Bo", "b@x"), from("Al", "a@x")];
    expect(participantNames(rows, "")).toBe("Al … D, E");
    expect(participantNames(rows.slice(2), "")).toBe("Al, Bo, carol");
  });
});

describe("mergeThread", () => {
  it("list rows plus thread rows, oldest first, one copy per message (the list's wins)", () => {
    const inboxNew = row("n", { date: "2026-09-03T10:00:00.000Z", refs: ["a@x"] });
    const inboxOld = row("a", { date: "2026-09-01T10:00:00.000Z" });
    const sent = row("s", { date: "2026-09-02T10:00:00.000Z", folder: "Sent", folder_role: "sent", refs: ["a@x"] });
    const dup = { ...inboxOld, key: "imap:Archive:9" as MessageKey, id: "Archive:9", folder: "Archive" };
    const same = { ...inboxNew, preview: "from the thread op" };
    const merged = mergeThread([inboxNew, inboxOld], [dup, sent, same]);
    expect(merged.map((r) => r.id)).toEqual(["a", "s", "n"]);
    expect(merged[2]).toBe(inboxNew);
  });
});
