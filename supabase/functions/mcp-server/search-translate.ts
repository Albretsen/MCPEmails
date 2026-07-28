/**
 * search-translate.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Provider-agnostic, normalized email-search translation layer.
 *
 * The MCP `email_search` tool exposes a single structured `NormalizedSearch`
 * shape to the AI agent. This module translates that shape into each backend's
 * native query dialect, so the agent never has to know Gmail operators, KQL,
 * OData, JMAP filters, or IMAP SEARCH syntax.
 *
 * Pure functions, no I/O, zero external dependencies. ESM, strict TypeScript.
 *
 * ── Field → provider support matrix ─────────────────────────────────────────
 *
 *   field          Gmail              Graph (Outlook)        Fastmail (JMAP)     IMAP (RFC3501)
 *   ─────────────  ─────────────────  ─────────────────────  ──────────────────  ────────────────
 *   from           from:              $search "from:…"       from                FROM
 *   to             to:                $search "to:…"         to                  TO
 *   cc             cc:                $search "cc:…"         cc                  CC
 *   subject        subject:           $search "subject:…"    subject             SUBJECT
 *   body           "phrase" (text)*   $search "body:…"       body                BODY
 *   text           bareword          $search "phrase"       text                TEXT
 *   unread         is:unread/is:read  $filter isRead eq …    hasKeyword/notKw    UNSEEN/SEEN
 *                                     (NOT combinable w/     $seen
 *                                      $search — see policy)
 *   has_attachment has:attachment     $filter hasAttachments hasAttachment:true  (none — see gap)†
 *                                     eq true (filter-only)
 *   flagged        is:starred         (none — see gap)‡      hasKeyword $flagged  FLAGGED
 *   since (≥)      after:YYYY/MM/DD   $filter receivedDate…  after (UTCDate)     SINCE dd-Mon-yyyy
 *   before (<)     before:YYYY/MM/DD  $filter receivedDate…  before (UTCDate)    BEFORE dd-Mon-yyyy
 *   raw            appended verbatim  see policy below       (dropped — see gap) appended verbatim
 *
 *   *  Gmail has no dedicated "body-only" operator; bare phrases search the whole
 *      message (incl. subject/headers). We map both `body` and `text` to bare
 *      quoted terms; they are effectively equivalent on Gmail.
 *   †  IMAP RFC 3501 SEARCH has no attachment predicate. `has_attachment` is
 *      silently dropped for IMAP; the integrator must filter client-side if needed.
 *   ‡  Graph KQL `$search` exposes no "flagged/followup" token usable here and
 *      the `flag/followupFlag` property is awkward in `$filter`; `flagged` is
 *      dropped for Graph. Surface this to users.
 *
 * ── Graph $search vs $filter combination policy ─────────────────────────────
 *   For the **messages** endpoint, Microsoft Graph does NOT allow `$search` and
 *   `$filter` to be combined, and `$orderby` is not supported alongside `$search`.
 *   (See "using $search and $filter parameters for messages endpoint".)
 *   Free-text/field predicates (from/to/cc/subject/body/text) live in KQL
 *   `$search`; state/date predicates (isRead/hasAttachments/receivedDateTime)
 *   live in OData `$filter`. Because they cannot coexist on this endpoint,
 *   `toGraphSearch` returns BOTH a `search` and a `filter` string when both are
 *   present, but the integrator MUST pick exactly one to send (preferring
 *   `$search` when free-text criteria exist, else `$filter`). This function does
 *   not decide for you; it returns both and documents the constraint here.
 *   `raw` is treated as KQL and appended to `search`.
 *
 * ── Doc sources (researched 2026-06) ────────────────────────────────────────
 *   Gmail search operators:
 *     https://support.google.com/mail/answer/7190
 *   Microsoft Graph $search (KQL, searchable message properties):
 *     https://learn.microsoft.com/en-us/graph/search-query-parameter
 *   Microsoft Graph list messages ($filter/$orderby rules):
 *     https://learn.microsoft.com/en-us/graph/api/user-list-messages
 *   Graph $search + $filter not combinable on /messages:
 *     https://learn.microsoft.com/en-us/answers/questions/1401458/using-search-and-filter-parameters-for-messages-en
 *   JMAP Mail Email/query FilterCondition (RFC 8621 §4.4.1):
 *     https://datatracker.ietf.org/doc/html/rfc8621
 *   JMAP FilterOperator (RFC 8620 §5.5):
 *     https://datatracker.ietf.org/doc/html/rfc8620#section-5.5
 *   IMAP4rev1 SEARCH command + date/string syntax (RFC 3501 §6.4.4, §9):
 *     https://datatracker.ietf.org/doc/html/rfc3501#section-6.4.4
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Provider-agnostic, structured search criteria. All fields are optional; an
 * empty object means "match everything". Multiple fields combine with AND.
 *
 * Free-text fields (`from`, `to`, `cc`, `subject`, `body`, `text`) are matched
 * as the provider sees fit (substring/token/phrase). `since`/`before` are
 * received-date bounds. `raw` is an escape hatch passed through verbatim.
 */
export interface NormalizedSearch {
  /** Sender. Email address, display name, or fragment. All providers. */
  from?: string;
  /** Primary recipient (To). Address/name/fragment. All providers. */
  to?: string;
  /** Carbon-copy recipient (Cc). All providers. */
  cc?: string;
  /** Subject line text. All providers. */
  subject?: string;
  /**
   * Free text in the message body. Gmail maps this to a whole-message term
   * (no body-only operator); Graph/JMAP/IMAP scope it to the body.
   */
  body?: string;
  /** Free text matched anywhere (headers + body). All providers. */
  text?: string;
  /** true = only unread; false = only read; omit = either. All providers. */
  unread?: boolean;
  /**
   * true = only messages with a (non-inline) attachment. Gmail/Graph/JMAP
   * supported; IMAP (RFC 3501) has no attachment predicate so this is dropped.
   */
  has_attachment?: boolean;
  /**
   * true = only flagged/starred messages. Gmail (is:starred), JMAP ($flagged),
   * IMAP (FLAGGED). Dropped for Graph (no usable predicate).
   */
  flagged?: boolean;
  /** ISO 8601 date or datetime; received on/after (>=) this instant. */
  since?: string;
  /** ISO 8601 date or datetime; received strictly before (<) this instant. */
  before?: string;
  /**
   * Provider-native query passed through verbatim. Precedence: structured
   * fields are NOT discarded — `raw` is appended (AND-combined) where the
   * provider allows it (Gmail, IMAP, Graph-$search). For JMAP there is no raw
   * query string, so `raw` is ignored. For Graph it is treated as KQL and
   * appended to `$search`.
   */
  raw?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared date handling
// ─────────────────────────────────────────────────────────────────────────────

const MONTHS_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * Parse an ISO 8601 date or datetime into a Date. Accepts:
 *   "2026-06-03", "2026-06-03T14:12:00Z", "2026-06-03T14:12:00+02:00".
 * A bare date ("YYYY-MM-DD") is interpreted as UTC midnight.
 * Throws on an unparseable value so callers fail loud rather than silently
 * emitting a wrong query.
 */
export function parseIsoDate(input: string): Date {
  const s = input.trim();
  // Bare date → pin to UTC midnight (avoid local-tz drift from `new Date`).
  const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (bare) {
    const d = new Date(Date.UTC(
      Number(bare[1]),
      Number(bare[2]) - 1,
      Number(bare[3]),
    ));
    if (Number.isNaN(d.getTime())) {
      throw new RangeError(`Invalid ISO date: ${JSON.stringify(input)}`);
    }
    return d;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new RangeError(`Invalid ISO 8601 date/datetime: ${JSON.stringify(input)}`);
  }
  return d;
}

/** Gmail date format: YYYY/MM/DD (UTC calendar date). */
export function formatGmailDate(input: string): string {
  const d = parseIsoDate(input);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

/** IMAP date format: dd-Mon-yyyy, e.g. "1-Feb-1994" (RFC 3501 §9). */
export function formatImapDate(input: string): string {
  const d = parseIsoDate(input);
  const day = d.getUTCDate(); // no leading zero required; "1-Feb-1994" is valid
  const mon = MONTHS_ABBR[d.getUTCMonth()];
  const y = d.getUTCFullYear();
  return `${day}-${mon}-${y}`;
}

/**
 * JMAP / Graph UTCDate: ISO 8601 in UTC with seconds, e.g.
 * "2026-06-03T00:00:00Z". A bare input date becomes UTC midnight.
 */
export function formatUtcDateTime(input: string): string {
  const d = parseIsoDate(input);
  // Strip milliseconds for a clean "…Z" UTCDate.
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-dialect quoting helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Quote a value for a Gmail operator. Gmail wraps multi-word phrases in double
 * quotes; embedded double quotes are stripped (Gmail has no escape mechanism in
 * its search box grammar, so the safe move is to remove them). Always returns a
 * single token (quoted iff it contains whitespace or quotes).
 */
function quoteGmail(value: string): string {
  const cleaned = value.replace(/"/g, "").trim();
  if (cleaned === "") return '""';
  return /\s/.test(cleaned) ? `"${cleaned}"` : cleaned;
}

/**
 * Quote a KQL clause value for Graph `$search`. The whole clause is wrapped in
 * double quotes; embedded `"` and `\` are backslash-escaped per the Graph
 * search syntax rules.
 */
function quoteKqlValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Quote an IMAP astring argument (RFC 3501 §9). Emits a quoted string with
 * backslash and double-quote escaped. CR/LF are stripped (illegal in a quoted
 * string and not representable without a literal, which we avoid).
 */
function quoteImap(value: string): string {
  const cleaned = value.replace(/[\r\n]/g, " ");
  const escaped = cleaned.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gmail  →  search operator string
//   Empty NormalizedSearch → "" (Gmail treats an empty query as "all mail").
//   Docs: https://support.google.com/mail/answer/7190
// ─────────────────────────────────────────────────────────────────────────────

export function toGmailQuery(s: NormalizedSearch): string {
  const parts: string[] = [];

  if (s.from) parts.push(`from:${quoteGmail(s.from)}`);
  if (s.to) parts.push(`to:${quoteGmail(s.to)}`);
  if (s.cc) parts.push(`cc:${quoteGmail(s.cc)}`);
  if (s.subject) parts.push(`subject:${quoteGmail(s.subject)}`);
  // Gmail has no body-only operator; both body & text become bare terms.
  if (s.body) parts.push(quoteGmail(s.body));
  if (s.text) parts.push(quoteGmail(s.text));

  if (s.unread === true) parts.push("is:unread");
  else if (s.unread === false) parts.push("is:read");

  if (s.has_attachment === true) parts.push("has:attachment");
  if (s.flagged === true) parts.push("is:starred");

  if (s.since) parts.push(`after:${formatGmailDate(s.since)}`);
  if (s.before) parts.push(`before:${formatGmailDate(s.before)}`);

  if (s.raw && s.raw.trim() !== "") parts.push(s.raw.trim());

  return parts.join(" ");
}

// ─────────────────────────────────────────────────────────────────────────────
// IMAP  →  RFC 3501 SEARCH criteria string (caller prepends "UID SEARCH").
//   Empty NormalizedSearch → "ALL".
//   has_attachment is unsupported and dropped (no RFC 3501 predicate).
//   Multiple keys are space-separated (implicit AND).
//   `unread:true` → UNSEEN; `unread:false` → SEEN. `flagged:true` → FLAGGED.
//   `raw` is appended verbatim. Dates use SINCE/BEFORE (internal date).
//   Docs: https://datatracker.ietf.org/doc/html/rfc3501#section-6.4.4
// ─────────────────────────────────────────────────────────────────────────────

export function toImapSearch(s: NormalizedSearch): string {
  const parts: string[] = [];

  if (s.from) parts.push(`FROM ${quoteImap(s.from)}`);
  if (s.to) parts.push(`TO ${quoteImap(s.to)}`);
  if (s.cc) parts.push(`CC ${quoteImap(s.cc)}`);
  if (s.subject) parts.push(`SUBJECT ${quoteImap(s.subject)}`);
  if (s.body) parts.push(`BODY ${quoteImap(s.body)}`);
  if (s.text) parts.push(`TEXT ${quoteImap(s.text)}`);

  if (s.unread === true) parts.push("UNSEEN");
  else if (s.unread === false) parts.push("SEEN");

  if (s.flagged === true) parts.push("FLAGGED");
  // has_attachment: no RFC 3501 SEARCH predicate — intentionally dropped.

  if (s.since) parts.push(`SINCE ${formatImapDate(s.since)}`);
  if (s.before) parts.push(`BEFORE ${formatImapDate(s.before)}`);

  if (s.raw && s.raw.trim() !== "") parts.push(s.raw.trim());

  return parts.length === 0 ? "ALL" : parts.join(" ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Microsoft Graph  →  { search?, filter? }
//   Empty NormalizedSearch → {} (caller sends no $search/$filter).
//   KQL $search: from/to/cc/subject/body/text + raw (free text).
//   OData $filter: isRead, hasAttachments, receivedDateTime range.
//   CONSTRAINT: on /messages, $search and $filter cannot be combined, and
//   $orderby is unavailable with $search. When BOTH are produced, the caller
//   MUST choose one (prefer $search when free-text criteria exist).
//   `flagged` is dropped (no usable predicate). `raw` → appended to $search.
//   Docs: https://learn.microsoft.com/en-us/graph/search-query-parameter
//         https://learn.microsoft.com/en-us/graph/api/user-list-messages
// ─────────────────────────────────────────────────────────────────────────────

export function toGraphSearch(s: NormalizedSearch): { search?: string; filter?: string } {
  // ── KQL $search clauses ──
  const searchClauses: string[] = [];
  const kqlClause = (prop: string, value: string) =>
    `"${prop}:${quoteKqlValue(value)}"`;

  if (s.from) searchClauses.push(kqlClause("from", s.from));
  if (s.to) searchClauses.push(kqlClause("to", s.to));
  if (s.cc) searchClauses.push(kqlClause("cc", s.cc));
  if (s.subject) searchClauses.push(kqlClause("subject", s.subject));
  if (s.body) searchClauses.push(kqlClause("body", s.body));
  // free text anywhere → bare quoted phrase (default props: from/subject/body)
  if (s.text) searchClauses.push(`"${quoteKqlValue(s.text)}"`);
  if (s.raw && s.raw.trim() !== "") searchClauses.push(`"${quoteKqlValue(s.raw.trim())}"`);

  // ── OData $filter clauses ──
  const filterClauses: string[] = [];
  if (s.unread === true) filterClauses.push("isRead eq false");
  else if (s.unread === false) filterClauses.push("isRead eq true");
  if (s.has_attachment === true) filterClauses.push("hasAttachments eq true");
  if (s.since) filterClauses.push(`receivedDateTime ge ${formatUtcDateTime(s.since)}`);
  if (s.before) filterClauses.push(`receivedDateTime lt ${formatUtcDateTime(s.before)}`);
  // flagged: no usable Graph predicate — intentionally dropped.

  const out: { search?: string; filter?: string } = {};
  if (searchClauses.length > 0) out.search = searchClauses.join(" AND ");
  if (filterClauses.length > 0) out.filter = filterClauses.join(" and ");
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON-Schema parameter descriptions (audience: an AI agent). Each ≤ ~140 chars.
// ─────────────────────────────────────────────────────────────────────────────

export const SEARCH_FIELD_DESCRIPTIONS: Record<string, string> = {
  from: "Sender to match: email address, display name, or fragment (e.g. \"alice@example.com\" or \"Alice\").",
  to: "Primary (To) recipient to match: email address, display name, or fragment.",
  cc: "Carbon-copy (Cc) recipient to match: email address, display name, or fragment.",
  subject: "Text to match in the subject line. Multi-word phrases are matched as-is.",
  body: "Free text to find in the message body. (On Gmail this matches the whole message, not body-only.)",
  text: "Free text to match anywhere in the message (headers and body).",
  unread: "true = only unread messages; false = only read messages; omit for either.",
  has_attachment: "true = only messages with an attachment. Not supported on generic IMAP (ignored there).",
  flagged: "true = only flagged/starred messages. Not supported on Outlook/Graph (ignored there).",
  since: "ISO 8601 date or datetime; return messages received on/after (>=) this instant. E.g. \"2026-06-01\".",
  before: "ISO 8601 date or datetime; return messages received strictly before (<) this instant.",
  raw: "Escape hatch: a provider-native query appended to the structured criteria. Ignored on Fastmail (JMAP).",
};
