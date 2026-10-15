import { describe, expect, it } from "vitest";
import { type InboxPage, mergeInboxPages } from "./merge";
import { type MessagePage, type MessageRow, type PageCursor, makeKey } from "./types";

/* Property-style tests of the unified merge: many random mailboxes, page
 * sizes, arrival orders and delays, all from a seeded generator so a failure
 * names the seed that reproduces it. */

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE = Date.parse("2026-10-04T12:00:00Z");

function row(inbox_id: string, n: number, minutesAgo: number): MessageRow {
  const id = `${inbox_id}-${n}`;
  return {
    id,
    key: makeKey(inbox_id, id),
    inbox_id,
    from: { name: "S", email: "s@example.com" },
    to: [],
    subject: id,
    date: new Date(BASE - minutesAgo * 60_000).toISOString(),
    preview: "",
    is_read: true,
    is_starred: false,
    has_attachments: false,
    folder: "INBOX",
    folder_role: "inbox",
    thread_id: id,
  };
}

interface World {
  ids: string[];
  boxes: Map<string, MessageRow[]>;
  limit: number;
}

/** Random mailboxes: different sizes (some empty, some far larger than a
 *  page), dates that interleave and collide across and inside mailboxes. */
function world(rand: () => number): World {
  const count = 2 + Math.floor(rand() * 4);
  const limit = 1 + Math.floor(rand() * 7);
  const ids = Array.from({ length: count }, (_, i) => `box${i}`);
  const boxes = new Map<string, MessageRow[]>();
  for (const id of ids) {
    const size = rand() < 0.15 ? 0 : Math.floor(rand() * 30);
    // A mailbox whose mail is bunched in a short span next to one spread out.
    const span = rand() < 0.3 ? 20 : 400;
    const ages = Array.from({ length: size }, () => Math.floor(rand() * span)).sort((a, b) => a - b);
    boxes.set(id, ages.map((age, n) => row(id, n, age)));
  }
  return { ids, boxes, limit };
}

function pageOf(w: World, inbox_id: string, offset: number, limit: number): InboxPage {
  const all = w.boxes.get(inbox_id) ?? [];
  const rows = all.slice(offset, offset + limit);
  const has_more = offset + limit < all.length;
  return { inbox_id, rows, total: all.length, has_more, next_offset: has_more ? offset + limit : null };
}

/** A fetch whose answers arrive in a random order, after random delays
 *  (0 to 40 turns of the microtask queue: enough for every interleaving, and
 *  thousands of them run in a moment). `failing` mailboxes answer as the API
 *  layer reports a failed one to the merge: nothing, and no more. */
function shuffledFetch(w: World, rand: () => number, failing = new Set<string>()) {
  const fetch = async (inbox_id: string, offset: number, limit: number): Promise<InboxPage> => {
    const waits = Math.floor(rand() * 40);
    for (let i = 0; i < waits; i++) await Promise.resolve();
    if (failing.has(inbox_id)) return { inbox_id, rows: [], total: null, has_more: false };
    return pageOf(w, inbox_id, offset, limit);
  };
  return { fetch };
}

const instant = (w: World, failing = new Set<string>()) => async (inbox_id: string, offset: number, limit: number) =>
  failing.has(inbox_id) ? { inbox_id, rows: [], total: null, has_more: false } : pageOf(w, inbox_id, offset, limit);

const isSortedDesc = (rows: MessageRow[]) => rows.every((r, i) => i === 0 || (rows[i - 1] as MessageRow).date >= r.date);
const keysOf = (rows: MessageRow[]) => rows.map((r) => r.key);
const of = (rows: MessageRow[], inbox_id: string) => keysOf(rows.filter((r) => r.inbox_id === inbox_id));
const isPrefix = (short: string[], long: string[]) => short.length <= long.length && short.every((k, i) => long[i] === k);

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

describe("mergeInboxPages: provisional first pages (random arrival orders and delays)", () => {
  it("resolves to exactly what it resolves to without progress, whatever the order", async () => {
    for (const seed of SEEDS) {
      const rand = rng(seed);
      const w = world(rand);
      const plain = await mergeInboxPages(w.ids, null, w.limit, instant(w));
      const { fetch } = shuffledFetch(w, rand);
      const progressive = await mergeInboxPages(w.ids, null, w.limit, fetch, () => {});
      expect(progressive, `seed ${seed}`).toEqual(plain);
      expect(progressive.pending_inboxes, `seed ${seed}`).toBeUndefined();
    }
  });

  it("every provisional page holds only mailboxes that answered, in date order, once, and never claims to be complete", async () => {
    for (const seed of SEEDS) {
      const rand = rng(seed);
      const w = world(rand);
      const { fetch } = shuffledFetch(w, rand);
      const partials: MessagePage[] = [];
      await mergeInboxPages(w.ids, null, w.limit, fetch, (page) => partials.push(page));
      // One for every answer except the last (that one is the real page).
      expect(partials.length, `seed ${seed}`).toBe(w.ids.length - 1);
      partials.forEach((page, i) => {
        const pending = page.pending_inboxes ?? [];
        const label = `seed ${seed}, waiting for ${pending.join(",")}`;
        // One mailbox fewer is out with every answer, and at least one still is.
        expect(pending.length, label).toBe(w.ids.length - 1 - i);
        expect(pending.length, label).toBeGreaterThan(0);
        for (const id of pending) expect(w.ids, label).toContain(id);
        if (i > 0) for (const id of pending) expect(partials[i - 1]?.pending_inboxes, label).toContain(id);
        // No row of a mailbox that has not answered.
        for (const r of page.rows) expect(pending, label).not.toContain(r.inbox_id);
        expect(isSortedDesc(page.rows), label).toBe(true);
        expect(new Set(keysOf(page.rows)).size, label).toBe(page.rows.length);
        // Not complete: no total, nothing to page with.
        expect(page.total, label).toBeNull();
        expect(page.next_cursor, label).toBeNull();
        expect(page.has_more, label).toBe(true);
      });
    }
  });

  it("a mailbox that answers later only inserts rows and lowers the horizon: it never reorders or invents", async () => {
    for (const seed of SEEDS) {
      const rand = rng(seed);
      const w = world(rand);
      const { fetch } = shuffledFetch(w, rand);
      const pages: MessagePage[] = [];
      const final = await mergeInboxPages(w.ids, null, w.limit, fetch, (p) => pages.push(p));
      pages.push(final);
      for (let i = 1; i < pages.length; i++) {
        const before = pages[i - 1] as MessagePage;
        const after = pages[i] as MessagePage;
        for (const id of w.ids) {
          // Each mailbox's rows are the newest of that mailbox, in its own
          // order; a later page shows a prefix of what an earlier one showed.
          const all = keysOf(w.boxes.get(id) ?? []);
          expect(isPrefix(of(after.rows, id), all), `seed ${seed} ${id}`).toBe(true);
          if (before.rows.some((r) => r.inbox_id === id) || !(before.pending_inboxes ?? []).includes(id)) {
            expect(isPrefix(of(after.rows, id), of(before.rows, id)), `seed ${seed} ${id} step ${i}`).toBe(true);
          }
        }
      }
      // The safe horizon holds in the final page: no mailbox that has more
      // could contribute a row newer than the oldest row shown.
      const oldest = final.rows[final.rows.length - 1]?.date;
      if (oldest !== undefined && final.next_cursor) {
        for (const id of w.ids) {
          const offset = final.next_cursor[id];
          if (offset == null) continue;
          const next = (w.boxes.get(id) ?? [])[offset];
          if (next) expect(next.date <= oldest, `seed ${seed} ${id}`).toBe(true);
        }
      }
    }
  });
});

describe("mergeInboxPages: paging (random arrival orders, a slow and a failed mailbox)", () => {
  async function pageThrough(w: World, rand: () => number, failing: Set<string>) {
    const out: MessageRow[] = [];
    const pages: MessagePage[] = [];
    let cursor: PageCursor | null = null;
    for (let guard = 0; guard < 500; guard++) {
      const { fetch } = shuffledFetch(w, rand, failing);
      // The first page with progress (as the list loads it), the rest without.
      const page: MessagePage = await mergeInboxPages(w.ids, cursor, w.limit, fetch, cursor ? undefined : () => {});
      pages.push(page);
      out.push(...page.rows);
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    return { out, pages };
  }

  it("shows every row of every healthy mailbox exactly once, newest first across pages", async () => {
    for (const seed of SEEDS) {
      const rand = rng(seed);
      const w = world(rand);
      const { out, pages } = await pageThrough(w, rand, new Set());
      const expected = w.ids.flatMap((id) => keysOf(w.boxes.get(id) ?? []));
      expect(keysOf(out).sort(), `seed ${seed}`).toEqual([...expected].sort());
      expect(new Set(keysOf(out)).size, `seed ${seed}`).toBe(out.length);
      expect(isSortedDesc(out), `seed ${seed}`).toBe(true);
      for (const id of w.ids) expect(of(out, id), `seed ${seed} ${id}`).toEqual(keysOf(w.boxes.get(id) ?? []));
      // Every page but the last makes progress.
      for (const p of pages.slice(0, -1)) expect(p.rows.length, `seed ${seed}`).toBeGreaterThan(0);
    }
  });

  it("a failed mailbox is left out; the others are still complete, in order, without duplicates", async () => {
    for (const seed of SEEDS) {
      const rand = rng(seed);
      const w = world(rand);
      const failing = new Set([w.ids[Math.floor(rand() * w.ids.length)] as string]);
      const { out } = await pageThrough(w, rand, failing);
      const healthy = w.ids.filter((id) => !failing.has(id));
      expect(keysOf(out).sort(), `seed ${seed}`).toEqual(healthy.flatMap((id) => keysOf(w.boxes.get(id) ?? [])).sort());
      expect(out.some((r) => failing.has(r.inbox_id)), `seed ${seed}`).toBe(false);
      expect(isSortedDesc(out), `seed ${seed}`).toBe(true);
    }
  });

  it("a mailbox that fails part of the way through keeps what it showed and hides nothing of the others", async () => {
    for (const seed of SEEDS.slice(0, 120)) {
      const rand = rng(seed);
      const w = world(rand);
      const victim = w.ids[0] as string;
      const out: MessageRow[] = [];
      let cursor: PageCursor | null = null;
      let pageNo = 0;
      for (let guard = 0; guard < 500; guard++) {
        const failing = pageNo >= 1 ? new Set([victim]) : new Set<string>();
        const page: MessagePage = await mergeInboxPages(w.ids, cursor, w.limit, shuffledFetch(w, rand, failing).fetch, cursor ? undefined : () => {});
        out.push(...page.rows);
        pageNo++;
        if (!page.next_cursor) break;
        cursor = page.next_cursor;
      }
      expect(new Set(keysOf(out)).size, `seed ${seed}`).toBe(out.length);
      expect(isSortedDesc(out), `seed ${seed}`).toBe(true);
      for (const id of w.ids.slice(1)) expect(of(out, id), `seed ${seed} ${id}`).toEqual(keysOf(w.boxes.get(id) ?? []));
      // What the failed mailbox did show is a prefix of its mail: no gaps.
      expect(isPrefix(of(out, victim), keysOf(w.boxes.get(victim) ?? [])), `seed ${seed}`).toBe(true);
    }
  });

  it("gives no provisional page after the first: no row of a later page is safe before every mailbox answered", async () => {
    const rand = rng(7);
    const w = world(rand);
    const first = await mergeInboxPages(w.ids, null, 2, instant(w));
    if (!first.next_cursor) throw new Error("the world of seed 7 has more than one page");
    let partials = 0;
    await mergeInboxPages(w.ids, first.next_cursor, 2, shuffledFetch(w, rand).fetch, () => partials++);
    expect(partials).toBe(0);
  });
});
