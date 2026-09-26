// ---------------------------------------------------------------------------
// Date handling for the search tools' `since` / `before` arguments.
//
// The property that matters here is not "does it parse" but "does it mean the
// same instant everywhere". A zone-less date-time is the shape models emit
// constantly, and under ECMAScript `new Date` reads a date-only string as UTC
// but a date-*time* without an offset as LOCAL. Handed straight to `new Date`,
// the identical search would therefore hit a different range depending on the
// timezone the edge runtime happened to boot in, which is why validation used
// to refuse the shape outright and why the fix has to pin it rather than merely
// let it through.
//
// So these tests assert four things:
//
//   1. Exactly which strings the tool schema accepts, and that prose and
//      out-of-range fields are still refused.
//   2. A zone-less date-time is read as UTC, not as host-local time.
//   3. Nothing shifts by a day at a UTC boundary in any of the three provider
//      dialects (Gmail after:, IMAP SINCE, Graph receivedDateTime ge).
//   4. The parser and the validator agree, so nothing the schema waves through
//      can throw one layer down.
//
// Property 2 is only convincing if the run is not in UTC to begin with, so the
// suite asserts the same values under two deliberately hostile fixed offsets by
// re-reading TZ (see the tz-sweep note at the bottom): run it as
//
//   TZ=Pacific/Kiritimati deno test --allow-all supabase/functions/mcp-server/
//   TZ=Pacific/Niue       deno test --allow-all supabase/functions/mcp-server/
//
// Run: deno test --allow-all supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import {
  buildUnappliedSearchNote,
  buildUnappliedSearchRefusal,
  DATE_INPUT_EXAMPLES,
  formatGmailDate,
  formatImapDate,
  formatUtcDateTime,
  isIsoDateOrDateTime,
  type NormalizedSearch,
  normalizeDateOrDateTime,
  parseIsoDate,
  searchDialectFor,
  SEARCH_FIELD_DESCRIPTIONS,
  toGmailQuery,
  toGraphSearch,
  toImapSearch,
  unappliedSearchFields,
} from "./search-translate.ts";
import { graphSearchParam } from "./outlook-graph.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertThrows(fn: () => unknown, message: string): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(`${message}: expected a throw, got a value`);
}

// ── 1. The accepted set ──────────────────────────────────────────────────────

Deno.test("schema accepts a bare date, a naive date-time, Z and an offset", () => {
  const accepted = [
    "2026-06-01", // bare date, the original reason for the custom format token
    "2026-08-01T00:00:00", // naive date-time: the shape that caused 306 rejections
    "2026-08-01T09:30", // naive, seconds omitted
    "2026-08-01T09:30:15.250", // naive, fractional seconds
    "2026-06-01T09:00:00Z",
    "2026-06-01t09:00:00z", // lowercase, as copied out of a log
    "2026-06-01T09:00:00.500Z",
    "2026-06-01T09:00:00+02:00",
    "2026-06-01T09:00:00-05:30",
    "2026-06-01T09:00:00+0200", // colon-less offset: unambiguous, so allowed
  ];
  for (const value of accepted) {
    assert(isIsoDateOrDateTime(value), `must accept ${JSON.stringify(value)}`);
  }
});

Deno.test("schema still rejects prose, wrong separators and impossible fields", () => {
  const rejected = [
    "June 1 2026", // Date.parse takes it; the shape check is what stops it
    "1 June 2026",
    "next tuesday",
    "2026-08-01 00:00:00", // space separator, not ISO 8601's `T`
    "2026-8-1", // unpadded fields
    "2026/08/01",
    "2026-13-01", // month out of range
    "2026-08-01T25:00:00", // hour out of range
    "2026-08-01T12:60:00Z", // minute out of range
    "2026-08-01T09:00:00+2:00", // malformed offset
    "",
    "   ",
    "2026",
  ];
  for (const value of rejected) {
    assert(!isIsoDateOrDateTime(value), `must reject ${JSON.stringify(value)}`);
  }
});

// ── 2. UTC pinning ───────────────────────────────────────────────────────────

Deno.test("a zone-less value is read as UTC, not as host-local time", () => {
  assertEquals(
    parseIsoDate("2026-08-01T00:00:00").toISOString(),
    "2026-08-01T00:00:00.000Z",
    "naive midnight is UTC midnight",
  );
  assertEquals(
    parseIsoDate("2026-08-01").toISOString(),
    "2026-08-01T00:00:00.000Z",
    "bare date is UTC midnight (unchanged behaviour)",
  );
  assertEquals(
    parseIsoDate("2026-08-01T00:00:00").getTime(),
    parseIsoDate("2026-08-01T00:00:00Z").getTime(),
    "naive and Z-suffixed name the same instant",
  );
  assertEquals(
    parseIsoDate("2026-08-01T00:00:00").getTime(),
    parseIsoDate("2026-08-01").getTime(),
    "naive midnight and the bare date name the same instant",
  );
  // The whole point: a host in any zone must produce that same instant. If the
  // implementation ever regresses to `new Date(naive)`, this is the assertion
  // that fails on every runner outside UTC.
  assertEquals(
    parseIsoDate("2026-08-01T00:00:00").getTime(),
    Date.UTC(2026, 7, 1, 0, 0, 0),
    "host timezone does not participate",
  );
});

Deno.test("an explicit offset is honoured rather than pinned", () => {
  assertEquals(
    parseIsoDate("2026-08-01T02:00:00+02:00").toISOString(),
    "2026-08-01T00:00:00.000Z",
    "+02:00 shifts back to UTC",
  );
  assertEquals(
    parseIsoDate("2026-07-31T19:00:00-05:00").toISOString(),
    "2026-08-01T00:00:00.000Z",
    "-05:00 shifts forward to UTC",
  );
});

Deno.test("parseIsoDate throws on a well-shaped but impossible value", () => {
  assertThrows(() => parseIsoDate("2026-13-01"), "month 13");
  assertThrows(() => parseIsoDate("2026-08-01T25:00:00"), "hour 25");
  assertThrows(() => parseIsoDate("not a date at all !!"), "junk");
});

// ── 3. Provider dialects, including the UTC boundary ─────────────────────────

Deno.test("a naive date-time formats identically in all three dialects", () => {
  const naive = "2026-08-01T00:00:00";
  assertEquals(formatGmailDate(naive), "2026/08/01", "Gmail after:/before:");
  assertEquals(formatImapDate(naive), "1-Aug-2026", "IMAP SINCE/BEFORE");
  assertEquals(formatUtcDateTime(naive), "2026-08-01T00:00:00Z", "Graph receivedDateTime");

  // Same calendar day as the bare date it is the midnight of.
  assertEquals(formatGmailDate("2026-08-01"), formatGmailDate(naive), "Gmail matches bare date");
  assertEquals(formatImapDate("2026-08-01"), formatImapDate(naive), "IMAP matches bare date");
  assertEquals(
    formatUtcDateTime("2026-08-01"),
    formatUtcDateTime(naive),
    "Graph matches bare date",
  );
});

Deno.test("no day shift at either edge of a UTC day", () => {
  // Late evening: a local reading in any zone west of UTC would roll this into
  // 2 August and silently widen the search by a day.
  assertEquals(formatGmailDate("2026-08-01T23:30:00"), "2026/08/01", "Gmail, 23:30");
  assertEquals(formatImapDate("2026-08-01T23:30:00"), "1-Aug-2026", "IMAP, 23:30");
  assertEquals(
    formatUtcDateTime("2026-08-01T23:30:00"),
    "2026-08-01T23:30:00Z",
    "Graph, 23:30",
  );
  // Just after midnight: a local reading east of UTC would roll it back to
  // 31 July, the same bug in the other direction.
  assertEquals(formatGmailDate("2026-08-01T00:30:00"), "2026/08/01", "Gmail, 00:30");
  assertEquals(formatImapDate("2026-08-01T00:30:00"), "1-Aug-2026", "IMAP, 00:30");
  assertEquals(
    formatUtcDateTime("2026-08-01T00:30:00"),
    "2026-08-01T00:30:00Z",
    "Graph, 00:30",
  );
  // Month and year boundaries, where a shift changes more than the day number.
  assertEquals(formatImapDate("2026-12-31T23:59:59"), "31-Dec-2026", "IMAP, year end");
  assertEquals(formatGmailDate("2026-12-31T23:59:59"), "2026/12/31", "Gmail, year end");
});

Deno.test("naive dates reach the built provider queries unshifted", () => {
  const search = { from: "alice@example.com", since: "2026-08-01T23:30:00", before: "2026-08-02T00:30:00" };

  assertEquals(
    toGmailQuery(search),
    "from:alice@example.com after:2026/08/01 before:2026/08/02",
    "Gmail query",
  );
  assertEquals(
    toImapSearch(search),
    'FROM "alice@example.com" SINCE 1-Aug-2026 BEFORE 2-Aug-2026',
    "IMAP SEARCH criteria",
  );
  assertEquals(
    toGraphSearch(search).filter,
    "receivedDateTime ge 2026-08-01T23:30:00Z and receivedDateTime lt 2026-08-02T00:30:00Z",
    "Graph $filter",
  );
});

// ── 4. Validator and parser agree ────────────────────────────────────────────

Deno.test("everything the schema accepts also parses, and vice versa", () => {
  const values = [
    "2026-06-01",
    "2026-08-01T00:00:00",
    "2026-08-01T09:30",
    "2026-08-01T09:30:15.250",
    "2026-06-01T09:00:00Z",
    "2026-06-01T09:00:00+02:00",
    "2026-13-01",
    "2026-08-01T25:00:00",
    "June 1 2026",
    "2026-08-01 00:00:00",
  ];
  for (const value of values) {
    let parsed = true;
    try {
      parseIsoDate(value);
    } catch {
      parsed = false;
    }
    if (isIsoDateOrDateTime(value)) {
      // A value the tool schema waves through must never throw in the handler
      // or in a formatter; that would turn a -32602 into a 500.
      assert(parsed, `accepted but unparseable: ${JSON.stringify(value)}`);
    }
  }
  // The converse only holds one way on purpose: parseIsoDate keeps a permissive
  // `new Date` fallback for the triage runner's stored filters, so it parses
  // strings the tool schema refuses ("June 1 2026"). What must not happen is the
  // schema accepting something the parser rejects, which is asserted above.
  assert(!isIsoDateOrDateTime("June 1 2026"), "prose stays out of the tool schema");
});

// ── tz sweep ─────────────────────────────────────────────────────────────────

Deno.test("the UTC pinning assertions are not an artefact of the host zone", () => {
  // Documents the zone this run actually exercised, and asserts the invariant
  // one more time against a value computed from UTC components only. Running
  // the suite under TZ=Pacific/Kiritimati (+14) and TZ=Pacific/Niue (-11) makes
  // this cover both signs of a local-time regression.
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert(typeof zone === "string" && zone.length > 0, "a timezone is resolvable");
  const naive = parseIsoDate("2026-03-15T12:00:00");
  assertEquals(naive.getUTCHours(), 12, `UTC hour under ${zone}`);
  assertEquals(naive.getUTCDate(), 15, `UTC day under ${zone}`);
});

// ── date normalization ───────────────────────────────────────────────────────
//
// The contract above is unchanged: one shape reaches the query builders. What
// these assert is the translation layer in front of it, which took 414 calls a
// month that were refused for punctuation and turned them into the canonical
// shape — and, just as importantly, which shapes it still refuses because they
// have two readings.
//
// Every relative case resolves against a FIXED `now` so the expected values are
// literals rather than a re-implementation of the arithmetic under test.

/** A Thursday, mid-month, mid-year: no month-end or year-end edge to hide in. */
const NOW = new Date("2026-08-13T15:42:09Z");

function assertNormalizes(input: string, expected: string): void {
  assertEquals(normalizeDateOrDateTime(input, NOW), expected, `normalize ${JSON.stringify(input)}`);
  const canonical = normalizeDateOrDateTime(input, NOW);
  assert(
    canonical !== null && isIsoDateOrDateTime(canonical),
    `normalized ${JSON.stringify(input)} must satisfy the published format`,
  );
}

Deno.test("a value already in contract is returned untouched, offset included", () => {
  // Rewriting an explicit offset to UTC would only make the caller's own value
  // unrecognisable in an error message; it already names one instant.
  assertNormalizes("2026-06-01", "2026-06-01");
  assertNormalizes("2026-06-01T09:00:00", "2026-06-01T09:00:00");
  assertNormalizes("2026-06-01T09:00:00Z", "2026-06-01T09:00:00Z");
  assertNormalizes("2026-06-01T09:00:00.123Z", "2026-06-01T09:00:00.123Z");
  assertNormalizes("2026-06-01T09:00:00+02:00", "2026-06-01T09:00:00+02:00");
  // Trimmed, but otherwise the same string.
  assertNormalizes("  2026-06-01  ", "2026-06-01");
});

Deno.test("a space instead of T is the same instant, pinned to UTC", () => {
  // What every SQL console, log line and spreadsheet export emits.
  assertNormalizes("2026-08-01 10:00:00", "2026-08-01T10:00:00Z");
  assertNormalizes("2026-08-01 10:00", "2026-08-01T10:00:00Z");
  assertNormalizes("2026-08-01 10:00:00.500", "2026-08-01T10:00:00Z");
  assertNormalizes("2026-08-01 10:00:00Z", "2026-08-01T10:00:00Z");
  assertNormalizes("2026-08-01 10:00:00+02:00", "2026-08-01T10:00:00+02:00");
  // Unpadded fields, with either separator.
  assertNormalizes("2026-8-1T9:05", "2026-08-01T09:05:00Z");
});

Deno.test("year-first calendar dates normalize whatever the separator", () => {
  assertNormalizes("2026/08/01", "2026-08-01");
  assertNormalizes("2026/8/1", "2026-08-01");
  assertNormalizes("2026-8-1", "2026-08-01");
});

Deno.test("a truncated date means the first instant it can mean", () => {
  // Exactly what ISO 8601 truncation already means, so nothing is being guessed.
  assertNormalizes("2026-08", "2026-08-01");
  assertNormalizes("2026/08", "2026-08-01");
  assertNormalizes("2026", "2026-01-01");
});

Deno.test("epoch seconds and milliseconds are told apart by magnitude", () => {
  // 1e11 seconds is the year 5138; nothing a caller means by a date is above it.
  assertNormalizes("1786000000", "2026-08-06T07:06:40Z");
  assertNormalizes("1786000000000", "2026-08-06T07:06:40Z");
  // A bare year must never be read as an epoch: four digits is below the floor.
  assertNormalizes("2026", "2026-01-01");
});

Deno.test("the relative expressions models actually emit resolve against one now", () => {
  assertNormalizes("today", "2026-08-13");
  assertNormalizes("Today", "2026-08-13");
  assertNormalizes("yesterday", "2026-08-12");
  assertNormalizes("tomorrow", "2026-08-14");
  assertNormalizes("7 days ago", "2026-08-06");
  assertNormalizes("last 7 days", "2026-08-06");
  assertNormalizes("last week", "2026-08-06");
  assertNormalizes("last month", "2026-07-13");
  assertNormalizes("last year", "2025-08-13");
  assertNormalizes("3 months ago", "2026-05-13");
  assertNormalizes("30d", "2026-07-14");
  assertNormalizes("-7d", "2026-08-06");
  assertNormalizes("2w", "2026-07-30");
  // Only an hour offset names a time of day, so only it returns an instant.
  assertNormalizes("24h", "2026-08-12T15:42:09Z");
  assertNormalizes("now", "2026-08-13T15:42:09Z");
});

Deno.test("a relative day means the whole day, not this moment on it", () => {
  // "since 7 days ago" that resolved to 15:42 would silently drop the morning
  // of the day the caller named.
  assertEquals(normalizeDateOrDateTime("7 days ago", NOW), "2026-08-06", "start of day");
});

Deno.test("a month shift clamps the day instead of rolling into the next month", () => {
  // Date.UTC(y, m - 1, 31) on the 31st of March lands back in March, which
  // would turn "last month" into "three days ago" once a year.
  const march31 = new Date("2026-03-31T12:00:00Z");
  assertEquals(normalizeDateOrDateTime("last month", march31), "2026-02-28", "February has no 31st");
  const jan31 = new Date("2026-01-31T12:00:00Z");
  assertEquals(normalizeDateOrDateTime("1 month ago", jan31), "2025-12-31", "and the year rolls back");
});

Deno.test("an ambiguous or unreadable value is still refused", () => {
  for (const input of [
    "01-08-2026",       // the 1st of August, or the 8th of January
    "08/01/2026",       // same ambiguity, other separator
    "June 1 2026",      // prose: `new Date` accepts it by guessing
    "next tuesday",     // no fixed meaning
    "2026-13-01",       // well-shaped, and no such month
    "2026-08-01T25:00", // well-shaped, and no such hour
    "5 fortnights ago", // a unit we do not carry
    "30m",              // minutes or months: the one shorthand left out
    "",
    "   ",
    "soon",
  ]) {
    assertEquals(normalizeDateOrDateTime(input, NOW), null, `refused: ${JSON.stringify(input)}`);
  }
});

Deno.test("the examples in the rejection are all shapes the parser takes", () => {
  // The message a caller reads must not promise a shape that then fails.
  const quoted = DATE_INPUT_EXAMPLES.match(/"([^"]+)"/g) ?? [];
  assert(quoted.length >= 5, `the examples list should carry several: ${DATE_INPUT_EXAMPLES}`);
  for (const example of quoted) {
    const value = example.slice(1, -1);
    const canonical = normalizeDateOrDateTime(value, NOW);
    assert(
      canonical !== null && isIsoDateOrDateTime(canonical),
      `the rejection offers ${example}, which must normalize`,
    );
  }
});

// ── Unapplied criteria (F-04, live functional test, 2026-09-20) ──────────────
//
// The regression these pin: `email_read {action:"search", subject:"[MCPE-TEST-
// 20260920-1501]", has_attachment:true}` against a Gmail-over-IMAP inbox
// returned all 9 subject matches (2 of which had attachments) with
// `query_normalized: 'SUBJECT "[MCPE-TEST-20260920-1501]"'` and no `notes`.
// The drop is correct; the silence was the bug.
//
// The first test is the important one and it is deliberately not a string
// comparison against a hand-written list: it asserts the REPORT against the
// QUERY, so a translator that learns a new predicate, or loses one, cannot
// leave the disclosure behind. That is the failure mode automation-filter-
// fields.test.ts exists for elsewhere in this server, and it is the same shape.

/** Does the emitted query carry any trace of `field`? */
function queryMentions(search: NormalizedSearch, provider: string, field: string): boolean {
  const probes: Record<string, RegExp> = {
    has_attachment: /has:attachment|hasAttachments|KEYWORD/i,
    flagged: /is:starred|FLAGGED|\$flagged|flag\/flagStatus/i,
    unread: /is:unread|is:read|UNSEEN|SEEN|isRead/i,
    since: /after:|SINCE|ge 2/i,
    before: /before:|BEFORE|lt 2/i,
  };
  const probe = probes[field];
  if (!probe) throw new Error(`no probe for ${field}`);
  if (provider === "gmail") return probe.test(toGmailQuery(search));
  if (provider === "imap") return probe.test(toImapSearch(search));
  const graph = toGraphSearch(search);
  // The Graph policy (see this module's header): $search and $filter cannot be
  // combined on /messages, so when both exist only $search is actually sent.
  const sent = graph.search ?? graph.filter ?? "";
  return probe.test(sent);
}

Deno.test("every reported drop is really absent from the query, and vice versa", () => {
  const criteria: NormalizedSearch[] = [
    { subject: "invoice", has_attachment: true },
    { subject: "invoice", flagged: true },
    { subject: "invoice", unread: true, since: "2026-08-01" },
    { has_attachment: true, flagged: true, unread: false },
    { subject: "q3", has_attachment: true, flagged: true, unread: true, since: "2026-08-01", before: "2026-09-01" },
    // No free text at all: on Graph this is the $filter-only branch, where the
    // state and date predicates DO survive.
    { has_attachment: true, unread: true, since: "2026-08-01" },
    { flagged: true },
  ];
  const checkable = ["has_attachment", "flagged", "unread", "since", "before"];

  for (const provider of ["gmail", "outlook", "imap"]) {
    for (const search of criteria) {
      const reported = unappliedSearchFields(search, provider);
      for (const field of checkable) {
        const sent = (search as Record<string, unknown>)[field] !== undefined;
        if (!sent) {
          assert(
            !reported.includes(field),
            `${provider}: reported '${field}' as dropped although it was never sent`,
          );
          continue;
        }
        const survived = queryMentions(search, provider, field);
        assertEquals(
          reported.includes(field),
          !survived,
          `${provider} ${JSON.stringify(search)}: '${field}' survived=${survived} but ` +
            `reported=${JSON.stringify(reported)}`,
        );
      }
    }
  }
});

Deno.test("flagged on Graph is $filter flag/flagStatus eq 'flagged', dropped (and said) only beside $search", () => {
  const j = JSON.stringify;
  assertEquals(j(toGraphSearch({ flagged: true })), j({ filter: "flag/flagStatus eq 'flagged'" }), "flagged alone");
  assertEquals(j(unappliedSearchFields({ flagged: true }, "outlook")), "[]", "applied");
  assertEquals(
    toGraphSearch({ flagged: true, unread: true }).filter,
    "isRead eq false and flag/flagStatus eq 'flagged'",
    "beside unread",
  );
  // With free text Graph must send $search, which cannot carry a $filter.
  assertEquals(j(unappliedSearchFields({ subject: "x", flagged: true }, "outlook")), j(["flagged"]), "beside $search");
  assert(!/Outlook|Graph/.test(SEARCH_FIELD_DESCRIPTIONS.flagged), "no longer described as ignored on Outlook");
});

Deno.test("F-04: has_attachment on an IMAP inbox is dropped AND disclosed", () => {
  // The exact call from the 2026-09-20 functional test.
  const search: NormalizedSearch = {
    subject: "[MCPE-TEST-20260920-1501]",
    has_attachment: true,
  };

  // Still dropped — that part was never the bug, and RFC 3501 has no predicate.
  assertEquals(
    toImapSearch(search),
    'SUBJECT "[MCPE-TEST-20260920-1501]"',
    "the IMAP query is unchanged",
  );

  // …and now said out loud.
  const unapplied = unappliedSearchFields(search, "imap");
  assertEquals(unapplied.length, 1, "exactly one criterion went unapplied");
  assertEquals(unapplied[0], "has_attachment", "and it is named");

  const note = buildUnappliedSearchNote("imap", unapplied);
  assert(note.includes("'has_attachment'"), `the note names the field: ${note}`);
  assert(note.includes("not applied"), `the note says it was not applied: ${note}`);
  assert(
    note.includes("does not reflect it"),
    `the note says the result does not reflect it: ${note}`,
  );
  assert(note.includes("generic IMAP"), `the note names the provider: ${note}`);
  // Same opener as the argument-leniency disclosure, so a reader that has seen
  // one recognises the other. See buildIgnoredArgumentsNote.
  assert(note.startsWith("Note: "), `the note reads like every other note: ${note}`);
});

Deno.test("the same criteria on Gmail are honoured and disclose nothing", () => {
  const search: NormalizedSearch = { subject: "invoice", has_attachment: true };
  assertEquals(toGmailQuery(search), "subject:invoice has:attachment", "Gmail runs it");
  assertEquals(
    unappliedSearchFields(search, "gmail").length,
    0,
    "so there is nothing to disclose",
  );
});

Deno.test("Graph drops its whole $filter beside a $search, and says which fields", () => {
  // The larger, quieter Outlook drop: a subject search with a date window
  // silently becomes a subject search over all time.
  const search: NormalizedSearch = {
    subject: "invoice",
    unread: true,
    since: "2026-08-01",
    has_attachment: true,
  };
  const graph = toGraphSearch(search);
  assert(!!graph.search && !!graph.filter, "both are produced, and only one may be sent");

  const unapplied = unappliedSearchFields(search, "outlook");
  assertEquals(
    JSON.stringify(unapplied),
    JSON.stringify(["unread", "has_attachment", "since"]),
    "every filter-side criterion is named",
  );
  const note = buildUnappliedSearchNote("outlook", unapplied);
  assert(note.includes("They were not applied"), `plural reads correctly: ${note}`);
  assert(note.includes("does not reflect them"), `plural reads correctly: ${note}`);
});

Deno.test("a negated attachment or flag predicate exists in no dialect", () => {
  // Unreachable from a tool call (buildNormalizedSearch records only `true`),
  // reachable from a stored automation filter, which accepts either boolean and
  // counts it as a criterion. So a rule meaning "unflagged mail only" was
  // expressible, unhonourable and silent.
  for (const provider of ["gmail", "outlook", "imap"]) {
    assertEquals(
      JSON.stringify(unappliedSearchFields({ subject: "x", flagged: false }, provider)),
      JSON.stringify(["flagged"]),
      `${provider}: flagged:false is not a predicate anywhere`,
    );
    assert(
      unappliedSearchFields({ subject: "x", has_attachment: false }, provider)
        .includes("has_attachment"),
      `${provider}: has_attachment:false is not a predicate anywhere`,
    );
  }
});

Deno.test("an unknown provider is treated as the IMAP baseline, not as supported", () => {
  // Fail-safe, matching getProviderCapabilities in index.ts: a connector that
  // forgets to declare itself over-reports drops rather than under-reporting
  // them. Over-reporting costs a sentence; under-reporting is F-04.
  assertEquals(searchDialectFor("fastmail"), "imap", "fastmail is IMAP since 2026-06-01");
  assertEquals(searchDialectFor("something-new"), "imap", "and so is anything unknown");
  assert(
    unappliedSearchFields({ subject: "x", has_attachment: true }, "something-new")
      .includes("has_attachment"),
    "an unrecognised provider still reports the baseline's drops",
  );
});

Deno.test("the destructive refusal names the tool, the field and a way forward", () => {
  // The destructive half of the fix: search_and_move / search_and_delete do not
  // get the note, they get this. See buildUnappliedSearchRefusal for why, and
  // LENIENT_ACTIONS in consolidated-arguments.ts for the precedent.
  const refusal = buildUnappliedSearchRefusal(
    "email_search_and_delete",
    "imap",
    ["has_attachment"],
  );
  assert(refusal.startsWith("email_search_and_delete:"), `names the tool: ${refusal}`);
  assert(refusal.includes("'has_attachment'"), `names the field: ${refusal}`);
  assert(refusal.includes("generic IMAP"), `names the provider: ${refusal}`);
  assert(refusal.includes("no mail was"), `says nothing was touched: ${refusal}`);
  assert(refusal.includes("WIDER"), `says which direction the error would run: ${refusal}`);
  assert(
    refusal.includes('email_read {action: "search"}'),
    `offers the read that shows the same set without acting: ${refusal}`,
  );
  // It must NOT read like the note: a caller that gets this has no result.
  assert(!refusal.startsWith("Note: "), "a refusal is not a note");
});

Deno.test("the subject fallback description does not promise substring matching", () => {
  // MEASURED 2026-09-20 on a live Gmail-over-IMAP mailbox: `subject: "sigtext"`
  // matched, `subject: "sigtex"` returned 0, and the leading fragment
  // "[MCPE-TEST-20260920-1501] G" of a subject that matched in full returned 0
  // too. The matching is per-token, and this constant said "Multi-word phrases
  // are matched as-is" until 2026-09-21, which a reader takes as a substring
  // promise and then reads an empty result as "that mail does not exist".
  //
  // SEARCH_SCHEMA_DESCRIPTIONS in index.ts is what actually ships for this
  // field and was corrected in the previous round; this constant is the
  // fallback behind it. index.ts cannot be imported here (it calls Deno.serve
  // at load), so the two are held together by asserting the same facts of both
  // rather than by comparing the strings.
  const subject = SEARCH_FIELD_DESCRIPTIONS["subject"];
  assert(
    !/as-is/i.test(subject),
    `the phrase that read as a substring promise is gone: ${subject}`,
  );
  assert(/whole words/i.test(subject), `says what Gmail and Outlook do: ${subject}`);
  assert(/substring/i.test(subject), `and what a conventional IMAP server does: ${subject}`);
  assert(/gmail/i.test(subject) && /outlook/i.test(subject), `names both: ${subject}`);
});

// ── Graph $search: one pair of quotes, not two ──────────────────────────────
//
// Until 2026-09-25 toGraphSearch quoted every clause ("from:alice" AND …) and
// searchOutlookMessages then quoted the whole expression again, so the wire
// value was `""from:alice" AND "subject:report""` — a KQL syntax error on every
// structured Outlook search. toGraphSearch now emits UNQUOTED KQL, and the one
// wrapping for the URL parameter happens in graphSearchParam (outlook-graph.ts).

Deno.test("toGraphSearch emits bare KQL clauses, phrase-quoting only multi-word values", () => {
  assertEquals(
    toGraphSearch({ from: "alice@example.com", subject: "report" }).search,
    "from:alice@example.com AND subject:report",
    "single words stay bare",
  );
  assertEquals(
    toGraphSearch({ subject: "q3 report" }).search,
    'subject:"q3 report"',
    "a multi-word value is one KQL phrase",
  );
  assertEquals(
    toGraphSearch({ text: 'say "hi" there' }).search,
    '"say hi there"',
    "embedded quotes are removed, not escaped (a KQL phrase cannot hold its delimiter)",
  );
  assertEquals(
    toGraphSearch({ subject: "x", raw: "from:a OR from:b" }).search,
    "subject:x AND (from:a OR from:b)",
    "raw is native KQL, parenthesised so its OR cannot swallow the structured clauses",
  );
});

Deno.test("the $search parameter wraps the whole KQL once and escapes inner quotes", () => {
  const kql = toGraphSearch({ from: "alice", subject: "q3 report" }).search ?? "";
  const param = graphSearchParam(kql);
  assertEquals(param, '"from:alice AND subject:\\"q3 report\\""', "one outer pair, inner quotes backslashed");
  assert(!param.startsWith('""'), "never double-quoted at the start");
  assertEquals(graphSearchParam('a\\b'), '"a\\\\b"', "a backslash is escaped too");
  // URL-encoded exactly once by URLSearchParams.
  const qs = new URLSearchParams({ $search: param }).toString();
  assertEquals(
    decodeURIComponent(qs.replace(/\+/g, " ")),
    '$search="from:alice AND subject:\\"q3 report\\""',
    "the decoded query string is the documented shape",
  );
});
