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
  /** ISO 8601 date or datetime (no timezone = UTC); received on/after (>=) this instant. */
  since?: string;
  /** ISO 8601 date or datetime (no timezone = UTC); received strictly before (<) this instant. */
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
 * The single shape definition shared by the parser below and by the schema
 * validator (isIsoDateOrDateTime), so the two can never drift apart and start
 * disagreeing about what a caller is allowed to send.
 *
 * Groups: (1) the calendar date, (2) the optional time, (3) the optional zone
 * designator. The zone is `Z`, `+HH:MM` or the colon-less `+HHMM` that V8 also
 * accepts; a lowercase `z` is tolerated via the `i` flag because callers copy
 * timestamps out of logs. Everything else (a space instead of `T`, a bare
 * offset like `+02`, prose such as "June 1 2026") is deliberately not matched:
 * see the note on the fallback branch of parseIsoDate.
 */
const ISO_DATE_OR_DATE_TIME_RE =
  /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?)?$/i;

/**
 * Parse an ISO 8601 date or datetime into a Date. Accepts:
 *   "2026-06-03", "2026-06-03T14:12", "2026-06-03T14:12:00",
 *   "2026-06-03T14:12:00Z", "2026-06-03T14:12:00+02:00".
 * Throws on an unparseable value so callers fail loud rather than silently
 * emitting a wrong query.
 *
 * TIMEZONE: a value that carries no zone designator, whether it is a bare date
 * or a full date-time, is read as UTC. That is the whole reason this function
 * normalises the string itself instead of handing it to `new Date`: under
 * ECMAScript a date-only string is UTC but a date-*time* without an offset is
 * LOCAL, so `new Date("2026-08-01T00:00:00")` would mean a different instant
 * depending on the timezone the edge runtime happens to boot in, and the same
 * search would return different mail from two regions. Appending "Z" before
 * parsing removes the runtime from the equation entirely.
 */
export function parseIsoDate(input: string): Date {
  const s = input.trim();
  const match = ISO_DATE_OR_DATE_TIME_RE.exec(s);
  if (match) {
    const [, date, time, zone] = match;
    // No time at all means UTC midnight; a time with no zone is pinned to UTC
    // rather than inheriting the host's. Only an explicit zone is passed
    // through as written, because it already names an unambiguous instant.
    const normalized = time === undefined
      ? `${date}T00:00:00Z`
      : `${date}T${time}${zone ?? "Z"}`;
    const d = new Date(normalized);
    if (Number.isNaN(d.getTime())) {
      // Reachable for a well-shaped but impossible value such as
      // "2026-13-01" or "2026-08-01T25:00:00": the regex can only see the
      // shape, not whether the fields are in range.
      throw new RangeError(`Invalid ISO 8601 date/datetime: ${JSON.stringify(input)}`);
    }
    return d;
  }
  // Fallback for callers that do not go through the tool schema validator (the
  // unattended triage runner stores a filter that was only checked with
  // Date.parse). Anything landing here is whatever `new Date` makes of it,
  // including the local-time reading of an odd date-time shape, which is
  // precisely why the schema layer refuses to accept these from a tool call.
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new RangeError(`Invalid ISO 8601 date/datetime: ${JSON.stringify(input)}`);
  }
  return d;
}

/**
 * Does `value` match the date/date-time contract the search tools advertise?
 *
 * Used by validateInputSchema in index.ts for the "date-or-date-time" format
 * token. It lives here, next to parseIsoDate, because the promise it makes to
 * the caller is only worth anything if it accepts exactly what the parser one
 * layer down understands.
 *
 * The shape is checked as well as the parse because `new Date` cheerfully
 * accepts prose ("June 1 2026") and other implementation-defined junk, which
 * would then reach the provider as a date nobody intended. The parse is
 * checked as well as the shape because the shape cannot tell that month 13 or
 * hour 25 do not exist.
 */
export function isIsoDateOrDateTime(value: string): boolean {
  const s = value.trim();
  if (!ISO_DATE_OR_DATE_TIME_RE.test(s)) return false;
  try {
    // Safe from the permissive fallback above: the regex has already matched,
    // so parseIsoDate takes its strict branch.
    parseIsoDate(s);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Date normalization
//
// isIsoDateOrDateTime above is the CONTRACT: one shape, no ambiguity, an
// unambiguous instant. Models do not write to a contract, they write what the
// user said, and in the 30 days to 2026-08-29 that cost 414 hard rejections of
// `since` / `before` across 40 workspaces — the second largest error class on
// the product, and one where fewer than half the callers ever recovered.
//
// Nothing about the contract changes here. What changes is that a value the
// caller clearly meant is TRANSLATED into the contract before it is checked,
// rather than refused for its punctuation. The test for admission is that the
// shape has exactly one reading:
//
//   ADMITTED    Year-first calendar dates in any separator ("2026/08/01",
//               "2026-8-1"), a truncated one ("2026-08" = the 1st, "2026" =
//               Jan 1, which is what ISO 8601 truncation already means), the
//               space-instead-of-T datetime every SQL console and log line
//               emits, epoch seconds or milliseconds, and the handful of
//               relative English phrases models actually emit ("today",
//               "7 days ago", "last month", "30d").
//
//   REFUSED     Anything where two readings exist. "01-08-2026" is the 1st of
//               August to most of the world and the 8th of January to the rest,
//               and there is no signal in the string to choose between them —
//               so it stays an error, and the error names shapes that work.
//               Prose dates ("June 1 2026") stay refused for the same reason
//               `new Date` is not trusted here: it accepts them by guessing.
//
// Relative expressions resolve against a caller-supplied `now`, never against
// an implicit clock, so the resolution is deterministic under test and every
// arithmetic step below is UTC. A relative DAY resolves to a bare date rather
// than to an instant: "7 days ago" as a `since` means the whole of that day,
// and pinning it to the current wall-clock time would silently drop the morning
// of it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Examples of what `since` / `before` accept, used verbatim in the rejection a
 * caller reads. Kept beside the parser so the message cannot promise a shape
 * the parser does not take.
 */
export const DATE_INPUT_EXAMPLES =
  '"2026-06-01", "2026-06-01T09:00:00Z", "2026-06", "today", "7 days ago" or "30d"';

/** `YYYY-MM-DD` for the UTC calendar day `d` falls on. */
function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** `YYYY-MM-DDTHH:MM:SSZ` — the canonical instant shape, milliseconds dropped. */
function utcDateTimeString(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** UTC midnight of the calendar day `d` falls on. */
function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Shift by whole UTC months, clamping the day rather than rolling over.
 * `Date.UTC(y, m - 1, 31)` on the 31st of March lands in March again, which
 * would turn "last month" into "three days ago" once a year.
 */
function shiftUtcMonths(d: Date, months: number): Date {
  const absolute = d.getUTCMonth() + months;
  const year = d.getUTCFullYear() + Math.floor(absolute / 12);
  const month = ((absolute % 12) + 12) % 12;
  const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(d.getUTCDate(), lastDayOfMonth)));
}

/** Zero-pad a 1- or 2-digit numeric field. */
function pad2(value: string): string {
  return value.length === 1 ? `0${value}` : value;
}

/**
 * Build `YYYY-MM-DD` from already-separated fields, returning null when the
 * fields do not name a real day. The range check is the parse: "2026-02-31"
 * has a perfectly good shape and no existence.
 */
function calendarDate(year: string, month: string, day: string): string | null {
  const candidate = `${year}-${pad2(month)}-${pad2(day)}`;
  return isIsoDateOrDateTime(candidate) ? candidate : null;
}

/** Relative units, in the spellings models actually emit. */
const RELATIVE_UNIT_ALIASES: Record<string, "hour" | "day" | "week" | "month" | "year"> = {
  h: "hour", hour: "hour", hours: "hour",
  d: "day", day: "day", days: "day",
  w: "week", week: "week", weeks: "week",
  month: "month", months: "month",
  y: "year", year: "year", years: "year",
  // `m` is deliberately absent: it is minutes as often as months, and this
  // module's whole rule is that an ambiguous shape stays an error.
};

/** Apply `-count` of `unit` to `now`, at the granularity the unit implies. */
function shiftRelative(
  now: Date,
  unit: "hour" | "day" | "week" | "month" | "year",
  count: number,
): string {
  // An hour offset is the only one that names a time of day, so it is the only
  // one that returns an instant. Everything coarser returns the calendar day,
  // because "since 7 days ago" means from the start of that day.
  if (unit === "hour") return utcDateTimeString(new Date(now.getTime() - count * 3_600_000));
  const midnight = utcMidnight(now);
  switch (unit) {
    case "day": return utcDateString(new Date(midnight.getTime() - count * 86_400_000));
    case "week": return utcDateString(new Date(midnight.getTime() - count * 7 * 86_400_000));
    case "month": return utcDateString(shiftUtcMonths(midnight, -count));
    case "year": return utcDateString(shiftUtcMonths(midnight, -count * 12));
  }
}

/** Epoch seconds vs milliseconds. 1e11 seconds is the year 5138; nothing a
 * caller means by a date is above it, and every millisecond value since 1973
 * is. */
const EPOCH_MILLISECOND_THRESHOLD = 1e11;

/**
 * Translate a caller's date into the one shape `isIsoDateOrDateTime` accepts,
 * or return null when the value has no single reading.
 *
 * A value that is ALREADY in contract is returned untouched, offset and all:
 * "2026-06-01T09:00:00+02:00" already names one instant and rewriting it to UTC
 * would only make the caller's own value unrecognisable in an error message.
 *
 * @param now the instant relative expressions resolve against. Passed in rather
 *            than read from the clock so the resolution is testable and so one
 *            request cannot resolve `since` and `before` against two instants.
 */
export function normalizeDateOrDateTime(input: string, now: Date = new Date()): string | null {
  const s = input.trim();
  if (s === "") return null;

  // Already canonical (including a well-shaped impossibility like "2026-13-01",
  // which isIsoDateOrDateTime rejects and which must stay rejected).
  if (ISO_DATE_OR_DATE_TIME_RE.test(s)) return isIsoDateOrDateTime(s) ? s : null;

  // Epoch seconds or milliseconds. Nine digits is the floor so that a bare year
  // ("2026") and a bare month ("2026-08" once stripped) cannot be swallowed.
  const epoch = /^\d{9,14}$/.exec(s);
  if (epoch) {
    const value = Number(s);
    const d = new Date(value >= EPOCH_MILLISECOND_THRESHOLD ? value : value * 1000);
    return Number.isNaN(d.getTime()) ? null : utcDateTimeString(d);
  }

  // Year-first calendar dates: any of `-` or `/` as the separator, either
  // padded or not. Year-first is what makes these unambiguous; a day-first or
  // month-first shape never reaches this function's accept list.
  const ymd = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (ymd) return calendarDate(ymd[1], ymd[2], ymd[3]);

  // ISO 8601 truncation: a month means its first day, a year means January 1st.
  const ym = /^(\d{4})[-/](\d{1,2})$/.exec(s);
  if (ym) return calendarDate(ym[1], ym[2], "01");
  const y = /^(\d{4})$/.exec(s);
  if (y) {
    const year = Number(y[1]);
    return year >= 1970 && year <= 2999 ? calendarDate(y[1], "01", "01") : null;
  }

  // A date-time whose separator is a space rather than `T`, which is what every
  // SQL console, log line and spreadsheet emits, plus unpadded fields and an
  // optional fractional second and zone.
  const spaced =
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i
      .exec(s);
  if (spaced) {
    const date = calendarDate(spaced[1], spaced[2], spaced[3]);
    if (!date) return null;
    const time = `${pad2(spaced[4])}:${spaced[5]}:${spaced[6] ?? "00"}`;
    const zone = spaced[7] ? spaced[7].toUpperCase() : "Z";
    const candidate = `${date}T${time}${zone}`;
    return isIsoDateOrDateTime(candidate) ? candidate : null;
  }

  // ── Relative expressions ────────────────────────────────────────────────
  // Matched on a lowercased, whitespace-collapsed copy so "  Last  Week " and
  // "last week" are the same phrase.
  const phrase = s.toLowerCase().replace(/\s+/g, " ");

  if (phrase === "now") return utcDateTimeString(now);
  if (phrase === "today") return utcDateString(now);
  if (phrase === "yesterday") return shiftRelative(now, "day", 1);
  if (phrase === "tomorrow") return utcDateString(new Date(utcMidnight(now).getTime() + 86_400_000));

  // "last week" / "past month" / "a year ago" — a bare unit means one of it.
  const bareUnit = /^(?:the )?(?:last|past|previous) (week|month|year|day)$/.exec(phrase) ??
    /^an? (week|month|year|day) ago$/.exec(phrase);
  if (bareUnit) return shiftRelative(now, RELATIVE_UNIT_ALIASES[bareUnit[1]], 1);

  // "7 days ago" / "last 7 days" / "past 3 months".
  const counted = /^(\d{1,4}) ([a-z]+) ago$/.exec(phrase) ??
    /^(?:the )?(?:last|past) (\d{1,4}) ([a-z]+)$/.exec(phrase);
  if (counted) {
    const unit = RELATIVE_UNIT_ALIASES[counted[2]];
    return unit ? shiftRelative(now, unit, Number(counted[1])) : null;
  }

  // The shorthand form: "30d", "-7d", "24h". A sign is accepted and ignored —
  // both "30d" and "-30d" mean thirty days back, and no caller has ever meant
  // a date thirty days into the future by either.
  const shorthand = /^[+-]?(\d{1,4}) ?(h|d|w|y)$/.exec(phrase);
  if (shorthand) return shiftRelative(now, RELATIVE_UNIT_ALIASES[shorthand[2]], Number(shorthand[1]));

  return null;
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
 * "2026-06-03T00:00:00Z". An input with no timezone is read as UTC.
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

/**
 * RFC 3501 §6.4.4 SEARCH keys that may legitimately open a raw escape-hatch
 * query (e.g. "OR FROM a FROM b", "HEADER X-Spam yes", "NOT DELETED"). Used
 * by {@link toImapSearch} to distinguish an actual IMAP SEARCH expression from
 * plain free text — see the BUGFIX note below.
 */
const IMAP_SEARCH_KEYWORDS = new Set([
  "ALL", "ANSWERED", "BCC", "BEFORE", "BODY", "CC", "DELETED", "DRAFT",
  "FLAGGED", "FROM", "HEADER", "KEYWORD", "LARGER", "NEW", "NOT", "OLD", "ON",
  "OR", "RECENT", "SEEN", "SENTBEFORE", "SENTON", "SENTSINCE", "SINCE",
  "SMALLER", "SUBJECT", "TEXT", "TO", "UID", "UNANSWERED", "UNDELETED",
  "UNDRAFT", "UNFLAGGED", "UNKEYWORD", "UNSEEN",
]);

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

  // BUGFIX (2026-07-28): `raw` is documented as a provider-native escape hatch
  // ("prefer the structured fields above"), but in practice AI callers
  // frequently pass a plain free-text phrase in `query` (e.g. "invoice from
  // acme") expecting a general search rather than literal RFC 3501 SEARCH
  // syntax. Spliced in verbatim, that reliably produced a server-rejected
  // command ("Unknown argument invoice…"), surfaced as `invalid_query` — this
  // was the single largest email_search error bucket (65/65 from one caller
  // in 30 days, 100% attributable to this path). If the raw string's first
  // token isn't a recognized SEARCH key, treat the whole thing as free text
  // (TEXT) instead of splicing it in unquoted — this makes the common
  // "query as a search phrase" usage work instead of erroring, while leaving
  // genuine IMAP-syntax escape-hatch queries (e.g. "OR FROM a FROM b")
  // untouched.
  const raw = s.raw?.trim();
  if (raw) {
    const firstToken = raw.split(/\s+/, 1)[0]?.toUpperCase() ?? "";
    if (IMAP_SEARCH_KEYWORDS.has(firstToken)) {
      parts.push(raw);
    } else {
      parts.push(`TEXT ${quoteImap(raw)}`);
    }
  }

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
  since: "ISO 8601 date or date-time; return messages received on/after (>=) this instant. A value with no timezone is read as UTC. E.g. \"2026-06-01\", \"2026-06-01T09:00:00\" or \"2026-06-01T09:00:00Z\". Also accepts \"2026-06\", \"today\", \"7 days ago\" and \"30d\".",
  before: "ISO 8601 date or date-time; return messages received strictly before (<) this instant. A value with no timezone is read as UTC. E.g. \"2026-07-01\" or \"2026-07-01T00:00:00\". Also accepts \"2026-07\", \"today\" and \"30d\".",
  raw: "Escape hatch: a provider-native query appended to the structured criteria. Ignored on Fastmail (JMAP).",
};
