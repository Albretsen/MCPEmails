import type { MessagePage, MessageRow, PageCursor } from "./types";

/** One inbox's answer for one page request. */
export interface InboxPage {
  inbox_id: string;
  rows: MessageRow[];
  total: number | null;
  total_is_estimate?: boolean;
  has_more: boolean;
  /** The backend's own `next_offset`, when it gave one. Used instead of
   *  `offset + rows` once every fetched row was emitted: a short page is not
   *  proof of the end, and the backend may skip rows. */
  next_offset?: number | null;
}

export type FetchInboxPage = (inbox_id: string, offset: number, limit: number) => Promise<InboxPage>;

const byDateDesc = (a: MessageRow, b: MessageRow) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);

/** Where each inbox starts for this page. `null` = exhausted. */
function startOffsets(inboxIds: readonly string[], cursor: PageCursor | null | undefined): PageCursor {
  const offsets: PageCursor = {};
  for (const id of inboxIds) offsets[id] = cursor ? (cursor[id] ?? null) : 0;
  // A first-page cursor has every inbox at 0; a later one may have nulls.
  if (cursor) for (const id of inboxIds) if (!(id in cursor)) offsets[id] = 0;
  return offsets;
}

/** The merge itself, over the answers in hand. Pure.
 *
 * Emits only the rows that are guaranteed to be next in date order. An inbox
 * that still has more may be hiding rows newer than its oldest fetched row,
 * so nothing older than that watermark (the "safe horizon") can be emitted
 * yet. Rows held back are simply fetched again on the next page (their
 * inbox's offset only advances by what was emitted). At least one inbox
 * always emits everything it fetched, so every page makes progress.
 *
 * `inboxIds` are the inboxes this merge speaks for; `pages` are the answers
 * of those among them that were asked (the ones not exhausted). */
export function mergeAnswered(inboxIds: readonly string[], offsets: PageCursor, pages: readonly InboxPage[]): MessagePage {
  const live = inboxIds.filter((id) => offsets[id] != null);

  let total: number | null = 0;
  let estimate = false;
  for (const p of pages) {
    if (p.total == null || total == null) total = null;
    else total += p.total;
    if (p.total_is_estimate) estimate = true;
  }
  // Exhausted inboxes were not fetched, so their totals are unknown here.
  if (live.length !== inboxIds.length) total = null;

  // Watermark: the newest "oldest fetched row" among inboxes that have more.
  let watermark: string | null = null;
  for (const p of pages) {
    if (!p.has_more) continue;
    const last = p.rows[p.rows.length - 1];
    if (!last) continue;
    if (watermark == null || last.date > watermark) watermark = last.date;
  }

  const emitted: MessageRow[] = [];
  const next: PageCursor = {};
  for (const id of inboxIds) if (offsets[id] == null) next[id] = null;
  for (const p of pages) {
    const safe = watermark == null ? p.rows : p.rows.filter((r) => r.date >= (watermark as string));
    emitted.push(...safe);
    const start = offsets[p.inbox_id] as number;
    const consumedAll = safe.length === p.rows.length;
    if (consumedAll && !p.has_more) next[p.inbox_id] = null;
    else if (consumedAll && p.next_offset != null && p.next_offset > start) next[p.inbox_id] = p.next_offset;
    else next[p.inbox_id] = start + safe.length;
  }
  emitted.sort(byDateDesc);

  const has_more = Object.values(next).some((v) => v != null);
  return { rows: emitted, total, total_is_estimate: estimate, has_more, next_cursor: has_more ? next : null };
}

/** Unified listing: a correct k-way merge over offset-paginated inboxes.
 *
 * Each call fetches up to `limit` rows from every inbox that is not exhausted
 * and merges the answers (see `mergeAnswered`).
 *
 * PROGRESS (`onPartial`, first page only). The answer waits for the slowest
 * inbox, and one cold, very large mailbox can take many seconds. With
 * `onPartial`, every answer that arrives while others are still out produces a
 * PROVISIONAL page: the merge of the inboxes that have answered so far, as if
 * they were the only ones. It is marked as such (`pending_inboxes`, no total,
 * no cursor): an inbox that has not answered could still contribute a row
 * newer than any of these, so the provisional page promises neither
 * completeness nor that a row keeps its position. Adding an inbox can only
 * raise the watermark, so each inbox's rows in a later provisional page (and
 * in the final one) are a prefix of its rows in an earlier one: rows may be
 * inserted between the ones shown, and rows below the new horizon leave
 * again until the next page fetches them, but nothing is reordered.
 *
 * Later pages get no provisional result: every row of a later page is at or
 * below the previous page's horizon, and an inbox that has not answered yet
 * may hold a newer one at its offset, so no row of it is safe to show before
 * that inbox answers.
 *
 * The resolved value is the same with and without `onPartial`. */
export async function mergeInboxPages(
  inboxIds: string[],
  cursor: PageCursor | null | undefined,
  limit: number,
  fetchInbox: FetchInboxPage,
  onPartial?: (page: MessagePage) => void,
): Promise<MessagePage> {
  const offsets = startOffsets(inboxIds, cursor);
  const live = inboxIds.filter((id) => offsets[id] != null);
  const answered = new Map<string, InboxPage>();
  const progressive = !!onPartial && !cursor && live.length > 1;

  await Promise.all(
    live.map(async (id) => {
      const page = await fetchInbox(id, offsets[id] as number, limit);
      answered.set(id, page);
      if (!progressive || answered.size >= live.length) return;
      const have = live.filter((x) => answered.has(x));
      const partial = mergeAnswered(
        have,
        offsets,
        have.map((x) => answered.get(x) as InboxPage),
      );
      onPartial?.({
        rows: partial.rows,
        total: null,
        total_is_estimate: true,
        has_more: true,
        next_cursor: null,
        pending_inboxes: live.filter((x) => !answered.has(x)),
      });
    }),
  );

  return mergeAnswered(
    inboxIds,
    offsets,
    live.map((id) => answered.get(id) as InboxPage),
  );
}
