/**
 * one-click-post.test.ts. No test touches the network: every case injects a
 * `fetchImpl`, and every case that gets past the URL checks injects a `guard`.
 */

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  ONE_CLICK_BODY,
  ONE_CLICK_MAX_RESPONSE_BYTES,
  ONE_CLICK_USER_AGENT,
  OneClickHostError,
  postOneClick,
  redactUnsubscribeUrl,
} from "./one-click-post.ts";

const URL_OK = "https://lists.example.com/unsub/one-click?token=SECRET123";

interface Recorded {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(respond: () => Response | Promise<Response>, calls: Recorded[] = []): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(respond());
  }) as typeof fetch;
}

const allowAll = () => Promise.resolve();

Deno.test("a 2xx answer is a success, and the request is exactly the RFC 8058 POST", async () => {
  const calls: Recorded[] = [];
  const guarded: string[] = [];
  const result = await postOneClick(URL_OK, {
    fetchImpl: fakeFetch(() => new Response("ok", { status: 200 }), calls),
    guard: (host) => {
      guarded.push(host);
      return Promise.resolve();
    },
  });
  assertEquals(result.ok, true);
  assertEquals(result.status, 200);
  assertEquals(result.error, undefined);
  assert(result.durationMs >= 0);
  assertEquals(guarded, ["lists.example.com"]);

  assertEquals(calls.length, 1);
  const { url, init } = calls[0];
  assertEquals(url, URL_OK);
  assertEquals(init?.method, "POST");
  assertEquals(init?.redirect, "manual");
  assertEquals(init?.credentials, "omit");
  assertEquals(init?.body, ONE_CLICK_BODY);
  assertEquals(ONE_CLICK_BODY, "List-Unsubscribe=One-Click");
  assert(init?.signal instanceof AbortSignal);
  const headers = new Headers(init?.headers);
  assertEquals(headers.get("content-type"), "application/x-www-form-urlencoded");
  assertEquals(headers.get("user-agent"), ONE_CLICK_USER_AGENT);
  assertEquals(headers.get("cookie"), null);
  assertEquals(headers.get("authorization"), null);
  assertEquals([...headers.keys()].sort(), ["content-type", "user-agent"]);
});

Deno.test("202 and 204 count as success too", async () => {
  for (const status of [202, 204]) {
    const result = await postOneClick(URL_OK, {
      fetchImpl: fakeFetch(() => new Response(null, { status })),
      guard: allowAll,
    });
    assertEquals(result, { ok: true, status, durationMs: result.durationMs });
  }
});

Deno.test("a 3xx is a failure and the Location is never followed", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const calls: Recorded[] = [];
    const result = await postOneClick(URL_OK, {
      fetchImpl: fakeFetch(
        () => new Response("moved", { status, headers: { location: "https://127.0.0.1/" } }),
        calls,
      ),
      guard: allowAll,
    });
    assertEquals(result.ok, false);
    assertEquals(result.status, status);
    assertEquals(result.error, "redirect");
    assertEquals(calls.length, 1, "exactly one request, no redirect hop");
  }
});

Deno.test("an opaqueredirect response is a redirect failure", async () => {
  const opaque = { type: "opaqueredirect", status: 0, body: null } as unknown as Response;
  const result = await postOneClick(URL_OK, { fetchImpl: fakeFetch(() => opaque), guard: allowAll });
  assertEquals(result.ok, false);
  assertEquals(result.status, null);
  assertEquals(result.error, "redirect");
});

Deno.test("4xx and 5xx are http_error with the status kept", async () => {
  for (const status of [400, 404, 410, 429, 500, 503]) {
    const result = await postOneClick(URL_OK, {
      fetchImpl: fakeFetch(() => new Response("nope", { status })),
      guard: allowAll,
    });
    assertEquals(result.ok, false);
    assertEquals(result.status, status);
    assertEquals(result.error, "http_error");
  }
});

Deno.test("a request that outlives the timeout is reported as timeout", async () => {
  const hanging = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as typeof fetch;
  const result = await postOneClick(URL_OK, { fetchImpl: hanging, guard: allowAll, timeoutMs: 20 });
  assertEquals(result.ok, false);
  assertEquals(result.status, null);
  assertEquals(result.error, "timeout");
});

Deno.test("a thrown fetch error is network", async () => {
  const broken = (() => Promise.reject(new TypeError("connection reset"))) as typeof fetch;
  const result = await postOneClick(URL_OK, { fetchImpl: broken, guard: allowAll });
  assertEquals(result, { ok: false, status: null, error: "network", durationMs: result.durationMs });
});

Deno.test("URLs that are not https on 443 without credentials are invalid_url, with no request", async () => {
  const cases = [
    "http://lists.example.com/unsub",
    "https://lists.example.com:8443/unsub",
    "https://lists.example.com:80/unsub",
    "https://user@lists.example.com/unsub",
    "https://user:pw@lists.example.com/unsub",
    "https://:pw@lists.example.com/unsub",
    "mailto:unsub@example.com",
    "ftp://lists.example.com/unsub",
    "not a url",
    "",
    `https://lists.example.com/${"a".repeat(3000)}`,
  ];
  for (const url of cases) {
    const calls: Recorded[] = [];
    let guarded = false;
    const result = await postOneClick(url, {
      fetchImpl: fakeFetch(() => new Response("ok"), calls),
      guard: () => {
        guarded = true;
        return Promise.resolve();
      },
    });
    assertEquals(result.error, "invalid_url", url);
    assertEquals(result.ok, false);
    assertEquals(calls.length, 0, url);
    assertEquals(guarded, false, url);
  }
});

Deno.test("an explicit :443 is accepted", async () => {
  const result = await postOneClick("https://lists.example.com:443/unsub", {
    fetchImpl: fakeFetch(() => new Response("ok")),
    guard: allowAll,
  });
  assertEquals(result.ok, true);
});

Deno.test("internal IP literals are blocked even when the injected guard allows everything", async () => {
  const cases = [
    "https://127.0.0.1/unsub",
    "https://10.0.0.5/unsub",
    "https://169.254.169.254/latest/meta-data",
    "https://100.64.1.1/unsub",
    "https://192.168.1.1/unsub",
    "https://0.0.0.0/unsub",
    "https://224.0.0.1/unsub",
    "https://[::1]/unsub",
    "https://[fc00::1]/unsub",
    "https://[fd12:3456::1]/unsub",
    "https://[fe80::1]/unsub",
    "https://[ff02::1]/unsub",
    "https://[::ffff:127.0.0.1]/unsub",
    "https://2130706433/unsub",
    "https://0x7f.0.0.1/unsub",
    "https://0177.0.0.1/unsub",
    "https://127.1/unsub",
  ];
  for (const url of cases) {
    const calls: Recorded[] = [];
    const result = await postOneClick(url, { fetchImpl: fakeFetch(() => new Response("ok"), calls), guard: allowAll });
    assertEquals(result.error, "blocked_host", url);
    assertEquals(result.ok, false);
    assertEquals(calls.length, 0, url);
  }
});

Deno.test("a public IP literal passes the literal check and still goes through the guard", async () => {
  const guarded: string[] = [];
  const result = await postOneClick("https://8.8.8.8/unsub", {
    fetchImpl: fakeFetch(() => new Response("ok")),
    guard: (host) => {
      guarded.push(host);
      return Promise.resolve();
    },
  });
  assertEquals(result.ok, true);
  assertEquals(guarded, ["8.8.8.8"]);
});

Deno.test("a guard rejection is blocked_host and no request is sent", async () => {
  const calls: Recorded[] = [];
  const result = await postOneClick(URL_OK, {
    fetchImpl: fakeFetch(() => new Response("ok"), calls),
    guard: () => Promise.reject(new OneClickHostError("host_not_allowed")),
  });
  assertEquals(result, { ok: false, status: null, error: "blocked_host", durationMs: result.durationMs });
  assertEquals(calls.length, 0);

  const generic = await postOneClick(URL_OK, {
    fetchImpl: fakeFetch(() => new Response("ok"), calls),
    guard: () => Promise.reject(new Error("anything")),
  });
  assertEquals(generic.error, "blocked_host");
  assertEquals(calls.length, 0);
});

Deno.test("a name that does not resolve is network, not blocked_host", async () => {
  const result = await postOneClick(URL_OK, {
    fetchImpl: fakeFetch(() => new Response("ok")),
    guard: () => Promise.reject(new OneClickHostError("host_not_found")),
  });
  assertEquals(result.error, "network");
});

Deno.test("an endless response body is read only up to the cap, then cancelled", async () => {
  const chunk = new Uint8Array(1024);
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += chunk.length;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  const result = await postOneClick(URL_OK, {
    fetchImpl: fakeFetch(() => new Response(body, { status: 200 })),
    guard: allowAll,
  });
  assertEquals(result.ok, true);
  assert(cancelled, "the stream must be cancelled");
  assert(
    pulled <= ONE_CLICK_MAX_RESPONSE_BYTES + 2 * chunk.length,
    `read ${pulled} bytes; the cap is ${ONE_CLICK_MAX_RESPONSE_BYTES}`,
  );
});

Deno.test("an error body is capped too", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(4096));
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  const result = await postOneClick(URL_OK, {
    fetchImpl: fakeFetch(() => new Response(body, { status: 500 })),
    guard: allowAll,
  });
  assertEquals(result.error, "http_error");
  assert(cancelled);
});

Deno.test("redactUnsubscribeUrl keeps scheme and host only", () => {
  assertEquals(redactUnsubscribeUrl(URL_OK), "https://lists.example.com");
  assertEquals(redactUnsubscribeUrl("https://u:p@Lists.Example.com:8443/a/b?t=1#x"), "https://lists.example.com");
  assertEquals(redactUnsubscribeUrl("not a url"), "[invalid url]");
  assert(!redactUnsubscribeUrl(URL_OK).includes("SECRET123"));
});
