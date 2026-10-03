/* PlatformAdapter: everything that differs between a browser tab, an installed
 * PWA and a future Electron shell sits behind this one interface. App code
 * calls `getPlatform()` and never touches `Notification`, `navigator.*` or
 * storage APIs directly. */

export type NotificationPermissionState = "default" | "granted" | "denied" | "unsupported";

export interface AppNotification {
  title: string;
  body?: string;
  /** Replaces an earlier notification with the same tag. */
  tag?: string;
  /** In-app path to open when it is clicked, e.g. "/all/inbox/gmail%3Amaya". */
  url?: string;
  data?: Record<string, unknown>;
  /** Action buttons. Only service-worker notifications can show them; ignored elsewhere. */
  actions?: { action: string; title: string }[];
  /** Stay on screen until the user acts (approval requests). */
  requireInteraction?: boolean;
}

/** Notification action ids. Keep in sync with public/sw.js. */
export const NOTIFICATION_ACTION = { approve: "approve", review: "review" } as const;

export type InstallOutcome = "accepted" | "dismissed" | "unavailable";

export interface DeepLink {
  /** In-app path + search, e.g. "/all/inbox?q=invoice". */
  url: string;
  /** Notification action button that was pressed, if any. */
  action: string | null;
  data?: Record<string, unknown>;
}

export interface PlatformAdapter {
  readonly kind: "web" | "pwa" | "electron";
  /** Running as an installed app (Home Screen, dock), not in a browser tab. */
  readonly isStandalone: boolean;
  /** iPhone or iPad. For install instructions only: capabilities are feature-detected. */
  readonly isIOS: boolean;

  notifications: {
    readonly supported: boolean;
    /** Web Push can work in this context. False in iPhone Safari until the
     *  app is added to the Home Screen. */
    readonly pushSupported: boolean;
    permission(): NotificationPermissionState;
    /** Must be called from a user gesture (required on iOS). */
    requestPermission(): Promise<NotificationPermissionState>;
    show(n: AppNotification): Promise<void>;
    /** Web Push subscription for the server to deliver to. Null when
     *  unsupported, denied, or no VAPID key is configured. The key defaults to
     *  VITE_VAPID_PUBLIC_KEY. */
    subscribePush(vapidPublicKey?: string): Promise<PushSubscriptionJSON | null>;
  };

  /** Small async key-value store for app state that should outlive a reload
   *  (query cache, preferences). Never throws: failures resolve to undefined. */
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T): Promise<void>;
    del(key: string): Promise<void>;
  };

  /** App icon badge (unread count). No-op where unsupported. */
  badge: {
    readonly supported: boolean;
    set(count: number): Promise<void>;
    clear(): Promise<void>;
  };

  deepLinks: {
    /** Fires when the app is asked to open a path (notification click, protocol handler). */
    onOpen(listener: (link: DeepLink) => void): () => void;
    /** Absolute URL for an in-app path, for sharing or notifications. */
    buildUrl(path: string): string;
  };

  haptics: {
    /** A short tick for a committed gesture (swipe action, long-press select). */
    tick(): void;
  };

  /** Connectivity, from the host's online / offline events. */
  network: {
    isOnline(): boolean;
    subscribe(listener: () => void): () => void;
  };

  /** "Install app", where the host offers it (beforeinstallprompt on Chromium). */
  install: {
    /** A prompt is ready and can be shown from a user gesture. */
    canPrompt(): boolean;
    prompt(): Promise<InstallOutcome>;
    /** Fires when canPrompt() changes. */
    subscribe(listener: () => void): () => void;
  };

  /** Registers background delivery (the service worker on web). Production only. */
  registerBackground(): Promise<void>;
}
