import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SW_BADGE_URL, SW_CONFIG_URL, SW_STORE } from "./web";

/* public/sw.js, run for real inside a stand-in ServiceWorkerGlobalScope: the
 * file is plain JavaScript with no imports, so it is evaluated as written. */

// Vitest runs from apps/client.
const SOURCE = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");
const ORIGIN = "https://app.mcpemails.com";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

interface FakeClient {
  visibilityState: "visible" | "hidden";
  messages: unknown[];
  focused: number;
  postMessage(message: unknown): void;
  focus(): Promise<void>;
}

function windowClient(visibilityState: "visible" | "hidden"): FakeClient {
  const client: FakeClient = {
    visibilityState,
    messages: [],
    focused: 0,
    postMessage: (m) => void client.messages.push(m),
    focus: async () => void client.focused++,
  };
  return client;
}

function worker(options: { clients?: FakeClient[]; userAgent?: string; badge?: boolean; store?: Record<string, unknown> } = {}) {
  type Handler = (event: Record<string, unknown>) => void;
  const handlers = new Map<string, Handler>();
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const fetched: Array<{ url: string; init: RequestInit }> = [];
  const badges: Array<number | "clear"> = [];
  const store = new Map<string, string>(Object.entries(options.store ?? {}).map(([k, v]) => [k, JSON.stringify(v)]));
  const subscriptions = { current: null as unknown, subscribed: [] as unknown[] };
  const cacheNames: string[] = [];

  const scope = {
    location: { origin: ORIGIN },
    navigator: {
      userAgent: options.userAgent ?? CHROME,
      ...(options.badge === false
        ? {}
        : {
            setAppBadge: async (n: number) => void badges.push(n),
            clearAppBadge: async () => void badges.push("clear"),
          }),
    },
    skipWaiting: () => {},
    addEventListener: (type: string, handler: Handler) => void handlers.set(type, handler),
    clients: {
      claim: async () => {},
      matchAll: async () => options.clients ?? [],
      openWindow: async (url: string) => void opened.push(url),
    },
    registration: {
      showNotification: async (title: string, opts: Record<string, unknown>) => void shown.push({ title, options: opts }),
      pushManager: {
        getSubscription: async () => subscriptions.current,
        subscribe: async (opts: unknown) => {
          subscriptions.subscribed.push(opts);
          subscriptions.current = sub("https://fcm.googleapis.com/fcm/send/made-by-sw", "new-auth");
          return subscriptions.current;
        },
      },
    },
  };
  const caches = {
    open: async (name: string) => {
      cacheNames.push(name);
      return {
        match: async (url: string) => (store.has(url) ? new Response(store.get(url)!) : undefined),
        put: async (url: string, response: Response) => void store.set(url, await response.text()),
      };
    },
  };
  const fetchFake = async (url: string, init: RequestInit) => {
    fetched.push({ url, init });
    return new Response("{}", { status: 200 });
  };
  new Function("self", "caches", "fetch", SOURCE)(scope, caches, fetchFake);

  /** Dispatch an event and wait for everything it passed to waitUntil. */
  const dispatch = async (type: string, event: Record<string, unknown> = {}) => {
    const pending: Promise<unknown>[] = [];
    handlers.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => void pending.push(p) });
    await Promise.all(pending);
  };
  const push = (payload: unknown) =>
    dispatch("push", {
      data: payload === undefined ? null : { json: () => payload, text: () => JSON.stringify(payload) },
    });
  return { dispatch, push, shown, opened, fetched, badges, store, subscriptions, cacheNames, handlers };
}

function sub(endpoint: string, auth: string) {
  const json = { endpoint, keys: { p256dh: "p256dh-key", auth } };
  return { ...json, toJSON: () => json };
}

const RICH = {
  type: "new_mail",
  mode: "rich",
  title: "Maya Berg",
  body: "Lunch on Friday?",
  url: "/i1/inbox/i1%3AINBOX%3A42",
  tag: "mail-i1",
  inbox_id: "i1",
  count: 1,
  unread: 4,
};
const PRIVATE = { type: "new_mail", mode: "private", title: "New mail", body: "2 new messages in Work", url: "/i1/inbox", tag: "mail-i1", inbox_id: "i1", count: 2, unread: 5 };

describe("service worker: showing a push", () => {
  it("rich mode: sender as the title, subject as the body, one notification per mailbox", async () => {
    const w = worker();
    await w.push(RICH);
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0]!.title).toBe("Maya Berg");
    expect(w.shown[0]!.options).toMatchObject({
      body: "Lunch on Friday?",
      tag: "mail-i1",
      renotify: true,
      data: { url: "/i1/inbox/i1%3AINBOX%3A42", type: "new_mail", inbox_id: "i1", approval_id: null },
    });
    expect(w.shown[0]!.options.actions).toBeUndefined();
    expect(w.shown[0]!.options.silent).toBeUndefined();
  });

  it("private mode: a count and the mailbox name, exactly as the server sent them", async () => {
    const w = worker();
    await w.push(PRIVATE);
    expect([w.shown[0]!.title, w.shown[0]!.options.body]).toEqual(["New mail", "2 new messages in Work"]);
    expect(w.shown[0]!.options.data).toMatchObject({ url: "/i1/inbox" });
  });

  it("a payload without text is described by its count, never by invented content", async () => {
    const w = worker();
    await w.push({ type: "new_mail", mode: "private", count: 3, inbox_id: "i1" });
    await w.push({ type: "new_mail" });
    await w.push(undefined);
    expect(w.shown.map((n) => [n.title, n.options.body])).toEqual([
      ["New mail", "3 new messages"],
      ["New mail", "1 new message"],
      ["New mail", "1 new message"],
    ]);
  });

  it("only same-origin, in-app paths are stored on a notification", async () => {
    const w = worker();
    await w.push({ ...RICH, url: "https://evil.example/phish" });
    await w.push({ ...RICH, url: "//evil.example/x" });
    await w.push({ ...RICH, url: "javascript:alert(1)" });
    expect(w.shown.map((n) => (n.options.data as { url: string }).url)).toEqual(["/", "/", "/"]);
  });

  it("the test push is shown with its fixed text", async () => {
    const w = worker();
    await w.push({ type: "test", title: "MCP Emails", body: "Notifications are working on this device.", url: "/", tag: "push-test" });
    expect([w.shown[0]!.title, w.shown[0]!.options.body, w.shown[0]!.options.tag]).toEqual(["MCP Emails", "Notifications are working on this device.", "push-test"]);
    expect(w.shown[0]!.options.renotify).toBeUndefined();
  });
});

describe("service worker: the app is open", () => {
  it("a visible window gets the payload and NO system notification is shown", async () => {
    const visible = windowClient("visible");
    const hidden = windowClient("hidden");
    const w = worker({ clients: [hidden, visible] });
    await w.push(RICH);
    expect(w.shown).toEqual([]);
    expect(visible.messages).toEqual([{ type: "push", payload: RICH }]);
    expect(hidden.messages).toEqual([]);
    expect(w.badges).toEqual([]); // the page owns the badge while it is open
  });

  it("a hidden window is not enough: the notification is shown", async () => {
    const w = worker({ clients: [windowClient("hidden")] });
    await w.push(RICH);
    expect(w.shown).toHaveLength(1);
  });

  it("Safari: the notification is still shown (silently) so the subscription is not withdrawn, and the page is told", async () => {
    const visible = windowClient("visible");
    const w = worker({ clients: [visible], userAgent: SAFARI });
    await w.push(RICH);
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0]!.options.silent).toBe(true);
    expect(visible.messages).toEqual([{ type: "push", payload: RICH }]);
  });

  it("an approval request is shown even over a visible app, with its two actions", async () => {
    const w = worker({ clients: [windowClient("visible")] });
    await w.push({ type: "approval_required", approval_id: "ap1", url: "/compose" });
    expect(w.shown[0]!.options).toMatchObject({ requireInteraction: true, tag: "approval-ap1" });
    expect((w.shown[0]!.options.actions as { action: string }[]).map((a) => a.action)).toEqual(["approve", "review"]);
  });
});

describe("service worker: the app badge", () => {
  it("continues from the total the page last set, per mailbox, while no window is open", async () => {
    const w = worker({ store: { [SW_BADGE_URL]: { total: 7, inboxes: {} } } });
    await w.push(RICH); // unknown mailbox so far: +count
    expect(w.badges).toEqual([8]);
    await w.push({ ...PRIVATE, unread: 6 }); // the same mailbox, now known at 4 unread: +2
    expect(w.badges).toEqual([8, 10]);
    expect(JSON.parse(w.store.get(SW_BADGE_URL)!)).toEqual({ total: 10, inboxes: { i1: 6 } });
    expect(w.cacheNames.every((n) => n === SW_STORE)).toBe(true);
  });

  it("does nothing where the Badging API is missing, and nothing for a test push", async () => {
    const none = worker({ badge: false });
    await none.push(RICH);
    expect(none.shown).toHaveLength(1);
    const test = worker();
    await test.push({ type: "test" });
    expect(test.badges).toEqual([]);
  });
});

describe("service worker: clicking a notification", () => {
  const click = (w: ReturnType<typeof worker>, data: Record<string, unknown>, action = "") => {
    let closed = 0;
    return w
      .dispatch("notificationclick", { action, notification: { data, close: () => void closed++ } })
      .then(() => closed);
  };

  it("an open app is focused and told where to go", async () => {
    const hidden = windowClient("hidden");
    const visible = windowClient("visible");
    const w = worker({ clients: [hidden, visible] });
    const closed = await click(w, { url: "/i1/inbox/i1%3A42", type: "new_mail", inbox_id: "i1" });
    expect(closed).toBe(1);
    expect(visible.focused).toBe(1);
    expect(visible.messages).toEqual([
      { type: "deep_link", url: "/i1/inbox/i1%3A42", action: null, data: { url: "/i1/inbox/i1%3A42", type: "new_mail", inbox_id: "i1" } },
    ]);
    expect(hidden.messages).toEqual([]);
    expect(w.opened).toEqual([]);
  });

  it("with no window, the app is opened at the mailbox or message", async () => {
    const w = worker();
    await click(w, { url: "/i1/inbox" });
    await click(w, { url: "https://evil.example/" });
    expect(w.opened).toEqual(["/i1/inbox", "/"]);
  });
});

describe("service worker: the browser rotated the subscription", () => {
  const config = { [SW_CONFIG_URL]: { apiBase: "https://project.supabase.co/functions/v1/client-api", vapidPublicKey: "BPublicKey" } };

  it("with no page open: the new subscription is registered with the OLD one's auth secret as proof, and no token", async () => {
    const w = worker({ store: config });
    await w.dispatch("pushsubscriptionchange", {
      oldSubscription: sub("https://fcm.googleapis.com/fcm/send/old", "old-auth"),
      newSubscription: sub("https://fcm.googleapis.com/fcm/send/new", "new-auth"),
    });
    expect(w.fetched).toHaveLength(1);
    expect(w.fetched[0]!.url).toBe("https://project.supabase.co/functions/v1/client-api/push/resubscribe");
    expect(w.fetched[0]!.init.method).toBe("POST");
    expect(w.fetched[0]!.init.headers).toEqual({ "Content-Type": "application/json" }); // no Authorization
    expect(JSON.parse(w.fetched[0]!.init.body as string)).toEqual({
      old_endpoint: "https://fcm.googleapis.com/fcm/send/old",
      old_auth: "old-auth",
      subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/new", keys: { p256dh: "p256dh-key", auth: "new-auth" } },
    });
  });

  it("when the browser gave no new subscription, one is made with the stored PUBLIC key", async () => {
    const w = worker({ store: config });
    await w.dispatch("pushsubscriptionchange", { oldSubscription: sub("https://fcm.googleapis.com/fcm/send/old", "old-auth"), newSubscription: null });
    expect(w.subscriptions.subscribed).toHaveLength(1);
    expect((w.subscriptions.subscribed[0] as { userVisibleOnly: boolean }).userVisibleOnly).toBe(true);
    expect(JSON.parse(w.fetched[0]!.init.body as string).subscription.endpoint).toBe("https://fcm.googleapis.com/fcm/send/made-by-sw");
  });

  it("with a page open: the page is told and registers it through the signed-in route", async () => {
    const page = windowClient("hidden");
    const w = worker({ store: config, clients: [page] });
    await w.dispatch("pushsubscriptionchange", {
      oldSubscription: sub("https://fcm.googleapis.com/fcm/send/old", "old-auth"),
      newSubscription: sub("https://fcm.googleapis.com/fcm/send/new", "new-auth"),
    });
    expect(page.messages).toEqual([{ type: "push_subscription_changed" }]);
    expect(w.fetched).toEqual([]);
  });

  it("without the old subscription, or without the stored config, nothing is sent (the page repairs it at its next load)", async () => {
    const noOld = worker({ store: config });
    await noOld.dispatch("pushsubscriptionchange", { oldSubscription: null, newSubscription: sub("https://fcm.googleapis.com/fcm/send/new", "n") });
    const noConfig = worker();
    await noConfig.dispatch("pushsubscriptionchange", {
      oldSubscription: sub("https://fcm.googleapis.com/fcm/send/old", "o"),
      newSubscription: sub("https://fcm.googleapis.com/fcm/send/new", "n"),
    });
    expect(noOld.fetched).toEqual([]);
    expect(noConfig.fetched).toEqual([]);
  });
});
