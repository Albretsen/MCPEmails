// ---------------------------------------------------------------------------
// provider-read-ahead.test.ts — createReadAhead, the piece that lets
// email_read_batch issue a few reads early while its loop still consumes them
// strictly in order.
//
// Run: deno test --node-modules-dir=none --allow-read --allow-env \
//        supabase/functions/mcp-server/provider-read-ahead.test.ts
// ---------------------------------------------------------------------------

import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createReadAhead } from "./provider-concurrency.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function controlled(count: number) {
  const gates = Array.from({ length: count }, () => deferred<string>());
  const started: number[] = [];
  const start = (index: number): Promise<string> => {
    started.push(index);
    return gates[index].promise;
  };
  return { gates, started, start };
}

Deno.test("read-ahead: taking index i starts i and the next width-1 reads, and no more", async () => {
  const c = controlled(10);
  const ahead = createReadAhead(10, c.start);
  const first = ahead.take(0, 4);
  assertEquals(c.started, [0, 1, 2, 3]);
  c.gates[0].resolve("r0");
  assertEquals(await first, "r0");
  assertEquals(c.started, [0, 1, 2, 3], "consuming a result does not by itself start anything");

  // The window slides by one per take: outstanding never exceeds the width.
  const second = ahead.take(1, 4);
  assertEquals(c.started, [0, 1, 2, 3, 4]);
  c.gates[1].resolve("r1");
  assertEquals(await second, "r1");
  for (let i = 2; i < 10; i++) c.gates[i].resolve(`r${i}`);
  for (let i = 2; i < 10; i++) assertEquals(await ahead.take(i, 4), `r${i}`);
  assertEquals(c.started, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "each read is started exactly once, in order");
});

Deno.test("read-ahead: a width of 1 reads nothing ahead", async () => {
  const c = controlled(4);
  const ahead = createReadAhead(4, c.start);
  for (let i = 0; i < 4; i++) {
    const read = ahead.take(i, 1);
    assertEquals(c.started.length, i + 1);
    c.gates[i].resolve(`r${i}`);
    assertEquals(await read, `r${i}`);
  }
});

Deno.test("read-ahead: the width can grow between takes, and a nonsense width is 1", async () => {
  const c = controlled(8);
  const ahead = createReadAhead(8, c.start);
  ahead.take(0, 1).catch(() => {});
  assertEquals(c.started, [0]);
  ahead.take(1, 4).catch(() => {});
  assertEquals(c.started, [0, 1, 2, 3, 4]);
  for (const width of [0, -2, Number.NaN]) {
    const before = c.started.length;
    ahead.take(before - 3, width).catch(() => {});
    assertEquals(c.started.length, before, `width ${width} starts nothing beyond what is running`);
  }
  for (const g of c.gates) g.resolve("x");
  await ahead.drain();
});

Deno.test("read-ahead: results are delivered by index even when later reads finish first", async () => {
  const c = controlled(4);
  const ahead = createReadAhead(4, c.start);
  const zero = ahead.take(0, 4);
  c.gates[3].resolve("r3");
  c.gates[2].resolve("r2");
  c.gates[1].resolve("r1");
  await settle();
  let zeroDone = false;
  zero.then(() => {
    zeroDone = true;
  });
  await settle();
  assertEquals(zeroDone, false, "index 0 is still waiting on its own read");
  c.gates[0].resolve("r0");
  assertEquals(await zero, "r0");
  assertEquals([await ahead.take(1, 4), await ahead.take(2, 4), await ahead.take(3, 4)], ["r1", "r2", "r3"]);
});

Deno.test("read-ahead: a failed read rejects in its own turn, not when it happened", async () => {
  const c = controlled(5);
  const ahead = createReadAhead(5, c.start);
  const zero = ahead.take(0, 4);
  // Index 2 fails long before the loop gets to it.
  c.gates[2].reject(new Error("read 2 failed"));
  await settle();
  c.gates[0].resolve("r0");
  c.gates[1].resolve("r1");
  c.gates[3].resolve("r3");
  c.gates[4].resolve("r4");
  assertEquals(await zero, "r0");
  assertEquals(await ahead.take(1, 4), "r1");
  await assertRejects(() => ahead.take(2, 4), Error, "read 2 failed");
  assertEquals(await ahead.take(3, 4), "r3");
  assertEquals(await ahead.take(4, 4), "r4");
});

Deno.test("read-ahead: reads that are abandoned never surface, and drain waits for them", async () => {
  const c = controlled(6);
  const ahead = createReadAhead(6, c.start);
  const zero = ahead.take(0, 4);
  c.gates[0].resolve("r0");
  await zero;

  // The loop stops here. 1, 2 and 3 are in flight and will never be taken.
  let drained = false;
  const draining = ahead.drain().then(() => {
    drained = true;
  });
  await settle();
  assertEquals(drained, false, "drain waits while abandoned reads are still running");
  c.gates[1].reject(new Error("abandoned and failed"));
  c.gates[2].resolve("r2");
  await settle();
  assertEquals(drained, false);
  c.gates[3].reject(new Error("abandoned and failed too"));
  await draining;
  assertEquals(drained, true);
  assertEquals(c.started, [0, 1, 2, 3], "nothing beyond the window was ever started");
  // Draining again, with nothing left, returns at once. The test passing at
  // all is the other assertion: an unhandled rejection would have failed it.
  await ahead.drain();
});

Deno.test("read-ahead: a start that throws synchronously is that read's failure", async () => {
  const ahead = createReadAhead(3, (index) => {
    if (index === 1) throw new Error("start threw at 1");
    return Promise.resolve(`r${index}`);
  });
  assertEquals(await ahead.take(0, 3), "r0");
  await assertRejects(() => ahead.take(1, 3), Error, "start threw at 1");
  assertEquals(await ahead.take(2, 3), "r2");
});

Deno.test("read-ahead: taking an index twice, or past the end, is refused rather than re-read", async () => {
  const c = controlled(2);
  const ahead = createReadAhead(2, c.start);
  c.gates[0].resolve("r0");
  c.gates[1].resolve("r1");
  assertEquals(await ahead.take(0, 2), "r0");
  await assertRejects(() => ahead.take(0, 2), Error, "already taken");
  assertEquals(await ahead.take(1, 2), "r1");
  await assertRejects(() => ahead.take(2, 2), Error, "out of range");
  assertEquals(c.started, [0, 1]);
});
