// ---------------------------------------------------------------------------
// The allowance-notice kick: a fire-and-forget POST to the web dispatcher
// that can be skipped, can fail and can time out, and never throws or blocks
// the tool call that queued the notice.
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";

import { dispatchUrl, kickBillingDispatch } from "./billing-dispatch-kick.ts";

function silenced<T>(run: () => T): T {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return run();
  } finally {
    console.warn = warn;
  }
}

Deno.test("kick: POSTs the emails-only dispatcher with the dispatch secret", async () => {
  const calls: Array<{ url: string; secret: string | null; method: string }> = [];
  const pending: Promise<unknown>[] = [];
  const started = kickBillingDispatch({
    secret: "s3cret",
    appUrl: "https://mcpemails.com/",
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        secret: new Headers(init.headers).get("x-dispatch-secret"),
        method: init.method ?? "GET",
      });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
    runtime: { waitUntil: (p) => pending.push(p) },
  });
  assert(started);
  assertEquals(pending.length, 1);
  await Promise.all(pending);
  assertEquals(calls, [{
    url: "https://mcpemails.com/api/internal/billing-lifecycle/dispatch?mode=emails",
    secret: "s3cret",
    method: "POST",
  }]);
});

Deno.test("kick: skipped without a secret or a URL, and never fetches", () => {
  let fetched = 0;
  const fetchImpl = (() => {
    fetched += 1;
    return Promise.resolve(new Response());
  }) as unknown as typeof fetch;
  silenced(() => {
    assertEquals(kickBillingDispatch({ secret: undefined, appUrl: "https://mcpemails.com", fetchImpl, runtime: null }), false);
    assertEquals(kickBillingDispatch({ secret: "", appUrl: "https://mcpemails.com", fetchImpl, runtime: null }), false);
    assertEquals(kickBillingDispatch({ secret: "s", appUrl: undefined, fetchImpl, runtime: null }), false);
    assertEquals(kickBillingDispatch({ secret: "s", appUrl: "not a url", fetchImpl, runtime: null }), false);
  });
  assertEquals(fetched, 0);
});

Deno.test("kick: a rejected fetch, a 500 and a throwing waitUntil never throw", async () => {
  const pending: Promise<unknown>[] = [];
  const warn = console.warn;
  console.warn = () => {};
  try {
    kickBillingDispatch({
      secret: "s",
      appUrl: "https://mcpemails.com",
      fetchImpl: (() => Promise.reject(new Error("network down"))) as unknown as typeof fetch,
      runtime: { waitUntil: (p) => pending.push(p) },
    });
    kickBillingDispatch({
      secret: "s",
      appUrl: "https://mcpemails.com",
      fetchImpl: (() => Promise.resolve(new Response("no", { status: 500 }))) as unknown as typeof fetch,
      runtime: { waitUntil: (p) => pending.push(p) },
    });
    kickBillingDispatch({
      secret: "s",
      appUrl: "https://mcpemails.com",
      fetchImpl: (() => {
        throw new Error("sync throw");
      }) as unknown as typeof fetch,
      runtime: {
        waitUntil: (p) => {
          pending.push(p);
          throw new Error("refused");
        },
      },
    });
    // Every task settles (resolves), none rejects.
    const settled = await Promise.allSettled(pending);
    assertEquals(settled.map((s) => s.status), ["fulfilled", "fulfilled", "fulfilled"]);
  } finally {
    console.warn = warn;
  }
});

Deno.test("kick: a hung dispatcher is aborted by the timeout", async () => {
  const pending: Promise<unknown>[] = [];
  let aborted = false;
  silenced(() =>
    kickBillingDispatch({
      secret: "s",
      appUrl: "https://mcpemails.com",
      timeoutMs: 10,
      fetchImpl: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        })) as unknown as typeof fetch,
      runtime: { waitUntil: (p) => pending.push(p) },
    })
  );
  const warn = console.warn;
  console.warn = () => {};
  try {
    await Promise.all(pending);
  } finally {
    console.warn = warn;
  }
  assert(aborted);
});

Deno.test("dispatchUrl: trims trailing slashes and refuses a non-http origin", () => {
  assertEquals(
    dispatchUrl("https://mcpemails.com///"),
    "https://mcpemails.com/api/internal/billing-lifecycle/dispatch?mode=emails",
  );
  assertEquals(dispatchUrl(""), null);
  assertEquals(dispatchUrl("ftp://x"), null);
});
