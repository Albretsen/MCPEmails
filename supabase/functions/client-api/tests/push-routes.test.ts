// The /push routes through the real router: who may call what, what is
// validated before it is stored, and that the dispatcher is reachable with the
// dispatch secret and with nothing else.

import { assert, assertEquals } from "jsr:@std/assert@1";
import type { DispatchSummary } from "../push/dispatch.ts";
import { deviceLabel, MAX_SUBSCRIPTIONS_PER_USER, timingSafeEqual } from "../push/routes.ts";
import { RateLimiter } from "../rate-limit.ts";
import {
  fakeSeam,
  fakeStore,
  INBOX_ID,
  membership,
  mintHs256,
  ok,
  OTHER_USER_ID,
  request,
  SECOND_INBOX_ID,
  testApp,
  USER_ID,
  WORKSPACE_ID,
} from "./helpers.ts";
import { browserKeys, fakePushStore, fakeSender } from "./push-fakes.ts";

const DISPATCH_SECRET = "dispatch-secret-for-tests-0123456789";
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/browser-one";
const token = await mintHs256();
const otherToken = await mintHs256({ sub: OTHER_USER_ID, email: "other@client-api-test.example" });

const SUMMARY: DispatchSummary = {
  leased: 3,
  checked: 3,
  arrivals: 1,
  notified: 1,
  pushes_sent: 2,
  pushes_failed: 0,
  subscriptions_gone: 0,
  failed: 0,
  skipped_reconnect: 0,
  deferred: 0,
  ms: 12,
};

function rig(options: { sender?: ReturnType<typeof fakeSender> | null; secret?: string | null; rows?: ReturnType<typeof membership>[]; limiter?: RateLimiter } = {}) {
  const pushStore = fakePushStore();
  const sender = options.sender === undefined ? fakeSender() : options.sender;
  const seam = fakeSeam();
  seam.respond = (call) =>
    call.tool === "inbox_list"
      ? ok({
        inboxes: [INBOX_ID, SECOND_INBOX_ID].map((id, i) => ({
          inbox_id: id,
          email_address: `box${i}@client-api-test.example`,
          display_name: `Box ${i}`,
          provider: "imap",
          sender_identities: [],
        })),
      })
      : ok({});
  let dispatches = 0;
  const secret = options.secret === undefined ? DISPATCH_SECRET : options.secret;
  const app = testApp({
    seam,
    store: fakeStore(options.rows ?? [membership()]),
    limiter: options.limiter,
    env: (name) => (name === "DISPATCH_SECRET" ? secret ?? undefined : undefined),
    push: {
      store: pushStore,
      sender,
      dispatch: () => {
        dispatches++;
        return Promise.resolve(SUMMARY);
      },
    },
  });
  return { ...app, pushStore, sender, dispatches: () => dispatches };
}

async function subscription(endpoint = ENDPOINT) {
  return { endpoint, expirationTime: null, keys: await browserKeys() };
}

// ── subscribe / unsubscribe ─────────────────────────────────────────────────

Deno.test("subscribe: stores the endpoint and keys for the caller and their workspace, with a device label", async () => {
  const r = rig();
  const sub = await subscription();
  const response = await r.handle(request("/push/subscribe", {
    token,
    body: { subscription: sub },
    headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" },
  }));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { subscribed: true });
  assertEquals(r.pushStore.subs.length, 1);
  const row = r.pushStore.subs[0];
  assertEquals([row.user_id, row.workspace_id, row.endpoint, row.p256dh, row.auth], [USER_ID, WORKSPACE_ID, ENDPOINT, sub.keys.p256dh, sub.keys.auth]);
  assertEquals(row.user_agent, "Chrome on macOS");
});

Deno.test("subscribe: the same browser again is one row; another person on that browser takes the row over", async () => {
  const r = rig({ rows: [membership()] });
  const sub = await subscription();
  for (let i = 0; i < 2; i++) await (await r.handle(request("/push/subscribe", { token, body: { subscription: sub } }))).body?.cancel();
  assertEquals(r.pushStore.subs.length, 1);
  await (await r.handle(request("/push/subscribe", { token: otherToken, body: { subscription: sub } }))).body?.cancel();
  assertEquals(r.pushStore.subs.length, 1);
  assertEquals(r.pushStore.subs[0].user_id, OTHER_USER_ID);
});

Deno.test("subscribe: an endpoint that is not a browser push service is refused and nothing is stored", async () => {
  const r = rig();
  const keys = await browserKeys();
  for (const endpoint of [
    "https://attacker.example/collect",
    "http://fcm.googleapis.com/fcm/send/x",
    "https://127.0.0.1:8080/x",
    "https://swvaxorwumispmjaaszb.supabase.co/rest/v1/inboxes",
    "",
    null,
  ]) {
    const response = await r.handle(request("/push/subscribe", { token, body: { subscription: { endpoint, keys } } }));
    assertEquals(response.status, 400, String(endpoint));
    assertEquals((await response.json()).error.code, "invalid_request");
  }
  assertEquals(r.pushStore.subs.length, 0);
});

Deno.test("subscribe: malformed keys and a missing subscription are refused", async () => {
  const r = rig();
  const good = await subscription();
  for (const body of [
    {},
    { subscription: "x" },
    { subscription: { endpoint: ENDPOINT } },
    { subscription: { endpoint: ENDPOINT, keys: { p256dh: "short", auth: good.keys.auth } } },
    { subscription: { endpoint: ENDPOINT, keys: { p256dh: good.keys.p256dh, auth: "AAAA" } } },
  ]) {
    const response = await r.handle(request("/push/subscribe", { token, body }));
    assertEquals(response.status, 400);
    await response.body?.cancel();
  }
  assertEquals(r.pushStore.subs.length, 0);
});

Deno.test("subscribe: a per-person cap on devices", async () => {
  const r = rig();
  for (let n = 0; n < MAX_SUBSCRIPTIONS_PER_USER; n++) {
    await r.pushStore.upsertSubscription({ userId: USER_ID, workspaceId: WORKSPACE_ID, endpoint: `${ENDPOINT}-${n}`, ...(await browserKeys()), userAgent: null });
  }
  const over = await r.handle(request("/push/subscribe", { token, body: { subscription: await subscription() } }));
  assertEquals(over.status, 409);
  assertEquals((await over.json()).error.tool_code, "push_subscription_limit");
  // Re-registering one that already exists is still fine.
  const again = await r.handle(request("/push/subscribe", { token, body: { subscription: await subscription(`${ENDPOINT}-3`) } }));
  assertEquals(again.status, 200);
  await again.body?.cancel();
});

Deno.test("subscribe and test answer 503 when the VAPID keys are not set; preferences say so", async () => {
  const r = rig({ sender: null });
  const sub = await r.handle(request("/push/subscribe", { token, body: { subscription: await subscription() } }));
  assertEquals(sub.status, 503);
  assertEquals((await sub.json()).error.tool_code, "push_not_configured");
  const test = await r.handle(request("/push/test", { token, body: {} }));
  assertEquals(test.status, 503);
  await test.body?.cancel();
  const prefs = await (await r.handle(request("/push/preferences", { token }))).json();
  assertEquals(prefs.configured, false);
  assertEquals(r.pushStore.subs.length, 0);
});

Deno.test("unsubscribe: removes the caller's row only", async () => {
  const r = rig();
  await (await r.handle(request("/push/subscribe", { token, body: { subscription: await subscription() } }))).body?.cancel();
  const notMine = await r.handle(request("/push/subscribe", { method: "DELETE", token: otherToken, body: { endpoint: ENDPOINT } }));
  assertEquals(await notMine.json(), { removed: 0 });
  assertEquals(r.pushStore.subs.length, 1, "someone else cannot remove it");
  const mine = await r.handle(request("/push/subscribe", { method: "DELETE", token, body: { endpoint: ENDPOINT } }));
  assertEquals(await mine.json(), { removed: 1 });
  assertEquals(r.pushStore.subs.length, 0);
  const bad = await r.handle(request("/push/subscribe", { method: "DELETE", token, body: {} }));
  assertEquals(bad.status, 400);
  await bad.body?.cancel();
});

// ── preferences ─────────────────────────────────────────────────────────────

Deno.test("preferences: defaults for every mailbox of the workspace, then what was saved", async () => {
  const r = rig();
  const first = await (await r.handle(request("/push/preferences", { token }))).json();
  assertEquals(first, {
    configured: true,
    subscribed_devices: 0,
    inboxes: [
      { inbox_id: INBOX_ID, enabled: true, payload_mode: "rich", quiet_hours: null },
      { inbox_id: SECOND_INBOX_ID, enabled: true, payload_mode: "rich", quiet_hours: null },
    ],
  });
  const put = await r.handle(request("/push/preferences", {
    method: "PUT",
    token,
    body: {
      inboxes: [
        { inbox_id: INBOX_ID, enabled: false },
        { inbox_id: SECOND_INBOX_ID, payload_mode: "private", quiet_hours: { start: "22:00", end: "07:30", timezone: "Europe/Oslo" } },
      ],
    },
  }));
  assertEquals(put.status, 200);
  const expected = [
    { inbox_id: INBOX_ID, enabled: false, payload_mode: "rich", quiet_hours: null },
    { inbox_id: SECOND_INBOX_ID, enabled: true, payload_mode: "private", quiet_hours: { start: "22:00", end: "07:30", timezone: "Europe/Oslo" } },
  ];
  assertEquals((await put.json()).inboxes, expected);
  assertEquals((await (await r.handle(request("/push/preferences", { token }))).json()).inboxes, expected);
  assertEquals(r.pushStore.prefs.get(`${USER_ID}:${SECOND_INBOX_ID}`)?.quiet_start, 22 * 60);
  // A partial update keeps the rest; null clears quiet hours.
  const patch = await r.handle(request("/push/preferences", { method: "PUT", token, body: { inboxes: [{ inbox_id: SECOND_INBOX_ID, quiet_hours: null }] } }));
  assertEquals((await patch.json()).inboxes[1], { inbox_id: SECOND_INBOX_ID, enabled: true, payload_mode: "private", quiet_hours: null });
  // Another person's settings are their own.
  assertEquals((await (await r.handle(request("/push/preferences", { token: otherToken }))).json()).inboxes[0].enabled, true);
});

Deno.test("preferences: a mailbox outside the workspace, unknown keys and bad values are refused; nothing is saved", async () => {
  const r = rig();
  const cases: Array<[unknown, number]> = [
    [{ inboxes: [{ inbox_id: "99999999-9999-4999-8999-999999999999", enabled: false }] }, 404],
    [{ inboxes: [{ inbox_id: "not-an-id", enabled: false }] }, 404],
    [{ inboxes: [{ inbox_id: INBOX_ID, enabled: "no" }] }, 400],
    [{ inboxes: [{ inbox_id: INBOX_ID, payload_mode: "full_body" }] }, 400],
    [{ inboxes: [{ inbox_id: INBOX_ID, subject_filter: "x" }] }, 400],
    [{ inboxes: [{ inbox_id: INBOX_ID, quiet_hours: { start: "25:00", end: "07:00", timezone: "UTC" } }] }, 400],
    [{ inboxes: [{ inbox_id: INBOX_ID, quiet_hours: { start: "22:00", end: "07:00", timezone: "Mars/Olympus" } }] }, 400],
    [{ inboxes: [] }, 400],
    [{}, 400],
  ];
  for (const [body, status] of cases) {
    const response = await r.handle(request("/push/preferences", { method: "PUT", token, body }));
    assertEquals(response.status, status, JSON.stringify(body));
    await response.body?.cancel();
  }
  assertEquals(r.pushStore.prefs.size, 0);
});

// ── test notification ───────────────────────────────────────────────────────

Deno.test("test: a fixed payload to the caller's own subscriptions in this workspace, and to nobody else's", async () => {
  const r = rig();
  await r.pushStore.upsertSubscription({ userId: USER_ID, workspaceId: WORKSPACE_ID, endpoint: `${ENDPOINT}-mine`, ...(await browserKeys()), userAgent: null });
  await r.pushStore.upsertSubscription({ userId: OTHER_USER_ID, workspaceId: WORKSPACE_ID, endpoint: `${ENDPOINT}-theirs`, ...(await browserKeys()), userAgent: null });
  await r.pushStore.upsertSubscription({ userId: USER_ID, workspaceId: "44444444-4444-4444-8444-444444444444", endpoint: `${ENDPOINT}-other-ws`, ...(await browserKeys()), userAgent: null });
  const response = await r.handle(request("/push/test", { token, body: { title: "ignored", url: "https://evil.example" } }));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { devices: 1, sent: 1, failed: 0, expired: 0 });
  assertEquals(r.sender!.sent.map((m) => m.endpoint), [`${ENDPOINT}-mine`]);
  assertEquals(r.sender!.sent[0].payload, {
    type: "test",
    title: "MCP Emails",
    body: "Notifications are working on this device.",
    url: "/",
    tag: "push-test",
  });
});

Deno.test("test: an expired subscription is reported and disabled", async () => {
  const r = rig();
  await r.pushStore.upsertSubscription({ userId: USER_ID, workspaceId: WORKSPACE_ID, endpoint: ENDPOINT, ...(await browserKeys()), userAgent: null });
  r.sender!.answer = () => ({ kind: "gone", status: 410, attempts: 1 });
  const response = await r.handle(request("/push/test", { token, body: {} }));
  assertEquals(await response.json(), { devices: 1, sent: 0, failed: 0, expired: 1 });
  assert(r.pushStore.subs[0].disabled_at !== null);
});

Deno.test("test: counted against the strictest rate bucket", async () => {
  const limiter = new RateLimiter({
    read: { capacity: 100, refillPerSec: 1 },
    write: { capacity: 100, refillPerSec: 1 },
    send: { capacity: 2, refillPerSec: 0.001 },
    assistant: { capacity: 100, refillPerSec: 1 },
  });
  const r = rig({ limiter });
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) {
    const response = await r.handle(request("/push/test", { token, body: {} }));
    statuses.push(response.status);
    await response.body?.cancel();
  }
  assertEquals(statuses, [200, 200, 429]);
});

// ── auth on the signed-in routes ────────────────────────────────────────────

Deno.test("every signed-in push route: 401 without a token, 403 when the workspace has the web client off", async () => {
  const routes: Array<[string, string, unknown]> = [
    ["/push/subscribe", "POST", { subscription: await subscription() }],
    ["/push/subscribe", "DELETE", { endpoint: ENDPOINT }],
    ["/push/preferences", "GET", undefined],
    ["/push/preferences", "PUT", { inboxes: [{ inbox_id: INBOX_ID, enabled: false }] }],
    ["/push/test", "POST", {}],
  ];
  const open = rig();
  const closed = rig({ rows: [membership({ web_client_enabled: false })] });
  for (const [path, method, body] of routes) {
    const anonymous = await open.handle(request(path, { method, body, token: null }));
    assertEquals(anonymous.status, 401, `${method} ${path}`);
    assertEquals((await anonymous.json()).error.code, "unauthenticated");
    const expired = await open.handle(request(path, { method, body, token: await mintHs256({ expiresIn: -60 }) }));
    assertEquals(expired.status, 401);
    await expired.body?.cancel();
    const gated = await closed.handle(request(path, { method, body, token }));
    assertEquals(gated.status, 403, `${method} ${path}`);
    assertEquals((await gated.json()).error.code, "web_client_disabled");
  }
  assertEquals(open.pushStore.subs.length + closed.pushStore.subs.length, 0);
  assertEquals(open.sender!.sent.length + closed.sender!.sent.length, 0);
});

Deno.test("wrong method on a push route is 405; without the push wiring the routes do not exist", async () => {
  const r = rig();
  const wrong = await r.handle(request("/push/test", { method: "GET", token }));
  assertEquals(wrong.status, 405);
  await wrong.body?.cancel();
  const bare = testApp();
  const missing = await bare.handle(request("/push/preferences", { token }));
  assertEquals(missing.status, 404);
  await missing.body?.cancel();
});

Deno.test("CORS: the preflight allows PUT and DELETE", async () => {
  const r = rig();
  const response = await r.handle(request("/push/preferences", { method: "OPTIONS" }));
  assertEquals(response.status, 204);
  const methods = response.headers.get("access-control-allow-methods") ?? "";
  assert(methods.includes("PUT") && methods.includes("DELETE"));
});

// ── the dispatcher's door ───────────────────────────────────────────────────

Deno.test("dispatch: the dispatch secret runs one pass and returns counts", async () => {
  const r = rig();
  const response = await r.handle(request("/push/dispatch", { method: "POST", body: {}, origin: null, headers: { "x-dispatch-secret": DISPATCH_SECRET } }));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), SUMMARY);
  assertEquals(r.dispatches(), 1);
  assertEquals(r.store.calls.memberships, 0, "no user, no membership lookup");
  const line = r.logs.find((l) => l.event === "request")!;
  assertEquals([line.fields["push"], line.fields["leased"], line.fields["pushes_sent"]], ["dispatch", 3, 2]);
});

Deno.test("dispatch: a user token is not a way in, with or without a wrong secret", async () => {
  const r = rig();
  const attempts: Array<Record<string, string> | undefined> = [
    undefined,
    { "x-dispatch-secret": "" },
    { "x-dispatch-secret": "wrong" },
    { "x-dispatch-secret": DISPATCH_SECRET.slice(0, -1) },
    { "x-dispatch-secret": `${DISPATCH_SECRET}x` },
    { "x-dispatch-secret": DISPATCH_SECRET.toUpperCase() },
  ];
  for (const headers of attempts) {
    for (const bearer of [token, null]) {
      const response = await r.handle(request("/push/dispatch", { method: "POST", body: {}, token: bearer, headers }));
      assertEquals(response.status, 401, JSON.stringify(headers));
      assertEquals((await response.json()).error.code, "unauthenticated");
    }
  }
  // The service-role style header a caller might try instead.
  const viaApikey = await r.handle(request("/push/dispatch", { method: "POST", body: {}, token, headers: { apikey: DISPATCH_SECRET } }));
  assertEquals(viaApikey.status, 401);
  await viaApikey.body?.cancel();
  assertEquals(r.dispatches(), 0);
});

Deno.test("dispatch: with no DISPATCH_SECRET configured nothing matches, an empty header included", async () => {
  for (const secret of [null, ""]) {
    const r = rig({ secret });
    for (const headers of [undefined, { "x-dispatch-secret": "" }, { "x-dispatch-secret": "undefined" }]) {
      const response = await r.handle(request("/push/dispatch", { method: "POST", body: {}, headers }));
      assertEquals(response.status, 401);
      await response.body?.cancel();
    }
    assertEquals(r.dispatches(), 0);
  }
});

Deno.test("dispatch: GET is refused; the Gmail push stub answers 501", async () => {
  const r = rig();
  const get = await r.handle(request("/push/dispatch", { method: "GET", headers: { "x-dispatch-secret": DISPATCH_SECRET } }));
  assertEquals(get.status, 405);
  await get.body?.cancel();
  const gmail = await r.handle(request("/push/provider/gmail", { method: "POST", body: { message: {} } }));
  assertEquals(gmail.status, 501);
  await gmail.body?.cancel();
  assertEquals(r.dispatches(), 0);
});

Deno.test("timingSafeEqual", async () => {
  assert(await timingSafeEqual("abc", "abc"));
  assert(!await timingSafeEqual("abc", "abd"));
  assert(!await timingSafeEqual("abc", "abcd"));
  assert(!await timingSafeEqual("", "a"));
});

// ── subscription rotation without a session ─────────────────────────────────

Deno.test("resubscribe: the old subscription's auth secret swaps the row in place, with no token", async () => {
  const r = rig();
  const old = await subscription();
  await (await r.handle(request("/push/subscribe", { token, body: { subscription: old } }))).body?.cancel();
  const next = await subscription("https://fcm.googleapis.com/fcm/send/browser-one-rotated");
  const response = await r.handle(request("/push/resubscribe", {
    token: null,
    body: { old_endpoint: old.endpoint, old_auth: old.keys.auth, subscription: next },
  }));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { rotated: true });
  assertEquals(r.pushStore.subs.length, 1);
  const row = r.pushStore.subs[0];
  assertEquals([row.endpoint, row.p256dh, row.auth, row.user_id, row.workspace_id], [next.endpoint, next.keys.p256dh, next.keys.auth, USER_ID, WORKSPACE_ID]);
});

Deno.test("resubscribe: a wrong secret, an unknown endpoint and a bad new endpoint all change nothing", async () => {
  const r = rig();
  const old = await subscription();
  await (await r.handle(request("/push/subscribe", { token, body: { subscription: old } }))).body?.cancel();
  const next = await subscription("https://fcm.googleapis.com/fcm/send/attacker");
  const wrongSecret = await r.handle(request("/push/resubscribe", { token: null, body: { old_endpoint: old.endpoint, old_auth: next.keys.auth, subscription: next } }));
  const unknown = await r.handle(request("/push/resubscribe", { token: null, body: { old_endpoint: `${old.endpoint}-nope`, old_auth: old.keys.auth, subscription: next } }));
  assertEquals([wrongSecret.status, unknown.status], [403, 403]);
  assertEquals(await wrongSecret.json(), await unknown.json(), "the two refusals are indistinguishable");
  // Knowing the endpoint AND the secret still cannot point the row at an arbitrary URL.
  const offList = await r.handle(request("/push/resubscribe", {
    token: null,
    body: { old_endpoint: old.endpoint, old_auth: old.keys.auth, subscription: { ...next, endpoint: "https://attacker.example/x" } },
  }));
  assertEquals(offList.status, 400);
  await offList.body?.cancel();
  // A valid user token of someone else does not help either.
  const withToken = await r.handle(request("/push/resubscribe", { token: otherToken, body: { old_endpoint: old.endpoint, old_auth: "AAAAAAAAAAAAAAAAAAAAAA", subscription: next } }));
  assertEquals(withToken.status, 403);
  await withToken.body?.cancel();
  assertEquals([r.pushStore.subs[0].endpoint, r.pushStore.subs[0].auth, r.pushStore.subs[0].user_id], [old.endpoint, old.keys.auth, USER_ID]);
});

// ── logging ─────────────────────────────────────────────────────────────────

Deno.test("request log lines for push routes carry no endpoint, key or mailbox text", async () => {
  const r = rig();
  const sub = await subscription();
  await (await r.handle(request("/push/subscribe", { token, body: { subscription: sub } }))).body?.cancel();
  await (await r.handle(request("/push/preferences", { method: "PUT", token, body: { inboxes: [{ inbox_id: INBOX_ID, payload_mode: "private" }] } }))).body?.cancel();
  await (await r.handle(request("/push/test", { token, body: {} }))).body?.cancel();
  await (await r.handle(request("/push/subscribe", { method: "DELETE", token, body: { endpoint: sub.endpoint } }))).body?.cancel();
  const logged = JSON.stringify(r.logs);
  for (const secret of ["fcm.googleapis.com", "browser-one", sub.keys.p256dh, sub.keys.auth, "client-api-test.example", "Box 0"]) {
    assert(!logged.includes(secret), `log contains ${secret}`);
  }
  assertEquals(
    r.logs.filter((l) => l.event === "request").map((l) => l.fields["push"]),
    ["subscribe", "preferences_put", "test", "unsubscribe"],
  );
});

Deno.test("deviceLabel: a fixed vocabulary, never the header itself", () => {
  assertEquals(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"), "Safari on iOS");
  assertEquals(deviceLabel("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"), "Firefox on Linux");
  assertEquals(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0"), "Edge on Windows");
  assertEquals(deviceLabel("curl/8.0 <script>alert(1)</script>"), null);
  assertEquals(deviceLabel(null), null);
});
