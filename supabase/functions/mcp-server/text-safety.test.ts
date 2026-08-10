// ---------------------------------------------------------------------------
// Bidi / control-character neutralisation.
//
// The payloads here are real, not illustrative. `RLO` below is U+202E RIGHT-TO-
// LEFT OVERRIDE; put it in the middle of a filename and the tail renders
// reversed, so an executable displays as a PDF. Every assertion in this file is
// about a string a human is asked to make a send-or-not decision from.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

// Walking an arbitrary neutralised structure is untyped by nature.
// deno-lint-ignore-file no-explicit-any

import {
  neutralizeDeep,
  neutralizeList,
  neutralizeMaybe,
  neutralizeText,
} from "./text-safety.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

/** U+202E RIGHT-TO-LEFT OVERRIDE. */
const RLO = "\u202e";
/** U+2066 LEFT-TO-RIGHT ISOLATE. */
const LRI = "\u2066";
/** U+200B ZERO WIDTH SPACE. */
const ZWSP = "\u200b";

Deno.test("the attack that started this: an .exe that renders as a .pdf", () => {
  // Displayed by any bidi-aware renderer as `invoiceexe.pdf`.
  const spoofed = `invoice${RLO} fdp.exe`;
  assert(spoofed.includes(RLO), "the fixture must actually contain U+202E");

  const safe = neutralizeText(spoofed);
  assertEquals(safe, "invoice fdp.exe", "the override is removed, the bytes stay");
  assert(!safe.includes(RLO), "no bidi override survives");
  // The point is not that the name becomes pretty. It is that it can no longer
  // claim to end in `.pdf`.
  assert(safe.endsWith(".exe"), "the real extension is now the visible one");
});

Deno.test("subjects and display names get the same treatment", () => {
  assertEquals(
    neutralizeText(`Invoice ${RLO}FDP.exe from Accounts`),
    "Invoice FDP.exe from Accounts",
    "subject line",
  );
  assertEquals(
    neutralizeText(`Finance${ZWSP} Team`),
    "Finance Team",
    "a zero-width space that splits a name for a filter but not for an eye",
  );
  assertEquals(
    neutralizeText(`${LRI}payments@evil.example${RLO}`),
    "payments@evil.example",
    "isolates and overrides around an address",
  );
});

Deno.test("every character class in the contract is covered", () => {
  const cases: Array<[string, string]> = [
    ["\u0000null", "null"],           // C0 NUL
    ["be\u0007ll", "bell"],           // C0 BEL
    ["\u001b[31mred", "[31mred"],     // C0 ESC, i.e. an ANSI sequence
    ["de\u007fl", "del"],             // DEL
    ["C\u009f1", "C1"],               // C1 APC
    ["a\u200bb", "ab"],               // ZERO WIDTH SPACE
    ["a\u200cb", "ab"],               // ZERO WIDTH NON-JOINER
    ["a\u200fb", "ab"],               // RIGHT-TO-LEFT MARK
    ["a\u202ab", "ab"],               // LEFT-TO-RIGHT EMBEDDING
    ["a\u202db", "ab"],               // LEFT-TO-RIGHT OVERRIDE
    ["a\u202eb", "ab"],               // RIGHT-TO-LEFT OVERRIDE
    ["a\u2060b", "ab"],               // WORD JOINER
    ["a\u2069b", "ab"],               // POP DIRECTIONAL ISOLATE
    ["\ufeffBOM", "BOM"],             // BYTE ORDER MARK
  ];
  for (const [input, expected] of cases) {
    assertEquals(neutralizeText(input), expected, `stripped: ${JSON.stringify(input)}`);
  }
});

Deno.test("legitimate text is never touched", () => {
  // Tab, newline and carriage return are structure, not camouflage; stripping
  // them would mangle every multi-line value we store.
  assertEquals(neutralizeText("line\tone\r\nline two"), "line\tone\r\nline two", "whitespace");
  // Non-Latin scripts, emoji, combining marks and RTL LETTERS (as opposed to
  // RTL control characters) all survive intact. Neutralising the letters would
  // be the cure being worse than the disease.
  assertEquals(neutralizeText("مرحبا بالعالم"), "مرحبا بالعالم", "Arabic letters");
  assertEquals(neutralizeText("שלום עולם"), "שלום עולם", "Hebrew letters");
  assertEquals(neutralizeText("Grüße 你好 🎉 café"), "Grüße 你好 🎉 café", "mixed scripts");
  assertEquals(neutralizeText(""), "", "empty string");
});

Deno.test("neutralizeList drops non-strings instead of coercing them", () => {
  assertEquals(
    neutralizeList([`a${RLO}@x.com`, 42, null, "b@x.com", undefined]),
    ["a@x.com", "b@x.com"],
    "list",
  );
  assertEquals(neutralizeList("not a list"), [], "a non-array is an empty list");
  assertEquals(neutralizeList(undefined), [], "undefined is an empty list");
});

Deno.test("neutralizeMaybe passes non-strings through unchanged", () => {
  assertEquals(neutralizeMaybe(null), null, "null");
  assertEquals(neutralizeMaybe(undefined), undefined, "undefined");
  assertEquals(neutralizeMaybe(7), 7, "number");
  assertEquals(neutralizeMaybe(`x${RLO}y`), "xy", "string");
});

Deno.test("neutralizeDeep reaches every string in a nested payload", () => {
  const dirty = {
    subject: `Invoice ${RLO}FDP.exe`,
    to: [`a${ZWSP}@x.com`],
    attachments: [{ filename: `invoice${RLO} fdp.exe`, size_bytes: 10 }],
    nested: { deeper: { value: `x${RLO}y` } },
    untouched: 42,
    flag: true,
    nothing: null,
  };
  const clean = neutralizeDeep(dirty);
  assertEquals(clean.subject, "Invoice FDP.exe", "top-level string");
  assertEquals(clean.to, ["a@x.com"], "string in an array");
  assertEquals(clean.attachments[0].filename, "invoice fdp.exe", "string in an object in an array");
  assertEquals(clean.nested.deeper.value, "xy", "deeply nested string");
  assertEquals(clean.untouched, 42, "numbers survive");
  assertEquals(clean.flag, true, "booleans survive");
  assertEquals(clean.nothing, null, "null survives");
  // A copy, not a mutation: the caller's original is not silently rewritten.
  assert(dirty.subject.includes(RLO), "the input is left alone");
});

Deno.test("neutralizeDeep is bounded, because the payload is not trusted either", () => {
  // Depth: past the limit the value is returned as-is rather than recursed into
  // forever. A hostile payload cannot turn this into a stack overflow.
  let deep: Record<string, unknown> = { value: `x${RLO}y` };
  for (let i = 0; i < 40; i++) deep = { child: deep };
  const cleaned = neutralizeDeep(deep) as Record<string, any>;
  let cursor: any = cleaned;
  let depth = 0;
  while (cursor?.child) {
    cursor = cursor.child;
    depth++;
  }
  assertEquals(depth, 40, "the structure is preserved even where it stops cleaning");

  // Width: arrays are capped, so a million-element array cannot be walked.
  const wide = new Array(1200).fill(`a${RLO}b`);
  assertEquals((neutralizeDeep(wide) as string[]).length, 500, "array length is capped at 500");
});

// NOTE: this is the only test in the suite that touches the filesystem, so the
// suite must be run as:
//
//     deno test --allow-read supabase/functions/mcp-server/
//
// Without the flag this test fails with NotCapable rather than skipping, and
// that is deliberate. A drift check that quietly does not run is worse than no
// drift check, because it reads as green while the three copies diverge.
Deno.test("the three copies of the character class agree", async () => {
  // This module, the card (apps/mcp-app/src/sanitize.ts) and the web app
  // (apps/web/src/lib/textSafety.ts) each hold their own copy because they run
  // in three different runtimes. If they drift, a string neutralised on one
  // surface is still spoofable on another, which is precisely the bug this
  // change exists to close. Compare the source text.
  const CLASS =
    "/[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u200b-\\u200f" +
    "\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]/g";
  const here = new URL(".", import.meta.url).pathname;
  const files = [
    `${here}text-safety.ts`,
    `${here}../../../apps/mcp-app/src/sanitize.ts`,
    `${here}../../../apps/web/src/lib/textSafety.ts`,
  ];
  for (const file of files) {
    const source = await Deno.readTextFile(file);
    assert(
      source.includes(CLASS),
      `${file} does not contain the shared character class verbatim — the copies have drifted`,
    );
  }
});
