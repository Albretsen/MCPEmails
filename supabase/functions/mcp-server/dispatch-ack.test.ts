// Run: deno test --node-modules-dir=none --allow-read --allow-env supabase/functions/mcp-server/dispatch-ack.test.ts

import { assertEquals } from "jsr:@std/assert@1";
import { acknowledgeThenRun } from "./dispatch-ack.ts";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

Deno.test("with a runtime hook: 202 before the work finishes, and the work is handed to the hook", async () => {
  const gate = deferred<Response>();
  let started = false;
  const held: Promise<unknown>[] = [];
  const res = await acknowledgeThenRun(
    "triage_dispatch",
    () => {
      started = true;
      return gate.promise;
    },
    () => {},
    { waitUntil: (p) => held.push(p) },
  );
  assertEquals(started, true);
  assertEquals(res.status, 202);
  assertEquals(await res.json(), { accepted: true });
  assertEquals(held.length, 1);
  gate.resolve(new Response("{}", { status: 200 }));
  await held[0];
});

Deno.test("with a runtime hook: a rejected work is reported, not thrown", async () => {
  const failures: string[] = [];
  const held: Promise<unknown>[] = [];
  const res = await acknowledgeThenRun(
    "triage_dispatch",
    () => Promise.reject(new Error("boom")),
    (name) => failures.push(name),
    { waitUntil: (p) => held.push(p) },
  );
  assertEquals(res.status, 202);
  await held[0];
  assertEquals(failures, ["triage_dispatch"]);
});

Deno.test("without a runtime hook: returns the work's own response", async () => {
  const res = await acknowledgeThenRun(
    "triage_dispatch",
    () => Promise.resolve(new Response('{"ran":3}', { status: 200 })),
    () => {},
    null,
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ran: 3 });
});

Deno.test("a hook that refuses the work: falls back to awaiting it", async () => {
  const failures: string[] = [];
  const res = await acknowledgeThenRun(
    "triage_dispatch",
    () => Promise.resolve(new Response('{"ran":1}', { status: 200 })),
    (name) => failures.push(name),
    {
      waitUntil: () => {
        throw new Error("refused");
      },
    },
  );
  assertEquals(res.status, 200);
  assertEquals(failures, ["wait_until"]);
});
