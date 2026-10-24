// ---------------------------------------------------------------------------
// cross-inbox.ts: the pure half of `inbox_id: "all"` (Pro), plus the closed
// gate through the real tools/call and tools/list (introspection mode, where
// the gate always reads closed). The fan-out over real executors is pinned in
// cross-inbox-dispatch.test.ts.
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  advertiseCrossInboxSearch,
  CROSS_INBOX_IMAP_HOST_LIMIT,
  CROSS_INBOX_PROVIDER_LIMITS,
  CROSS_INBOX_WINDOW,
  crossInboxBuckets,
  crossInboxFetchLimit,
  crossInboxLegArgs,
  crossInboxValidationArgs,
  type CrossInboxLeg,
  isCrossInboxAll,
  isCrossInboxCall,
  legFromToolResult,
  mergeCrossInboxPages,
  runFanOut,
} from "./cross-inbox.ts";

Deno.env.set("MCP_INTROSPECTION_ONLY", "1");
Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
const server = await import("./index.ts");

// ── Recognising the value ───────────────────────────────────────────────────

Deno.test("only the word all, trimmed and in any case, selects every inbox", () => {
  for (const v of ["all", "ALL", " All "]) assert(isCrossInboxAll(v), v);
  for (const v of ["", "every", "all inboxes", null, undefined, ["all"], 1]) assert(!isCrossInboxAll(v), String(v));
  assert(isCrossInboxCall("email_list", { inbox_id: "all" }));
  assert(isCrossInboxCall("email_search", { inbox_id: "all", from: "x" }));
  assert(!isCrossInboxCall("email_read", { inbox_id: "all" }));
  assert(!isCrossInboxCall("email_list", { inbox: "all" }));
  assert(!isCrossInboxCall("email_list", null));
});

Deno.test("validation args drop only inbox_id; leg args name one inbox from offset 0", () => {
  const args = { inbox_id: "all", from: "a", limit: 5, offset: 10, action: "search" };
  assertEquals(crossInboxValidationArgs(args), { from: "a", limit: 5, offset: 10, action: "search" });
  assertEquals(crossInboxLegArgs({ ...args, inbox: "" }, "id-1", 15), {
    from: "a",
    action: "search",
    inbox_id: "id-1",
    offset: 0,
    limit: 15,
  });
  assertEquals(crossInboxFetchLimit(0, 20), 20);
  assertEquals(crossInboxFetchLimit(90, 20), CROSS_INBOX_WINDOW);
});

// ── Scheduling ──────────────────────────────────────────────────────────────

Deno.test("buckets: provider for everyone, host as well for IMAP", () => {
  assertEquals(crossInboxBuckets({ provider: "gmail", imap_host: null }), [
    { key: "provider:gmail", limit: CROSS_INBOX_PROVIDER_LIMITS.gmail },
  ]);
  assertEquals(crossInboxBuckets({ provider: "imap", imap_host: "IMAP.Mail.Yahoo.com" }), [
    { key: "provider:imap", limit: CROSS_INBOX_PROVIDER_LIMITS.imap },
    { key: "imap_host:imap.mail.yahoo.com", limit: CROSS_INBOX_IMAP_HOST_LIMIT },
  ]);
});

/** A task that stays open until released, recording the peak per bucket. */
function gatedTasks<T extends { bucket: string }>() {
  const open: Array<() => void> = [];
  let running = 0;
  let peak = 0;
  const perBucket = new Map<string, number>();
  const peakPerBucket = new Map<string, number>();
  const task = (item: T) =>
    new Promise<string>((resolve) => {
      running++;
      peak = Math.max(peak, running);
      const n = (perBucket.get(item.bucket) ?? 0) + 1;
      perBucket.set(item.bucket, n);
      peakPerBucket.set(item.bucket, Math.max(peakPerBucket.get(item.bucket) ?? 0, n));
      open.push(() => {
        running--;
        perBucket.set(item.bucket, (perBucket.get(item.bucket) ?? 1) - 1);
        resolve(`done:${item.bucket}`);
      });
    });
  return { open, task, peak: () => peak, peakPerBucket };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

Deno.test("fan-out holds the global cap and every bucket's cap, and keeps item order", async () => {
  const items = [
    ...Array.from({ length: 6 }, () => ({ bucket: "yahoo" })),
    ...Array.from({ length: 6 }, () => ({ bucket: "gmail" })),
  ];
  const g = gatedTasks<{ bucket: string }>();
  const run = runFanOut(items, {
    concurrency: 4,
    timeoutMs: 60_000,
    buckets: (item) => [{ key: item.bucket, limit: item.bucket === "yahoo" ? 2 : 3 }],
  }, g.task);
  // Release one at a time until all have finished.
  for (let i = 0; i < items.length; i++) {
    await tick();
    g.open.shift()?.();
  }
  const outcomes = await run;
  assertEquals(outcomes.length, items.length);
  outcomes.forEach((o, i) => assertEquals(o, { ok: true, value: `done:${items[i].bucket}` }));
  assert(g.peak() <= 4, `peak ${g.peak()}`);
  assertEquals(g.peakPerBucket.get("yahoo"), 2);
  assert(g.peakPerBucket.get("gmail")! <= 3);
});

Deno.test("fan-out fills a bucket to its cap and no further when the global cap is wider", async () => {
  const items = Array.from({ length: 7 }, () => ({ bucket: "imap.mail.yahoo.com" }));
  const g = gatedTasks<{ bucket: string }>();
  const run = runFanOut(items, { concurrency: 10, timeoutMs: 60_000, buckets: (item) => [{ key: item.bucket, limit: 2 }] }, g.task);
  for (let i = 0; i < items.length; i++) {
    await tick();
    g.open.shift()?.();
  }
  await run;
  assertEquals(g.peak(), 2);
});

Deno.test("fan-out: a failure and a timeout are their items' outcomes; the rest still answer", async () => {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const run = runFanOut(
    ["ok", "boom", "slow", "ok2"],
    {
      concurrency: 2,
      timeoutMs: 1000,
      buckets: () => [],
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length - 1;
      },
      clearTimer: () => {},
    },
    (item) => {
      if (item === "boom") throw new Error("synchronous failure");
      if (item === "slow") return new Promise<string>(() => {});
      return Promise.resolve(item);
    },
  );
  await tick();
  await tick();
  // Fire every timer: only "slow" is still running, so only it times out.
  for (const t of timers) t.fn();
  const outcomes = await run;
  assertEquals(outcomes[0], { ok: true, value: "ok" });
  assertEquals(outcomes[1].ok, false);
  assertEquals((outcomes[1] as { timedOut: boolean }).timedOut, false);
  assertEquals(outcomes[2].ok, false);
  assertEquals((outcomes[2] as { timedOut: boolean }).timedOut, true);
  assertEquals(outcomes[3], { ok: true, value: "ok2" });
});

/** Timers a test fires by hand, by their duration. */
function manualTimers() {
  const live = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  return {
    setTimer: (fn: () => void, ms: number) => {
      live.set(next, { fn, ms });
      return next++;
    },
    clearTimer: (h: unknown) => void live.delete(h as number),
    fire(ms: number) {
      for (const [h, t] of [...live]) {
        if (t.ms !== ms) continue;
        live.delete(h);
        t.fn();
      }
    },
  };
}

Deno.test("fan-out: a timed-out leg is reported at once but keeps its slot until it settles", async () => {
  const timers = manualTimers();
  const started: string[] = [];
  let releaseSlow: (v: string) => void = () => {};
  let resolved = false;
  const run = runFanOut(
    ["slow", "next", "last"],
    { concurrency: 5, timeoutMs: 1000, buckets: () => [{ key: "imap_host:slow.example", limit: 1 }], ...timers },
    (item) => {
      started.push(item);
      if (item === "slow") return new Promise<string>((r) => (releaseSlow = r));
      return Promise.resolve(item);
    },
  ).then((o) => {
    resolved = true;
    return o;
  });
  await tick();
  timers.fire(1000);
  await tick();
  // Timed out, but the host's one connection is still open: nothing else starts.
  assertEquals(started, ["slow"]);
  assertEquals(resolved, false);
  releaseSlow("late");
  await tick();
  await tick();
  assertEquals(started, ["slow", "next", "last"]);
  const outcomes = await run;
  // The late answer does not replace the timeout already reported.
  assertEquals(outcomes[0].ok, false);
  assertEquals((outcomes[0] as { timedOut: boolean }).timedOut, true);
  assertEquals(outcomes[1], { ok: true, value: "next" });
  assertEquals(outcomes[2], { ok: true, value: "last" });
});

Deno.test("fan-out: at the call deadline, unstarted legs are skipped and the outcomes return", async () => {
  const timers = manualTimers();
  const started: number[] = [];
  const run = runFanOut(
    [0, 1, 2, 3],
    { concurrency: 5, timeoutMs: 1000, deadlineMs: 5000, buckets: () => [{ key: "imap_host:one.example", limit: 1 }], ...timers },
    (item) => {
      started.push(item);
      return new Promise<number>(() => {});
    },
  );
  await tick();
  timers.fire(1000);
  await tick();
  timers.fire(5000);
  const outcomes = await run;
  assertEquals(started, [0]);
  assertEquals((outcomes[0] as { timedOut: boolean }).timedOut, true);
  for (const i of [1, 2, 3]) {
    assertEquals(outcomes[i].ok, false);
    assertEquals((outcomes[i] as { skipped?: boolean }).skipped, true, String(i));
  }
});

Deno.test("fan-out: the deadline also closes a leg still running past it", async () => {
  const timers = manualTimers();
  const run = runFanOut(
    ["a", "b"],
    { concurrency: 5, timeoutMs: 9000, deadlineMs: 5000, buckets: () => [], ...timers },
    (item) => item === "a" ? Promise.resolve("a") : new Promise<string>(() => {}),
  );
  await tick();
  timers.fire(5000);
  const outcomes = await run;
  assertEquals(outcomes[0], { ok: true, value: "a" });
  assertEquals((outcomes[1] as { timedOut: boolean; skipped?: boolean }).timedOut, true);
  assertEquals((outcomes[1] as { skipped?: boolean }).skipped, undefined);
});

Deno.test("fan-out over nothing answers at once", async () => {
  assertEquals(await runFanOut([], { concurrency: 3, timeoutMs: 10, buckets: () => [] }, () => Promise.resolve(1)), []);
});

// ── Merge ───────────────────────────────────────────────────────────────────

const A = { inbox_id: "aaaaaaaa-0000-4000-8000-000000000001", inbox_address: "a@example.com" };
const B = { inbox_id: "bbbbbbbb-0000-4000-8000-000000000002", inbox_address: "b@example.com" };
const C = { inbox_id: "cccccccc-0000-4000-8000-000000000003", inbox_address: "c@example.com" };

const msg = (id: string, day: number) => ({ id, subject: id, date: `2026-10-${String(day).padStart(2, "0")}T10:00:00.000Z` });

function ok(target: typeof A, messages: Record<string, unknown>[], extra: Partial<CrossInboxLeg & { ok: true }> = {}): CrossInboxLeg {
  return { ok: true, target, messages, total: messages.length, totalIsEstimate: false, hasMore: false, ...extra } as CrossInboxLeg;
}

Deno.test("merge: newest first across inboxes, each tagged with its inbox", () => {
  const page = mergeCrossInboxPages({
    legs: [ok(A, [msg("a1", 20), msg("a2", 5)]), ok(B, [msg("b1", 22), msg("b2", 10)])],
    offset: 0,
    limit: 10,
  });
  assertEquals(page.messages.map((m) => m.id), ["b1", "a1", "b2", "a2"]);
  assertEquals(page.messages[0].inbox_id, B.inbox_id);
  assertEquals(page.messages[0].inbox_address, B.inbox_address);
  assertEquals(page.messages[1].inbox_address, A.inbox_address);
  assertEquals(page.total, 4);
  assertEquals(page.total_is_estimate, false);
  assertEquals(page.has_more, false);
  assertEquals(page.next_offset, null);
  assertEquals(page.inbox_errors, []);
  assertEquals(page.inboxes.map((i) => i.status), ["ok", "ok"]);
  assertEquals(page.notes, undefined);
});

Deno.test("merge: equal dates break on inbox_id then id, so pages never swap", () => {
  const page = mergeCrossInboxPages({
    legs: [ok(B, [msg("z", 1), msg("y", 1)]), ok(A, [msg("x", 1)])],
    offset: 0,
    limit: 10,
  });
  assertEquals(page.messages.map((m) => m.id), ["x", "y", "z"]);
});

Deno.test("merge: offset and limit page the merged list; next_offset continues it", () => {
  const legs = [
    ok(A, [msg("a1", 30), msg("a2", 28), msg("a3", 26)], { hasMore: true, total: 9 }),
    ok(B, [msg("b1", 29), msg("b2", 27), msg("b3", 25)], { total: 3 }),
  ];
  const first = mergeCrossInboxPages({ legs, offset: 0, limit: 2 });
  assertEquals(first.messages.map((m) => m.id), ["a1", "b1"]);
  assertEquals(first.has_more, true);
  assertEquals(first.next_offset, 2);
  assertEquals(first.total, 12);
  const second = mergeCrossInboxPages({ legs, offset: 2, limit: 2 });
  assertEquals(second.messages.map((m) => m.id), ["a2", "b2"]);
});

Deno.test("merge: a failed inbox is listed in inbox_errors, the rest are returned, total becomes a floor", () => {
  const page = mergeCrossInboxPages({
    legs: [
      ok(A, [msg("a1", 3)]),
      { ok: false, target: B, errorCode: "provider_error", message: "Provider error:\n  Backend Error" },
      ok(C, [msg("c1", 4)]),
    ],
    offset: 0,
    limit: 20,
  });
  assertEquals(page.messages.map((m) => m.id), ["c1", "a1"]);
  assertEquals(page.inbox_errors, [{
    inbox_id: B.inbox_id,
    inbox_address: B.inbox_address,
    error_code: "provider_error",
    message: "Provider error: Backend Error",
  }]);
  assertEquals(page.inboxes.map((i) => i.status), ["ok", "error", "ok"]);
  assertEquals(page.total, 2);
  assertEquals(page.total_is_estimate, true);
  assertStringIncludes(page.notes!.join(" "), "1 of 3 inboxes did not answer");
});

Deno.test("merge: an unknown provider count makes the total unknown", () => {
  const page = mergeCrossInboxPages({
    legs: [ok(A, [msg("a1", 3)], { total: null }), ok(B, [msg("b1", 2)])],
    offset: 0,
    limit: 5,
  });
  assertEquals(page.total, null);
});

Deno.test("merge: the per-inbox window is a hard edge, said out loud", () => {
  const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => msg(`${prefix}${i}`, 28 - (i % 28)));
  const page = mergeCrossInboxPages({
    legs: [ok(A, many("a", CROSS_INBOX_WINDOW), { hasMore: true }), ok(B, many("b", CROSS_INBOX_WINDOW), { hasMore: true })],
    offset: 90,
    limit: 20,
  });
  // Positions 90..99 only: past 100 an inbox's 101st result might belong earlier.
  assertEquals(page.messages.length, 10);
  assertEquals(page.has_more, false);
  assertEquals(page.next_offset, null);
  assertEquals(page.window_reached, true);
  assertEquals(page.total_is_estimate, true);
  assertStringIncludes(page.notes!.join(" "), `newest ${CROSS_INBOX_WINDOW} results of each inbox`);
});

Deno.test("merge: inboxes over the cap are reported as not searched", () => {
  const page = mergeCrossInboxPages({ legs: [ok(A, [msg("a", 1)])], offset: 0, limit: 5, skippedInboxes: 3 });
  assertEquals(page.total_is_estimate, true);
  assertStringIncludes(page.notes!.join(" "), "3 more were not searched");
});

Deno.test("merge: provider notes keep their inbox, and the search's normalized query rides along", () => {
  const page = mergeCrossInboxPages({
    legs: [ok(A, [], { notes: ["has_attachment was not applied"], queryNormalized: "from:x" })],
    offset: 0,
    limit: 5,
  });
  assertEquals(page.notes, ["a@example.com: has_attachment was not applied"]);
  assertEquals(page.query_normalized, "from:x");
});

Deno.test("legFromToolResult reads structuredContent, falls back to the text, and keeps errors", () => {
  const body = { messages: [msg("m", 1)], total: 1, total_is_estimate: false, has_more: true, next_offset: 1 };
  const fromStructured = legFromToolResult(A, {
    result: { content: [{ type: "text", text: "ignored" }], structuredContent: body },
    logErrorCode: null,
  });
  assertEquals(fromStructured, { ok: true, target: A, messages: [msg("m", 1)], total: 1, totalIsEstimate: false, hasMore: true });
  const fromText = legFromToolResult(A, { result: { content: [{ type: "text", text: JSON.stringify(body) }] } });
  assertEquals(fromText.ok, true);
  const failed = legFromToolResult(A, {
    result: { content: [{ type: "text", text: "No inbox matches" }], isError: true },
    logErrorCode: "inbox_not_found",
  });
  assertEquals(failed, { ok: false, target: A, errorCode: "inbox_not_found", message: "No inbox matches" });
  assertEquals(legFromToolResult(A, null).ok, false);
});

// ── Listing ─────────────────────────────────────────────────────────────────

Deno.test("listing: not visible, the tools come back as the same objects", () => {
  const tools = server.TOOL_REGISTRY.slice();
  const out = advertiseCrossInboxSearch(tools, { visible: false });
  assertEquals(out.length, tools.length);
  out.forEach((t, i) => assert(t === tools[i]));
});

Deno.test("listing: visible, inbox_id on the list and search tools takes all, without the uuid format", () => {
  const consolidated = server.TOOL_REGISTRY.filter((t) => t.name === "email_read");
  const perOp = server.PER_OPERATION_LISTING.filter((t) => t.name === "email_list" || t.name === "email_search");
  assertEquals(perOp.length, 2);
  for (const tool of advertiseCrossInboxSearch([...consolidated, ...perOp], { visible: true })) {
    const schema = (tool.listedInputSchema ?? tool.inputSchema) as { properties: Record<string, Record<string, unknown>> };
    const inboxId = schema.properties.inbox_id;
    assertEquals(inboxId.format, undefined, tool.name);
    assertStringIncludes(String(inboxId.description), `"all" for every inbox at once (Pro)`);
  }
  // The registry itself (what the validator reads) is untouched.
  const registry = server.TOOL_REGISTRY.find((t) => t.name === "email_read")!;
  assertEquals((registry.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties.inbox_id.format, "uuid");
  // Other tools keep their inbox_id as it was.
  const folderList = server.PER_OPERATION_LISTING.filter((t) => t.name === "folder_list");
  assert(advertiseCrossInboxSearch(folderList, { visible: true })[0] === folderList[0]);
});

// ── Closed gate, end to end (introspection mode reads the gate as closed) ──

const KEY = () => ({
  id: "11111111-1111-4111-8111-111111111111",
  workspace_id: "22222222-2222-4222-8222-222222222222",
  name: "cross-inbox test",
  key_prefix: "mcpe_abc",
  key_hash: "",
  scopes: ["read:email", "search:email"],
  inbox_ids: null,
  expires_at: null,
  last_used_at: null,
  deleted_at: null,
  created_at: new Date().toISOString(),
});

Deno.test("closed gate: inbox_id all is refused by the uuid check exactly as before", async () => {
  for (const [name, args] of [
    ["email_read", { action: "list", inbox_id: "all" }],
    ["email_read", { action: "search", inbox_id: "all", from: "someone" }],
    ["email_list", { inbox_id: "all" }],
  ] as const) {
    // deno-lint-ignore no-explicit-any
    const response: any = await server.handleToolsCall(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { ...args } } },
      1,
      // deno-lint-ignore no-explicit-any
      KEY() as any,
      { userAgent: null },
    );
    const text = JSON.stringify(response);
    assertStringIncludes(text, "inbox_id", name);
    assertStringIncludes(text, "must be a UUID", name);
    assert(!text.includes("Pro"), `${name} must not mention Pro while the feature is hidden`);
  }
});

Deno.test("closed gate: tools/list never mentions all", async () => {
  // deno-lint-ignore no-explicit-any
  const response: any = await server.handleToolsList({ jsonrpc: "2.0", id: 1, method: "tools/list" }, 1, KEY() as any);
  const text = JSON.stringify(response.result.tools);
  assert(!text.includes(`"all" for every inbox`));
});
