import { describe, expect, it } from "vitest";
import type { MessageKey, MessageRow } from "../../api/types";
import {
  anchoredOffset,
  emptyState,
  indexByKey,
  listCountText,
  listSetSize,
  listTitle,
  phoneNavValue,
  rowAriaLabel,
  rowDecor,
  rowView,
} from "./model";
import {
  SWIPE_COMMIT_FRACTION,
  swipeAllowed,
  swipeArmed,
  swipeIntent,
  swipeOffset,
  swipeOutcome,
  swipeVelocity,
} from "./swipe";

const row = (over: Partial<MessageRow> = {}): MessageRow => ({
  key: "gmail:1",
  inbox_id: "gmail",
  id: "1",
  from: { name: "Maya Chen", email: "maya@x.io" },
  to: [{ name: "", email: "jordan@gmail.com" }],
  subject: "Q3 numbers",
  date: "2026-10-03T09:41:00Z",
  preview: "Here they are",
  is_read: false,
  has_attachments: false,
  folder: "INBOX",
  thread_id: "t1",
  is_starred: false,
  folder_role: "inbox",
  ...over,
});

const k = (n: number): MessageKey => `gmail:${n}`;
const keys = (...ns: number[]) => ns.map(k);

describe("rowView", () => {
  it("shows the sender for received mail", () => {
    expect(rowView(row())).toEqual({ who: "Maya Chen", subject: "Q3 numbers", canStar: true, outgoing: false });
  });

  it("shows the recipients for mail the user wrote", () => {
    const v = rowView(row({ folder_role: "sent", to: [{ name: "Sam", email: "s@x.io" }, { name: "", email: "p@x.io" }] }));
    expect(v.who).toBe("To: Sam, p@x.io");
    expect(v.outgoing).toBe(true);
    expect(v.canStar).toBe(true);
  });

  it("handles a draft with no recipient or subject, and has no star", () => {
    const v = rowView(row({ folder_role: "drafts", to: [], subject: "" }));
    expect(v).toEqual({ who: "To: —", subject: "(no subject)", canStar: false, outgoing: true });
  });

  it("is cached per row object", () => {
    const r = row();
    expect(rowView(r)).toBe(rowView(r));
  });
});

describe("rowDecor", () => {
  const base = { touch: null, hasTrace: false, ghostTo: null, label: null, attached: false, fresh: false };

  it("is empty for an ordinary row", () => {
    expect(rowDecor(base)).toEqual({ tag: null, note: null, trace: false, inChat: false, tone: null });
  });

  it("shows a cobalt tag while a call is touching the row", () => {
    const d = rowDecor({ ...base, touch: { tool: "email_read", state: "running" }, hasTrace: true, label: "needs reply" });
    expect(d.tag).toEqual({ text: "Reading", icon: "eye", amber: false });
    expect(d.tone).toBe("cobalt");
    // The tag owns the slot: no label, no trace mark, no badge.
    expect(d.note).toBeNull();
    expect(d.trace).toBe(false);
  });

  it("goes amber while a send waits for approval", () => {
    const d = rowDecor({ ...base, touch: { tool: "email_compose", state: "waiting" } });
    expect(d.tag).toEqual({ text: "Awaiting approval", icon: "shield-alert", amber: true });
    expect(d.tone).toBe("amber");
  });

  it("shows where a ghost row went, without the trace mark", () => {
    const d = rowDecor({ ...base, ghostTo: "Receipts", hasTrace: true, label: "receipt" });
    expect(d.note).toBe("Moved to Receipts");
    expect(d.trace).toBe(false);
  });

  it("shows a label together with the trace mark", () => {
    const d = rowDecor({ ...base, label: "needs reply", hasTrace: true });
    expect(d.note).toBe("needs reply");
    expect(d.trace).toBe(true);
  });

  it("shows the in-chat badge only when nothing else marks the row", () => {
    expect(rowDecor({ ...base, attached: true }).inChat).toBe(true);
    expect(rowDecor({ ...base, attached: true, hasTrace: true }).inChat).toBe(false);
    expect(rowDecor({ ...base, attached: true, label: "x" }).inChat).toBe(false);
    expect(rowDecor({ ...base, attached: true, touch: { tool: "draft", state: "running" } }).inChat).toBe(false);
  });

  it("flashes cobalt for a fresh row", () => {
    expect(rowDecor({ ...base, fresh: true }).tone).toBe("cobalt");
  });
});

describe("rowAriaLabel", () => {
  it("reads state, sender, subject and time", () => {
    expect(rowAriaLabel({ unread: true, starred: false, who: "Maya Chen", subject: "Q3 numbers", time: "9:41" })).toBe(
      "Unread. Maya Chen, Q3 numbers, 9:41",
    );
  });
  it("adds star, attachment and what the assistant is doing", () => {
    expect(
      rowAriaLabel({ unread: false, starred: true, who: "Stripe", subject: "Receipt", time: "Tue", status: "Moving", hasAttachment: true }),
    ).toBe("Stripe, Receipt, Tue, starred, has attachment. Assistant: Moving");
  });
});

describe("listTitle", () => {
  const base = { query: "", isInbox: true, folderName: "Inbox", scopeIsAll: true, scopeName: "All mailboxes" };
  it("names the inbox with its scope", () => {
    expect(listTitle(base)).toBe("Inbox · All mailboxes");
    expect(listTitle({ ...base, scopeIsAll: false, scopeName: "Work" })).toBe("Inbox · Work");
  });
  it("names other folders, with the mailbox only when filtered", () => {
    expect(listTitle({ ...base, isInbox: false, folderName: "Receipts" })).toBe("Receipts");
    expect(listTitle({ ...base, isInbox: false, folderName: "Receipts", scopeIsAll: false, scopeName: "Work" })).toBe("Receipts · Work");
  });
  it("shows the search", () => {
    expect(listTitle({ ...base, query: "  invoice " })).toBe('Results for "invoice"');
  });
});

describe("listCountText", () => {
  const base = { searching: false, folderUnread: 0, folderTotal: 128, listTotal: 128, loadedCount: 50, loadedUnread: 0, hasMore: true };

  it("prefers the folder's unread count over the loaded rows", () => {
    expect(listCountText({ ...base, folderUnread: 12, loadedUnread: 4 })).toBe("12 unread");
  });
  it("falls back to the folder total when nothing is unread", () => {
    expect(listCountText(base)).toBe("128 emails");
    expect(listCountText({ ...base, folderTotal: 1, listTotal: 1, loadedCount: 1, hasMore: false })).toBe("1 email");
  });
  it("does not trust a stale loaded-unread when the folder says zero", () => {
    expect(listCountText({ ...base, folderUnread: 0, loadedUnread: 2 })).toBe("128 emails");
  });
  it("counts the loaded rows when the folder has no counts (Starred)", () => {
    expect(listCountText({ ...base, folderUnread: null, folderTotal: null, listTotal: null, loadedUnread: 3 })).toBe("3+ unread");
    expect(listCountText({ ...base, folderUnread: null, folderTotal: null, listTotal: null })).toBe("50+ emails");
    expect(listCountText({ ...base, folderUnread: null, folderTotal: null, listTotal: null, hasMore: false })).toBe("50 emails");
  });
  it("never renders an unknown total as a number", () => {
    const text = listCountText({ ...base, folderUnread: undefined, folderTotal: undefined, listTotal: null, loadedCount: 0, hasMore: false });
    expect(text).toBe("0 emails");
    expect(text).not.toMatch(/null|undefined|NaN/);
  });
  it("ignores folder counts while searching", () => {
    expect(listCountText({ ...base, searching: true, folderUnread: 12, listTotal: 7, loadedCount: 7, loadedUnread: 2, hasMore: false })).toBe("2 unread");
    expect(listCountText({ ...base, searching: true, folderUnread: 12, listTotal: 7, loadedCount: 7, hasMore: false })).toBe("7 emails");
  });
  it("is never smaller than what is on screen", () => {
    expect(listCountText({ ...base, folderTotal: 3, listTotal: 3, loadedCount: 5, hasMore: false })).toBe("5 emails");
  });
});

describe("listSetSize", () => {
  it("uses the total, -1 while unknown and more can load", () => {
    expect(listSetSize(128, 50, true)).toBe(128);
    expect(listSetSize(null, 50, true)).toBe(-1);
    expect(listSetSize(null, 50, false)).toBe(50);
    expect(listSetSize(3, 5, false)).toBe(5);
  });
});

describe("emptyState", () => {
  it("covers an empty folder, a filtered mailbox and a search", () => {
    expect(emptyState({ query: "", isInbox: true, folderName: "Inbox", filteredTo: null })).toEqual({
      title: "Nothing in your inbox.",
      sub: "New mail appears here as it arrives.",
    });
    expect(emptyState({ query: "", isInbox: false, folderName: "Receipts", filteredTo: "Work" })).toEqual({
      title: "Nothing in Receipts.",
      sub: "Showing Work only.",
    });
    expect(emptyState({ query: "zzz", isInbox: true, folderName: "Inbox", filteredTo: "Work" })).toEqual({
      title: 'No results for "zzz"',
      sub: "Try a sender name or part of a subject.",
    });
  });
});

describe("phoneNavValue", () => {
  it("maps the inbox to a mailbox option and other folders to a folder option", () => {
    expect(phoneNavValue(true, "work", true, "inbox")).toBe("mb:work");
    expect(phoneNavValue(true, "all", true, "inbox")).toBe("mb:all");
    expect(phoneNavValue(true, "work", false, "inbox")).toBe("mb:all");
    expect(phoneNavValue(false, "all", true, "name:Receipts")).toBe("f:name:Receipts");
  });
});

describe("anchoredOffset", () => {
  const H = 76;
  it("does nothing at the top of the list", () => {
    expect(anchoredOffset(keys(1, 2, 3), indexByKey(keys(9, 1, 2, 3)), 0, H)).toBeNull();
  });
  it("does nothing when rows are appended below", () => {
    expect(anchoredOffset(keys(1, 2, 3), indexByKey(keys(1, 2, 3, 4, 5)), 100, H)).toBeNull();
  });
  it("shifts by the rows inserted above the viewport", () => {
    // Top visible row is index 1 (offset 100 → row 2). Two rows arrive on top.
    expect(anchoredOffset(keys(1, 2, 3, 4), indexByKey(keys(8, 9, 1, 2, 3, 4)), 100, H)).toBe(100 + 2 * H);
  });
  it("shifts back when a row above the viewport is removed", () => {
    expect(anchoredOffset(keys(1, 2, 3, 4), indexByKey(keys(2, 3, 4)), 2 * H + 10, H)).toBe(H + 10);
  });
  it("anchors on the next surviving row when the top one left", () => {
    // Row 2 (top of viewport) is removed; row 3 keeps its place on screen.
    expect(anchoredOffset(keys(1, 2, 3, 4), indexByKey(keys(1, 3, 4)), H + 10, H)).toBe(10);
    expect(anchoredOffset(keys(1, 2), indexByKey(keys(7)), H, H)).toBeNull();
  });
});

describe("swipe", () => {
  const all = { archive: true, trash: true };
  const W = 390;

  it("waits for enough movement before classifying", () => {
    expect(swipeIntent(4, 3)).toBeNull();
    expect(swipeIntent(-9, 9)).toBeNull();
  });
  it("lets vertical scrolling win a diagonal", () => {
    expect(swipeIntent(12, 12)).toBe("vertical");
    expect(swipeIntent(14, 10)).toBe("vertical");
    expect(swipeIntent(2, 30)).toBe("vertical");
  });
  it("recognises a clearly horizontal move in either direction", () => {
    expect(swipeIntent(16, 4)).toBe("horizontal");
    expect(swipeIntent(-22, 6)).toBe("horizontal");
  });

  it("commits at 38% of the row width: right archives, left trashes", () => {
    const at = Math.ceil(W * SWIPE_COMMIT_FRACTION);
    expect(swipeOutcome(at, W, 0, all)).toBe("archive");
    expect(swipeOutcome(-at, W, 0, all)).toBe("trash");
    expect(swipeOutcome(at - 2, W, 0, all)).toBeNull();
    expect(swipeArmed(at, W, all)).toBe(true);
    expect(swipeArmed(at - 2, W, all)).toBe(false);
  });
  it("commits on a fast flick below the distance threshold", () => {
    expect(swipeOutcome(60, W, 0.9, all)).toBe("archive");
    expect(swipeOutcome(-60, W, -0.9, all)).toBe("trash");
  });
  it("ignores a flick that is too short, too slow or going back", () => {
    expect(swipeOutcome(12, W, 2, all)).toBeNull();
    expect(swipeOutcome(60, W, 0.2, all)).toBeNull();
    expect(swipeOutcome(60, W, -0.9, all)).toBeNull();
  });
  it("never commits a direction that is not allowed", () => {
    const noTrash = swipeAllowed("trash");
    expect(noTrash).toEqual({ archive: true, trash: false });
    expect(swipeOutcome(-300, W, -2, noTrash)).toBeNull();
    expect(swipeArmed(-300, W, noTrash)).toBe(false);
    expect(swipeAllowed("archive")).toEqual({ archive: false, trash: true });
    expect(swipeAllowed("drafts")).toEqual({ archive: false, trash: false });
    expect(swipeAllowed("inbox", true)).toEqual({ archive: false, trash: false });
    expect(swipeAllowed(null)).toEqual(all);
  });

  it("follows the finger 1:1, clamped to the row, and resists a dead direction", () => {
    expect(swipeOffset(80, W, all)).toBe(80);
    expect(swipeOffset(-900, W, all)).toBe(-W);
    expect(swipeOffset(0, W, all)).toBe(0);
    expect(swipeOffset(-100, W, { archive: true, trash: false })).toBe(-20);
    expect(swipeOffset(-1000, W, { archive: true, trash: false })).toBe(-28);
  });

  it("measures release velocity, and none after a pause", () => {
    expect(swipeVelocity(0, 0, 40, 50)).toBeCloseTo(0.8);
    expect(swipeVelocity(40, 0, 0, 50)).toBeCloseTo(-0.8);
    expect(swipeVelocity(0, 0, 40, 500)).toBe(0);
    expect(swipeVelocity(0, 10, 40, 10)).toBe(0);
  });
});
