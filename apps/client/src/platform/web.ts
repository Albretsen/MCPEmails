import { del, get, set } from "idb-keyval";
import type {
  AppNotification,
  BackgroundPushConfig,
  DeepLink,
  InstallOutcome,
  NotificationPermissionState,
  PlatformAdapter,
  PushPayload,
} from "./types";

/* Web implementation. Every capability is feature-detected; nothing here
 * throws when an API is missing (Safari without Home Screen install, private
 * mode without IndexedDB, jsdom in tests). */

type BadgeNavigator = Navigator & {
  setAppBadge?: (n?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const hasWindow = typeof window !== "undefined";
const hasNotification = hasWindow && "Notification" in window;
const hasServiceWorker = typeof navigator !== "undefined" && "serviceWorker" in navigator;
const hasPush = hasServiceWorker && hasNotification && "PushManager" in window;
const hasIdb = typeof indexedDB !== "undefined";

/** Web Push application server key (public). Set VITE_VAPID_PUBLIC_KEY at
 *  build time to the value scripts/generate-vapid-keys.ts printed. Empty =
 *  never subscribe: every push control says notifications are unavailable. */
export const VAPID_PUBLIC_KEY: string = (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) ?? "";

/* What the page shares with the service worker (public/sw.js reads the same
 * names). The Cache API is the one store both sides can reach without a
 * library; nothing secret goes in it: the API base URL, the PUBLIC key, and
 * the unread total for the app badge. */
export const SW_STORE = "mcpe-push";
export const SW_CONFIG_URL = "/__push/config";
export const SW_BADGE_URL = "/__push/badge";

async function swStorePut(url: string, value: unknown): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open(SW_STORE);
    await cache.put(url, new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } }));
  } catch {
    /* private mode, storage full: the service worker falls back to asking the page */
  }
}

/** Falls back to memory when IndexedDB is unavailable. */
const memory = new Map<string, unknown>();

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

function isStandaloneDisplay(): boolean {
  if (!hasWindow) return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function detectIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  // iPadOS reports itself as a Mac; a Mac has no touch points.
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function createWebPlatform(): PlatformAdapter {
  const linkListeners = new Set<(link: DeepLink) => void>();
  const pushListeners = new Set<(payload: PushPayload) => void>();

  if (hasServiceWorker) {
    navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
      const d = event.data as {
        type?: string;
        url?: string;
        action?: string | null;
        data?: Record<string, unknown>;
        payload?: PushPayload;
      };
      // A push arrived while this window was visible (no system notification was shown).
      if (d?.type === "push" && d.payload && typeof d.payload === "object") {
        for (const l of [...pushListeners]) l(d.payload);
        return;
      }
      // The browser rotated the subscription: the app registers the new one.
      if (d?.type === "push_subscription_changed") {
        for (const l of [...pushListeners]) l({ type: "subscription_changed" });
        return;
      }
      // A notification was clicked.
      if (d?.type !== "deep_link" || typeof d.url !== "string") return;
      for (const l of [...linkListeners]) l({ url: d.url, action: d.action ?? null, data: d.data });
    });
  }

  /** The registration, without waiting for one: dev builds register none. */
  const registration = async (): Promise<ServiceWorkerRegistration | null> => {
    if (!hasPush) return null;
    try {
      return (await navigator.serviceWorker.getRegistration()) ?? null;
    } catch {
      return null;
    }
  };

  // Chromium fires beforeinstallprompt once, early. Keep it so a button can use it later.
  let installEvent: BeforeInstallPromptEvent | null = null;
  const installListeners = new Set<() => void>();
  const setInstallEvent = (e: BeforeInstallPromptEvent | null) => {
    installEvent = e;
    for (const l of [...installListeners]) l();
  };
  if (hasWindow) {
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
    });
    window.addEventListener("appinstalled", () => setInstallEvent(null));
  }

  const nav = (typeof navigator !== "undefined" ? navigator : {}) as BadgeNavigator;
  const standalone = isStandaloneDisplay();

  return {
    kind: standalone ? "pwa" : "web",
    isStandalone: standalone,
    isIOS: detectIOS(),

    notifications: {
      supported: hasNotification,
      pushSupported: hasPush,
      permission(): NotificationPermissionState {
        return hasNotification ? Notification.permission : "unsupported";
      },
      async requestPermission(): Promise<NotificationPermissionState> {
        if (!hasNotification) return "unsupported";
        try {
          return await Notification.requestPermission();
        } catch {
          return "denied";
        }
      },
      async show(n: AppNotification): Promise<void> {
        if (!hasNotification || Notification.permission !== "granted") return;
        const options: NotificationOptions = {
          body: n.body,
          tag: n.tag,
          icon: "/icon-192.png",
          requireInteraction: n.requireInteraction,
          data: { url: n.url ?? "/", ...n.data },
        };
        try {
          // Prefer the service worker: page-created notifications are not allowed on Android.
          const reg = hasServiceWorker ? await navigator.serviceWorker.getRegistration() : undefined;
          if (reg) {
            // Action buttons exist only on service-worker notifications.
            await reg.showNotification(n.title, n.actions?.length ? { ...options, actions: n.actions } as NotificationOptions : options);
          } else new Notification(n.title, options);
        } catch {
          /* notification could not be shown: not fatal */
        }
      },
      async subscribePush(vapidPublicKey: string = VAPID_PUBLIC_KEY): Promise<PushSubscriptionJSON | null> {
        if (!vapidPublicKey || !hasPush) return null;
        if (Notification.permission !== "granted") return null;
        try {
          const reg = await registration();
          if (!reg) return null;
          const key = urlBase64ToUint8Array(vapidPublicKey);
          let sub = await reg.pushManager.getSubscription();
          // Made with another server key (the keys were replaced): the push
          // service would reject this server's messages. Subscribe afresh.
          if (sub && sub.options?.applicationServerKey && !sameKey(sub.options.applicationServerKey, key)) {
            await sub.unsubscribe();
            sub = null;
          }
          sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
          return sub.toJSON();
        } catch {
          return null;
        }
      },
      async currentPushSubscription(): Promise<PushSubscriptionJSON | null> {
        try {
          const reg = await registration();
          return (await reg?.pushManager.getSubscription())?.toJSON() ?? null;
        } catch {
          return null;
        }
      },
      async unsubscribePush(): Promise<PushSubscriptionJSON | null> {
        try {
          const reg = await registration();
          const sub = await reg?.pushManager.getSubscription();
          if (!sub) return null;
          const json = sub.toJSON();
          await sub.unsubscribe();
          return json;
        } catch {
          return null;
        }
      },
      onPush(listener: (payload: PushPayload) => void): () => void {
        pushListeners.add(listener);
        return () => {
          pushListeners.delete(listener);
        };
      },
      async configureBackground(config: BackgroundPushConfig): Promise<void> {
        await swStorePut(SW_CONFIG_URL, config);
      },
    },

    storage: {
      async get<T>(key: string): Promise<T | undefined> {
        if (!hasIdb) return memory.get(key) as T | undefined;
        try {
          return await get<T>(key);
        } catch {
          return memory.get(key) as T | undefined;
        }
      },
      async set<T>(key: string, value: T): Promise<void> {
        memory.set(key, value);
        if (!hasIdb) return;
        try {
          await set(key, value);
          memory.delete(key);
        } catch {
          /* kept in memory */
        }
      },
      async del(key: string): Promise<void> {
        memory.delete(key);
        if (!hasIdb) return;
        try {
          await del(key);
        } catch {
          /* ignore */
        }
      },
    },

    badge: {
      supported: typeof nav.setAppBadge === "function",
      async set(count: number): Promise<void> {
        // The service worker continues from this total when a push arrives
        // with no window open (public/sw.js).
        if (hasPush) void swStorePut(SW_BADGE_URL, { total: Math.max(0, count), inboxes: {} });
        try {
          if (count > 0) await nav.setAppBadge?.(count);
          else await nav.clearAppBadge?.();
        } catch {
          /* not allowed in this context */
        }
      },
      async clear(): Promise<void> {
        try {
          await nav.clearAppBadge?.();
        } catch {
          /* ignore */
        }
      },
    },

    deepLinks: {
      onOpen(listener) {
        linkListeners.add(listener);
        return () => {
          linkListeners.delete(listener);
        };
      },
      buildUrl(path: string): string {
        const origin = hasWindow ? window.location.origin : "https://app.mcpemails.com";
        return origin + (path.startsWith("/") ? path : `/${path}`);
      },
    },

    haptics: {
      tick(): void {
        try {
          navigator.vibrate?.(10);
        } catch {
          /* unsupported (iOS Safari) */
        }
      },
    },

    network: {
      isOnline(): boolean {
        // Only `false` is reliable; `true` just means there is a network interface.
        return typeof navigator === "undefined" || navigator.onLine !== false;
      },
      subscribe(listener: () => void): () => void {
        if (!hasWindow) return () => {};
        window.addEventListener("online", listener);
        window.addEventListener("offline", listener);
        return () => {
          window.removeEventListener("online", listener);
          window.removeEventListener("offline", listener);
        };
      },
    },

    install: {
      canPrompt(): boolean {
        return installEvent != null;
      },
      async prompt(): Promise<InstallOutcome> {
        const e = installEvent;
        if (!e) return "unavailable";
        try {
          await e.prompt();
          const { outcome } = await e.userChoice;
          // The event can be used only once.
          setInstallEvent(null);
          return outcome;
        } catch {
          return "unavailable";
        }
      },
      subscribe(listener: () => void): () => void {
        installListeners.add(listener);
        return () => {
          installListeners.delete(listener);
        };
      },
    },

    async registerBackground(): Promise<void> {
      // Dev builds skip it: a service worker would fight Vite's module reloads.
      if (!import.meta.env.PROD || !hasServiceWorker) return;
      try {
        await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      } catch {
        /* push is unavailable: the app still works */
      }
    },
  };
}
