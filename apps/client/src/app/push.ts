/* Web push, app side: the one place that connects the browser's push
 * subscription (behind the platform adapter) to the server's push routes.
 *
 *   enable()    from a click: ask permission, subscribe, POST /push/subscribe
 *   disable()   unsubscribe the browser, DELETE /push/subscribe
 *   sync()      every session load: if this device has notifications on, make
 *               sure the server has the CURRENT subscription for the CURRENT
 *               workspace. Idempotent, so it also repairs a subscription the
 *               browser rotated, new VAPID keys, and a workspace switch.
 *   signOut()   this browser must stop receiving this account's mail
 *               notifications: the server row is deleted while there is still
 *               a token, and the browser subscription is ended either way (so
 *               even with no token the push service starts answering "gone").
 *
 * Permission is only ever requested inside enable(), which the UI calls
 * straight from a button's click handler. Nothing here prompts by itself.
 *
 * A push that arrives while the app is visible is not shown by the system
 * (public/sw.js hands it to the page): `handleForegroundPush` syncs at once
 * and shows a toast only when the mailbox is not the one on screen.
 */

import type { NotificationPermissionState, PlatformAdapter, PushPayload } from "../platform";

export type PayloadMode = "rich" | "private";

export interface QuietHours {
  /** "22:00" */
  start: string;
  end: string;
  /** IANA name, e.g. "Europe/Oslo". */
  timezone: string;
}

export interface InboxPushPreference {
  inbox_id: string;
  enabled: boolean;
  payload_mode: PayloadMode;
  quiet_hours: QuietHours | null;
}

export interface PushPreferences {
  /** The server has its VAPID keys. */
  configured: boolean;
  /** This account's devices with notifications on, in this workspace. */
  subscribed_devices: number;
  inboxes: InboxPushPreference[];
}

export interface PushTestResult {
  devices: number;
  sent: number;
  failed: number;
  expired: number;
}

/** Why notifications can or cannot be turned on in this browser, right now. */
export type PushAvailability =
  | "ready"
  /** The browser has no Web Push at all. */
  | "unsupported"
  /** iPhone / iPad in a browser tab: push only reaches an installed app. */
  | "needs_install"
  /** The person (or a policy) blocked notifications for this site. */
  | "blocked"
  /** This build has no VAPID key, or no service worker (a dev build). */
  | "unavailable";

export interface PushState {
  availability: PushAvailability;
  permission: NotificationPermissionState;
  /** This browser holds a subscription and notifications are switched on here. */
  subscribed: boolean;
}

export type EnableResult = "enabled" | "blocked" | "dismissed" | "unavailable" | "failed";

export interface PushControllerDeps {
  platform: () => PlatformAdapter;
  /** A signed-in JSON request to client-api (ApiClient.request). */
  request: <T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) => Promise<T>;
  /** `{FUNCTIONS_URL}/client-api`. */
  apiBase: string;
  vapidPublicKey: string;
  /** The workspace requests are made in (part of what "already synced" means). */
  workspaceId: () => string | null;
}

export interface PushController {
  state(): Promise<PushState>;
  enable(): Promise<EnableResult>;
  disable(): Promise<void>;
  sync(options?: { force?: boolean }): Promise<void>;
  signOut(options: { authed: boolean }): Promise<void>;
  preferences(): Promise<PushPreferences>;
  savePreferences(inboxes: Array<Partial<InboxPushPreference> & { inbox_id: string }>): Promise<InboxPushPreference[]>;
  sendTest(): Promise<PushTestResult>;
}

/** "Notifications are on, on this device": survives reloads, REMOVED (not set
 *  to false) when turned off or on sign-out, so a signed-out browser keeps nothing. */
export const PUSH_ENABLED_KEY = "push.enabled";

export function createPushController(deps: PushControllerDeps): PushController {
  let synced: string | null = null;

  const availability = (): PushAvailability => {
    const platform = deps.platform();
    const n = platform.notifications;
    if (platform.isIOS && !platform.isStandalone) return "needs_install";
    if (!n.supported || !n.pushSupported) return "unsupported";
    if (!deps.vapidPublicKey) return "unavailable";
    if (n.permission() === "denied") return "blocked";
    return "ready";
  };

  const register = async (subscription: PushSubscriptionJSON): Promise<void> => {
    await deps.request("POST", "/push/subscribe", { subscription });
    synced = `${deps.workspaceId() ?? ""}|${subscription.endpoint ?? ""}`;
    // The service worker needs these to re-register a rotated subscription.
    void deps.platform().notifications.configureBackground({ apiBase: deps.apiBase, vapidPublicKey: deps.vapidPublicKey });
  };

  return {
    async state() {
      const platform = deps.platform();
      const a = availability();
      const permission = platform.notifications.permission();
      if (a !== "ready" || permission !== "granted") return { availability: a, permission, subscribed: false };
      const [enabled, current] = await Promise.all([
        platform.storage.get<boolean>(PUSH_ENABLED_KEY),
        platform.notifications.currentPushSubscription(),
      ]);
      return { availability: a, permission, subscribed: enabled === true && current !== null };
    },

    async enable() {
      const platform = deps.platform();
      const a = availability();
      if (a === "blocked") return "blocked";
      if (a !== "ready") return "unavailable";
      // The first await: this must be called from a click handler.
      const permission = platform.notifications.permission() === "granted"
        ? "granted"
        : await platform.notifications.requestPermission();
      if (permission === "denied") return "blocked";
      if (permission !== "granted") return "dismissed";
      const subscription = await platform.notifications.subscribePush(deps.vapidPublicKey);
      // No service worker (a dev build), or the push service refused.
      if (!subscription?.endpoint) return "unavailable";
      try {
        await register(subscription);
      } catch {
        // Not half on: a subscription the server does not know delivers nothing.
        await platform.notifications.unsubscribePush();
        return "failed";
      }
      await platform.storage.set(PUSH_ENABLED_KEY, true);
      return "enabled";
    },

    async disable() {
      const platform = deps.platform();
      await platform.storage.del(PUSH_ENABLED_KEY);
      synced = null;
      const subscription = await platform.notifications.unsubscribePush();
      if (subscription?.endpoint) {
        // If this fails the push service still reports the subscription gone
        // at the next send, and the server disables the row then.
        await deps.request("DELETE", "/push/subscribe", { endpoint: subscription.endpoint }).catch(() => {});
      }
    },

    async sync(options = {}) {
      const platform = deps.platform();
      if (availability() !== "ready" || platform.notifications.permission() !== "granted") return;
      if ((await platform.storage.get<boolean>(PUSH_ENABLED_KEY)) !== true) return;
      // Re-creates the subscription if the browser dropped it; never prompts
      // (permission is already granted).
      const subscription = await platform.notifications.subscribePush(deps.vapidPublicKey);
      if (!subscription?.endpoint) return;
      const key = `${deps.workspaceId() ?? ""}|${subscription.endpoint}`;
      if (!options.force && synced === key) return;
      await register(subscription).catch(() => {
        /* offline, or push not configured on the server: tried again next load */
      });
    },

    async signOut({ authed }) {
      const platform = deps.platform();
      synced = null;
      await platform.storage.del(PUSH_ENABLED_KEY);
      const subscription = await platform.notifications.currentPushSubscription();
      if (!subscription) return;
      if (authed && subscription.endpoint) {
        await deps.request("DELETE", "/push/subscribe", { endpoint: subscription.endpoint }).catch(() => {});
      }
      await platform.notifications.unsubscribePush();
    },

    preferences: () => deps.request<PushPreferences>("GET", "/push/preferences"),

    async savePreferences(inboxes) {
      const out = await deps.request<{ inboxes: InboxPushPreference[] }>("PUT", "/push/preferences", { inboxes });
      return out.inboxes;
    },

    sendTest: () => deps.request<PushTestResult>("POST", "/push/test", {}),
  };
}

export interface ForegroundPushDeps {
  /** Run the sync engine now. */
  syncNow: () => void;
  /** Re-register the subscription (the browser rotated it). */
  resync: () => void;
  /** Is this mailbox's inbox what the person is looking at. */
  isShowingInbox: (inboxId: string | undefined) => boolean;
  toast: (input: { text: string; action?: { label: string; run: () => void } }) => void;
  open: (url: string) => void;
}

/** One line for the in-app toast. Never more than the notification itself would have shown. */
export function toastTextFor(payload: PushPayload): string {
  const count = typeof payload.count === "number" && payload.count > 0 ? payload.count : 1;
  if (payload.mode === "rich" && count === 1 && payload.title) {
    return payload.body ? `${payload.title}: ${payload.body}` : `New mail from ${payload.title}`;
  }
  if (payload.mode === "private" && payload.body) return payload.body;
  return payload.title && count > 1 ? payload.title : count === 1 ? "1 new message" : `${count} new messages`;
}

/** A push the service worker handed to the visible page instead of showing it. */
export function handleForegroundPush(payload: PushPayload, deps: ForegroundPushDeps): void {
  if (payload.type === "subscription_changed") {
    deps.resync();
    return;
  }
  if (payload.type === "test") {
    deps.toast({ text: "Test notification received. Notifications are working on this device." });
    return;
  }
  if (payload.type !== "new_mail") return;
  // The list updates through the normal sync path (and its "do not move rows
  // under the pointer" rule): the push only says "look now".
  deps.syncNow();
  if (deps.isShowingInbox(payload.inbox_id)) return;
  const url = typeof payload.url === "string" ? payload.url : null;
  deps.toast({
    text: toastTextFor(payload),
    ...(url ? { action: { label: "Open", run: () => deps.open(url) } } : {}),
  });
}
