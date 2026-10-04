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

/** Unified listing: a correct k-way merge over offset-paginated inboxes.
 *
 * Each call fetches up to `limit` rows from every inbox that is not exhausted,
 * then emits only the rows that are guaranteed to be next in date order. An
 * inbox that still has more may be hiding rows newer than its oldest fetched
 * row, so nothing older than that watermark can be emitted yet. Rows held back
 * are simply fetched again on the next page (their inbox's offset only advances
 * by what was emitted). At least one inbox always emits everything it fetched,
 * so every page makes progress.
 */
export async function mergeInboxPages(
  inboxIds: string[],
  cursor: PageCursor | null | undefined,
  limit: number,
  fetchInbox: FetchInboxPage,
): Promise<MessagePage> {
  const offsets: PageCursor = {};
  for (const id of inboxIds) offsets[id] = cursor ? (cursor[id] ?? null) : 0;
  // A first-page cursor has every inbox at 0; a later one may have nulls.
  if (cursor) for (const id of inboxIds) if (!(id in cursor)) offsets[id] = 0;

  const live = inboxIds.filter((id) => offsets[id] != null);
  const pages = await Promise.all(live.map((id) => fetchInbox(id, offsets[id] as number, limit)));

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
