// ---------------------------------------------------------------------------
// One page of an IMAP mailbox listing, newest first.
//
// ── What this replaces ──────────────────────────────────────────────────────
// email_list used to run `UID SEARCH ALL` after every SELECT: the server walks
// the mailbox and sends back EVERY UID in it, and the handler sorts them to
// keep the newest twenty. On a 40,000-message inbox that is a quarter of a
// megabyte of digits and a full index walk, per call, to learn two things the
// SELECT reply had already said for free: how many messages there are
// (`* n EXISTS`) and, because sequence numbers run in ascending UID order
// (RFC 3501 2.3.1.2), where the newest ones sit (at the end).
//
// So the unfiltered listing now asks for the page directly, by sequence range,
// and each row carries its own UID: SELECT, FETCH. One command fewer, and the
// one that is gone was the only one whose cost grew with the mailbox.
//
// ── Why the answer is the same ──────────────────────────────────────────────
// "Newest first" has always meant highest UID first here. The UIDs of a
// mailbox, ascending, ARE its sequence numbers 1..n, so "sort every UID
// descending and take [offset, offset + limit)" names exactly the messages at
// sequence numbers (n - offset - limit + 1)..(n - offset). `total` was the
// number of UIDs the search returned, which is n.
//
// ── When it does not hold, the old path runs ───────────────────────────────
// A sequence number is a snapshot. If another client expunges a message
// between our SELECT and our FETCH, the server may leave that row out of the
// reply or refuse the command (RFC 2180 4.1). Either way the reply no longer
// has one row per sequence number asked for, and the page is fetched the old
// way instead, by UID SEARCH and UID FETCH on the same connection. The same
// fallback covers a server that omits EXISTS. Nothing is guessed: either the
// range came back whole, or the search decides.
//
// A read or unread filter needs the server to do the filtering, so it keeps
// SEARCH (UNSEEN or SEEN), exactly as before.
//
// Kept out of index.ts so it can be run against a scripted server and held
// equal to the implementation it replaces; see imap-list-page.test.ts.
// ---------------------------------------------------------------------------

import type { ImapMessageSummary } from "./imap-client.ts";

/** The slice of `ImapClient` a listing needs. Structural, so a test can fake it. */
export interface ImapListPageClient {
  selectedMessageCount(): number | null;
  uidSearch(criteria: string): Promise<number[]>;
  fetchSummaries(uids: number[]): Promise<ImapMessageSummary[]>;
  fetchSummariesBySequence(first: number, last: number): Promise<ImapMessageSummary[] | null>;
}

export interface ImapListPage {
  /** Messages in the mailbox that match the filter. Exact, never an estimate. */
  total: number;
  /** The UIDs on this page, newest (highest) first. */
  pageUids: number[];
  /** A summary per page UID the server still had, in no particular order. */
  summaries: ImapMessageSummary[];
}

export interface ImapListPageRequest {
  limit: number;
  offset: number;
  /** true = unread only; false = read only; undefined = both. */
  unread: boolean | undefined;
}

/**
 * Fetch one page of the SELECTED mailbox. The caller must have just issued the
 * SELECT on this client: the sequence-range path reads the count that SELECT
 * reported.
 */
export async function fetchImapListPage(
  client: ImapListPageClient,
  request: ImapListPageRequest,
): Promise<ImapListPage> {
  if (request.unread === undefined) {
    const page = await newestBySequenceRange(client, request.limit, request.offset);
    if (page) return page;
  }
  return await pageBySearch(client, request);
}

/**
 * The page as a sequence range, or null when that cannot be trusted and the
 * search path has to answer instead.
 */
async function newestBySequenceRange(
  client: ImapListPageClient,
  limit: number,
  offset: number,
): Promise<ImapListPage | null> {
  const exists = client.selectedMessageCount();
  if (exists === null) return null;
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(offset) || offset < 0) return null;

  // An empty mailbox, or an offset past its end: nothing to fetch, and the
  // search path would have issued no FETCH for it either.
  const last = exists - offset;
  if (last < 1) return { total: exists, pageUids: [], summaries: [] };
  const first = Math.max(1, last - limit + 1);

  const rows = await client.fetchSummariesBySequence(first, last);
  // One row per sequence number, each with a distinct UID, or the snapshot the
  // range was computed from is no longer the mailbox.
  if (rows === null || rows.length !== last - first + 1) return null;
  const pageUids = rows.map((row) => row.uid);
  if (new Set(pageUids).size !== pageUids.length) return null;

  pageUids.sort((a, b) => b - a);
  return { total: exists, pageUids, summaries: rows };
}

/** The original path: every matching UID, newest first, then one UID FETCH. */
async function pageBySearch(
  client: ImapListPageClient,
  request: ImapListPageRequest,
): Promise<ImapListPage> {
  const allUids = await client.uidSearch(
    request.unread === true ? "UNSEEN" : request.unread === false ? "SEEN" : "ALL",
  );
  // Newest first: highest UID first.
  const ordered = allUids.slice().sort((a, b) => b - a);
  const pageUids = ordered.slice(request.offset, request.offset + request.limit);
  const summaries = await client.fetchSummaries(pageUids);
  return { total: allUids.length, pageUids, summaries };
}
