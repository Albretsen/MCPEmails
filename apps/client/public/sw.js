/* Service worker for app.mcpemails.com.
 *
 * Deliberately minimal: it does not cache any page or mail (the app's offline
 * story is the IndexedDB query cache, not an HTTP cache). It exists so Web
 * Push has somewhere to land. Registered only in production builds, by the
 * web platform adapter (src/platform/web.ts).
 *
 * Push payload contract (JSON), produced by the client-api edge function
 * (supabase/functions/client-api/push/notify.ts):
 *   { type: "new_mail", mode: "rich",    title: <sender>, body: <subject>,
 *     url, tag, inbox_id, count, unread }
 *   { type: "new_mail", mode: "private", title: "New mail",
 *     body: "<n> new messages in <mailbox>", url, tag, inbox_id, count, unread }
 *   { type: "test", title, body, url, tag }
 *   { type: "approval_required", title, body, url, tag, approval_id }
 *     (not sent by the server yet: an assistant run only happens while the app
 *      is open, where the approval is a card in the app.)
 * Both new_mail modes arrive with `title` and `body` ready to show; if either
 * is missing the text is rebuilt here from `count`, without inventing content.
 * The payload is encrypted to this browser (RFC 8291): the push service
 * relays it without being able to read it.
 *
 * WHEN THE APP IS OPEN AND VISIBLE the push is handed to the page
 *   { type: "push", payload }
 * and no system notification is shown: the page syncs at once and shows its
 * own toast if the mailbox is not the one on screen. Safari is the exception:
 * it withdraws a subscription that receives pushes without showing a
 * notification, so there the notification is always shown (silently when the
 * app is visible) as well as the page being told.
 *
 * Notification click -> the app. If a window is open it is focused and sent
 *   { type: "deep_link", url, action, data }
 * (handled in src/platform/web.ts -> deepLinks.onOpen -> src/app/route-sync.tsx,
 * which also starts a sync). Otherwise a new window is opened at `url`.
 *
 * Action ids ("approve", "review") match NOTIFICATION_ACTION in src/platform/types.ts.
 *
 * "Approve" never sends anything from here. It only tells the open app which
 * button was pressed; the app approves the send it is actually holding, and
 * only if the approval id matches. With no app window open, Approve behaves
 * like Review: it opens the draft, and nothing is sent until the user confirms
 * there. Unanswered means not sent.
 *
 * SHARED WITH THE PAGE through one Cache API store (names mirrored in
 * src/platform/web.ts): the API base URL and the PUBLIC VAPID key (for
 * `pushsubscriptionchange`), and the unread total (for the app badge).
 * Nothing secret, and no mail.
 */

const ICON = "/icon-192.png";
const SW_STORE = "mcpe-push";
const SW_CONFIG_URL = "/__push/config";
const SW_BADGE_URL = "/__push/badge";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

async function storeGet(url) {
  try {
    const cache = await caches.open(SW_STORE);
    const hit = await cache.match(url);
    return hit ? await hit.json() : null;
  } catch {
    return null;
  }
}

async function storePut(url, value) {
  try {
    const cache = await caches.open(SW_STORE);
    await cache.put(url, new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } }));
  } catch {
    /* no storage: the badge simply waits for the app to be opened */
  }
}

function readPayload(event) {
  if (!event.data) return {};
  try {
    const json = event.data.json();
    return json && typeof json === "object" ? json : {};
  } catch {
    return {};
  }
}

/** Only same-origin, in-app paths are ever opened. */
function safePath(url) {
  try {
    const u = new URL(typeof url === "string" ? url : "/", self.location.origin);
    return u.origin === self.location.origin ? u.pathname + u.search : "/";
  } catch {
    return "/";
  }
}

/** Title and body for a payload. The server sends both; this is the fallback. */
function textFor(data) {
  if (data.type === "approval_required") {
    return { title: data.title || "The assistant wants to send an email", body: data.body || "" };
  }
  if (data.type === "test") {
    return { title: data.title || "MCP Emails", body: data.body || "Notifications are working on this device." };
  }
  const count = Number.isFinite(data.count) && data.count > 0 ? Math.round(data.count) : 1;
  const fallback = count === 1 ? "1 new message" : `${count} new messages`;
  // "rich" (sender and subject) and "private" (a count and the mailbox name)
  // differ only in what the server put in `title` and `body`.
  return { title: data.title || "New mail", body: data.body || fallback };
}

/** Safari revokes a subscription whose pushes show nothing. Chromium and Firefox do not when a window is visible. */
function mustAlwaysNotify() {
  const ua = self.navigator.userAgent || "";
  return /Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\/|OPR\/|Android/.test(ua);
}

/** The app badge follows new mail while no window is open; the app sets the true total when it opens. */
async function bumpBadge(data) {
  if (data.type !== "new_mail" || typeof self.navigator.setAppBadge !== "function") return;
  const state = (await storeGet(SW_BADGE_URL)) || {};
  const inboxes = state.inboxes && typeof state.inboxes === "object" ? state.inboxes : {};
  const count = Number.isFinite(data.count) && data.count > 0 ? Math.round(data.count) : 1;
  const known = typeof data.inbox_id === "string" ? inboxes[data.inbox_id] : undefined;
  // The mailbox's own unread count when the server sent one, else just "count more".
  const delta = Number.isFinite(data.unread) && Number.isFinite(known) ? data.unread - known : count;
  const total = Math.max(0, (Number.isFinite(state.total) ? state.total : 0) + delta);
  if (typeof data.inbox_id === "string" && Number.isFinite(data.unread)) inboxes[data.inbox_id] = data.unread;
  await storePut(SW_BADGE_URL, { total, inboxes });
  try {
    if (total > 0) await self.navigator.setAppBadge(total);
    else await self.navigator.clearAppBadge();
  } catch {
    /* not allowed in this context */
  }
}

async function onPush(event) {
  const data = readPayload(event);
  const approval = data.type === "approval_required";
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const visible = windows.filter((c) => c.visibilityState === "visible");

  // The open app hears about it first: it syncs and decides on an in-app toast.
  for (const client of visible) client.postMessage({ type: "push", payload: data });

  const always = mustAlwaysNotify();
  // An approval request is always shown: it needs an answer.
  if (visible.length > 0 && !approval && !always) return;

  if (visible.length === 0) await bumpBadge(data);

  const { title, body } = textFor(data);
  const options = {
    body,
    tag: data.tag || (approval && data.approval_id ? `approval-${data.approval_id}` : undefined),
    icon: ICON,
    badge: ICON,
    data: {
      url: safePath(data.url),
      type: data.type || "new_mail",
      approval_id: data.approval_id || null,
      inbox_id: typeof data.inbox_id === "string" ? data.inbox_id : null,
    },
  };
  if (data.type === "new_mail" && options.tag) {
    // One notification per mailbox: a newer one replaces it, and alerts again.
    options.renotify = true;
  }
  // Shown only because Safari requires it: no sound over the app that is already showing the mail.
  if (visible.length > 0 && always && !approval) options.silent = true;
  if (approval) {
    options.requireInteraction = true;
    options.actions = [
      { action: "approve", title: "Approve" },
      { action: "review", title: "Review" },
    ];
  }
  await self.registration.showNotification(title, options);
}

self.addEventListener("push", (event) => {
  event.waitUntil(onPush(event));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = safePath(data.url);
  const message = { type: "deep_link", url, action: event.action || null, data };
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Prefer a window that is already visible.
      const client = all.find((c) => c.visibilityState === "visible") || all[0];
      if (client) {
        client.postMessage(message);
        if ("focus" in client) {
          try {
            await client.focus();
          } catch {
            /* focus can be refused; the message was still delivered */
          }
        }
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/* The browser replaced (or dropped) the subscription, possibly with no page
 * open and so with no session token to hand. Two paths, both safe to run:
 *
 *  1. Tell any open page ({ type: "push_subscription_changed" }): it
 *     re-registers through the signed-in route. The page also does this by
 *     itself every time it loads, so a missed event heals at the next visit.
 *  2. With no page: POST /push/resubscribe with the OLD subscription's
 *     endpoint and auth secret plus the new subscription. The old auth secret
 *     is the proof: only this browser and the server ever held it (the push
 *     service does not). The route can only swap that one row in place.
 *     No token is stored in, or readable by, the service worker.
 */
async function onSubscriptionChange(event) {
  const config = await storeGet(SW_CONFIG_URL);
  let next = event.newSubscription || null;
  try {
    if (!next) next = await self.registration.pushManager.getSubscription();
    if (!next && config && config.vapidPublicKey) {
      next = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey),
      });
    }
  } catch {
    next = null;
  }

  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) client.postMessage({ type: "push_subscription_changed" });
  if (windows.length > 0 || !next) return;

  const old = event.oldSubscription ? event.oldSubscription.toJSON() : null;
  const oldAuth = old && old.keys ? old.keys.auth : null;
  if (!old || !old.endpoint || !oldAuth || !config || !config.apiBase) return;
  try {
    await fetch(`${config.apiBase}/push/resubscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ old_endpoint: old.endpoint, old_auth: oldAuth, subscription: next.toJSON() }),
    });
  } catch {
    /* offline: the page re-registers the next time the app is opened */
  }
}

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(onSubscriptionChange(event));
});
