// Tests for flag-read-retry.ts: a card flag that fails to read is asked once
// more before the caller falls back to "no card".

import { readFlagWithOneRetry } from "./flag-read-retry.ts";

function assertEquals<T>(actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`expected ${e}, got ${a}`);
}

Deno.test("a read that works is not repeated", async () => {
  let calls = 0;
  const result = await readFlagWithOneRetry(() => {
    calls++;
    return Promise.resolve({ data: { draft_editor_hidden: false }, error: null });
  }, 0);
  assertEquals(calls, 1);
  assertEquals(result, { data: { draft_editor_hidden: false }, error: null, retried: false });
});

Deno.test("a gateway blip is asked once more, and the second answer is used", async () => {
  let calls = 0;
  const result = await readFlagWithOneRetry(() => {
    calls++;
    return Promise.resolve(
      calls === 1
        ? { data: null, error: { message: "<html><head><title>502 Bad Gateway</title></head></html>" } }
        : { data: { draft_editor_hidden: false }, error: null },
    );
  }, 0);
  assertEquals(calls, 2);
  assertEquals(result.error, null);
  assertEquals(result.data, { draft_editor_hidden: false });
  assertEquals(result.retried, true);
});

Deno.test("a read that throws is retried the same way", async () => {
  let calls = 0;
  const result = await readFlagWithOneRetry<{ ok: boolean }>(() => {
    calls++;
    if (calls === 1) throw new Error("connection reset");
    return Promise.resolve({ data: { ok: true }, error: null });
  }, 0);
  assertEquals(calls, 2);
  assertEquals(result.data, { ok: true });
});

Deno.test("two failures stop there and report the second", async () => {
  let calls = 0;
  const result = await readFlagWithOneRetry(() => {
    calls++;
    return Promise.resolve({ data: null, error: { message: `column does not exist (${calls})` } });
  }, 0);
  assertEquals(calls, 2);
  assertEquals(result, { data: null, error: { message: "column does not exist (2)" }, retried: true });
});
