// ---------------------------------------------------------------------------
// One honest pagination envelope for every list/search surface.
//
// Production, 2026-08-30, three separate lies in the same four fields:
//
//   * a subject search returning 14 results across 3 pages reported
//     `total: 201, total_is_estimate: true` on pages 1 and 2 (a 14x
//     overestimate) and `total: 14` on the last page;
//   * a label listing that returned 3 messages reported
//     `total: 0, total_is_estimate: false` — a count that contradicts the page
//     sitting next to it, and explicitly flagged as NOT an estimate;
//   * several responses returned `has_more: false` next to a populated
//     `next_offset` (e.g. `"has_more":false,"next_offset":50`), handing back an
//     offset that leads nowhere.
//
// `has_more` was truthful throughout, so pagination itself never broke. But
// `total` is what an agent uses to decide whether to paginate AT ALL and what
// to tell the user ("you have 201 messages about X" when there are 14), so a
// wrong total is a wrong answer even when every page is correct.
//
// The rules this module enforces, in one place, for every provider:
//
//   1. `total` NEVER contradicts the page. On a page with results it can never
//      be below what the caller has now seen (`offset + returned`), and when
//      `has_more` is true it must be strictly above it, because another result
//      demonstrably exists. A count that had to be raised to satisfy this is a
//      floor, not a measurement, so it comes back as an estimate. An EMPTY page
//      proves nothing and never moves the total.
//   2. `total_is_estimate: false` is reserved for counts that are actually
//      exact. Unknown stays `null` — never fabricated, never zero.
//   3. `next_offset` is null when `has_more` is false. An offset is a promise
//      that something is there.
//
// Pure and dependency-free so it can be unit-tested without a mailbox; see
// pagination-envelope.test.ts.
// ---------------------------------------------------------------------------

/** The four pagination fields every list/search result closes with. */
export interface PaginationEnvelope {
  /**
   * Number of matching items, or `null` when the provider cannot supply one.
   * Never below the number of items the caller has seen so far.
   */
  total: number | null;
  /**
   * True when `total` is a provider estimate or a floor derived from what has
   * been seen, rather than an exact count. False ONLY for exact counts.
   */
  total_is_estimate: boolean;
  has_more: boolean;
  /** Offset for the next page; `null` whenever `has_more` is false. */
  next_offset: number | null;
}

export interface PaginationInput {
  /** Items on THIS page (`messages.length`), not the window that was scanned. */
  returned: number;
  /** The offset that produced this page. */
  offset: number;
  /** Page size requested. */
  limit: number;
  /** The provider's count, or null/undefined when it cannot supply one. */
  total?: number | null;
  /** Whether the provider's count is an approximation. Defaults to false. */
  totalIsEstimate?: boolean;
  /** The provider's answer to "is there another page?". */
  hasMore: boolean;
}

/** Coerce to a non-negative integer; anything unusable becomes `fallback`. */
function nonNegativeInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  return floored < 0 ? fallback : floored;
}

/**
 * Reconciles a provider's raw count/cursor into an envelope that cannot
 * contradict the page it is attached to.
 *
 * The clamp is deliberately one-directional: a total that is too LOW is
 * provably wrong (the caller is holding results that disprove it), so it is
 * raised and demoted to an estimate. A total that is too HIGH cannot be
 * disproved from here — Gmail's `resultSizeEstimate` is simply approximate —
 * so it is left alone and stays flagged as an estimate. Callers that CAN
 * measure the exact figure (e.g. a Gmail page walk that ran out of pages)
 * should pass it with `totalIsEstimate: false` rather than fixing it here.
 */
export function buildPaginationEnvelope(input: PaginationInput): PaginationEnvelope {
  const returned = nonNegativeInt(input.returned, 0);
  const offset = nonNegativeInt(input.offset, 0);
  const limit = Math.max(1, nonNegativeInt(input.limit, 1));
  const hasMore = input.hasMore === true;

  // Everything the caller has now seen across this and all previous pages.
  const seen = offset + returned;
  // What the page in the caller's hands PROVES exists.
  //
  // An empty page proves nothing: asking for offset 100 of a 14-result search
  // legitimately returns nothing, and inflating the total to 100 there would
  // replace a correct count with a wrong one. Only a page with results on it
  // puts a floor under the total, and `has_more: true` on such a page adds one
  // more, because the provider is asserting another result exists behind it.
  const floor = returned > 0 ? seen + (hasMore ? 1 : 0) : 0;

  const rawTotal = input.total;
  let total: number | null =
    typeof rawTotal === "number" && Number.isFinite(rawTotal)
      ? Math.floor(rawTotal)
      : null;
  let totalIsEstimate = input.totalIsEstimate === true;

  if (total === null) {
    // Nothing to qualify: an unknown count is not an "estimate", it is absent.
    totalIsEstimate = false;
  } else if (total < floor) {
    // The page in the caller's hands disproves this count. Raise it to what we
    // can prove and stop claiming it is exact.
    total = floor;
    totalIsEstimate = true;
  }

  return {
    total,
    total_is_estimate: totalIsEstimate,
    has_more: hasMore,
    // Never hand back an offset that leads nowhere.
    next_offset: hasMore ? offset + limit : null,
  };
}

// ---------------------------------------------------------------------------
// contact_search
// ---------------------------------------------------------------------------

/**
 * `contact_search` result envelope.
 *
 * Two defects, one shape. It could not be paginated at all (the schema exposed
 * `limit` but no `offset`, and `total` merely echoed the page size, so there
 * was no way to tell whether more contacts matched and no way to reach them),
 * and it carried no `untrusted_content` marker even though `display_name` is
 * harvested verbatim from third-party mail headers — text a sender chooses.
 *
 * The scan behind it is bounded on purpose (a header-only pass over a recent
 * mail window, never a stored contact list), so pagination here walks the
 * correspondents that scan FOUND. When the window was full, more people may
 * exist behind it who no offset can reach; that is reported as
 * `total_is_estimate: true` plus an explicit `scan_truncated` flag rather than
 * papered over with a fabricated number.
 */
export interface ContactSearchEnvelope extends PaginationEnvelope {
  query: string;
  contacts: unknown[];
  /**
   * True when the bounded scan window was full (or an inbox was skipped), so
   * correspondents may exist beyond what any page can show. Narrow the query
   * rather than paging when this is true.
   */
  scan_truncated: boolean;
  /** Always true: display names come from other people's mail headers. */
  untrusted_content: true;
}

export interface ContactSearchInput<T> {
  query: string;
  /** Every matching correspondent the scan found, already sorted. */
  allContacts: T[];
  offset: number;
  limit: number;
  /**
   * True when the scan hit its bound (per-inbox message cap, inbox-count cap,
   * or an inbox that failed), meaning `allContacts` is a floor.
   */
  scanTruncated: boolean;
}

/**
 * Slices one page out of the scan's merged correspondent list and closes it
 * with the same pagination contract `email_read action: search` uses, so an
 * agent does not have to learn a second one.
 */
export function buildContactSearchEnvelope<T>(
  input: ContactSearchInput<T>,
): ContactSearchEnvelope {
  const offset = nonNegativeInt(input.offset, 0);
  const limit = Math.max(1, nonNegativeInt(input.limit, 1));
  const all = input.allContacts ?? [];
  const contacts = all.slice(offset, offset + limit);
  const hasMore = offset + contacts.length < all.length;

  const pagination = buildPaginationEnvelope({
    returned: contacts.length,
    offset,
    limit,
    // Exact for the scan window: every correspondent it saw is in `all`.
    total: all.length,
    // ...but the window itself may be a subset of the mailbox.
    totalIsEstimate: input.scanTruncated,
    hasMore,
  });

  return {
    query: input.query,
    contacts,
    ...pagination,
    scan_truncated: input.scanTruncated === true,
    untrusted_content: true,
  };
}
