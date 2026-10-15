// ---------------------------------------------------------------------------
// provider-concurrency.test.ts — the two rules provider-concurrency.ts exists
// to keep: results in item order, and the failure a serial loop would report.
//
// Run: deno test --node-modules-dir=none --allow-read --allow-env \
//        supabase/functions/mcp-server/provider-concurrency.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { mapWithConcurrency } from "./provider-concurrency.ts";

/** A promise the test settles by hand, so finishing order is chosen, not timed. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every microtask that is ready run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** `count` tasks whose completion the test controls, with in-flight tracking. */
function controlled(count: number) {
  const gates = Array.from({ length: count }, () => deferred<string>());
  const started: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const task = async (_item: number, index: number): Promise<string> => {
    started.push(index);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      return await gates[index].promise;
    } finally {
      inFlight--;
    }
  };
  return {
    gates,
    started,
    task,
    get inFlight() {
      return inFlight;
    },
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

Deno.test("mapWithConcurrency returns results in item order when tasks finish in the opposite order", async () => {
  const c = controlled(6);
  const pending = mapWithConcurrency(range(6), 6, c.task);
  await settle();
  assertEquals(c.started, [0, 1, 2, 3, 4, 5]);
  for (const i of [5, 4, 3, 2, 1, 0]) {
    c.gates[i].resolve(`r${i}`);
    await settle();
  }
  assertEquals(await pending, ["r0", "r1", "r2", "r3", "r4", "r5"]);
});

Deno.test("mapWithConcurrency never runs more than the limit, and refills a slot as soon as one frees", async () => {
  const c = controlled(10);
  const pending = mapWithConcurrency(range(10), 3, c.task);
  await settle();
  assertEquals(c.started, [0, 1, 2], "three start at once, not one and not ten");
  assertEquals(c.inFlight, 3);

  // The MIDDLE one finishes first: its slot is refilled with the next index.
  c.gates[1].resolve("r1");
  await settle();
  assertEquals(c.started, [0, 1, 2, 3]);
  assertEquals(c.inFlight, 3);

  for (const i of [0, 2, 3, 4, 5, 6, 7, 8, 9]) {
    c.gates[i].resolve(`r${i}`);
    await settle();
    assert(c.inFlight <= 3);
  }
  assertEquals(await pending, range(10).map((i) => `r${i}`));
  assertEquals(c.maxInFlight, 3);
  assertEquals(c.started, range(10), "items are started in index order");
});

Deno.test("mapWithConcurrency with a limit of 1 is a serial loop", async () => {
  const c = controlled(4);
  const pending = mapWithConcurrency(range(4), 1, c.task);
  for (const i of range(4)) {
    await settle();
    assertEquals(c.started, range(i + 1));
    assertEquals(c.inFlight, 1);
    c.gates[i].resolve(`r${i}`);
  }
  assertEquals(await pending, ["r0", "r1", "r2", "r3"]);
  assertEquals(c.maxInFlight, 1);
});

Deno.test("mapWithConcurrency handles no items, fewer items than the limit, and a nonsense limit", async () => {
  assertEquals(await mapWithConcurrency([], 4, () => Promise.resolve(1)), []);
  assertEquals(await mapWithConcurrency(["a", "b"], 50, (s, i) => Promise.resolve(`${s}${i}`)), ["a0", "b1"]);
  for (const limit of [0, -3, Number.NaN, 0.4]) {
    const c = controlled(3);
    const pending = mapWithConcurrency(range(3), limit, c.task);
    await settle();
    assertEquals(c.started, [0], `limit ${limit} falls back to one at a time`);
    for (const i of range(3)) {
      c.gates[i].resolve(`r${i}`);
      await settle();
    }
    assertEquals(await pending, ["r0", "r1", "r2"]);
  }
});

Deno.test("mapWithConcurrency reports the LOWEST-index failure, not the first to arrive and not the last", async () => {
  const c = controlled(8);
  const pending = mapWithConcurrency(range(8), 4, c.task);
  pending.catch(() => {});
  await settle();
  assertEquals(c.started, [0, 1, 2, 3]);

  // Index 3 fails first in time, then 1, then 2. A serial loop would have
  // stopped at 1 and thrown its error.
  c.gates[3].reject(new Error("failure at 3"));
  await settle();
  c.gates[1].reject(new Error("failure at 1"));
  await settle();
  c.gates[2].reject(new Error("failure at 2"));
  await settle();
  c.gates[0].resolve("r0");
  await assertRejects(() => pending, Error, "failure at 1");
});

Deno.test("mapWithConcurrency starts nothing new after a failure, and waits for what is already running", async () => {
  const c = controlled(10);
  const pending = mapWithConcurrency(range(10), 3, c.task);
  let settled = false;
  pending.catch(() => {}).finally(() => {
    settled = true;
  });
  await settle();
  c.gates[2].reject(new Error("failure at 2"));
  await settle();
  assertEquals(c.started, [0, 1, 2], "index 3 and later are never started");
  assertEquals(settled, false, "it does not reject while 0 and 1 are still running");

  c.gates[0].resolve("r0");
  await settle();
  assertEquals(c.started, [0, 1, 2]);
  assertEquals(settled, false);
  c.gates[1].resolve("r1");
  await assertRejects(() => pending, Error, "failure at 2");
  assertEquals(c.started, [0, 1, 2]);
  assertEquals(c.inFlight, 0);
});

Deno.test("mapWithConcurrency treats a task that throws before returning a promise as that item's failure", async () => {
  const boom = (item: number): Promise<number> => {
    if (item === 1) throw new Error("threw synchronously at 1");
    return Promise.resolve(item);
  };
  await assertRejects(() => mapWithConcurrency(range(4), 2, boom), Error, "threw synchronously at 1");
});
