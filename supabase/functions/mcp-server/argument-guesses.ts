// ---------------------------------------------------------------------------
// What an argument name a model GUESSED should have been.
//
// argument-remedies.ts covers arguments that exist somewhere on the tool and
// were sent to the wrong operation. This covers names that exist nowhere, the
// ones the validator can only call "not allowed". Read-out of 2026-10-18 over
// the -32602 rows after PR #115 (external workspaces only):
//
//   email_read search, one workspace, 10-18 03:35..03:39 UTC:
//     after; search; imap_query; criteria (x2); search_query; search_criteria;
//     imap_search; filter; filters; date_after+date_before;
//     since_date+before_date; received_after+received_before;
//     after_date+before_date; start_date+end_date; then since+before, which
//     exist and were refused for their format, then a success.
//     Seventeen refusals, each "arguments.<name> is not allowed." and nothing
//     else, so every retry was another guess. include_body (5, 10-16..10-19).
//   email_read list, same workspace: until; since_date+before_date.
//   email_read read, missing message_id: 18 in five seconds (one workspace,
//     10-19 11:22 UTC), one parallel fan-out, every call "is required" and
//     nothing about where an id comes from.
//
// Nothing here is accepted in silence. A guessed date name has no single
// meaning to map to: "until" and "end_date" are inclusive to most people and
// `before` is strict, and "after" is strict where `since` is not, so quietly
// rewriting them would move the edge of the range the caller asked for. The
// argument is still refused; the refusal now says which argument does exist.
//
// Every fact names only arguments the refused operation takes (the caller
// passes that list in), so it is true on the consolidated and per-operation
// surfaces alike. When the operation has no such argument, `elsewhere` lets
// the caller name the sibling that does, in that surface's own words.
//
// Declarative, never imperative, for the reason set out in
// invalid-arguments-message.ts. Paths and keywords are untouched, so the
// persisted classification is the same as before.
//
// Pure and dependency-free so the wording can be tested without booting the
// server.
// ---------------------------------------------------------------------------

import type { SchemaErrorLike } from "./argument-remedies.ts";

/** The structured search criteria, in the order the schemas list them. */
const SEARCH_CRITERIA = [
  "from",
  "to",
  "cc",
  "subject",
  "body",
  "text",
  "unread",
  "has_attachment",
  "flagged",
  "since",
  "before",
] as const;

interface GuessGroup {
  /** Names models write, normalised to lower snake case. */
  names: readonly string[];
  /**
   * The fact, given every argument the refused operation takes, or "" when
   * the operation has nothing to point at. Only arguments in `allowed` may be
   * named.
   */
  fact: (allowed: ReadonlySet<string>) => string;
  /** The arguments to look for on a sibling when `fact` is "". */
  elsewhere?: readonly string[];
}

const GUESS_GROUPS: readonly GuessGroup[] = [
  {
    names: [
      "after", "start", "start_date", "from_date", "date_from", "date_after",
      "after_date", "since_date", "received_after", "received_since",
      "newer_than", "min_date", "date_start",
      "until", "end", "end_date", "to_date", "date_to", "date_before",
      "before_date", "until_date", "received_before", "older_than",
      "max_date", "date_end", "date_range", "dates",
    ],
    fact: (allowed) =>
      allowed.has("since") && allowed.has("before")
        ? "dates are filtered with since (on or after) and before (strictly " +
          "before), each a year-first date such as 2026-10-01"
        : "",
    elsewhere: ["since", "before"],
  },
  {
    names: [
      "search", "search_query", "search_criteria", "search_string", "search_term",
      "search_terms", "criteria", "filter", "filters", "imap_query",
      "imap_search", "imap_criteria", "q", "keyword", "keywords",
    ],
    fact: (allowed) => {
      const criteria = SEARCH_CRITERIA.filter((name) => allowed.has(name));
      if (criteria.length === 0) return "";
      return `the search criteria are separate top-level arguments (${criteria.join(", ")})` +
        (allowed.has("query") ? ", and query takes the provider's own search syntax" : "");
    },
  },
  {
    names: [
      "include_body", "with_body", "fetch_body", "full_body", "body_text",
      "include_content", "full_content", "include_text",
    ],
    // Only where results are summaries: the operation pages (offset) and has
    // no body window of its own.
    fact: (allowed) =>
      allowed.has("offset") && !allowed.has("body_max_chars")
        ? "results here are summaries without bodies, and a message's body " +
          "comes from reading it by its message_id"
        : "",
  },
  {
    // email_attachment, read-out of 2026-10-26: attachment_id, attachment_name.
    names: [
      "attachment_id", "attachment_name", "attachment", "attachment_filename",
      "file_name", "file_id", "part_id", "content_id", "attachment_number",
    ],
    fact: (allowed) =>
      allowed.has("attachment_index") && allowed.has("filename")
        ? "an attachment is chosen by attachment_index or filename, as reading " +
          "its message lists them"
        : "",
  },
];

const GUESS_BY_NAME: ReadonlyMap<string, GuessGroup> = new Map(
  GUESS_GROUPS.flatMap((group) => group.names.map((name) => [name, group] as const)),
);

/** Marks the inbox listing fact as stated, beside the groups. */
const INBOX_LISTING = Symbol("inbox_listing");

/** Facts for a required argument, by name, when it is missing. */
const REQUIRED_FACTS: Readonly<Record<string, string>> = {
  message_id: "it is the id each message carries in a list or search result",
  message_ids: "they are the ids messages carry in a list or search result",
};

/**
 * inbox_list's own arguments. Any other argument on it (limit, query,
 * include_stats: 16 refusals in 30 days to 2026-10-26, most of them `limit`,
 * and several in a workspace's first hour) gets this fact: there is nothing
 * to page or search, and three arguments narrow the list.
 */
function inboxListingFact(allowed: ReadonlySet<string>): string {
  return allowed.has("inbox") && allowed.has("provider") && allowed.has("service") &&
      !allowed.has("message_id")
    ? "it returns every inbox in one call, and inbox (an email address or " +
      "inbox_id), provider or service narrow it"
    : "";
}

/** The date arguments, for a value of the wrong JSON type (a number, an object). */
const DATE_ARGUMENTS = new Set(["since", "before"]);
const DATE_TYPE_FACT = "it takes a string with the year first, such as " +
  "\"2026-10-01\", \"today\" or \"7 days ago\"";

function normalise(name: string): string {
  return name.trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * Add the fact that answers a guessed or missing argument.
 *
 * @param subject   how the refused operation is named in the message: the tool
 *                  (`email_search`) or the action (`action 'search'`).
 * @param allowed   every argument the refused operation takes.
 * @param elsewhere for a date guess on an operation with no date filter: a
 *                  clause naming where since and before are taken, or null.
 */
export function withGuessedArgumentHints<T extends SchemaErrorLike>(
  errors: readonly T[],
  subject: string,
  allowed: readonly string[],
  elsewhere: (canonical: readonly string[]) => string | null = () => null,
  rootPath = "arguments",
): T[] {
  const allowedSet = new Set(allowed);
  const prefix = `${rootPath}.`;
  // start_date and end_date in one call get the fact once, not twice.
  const stated = new Set<GuessGroup | typeof INBOX_LISTING>();
  return errors.map((error) => {
    if (!error.path.startsWith(prefix)) return error;
    const property = error.path.slice(prefix.length);
    if (property.includes(".") || property.includes("[")) return error;

    if (error.keyword === "required") {
      // On email_attachment the id is the message's, not the attachment's.
      const fact = property === "message_id" && allowedSet.has("attachment_index")
        ? "it is the id of the message that carries the attachment, from a list or search result"
        : REQUIRED_FACTS[property];
      return fact && error.message === "is required"
        ? { ...error, message: `is required; ${fact}` }
        : error;
    }

    if (error.keyword === "type" && DATE_ARGUMENTS.has(property) && allowedSet.has(property)) {
      return { ...error, message: `${error.message}; ${DATE_TYPE_FACT}` };
    }

    // Only the validator's bare wording: a refusal another rewrite already
    // explained (a sibling's argument, a remedy) keeps its own sentence.
    if (error.keyword !== "additionalProperties" || error.message !== "is not allowed") {
      return error;
    }
    const group = GUESS_BY_NAME.get(normalise(property));
    const listing = inboxListingFact(allowedSet);
    if (listing && (!group || !group.fact(allowedSet))) {
      if (stated.has(INBOX_LISTING)) return { ...error, message: `is not an argument of ${subject} either` };
      stated.add(INBOX_LISTING);
      return { ...error, message: `is not an argument of ${subject}; ${listing}` };
    }
    if (!group) return error;
    const fact = group.fact(allowedSet);
    if (fact) {
      if (stated.has(group)) return { ...error, message: `is not an argument of ${subject} either` };
      stated.add(group);
      return { ...error, message: `is not an argument of ${subject}; ${fact}` };
    }
    if (!group.elsewhere) return error;
    const where = elsewhere(group.elsewhere);
    return where
      ? { ...error, message: `is not an argument of ${subject}, which has no date filter; ${where}` }
      : error;
  });
}

/** Every guessed name with a hint, for tests. */
export function guessedArgumentNames(): string[] {
  return [...GUESS_BY_NAME.keys()];
}
