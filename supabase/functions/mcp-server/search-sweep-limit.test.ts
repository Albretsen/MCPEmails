// ---------------------------------------------------------------------------
// Search-sweep truncation tests.
//
// Production defect F8 (2026-08-30): a search_and_move with limit:1 against
// three matching messages returned
//   {"succeeded":1,"failed":0,"operation":"email_search_and_move", ...}
// which is byte-for-byte the response of a sweep that finished. What is asserted
// here is mostly the wording and the boundaries, not arithmetic: the failure
// mode is a model reading a truncated result as a completion.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { searchSweepLimitFields } from "./search-sweep-limit.ts";

// ── F8: the reproduction ────────────────────────────────────────────────────

Deno.test("F8: limit 1 against three matches says so, loudly", () => {
  const f = searchSweepLimitFields({
    verb: "move",
    matched: 1,
    limit: 1,
    processed: 1,
    totalMatches: 3,
    providerHasMore: true,
  });

  assertEquals(f.match_count, 1);
  assertEquals(f.limit, 1);
  assertEquals(f.limit_reached, true);
  assertEquals(f.has_more, true);
  assertEquals(f.total_matches, 3);
  assert(f.limit_notice, "a truncated sweep must carry a notice");
  assertStringIncludes(f.limit_notice!, "INCOMPLETE");
  assertStringIncludes(f.limit_notice!, "2 more match the query");
});

Deno.test("F8: the delete wording says deleted, not moved", () => {
  const f = searchSweepLimitFields({
    verb: "delete",
    matched: 1,
    limit: 1,
    processed: 1,
    totalMatches: 3,
    providerHasMore: true,
  });
  assertStringIncludes(f.limit_notice!, "deleted 1 message");
  assert(!f.limit_notice!.includes("moved"));
});

// ── Boundaries ──────────────────────────────────────────────────────────────

Deno.test("fewer matches than the limit is a finished sweep", () => {
  const f = searchSweepLimitFields({
    verb: "move",
    matched: 2,
    limit: 10,
    processed: 2,
    totalMatches: 2,
    providerHasMore: false,
  });
  assertEquals(f.limit_reached, false);
  assertEquals(f.has_more, false);
  assertEquals(f.limit_notice, undefined);
});

Deno.test("exactly the limit, with the provider confirming no more, is finished", () => {
  const f = searchSweepLimitFields({
    verb: "move",
    matched: 3,
    limit: 3,
    processed: 3,
    totalMatches: 3,
    providerHasMore: false,
  });
  assertEquals(f.limit_reached, true, "the window WAS filled");
  assertEquals(f.has_more, false, "but the provider proved nothing was left");
  assertEquals(f.limit_notice, undefined);
});

Deno.test("exactly the limit with no provider signal warns rather than assumes", () => {
  // Outlook queries without @odata.count land here. An unnecessary re-check
  // costs one call; a missed one is the bug.
  const f = searchSweepLimitFields({
    verb: "delete",
    matched: 3,
    limit: 3,
    processed: 3,
  });
  assertEquals(f.limit_reached, true);
  assertEquals(f.has_more, true);
  assert(f.limit_notice);
  assertStringIncludes(f.limit_notice!, "More messages match the query");
});

Deno.test("more matches than the limit is always a truncation", () => {
  const f = searchSweepLimitFields({
    verb: "move",
    matched: 100,
    limit: 100,
    processed: 100,
    totalMatches: 412,
    providerHasMore: true,
  });
  assertEquals(f.has_more, true);
  assertStringIncludes(f.limit_notice!, "312 more match the query");
});

Deno.test("a total larger than what came back overrides a provider 'no more'", () => {
  const f = searchSweepLimitFields({
    verb: "move",
    matched: 5,
    limit: 5,
    processed: 5,
    totalMatches: 40,
    providerHasMore: false,
  });
  assertEquals(f.has_more, true, "the count itself is proof mail was left behind");
});

Deno.test("zero matches is a finished sweep, not a truncation", () => {
  const f = searchSweepLimitFields({
    verb: "delete",
    matched: 0,
    limit: 500,
    processed: 0,
    totalMatches: 0,
    providerHasMore: false,
  });
  assertEquals(f.match_count, 0);
  assertEquals(f.limit_reached, false);
  assertEquals(f.has_more, false);
  assertEquals(f.limit_notice, undefined);
});

Deno.test("an estimate-happy provider cannot cry truncation on a short result", () => {
  // Gmail's resultSizeEstimate routinely overshoots. A search that came back
  // under its own limit cannot have been cut off BY the limit.
  const f = searchSweepLimitFields({
    verb: "move",
    matched: 4,
    limit: 500,
    processed: 4,
    totalMatches: 9,
    totalIsEstimate: true,
    providerHasMore: true,
  });
  assertEquals(f.limit_reached, false);
  assertEquals(f.has_more, false);
  assertEquals(f.limit_notice, undefined);
});

// ── Reporting details ───────────────────────────────────────────────────────

Deno.test("has_more is ALWAYS present, so absence is never the signal", () => {
  for (
    const input of [
      { verb: "move" as const, matched: 0, limit: 500, processed: 0 },
      { verb: "move" as const, matched: 500, limit: 500, processed: 500 },
      { verb: "delete" as const, matched: 7, limit: 500, processed: 3 },
    ]
  ) {
    const f = searchSweepLimitFields(input);
    assertEquals(typeof f.has_more, "boolean");
    assertEquals(typeof f.limit_reached, "boolean");
    assertEquals(typeof f.match_count, "number");
  }
});

Deno.test("an estimated total is flagged as an estimate in both field and prose", () => {
  const f = searchSweepLimitFields({
    verb: "move",
    matched: 10,
    limit: 10,
    processed: 10,
    totalMatches: 55,
    totalIsEstimate: true,
    providerHasMore: true,
  });
  assertEquals(f.total_matches, 55);
  assertEquals(f.total_matches_is_estimate, true);
  assertStringIncludes(f.limit_notice!, "Roughly 45 more");
  assertStringIncludes(f.limit_notice!, "estimate");
});

Deno.test("no provider total means no total fields at all, not a zero", () => {
  const f = searchSweepLimitFields({
    verb: "move",
    matched: 10,
    limit: 10,
    processed: 10,
    totalMatches: null,
  });
  assertEquals(f.total_matches, undefined);
  assertEquals(f.total_matches_is_estimate, undefined);
});

Deno.test("the notice counts what was PROCESSED, not what was matched", () => {
  // A sweep can match 10, be cut off at 10 by the limit, and only succeed on 6
  // (four provider failures). Saying "moved 10" there would be a second lie.
  const f = searchSweepLimitFields({
    verb: "move",
    matched: 10,
    limit: 10,
    processed: 6,
    totalMatches: 30,
    providerHasMore: true,
  });
  assertStringIncludes(f.limit_notice!, "moved 6 messages");
  assertStringIncludes(f.limit_notice!, "24 more match the query");
});

Deno.test("the notice tells the caller what to do next", () => {
  const f = searchSweepLimitFields({
    verb: "delete",
    matched: 500,
    limit: 500,
    processed: 500,
    providerHasMore: true,
  });
  assertStringIncludes(f.limit_notice!, "has_more is false");
  assertStringIncludes(f.limit_notice!, "Do not report the mailbox as fully swept");
});
