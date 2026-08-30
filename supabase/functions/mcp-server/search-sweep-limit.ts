// ---------------------------------------------------------------------------
// search-sweep-limit.ts - "did the sweep finish, or did it just stop?"
//
// `email_search_and_move` and `email_search_and_delete` run a search and act on
// what it returned. The search is bounded by `limit` (default and ceiling
// MAX_BULK_IDS). Until this module existed, a sweep that matched three messages
// with limit:1 returned:
//
//   {"succeeded":1,"failed":0,"operation":"email_search_and_move", ...}
//
// which is byte-for-byte what a sweep that finished the job returns. An agent
// told to "file everything from Acme" reported the mailbox tidy having touched
// a third of it, and on the delete side the same shape means "I deleted them
// all" when most are still there.
//
// This is a DIFFERENT truncation from the one bulk-budget.ts reports. That one
// is "I ran out of wall clock partway through the ids I had"; this one is "the
// search never handed me all the ids in the first place". A call can hit both,
// and the two signals are emitted side by side.
//
// Pure: no I/O, no imports. Every input comes from the search result and the
// bulk result the handler already holds.
// ---------------------------------------------------------------------------

export interface SearchSweepLimitInput {
  /** "move" or "delete" - only used to word the notice. */
  verb: "move" | "delete";
  /** How many message ids the search actually returned (never exceeds `limit`). */
  matched: number;
  /** The effective limit applied to the search. */
  limit: number;
  /** How many of the matched messages the operation actually processed. */
  processed: number;
  /**
   * The provider's total match count when it supplies one, else null.
   * Exact on IMAP/Fastmail, an estimate on Gmail, absent on some Outlook queries.
   */
  totalMatches?: number | null;
  /** True when `totalMatches` is a provider estimate rather than a count. */
  totalIsEstimate?: boolean;
  /**
   * The provider's own "there is another page" signal, when it gave one.
   * This is the STRONGEST evidence and is trusted over the `matched >= limit`
   * heuristic in both directions.
   */
  providerHasMore?: boolean;
}

export interface SearchSweepLimitFields {
  /** Ids the search returned, i.e. the most this call could ever have acted on. */
  match_count: number;
  /** The limit that bounded the search. */
  limit: number;
  /**
   * True when the search filled its window, so it stopped counting rather than
   * running out of matches. On its own this does NOT prove more mail exists
   * (a query matching exactly `limit` messages sets it too) - `has_more` is the
   * claim about mail left behind.
   */
  limit_reached: boolean;
  /**
   * True when messages matching the query were left UNTOUCHED because of the
   * limit. This is the field a caller should branch on before reporting the
   * sweep complete.
   */
  has_more: boolean;
  /** Provider match total when known. Omitted when the provider gave none. */
  total_matches?: number;
  /** True when `total_matches` is an estimate (Gmail). Omitted otherwise. */
  total_matches_is_estimate?: boolean;
  /**
   * Plain-language statement of the shortfall. Present ONLY when `has_more`, so
   * its mere presence means "this did not finish".
   */
  limit_notice?: string;
}

/**
 * Computes the truncation signal for one search-driven sweep.
 *
 * Decision order, most trustworthy evidence first:
 *   1. The provider said whether another page exists -> believe it.
 *   2. The provider gave a total larger than what came back -> more exist.
 *   3. Neither -> fall back to "the window was filled", which errs toward
 *      warning. For a destructive sweep an unnecessary "check for more" is a
 *      cheap mistake; a missed one is the bug this module was written for.
 *
 * `has_more` is always emitted, including on a clean finish and on zero matches,
 * so a caller may rely on the field existing rather than inferring truncation
 * from its absence.
 */
export function searchSweepLimitFields(
  input: SearchSweepLimitInput,
): SearchSweepLimitFields {
  const matched = Math.max(0, Math.floor(input.matched));
  const limit = Math.max(0, Math.floor(input.limit));
  const processed = Math.max(0, Math.floor(input.processed));
  const total = typeof input.totalMatches === "number" && input.totalMatches >= 0
    ? Math.floor(input.totalMatches)
    : null;

  const limitReached = limit > 0 && matched >= limit;

  // A search that came back short of its own limit cannot have left anything
  // behind BECAUSE of the limit, whatever the provider's paging flag says: it
  // ran out of matches before the window filled. That gate comes first so an
  // estimate-happy provider cannot cry truncation on a finished sweep.
  const proofOfMore = total !== null && total > matched;
  let hasMore: boolean;
  if (!limitReached) {
    hasMore = false;
  } else if (proofOfMore) {
    hasMore = true;
  } else if (typeof input.providerHasMore === "boolean") {
    // Only a POSITIVE denial from the provider clears a filled window. Its
    // "yes" is believed too, but that case is already covered above or lands
    // here as true.
    hasMore = input.providerHasMore;
  } else {
    // Window full, provider silent: assume mail was left behind. An unnecessary
    // "check for more" costs one call; a missed one is the bug this fixes.
    hasMore = true;
  }

  const fields: SearchSweepLimitFields = {
    match_count: matched,
    limit,
    limit_reached: limitReached,
    has_more: hasMore,
  };
  if (total !== null) {
    fields.total_matches = total;
    if (input.totalIsEstimate) fields.total_matches_is_estimate = true;
  }
  if (hasMore) {
    fields.limit_notice = buildLimitNotice(input.verb, processed, limit, total, !!input.totalIsEstimate);
  }
  return fields;
}

/**
 * The sentence a model reads when it is about to say "done".
 *
 * It names the operation, the number actually acted on, and the exact next call,
 * because "some remain" without a way to continue just moves the guesswork.
 */
function buildLimitNotice(
  verb: "move" | "delete",
  processed: number,
  limit: number,
  total: number | null,
  totalIsEstimate: boolean,
): string {
  const past = verb === "move" ? "moved" : "deleted";
  const remainder = total !== null && total > processed
    ? (totalIsEstimate
      ? `Roughly ${total - processed} more match the query (the provider's count is an estimate).`
      : `${total - processed} more match the query.`)
    : "More messages match the query.";
  return `INCOMPLETE: this ${past} ${processed} message${processed === 1 ? "" : "s"}, ` +
    `the most the limit of ${limit} allowed. ${remainder} ` +
    `Do not report the mailbox as fully swept. Repeat the same call (raising ` +
    `limit, or running it again) until has_more is false.`;
}
