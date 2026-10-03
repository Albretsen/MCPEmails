/* Service worker for app.mcpemails.com.
 *
 * Deliberately minimal: it does not cache anything yet (the app's offline story
 * is the IndexedDB query cache, not an HTTP cache). It exists so Web Push has
 * somewhere to land. Registered only in production builds, by the web platform
 * adapter (src/platform/web.ts).
 *
 * Push payload contract (JSON), to be produced by the server later:
 *   { type: "new_mail",          title, body, url, tag }
 *   { type: "approval_required", title, body, url, tag, approval_id }
 *
 * Notification click -> the app. If a window is open it is focused and sent
 *   { type: "deep_link", url, action, data }
 * (handled in src/platform/web.ts -> deepLinks.onOpen -> src/app/deep-links.ts).
 * Otherwise a new window is opened at `url`.
 *
 * Action ids ("approve", "review") match NOTIFICATION_ACTION in src/platform/types.ts.
 *
 * "Approve" never sends anything from here. It only tells the open app which
 * button was pressed; the app approves the send it is actually holding, and
 * only if the approval id matches. With no app window open, Approve behaves
 * like Review: it opens the draft, and nothing is sent until the user confirms
 * there. Unanswered means not sent.
 */

const ICON = "/icon-192.png";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function readPayload(event) {
  if (!event.data) return {};
  try {
    const json = event.data.json();
    return json && typeof json === "object" ? json : {};
  } catch {
    return { body: event.data.text() };
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

self.addEventListener("push", (event) => {
  const data = readPayload(event);
  const approval = data.type === "approval_required";
  const title = data.title || (approval ? "The assistant wants to send an email" : "New mail");
  const options = {
    body: data.body || "",
    tag: data.tag || (approval && data.approval_id ? `approval-${data.approval_id}` : undefined),
    icon: ICON,
    badge: ICON,
    data: { url: safePath(data.url), type: data.type || "new_mail", approval_id: data.approval_id || null },
  };
  if (approval) {
    options.requireInteraction = true;
    options.actions = [
      { action: "approve", title: "Approve" },
      { action: "review", title: "Review" },
    ];
  }
  event.waitUntil(self.registration.showNotification(title, options));
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

/* A subscription can be rotated by the browser at any time.
 * TODO(push backend): re-subscribe with the VAPID key and send the new
 * subscription to the server. There is no endpoint to send it to yet. */
self.addEventListener("pushsubscriptionchange", () => {});
