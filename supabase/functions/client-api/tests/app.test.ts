// The router: CORS, the error envelope, auth, the workspace gate, the viewer
// rule, argument validation, batching, rate limiting, headers and logging.
// Driven with a stand-in for the mcp-server module, so nothing here loads it.

import { assert, assertEquals, assertMatch, assertStringIncludes } from "jsr:@std/assert@1";
import type { AssistantDeps } from "../assistant-deps.ts";
import { contentDisposition } from "../app.ts";
import { ALLOWED_ORIGINS } from "../cors.ts";
import { OP_NAMES, OPS } from "../mail/ops.ts";
import { RateLimiter } from "../rate-limit.ts";
import { ListenGuardError, loadMcpSeam } from "../seam.ts";
import {
  fakeSeam,
  fakeStore,
  INBOX_ID,
  membership,
  mintHs256,
  ok,
  ORIGIN,
  request,
  SECOND_INBOX_ID,
  SECOND_WORKSPACE_ID,
  testApp,
  toolError,
  USER_ID,
  WORKSPACE_ID,
} from "./helpers.ts";

const token = await mintHs256();

async function errorOf(response: Response): Promise<{ code: string; message: string; retryable: boolean; tool_code?: string }> {
  const body = await response.json();
  assertEquals(Object.keys(body.error).filter((k) => !["code", "message", "retryable", "tool_code", "retry_after"].includes(k)), []);
  assertEquals(typeof body.error.code, "string");
  assertEquals(typeof body.error.message, "string");
  assertEquals(typeof body.error.retryable, "boolean");
  return body.error;
}

// ── CORS ────────────────────────────────────────────────────────────────────

Deno.test("CORS: the allow-list is exactly the production app and the dev server", () => {
  assertEquals([...ALLOWED_ORIGINS], ["https://app.mcpemails.com", "http://localhost:5183"]);
});

Deno.test("CORS: a preflight from an allowed origin is answered 204 with the headers the client sends", async () => {
  const { handle, store } = testApp();
  for (const origin of ALLOWED_ORIGINS) {
    const response = await handle(request("/mail", { method: "OPTIONS", origin }));
    assertEquals(response.status, 204);
    assertEquals(response.headers.get("access-control-allow-origin"), origin);
    assertStringIncludes(response.headers.get("access-control-allow-headers") ?? "", "authorization");
    assertStringIncludes(response.headers.get("access-control-allow-headers") ?? "", "x-workspace-id");
    assertEquals(response.headers.get("access-control-allow-credentials"), null, "no cookies");
    assertStringIncludes(response.headers.get("vary") ?? "", "Origin");
  }
  assertEquals(store.calls.memberships, 0, "a preflight needs no auth and no database");
});

Deno.test("CORS: any other origin gets no Access-Control-Allow-Origin, on a preflight or a real request", async () => {
  const { handle } = testApp();
  for (const origin of ["https://evil.example", "https://app.mcpemails.com.evil.example", "http://localhost:3000", "null"]) {
    const preflight = await handle(request("/mail", { method: "OPTIONS", origin }));
    assertEquals(preflight.status, 403);
    assertEquals(preflight.headers.get("access-control-allow-origin"), null);
    const real = await handle(request("/session", { token, origin }));
    assertEquals(real.headers.get("access-control-allow-origin"), null);
    await real.body?.cancel();
  }
});

Deno.test("CORS: responses to the app carry the origin, and expose the timing and request-id headers", async () => {
  const { handle } = testApp();
  const response = await handle(request("/allowance", { token }));
  assertEquals(response.headers.get("access-control-allow-origin"), ORIGIN);
  const exposed = response.headers.get("access-control-expose-headers") ?? "";
  assertStringIncludes(exposed, "server-timing");
  assertStringIncludes(exposed, "x-request-id");
  await response.body?.cancel();
});

// ── envelope, headers ───────────────────────────────────────────────────────

Deno.test("every response carries Server-Timing with the four phases, and X-Request-Id", async () => {
  const { handle } = testApp();
  const responses = [
    await handle(request("/session", { token })),
    await handle(request("/session", { token: null })),
    await handle(request("/nope", { token })),
    await handle(request("/mail", { token, body: { op: "list", inbox_id: INBOX_ID, args: {} } })),
  ];
  for (const response of responses) {
    assertMatch(
      response.headers.get("server-timing") ?? "",
      // The four phases, then which isolate answered and its request count.
      /^auth;dur=[\d.]+, db;dur=[\d.]+, provider;dur=[\d.]+, total;dur=[\d.]+(, connect;dur=[\d.]+, imap;desc="\d+:\d+")?, isolate;desc="[0-9a-f]{8}:\d+"$/,
    );
    assertMatch(response.headers.get("x-request-id") ?? "", /^[A-Za-z0-9_-]{8,64}$/);
    assertEquals(response.headers.get("cache-control"), "no-store");
    await response.body?.cancel();
  }
});

Deno.test("X-Request-Id: a well-formed client id is echoed, anything else is replaced", async () => {
  const { handle } = testApp();
  const echoed = await handle(request("/allowance", { token, headers: { "x-request-id": "client-req-0001" } }));
  assertEquals(echoed.headers.get("x-request-id"), "client-req-0001");
  await echoed.body?.cancel();
  const replaced = await handle(request("/allowance", { token, headers: { "x-request-id": "bad id\twith spaces" } }));
  assert(replaced.headers.get("x-request-id") !== "bad id\twith spaces");
  await replaced.body?.cancel();
});

Deno.test("error envelope: unknown route, wrong method, bad JSON, unknown op", async () => {
  const { handle } = testApp();
  const notFound = await handle(request("/nope", { token }));
  assertEquals([notFound.status, (await errorOf(notFound)).code], [404, "not_found"]);

  const wrongMethod = await handle(request("/mail", { token, method: "GET" }));
  assertEquals([wrongMethod.status, (await errorOf(wrongMethod)).code], [405, "invalid_request"]);

  const badJson = await handle(
    new Request("https://x.invalid/functions/v1/client-api/mail", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
      body: "{not json",
    }),
  );
  assertEquals([badJson.status, (await errorOf(badJson)).code], [400, "invalid_request"]);

  const unknownOp = await handle(request("/mail", { token, body: { op: "drop_everything", inbox_id: INBOX_ID } }));
  assertEquals([unknownOp.status, (await errorOf(unknownOp)).code], [400, "invalid_request"]);

  const proto = await handle(request("/mail", { token, body: { op: "constructor", inbox_id: INBOX_ID } }));
  assertEquals(proto.status, 400, "an inherited property name is not an op");
  await proto.body?.cancel();
});

Deno.test("error envelope: an unexpected exception is a 500 with no detail on the wire", async () => {
  const seam = fakeSeam();
  const store = fakeStore();
  store.ensureWebClientKey = () => Promise.reject(new Error("secret internal detail: host db-7"));
  const { handle, logs } = testApp({ seam, store });
  const response = await handle(request("/allowance", { token }));
  assertEquals(response.status, 500);
  const error = await errorOf(response);
  assertEquals([error.code, error.retryable], ["internal_error", true]);
  assert(!error.message.includes("db-7"));
  assert(!JSON.stringify(logs).includes("db-7"), "the message is not logged either, only the error name");
});

Deno.test("executor errors map to the public codes", async () => {
  const cases: Array<[string, number, string, boolean]> = [
    ["-32602", 400, "invalid_request", false],
    ["inbox_not_found", 404, "inbox_not_found", false],
    ["message_not_found", 404, "not_found", false],
    ["auth_failed", 409, "reconnect_required", false],
    ["provider_error", 502, "provider_error", true],
    ["search_timeout", 504, "timeout", true],
    ["quota_exceeded", 429, "rate_limited", true],
  ];
  for (const [toolCode, status, code, retryable] of cases) {
    const seam = fakeSeam();
    seam.respond = () => toolError(toolCode, "The executor's own explanation.");
    const { handle } = testApp({ seam });
    const response = await handle(request("/mail", { token, body: { op: "list", inbox_id: INBOX_ID, args: {} } }));
    const error = await errorOf(response);
    assertEquals([response.status, error.code, error.retryable, error.tool_code], [status, code, retryable, toolCode]);
    // A refused credential is the one error whose text is rewritten for the
    // person using the app (tests/inbox-health.test.ts); the rest pass through.
    if (toolCode !== "auth_failed") assertEquals(error.message, "The executor's own explanation.");
  }
});

Deno.test("an executor that throws is a retryable provider_error, and its message is neither returned nor logged", async () => {
  const seam = fakeSeam();
  seam.respond = () => {
    throw new Error("Subject: Quarterly numbers for alice@customer.example");
  };
  const { handle, logs } = testApp({ seam });
  const response = await handle(request("/mail", { token, body: { op: "read", inbox_id: INBOX_ID, args: { message_id: "m1" } } }));
  const error = await errorOf(response);
  assertEquals([response.status, error.code, error.retryable], [502, "provider_error", true]);
  assert(!JSON.stringify([error, logs]).includes("Quarterly"));
});

// ── auth + gate ─────────────────────────────────────────────────────────────

Deno.test("no token, a bad token and an expired token are all 401 unauthenticated", async () => {
  const { handle, seam } = testApp();
  const expired = await mintHs256({ expiresIn: -120 });
  for (const t of [null, "not.a.jwt", expired]) {
    const response = await handle(request("/mail", { token: t, body: { op: "list", inbox_id: INBOX_ID } }));
    assertEquals([response.status, (await errorOf(response)).code], [401, "unauthenticated"]);
  }
  assertEquals((seam as ReturnType<typeof fakeSeam>).calls.length, 0);
});

Deno.test("gate: a disabled workspace is refused on every route, before any executor runs", async () => {
  const seam = fakeSeam();
  const { handle, store } = testApp({ seam, store: fakeStore([membership({ web_client_enabled: false })]) });
  const routes: Request[] = [
    request("/session", { token }),
    request("/allowance", { token }),
    request("/mail", { token, body: { op: "list", inbox_id: INBOX_ID } }),
    request("/mail/batch", { token, body: { calls: [{ op: "list", inbox_id: INBOX_ID }] } }),
    request("/assistant/run", { token, body: { text: "hi" } }),
  ];
  for (const req of routes) {
    const response = await handle(req);
    assertEquals([response.status, (await errorOf(response)).code], [403, "web_client_disabled"]);
  }
  assertEquals(seam.calls.length, 0);
  assertEquals(store.calls.ensureKey, 0, "no hidden key is created for a workspace that is not allow-listed");
});

Deno.test("gate: a non-member is forbidden, including for a workspace named in X-Workspace-Id", async () => {
  const seam = fakeSeam();
  const none = testApp({ seam, store: fakeStore([]) });
  const response = await none.handle(request("/session", { token }));
  assertEquals([response.status, (await errorOf(response)).code], [403, "forbidden"]);

  const one = testApp({ seam });
  const other = await one.handle(
    request("/mail", { token, headers: { "x-workspace-id": SECOND_WORKSPACE_ID }, body: { op: "list", inbox_id: INBOX_ID } }),
  );
  assertEquals([other.status, (await errorOf(other)).code], [403, "forbidden"]);
  assertEquals(seam.calls.length, 0);
});

Deno.test("gate: X-Workspace-Id selects the workspace the executors run in", async () => {
  const seam = fakeSeam();
  const { handle } = testApp({
    seam,
    store: fakeStore([
      membership(),
      membership({ workspace_id: SECOND_WORKSPACE_ID, joined_at: "2026-06-01T00:00:00Z" }),
    ]),
  });
  await (await handle(request("/mail", { token, body: { op: "folders", inbox_id: INBOX_ID } }))).body?.cancel();
  await (await handle(
    request("/mail", { token, headers: { "x-workspace-id": SECOND_WORKSPACE_ID }, body: { op: "folders", inbox_id: INBOX_ID } }),
  )).body?.cancel();
  assertEquals(seam.calls.map((c) => c.apiKey.workspace_id), [WORKSPACE_ID, SECOND_WORKSPACE_ID]);
});

Deno.test("viewer: read ops run, every write and send op is forbidden before an executor is reached", async () => {
  const seam = fakeSeam();
  const { handle } = testApp({ seam, store: fakeStore([membership({ role: "viewer" })]) });
  const read = await handle(request("/mail", { token, body: { op: "list", inbox_id: INBOX_ID, args: {} } }));
  assertEquals(read.status, 200);
  await read.body?.cancel();
  assertEquals(seam.calls.at(-1)!.apiKey.scopes, ["read:email", "search:email"], "a viewer's key carries read scopes only");

  const args: Record<string, Record<string, unknown>> = {
    flag: { message_ids: ["m1"], read: true },
    move: { message_ids: ["m1"], destination_folder_id: "archive" },
    archive: { message_ids: ["m1"] },
    delete: { message_ids: ["m1"] },
    send: { to: ["a@b.example"], subject: "s", body: "b", idempotency_key: "k-1" },
    reply: { message_id: "m1", body: "b", idempotency_key: "k-2" },
    forward: { message_id: "m1", to: ["a@b.example"], idempotency_key: "k-3" },
    draft_create: { subject: "s", body: "b" },
    draft_update: { draft_id: "d1", body: "b" },
    draft_delete: { draft_id: "d1" },
    draft_send: { draft_id: "d1", idempotency_key: "k-4" },
    schedule_create: { to: ["a@b.example"], subject: "s", body: "b", send_at: "2027-01-01T00:00:00Z", idempotency_key: "k-5" },
    schedule_cancel: { id: "s1" },
  };
  const writes = OP_NAMES.filter((op) => OPS[op].kind !== "read");
  assertEquals(writes.slice().sort(), Object.keys(args).sort(), "every non-read op is covered by this test");
  const before = seam.calls.length;
  for (const op of writes) {
    const response = await handle(request("/mail", { token, body: { op, inbox_id: INBOX_ID, args: args[op] } }));
    assertEquals([op, response.status, (await errorOf(response)).code], [op, 403, "forbidden"]);
  }
  assertEquals(seam.calls.length, before);
});

Deno.test("the human-sender marker is on the key for mail ops, and the key never carries an inbox allowlist", async () => {
  const seam = fakeSeam();
  const { handle } = testApp({ seam });
  await (await handle(
    request("/mail", { token, body: { op: "send", inbox_id: INBOX_ID, args: { to: ["a@b.example"], subject: "s", body: "b", idempotency_key: "key-0001" } } }),
  )).body?.cancel();
  const call = seam.calls.at(-1)!;
  assertEquals(call.tool, "email_send");
  assertEquals((call.apiKey as { firstPartyHuman?: boolean }).firstPartyHuman, true);
  assertEquals(call.apiKey.inbox_ids, null);
  assertEquals(call.args["inbox_id"], INBOX_ID);
  assertEquals(seam.claims, [{ tool: "email_send", key: "key-0001" }], "the send was claimed in the idempotency ledger");
  assertEquals(seam.completed, 1);
});

// ── validation ──────────────────────────────────────────────────────────────

Deno.test("validation: unknown arguments, missing ids, oversize lists and missing idempotency keys are refused", async () => {
  const seam = fakeSeam();
  const { handle } = testApp({ seam });
  const bad: Array<[string, unknown]> = [
    ["unknown argument", { op: "list", inbox_id: INBOX_ID, args: { folder: "inbox", sneaky: true } }],
    ["no inbox_id", { op: "list", args: {} }],
    ["inbox_id not a uuid", { op: "list", inbox_id: "inbox-1", args: {} }],
    ["limit above 100", { op: "list", inbox_id: INBOX_ID, args: { limit: 101 } }],
    ["too many ids", { op: "flag", inbox_id: INBOX_ID, args: { message_ids: Array.from({ length: 501 }, (_, i) => `m${i}`), read: true } }],
    ["read_batch above 50", { op: "read_batch", inbox_id: INBOX_ID, args: { message_ids: Array.from({ length: 51 }, (_, i) => `m${i}`) } }],
    ["flag with nothing to set", { op: "flag", inbox_id: INBOX_ID, args: { message_ids: ["m1"] } }],
    ["send without idempotency_key", { op: "send", inbox_id: INBOX_ID, args: { to: ["a@b.example"], subject: "s", body: "b" } }],
    ["send without recipients", { op: "send", inbox_id: INBOX_ID, args: { to: [], subject: "s", body: "b", idempotency_key: "k" } }],
    ["header injection in a recipient", { op: "send", inbox_id: INBOX_ID, args: { to: ["a@b.example\r\nBcc: x@y.example"], subject: "s", body: "b", idempotency_key: "k" } }],
    ["args not an object", { op: "list", inbox_id: INBOX_ID, args: ["x"] }],
    ["attachment with no selector", { op: "attachment", inbox_id: INBOX_ID, args: { message_id: "m1" } }],
  ];
  for (const [why, body] of bad) {
    const response = await handle(request("/mail", { token, body }));
    assertEquals([why, response.status], [why, 400]);
    assertEquals((await errorOf(response)).code, "invalid_request");
  }
  assertEquals(seam.calls.length, 0, "nothing invalid reached an executor");
});

Deno.test("ops map to the documented executors with only the allowed arguments", async () => {
  const seam = fakeSeam();
  const { handle } = testApp({ seam });
  const run = async (op: string, args: Record<string, unknown>, inbox: string | null = INBOX_ID) => {
    const before = seam.calls.length;
    const response = await handle(request("/mail", { token, body: { op, inbox_id: inbox ?? undefined, args } }));
    assertEquals([op, response.status], [op, 200]);
    await response.body?.cancel();
    return seam.calls.slice(before).map((c) => [c.tool, c.args]);
  };
  assertEquals(await run("list", { folder: "inbox", unread: true }), [
    ["email_list", { folder: "inbox", limit: 50, offset: 0, unread: true, inbox_id: INBOX_ID }],
  ]);
  assertEquals(await run("read", { message_id: "m1" }), [
    ["email_read", { message_id: "m1", include_html: true, include_attachments: false, inbox_id: INBOX_ID }],
  ]);
  assertEquals(await run("search", { text: "invoice", flagged: true, limit: 20 }), [
    ["email_search", { text: "invoice", flagged: true, limit: 20, offset: 0, inbox_id: INBOX_ID }],
  ]);
  assertEquals(await run("flag", { message_ids: ["m1", "m2"], read: true, starred: false }), [
    ["email_flag", { message_ids: ["m1", "m2"], action: "read", inbox_id: INBOX_ID }],
    ["email_flag", { message_ids: ["m1", "m2"], action: "unflag", inbox_id: INBOX_ID }],
  ]);
  assertEquals(await run("archive", { message_ids: ["m1"] }), [["email_archive", { message_id: "m1", inbox_id: INBOX_ID }]]);
  assertEquals(await run("archive", { message_ids: ["m1", "m2"] }), [
    ["email_move_batch", { message_ids: ["m1", "m2"], destination_folder_id: "archive", inbox_id: INBOX_ID }],
  ]);
  assertEquals(await run("delete", { message_ids: ["m1"] }), [
    ["email_delete_batch", { message_ids: ["m1"], permanent: false, inbox_id: INBOX_ID }],
  ]);
  assertEquals(await run("draft_read", { draft_id: "d9" }), [
    ["email_read", { message_id: "d9", include_html: true, include_attachments: false, inbox_id: INBOX_ID }],
  ]);
  assertEquals(await run("draft_create", { message_id: "m1", body: "Thanks", reply_all: true }), [
    ["draft_reply", { message_id: "m1", body: "Thanks", reply_all: true, inbox_id: INBOX_ID }],
  ]);
  assertEquals(await run("send", { to: [{ name: "A", email: "a@b.example" }], subject: "s", body: "b", idempotency_key: "key-1" }), [
    ["email_send", { to: ["a@b.example"], subject: "s", body: "b", inbox_id: INBOX_ID, idempotency_key: "key-1" }],
  ]);
  assertEquals(await run("contacts", { query: "ma" }, null), [["contact_search", { query: "ma" }]]);
  assertEquals(await run("schedule_cancel", { id: "s1" }, null), [["schedule_cancel", { id: "s1" }]]);
});

Deno.test("flag: the idempotency ledger is skipped (three round trips saved on the hottest write)", async () => {
  const seam = fakeSeam();
  const { handle } = testApp({ seam });
  await (await handle(
    request("/mail", { token, body: { op: "flag", inbox_id: INBOX_ID, args: { message_ids: ["m1"], read: true, idempotency_key: "ignored" } } }),
  )).body?.cancel();
  assertEquals(seam.claims.length, 0);
  assertEquals(seam.calls[0].args["idempotency_key"], undefined);
});

// ── attachment ──────────────────────────────────────────────────────────────

Deno.test("attachment: answered as the raw bytes with a content type and a download disposition", async () => {
  const seam = fakeSeam();
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10]);
  seam.respond = () =>
    ok({
      filename: 'Rapport "Q3" æøå.pdf',
      mime_type: "application/pdf",
      size_bytes: bytes.length,
      data: btoa(String.fromCharCode(...bytes)),
    });
  const { handle } = testApp({ seam });
  const response = await handle(
    request("/mail", { token, body: { op: "attachment", inbox_id: INBOX_ID, args: { message_id: "m1", attachment_index: 0 } } }),
  );
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), "application/pdf");
  assertEquals(response.headers.get("content-length"), String(bytes.length));
  const disposition = response.headers.get("content-disposition") ?? "";
  assert(disposition.startsWith("attachment; filename="));
  assertStringIncludes(disposition, "filename*=UTF-8''");
  assert(!/[\r\n]/.test(disposition));
  assertEquals(new Uint8Array(await response.arrayBuffer()), bytes);
});

Deno.test("attachment: HTML and SVG are served as opaque downloads, never as a renderable type", async () => {
  for (const mime of ["text/html", "image/svg+xml", "application/javascript", "TEXT/HTML; charset=utf-8", "not a type"]) {
    const seam = fakeSeam();
    seam.respond = () => ok({ filename: "x", mime_type: mime, data: btoa("<script>1</script>") });
    const { handle } = testApp({ seam });
    const response = await handle(
      request("/mail", { token, body: { op: "attachment", inbox_id: INBOX_ID, args: { message_id: "m1", attachment_index: 0 } } }),
    );
    assertEquals([mime, response.headers.get("content-type")], [mime, "application/octet-stream"]);
    assertEquals(response.headers.get("x-content-type-options"), "nosniff");
    await response.body?.cancel();
  }
});

Deno.test("content disposition: quotes, slashes and control characters in a stored filename cannot break the header", () => {
  const header = contentDisposition('a"b\\c/d\r\nSet-Cookie: x=1.txt');
  assert(!/[\r\n]/.test(header));
  assertMatch(header, /^attachment; filename="[^"\\]*"; filename\*=UTF-8''[A-Za-z0-9%._~!*'()-]+$/);
});

// ── batch ───────────────────────────────────────────────────────────────────

Deno.test("batch: results come back in request order; same-inbox calls run in order, other inboxes in parallel", async () => {
  const seam = fakeSeam();
  const started: string[] = [];
  const finished: string[] = [];
  let inFlightA = 0;
  let maxInFlightA = 0;
  let sawParallel = false;
  let inFlight = 0;
  seam.respond = async (call) => {
    const tag = `${call.args["inbox_id"] === INBOX_ID ? "A" : "B"}:${call.args["message_id"]}`;
    started.push(tag);
    inFlight++;
    if (inFlight > 1) sawParallel = true;
    if (tag.startsWith("A")) maxInFlightA = Math.max(maxInFlightA, ++inFlightA);
    // The first call for inbox A is the slowest: order must not depend on speed.
    await new Promise((resolve) => setTimeout(resolve, tag === "A:1" ? 15 : 2));
    if (tag.startsWith("A")) inFlightA--;
    inFlight--;
    finished.push(tag);
    return ok({ tag });
  };
  const { handle } = testApp({ seam });
  const calls = [
    { op: "read", inbox_id: INBOX_ID, args: { message_id: "1" } },
    { op: "read", inbox_id: SECOND_INBOX_ID, args: { message_id: "1" } },
    { op: "read", inbox_id: INBOX_ID, args: { message_id: "2" } },
    { op: "read", inbox_id: INBOX_ID, args: { message_id: "3" } },
    { op: "read", inbox_id: SECOND_INBOX_ID, args: { message_id: "2" } },
  ];
  const response = await handle(request("/mail/batch", { token, body: { calls } }));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(
    body.results.map((r: { ok: boolean; result: { tag: string } }) => r.result.tag),
    ["A:1", "B:1", "A:2", "A:3", "B:2"],
    "results are in the order the calls were given",
  );
  assertEquals(started.filter((t) => t.startsWith("A")), ["A:1", "A:2", "A:3"], "inbox A's calls ran in order");
  assertEquals(maxInFlightA, 1, "never two calls at once on one inbox");
  assertEquals(sawParallel, true, "the two inboxes overlapped");
  assert(finished.indexOf("B:2") < finished.indexOf("A:3"), "inbox B did not wait for inbox A");
});

Deno.test("batch: one failing call fills its own slot and the rest still run", async () => {
  const seam = fakeSeam();
  seam.respond = (call) =>
    call.args["message_id"] === "gone" ? toolError("message_not_found", "No such message.") : ok({ id: call.args["message_id"] });
  const { handle } = testApp({ seam });
  const response = await handle(
    request("/mail/batch", {
      token,
      body: {
        calls: [
          { op: "read", inbox_id: INBOX_ID, args: { message_id: "a" } },
          { op: "read", inbox_id: INBOX_ID, args: { message_id: "gone" } },
          { op: "nonsense", inbox_id: INBOX_ID },
          { op: "attachment", inbox_id: INBOX_ID, args: { message_id: "a", attachment_index: 0 } },
          { op: "read", inbox_id: INBOX_ID, args: { message_id: "b" } },
        ],
      },
    }),
  );
  const body = await response.json();
  assertEquals(body.results.map((r: { ok: boolean }) => r.ok), [true, false, false, false, true]);
  assertEquals(body.results[1].error.code, "not_found");
  assertEquals(body.results[2].error.code, "invalid_request");
  assertEquals(body.results[3].error.code, "invalid_request");
  // A read result carries its conversation key (mail/thread-key.ts).
  assertEquals(body.results[4].result, { id: "b", thread_key: "u:b" });
});

Deno.test("batch: more than 12 calls, an empty list and a non-array are refused", async () => {
  const { handle } = testApp();
  const thirteen = Array.from({ length: 13 }, () => ({ op: "folders", inbox_id: INBOX_ID }));
  for (const calls of [thirteen, [], "x", undefined]) {
    const response = await handle(request("/mail/batch", { token, body: { calls } }));
    assertEquals([response.status, (await errorOf(response)).code], [400, "invalid_request"]);
  }
});

// ── rate limit ──────────────────────────────────────────────────────────────

Deno.test("rate limit: over the bucket is 429 rate_limited with Retry-After, and no executor runs", async () => {
  const seam = fakeSeam();
  const limiter = new RateLimiter(
    {
      read: { capacity: 2, refillPerSec: 0.5 },
      write: { capacity: 1, refillPerSec: 0.5 },
      send: { capacity: 1, refillPerSec: 0.1 },
      assistant: { capacity: 1, refillPerSec: 0.1 },
    },
    { limit: 1000, windowMs: 10_000 },
  );
  const { handle } = testApp({ seam, limiter });
  const list = () => handle(request("/mail", { token, body: { op: "list", inbox_id: INBOX_ID, args: {} } }));
  assertEquals((await list()).status, 200);
  assertEquals((await list()).status, 200);
  const refused = await list();
  assertEquals(refused.status, 429);
  assert(Number(refused.headers.get("retry-after")) >= 1);
  const error = await errorOf(refused);
  assertEquals([error.code, error.retryable], ["rate_limited", true]);
  assertEquals(seam.calls.length, 2);
});

Deno.test("rate limit: a batch is charged per call and classed by its heaviest op", async () => {
  const seam = fakeSeam();
  const limiter = new RateLimiter(
    {
      read: { capacity: 100, refillPerSec: 1 },
      write: { capacity: 3, refillPerSec: 0.01 },
      send: { capacity: 1, refillPerSec: 0.01 },
      assistant: { capacity: 1, refillPerSec: 0.01 },
    },
    { limit: 1000, windowMs: 10_000 },
  );
  const { handle } = testApp({ seam, limiter });
  const flags = (n: number) =>
    handle(
      request("/mail/batch", {
        token,
        body: { calls: Array.from({ length: n }, () => ({ op: "flag", inbox_id: INBOX_ID, args: { message_ids: ["m"], read: true } })) },
      }),
    );
  const first = await flags(3);
  assertEquals(first.status, 200);
  await first.body?.cancel();
  const second = await flags(1);
  assertEquals(second.status, 429);
  await second.body?.cancel();
});

// ── caching, session, allowance ─────────────────────────────────────────────

Deno.test("warm path: the second request makes no membership or key query", async () => {
  const { handle, store } = testApp();
  for (let i = 0; i < 3; i++) {
    await (await handle(request("/mail", { token, body: { op: "folders", inbox_id: INBOX_ID } }))).body?.cancel();
  }
  assertEquals([store.calls.memberships, store.calls.ensureKey], [1, 1]);
});

Deno.test("GET /session: everything the app needs to boot, in one response", async () => {
  const seam = fakeSeam();
  const inbox = {
    inbox_id: INBOX_ID,
    email_address: "owner@example.test",
    display_name: "Owner",
    provider: "imap",
    service: "fastmail",
    sender_identities: [{ email_address: "owner@example.test", display_name: "Owner", is_default: true }],
    sender_identity_status: "available",
  };
  seam.respond = (call) => (call.tool === "inbox_list" ? ok({ inboxes: [inbox] }) : ok({}));
  const { handle, store } = testApp({
    seam,
    store: fakeStore([membership({ plan: "solo" }), membership({ workspace_id: SECOND_WORKSPACE_ID, role: "viewer", web_client_enabled: false, joined_at: "2026-05-01T00:00:00Z" })]),
  });
  const response = await handle(request("/session", { token }));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.user, { id: USER_ID, email: "owner@client-api-test.example", display_name: "Test Owner" });
  assertEquals(body.workspace_id, WORKSPACE_ID);
  assertEquals(body.role, "owner");
  assertEquals(body.workspaces, [
    { id: WORKSPACE_ID, display_name: "Test Workspace", role: "owner", plan: "solo", web_client_enabled: true },
    { id: SECOND_WORKSPACE_ID, display_name: "Test Workspace", role: "viewer", plan: "free", web_client_enabled: false },
  ]);
  assertEquals(body.inboxes, [{ ...inbox, status: "ok", status_reason: null }]);
  assertEquals(body.allowance, {
    plan: "free",
    used: 3,
    cap: 20,
    remaining: 17,
    period_start: "2026-10-01T00:00:00.000Z",
    resets_at: "2026-11-01T00:00:00.000Z",
    max_tokens_per_run: 120000,
  });
  // The inbox list is cached; a second boot does not list again.
  await (await handle(request("/session", { token }))).body?.cancel();
  assertEquals(seam.calls.filter((c) => c.tool === "inbox_list").length, 1);
  assertEquals(store.calls.allowance, 2, "the allowance is always read fresh");
});

Deno.test("GET /allowance: an unreadable allowance reports nothing left rather than inventing headroom", async () => {
  const store = fakeStore();
  store.allowance = () => Promise.reject(new Error("function does not exist"));
  const { handle } = testApp({ store });
  const response = await handle(request("/allowance", { token }));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals([body.cap, body.remaining, body.used], [0, 0, 0]);
});

// ── logging ─────────────────────────────────────────────────────────────────

Deno.test("logs: one line per request with ids, codes and timings, and nothing from the mail", async () => {
  const seam = fakeSeam();
  seam.respond = () => ok({ messages: [{ subject: "TOP SECRET SUBJECT", from: { email: "ceo@customer.example" }, preview: "wire the money" }] });
  const { handle, logs } = testApp({ seam });
  await (await handle(
    request("/mail", { token, body: { op: "search", inbox_id: INBOX_ID, args: { text: "confidential merger", from: "ceo@customer.example" } } }),
  )).body?.cancel();
  await (await handle(
    request("/mail", { token, body: { op: "send", inbox_id: INBOX_ID, args: { to: ["ceo@customer.example"], subject: "TOP SECRET SUBJECT", body: "wire the money", idempotency_key: "idem-key-1" } } }),
  )).body?.cancel();
  const lines = logs.filter((l) => l.event === "request");
  assertEquals(lines.length, 2);
  assertEquals(lines.map((l) => [l.fields["op"], l.fields["status"], l.fields["user_id"], l.fields["workspace_id"], l.fields["inbox_id"]]), [
    ["search", 200, USER_ID, WORKSPACE_ID, INBOX_ID],
    ["send", 200, USER_ID, WORKSPACE_ID, INBOX_ID],
  ]);
  const text = JSON.stringify(logs);
  for (const secret of ["TOP SECRET", "ceo@customer.example", "wire the money", "confidential merger", "idem-key-1", token]) {
    assert(!text.includes(secret), `log lines must not contain ${secret.slice(0, 12)}`);
  }
  for (const line of lines) {
    for (const key of ["request_id", "auth_ms", "db_ms", "provider_ms", "total_ms"]) assert(key in line.fields, key);
  }
});

// ── assistant route ─────────────────────────────────────────────────────────

Deno.test("POST /assistant/run: the module gets scoped deps, and its stream is passed through with CORS", async () => {
  const seam = fakeSeam();
  seam.TOOL_REGISTRY.push(
    { name: "email_read", description: "read", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list", "read", "read_batch", "search", "attachment", "original"] } } } },
    { name: "email_organize", description: "organize", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["move", "move_batch", "copy", "flag", "archive"] } } } },
    { name: "email_delete", description: "delete", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["delete", "delete_batch", "search_and_delete"] } } } },
    { name: "email_compose", description: "compose", inputSchema: { type: "object" } },
    { name: "folder_list", description: "folders", inputSchema: { type: "object" } },
    { name: "contact_search", description: "contacts", inputSchema: { type: "object" } },
    { name: "draft_list", description: "drafts", inputSchema: { type: "object" } },
  );
  seam.CONSOLIDATED_SPECS["email_read"] = { actions: { list: { legacy: "email_list", scope: "read:email" } } };
  seam.CONSOLIDATED_SPECS["email_organize"] = {
    actions: { flag: { legacy: "email_flag", scope: "manage:folders", renames: { action: "flag_action" } } },
  };
  seam.CONSOLIDATED_SPECS["email_delete"] = { actions: { delete_batch: { legacy: "email_delete_batch", scope: "delete:email" } } };

  let captured: AssistantDeps | null = null;
  const { handle, store } = testApp({
    seam,
    env: (name) => ({ OPENAI_API_KEY: "sk-test-placeholder", ASSISTANT_MODEL: "m", SUPABASE_SERVICE_ROLE_KEY: "nope", ENCRYPTION_KEY: "nope" })[name],
    assistant: () =>
      Promise.resolve(async (req, deps) => {
        captured = deps;
        assertEquals((await req.json()).text, "tidy my inbox");
        return new Response('data: {"type":"done"}\n\n', { headers: { "content-type": "text/event-stream" } });
      }),
  });
  const response = await handle(request("/assistant/run", { token, body: { text: "tidy my inbox" } }));
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), "text/event-stream");
  assertEquals(response.headers.get("access-control-allow-origin"), ORIGIN);
  assertEquals(await response.text(), 'data: {"type":"done"}\n\n');

  const deps = captured as unknown as AssistantDeps;
  assertEquals(deps.user.id, USER_ID);
  assertEquals(deps.workspaceId, WORKSPACE_ID);
  assertEquals(deps.toolSchemas.map((t) => t.name), ["email_read", "email_organize", "email_delete", "folder_list", "contact_search", "draft_list"]);
  const actions = (name: string) =>
    ((deps.toolSchemas.find((t) => t.name === name)!.inputSchema["properties"] as Record<string, { enum: string[] }>)["action"]).enum;
  assertEquals(actions("email_read"), ["list", "read", "read_batch", "search"]);
  assertEquals(actions("email_organize"), ["move", "move_batch", "flag", "archive"]);
  assertEquals(actions("email_delete"), ["delete", "delete_batch"]);

  // Secrets: the provider key and assistant settings only.
  assertEquals(deps.env("OPENAI_API_KEY"), "sk-test-placeholder");
  assertEquals(deps.env("ASSISTANT_MODEL"), "m");
  assertEquals(deps.env("SUPABASE_SERVICE_ROLE_KEY"), undefined);
  assertEquals(deps.env("ENCRYPTION_KEY"), undefined);

  // Tools: allowed ones run WITHOUT the human-sender marker; the rest never reach an executor.
  const before = seam.calls.length;
  const listed = await deps.runTool("email_read", { action: "list", inbox_id: INBOX_ID });
  assertEquals(listed.isError, false);
  const flagged = await deps.runTool("email_organize", { action: "flag", flag_action: "read", inbox_id: INBOX_ID, message_ids: ["m1"] });
  assertEquals(flagged.isError, false);
  const ran = seam.calls.slice(before);
  assertEquals(ran.map((c) => c.tool), ["email_list", "email_flag"]);
  assertEquals(ran[1].args["action"], "read", "the consolidated rename is applied exactly as the MCP path does");
  for (const call of ran) assertEquals((call.apiKey as { firstPartyHuman?: boolean }).firstPartyHuman, undefined);

  const refused: Array<[string, Record<string, unknown>]> = [
    ["email_compose", { action: "send", to: ["x@y.example"], subject: "s", body: "b" }],
    ["email_send", { to: ["x@y.example"], subject: "s", body: "b" }],
    ["email_read", { action: "attachment", message_id: "m1" }],
    ["email_organize", { action: "copy", message_id: "m1" }],
    ["email_delete", { action: "delete_batch", message_ids: ["m1"], permanent: true }],
    ["email_delete", { action: "search_and_delete", query: "from:anyone" }],
    ["folder", { action: "delete", folder_id: "f1" }],
    ["__proto__", {}],
  ];
  const callsBefore = seam.calls.length;
  for (const [name, args] of refused) {
    const result = await deps.runTool(name, args);
    assertEquals([name, result.isError], [name, true]);
  }
  assertEquals(seam.calls.length, callsBefore, "no refused tool reached an executor");

  // A permitted delete always goes to trash.
  await deps.runTool("email_delete", { action: "delete_batch", message_ids: ["m1"], inbox_id: INBOX_ID, permanent: false });
  assertEquals(seam.calls.at(-1)!.tool, "email_delete_batch");
  assertEquals("permanent" in seam.calls.at(-1)!.args, false);

  // Allowance.
  const reservation = await deps.reserveAllowance();
  assertEquals([reservation.ok, reservation.allowance.used, reservation.allowance.remaining], [true, 4, 16]);
  await deps.finalizeAllowance(reservation.reservationId!, { input_tokens: 10, output_tokens: 5, cost_micro_usd: 42, model: "m" });
  assertEquals(store.finalized.length, 1);
  store.allowanceRow = { ...store.allowanceRow!, used: 20, remaining: 0 };
  assertEquals((await deps.reserveAllowance()).ok, false);
});

Deno.test("POST /assistant/run: a viewer's assistant has read tools only", async () => {
  const seam = fakeSeam();
  for (const name of ["email_read", "email_organize", "email_delete", "folder_list", "contact_search", "draft_list"]) {
    seam.TOOL_REGISTRY.push({ name, description: name, inputSchema: { type: "object" } });
  }
  let captured: AssistantDeps | null = null;
  const { handle } = testApp({
    seam,
    store: fakeStore([membership({ role: "viewer" })]),
    assistant: () =>
      Promise.resolve((_req, deps) => {
        captured = deps;
        return Promise.resolve(new Response("ok"));
      }),
  });
  await (await handle(request("/assistant/run", { token, body: { text: "x" } }))).body?.cancel();
  const deps = captured as unknown as AssistantDeps;
  assertEquals(deps.toolSchemas.map((t) => t.name), ["email_read", "folder_list", "contact_search", "draft_list"]);
  assertEquals((await deps.runTool("email_organize", { action: "flag", flag_action: "read", message_ids: ["m"] })).isError, true);
});

Deno.test("POST /assistant/run: a module that fails to load is a 503, and mail routes are unaffected", async () => {
  const { handle } = testApp({ assistant: () => Promise.reject(new Error("module not found")) });
  const response = await handle(request("/assistant/run", { token, body: { text: "x" } }));
  assertEquals([response.status, (await errorOf(response)).code], [503, "provider_error"]);
  const mail = await handle(request("/mail", { token, body: { op: "folders", inbox_id: INBOX_ID } }));
  assertEquals(mail.status, 200);
  await mail.body?.cancel();
});

// ── the listen guard ────────────────────────────────────────────────────────

Deno.test("listen guard: the MCP server module is not imported unless MCP_SERVER_NO_LISTEN reads back as 1", async () => {
  let imported = 0;
  const importer = () => {
    imported++;
    return Promise.resolve({ dispatchExecutor: () => null, serviceRoleClient: {}, resolveInbox: () => null, TOOL_REGISTRY: [] });
  };

  // Setting the variable is refused (no env permission).
  let error: unknown;
  try {
    await loadMcpSeam({ get: () => undefined, set: () => { throw new Deno.errors.PermissionDenied("env"); } }, importer);
  } catch (e) {
    error = e;
  }
  assert(error instanceof ListenGuardError);

  // The set silently does nothing.
  error = undefined;
  try {
    await loadMcpSeam({ get: () => undefined, set: () => {} }, importer);
  } catch (e) {
    error = e;
  }
  assert(error instanceof ListenGuardError);
  assertEquals(imported, 0, "fail closed: the module was never imported");

  // The guard holds: the variable is set BEFORE the import runs.
  const env = new Map<string, string>();
  let valueAtImport: string | undefined;
  await loadMcpSeam({ get: (n) => env.get(n), set: (n, v) => void env.set(n, v) }, () => {
    valueAtImport = env.get("MCP_SERVER_NO_LISTEN");
    return importer();
  });
  assertEquals(valueAtImport, "1");
  assertEquals(imported, 1);
});
