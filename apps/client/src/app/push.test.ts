import { describe, expect, it } from "vitest";
import type { NotificationPermissionState, PlatformAdapter, PushPayload } from "../platform";
import { PUSH_ENABLED_KEY, createPushController, handleForegroundPush, toastTextFor } from "./push";

/* A fake browser: permission, one push subscription, a key-value store. */
function fakePlatform(options: { permission?: NotificationPermissionState; ios?: boolean; standalone?: boolean; pushSupported?: boolean; worker?: boolean } = {}) {
  const state = {
    permission: options.permission ?? ("default" as NotificationPermissionState),
    onPrompt: "granted" as NotificationPermissionState,
    prompts: 0,
    subscription: null as PushSubscriptionJSON | null,
    created: 0,
    unsubscribed: 0,
    storage: new Map<string, unknown>(),
    configured: [] as unknown[],
    worker: options.worker ?? true,
  };
  const platform = {
    kind: "web",
    isStandalone: options.standalone ?? false,
    isIOS: options.ios ?? false,
    notifications: {
      supported: true,
      pushSupported: options.pushSupported ?? true,
      permission: () => state.permission,
      requestPermission: async () => {
        state.prompts++;
        state.permission = state.onPrompt;
        return state.permission;
      },
      show: async () => {},
      subscribePush: async () => {
        if (state.permission !== "granted" || !state.worker) return null;
        if (!state.subscription) {
          state.created++;
          state.subscription = { endpoint: `https://fcm.googleapis.com/fcm/send/device-${state.created}`, keys: { p256dh: "p", auth: "a" } };
        }
        return state.subscription;
      },
      currentPushSubscription: async () => state.subscription,
      unsubscribePush: async () => {
        const was = state.subscription;
        if (was) state.unsubscribed++;
        state.subscription = null;
        return was;
      },
      onPush: () => () => {},
      configureBackground: async (config: unknown) => void state.configured.push(config),
    },
    storage: {
      get: async (key: string) => state.storage.get(key),
      set: async (key: string, value: unknown) => void state.storage.set(key, value),
      del: async (key: string) => void state.storage.delete(key),
    },
  } as unknown as PlatformAdapter;
  return { platform, state };
}

function rig(options: Parameters<typeof fakePlatform>[0] & { vapid?: string } = {}) {
  const { platform, state } = fakePlatform(options);
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const server = { fail: null as Error | null, workspace: "ws-1" };
  const controller = createPushController({
    platform: () => platform,
    request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      calls.push({ method, path, body });
      if (server.fail) throw server.fail;
      return (path === "/push/preferences" ? { inboxes: [] } : {}) as T;
    },
    apiBase: "https://api.example/functions/v1/client-api",
    vapidPublicKey: options.vapid ?? "BPublicKey",
    workspaceId: () => server.workspace,
  });
  return { controller, state, calls, server };
}

describe("push controller: turning notifications on", () => {
  it("asks for permission only inside enable(), then subscribes and registers with the server", async () => {
    const r = rig();
    expect((await r.controller.state()).availability).toBe("ready");
    await r.controller.sync();
    expect(r.state.prompts).toBe(0); // nothing prompts by itself

    expect(await r.controller.enable()).toBe("enabled");
    expect(r.state.prompts).toBe(1);
    expect(r.calls).toEqual([
      { method: "POST", path: "/push/subscribe", body: { subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/device-1", keys: { p256dh: "p", auth: "a" } } } },
    ]);
    expect(r.state.storage.get(PUSH_ENABLED_KEY)).toBe(true);
    expect(r.state.configured).toEqual([{ apiBase: "https://api.example/functions/v1/client-api", vapidPublicKey: "BPublicKey" }]);
    expect(await r.controller.state()).toEqual({ availability: "ready", permission: "granted", subscribed: true });
  });

  it("does not prompt again when permission is already granted", async () => {
    const r = rig({ permission: "granted" });
    expect(await r.controller.enable()).toBe("enabled");
    expect(r.state.prompts).toBe(0);
  });

  it("a refused or dismissed prompt subscribes nothing and tells the server nothing", async () => {
    const denied = rig();
    denied.state.onPrompt = "denied";
    expect(await denied.controller.enable()).toBe("blocked");
    const dismissed = rig();
    dismissed.state.onPrompt = "default";
    expect(await dismissed.controller.enable()).toBe("dismissed");
    for (const r of [denied, dismissed]) {
      expect(r.calls).toEqual([]);
      expect(r.state.created).toBe(0);
      expect(r.state.storage.get(PUSH_ENABLED_KEY)).toBeUndefined();
    }
    // Already blocked: not even a prompt.
    const blocked = rig({ permission: "denied" });
    expect(await blocked.controller.enable()).toBe("blocked");
    expect(blocked.state.prompts).toBe(0);
  });

  it("if the server refuses the subscription, the browser's is removed again: never half on", async () => {
    const r = rig();
    r.server.fail = new Error("503");
    expect(await r.controller.enable()).toBe("failed");
    expect(r.state.subscription).toBeNull();
    expect(r.state.storage.get(PUSH_ENABLED_KEY)).toBeUndefined();
    expect((await r.controller.state()).subscribed).toBe(false);
  });

  it("says why it cannot be turned on: iPhone in a tab, no push support, no key, no service worker", async () => {
    const ios = rig({ ios: true });
    expect((await ios.controller.state()).availability).toBe("needs_install");
    expect(await ios.controller.enable()).toBe("unavailable");
    expect(ios.state.prompts).toBe(0);
    // The same phone, opened from the Home Screen.
    expect((await rig({ ios: true, standalone: true }).controller.state()).availability).toBe("ready");
    expect((await rig({ pushSupported: false }).controller.state()).availability).toBe("unsupported");
    expect((await rig({ vapid: "" }).controller.state()).availability).toBe("unavailable");
    const noWorker = rig({ worker: false });
    expect(await noWorker.controller.enable()).toBe("unavailable");
    expect(noWorker.calls).toEqual([]);
  });
});

describe("push controller: keeping the server in step", () => {
  it("sync registers the current subscription once per workspace, and again after a workspace switch", async () => {
    const r = rig();
    await r.controller.enable();
    r.calls.length = 0;
    await r.controller.sync();
    await r.controller.sync();
    expect(r.calls).toEqual([]); // enable() already registered it here
    r.server.workspace = "ws-2";
    await r.controller.sync();
    await r.controller.sync();
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /push/subscribe"]);
  });

  it("sync re-creates a subscription the browser dropped and registers the new one", async () => {
    const r = rig();
    await r.controller.enable();
    r.calls.length = 0;
    r.state.subscription = null; // the browser rotated or dropped it
    await r.controller.sync();
    expect(r.state.created).toBe(2);
    expect(r.calls).toEqual([
      { method: "POST", path: "/push/subscribe", body: { subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/device-2", keys: { p256dh: "p", auth: "a" } } } },
    ]);
    expect(r.state.prompts).toBe(1); // only the one from enable()
  });

  it("sync on a fresh page load (nothing remembered in memory) registers again: it is idempotent on the server", async () => {
    const first = rig({ permission: "granted" });
    first.state.storage.set(PUSH_ENABLED_KEY, true);
    first.state.subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/kept", keys: { p256dh: "p", auth: "a" } };
    await first.controller.sync();
    expect(first.calls.map((c) => c.path)).toEqual(["/push/subscribe"]);
    expect(first.state.created).toBe(0);
  });

  it("sync does nothing on a device where notifications were never turned on, or were turned off", async () => {
    const never = rig({ permission: "granted" });
    await never.controller.sync();
    expect(never.calls).toEqual([]);
    expect(never.state.created).toBe(0);

    const off = rig();
    await off.controller.enable();
    await off.controller.disable();
    off.calls.length = 0;
    await off.controller.sync({ force: true });
    expect(off.calls).toEqual([]);
    expect(off.state.subscription).toBeNull();
  });

  it("a failed sync is retried at the next one", async () => {
    const r = rig({ permission: "granted" });
    r.state.storage.set(PUSH_ENABLED_KEY, true);
    r.server.fail = new Error("offline");
    await expect(r.controller.sync()).resolves.toBeUndefined();
    r.server.fail = null;
    await r.controller.sync();
    expect(r.calls.length).toBe(2);
  });

  it("disable ends the browser subscription and deletes the server row", async () => {
    const r = rig();
    await r.controller.enable();
    r.calls.length = 0;
    await r.controller.disable();
    expect(r.state.subscription).toBeNull();
    expect(r.calls).toEqual([{ method: "DELETE", path: "/push/subscribe", body: { endpoint: "https://fcm.googleapis.com/fcm/send/device-1" } }]);
    expect((await r.controller.state()).subscribed).toBe(false);
  });
});

describe("push controller: sign-out", () => {
  it("with a token: the server row is deleted, then the browser subscription is ended", async () => {
    const r = rig();
    await r.controller.enable();
    r.calls.length = 0;
    await r.controller.signOut({ authed: true });
    expect(r.calls).toEqual([{ method: "DELETE", path: "/push/subscribe", body: { endpoint: "https://fcm.googleapis.com/fcm/send/device-1" } }]);
    expect(r.state.subscription).toBeNull();
    expect(r.state.storage.has(PUSH_ENABLED_KEY)).toBe(false);
    // The next person to sign in on this browser does not inherit it.
    await r.controller.sync();
    expect(r.calls.length).toBe(1);
    expect(r.state.subscription).toBeNull();
  });

  it("without a token (the session ended): no request, but the browser subscription is still ended", async () => {
    const r = rig();
    await r.controller.enable();
    r.calls.length = 0;
    await r.controller.signOut({ authed: false });
    expect(r.calls).toEqual([]);
    expect(r.state.unsubscribed).toBe(1);
    expect(r.state.subscription).toBeNull();
  });

  it("a server that cannot be reached does not keep the subscription alive", async () => {
    const r = rig();
    await r.controller.enable();
    r.server.fail = new Error("offline");
    await r.controller.signOut({ authed: true });
    expect(r.state.subscription).toBeNull();
  });
});

describe("push controller: preferences and test", () => {
  it("are plain signed-in requests", async () => {
    const r = rig();
    await r.controller.preferences();
    await r.controller.savePreferences([{ inbox_id: "i1", enabled: false }]);
    await r.controller.sendTest();
    expect(r.calls).toEqual([
      { method: "GET", path: "/push/preferences", body: undefined },
      { method: "PUT", path: "/push/preferences", body: { inboxes: [{ inbox_id: "i1", enabled: false }] } },
      { method: "POST", path: "/push/test", body: {} },
    ]);
  });
});

describe("a push while the app is visible", () => {
  function deps(showing: (id: string | undefined) => boolean) {
    const log: string[] = [];
    const toasts: Array<{ text: string; action?: { label: string; run: () => void } }> = [];
    return {
      log,
      toasts,
      deps: {
        syncNow: () => void log.push("sync"),
        resync: () => void log.push("resync"),
        isShowingInbox: showing,
        toast: (t: { text: string; action?: { label: string; run: () => void } }) => void toasts.push(t),
        open: (url: string) => void log.push(`open:${url}`),
      },
    };
  }
  const rich: PushPayload = { type: "new_mail", mode: "rich", title: "Maya Berg", body: "Lunch on Friday?", url: "/i1/inbox/i1%3A42", inbox_id: "i1", count: 1 };

  it("new mail in the mailbox on screen: sync now, no toast (the list shows it)", () => {
    const d = deps((id) => id === "i1");
    handleForegroundPush(rich, d.deps);
    expect(d.log).toEqual(["sync"]);
    expect(d.toasts).toEqual([]);
  });

  it("new mail in another mailbox: sync now and one toast that opens it", () => {
    const d = deps(() => false);
    handleForegroundPush(rich, d.deps);
    expect(d.log).toEqual(["sync"]);
    expect(d.toasts.map((t) => [t.text, t.action?.label])).toEqual([["Maya Berg: Lunch on Friday?", "Open"]]);
    d.toasts[0]!.action!.run();
    expect(d.log).toEqual(["sync", "open:/i1/inbox/i1%3A42"]);
  });

  it("the toast never says more than the notification would have", () => {
    expect(toastTextFor({ type: "new_mail", mode: "private", title: "New mail", body: "2 new messages in Work", count: 2 })).toBe("2 new messages in Work");
    expect(toastTextFor({ type: "new_mail", mode: "rich", title: "3 new messages in Work", body: "A: x\nB: y\nC: z", count: 3 })).toBe("3 new messages in Work");
    expect(toastTextFor({ type: "new_mail", count: 4 })).toBe("4 new messages");
    expect(toastTextFor({ type: "new_mail" })).toBe("1 new message");
  });

  it("a test push is confirmed in the app; a rotated subscription is re-registered; anything else is ignored", () => {
    const d = deps(() => false);
    handleForegroundPush({ type: "test" }, d.deps);
    handleForegroundPush({ type: "subscription_changed" }, d.deps);
    handleForegroundPush({ type: "approval_required", approval_id: "a1" }, d.deps);
    expect(d.log).toEqual(["resync"]);
    expect(d.toasts.length).toBe(1);
    expect(d.toasts[0]!.text).toContain("Test notification received");
  });
});
