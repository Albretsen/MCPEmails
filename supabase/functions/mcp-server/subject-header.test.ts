// ---------------------------------------------------------------------------
// The subject cap, in the unit that actually binds.
//
// The production repro is the first assertion in this file: a 998-character
// ASCII subject was ACCEPTED by the old cap, folded in transit, and delivered
// with a space inserted nine characters from the end — corrupting the subject
// and leaving a duplicate in Sent. Every test here is about the octet length of
// the header line as this server emits it, not about wording.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import {
  checkSubjectHeaderLine,
  encodeSubjectHeaderValue,
  HEADER_LINE_MAX_OCTETS,
  longestFittingSubjectChars,
  SUBJECT_FIELD_PREFIX,
  SUBJECT_MAX_CHARS,
  subjectCharCount,
  subjectHeaderLineError,
  subjectHeaderLineOctets,
  truncateSubjectToChars,
} from "./subject-header.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ── The production repro ───────────────────────────────────────────────────

Deno.test("a 998-character ASCII subject is REJECTED — the old cap sent it and corrupted it", () => {
  const subject = "s".repeat(998);
  const check = checkSubjectHeaderLine(subject);

  assertEquals(check.ok, false, "998 characters is 1007 octets on the wire");
  assertEquals(check.octets, 1007, `"${SUBJECT_FIELD_PREFIX}" costs nine octets and they were never counted`);
  assertEquals(check.reason, "too_long", "classified as over the line limit");
  assertEquals(check.maxChars, 989, "and the caller is told exactly what will fit");
});

Deno.test("the limit is the LINE, so the boundary sits at 989 characters for ASCII", () => {
  assertEquals(checkSubjectHeaderLine("a".repeat(989)).ok, true, "989 + 9 = 998, the last legal line");
  assertEquals(subjectHeaderLineOctets("a".repeat(989)), HEADER_LINE_MAX_OCTETS, "exactly at the limit");
  assertEquals(checkSubjectHeaderLine("a".repeat(990)).ok, false, "990 + 9 = 999, one octet too many");
  assertEquals(SUBJECT_MAX_CHARS, 989, "the schema cap agrees with the arithmetic");
});

// ── Non-ASCII: the reason a character count cannot express this ────────────

Deno.test("a SHORT non-ASCII subject can still overflow, which no character cap can catch", () => {
  // 250 emoji: 250 characters by any user-facing count, 500 UTF-16 units,
  // 1000 UTF-8 bytes, and a 1357-octet header line once RFC 2047 encoded. A cap
  // of 989 characters — or of 998 — waves this straight through.
  const subject = "\u{1F600}".repeat(250);
  const check = checkSubjectHeaderLine(subject);

  assertEquals(check.ok, false, "rejected on octets, not on characters");
  assertEquals(check.encoded, true, "and told the caller why the two differ");
  assert(check.octets > HEADER_LINE_MAX_OCTETS, `header line is ${check.octets} octets`);
  assertEquals(subjectCharCount(subject), 250, "250 characters, whatever String.length says");
  assert(
    subjectCharCount(subject) < SUBJECT_MAX_CHARS,
    "the fixture is well under any character cap, which is the whole point",
  );
  assert(check.maxChars > 0 && check.maxChars < 250, "a shorter subject would fit");
});

Deno.test("the advice actually fits: the suggested prefix passes its own check", () => {
  for (
    const subject of [
      "x".repeat(2_000),
      "\u{1F600}".repeat(250),
      "こんにちは".repeat(200),
      "café ".repeat(300),
    ]
  ) {
    const { maxChars } = checkSubjectHeaderLine(subject);
    const trimmed = truncateSubjectToChars(subject, maxChars);
    assert(
      checkSubjectHeaderLine(trimmed).ok,
      `advised prefix of ${maxChars} chars must fit (${subjectHeaderLineOctets(trimmed)} octets)`,
    );
    // And it is the LONGEST such prefix, so the advice is not needlessly harsh.
    if (maxChars < subjectCharCount(subject)) {
      assert(
        !checkSubjectHeaderLine(truncateSubjectToChars(subject, maxChars + 1)).ok,
        "one character more must not fit",
      );
    }
  }
});

Deno.test("the advised cut never lands inside a surrogate pair", () => {
  // A prefix ending on a lone high surrogate is not a subject anybody can send.
  // Counting code points is what makes that unrepresentable.
  const subject = "a".repeat(700) + "\u{1F600}".repeat(200);
  const maxChars = longestFittingSubjectChars(subject);
  const trimmed = truncateSubjectToChars(subject, maxChars);
  const lastCode = trimmed.charCodeAt(trimmed.length - 1);
  assert(!(lastCode >= 0xd800 && lastCode <= 0xdbff), "no orphaned high surrogate");
  assert(checkSubjectHeaderLine(trimmed).ok, "and the trimmed subject is sendable");
});

Deno.test("a CJK subject is measured in bytes, not in characters", () => {
  // 3 bytes each, so ~246 characters is the ceiling — a limit a character
  // count would put at 989 and a UTF-8 byte count would put at 329.
  const check = checkSubjectHeaderLine("あ".repeat(400));
  assertEquals(check.ok, false, "400 CJK characters cannot fit a 998-octet line");
  assert(check.maxChars > 200 && check.maxChars < 300, `expected ~246, got ${check.maxChars}`);
});

// ── Ordinary mail is untouched ─────────────────────────────────────────────

Deno.test("everyday subjects are accepted, ASCII or not", () => {
  for (
    const subject of [
      "Re: lunch",
      "Invoice 2026-08 attached",
      "Møte på torsdag kl. 14",
      "Q3 planning \u{1F680}",
      "s".repeat(200),
      "s".repeat(989),
    ]
  ) {
    const check = checkSubjectHeaderLine(subject);
    assertEquals(check.ok, true, `must accept: ${subject.slice(0, 40)}`);
    assertEquals(check.reason, null, "no reason to give");
    assertEquals(subjectHeaderLineError("email_compose", subject), null, "and no error sentence");
  }
});

Deno.test("an empty, blank or non-string subject is rejected", () => {
  for (const subject of ["", "   ", "\t\n", undefined, null, 42, {}]) {
    const check = checkSubjectHeaderLine(subject);
    assertEquals(check.ok, false, `must reject: ${JSON.stringify(subject)}`);
    assertEquals(check.reason, "empty", "distinguished from too_long, because the fix differs");
  }
});

// ── The encoder this validation is measuring ───────────────────────────────

Deno.test("control characters are collapsed before measuring, as the sender does", () => {
  // The CRLF strip is a header-injection fix, and it CHANGES the length: a
  // validator that measured the raw value would disagree with the sender.
  assertEquals(encodeSubjectHeaderValue("a\r\nb"), "a b", "one space for the run");
  assertEquals(subjectHeaderLineOctets("a\r\nb"), SUBJECT_FIELD_PREFIX.length + 3, "measured after the strip");
  // 988 characters plus a four-character control run: measured raw that is 992
  // characters, but the run collapses to one space and 989 fits exactly.
  assertEquals(checkSubjectHeaderLine("a".repeat(988) + "\r\n\r\n").ok, true, "collapses to 989, which fits");
  assertEquals(checkSubjectHeaderLine("a".repeat(989) + "\r\n\r\n").ok, false, "one more collapses to 990, which does not");
});

Deno.test("an ASCII subject passes through verbatim; a non-ASCII one becomes one encoded-word", () => {
  assertEquals(encodeSubjectHeaderValue("Plain subject"), "Plain subject", "no needless encoding");
  const encoded = encodeSubjectHeaderValue("Møte");
  assert(encoded.startsWith("=?UTF-8?B?") && encoded.endsWith("?="), "RFC 2047 encoded-word");
  assertEquals(subjectHeaderLineOctets("Møte"), SUBJECT_FIELD_PREFIX.length + encoded.length, "octets are the encoded form");
});

// ── The message a model has to act on ──────────────────────────────────────

Deno.test("the rejection names the tool, the real limit, and a length that would work", () => {
  const message = subjectHeaderLineError("email_compose", "s".repeat(998))!;
  assert(message.startsWith("email_compose:"), "names the tool, like every other pre-flight error");
  assert(message.includes("at most 989 characters"), "gives an actionable target");
  assert(message.includes("998 octets"), "names the real limit and its unit");
  assert(message.includes("1007"), "and what this subject actually measures");
  assert(message.includes("nothing was sent"), "states that no message landed in Sent");
});

Deno.test("a non-ASCII rejection explains why the character count was not the problem", () => {
  const message = subjectHeaderLineError("schedule", "\u{1F600}".repeat(250))!;
  assert(message.includes("RFC 2047"), "names the encoding that expanded it");
  assert(!message.includes("at most 989 characters"), "the ASCII number would be wrong advice here");
});
