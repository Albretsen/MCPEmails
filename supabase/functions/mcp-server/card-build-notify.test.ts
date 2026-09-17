// Tests for card-build-notify.ts — when a client is told its cached tool list
// (and therefore its cached card URI) is stale, and how that reaches a client
// over a stateless POST-only transport.

import {
  acceptsEventStream,
  CARD_BUILD_TRACKING_SINCE,
  CARD_CLAIM_DEADLINE_MS,
  CARD_LISTING_STALE,
  type CardBuildClient,
  type CardBuildUpdateBuilder,
  claimListingNotification,
  decideBuildNotification,
  predatesBuildTracking,
  sseResponse,
  TOOLS_LIST_CHANGED_NOTIFICATION,
} from "./card-build-notify.ts";
import { isCardBearingToolName } from "./mcp-app-resources.ts";
import { REVIEW_CARD_BUILD_ID } from "./ui/review-card.html.ts";

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
  notifiedBuild: "aaaaaaaaaaaa" as string | null,
  currentBuild: "bbbbbbbbbbbb",
  // The default is a key created after the column shipped: the ordinary case,
  // where a recorded build id is the only thing that decides anything.
  keyPredatesBuildTracking: false,
  keyUsedBefore: true,
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

Deno.test("a genuinely new key that has never read tools/list is not notified", () => {
  // It holds no cached listing, so there is nothing to invalidate. Notifying
  // would make a brand-new connection immediately re-read the list it is about
  // to read anyway.
  assertEquals(
    decideBuildNotification({ ...BASE, notifiedBuild: null }),
    { notify: false, record: null },
    "null notifiedBuild on a key created after tracking shipped",
  );
});

Deno.test("a key from before the column existed IS notified on a null column", () => {
  // The defect this pins, and the one that mattered most: a NULL column was
  // read as "never served a listing, nothing cached", which is true only of a
  // key that has never connected. Every client that connected before the
  // 2026-09-16T14:05Z tracking deploy reads NULL because the column did not
  // exist yet, and every one of them holds a cached listing. Excluding them
  // excluded exactly the cohort the notification was written for: for those
  // keys a card deploy AND a preference change both still needed a manual
  // reconnect.
  //
  // Counted on production 2026-09-16 22:54Z under the AUTHENTICATION filter,
  // which is the only one that can matter because an expired key cannot
  // authenticate and so can never be notified — `deleted_at is null AND
  // (expires_at is null OR expires_at > now())`: 145 keys can authenticate, 93
  // read NULL, 52 have a build recorded, and 58 NULL keys across 48 workspaces
  // both predate the watershed and have been used at least once. An earlier
  // version of this comment said 412 / 361 / 306, counted under `deleted_at is
  // null` alone (547 rows, of which 401 have already expired), overstating the
  // reachable population by roughly 4x. Only the never-expiring subset — 51
  // keys across 41 workspaces — held steady across two reads eight minutes
  // apart; every figure that includes expiring rows drifts, so quote those
  // with the timestamp attached or not at all.
  assertEquals(
    decideBuildNotification({
      ...BASE,
      notifiedBuild: null,
      keyPredatesBuildTracking: true,
      keyUsedBefore: true,
    }),
    { notify: true, record: BASE.currentBuild },
    "an old key with an unrecorded listing gets one notification, then records",
  );
});

Deno.test("an old key that has never been used is still not notified", () => {
  // Age alone is not evidence of a cache. A key created in June and never used
  // until this very request cannot have a cached listing, so both signals have
  // to agree before a NULL is read as "stale".
  assertEquals(
    decideBuildNotification({
      ...BASE,
      notifiedBuild: null,
      keyPredatesBuildTracking: true,
      keyUsedBefore: false,
    }),
    { notify: false, record: null },
    "old but never used",
  );
});

Deno.test("the watershed is the deploy instant, not the end of that UTC day", () => {
  // Pinned as a literal, because this constant is the whole classifier and the
  // first version of it was ~10 hours late.
  //
  // An earlier version of this comment justified the placement with "production
  // `api_keys` holds no row at all between 14:05:00Z and 18:09:32Z". That was
  // false: six rows sit in that span (14:18:26.93, 14:36:09.10, 15:20:09.15,
  // 16:45:51.43, 16:52:46.61, 17:30:07.17), and one of them — `c91a0a13` at
  // 16:52:46.61Z, NULL and used — would flip classification if the line moved
  // past it. The genuinely empty interval is 14:02:59.21Z → 14:18:26.93Z, and
  // 14:05:00Z sits inside THAT.
  //
  // What actually licenses the value: the deploy is bounded to (13:27:59Z,
  // 14:19:06Z] by key data (`54f1a785` used 13:27:59Z with a NULL column,
  // `ed24fc8e` used 14:19:06Z carrying the real build id 07359906cb80), and
  // the only row created inside the worst-case lag window [14:05:00Z,
  // 14:19:06Z) is `ed24fc8e` itself, which has a build recorded and so never
  // reaches `predatesBuildTracking`. Rows misclassified in the SILENCING
  // direction: 0. See CARD_BUILD_TRACKING_SINCE.
  assertEquals(
    CARD_BUILD_TRACKING_SINCE,
    Date.parse("2026-09-16T14:05:00Z"),
    "the watershed must be the deploy instant",
  );
  assert(
    CARD_BUILD_TRACKING_SINCE < Date.parse("2026-09-17T00:00:00Z"),
    "the end-of-day value regenerates a misclassified cohort; see the constant",
  );
});

Deno.test("predatesBuildTracking splits keys at the deploy that started recording", () => {
  assert(predatesBuildTracking("2026-09-16T13:24:54Z"), "a pre-deploy key with a NULL column");
  assert(predatesBuildTracking("2026-09-16T14:04:44Z"), "the tracking commit's own instant");
  assert(predatesBuildTracking("2026-05-29T13:13:11Z"), "the oldest key that can authenticate");
  assert(
    !predatesBuildTracking(new Date(CARD_BUILD_TRACKING_SINCE).toISOString()),
    "the watershed itself is not before itself",
  );
  assert(!predatesBuildTracking("2026-09-20T00:00:00Z"), "a key created afterwards");
  // Two real production rows created HOURS after the deploy whose column is
  // still NULL, because their clients never made a `tools/list` and never made
  // a card-bearing `tools/call`. Under the end-of-day constant both are
  // classified as predating tracking and notified for a build that never moved.
  // (NOT because a token rotation minted them — rotation updates the existing
  // row in place. That was the falsified claim; see CARD_BUILD_TRACKING_SINCE.)
  assert(!predatesBuildTracking("2026-09-16T16:52:46Z"), "c91a0a13, 2h47m after the deploy");
  assert(
    !predatesBuildTracking("2026-09-16T18:09:32Z"),
    "cd74d874 — at 22:54Z the ONLY row the two candidate watersheds disagree on",
  );
  // The triage runner synthesises key rows with created_at: "" and the
  // introspection key is not a client at all. Unparseable input must take the
  // quiet side, not the notifying one.
  assert(!predatesBuildTracking(""), "empty created_at");
  assert(!predatesBuildTracking(null), "null created_at");
  assert(!predatesBuildTracking(undefined), "absent created_at");
  assert(!predatesBuildTracking("not a date"), "garbage created_at");
});

Deno.test("a post-deploy key with an empty cache is never told a build moved", () => {
  // End-to-end version of the boundary above, through the decision function.
  // `cd74d874` in production: created 18:09:32Z, four hours after the tracking
  // deploy, used repeatedly (last at 22:53:44Z), column still NULL because
  // nothing it called was a `tools/list` or a card-bearing `tools/call`. Under
  // the end-of-day constant both NULL-splitting conditions hold and it notifies
  // for a card that never changed. Under this one it stays quiet, which is
  // correct: its client has no cached listing to invalidate.
  assertEquals(
    decideBuildNotification({
      ...BASE,
      notifiedBuild: null,
      keyPredatesBuildTracking: predatesBuildTracking("2026-09-16T18:09:32Z"),
      keyUsedBefore: true,
    }),
    { notify: false, record: null },
    "a post-deploy key with a NULL column stays silent however often it is used",
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

Deno.test("a tools/list does not swallow another connection's invalidation", () => {
  // One KEY, several live connections (desktop plus web, two Claude Code
  // sessions, a reconnect while another session stays up) — and one column
  // between them. A tools/list used to overwrite the sentinel with the real
  // build id, silently, so connection B's listing consumed the invalidation
  // raised for connection A, and A kept rendering a card the user had just
  // hidden until it reconnected. The sentinel now survives a listing; only a
  // notification clears it.
  assertEquals(
    decideBuildNotification({
      ...BASE,
      method: "tools/list",
      notifiedBuild: CARD_LISTING_STALE,
    }),
    { notify: false, record: null },
    "connection B's tools/list leaves the sentinel alone",
  );
  // ...and connection A, arriving after it, still gets told.
  assertEquals(
    decideBuildNotification({ ...BASE, notifiedBuild: CARD_LISTING_STALE }),
    { notify: true, record: BASE.currentBuild },
    "connection A's card-bearing call still notifies",
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

Deno.test("the real build id is pinned to the shape the sentinel avoids", () => {
  // The invariant above was pinned from ONE side only: the sentinel was
  // asserted not to look like a build id, but nothing asserted that a build id
  // looks like a build id. A codegen change that shortened the fingerprint, or
  // emitted something non-hex, could have collided with the sentinel with every
  // test still green — and a build id equal to "stale" stops every
  // notification, silently, for everyone. Both sides are now pinned to the same
  // shape, so a collision cannot be introduced without failing here.
  assert(
    /^[0-9a-f]{12}$/.test(REVIEW_CARD_BUILD_ID),
    `REVIEW_CARD_BUILD_ID must be 12 lowercase hex, got ${REVIEW_CARD_BUILD_ID}`,
  );
  // Compared as widened strings: both are `const` literals, so TypeScript
  // rejects the direct comparison as provably false — which is the point, but
  // only for the values that happen to be checked in today. The runtime check
  // is what survives a codegen change.
  assert(
    String(REVIEW_CARD_BUILD_ID) !== String(CARD_LISTING_STALE),
    "the build id and the sentinel must never be the same string",
  );
});

// ---------------------------------------------------------------------------
// claimListingNotification — the compare-and-swap
// ---------------------------------------------------------------------------

/**
 * A fake `api_keys` table that behaves like the real UPDATE ... WHERE: the
 * predicate is evaluated against the value held AT RESOLUTION TIME, not at the
 * time the query was built, so several claims built from the same observed
 * value genuinely race.
 */
function fakeKeyTable(initial: string | null, failWith: string | null = null) {
  const state = { value: initial, writes: 0, attempts: 0, usedIsNull: false };
  const client: CardBuildClient = {
    from(table: string) {
      assertEquals(table, "api_keys", "the sentinel lives on api_keys");
      return {
        update(values: Record<string, unknown>) {
          const next = values["card_build_notified"] as string;
          let expected: string | null | undefined = undefined;
          let id: string | undefined = undefined;
          const builder: CardBuildUpdateBuilder = {
            eq(column: string, value: unknown) {
              if (column === "card_build_notified") expected = value as string;
              if (column === "id") id = String(value);
              return builder;
            },
            is(column: string, value: null) {
              if (column === "card_build_notified") {
                expected = value;
                state.usedIsNull = true;
              }
              return builder;
            },
            select(_columns: string) {
              return (async () => {
                await Promise.resolve();
                state.attempts++;
                if (failWith) return { data: null, error: { message: failWith } };
                assert(id !== undefined, "the claim must be scoped to one key");
                assert(expected !== undefined, "the claim must carry a compare predicate");
                if (state.value !== expected) return { data: [], error: null };
                state.value = next;
                state.writes++;
                return { data: [{ id }], error: null };
              })();
            },
          };
          return builder;
        },
      };
    },
  };
  return { client, state };
}

Deno.test("N concurrent card-bearing calls produce exactly ONE notification", async () => {
  // The "exactly once per change" claim was false: the record write was
  // fire-and-forget with no compare-and-swap, so three in-flight calls on one
  // stale key each read the sentinel, each decided to notify, and each wrote —
  // three notifications and three client re-listings for one change. The
  // UPDATE's own predicate is now the arbiter, and the count pinned here is 1.
  const { client, state } = fakeKeyTable(CARD_LISTING_STALE);
  const claims = await Promise.all(
    [0, 1, 2].map(() =>
      claimListingNotification(client, "key-1", CARD_LISTING_STALE, "bbbbbbbbbbbb")
    ),
  );
  assertEquals(claims.filter(Boolean).length, 1, "exactly one caller may notify");
  assertEquals(state.writes, 1, "and exactly one row write happens");
  assertEquals(state.attempts, 3, "all three did try");
  assertEquals(state.value, "bbbbbbbbbbbb", "the sentinel is consumed");
});

Deno.test("a claim against a null column compares with IS NULL, not =", async () => {
  // PostgREST's `eq` never matches NULL, so the pre-column-era key — the one
  // population that reads NULL and must still be notified — would never win its
  // own claim if this used `eq`.
  const { client, state } = fakeKeyTable(null);
  assertEquals(
    await claimListingNotification(client, "key-1", null, "bbbbbbbbbbbb"),
    true,
    "the null claim is won",
  );
  assert(state.usedIsNull, "must predicate with .is(col, null)");
  assertEquals(state.value, "bbbbbbbbbbbb", "and records the build");
});

Deno.test("a claim whose expected value has already moved is lost", async () => {
  const { client, state } = fakeKeyTable("cccccccccccc");
  assertEquals(
    await claimListingNotification(client, "key-1", CARD_LISTING_STALE, "bbbbbbbbbbbb"),
    false,
    "someone else already moved it",
  );
  assertEquals(state.writes, 0, "and nothing is written over their value");
  assertEquals(state.value, "cccccccccccc", "the other writer's value stands");
});

/** Capture console.warn for the length of one call. */
async function captureWarnings<T>(
  body: () => Promise<T>,
): Promise<{ result: T; warnings: unknown[][] }> {
  const original = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    return { result: await body(), warnings };
  } finally {
    console.warn = original;
  }
}

Deno.test("a failed claim notifies rather than swallowing the invalidation", async () => {
  // We cannot know whether the swap landed. Claiming it did would risk losing
  // the notification entirely, which is the failure this file exists to remove;
  // claiming it did not costs at most a repeated notification, answered by a
  // tools/list the client would have made at its next reconnect anyway.
  const { client } = fakeKeyTable(CARD_LISTING_STALE, "connection reset");
  const errored = await captureWarnings(() =>
    claimListingNotification(client, "key-1", CARD_LISTING_STALE, "bbbbbbbbbbbb")
  );
  assertEquals(errored.result, true, "an errored claim still notifies");

  const thrower: CardBuildClient = {
    from() {
      throw new Error("network down");
    },
  };
  const threw = await captureWarnings(() =>
    claimListingNotification(thrower, "key-1", null, "bbbbbbbbbbbb")
  );
  assertEquals(threw.result, true, "a thrown claim still notifies");
});

Deno.test("a failed claim is LOGGED, not swallowed", async () => {
  // Fail-open bounds the cost PER REQUEST, not over time. A PATCH that keeps
  // failing makes every card-bearing call on that key notify, forever, at
  // exactly twice the client's traffic — and the original code did that with
  // `if (error) return true;`, discarding error.message with no log at all. The
  // web-side invalidateCardListings warns for the same reason. An unobservable
  // permanent 2x amplification is the thing being prevented here.
  const { client } = fakeKeyTable(CARD_LISTING_STALE, "connection reset by peer");
  const { warnings } = await captureWarnings(() =>
    claimListingNotification(client, "key-1", CARD_LISTING_STALE, "bbbbbbbbbbbb")
  );
  assertEquals(warnings.length, 1, "exactly one warning");
  const body = JSON.stringify(warnings[0]);
  assert(body.includes("connection reset by peer"), `the PostgREST message survives: ${body}`);
  assert(body.includes("key-1"), `the key is identified: ${body}`);

  const thrower: CardBuildClient = {
    from() {
      throw new Error("network down");
    },
  };
  const thrown = await captureWarnings(() =>
    claimListingNotification(thrower, "key-2", null, "bbbbbbbbbbbb")
  );
  assertEquals(thrown.warnings.length, 1, "a throw is logged too");
  assert(
    JSON.stringify(thrown.warnings[0]).includes("network down"),
    "the thrown message survives",
  );
});

Deno.test("a stalled claim gives up on its deadline instead of holding the response", async () => {
  // The awaited claim sits AFTER routeMethod, and card-bearing tools include
  // email_compose, schedule, draft, email_delete, email_organize and
  // email_search_and_move — the mail is already sent, the messages are already
  // deleted. The Supabase client sets no custom fetch and no AbortSignal, so
  // without this a stalled PostgREST would hold that response until the edge
  // function's wall clock killed it and the client would see a failure for work
  // that succeeded.
  const stalled: CardBuildClient = {
    from() {
      const builder: CardBuildUpdateBuilder = {
        eq: () => builder,
        is: () => builder,
        // Never settles. If the deadline did not exist this test would hang.
        select: () => new Promise<never>(() => {}),
      };
      return { update: () => builder };
    },
  };

  const started = Date.now();
  const { result, warnings } = await captureWarnings(() =>
    claimListingNotification(stalled, "key-1", CARD_LISTING_STALE, "bbbbbbbbbbbb", 20)
  );
  const elapsed = Date.now() - started;

  assertEquals(result, true, "a timed-out claim falls open and notifies, like every other failure");
  assert(elapsed < 2000, `must give up on the deadline, took ${elapsed}ms`);
  assertEquals(warnings.length, 1, "and says so");
  assert(
    JSON.stringify(warnings[0]).includes("timeout"),
    `the warning names the timeout: ${JSON.stringify(warnings[0])}`,
  );
});

Deno.test("a claim that rejects before its deadline is logged as a FAILURE, not a throw", async () => {
  // This is what the fold before `Promise.race` actually buys, and it is the
  // only thing it buys.
  //
  // The claim it used to be asserted for was false: "Promise.race leaves the
  // loser unobserved, so a late rejection would be unhandled and would take the
  // isolate down". `Promise.race` attaches a reaction to EVERY entrant, so the
  // loser is observed whether or not anyone still awaits the race — deleting
  // the fold (`const settled = Promise.resolve(work);`) produces no unhandled
  // rejection at all, and the test that was named for it stayed green. A test
  // that passes with and without the thing it names constrains nothing.
  //
  // What the fold does change is classification, and this asserts it: with the
  // fold, a rejection that beats the deadline arrives as `{data: null, error}`
  // and is logged `card_build_claim_failed`; without it, it propagates out of
  // the await into the outer catch and is logged `card_build_claim_threw`.
  // A database failure should not be filed with the programming errors.
  const rejecting: CardBuildClient = {
    from() {
      const builder: CardBuildUpdateBuilder = {
        eq: () => builder,
        is: () => builder,
        select: () => Promise.reject(new Error("PostgREST said no")),
      };
      return { update: () => builder };
    },
  };

  const { result, warnings } = await captureWarnings(() =>
    claimListingNotification(rejecting, "key-1", null, "bbbbbbbbbbbb", 1000)
  );
  assertEquals(result, true, "fail open, as every failure here does");
  assertEquals(warnings.length, 1, "exactly one warning");
  const logged = JSON.stringify(warnings[0]);
  assert(
    logged.includes("card_build_claim_failed"),
    `a rejected claim is a database failure: ${logged}`,
  );
  assert(
    !logged.includes("card_build_claim_threw"),
    `and must NOT be filed as a programming error: ${logged}`,
  );
  assert(
    logged.includes("PostgREST said no"),
    `the message survives the fold: ${logged}`,
  );
});

Deno.test("a claim that rejects after its deadline is harmless", async () => {
  // The other half of the same mechanism: once the deadline has won, a
  // rejection arriving later must not disturb anything. It does not, with or
  // without the fold — see the test above for why the stronger claim that used
  // to be made here was wrong — but the ordering is worth pinning because it is
  // the one a stalled-then-failing PostgREST actually produces.
  let reject: ((err: unknown) => void) | undefined;
  const late: CardBuildClient = {
    from() {
      const builder: CardBuildUpdateBuilder = {
        eq: () => builder,
        is: () => builder,
        select: () =>
          new Promise<never>((_resolve, rej) => {
            reject = rej;
          }),
      };
      return { update: () => builder };
    },
  };

  const { result } = await captureWarnings(() =>
    claimListingNotification(late, "key-1", null, "bbbbbbbbbbbb", 10)
  );
  assertEquals(result, true, "the deadline wins");
  // Now fail the request the claim is no longer waiting for. An unobserved
  // rejection here is what would have killed the isolate.
  reject!(new Error("too late"));
  await new Promise((resolve) => setTimeout(resolve, 20));
});

Deno.test("the claim deadline is short enough to bound an already-sent email", async () => {
  // A primary-key UPDATE against PostgREST in the same region is single-digit
  // milliseconds, so this has ~two orders of magnitude of headroom and cannot
  // fire on ordinary slowness — while a stalled database can add at most this
  // much to a tool call that has already done its irreversible work.
  assertEquals(CARD_CLAIM_DEADLINE_MS, 1500, "the deadline is pinned deliberately");
  assert(CARD_CLAIM_DEADLINE_MS <= 2000, "must not approach any client's own timeout");
  assert(CARD_CLAIM_DEADLINE_MS >= 500, "must not fire on a merely slow round trip");

  // And it is the default, so a caller that passes nothing is still bounded.
  const { client } = fakeKeyTable(CARD_LISTING_STALE);
  assertEquals(
    await claimListingNotification(client, "key-1", CARD_LISTING_STALE, "bbbbbbbbbbbb"),
    true,
    "the default path still works end to end",
  );
});

// ---------------------------------------------------------------------------
// The sentinel's second home
// ---------------------------------------------------------------------------

// NOTE: this test touches the filesystem, so the suite must be run with
// --allow-read, and the drift checks below shell out to git, so it also needs
// --allow-run=git (CI runs `deno test --allow-read --allow-env --allow-run=git`,
// .github/workflows/ci.yml). Without the flags it fails with NotCapable rather
// than skipping, and that is deliberate: the same argument as
// utf7-copies.test.ts, a drift check that quietly does not run reads as green
// while the copies diverge.
Deno.test("the dashboard's copy of the sentinel agrees with this one", async () => {
  // The sentinel is written by two codebases: this Deno edge function, and the
  // Next.js routes that handle the card preference. They cannot import from one
  // another (an edge deploy bundles only supabase/functions/), so the value is
  // duplicated — and duplicated values in this repo are pinned by a drift test
  // rather than by convention. Before this, both web routes hardcoded 'stale'
  // as a literal and nothing related them to CARD_LISTING_STALE: renaming the
  // constant here would have left dashboard-initiated invalidation writing a
  // value the server no longer recognises, i.e. silently dead, with every test
  // still green.
  // repoRoot, not a second hand-rolled `.pathname` — that spelling is
  // percent-encoded and failed on a checkout under a path containing a space.
  const web = `${repoRoot}apps/web/src/lib/mcp/card-listing.ts`;
  const source = await Deno.readTextFile(web);
  const match = source.match(/export const CARD_LISTING_STALE = '([^']*)';/);
  assert(
    match !== null,
    `apps/web/src/lib/mcp/card-listing.ts no longer exports a CARD_LISTING_STALE literal`,
  );
  assertEquals(
    match![1],
    CARD_LISTING_STALE,
    "apps/web/src/lib/mcp/card-listing.ts and card-build-notify.ts have drifted",
  );

});

// ---------------------------------------------------------------------------
// Every writer goes through the constant
//
// This check had three holes, all of which let a hardcoded sentinel back in
// with the suite green, and all three are closed here.
//
//  1. The negative check was /card_build_notified:\s*['"`]/, which a writer
//     spelled `['card_build_notified']: 'stale'` — or with a space before the
//     colon — walks straight past. So the negative check now looks for a quoted
//     literal equal to the SENTINEL VALUE anywhere in the file, whatever the
//     property is spelled like, and it runs on the RAW source so no amount of
//     comment-stripping can hide one.
//  2. The positive check was `source.includes(...)` against the raw file, which
//     a COMMENT satisfies: delete the real write, leave a comment mentioning
//     it, green. So the positive check runs on the source with comments and
//     only comments removed.
//  3. Coverage was two hardcoded route paths, so a third writer added later was
//     simply not checked. Writers are now DISCOVERED by walking the source.
//
// The DISCOVERY was the real problem, and it was attacked five times. Every
// round it was a hand-maintained list of top-level roots, and every round a
// verifier found a tree that was not on it — `.jsx` under apps/web; then
// apps/web itself rather than app/ + src/; then the whole edge-function
// RUNTIME; then the other four edge functions plus packages/, scripts/,
// tools/, self-host/ and apps/mcp-app. The fifth round found six more, all
// reproduced GREEN on 2026-09-17 against the round-4 checker (1164 passed / 0
// failed here and 8/8 in the Node mirror, identical to the clean-tree control,
// with each probe live in the tree):
//
//   * `docs/` was not a root, and it is a live source tree —
//     docs/token-cost/measure.mjs is 213 lines of executable Node with a
//     shebang;
//   * the repo ROOT was not a root, so `./probe.ts` passed;
//   * `.sql` lived outside SQL_ROOTS in three places: supabase/tests/ (4 live
//     files), supabase/verify_rls_production.sql sitting directly beside
//     functions/ and migrations/, and docs/usage-based-pricing/*.sql;
//   * a symlinked DIRECTORY inside a walked root was invisible, because
//     `Dirent.isDirectory()` and Deno's `DirEntry.isDirectory` are both lstat
//     semantics: such an entry is neither recursed into nor extension-matched,
//     so it fell through both branches silently;
//   * `packages/mcpemails/fixtures.test.helper.ts` was skipped by the
//     `!/\.test\./` filter — precisely the fixture-a-refactor-promotes-to-real-
//     code case, and the name never has to change;
//   * out/ and build/ are gitignored but were NOT skipped (only node_modules
//     and dot-prefixed names were), so a bundle emitted there could be read and
//     FALSE-FAIL on a bundled 'stale'.
//   * and one the fifth round did not name: the walk skipped every entry whose
//     NAME starts with a dot, which excluded apps/web/app/.well-known/ — SEVEN
//     live Next.js route handlers, four of them the OAuth metadata routes. A
//     writer planted there passed 1164/0 and 8/8 on 2026-09-17. That skip is
//     also exactly how the 623-file figure reconciles: 623 tracked source files
//     sit under the old roots once .test.-named files and dot-prefixed paths are
//     removed, and the new list is 759.
//
// So the root list is gone, and nothing replaces it. The file list is
// `git ls-files --cached --others --exclude-standard`, which IS the repo:
// every tracked file, plus every untracked file the repo does not ignore. That
// closes all six at once and permanently. node_modules/, .next/, out/, build/
// and .claude/ are excluded by the repo's own .gitignore instead of by a second
// hand-maintained list; git does not descend a symlinked directory, so a
// symlink's target is enumerated at its real path or not at all; and a new
// top-level directory is covered the day it is committed, by someone who has
// never heard of this file. `--others` keeps the property the filesystem walk
// had, that an uncommitted writer is still caught.
//
// The `.test.` skip went with it: a filename-shaped skip is the same mistake one
// level down. Every source file is read now, and the four files ALLOWED to
// contain a bare sentinel literal are listed by path in SENTINEL_EXEMPT — the
// two modules that declare the constant, and these two drift checks, which
// quote every evasion they pin.
//
// SQL is checked too, because the sentinel IS a database value and a migration
// or PL/pgSQL function is a plausible writer no TypeScript walk can see. That
// check used to be shape-matching — `set card_build_notified = '…'` and a DDL
// `default '…'`, over a source with SQL comments stripped — and it was defeated
// in its own home directory: one planted migration under supabase/migrations/
// carried three real writes and passed both suites. Ten assignment shapes
// passed in all: `$$stale$$` and `$tag$stale$tag$`, `INSERT … VALUES`,
// `ON CONFLICT DO UPDATE SET … = excluded.…`, a PL/pgSQL `:=` through a
// variable, a trigger's `NEW.col :=`, MIXED CASE (unquoted SQL identifiers are
// case-insensitive; the `includes()` early return was not, so such a file was
// never even considered), `CASE WHEN … THEN 'stale'`,
// `EXECUTE format('… = %L', 'stale')`, and `concat('sta','le')` / `chr(115)||…`.
//
// The comment stripper was broken in both directions on top of that. False
// pass: a `--` inside a string literal ate the rest of the line, write included
// (`set note = 'a -- b', card_build_notified = 'stale'`). False FAILURE, twice,
// which defeats the stripper's own stated purpose of not tripping over
// `comment on column`: documenting the forbidden shape in the column comment
// turned the suite RED, both as `… is 'do not write: set card_build_notified =
// ''stale'''` and as `… is 'never give this column a default ''stale'''`. And
// PostgreSQL NESTS block comments while `/\/\*[\s\S]*?\*\//` stops at the first
// `*/`, so `/* outer /* inner */ update … 'stale'; */` — entirely a comment to
// PostgreSQL — was a third false failure, not the false pass it looks like.
//
// Every fix for those is a step toward a SQL parser, which is how this checker's
// TypeScript half acquired its own documented-not-closed evasions. So the rule
// is blunt and the stripper is DELETED: no `.sql` file may NAME
// `card_build_notified` at all, case-insensitively, except the two migrations in
// SQL_ALLOWED. There is no shape to evade, because nothing but the identifier is
// matched. The value does not enter into it, which also catches a migration
// writing this column some value OTHER than the sentinel — the same drift, and
// invisible to any quoted-'stale' rule. The one false-failure mode is a
// migration that genuinely has to touch the column, and the fix is a one-line
// SQL_ALLOWED edit with a reason beside it.
//
// Two evasions are still DOCUMENTED rather than closed on the TypeScript side,
// because closing them means parsing rather than matching: a column name
// assembled from fragments (`['card_build' + '_notified']`) is invisible to a
// check keyed on the literal column name, and a sentinel value assembled from
// fragments (`'sta' + 'le'`) is invisible to the quoted-literal check. Both look
// deliberate enough that a reviewer would stop them, which is not true of a
// `.jsx` file. The SQL rule above has no such gap, because it matches the
// identifier and nothing else.
//
// The checker is pinned against synthetic evasions below: a check asserted only
// against files that already pass proves nothing about what it rejects.
//
// The twin of all of this lives in apps/web/src/lib/mcp/card-listing.test.ts —
// duplicated for the same reason the constant is, since the two runtimes cannot
// import from one another.
// ---------------------------------------------------------------------------

/**
 * Remove `//` and block comments, leaving string and template literals intact.
 *
 * Deliberately not a parser: it does not know regex literals, so a regex
 * containing an unbalanced quote would confuse it. Neither web writer contains
 * one, and the failure mode is a FALSE FAILURE on the positive check (the write
 * it is looking for gets eaten), never a false pass — the negative check runs
 * on the raw source precisely so that it cannot be fooled this way.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (quote !== null) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Everything wrong with one file that writes `card_build_notified`. */
function sentinelWriterProblems(source: string): string[] {
  const code = stripComments(source);
  // A file that only MENTIONS the column in prose is not a writer.
  if (!code.includes("card_build_notified")) return [];

  const problems: string[] = [];
  // Whitespace-tolerant: prettier is free to break this property across lines
  // (`card_build_notified:\n  CARD_LISTING_STALE`) and a substring match would
  // then FALSE-FAIL on a correct writer, which teaches people to delete the
  // check. The negative check below is what has to be strict.
  if (!/card_build_notified\s*:\s*CARD_LISTING_STALE\b/.test(code)) {
    problems.push("does not write `card_build_notified: CARD_LISTING_STALE` in code");
  }
  if (!code.includes("CARD_LISTING_STALE")) {
    problems.push("does not reference the shared constant at all");
  }
  // Raw source, any quoting, anywhere: the only legitimate place for a literal
  // equal to the sentinel is the module that declares the constant.
  const literal = new RegExp(`['"\`]${CARD_LISTING_STALE}['"\`]`);
  if (literal.test(source)) {
    problems.push(`hardcodes a ${JSON.stringify(CARD_LISTING_STALE)} literal`);
  }
  return problems;
}

/**
 * Every extension a module in this repo can be written in. `.jsx` and `.cjs`
 * were the gap: `.jsx` is live under apps/web (46 files) and a `.jsx` writer
 * passed the whole suite before this list was widened.
 */
const SOURCE_EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** `.sql` has its own, blunter rule — see `sqlSentinelProblems`. */
const SQL_EXTENSION = /\.sql$/;

/**
 * mcp-server/ -> functions/ -> supabase/ -> repo root.
 *
 * `URL.pathname` is percent-ENCODED, so a checkout under a path with a space
 * ("/Users/me/My Repos/...") yielded `/Users/me/My%20Repos/...` — a directory
 * that does not exist, which turned both the `git ls-files` cwd and every
 * `readTextFileSync` into a failure on a perfectly correct tree. The twin in
 * apps/web/src/lib/mcp/card-listing.test.ts never had this, because Node's
 * `fileURLToPath` decodes; this is the same decode.
 */
const repoRoot = `${decodeURIComponent(new URL(".", import.meta.url).pathname)}../../../`;

/**
 * Every file in the repo, repo-relative, from git.
 *
 * This replaces a hand-maintained list of top-level roots that was defeated in
 * five straight rounds. `git ls-files` cannot be defeated by putting a file
 * somewhere new, because "somewhere new" is still in the repo — and the repo's
 * own .gitignore, not a second list, is what keeps node_modules/, .next/, out/,
 * build/ and .claude/ out.
 *
 * This is why the suite is run with `--allow-run=git`. Withholding permissions
 * from this suite is deliberate elsewhere (see the CI job's note on --allow-net),
 * so it is worth being explicit: the grant is one binary, it is read-only, and
 * the alternative is re-implementing .gitignore semantics in this file, which is
 * the same parser-in-regex mistake one directory over.
 *
 * Failing to run git THROWS. A discovery step that quietly finds nothing reads
 * as green, which is exactly how this check kept being wrong.
 */
let cachedRepoFiles: string[] | null = null;
function repoFiles(): string[] {
  if (cachedRepoFiles) return cachedRepoFiles;
  let stdout: Uint8Array;
  try {
    // --cached: tracked. --others --exclude-standard: untracked and not
    // ignored, which keeps the filesystem walk's property that a writer is
    // caught before anyone commits it. -z: paths with spaces or newlines.
    const result = new Deno.Command("git", {
      args: ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      cwd: repoRoot,
    }).outputSync();
    if (!result.success) {
      throw new Error(new TextDecoder().decode(result.stderr).trim());
    }
    stdout = result.stdout;
  } catch (cause) {
    throw new Error(
      `the sentinel drift check could not run \`git ls-files\` in ${repoRoot}; ` +
        "it needs a git checkout and --allow-run=git to know what the repo contains",
      { cause },
    );
  }
  const files = new TextDecoder().decode(stdout).split("\0").filter((p) => p !== "");
  assert(files.length > 0, `git listed no files under ${repoRoot}`);
  cachedRepoFiles = files;
  return files;
}

/** The repo files with one of these extensions, repo-relative. */
function repoFilesMatching(match: RegExp): string[] {
  return repoFiles().filter((p) => match.test(p));
}

/**
 * Read one repo-relative path.
 *
 * A path git listed that cannot be read — a symlink pointing at a directory, a
 * staged deletion — is a LOUD failure NAMING the file, never a silent skip. The
 * bare errno does not say which file it was.
 */
function readRepoFile(path: string): string {
  try {
    return Deno.readTextFileSync(`${repoRoot}${path}`);
  } catch (cause) {
    throw new Error(`the sentinel drift check could not read ${path}`, { cause });
  }
}

/**
 * The only files allowed to contain a bare sentinel literal.
 *
 * The first two DECLARE the constant, one per runtime. The last two are these
 * drift checks themselves, which quote every evasion they pin. They used to be
 * excluded by a `!/\.test\./` filename filter, which also excluded
 * `fixtures.test.helper.ts` — a fixture a refactor promotes to real code
 * without the name ever changing. A path list cannot make that mistake.
 */
const SENTINEL_EXEMPT = new Set([
  "apps/web/src/lib/mcp/card-listing.ts",
  "apps/web/src/lib/mcp/card-listing.test.ts",
  "supabase/functions/mcp-server/card-build-notify.ts",
  "supabase/functions/mcp-server/card-build-notify.test.ts",
  // Generated, wholesale, by `npm run gen:types` from the live schema. It names
  // EVERY column in the database, so it necessarily names this one; it declares
  // types and writes nothing. It is exempt for the same reason the two
  // migrations are allow-listed rather than rewritten: naming a column is not
  // writing it. This entry appeared only once the types were regenerated — the
  // check was written against a stale file that did not yet know the column
  // existed, which is why no single branch could have caught it.
  "apps/web/src/types/database.types.ts",
]);

/**
 * The only `.sql` files allowed to NAME `card_build_notified`.
 *
 * One creates the column and one re-comments it; neither writes it. Adding a
 * path here is the only way to make a migration that touches this column pass,
 * and it should carry a reason.
 */
const SQL_ALLOWED = new Set([
  "supabase/migrations/20260916160000_card_build_notified.sql",
  "supabase/migrations/20260916180000_card_build_notified_comment.sql",
]);

/**
 * Everything wrong with one `.sql` file.
 *
 * Not a shape match and not a value match: NAMING the column is the problem,
 * because SQL cannot import `CARD_LISTING_STALE` and therefore has no correct
 * way to write this column at all. Case-insensitive, because unquoted SQL
 * identifiers are — a `NEW.CARD_BUILD_NOTIFIED := 'stale'` trigger slipped the
 * old check on nothing more than that.
 *
 * There is no comment stripper any more, and no double-dash, block-comment,
 * dollar-quote or string-literal awareness, because nothing needs protecting:
 * a `comment on column` inside one of the two allow-listed migrations passes on
 * its PATH, whatever it says, and the same text in any other `.sql` file is a
 * new file touching this column, which is exactly what should be reviewed.
 */
function sqlSentinelProblems(path: string, source: string): string[] {
  if (SQL_ALLOWED.has(path)) return [];
  if (!/card_build_notified/i.test(source)) return [];
  return [
    "names card_build_notified. SQL cannot import CARD_LISTING_STALE, so no " +
      ".sql file may read or write this column — write it from TypeScript. If a " +
      "migration genuinely has to touch it, add its path to SQL_ALLOWED in this " +
      "test, with a reason.",
  ];
}

Deno.test("every writer of the sentinel goes through the constant", () => {
  // The whole repo, from git. There is no root list to be outside of.
  const writers: string[] = [];
  for (const path of repoFilesMatching(SOURCE_EXTENSIONS)) {
    if (SENTINEL_EXEMPT.has(path)) continue;
    const source = readRepoFile(path);
    if (!source.includes("card_build_notified")) continue;
    writers.push(path);
    const problems = sentinelWriterProblems(source);
    assert(problems.length === 0, `${path}: ${problems.join("; ")}`);
  }

  // A discovery step that silently found nothing would read as green. All
  // THREE writers must be among what was found — the third, the edge
  // function's own invalidateCardListings(), is the one that gets left out of
  // "both dashboard routes" and the one a web-rooted walk structurally could
  // not reach.
  for (
    const known of [
      "apps/web/app/api/inboxes/[id]/route.ts",
      "apps/web/app/api/workspaces/[id]/route.ts",
      "supabase/functions/mcp-server/index.ts",
    ]
  ) {
    assert(
      writers.includes(known),
      `the discovery step missed ${known}; it found ${writers.length} file(s)`,
    );
  }

  // And the exemption list must not rot into a set of paths that no longer
  // exist, which would quietly stop excusing anything while looking deliberate.
  const all = new Set(repoFiles());
  for (const exempt of SENTINEL_EXEMPT) {
    assert(all.has(exempt), `SENTINEL_EXEMPT lists ${exempt}, which is not in the repo`);
  }
});

Deno.test("no SQL names the sentinel column outside the two migrations that own it", () => {
  // The column is a database value, so a migration or PL/pgSQL function is a
  // plausible writer no TypeScript walk can see. The rule is not "must not
  // assign a quoted literal" any more — ten assignment shapes beat that — it is
  // "must not name the column", with two migrations allow-listed by path.
  const named: string[] = [];
  for (const path of repoFilesMatching(SQL_EXTENSION)) {
    const source = readRepoFile(path);
    if (/card_build_notified/i.test(source)) named.push(path);
    const problems = sqlSentinelProblems(path, source);
    assert(problems.length === 0, `${path}: ${problems.join("; ")}`);
  }

  // Anti-silence and anti-rot in one: each allow-listed path must actually be
  // in the repo AND actually still name the column. An allow-list entry for a
  // deleted or rewritten migration is a hole nobody would notice.
  for (const allowed of SQL_ALLOWED) {
    assert(
      named.includes(allowed),
      `SQL_ALLOWED lists ${allowed}, which the enumeration did not find naming ` +
        `the column; it found ${named.length} file(s) that do. Is the allow-list stale?`,
    );
  }
});

Deno.test("the SQL rule is a path allow-list, not a shape match", () => {
  const other = "supabase/migrations/29990101000000_new.sql";
  const owned = "supabase/migrations/20260916180000_card_build_notified_comment.sql";
  const red = (sql: string) => sqlSentinelProblems(other, sql).length > 0;

  // The ten assignment shapes that passed the old shape-matching rule, each
  // reproduced green on 2026-09-17 as a live migration under
  // supabase/migrations/ — the checker's own home directory.
  assert(
    red("update public.api_keys set card_build_notified = $$stale$$ where id = p_key;"),
    "dollar-quoting must be rejected",
  );
  assert(
    red("update public.api_keys set card_build_notified = $tag$stale$tag$ where id = $1;"),
    "tagged dollar-quoting must be rejected",
  );
  assert(
    red("insert into public.api_keys (id, card_build_notified) values ($1, 'stale');"),
    "INSERT ... VALUES must be rejected",
  );
  assert(
    red(
      "insert into public.api_keys (id, card_build_notified) values ($1, 'stale')\n" +
        "on conflict (id) do update set card_build_notified = excluded.card_build_notified;",
    ),
    "ON CONFLICT DO UPDATE SET ... = excluded... must be rejected",
  );
  assert(
    red("v := 'stale';\nupdate public.api_keys set card_build_notified = v;"),
    "a PL/pgSQL := through a variable must be rejected",
  );
  assert(
    red("NEW.card_build_notified := 'stale';"),
    "a trigger's NEW.col := must be rejected",
  );
  assert(
    red("NEW.CARD_BUILD_NOTIFIED := 'stale';"),
    "MIXED CASE must be rejected: unquoted SQL identifiers are case-insensitive, " +
      "and the old includes() early return was not, so such a file was never considered",
  );
  assert(
    red("update public.api_keys set card_build_notified = case when true then 'stale' end;"),
    "CASE WHEN ... THEN must be rejected",
  );
  assert(
    red("execute format('update public.api_keys set card_build_notified = %L', 'stale');"),
    "EXECUTE format(... %L ...) must be rejected",
  );
  assert(
    red("update public.api_keys set card_build_notified = concat('sta', 'le');"),
    "a value assembled from fragments must be rejected; no rule keyed on a quoted " +
      "sentinel can see this one, which is why the value does not enter into it at all",
  );
  assert(
    red("update public.api_keys set card_build_notified = chr(115)||chr(116);"),
    "chr() assembly must be rejected for the same reason",
  );

  // Both directions the deleted comment stripper was broken in.
  assert(
    red("update public.api_keys set note = 'a -- b', card_build_notified = 'stale';"),
    "a double dash inside a string literal used to eat the write; there is no stripper now",
  );
  assert(
    red("/* outer /* inner */ update public.api_keys set card_build_notified = 'stale'; */"),
    "PostgreSQL nests block comments and the stripper did not; the nesting made this a " +
      "false FAILURE rather than the false pass it looks like. Either way a new .sql " +
      "file naming this column is reviewable, so it is rejected on the name alone",
  );

  // And a value OTHER than the sentinel, which is the same drift and which no
  // quoted-'stale' rule could ever see.
  assert(
    red("update public.api_keys set card_build_notified = 'abc123456789';"),
    "writing this column any value at all from SQL must be rejected",
  );

  // The two false FAILURES the stripper produced, both now green, because the
  // path is what excuses them and the two live migrations are on the list.
  assertEquals(
    sqlSentinelProblems(
      owned,
      "comment on column public.api_keys.card_build_notified is\n" +
        "  'do not write: set card_build_notified = ''stale''';",
    ),
    [],
    "documenting the forbidden shape in the column comment must not turn the suite red",
  );
  assertEquals(
    sqlSentinelProblems(
      owned,
      "comment on column public.api_keys.card_build_notified is\n" +
        "  'never give this column a default ''stale''; TypeScript owns the write.';",
    ),
    [],
    "and neither must documenting the DDL half of it",
  );

  // A `.sql` file that does not name the column is not the SQL rule's business,
  // wherever it lives and whatever it quotes.
  assertEquals(
    sqlSentinelProblems(other, "update public.api_keys set note = 'stale';"),
    [],
    "the rule is keyed on the column, not on the word",
  );
});

Deno.test("the writer check rejects the evasions the old one allowed", () => {
  const ok = [
    "import { CARD_LISTING_STALE } from '@/lib/mcp/card-listing';",
    "await db.from('api_keys').update({ card_build_notified: CARD_LISTING_STALE });",
  ].join("\n");
  assertEquals(sentinelWriterProblems(ok), [], "the real shape passes");

  // Gap 1: bracket notation. The old negative check was keyed on the property
  // name followed by a colon and a quote; this spelling has the quote first.
  assert(
    sentinelWriterProblems(
      `${ok}\nawait db.from('api_keys').update({ ['card_build_notified']: 'stale' });`,
    ).length > 0,
    "bracket-notation literal must be rejected",
  );

  // Gap 1 again: a single space before the colon defeats /card_build_notified:/.
  assert(
    sentinelWriterProblems(
      "import { CARD_LISTING_STALE } from '@/lib/mcp/card-listing';\n" +
        "await db.update({ card_build_notified : 'stale' });",
    ).length > 0,
    "a space before the colon must be rejected",
  );

  // Gap 2: a comment satisfying the positive check while the real write is gone.
  assert(
    sentinelWriterProblems(
      "// we write card_build_notified: CARD_LISTING_STALE here\n" +
        "const x = { card_build_notified: buildId };",
    ).length > 0,
    "a comment must not satisfy the positive check",
  );
  assert(
    sentinelWriterProblems(
      "/* card_build_notified: CARD_LISTING_STALE */\n" +
        "const x = { card_build_notified: buildId };",
    ).length > 0,
    "a block comment must not satisfy it either",
  );

  // And a file that merely names the column in prose is not a writer at all.
  assertEquals(
    sentinelWriterProblems("// card_build_notified is set by the edge function.\n"),
    [],
    "prose-only mentions are not writers",
  );

  // The positive check must survive a formatter. `card_build_notified:` and
  // `CARD_LISTING_STALE` on separate lines is what prettier produces when the
  // surrounding expression gets long enough, and a substring match FALSE-FAILED
  // on it — a check that fails on correct code is a check people delete.
  assertEquals(
    sentinelWriterProblems(
      "import { CARD_LISTING_STALE } from '@/lib/mcp/card-listing';\n" +
        "await db.from('api_keys').update({\n" +
        "  card_build_notified:\n" +
        "    CARD_LISTING_STALE,\n" +
        "});",
    ),
    [],
    "a prettier line break between the key and the constant is still a real write",
  );
  assertEquals(
    sentinelWriterProblems(
      "import { CARD_LISTING_STALE } from '@/lib/mcp/card-listing';\n" +
        "await db.update({ card_build_notified : CARD_LISTING_STALE });",
    ),
    [],
    "a space before the colon is still a real write",
  );

  // Documented, NOT closed: fragments defeat both halves. Pinned so the gap is
  // visible rather than folklore — if either of these ever starts being caught,
  // the checker grew a parser and this test should be updated deliberately.
  assertEquals(
    sentinelWriterProblems(
      "const k = 'card_build' + '_notified';\nawait db.update({ [k]: 'stale' });",
    ),
    [],
    "a column name assembled from fragments is invisible: the file never " +
      "contains the literal 'card_build_notified', so it is not even a writer",
  );
  assert(
    sentinelWriterProblems(
      "const v = 'sta' + 'le';\nawait db.update({ card_build_notified: v });",
    ).every((p) => !p.includes("hardcodes")),
    "a sentinel VALUE assembled from fragments slips the quoted-literal check " +
      "(it is still caught by the positive check, which is the backstop)",
  );
});

Deno.test("the file list is git's, not a hand-maintained root list", () => {
  for (const name of ["x.ts", "x.tsx", "x.mts", "x.cts", "x.js", "x.jsx", "x.mjs", "x.cjs"]) {
    assert(SOURCE_EXTENSIONS.test(name), `${name} must be checked`);
  }
  assert(!SOURCE_EXTENSIONS.test("x.json"), "data files are not sources");
  assert(!SOURCE_EXTENSIONS.test("x.css"), "stylesheets are not sources");
  assert(!SOURCE_EXTENSIONS.test("x.sql"), "SQL has its own rule");
  assert(SQL_EXTENSION.test("x.sql"), "and that rule must actually see .sql");

  const files = repoFiles();
  const has = (p: string) => files.includes(p);

  // The six holes the fifth round found, each pinned against a file that is
  // really there rather than against a directory name.
  assert(
    has("docs/token-cost/measure.mjs"),
    "docs/ is a live source tree (213 lines of executable Node here) and was not a root",
  );
  assert(
    files.some((f) => !f.includes("/")),
    "the repo ROOT itself must be in the list; ./probe.ts passed before",
  );
  assert(
    has("supabase/tests/usage_based_pricing.sql"),
    "supabase/tests/ holds live .sql and was outside SQL_ROOTS",
  );
  assert(
    has("supabase/verify_rls_production.sql"),
    "this .sql sits directly beside functions/ and migrations/ and was outside SQL_ROOTS",
  );
  assert(
    has("docs/usage-based-pricing/internal-reports.sql"),
    "docs/ holds live .sql too",
  );
  assert(
    has("apps/web/app/.well-known/oauth-protected-resource/route.ts"),
    "a dot-prefixed DIRECTORY is not a hidden file: the old walk skipped every " +
      "entry whose name starts with a dot and lost seven live route handlers here",
  );
  assert(
    has("supabase/functions/mcp-server/card-build-notify.test.ts"),
    "test files are in the list now; SENTINEL_EXEMPT excuses them by path, not a " +
      "filename pattern, so fixtures.test.helper.ts is checked",
  );
  // Symlinked directories: git does not descend them, so a symlink cannot hide a
  // tree. Its contents are enumerated at their real path, or they are not in the
  // repo at all. There is nothing to assert about the symlink itself.

  // .gitignore does the excluding, so there is no second hand-maintained list.
  assert(
    !files.some((f) => f.includes("node_modules/")),
    "node_modules must be excluded — by .gitignore, not by a skip list",
  );
  assert(
    !files.some((f) => f.startsWith(".claude/")),
    ".claude/ (worktrees and local config) must be excluded the same way",
  );

  // Everything the four earlier rounds had to widen the roots to reach, still
  // reached — now for free, because none of it is a root any more.
  for (
    const path of [
      "apps/web/proxy.ts",
      "apps/web/app/invite/[token]/InviteAcceptUI.jsx",
      "supabase/functions/mcp-server/index.ts",
    ]
  ) {
    assert(has(path), `the list must reach ${path}`);
  }
  for (
    const tree of [
      "apps/web/components/",
      "supabase/functions/gmail-token-refresh/",
      "supabase/functions/outlook-token-refresh/",
      "supabase/functions/synthetic-monitor/",
      "supabase/functions/system-notify/",
      "apps/mcp-app/",
      "packages/",
      "scripts/",
      "self-host/",
      "tools/",
    ]
  ) {
    assert(files.some((f) => f.startsWith(tree)), `the list must reach ${tree}`);
  }
});

Deno.test("stripComments leaves string literals alone", () => {
  assertEquals(
    stripComments("const a = 'http://x//y'; // gone\nconst b = 1;"),
    "const a = 'http://x//y'; \nconst b = 1;",
    "a URL inside a string survives; the trailing comment does not",
  );
  assertEquals(
    stripComments("const a = \"it's /* not */ a comment\";"),
    "const a = \"it's /* not */ a comment\";",
    "comment markers inside a string survive",
  );
  assertEquals(stripComments("a/* x */b"), "ab", "block comments are removed");
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
