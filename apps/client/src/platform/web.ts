import { del, get, set } from "idb-keyval";
import type { AppNotification, DeepLink, InstallOutcome, NotificationPermissionState, PlatformAdapter } from "./types";

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

/** Web Push application server key.
 *  PLACEHOLDER: there is no push backend yet, so no key is configured. Set
 *  VITE_VAPID_PUBLIC_KEY at build time once there is. Empty = never subscribe. */
export const VAPID_PUBLIC_KEY: string = (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) ?? "";

/** TODO(push backend): the endpoint that stores a push subscription for the
 *  signed-in user does not exist yet. When it does, send `sub` to it here, and
 *  remove it again on sign-out or when permission is revoked. Until then the
 *  subscription is created in the browser and delivered nowhere. */
async function sendSubscriptionToServer(_sub: PushSubscriptionJSON): Promise<void> {
  /* intentionally empty: see the TODO above */
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

  if (hasServiceWorker) {
    // The service worker posts this when a notification is clicked.
    navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
      const d = event.data as { type?: string; url?: string; action?: string | null; data?: Record<string, unknown> };
      if (d?.type !== "deep_link" || typeof d.url !== "string") return;
      for (const l of [...linkListeners]) l({ url: d.url, action: d.action ?? null, data: d.data });
    });
  }

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
          // Dev builds register no service worker: do not wait on `ready` forever.
          const reg = await navigator.serviceWorker.getRegistration();
          if (!reg) return null;
          const existing = await reg.pushManager.getSubscription();
          const sub =
            existing ??
            (await reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
            }));
          const json = sub.toJSON();
          await sendSubscriptionToServer(json);
          return json;
        } catch {
          return null;
        }
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
