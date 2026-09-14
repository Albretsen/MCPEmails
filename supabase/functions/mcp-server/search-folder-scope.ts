// ---------------------------------------------------------------------------
// search-folder-scope.ts — making `include_folders` mean one thing on Gmail and
// Outlook.
//
// ── The bug this exists to fix ─────────────────────────────────────────────
// `include_folders` is documented as "search only these folders". IMAP has
// always honoured it: searchImapMessages selects every listed mailbox in turn,
// merges the candidates and sorts them by date. Gmail and Outlook honoured it
// for exactly ONE entry and then, for two or more, fell through to a branch
// that searched the WHOLE mailbox:
//
//   if (includeFolders.length === 1) { …scope to that folder… }
//   else { …search everything… }
//
// So zero entries and five entries took the identical code path. A caller who
// asked for {Receipts, Invoices} got their inbox, their spam and their trash
// back, with no error, no note, and a `folder` field on every row that said
// "INBOX" whether or not that was true. That is a wrong-results bug: the
// narrower the caller made their constraint, the more confidently they would
// trust a result set that had quietly ignored it. Worse on the mutating twins
// (email_search_and_move / email_search_and_delete), where the widened set is
// what gets moved or deleted.
//
// The functions here are pure, and they are a separate module for the usual
// reason in this directory: index.ts calls `Deno.serve` at module load and
// exports nothing, so anything that only lives there can be pinned by a source
// scan and nothing more. Everything below can be run for real by a test.
//
// ── Why the two providers get different fixes ──────────────────────────────
// Because the two APIs disagree about what a folder IS.
//
// Gmail has labels, not folders, and messages.list `labelIds` is an AND: two
// ids there mean "carries both labels", which is the opposite of what
// `include_folders` asks for. Gmail's QUERY language does have the OR the
// caller wants — `{label:a label:b}` — so the constraint moves into `q` and the
// search stays ONE request. No fan-out, no merge, and `total` keeps meaning
// what it meant.
//
// Graph has real folders and no OR over them: `$search` cannot be combined with
// `$filter` on /messages, so `parentFolderId in (…)` is not available beside a
// keyword search, and the only honest way to scope to several folders is one
// request per folder against /me/mailFolders/{id}/messages, merged client-side.
// That costs N round trips inside a 30-second budget, so it is capped — and a
// cap that hides the folders it dropped would be the same class of bug this
// module exists to remove, so it reports them instead.
//
// ── Doc sources (researched 2026-09-14) ────────────────────────────────────
//   Gmail `labelIds` matches ALL the listed ids (AND), not any of them:
//     https://developers.google.com/workspace/gmail/api/guides/list-messages
//   Gmail `q` takes the web UI's operator syntax, including `label:`,
//   `{a b}` for OR, `( )` for grouping, `in:`/`is:`/`category:`, and
//   `in:anywhere` for "including Spam and Trash":
//     https://support.google.com/mail/answer/7190
//     https://developers.google.com/workspace/gmail/api/guides/filtering
//   Graph `$search` cannot be combined with `$filter` or `$orderby` on the
//   messages endpoint (see the policy note at the top of search-translate.ts):
//     https://learn.microsoft.com/en-us/graph/search-query-parameter
// ---------------------------------------------------------------------------

// ─────────────────────────────────────────────────────────────────────────────
// Gmail
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gmail system label id → the search operator that selects it.
 *
 * A system label cannot be addressed as `label:<id>` in every case (there is no
 * `label:draft`; drafts are `in:drafts`), and the operators below are the ones
 * Gmail's own operator reference lists, so they are used in preference to
 * guessing that the id doubles as a name. Anything not in this table is a user
 * label and is addressed by NAME through {@link gmailLabelQueryTerm}.
 */
const GMAIL_SYSTEM_LABEL_TERMS: Record<string, string> = {
  INBOX: "in:inbox",
  SENT: "in:sent",
  DRAFT: "in:drafts",
  DRAFTS: "in:drafts",
  TRASH: "in:trash",
  SPAM: "in:spam",
  STARRED: "is:starred",
  IMPORTANT: "is:important",
  UNREAD: "is:unread",
  CATEGORY_PERSONAL: "category:primary",
  CATEGORY_SOCIAL: "category:social",
  CATEGORY_PROMOTIONS: "category:promotions",
  CATEGORY_UPDATES: "category:updates",
  CATEGORY_FORUMS: "category:forums",
};

/**
 * The label ids in `labelIds` that are NOT system labels, i.e. the ones whose
 * display name has to be looked up before they can appear in a query.
 *
 * Exists so the caller can skip the labels.list round trip entirely for the
 * common case — a search across INBOX and SENT needs no lookup at all.
 */
export function gmailLabelIdsNeedingNames(labelIds: string[]): string[] {
  return labelIds.filter((id) => !(id.toUpperCase() in GMAIL_SYSTEM_LABEL_TERMS));
}

/**
 * Quote a Gmail label name for the `label:` operator.
 *
 * Gmail's search box has no escape mechanism inside a quoted phrase, so an
 * embedded double quote is STRIPPED rather than escaped — the same rule
 * `quoteGmail` in search-translate.ts applies to every other operand, and the
 * same rule Gmail's own UI is stuck with: a label whose name contains a quote
 * cannot be searched for by name there either. Stripping narrows the query at
 * worst; it can never widen it past the label set, which is the property this
 * whole module is about.
 */
function quoteGmailLabelName(name: string): string {
  const cleaned = name.replace(/"/g, "").trim();
  if (cleaned === "") return '""';
  return /^[A-Za-z0-9_-]+$/.test(cleaned) ? cleaned : `"${cleaned}"`;
}

/**
 * The single search term that selects one resolved Gmail label.
 *
 * `labelId` is what `resolveFolderId` handed back: a system label id, a
 * `Label_NN` user-label id, or (for an entry that was already a name) the name
 * itself. `nameById` is the labels.list mapping; an id missing from it is
 * treated as a name, which is what an unresolved pass-through entry is.
 */
export function gmailLabelQueryTerm(
  labelId: string,
  nameById: Record<string, string> = {},
): string {
  const system = GMAIL_SYSTEM_LABEL_TERMS[labelId.toUpperCase()];
  if (system) return system;
  return `label:${quoteGmailLabelName(nameById[labelId] ?? labelId)}`;
}

/**
 * The `q` fragment that restricts a search to exactly `labelIds`, or null when
 * there is nothing to restrict.
 *
 * Single entry → the bare term. Several → Gmail's brace form, which is its OR:
 * `{in:inbox label:"Q3 Receipts"}` reads as "in the inbox OR labelled Q3
 * Receipts". Gmail labels are not mutually exclusive, so a message carrying two
 * of the listed labels matches once, not twice — which is the semantics the
 * caller wants and the reason this is a query rather than a union of N result
 * sets that would have to be de-duplicated.
 *
 * `in:anywhere` is appended whenever Trash or Spam is among the listed labels.
 * Gmail search omits both by default, so `{in:inbox in:trash}` without it would
 * return the inbox half and silently drop the half the caller had to go out of
 * their way to ask for. It widens the SCOPE, not the label set: the brace group
 * still has to match.
 */
export function gmailFolderScopeQuery(
  labelIds: string[],
  nameById: Record<string, string> = {},
): string | null {
  if (labelIds.length === 0) return null;

  const terms = labelIds.map((id) => gmailLabelQueryTerm(id, nameById));
  const group = terms.length === 1 ? terms[0] : `{${terms.join(" ")}}`;

  const reachesHiddenMail = labelIds.some((id) => {
    const upper = id.toUpperCase();
    return upper === "TRASH" || upper === "SPAM";
  });
  return reachesHiddenMail ? `${group} in:anywhere` : group;
}

/**
 * Combine the translated search with the folder-scope fragment.
 *
 * The existing query is parenthesised rather than concatenated, because `raw`
 * is appended to it verbatim and may legitimately contain a top-level `OR`
 * ("from:amy OR from:david"). Joined with a bare space, the brace group would
 * then bind to the last alternative instead of to the whole query, and the
 * search would return mail from folders the caller excluded — the very bug
 * being fixed, reintroduced one precedence level down.
 */
export function applyGmailFolderScope(query: string, scope: string | null): string {
  if (!scope) return query;
  const trimmed = query.trim();
  return trimmed === "" ? scope : `(${trimmed}) ${scope}`;
}

/**
 * Which of the caller's requested folders a returned message should be reported
 * under.
 *
 * Gmail returns the message's whole label set, and a message can carry several
 * of the requested labels at once, so this prefers the FIRST requested label the
 * message actually has — a stable, caller-ordered answer rather than whichever
 * label Gmail happened to list first. `fallback` is used when the request was
 * unscoped, or (defensively) when nothing intersects.
 */
export function gmailResultFolder(
  messageLabelIds: string[],
  requestedFolders: string[],
  fallback: string,
): string {
  for (const requested of requestedFolders) {
    if (messageLabelIds.some((l) => l.toUpperCase() === requested.toUpperCase())) {
      return requested;
    }
  }
  return fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// Outlook
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many folders one Outlook search may fan out over.
 *
 * Graph gives no way to ask for several folders at once here, so each listed
 * folder is its own HTTP request. They are issued in parallel, which makes the
 * wall-clock cost the slowest leg rather than the sum — but not the THROTTLING
 * cost, which Exchange Online meters per mailbox and answers with 429s that the
 * search has no budget left to retry. Five is the point where the slowest leg of
 * a `$search` still leaves room inside the 30-second tool budget to fetch and
 * assemble the page.
 *
 * A cap is only defensible because going over it is reported rather than
 * quietly applied; see {@link planOutlookFolderFanout}.
 */
export const OUTLOOK_FOLDER_FANOUT_CAP = 5;

export interface OutlookFanoutPlan {
  /** The folders this search will actually cover, in the caller's order. */
  searched: string[];
  /** Folders the cap left out. Empty in every case but an over-long request. */
  skipped: string[];
  /** The caller-visible note, or null when the request fits under the cap. */
  note: string | null;
}

/**
 * Decide which listed folders one Outlook search covers.
 *
 * Under the cap this is the identity: every folder is searched and there is
 * nothing to say. Over it, the request is TRUNCATED rather than widened — the
 * results still come only from folders the caller asked for — and the note
 * names both halves explicitly, so the caller can see which folders were left
 * out and re-run the search over them. Naming them is the whole point: a bare
 * "some folders were skipped" would leave the caller in the same position as
 * the silent widening, holding a result set whose coverage they cannot state.
 */
export function planOutlookFolderFanout(
  folders: string[],
  cap: number = OUTLOOK_FOLDER_FANOUT_CAP,
): OutlookFanoutPlan {
  if (folders.length <= cap) {
    return { searched: [...folders], skipped: [], note: null };
  }
  const searched = folders.slice(0, cap);
  const skipped = folders.slice(cap);
  return {
    searched,
    skipped,
    note:
      `include_folders listed ${folders.length} folders and Microsoft Graph has no way to ` +
      `search several folders in one request, so this search covered the first ${cap} of ` +
      `them and stopped there: ${searched.join(", ")}. NOT searched: ${skipped.join(", ")}. ` +
      `No message from an unlisted folder is in these results — the coverage is narrower ` +
      `than you asked for, not wider. Run the search again with include_folders set to the ` +
      `folders that were not searched to cover the rest.`,
  };
}

/** One folder's worth of an Outlook fan-out, as it comes back from Graph. */
export interface OutlookFolderPage<T> {
  /** The folder this leg asked for, reported verbatim on each of its messages. */
  folder: string;
  /** The messages Graph returned for that folder, in whatever order it chose. */
  messages: T[];
  /**
   * Graph's exact match count for the folder (`@odata.count`), or null when the
   * request could not ask for one. `$count` is rejected alongside `$search`, so
   * this is null for every keyword search and a real number for a `$filter` one.
   */
  count: number | null;
  /** Whether Graph offered an `@odata.nextLink` for this folder. */
  hasNextPage: boolean;
}

export interface OutlookMergedPage<T> {
  /** The requested window, newest first, each message tagged with its folder. */
  page: { folder: string; message: T }[];
  /**
   * The exact total across every searched folder, or null when any leg could not
   * supply one. Outlook folders are disjoint — a message lives in exactly one —
   * so summing per-folder counts double-counts nothing. Null is deliberate and
   * unchanged from the single-folder behaviour: `$search` cannot return a count
   * and a fabricated one would be worse than an admitted absence.
   */
  total: number | null;
  hasMore: boolean;
}

/**
 * Merge the fan-out into one page.
 *
 * Graph `$search` returns relevance order and refuses `$orderby`, so every leg
 * arrives unsorted with respect to date and the legs have to be interleaved by
 * date before the window is cut — exactly what searchImapMessages does across
 * mailboxes, and for the same reason: paginating per folder and concatenating
 * would put every message from the first folder ahead of a newer one from the
 * second.
 *
 * `hasMore` is true when any leg still had a `nextLink` (there is more mail in
 * that folder than this request read) or when the merged candidate pool already
 * overflows the requested window.
 */
export function mergeOutlookFolderPages<T>(
  pages: OutlookFolderPage<T>[],
  offset: number,
  limit: number,
  dateOf: (message: T) => string | undefined,
): OutlookMergedPage<T> {
  const candidates: { folder: string; message: T }[] = [];
  for (const p of pages) {
    for (const message of p.messages) candidates.push({ folder: p.folder, message });
  }

  // Newest first. An unparseable or absent date sorts last rather than jumping
  // to the front, which is what a NaN comparison would otherwise do.
  const sorted = candidates.slice().sort((a, b) => {
    const da = Date.parse(dateOf(a.message) ?? "");
    const db = Date.parse(dateOf(b.message) ?? "");
    const va = Number.isFinite(da) ? da : -Infinity;
    const vb = Number.isFinite(db) ? db : -Infinity;
    return vb - va;
  });

  const total = pages.every((p) => p.count !== null)
    ? pages.reduce((sum, p) => sum + (p.count ?? 0), 0)
    : null;

  return {
    page: sorted.slice(offset, offset + limit),
    total,
    hasMore: pages.some((p) => p.hasNextPage) || sorted.length > offset + limit,
  };
}
