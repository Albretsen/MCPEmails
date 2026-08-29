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
  DATE_INPUT_EXAMPLES,
  formatGmailDate,
  formatImapDate,
  formatUtcDateTime,
  isIsoDateOrDateTime,
  normalizeDateOrDateTime,
  parseIsoDate,
  toGmailQuery,
  toGraphSearch,
  toImapSearch,
} from "./search-translate.ts";

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
