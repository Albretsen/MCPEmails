// Tests for card-build-notify.ts — when a client is told its cached tool list
// (and therefore its cached card URI) is stale, and how that reaches a client
// over a stateless POST-only transport.

import {
  acceptsEventStream,
  CARD_LISTING_STALE,
  decideBuildNotification,
  sseResponse,
  TOOLS_LIST_CHANGED_NOTIFICATION,
} from "./card-build-notify.ts";
import { isCardBearingToolName } from "./mcp-app-resources.ts";

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const BASE = {
  method: "tools/call",
  cardBearingTool: true,
  acceptsEventStream: true,
  notifiedBuild: "aaaaaaaaaaaa",
  currentBuild: "bbbbbbbbbbbb",
};

Deno.test("the notification is a bare JSON-RPC notification", () => {
  // No id: a notification, not a request. A client that treats it as a request
  // would wait forever for a response that is not coming.
  assertEquals(
    TOOLS_LIST_CHANGED_NOTIFICATION as Record<string, unknown>,
    { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
    "notification shape",
  );
  assert(!("id" in TOOLS_LIST_CHANGED_NOTIFICATION), "must carry no id");
  assert(!("params" in TOOLS_LIST_CHANGED_NOTIFICATION), "must carry no params");
});

Deno.test("a card-bearing call on a stale build notifies and records", () => {
  assertEquals(
    decideBuildNotification(BASE),
    { notify: true, record: "bbbbbbbbbbbb" },
    "the whole point",
  );
});

Deno.test("nothing is sent when the build has not moved", () => {
  assertEquals(
    decideBuildNotification({ ...BASE, notifiedBuild: BASE.currentBuild }),
    { notify: false, record: null },
    "same build",
  );
});

Deno.test("a client that has never read tools/list is not notified", () => {
  // It holds no cached listing, so there is nothing to invalidate. Notifying
  // would make a brand-new connection immediately re-read the list it is about
  // to read anyway.
  assertEquals(
    decideBuildNotification({ ...BASE, notifiedBuild: null }),
    { notify: false, record: null },
    "null notifiedBuild",
  );
});

Deno.test("tools/list records the build and never notifies", () => {
  // The client is being handed the current listing in this very response.
  // Telling it the listing changed would be false, and would loop: it would
  // re-read, and we would tell it again.
  assertEquals(
    decideBuildNotification({ ...BASE, method: "tools/list", notifiedBuild: null }),
    { notify: false, record: "bbbbbbbbbbbb" },
    "first tools/list records",
  );
  assertEquals(
    decideBuildNotification({
      ...BASE,
      method: "tools/list",
      notifiedBuild: BASE.currentBuild,
    }),
    { notify: false, record: null },
    "an unchanged build writes nothing",
  );
});

Deno.test("only card-bearing tool calls notify", () => {
  assertEquals(
    decideBuildNotification({ ...BASE, cardBearingTool: false }),
    { notify: false, record: null },
    "a tool with no card cannot have a stale card",
  );
});

Deno.test("methods other than tools/call and tools/list are inert", () => {
  // Streamable HTTP asks that messages on a POST's stream "relate to the
  // originating client request". A ping does not.
  for (const method of ["ping", "initialize", "resources/read", "prompts/list"]) {
    assertEquals(
      decideBuildNotification({ ...BASE, method }),
      { notify: false, record: null },
      `${method} must be inert`,
    );
  }
});

Deno.test("a client that did not ask for an event stream gets none", () => {
  // Without it there is no channel, and a client that asked for
  // application/json must not be handed a stream it cannot parse.
  assertEquals(
    decideBuildNotification({ ...BASE, acceptsEventStream: false }),
    { notify: false, record: null },
    "no SSE, no notification",
  );
});

Deno.test("acceptsEventStream reads the Accept header", () => {
  assertEquals(acceptsEventStream("application/json, text/event-stream"), true, "both");
  assertEquals(acceptsEventStream("TEXT/EVENT-STREAM"), true, "case-insensitive");
  assertEquals(acceptsEventStream("application/json"), false, "json only");
  assertEquals(acceptsEventStream(null), false, "absent");
  assertEquals(acceptsEventStream(""), false, "empty");
});

Deno.test("the card-bearing tool set is the three gated lists", () => {
  for (const name of ["draft", "email_compose", "schedule", "email_delete", "email_organize", "email_search_and_move"]) {
    assert(isCardBearingToolName(name), `${name} can mount the card`);
  }
  for (const name of ["inbox_list", "email_read", "folder_list", "signature_get", "ping"]) {
    assert(!isCardBearingToolName(name), `${name} cannot`);
  }
});

Deno.test("the SSE stream carries notifications first, then the response", async () => {
  const response = { jsonrpc: "2.0", id: 7, result: { ok: true } };
  const res = sseResponse([TOOLS_LIST_CHANGED_NOTIFICATION], response);

  assertEquals(res.status, 200, "status");
  assertEquals(res.headers.get("Content-Type"), "text/event-stream", "content type");

  const body = await res.text();
  const frames = body
    .split("\n\n")
    .filter((f) => f.trim().length > 0)
    .map((f) => JSON.parse(f.replace(/^data: /, "")));

  assertEquals(frames.length, 2, "two frames");
  assertEquals(
    frames[0],
    { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
    "the notification comes FIRST — the spec allows notifications only BEFORE the response",
  );
  assertEquals(frames[1], response, "then the response for the POSTed request");
});

Deno.test("the SSE stream is well-formed with no notifications at all", async () => {
  const response = { jsonrpc: "2.0", id: 1, result: {} };
  const body = await sseResponse([], response).text();
  assertEquals(body, `data: ${JSON.stringify(response)}\n\n`, "just the response");
});

Deno.test("sseResponse passes CORS headers through", () => {
  // The browser-facing proxy relies on these; an SSE response that drops them
  // is a response the client cannot read.
  const res = sseResponse([], { jsonrpc: "2.0", id: 1, result: {} }, {
    "Access-Control-Allow-Origin": "*",
  });
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*", "CORS preserved");
});

Deno.test("a preference change notifies, even though the card did not change", () => {
  // The bug this pins: hiding the card changes no bytes of the bundle, so the
  // build id is unmoved and the old logic stayed silent. The user kept seeing
  // the card they had just turned off until they reconnected, which is exactly
  // the staleness the notification exists to remove. Writing the sentinel makes
  // the next card-bearing call notify.
  assertEquals(
    decideBuildNotification({ ...BASE, notifiedBuild: CARD_LISTING_STALE }),
    { notify: true, record: BASE.currentBuild },
    "a stale marker notifies and then re-records the real build",
  );
});

Deno.test("the stale sentinel can never collide with a real build id", () => {
  // Build ids are 12 lowercase hex. If the sentinel could ever equal one, a
  // deploy would land on it and silently stop notifying.
  assert(
    !/^[0-9a-f]{12}$/.test(CARD_LISTING_STALE),
    `sentinel must not look like a build id, got ${CARD_LISTING_STALE}`,
  );
});

Deno.test("a stale marker on a non-card tool still says nothing", () => {
  // Invalidation is workspace-wide and deliberately over-broad, so it must not
  // turn every unrelated tool call into a tools/list re-read.
  assertEquals(
    decideBuildNotification({
      ...BASE,
      notifiedBuild: CARD_LISTING_STALE,
      cardBearingTool: false,
    }),
    { notify: false, record: null },
    "still only card-bearing calls",
  );
});
