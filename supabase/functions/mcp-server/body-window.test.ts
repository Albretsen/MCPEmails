// ---------------------------------------------------------------------------
// Body windowing is arithmetic, and the arithmetic is the part that must not be
// wrong. A cap that reports the wrong next offset is worse than no cap at all:
// it strands the agent exactly the way microsoft/vscode#311068 describes, told
// a recovery path exists and unable to walk it.
//
// So these tests are not about wording. They assert four properties:
//
//   1. Ordinary mail is untouched, and carries NO new fields.
//   2. A cut always announces itself, with the true total.
//   3. Feeding body_next_offset back returns the following characters exactly,
//      and walking the whole body reconstructs it byte for byte.
//   4. Neither budget in read_batch can be exceeded, and a surrogate pair is
//      never split.
//
// Run: deno test --allow-read supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import {
  batchBodyAllowance,
  BATCH_BODY_RESPONSE_CHARS,
  BATCH_READ_BODY_CHARS,
  BODY_MAX_CHARS_CEILING,
  clampBodyMaxChars,
  readBodyOffset,
  SINGLE_READ_BODY_CHARS,
  singleReadContinuation,
  windowBody,
} from "./body-window.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** A single read's window, with the recovery sentence the server really emits. */
function readWindow(body: string | null, offset: number, maxChars = SINGLE_READ_BODY_CHARS) {
  return windowBody(body, {
    offset,
    maxChars,
    prefix: "body",
    recovery: (next) => singleReadContinuation("m1", next, false),
  });
}

// ── 1. Ordinary mail is untouched ──────────────────────────────────────────

Deno.test("a body under the cap comes back whole, with no truncation fields", () => {
  // The largest real body measured during the token-cost investigation was a
  // four-deep reply chain at 3,033 characters. Anything at that scale must be
  // indistinguishable from what the server returned before the cap existed.
  const body = "x".repeat(3_033);
  const w = readWindow(body, 0);

  assertEquals(w.text, body, "body returned verbatim");
  assertEquals(Object.keys(w.fields).length, 0, "no continuation fields at all");
  assertEquals(w.emitted, 3_033, "emitted count is the whole body");
});

Deno.test("a null body stays null and reports nothing", () => {
  const w = readWindow(null, 0);
  assertEquals(w.text, null, "null in, null out");
  assertEquals(Object.keys(w.fields).length, 0, "nothing to report about a body that is not there");
});

Deno.test("a body exactly at the cap is not marked truncated", () => {
  const body = "y".repeat(SINGLE_READ_BODY_CHARS);
  const w = readWindow(body, 0);
  assertEquals(w.text?.length, SINGLE_READ_BODY_CHARS, "whole body");
  assertEquals(w.fields.body_truncated, undefined, "an off-by-one here would truncate every full-cap body");
});

// ── 2. A cut announces itself, truthfully ──────────────────────────────────

Deno.test("a body over the cap is cut, and says so with the true total", () => {
  const body = "z".repeat(20_000);
  const w = readWindow(body, 0);

  assertEquals(w.text?.length, SINGLE_READ_BODY_CHARS, "window is the cap");
  assertEquals(w.fields.body_truncated, true, "never a silent slice");
  assertEquals(w.fields.body_total_chars, 20_000, "the TOTAL, not the window");
  assertEquals(w.fields.body_offset, 0, "window start");
  assertEquals(w.fields.body_next_offset, SINGLE_READ_BODY_CHARS, "resume point");
  assert(typeof w.fields.body_continue === "string", "a recovery sentence is present");
});

Deno.test("the continuation names a parameter this server accepts", () => {
  const w = readWindow("q".repeat(20_000), 0);
  const sentence = String(w.fields.body_continue);
  // The whole point of the marker. A hint naming a client capability, or a
  // cursor the server never issued, is worse than no hint (vscode#311068).
  assert(sentence.includes("email_read"), "names the tool");
  assert(sentence.includes("body_offset:"), "names the parameter, not a cursor concept");
  assert(sentence.includes(String(SINGLE_READ_BODY_CHARS)), "carries the actual offset value");
  assert(sentence.includes("m1"), "carries the message id");
});

Deno.test("the html continuation names body_html_offset, not body_offset", () => {
  // body_text and body_html are different strings of different lengths, so one
  // shared offset could only ever be right for one of them.
  const sentence = singleReadContinuation("m1", 8_000, true);
  assert(sentence.includes("body_html_offset:"), "html has its own offset parameter");
  assert(sentence.includes("include_html: true"), "and the flag that produces an html body at all");
});

// ── 3. The continuation actually continues ─────────────────────────────────

Deno.test("body_next_offset yields the next chunk, with nothing lost or repeated", () => {
  const body = Array.from({ length: 30_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
  const first = readWindow(body, 0);
  const next = Number(first.fields.body_next_offset);

  const second = readWindow(body, next);
  assertEquals(second.text, body.slice(next, next + SINGLE_READ_BODY_CHARS), "exactly the following characters");
  assertEquals(second.fields.body_offset, next, "echoes where it started");
  assertEquals(second.fields.body_total_chars, 30_000, "same total throughout the walk");
});

Deno.test("walking every window reconstructs the body exactly", () => {
  const body = Array.from({ length: 21_111 }, (_, i) => `line ${i} `).join("");
  let offset = 0;
  let rebuilt = "";
  let windows = 0;

  // Bounded so a bug that fails to advance is a test failure, not a hang.
  while (windows < 1_000) {
    const w = readWindow(body, offset);
    rebuilt += w.text ?? "";
    windows++;
    if (w.fields.body_truncated !== true) break;
    const next = Number(w.fields.body_next_offset);
    assert(next > offset, "every window must advance");
    offset = next;
  }

  assertEquals(rebuilt, body, "concatenated windows are the original body");
  assert(windows > 1, "the fixture was large enough to actually need continuation");
});

Deno.test("the final window reports truncated false, so the walk has a positive end", () => {
  const body = "w".repeat(SINGLE_READ_BODY_CHARS + 500);
  const first = readWindow(body, 0);
  const last = readWindow(body, Number(first.fields.body_next_offset));

  assertEquals(last.text?.length, 500, "the remainder");
  assertEquals(last.fields.body_truncated, false, "explicitly finished, not ambiguously silent");
  assertEquals(last.fields.body_total_chars, SINGLE_READ_BODY_CHARS + 500, "total is still stated");
  assertEquals(last.fields.body_next_offset, undefined, "no next offset when there is no next window");
  assertEquals(last.fields.body_continue, undefined, "and no recovery sentence to chase");
});

Deno.test("an offset past the end returns empty and says the walk is over", () => {
  const body = "e".repeat(100);
  const w = readWindow(body, 5_000);
  assertEquals(w.text, "", "nothing left");
  assertEquals(w.fields.body_truncated, false, "not truncated, exhausted");
  assertEquals(w.fields.body_total_chars, 100, "the total is how the model spots its own mistake");
});

Deno.test("a negative or junk offset is read as the beginning, never as a silent skip", () => {
  assertEquals(readBodyOffset(-50), 0, "negative");
  assertEquals(readBodyOffset("800"), 0, "string");
  assertEquals(readBodyOffset(undefined), 0, "absent");
  assertEquals(readBodyOffset(12.9), 12, "fractional truncates toward the start");
  assertEquals(readBodyOffset(800), 800, "an ordinary offset survives");
});

// ── 4a. Multi-byte characters survive the boundary ─────────────────────────

Deno.test("a surrogate pair is never split across a window boundary", () => {
  // Emoji are two UTF-16 code units. A cut between them leaves a lone
  // surrogate on each side: one character destroyed, unrecoverable by any
  // offset. Build a body where the naive cut lands mid-pair.
  const cap = 10;
  const body = "abcdefghi" + "\u{1F600}" + "jklmnop"; // pair occupies units 9 and 10
  const first = windowBody(body, {
    offset: 0,
    maxChars: cap,
    prefix: "body",
    recovery: (n) => `body_offset: ${n}`,
  });

  assertEquals(first.text, "abcdefghi", "cut backs off the pair rather than halving it");
  assertEquals(first.fields.body_next_offset, 9, "and the resume point is the start of the pair");

  const second = windowBody(body, {
    offset: 9,
    maxChars: cap,
    prefix: "body",
    recovery: (n) => `body_offset: ${n}`,
  });
  assert(second.text!.startsWith("\u{1F600}"), "the whole emoji lands in the next window");
  assertEquals(first.text! + second.text!, body, "and the body still reassembles exactly");

  // The proof that matters: no lone surrogate anywhere in either window.
  for (const chunk of [first.text!, second.text!]) {
    for (let i = 0; i < chunk.length; i++) {
      const code = chunk.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const nextCode = chunk.charCodeAt(i + 1);
        assert(nextCode >= 0xdc00 && nextCode <= 0xdfff, "high surrogate must keep its partner");
        i++;
      } else {
        assert(!(code >= 0xdc00 && code <= 0xdfff), "no orphaned low surrogate");
      }
    }
    assert(!JSON.stringify(chunk).includes("\\ud8"), "nothing serialises as a bare escape");
  }
});

Deno.test("a hand-built offset landing mid-pair is nudged back, not forward", () => {
  const body = "ab\u{1F600}cd";
  // Unit 3 is the low half. Moving forward would delete the emoji silently.
  const w = windowBody(body, { offset: 3, maxChars: 10, prefix: "body", recovery: () => "" });
  assertEquals(w.fields.body_offset, 2, "snapped back to the start of the character");
  assert(w.text!.startsWith("\u{1F600}"), "so the character survives");
});

Deno.test("multi-byte characters that are ONE code unit are counted as one", () => {
  // CJK is three BYTES but one UTF-16 unit, so a character cap must not
  // shorten a Japanese mail to a third of an English one.
  const body = "あ".repeat(500);
  const w = readWindow(body, 0, 400);
  assertEquals(w.text?.length, 400, "400 characters, not 400 bytes");
  assertEquals(w.fields.body_total_chars, 500, "total in the same unit");
});

// ── 4b. read_batch budgets ─────────────────────────────────────────────────

Deno.test("read_batch is tighter per message than a single read, on purpose", () => {
  assert(
    BATCH_READ_BODY_CHARS < SINGLE_READ_BODY_CHARS,
    "50 messages share one context; one message does not",
  );
  assert(
    BATCH_BODY_RESPONSE_CHARS < BATCH_READ_BODY_CHARS * 50,
    "the per-message cap alone still permits 100k characters, so the overall ceiling has to bind",
  );
});

Deno.test("a small batch gets the full per-message allowance", () => {
  // Five messages cannot threaten the response budget, so nothing is squeezed.
  for (let i = 0; i < 5; i++) {
    const allowance = batchBodyAllowance(BATCH_READ_BODY_CHARS, BATCH_BODY_RESPONSE_CHARS, 5 - i);
    assertEquals(allowance, BATCH_READ_BODY_CHARS, "no squeeze at five messages");
  }
});

Deno.test("a 50-message batch cannot exceed the overall body budget", () => {
  // Simulate the worst case: every message has an enormous body.
  const huge = "b".repeat(200_000);
  let remaining = BATCH_BODY_RESPONSE_CHARS;
  let total = 0;
  const truncatedFlags: unknown[] = [];

  for (let i = 0; i < 50; i++) {
    const allowance = batchBodyAllowance(BATCH_READ_BODY_CHARS, remaining, 50 - i);
    const w = windowBody(huge, {
      offset: 0,
      maxChars: allowance,
      prefix: "body",
      recovery: (n) => singleReadContinuation(`m${i}`, n, false),
    });
    total += w.emitted;
    remaining -= w.emitted;
    truncatedFlags.push(w.fields.body_truncated);
  }

  assert(total <= BATCH_BODY_RESPONSE_CHARS, `batch emitted ${total} chars, budget is ${BATCH_BODY_RESPONSE_CHARS}`);
  assert(total > BATCH_BODY_RESPONSE_CHARS * 0.9, "and the budget is actually spent, not left on the table");
  assert(
    truncatedFlags.every((flag) => flag === true),
    "every squeezed message says it was squeezed",
  );
});

Deno.test("no message is starved by its position in the batch", () => {
  // First-come budgeting would serve twelve messages and hand the other
  // thirty-eight an empty body. Every message must get the same floor.
  const huge = "c".repeat(200_000);
  let remaining = BATCH_BODY_RESPONSE_CHARS;
  const emitted: number[] = [];

  for (let i = 0; i < 50; i++) {
    const allowance = batchBodyAllowance(BATCH_READ_BODY_CHARS, remaining, 50 - i);
    emitted.push(allowance);
    remaining -= allowance;
  }

  assert(Math.min(...emitted) > 0, "nobody gets nothing");
  assert(
    Math.max(...emitted) - Math.min(...emitted) <= 1,
    `allowances should differ by at most rounding: ${Math.min(...emitted)}..${Math.max(...emitted)}`,
  );
});

Deno.test("a short body hands its unspent budget to the messages after it", () => {
  let remaining = BATCH_BODY_RESPONSE_CHARS;
  const first = batchBodyAllowance(BATCH_READ_BODY_CHARS, remaining, 50);
  remaining -= 10; // this message's body was only 10 characters long
  const second = batchBodyAllowance(BATCH_READ_BODY_CHARS, remaining, 49);
  assert(second > first, "the remainder flows forward instead of being wasted");
});

Deno.test("a batch continuation points at a single read of that exact id", () => {
  // The recovery for a batch entry must NOT be "call read_batch with an
  // offset": there is no such parameter, and inventing one is the stranding
  // failure this whole design exists to avoid.
  const sentence = singleReadContinuation("INBOX:1234", 2_000, false);
  assert(sentence.includes("action: read"), "single read, not the batch");
  assert(sentence.includes("INBOX:1234"), "the specific message");
  assert(sentence.includes("body_offset: 2000"), "with the offset filled in");
});

// ── body_max_chars ─────────────────────────────────────────────────────────

Deno.test("body_max_chars is clamped, and absent means the caller's default", () => {
  assertEquals(clampBodyMaxChars(undefined, SINGLE_READ_BODY_CHARS), SINGLE_READ_BODY_CHARS, "absent");
  assertEquals(clampBodyMaxChars("lots", BATCH_READ_BODY_CHARS), BATCH_READ_BODY_CHARS, "junk");
  assertEquals(clampBodyMaxChars(500, SINGLE_READ_BODY_CHARS), 500, "a smaller ask is honoured");
  assertEquals(clampBodyMaxChars(-1, SINGLE_READ_BODY_CHARS), 0, "negative floors at headers-only");
  assertEquals(
    clampBodyMaxChars(5_000_000, SINGLE_READ_BODY_CHARS),
    BODY_MAX_CHARS_CEILING,
    "the parameter must not re-open the hole it exists to close",
  );
});

// ── 5. A continuation must advance, or it must not be offered ──────────────
//
// The tool description teaches: "when the response says body_truncated, call
// again with body_next_offset as body_offset". A next offset equal to the
// offset that produced it therefore is not a hint, it is a non-terminating
// loop the agent has been instructed to walk. Reproduced in production on
// 1a0527dde6f1cc6b with body_max_chars: 0, which answered
// body_truncated: true / body_next_offset: 0 for ever.

Deno.test("body_max_chars 0 is headers only: a complete answer, with nothing to continue", () => {
  const w = readWindow("d".repeat(4_000), 0, 0);
  assertEquals(w.text, "", "no body, as asked");
  assertEquals(w.fields.body_truncated, false, "headers-only is complete, not truncated");
  assertEquals(w.fields.body_next_offset, undefined, "an offset of 0 here loops for ever");
  assertEquals(w.fields.body_continue, undefined, "and no sentence telling the agent to walk it");
  assertEquals(w.fields.body_total_chars, 4_000, "the total still tells the model a body exists");
  assertEquals(w.emitted, 0, "nothing spent against any budget");
});

Deno.test("body_max_chars 0 on an html body is headers only too", () => {
  const w = windowBody("<p>" + "h".repeat(4_000) + "</p>", {
    offset: 0,
    maxChars: 0,
    prefix: "body_html",
    recovery: (n) => singleReadContinuation("m1", n, true),
  });
  assertEquals(w.text, "", "no html body");
  assertEquals(w.fields.body_html_truncated, false, "identical structure, identical contract");
  assertEquals(w.fields.body_html_next_offset, undefined, "no non-advancing resume point");
  assertEquals(w.fields.body_html_continue, undefined, "no recovery sentence to chase");
  assert(typeof w.fields.body_html_total_chars === "number", "the total is still reported");
});

Deno.test("body_max_chars 0 on an empty body reports nothing at all", () => {
  const w = readWindow("", 0, 0);
  assertEquals(w.text, "", "nothing there");
  assertEquals(Object.keys(w.fields).length, 0, "no body, no truncation story to tell");
});

Deno.test("a truncated window's next offset is always strictly greater than its own offset", () => {
  const body = "n".repeat(50_000);
  for (const maxChars of [1, 2, 7, 100, 999, 8_000]) {
    for (const offset of [0, 1, 13, 4_999]) {
      const w = windowBody(body, {
        offset,
        maxChars,
        prefix: "body",
        recovery: (n) => singleReadContinuation("m1", n, false),
      });
      if (w.fields.body_truncated !== true) continue;
      const next = Number(w.fields.body_next_offset);
      const at = Number(w.fields.body_offset);
      assert(next > at, `next offset ${next} must advance past ${at} (maxChars ${maxChars})`);
    }
  }
});

Deno.test("a one-character window on a body that opens with an emoji still advances", () => {
  // The other route to a non-advancing continuation: the cut backs off the
  // surrogate pair, lands back on `start`, and emits nothing while more
  // remains. The pair has to come along rather than the offset standing still.
  const body = "\u{1F600}tail";
  const w = windowBody(body, { offset: 0, maxChars: 1, prefix: "body", recovery: (n) => `body_offset: ${n}` });
  assertEquals(w.text, "\u{1F600}", "the whole character, not half of one and not none of it");
  assert(Number(w.fields.body_next_offset) > 0, "and the walk moves on");
});

Deno.test("walking a body at a tiny window size terminates", () => {
  // The property the production loop violated, asserted directly: with any
  // legitimate window size, following the documented contract must finish.
  const body = "abc\u{1F600}def\u{1F600}ghij".repeat(40);
  for (const maxChars of [1, 2, 3, 5]) {
    let offset = 0;
    let rebuilt = "";
    let steps = 0;
    while (steps < 5_000) {
      const w = windowBody(body, {
        offset,
        maxChars,
        prefix: "body",
        recovery: (n) => `body_offset: ${n}`,
      });
      rebuilt += w.text ?? "";
      steps++;
      if (w.fields.body_truncated !== true) break;
      const next = Number(w.fields.body_next_offset);
      assert(next > offset, `window of ${maxChars} failed to advance from ${offset}`);
      offset = next;
    }
    assertEquals(rebuilt, body, `walk at maxChars ${maxChars} reconstructs the body`);
    assert(steps < 5_000, `walk at maxChars ${maxChars} terminated`);
  }
});

Deno.test("walking an html body to completion terminates the same way", () => {
  const body = "<p>" + "x".repeat(20_000) + "</p>";
  let offset = 0;
  let rebuilt = "";
  let steps = 0;
  while (steps < 100) {
    const w = windowBody(body, {
      offset,
      maxChars: SINGLE_READ_BODY_CHARS,
      prefix: "body_html",
      recovery: (n) => singleReadContinuation("m1", n, true),
    });
    rebuilt += w.text ?? "";
    steps++;
    if (w.fields.body_html_truncated !== true) break;
    const next = Number(w.fields.body_html_offset);
    assert(Number(w.fields.body_html_next_offset) > next, "every html window advances");
    offset = Number(w.fields.body_html_next_offset);
  }
  assertEquals(rebuilt, body, "the html body reassembles exactly");
  assertEquals(steps, 3, "20,006 characters at 8,000 is three windows");
});
