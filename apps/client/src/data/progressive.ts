import type { QueryKey } from "@tanstack/react-query";
import type { MailApi, PartialPageListener } from "../api/mail-api";
import type { FolderRef, MailboxScope, MessageKey, MessagePage, MessageRow, PageCursor } from "../api/types";
import type { ListData } from "./cache";
import { queryClient } from "./query-client";

/* The unified list, as each mailbox answers.
 *
 * `MailApi.listMessages` hands over a provisional first page every time a
 * mailbox answers while others are still out (see `mergeInboxPages`). Those
 * pages are written into the query cache here, while the query's own fetch is
 * still running, so the list paints what it has instead of waiting for the
 * slowest mailbox. The fetch's final answer then replaces them.
 *
 * What a provisional page changes in the cache:
 *   - nothing cached yet: it becomes page 1;
 *   - rows cached from an earlier load: the mailboxes that have answered get
 *     their fresh rows, the ones still out keep the rows they had. Nothing
 *     that is on screen is taken away while its mailbox has not answered.
 * The page keeps `pending_inboxes`, has no total and no cursor: it does not
 * claim to be complete, and paging waits for the real page.
 */

export interface ListPageRequest {
  scope: MailboxScope;
  folder: FolderRef;
  /** Trimmed; non-empty = a search (the folder is ignored). */
  query: string;
  cursor: PageCursor | null;
  limit: number;
  queryKey: QueryKey;
  signal: AbortSignal;
  /** Called with the keys of rows that arrived into a list that was already
   *  showing rows (a mailbox that answered after the others). */
  onArrived?: (keys: MessageKey[]) => void;
}

/** One page of a message list: the query function of `useMessageList`.
 *  The first page of a unified list is written to the cache as each mailbox
 *  answers; every other page arrives whole. */
export async function loadListPage(api: MailApi, r: ListPageRequest): Promise<MessagePage> {
  const progressive = r.scope === "all" && r.cursor == null;
  const onPartial: PartialPageListener | undefined = progressive
    ? (partial) => {
        if (!r.signal.aborted) r.onArrived?.(writePartialPage(r.queryKey, partial));
      }
    : undefined;
  const page = await (r.query
    ? api.searchMessages({ scope: r.scope, query: r.query, limit: r.limit, cursor: r.cursor }, r.signal, onPartial)
    : api.listMessages({ scope: r.scope, folder: r.folder, limit: r.limit, cursor: r.cursor }, r.signal, onPartial));
  // The last mailbox to answer: its rows go between the ones on screen.
  if (progressive && !r.signal.aborted) r.onArrived?.(settleFirstPage(r.queryKey, page));
  return page;
}

const byDateDesc =(a: MessageRow, b: MessageRow) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);

function keysOf(data: ListData | undefined): Set<MessageKey> {
  const out = new Set<MessageKey>();
  for (const page of data?.pages ?? []) for (const r of page.rows) out.add(r.key);
  return out;
}

/** The provisional page merged into what the cache holds. Pure. */
export function mergePartialPage(old: ListData | undefined, partial: MessagePage): ListData {
  const first = old?.pages[0];
  if (!old || !first) return { pages: [partial], pageParams: [null] };
  const pending = new Set(partial.pending_inboxes ?? []);
  const fresh = new Set(partial.rows.map((r) => r.key));
  const kept = first.rows.filter((r) => pending.has(r.inbox_id) && !fresh.has(r.key));
  const rows = kept.length ? [...partial.rows, ...kept].sort(byDateDesc) : partial.rows;
  return { ...old, pages: [{ ...partial, rows }, ...old.pages.slice(1)] };
}

/** Rows of `page` the list was not showing before. */
function arrivals(before: ListData | undefined, page: MessagePage): MessageKey[] {
  const had = keysOf(before);
  // An empty list has nothing to keep still: its first rows are just shown.
  if (!had.size) return [];
  return page.rows.filter((r) => !had.has(r.key)).map((r) => r.key);
}

/** Writes a provisional page. Returns the keys that are new to the list. */
export function writePartialPage(key: QueryKey, partial: MessagePage): MessageKey[] {
  const before = queryClient.getQueryData<ListData>(key);
  queryClient.setQueryData<ListData>(key, mergePartialPage(before, partial));
  return arrivals(before, partial);
}

/** The real first page has arrived. Returns the keys that are new to the list
 *  as it stands. When the cache is showing a provisional page, the real one
 *  takes its place now: a list with several pages loaded refetches them one
 *  after the other, and only then replaces its data. */
export function settleFirstPage(key: QueryKey, page: MessagePage): MessageKey[] {
  const before = queryClient.getQueryData<ListData>(key);
  const first = before?.pages[0];
  if (before && first?.pending_inboxes?.length) {
    queryClient.setQueryData<ListData>(key, { ...before, pages: [page, ...before.pages.slice(1)] });
  }
  return arrivals(before, page);
}
