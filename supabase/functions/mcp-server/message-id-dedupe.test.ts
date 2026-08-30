// ---------------------------------------------------------------------------
// The assertion that matters here is not "the array got shorter". It is that
// the surviving list is what a caller's own `results` array will be zipped
// against: same order, first occurrence, nothing invented. A dedupe that
// reordered would be worse than no dedupe, because the per-message outcomes
// would silently line up against the wrong ids.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assertEquals } from "jsr:@std/assert@1";
import { dedupeMessageIds, duplicateCount } from "./message-id-dedupe.ts";

// The exact list from the production reproduction: two distinct ids, one
// duplicate of the first, one id that does not exist. The bug reported
// succeeded: 3; the fix must make the affected set exactly [A, B, bogus].
const REPRO = ["A", "B", "A", "bogus"];

Deno.test("the production repro collapses to three distinct ids in order", () => {
  assertEquals(dedupeMessageIds(REPRO), ["A", "B", "bogus"]);
});

Deno.test("reported success count equals the distinct ids actually affected", () => {
  const distinct = dedupeMessageIds(REPRO);
  // Everything but the nonexistent id succeeds, mirroring the live call.
  const succeeded = distinct.filter((id) => id !== "bogus");
  const failed = distinct.filter((id) => id === "bogus");
  assertEquals(succeeded.length, 2);
  assertEquals(failed.length, 1);
  assertEquals(succeeded.length + failed.length, distinct.length);
  // The old behaviour: four ids in, three "successes" out, A listed twice.
  assertEquals(duplicateCount(REPRO, distinct), 1);
});

Deno.test("first occurrence is the one kept", () => {
  assertEquals(dedupeMessageIds(["b", "a", "b", "c", "a"]), ["b", "a", "c"]);
});

Deno.test("an all-duplicates list collapses to a single id", () => {
  assertEquals(dedupeMessageIds(["A", "A", "A", "A"]), ["A"]);
});

Deno.test("empty input yields an empty list", () => {
  assertEquals(dedupeMessageIds([]), []);
});

Deno.test("a list with no duplicates is returned unchanged", () => {
  const ids = ["1", "2", "3"];
  assertEquals(dedupeMessageIds(ids), ids);
  assertEquals(duplicateCount(ids, dedupeMessageIds(ids)), 0);
});

Deno.test("whitespace-padded repeats are the same id", () => {
  assertEquals(dedupeMessageIds([" A ", "A", "\tA"]), ["A"]);
});

Deno.test("blanks and non-strings are dropped, not counted as ids", () => {
  assertEquals(dedupeMessageIds(["A", "", "   ", null, 7, "B"]), ["A", "B"]);
});
