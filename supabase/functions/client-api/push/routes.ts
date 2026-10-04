// ---------------------------------------------------------------------------
// The push routes. Wired into the router by ../app.ts, which has already done
// CORS, and for the signed-in routes the bearer token, the workspace gate and
// the rate limit, before anything here runs.
//
//   SIGNED IN (bearer token, web_client_enabled workspace):
//   POST   /push/subscribe     { subscription: PushSubscriptionJSON }
//   DELETE /push/subscribe     { endpoint }
//   GET    /push/preferences   -> { configured, subscribed_devices, inboxes: [...] }
//   PUT    /push/preferences   { inboxes: [{ inbox_id, enabled?, payload_mode?, quiet_hours? }] }
//   POST   /push/test          a fixed test message to the caller's OWN devices
//
//   NO USER TOKEN:
//   POST   /push/resubscribe   { old_endpoint, old_auth, subscription }
//          The service worker's `pushsubscriptionchange`: the browser rotated
//          a subscription while no page (and so no session token) was around.
//          Proof of ownership is the OLD subscription's auth secret, which
//          only that browser and this database have ever held; the push
//          service never sees it. It can only swap a row's endpoint and keys
//          in place, for the same person and workspace.
//   POST   /push/dispatch      X-Dispatch-Secret only (pg_cron). See dispatch.ts.
//   POST   /push/provider/gmail  501: the Gmail Pub/Sub entry point is not built.
//
// A subscription's endpoint is only ever stored if it is on a known push
// service (webpush.ts `isAllowedPushEndpoint`): this function POSTs to it.
// ---------------------------------------------------------------------------

import { ApiError, invalidRequest } from "../errors.ts";
import { isValidTimezone, TEST_PAYLOAD } from "./notify.ts";
import type { PayloadMode, PreferenceRow, PushStore } from "./store.ts";
import { isAllowedPushEndpoint, isAuthSecret, isP256PublicKey, type PushSender } from "./webpush.ts";

export type PushMethod = "GET" | "POST" | "PUT" | "DELETE";

/** route -> methods, and whether a signed-in user is required. */
export const PUSH_ROUTES: Record<string, { methods: PushMethod[]; auth: "user" | "none" }> = {
  "/push/subscribe": { methods: ["POST", "DELETE"], auth: "user" },
  "/push/preferences": { methods: ["GET", "PUT"], auth: "user" },
  "/push/test": { methods: ["POST"], auth: "user" },
  "/push/resubscribe": { methods: ["POST"], auth: "none" },
  "/push/dispatch": { methods: ["POST"], auth: "none" },
  "/push/provider/gmail": { methods: ["POST"], auth: "none" },
};

/** Subscriptions one person may hold, over all workspaces and browsers. */
export const MAX_SUBSCRIPTIONS_PER_USER = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface ParsedSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A `PushSubscription.toJSON()` document, checked field by field. */
export function parseSubscription(raw: unknown): ParsedSubscription {
  if (!isRecord(raw)) throw invalidRequest("'subscription' must be a push subscription.");
  const keys = isRecord(raw["keys"]) ? raw["keys"] : {};
  const endpoint = raw["endpoint"];
  if (!isAllowedPushEndpoint(endpoint)) {
    throw invalidRequest("This browser's push service is not supported.");
  }
  if (!isP256PublicKey(keys["p256dh"]) || !isAuthSecret(keys["auth"])) {
    throw invalidRequest("The push subscription's keys are not valid.");
  }
  return { endpoint, p256dh: keys["p256dh"], auth: keys["auth"] };
}

/**
 * "Chrome on macOS": a label for a future device list. Built from a fixed
 * vocabulary, so nothing from the header itself is stored.
 */
export function deviceLabel(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const ua = userAgent.slice(0, 400);
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
    ? "Opera"
    : /Firefox\//.test(ua)
    ? "Firefox"
    : /Chrome\//.test(ua)
    ? "Chrome"
    : /Safari\//.test(ua)
    ? "Safari"
    : null;
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
    ? "Android"
    : /Mac OS X|Macintosh/.test(ua)
    ? "macOS"
    : /Windows/.test(ua)
    ? "Windows"
    : /Linux|CrOS/.test(ua)
    ? "Linux"
    : null;
  if (!browser && !os) return null;
  return `${browser ?? "Browser"} on ${os ?? "unknown"}`;
}

function minutes(text: unknown, field: string): number {
  const match = typeof text === "string" ? HHMM_RE.exec(text) : null;
  if (!match) throw invalidRequest(`'${field}' must be a time such as "22:00".`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function hhmm(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

export interface PreferenceView {
  inbox_id: string;
  enabled: boolean;
  payload_mode: PayloadMode;
  quiet_hours: { start: string; end: string; timezone: string } | null;
}

const DEFAULT_PREFERENCE = { enabled: true, payload_mode: "rich" as PayloadMode };

function toView(inboxId: string, row: PreferenceRow | undefined): PreferenceView {
  return {
    inbox_id: inboxId,
    enabled: row?.enabled ?? DEFAULT_PREFERENCE.enabled,
    payload_mode: row?.payload_mode ?? DEFAULT_PREFERENCE.payload_mode,
    quiet_hours: row && row.quiet_start !== null && row.quiet_end !== null && row.quiet_timezone
      ? { start: hhmm(row.quiet_start), end: hhmm(row.quiet_end), timezone: row.quiet_timezone }
      : null,
  };
}

/** Constant-time comparison of two strings (via their SHA-256 digests, so length leaks nothing either). */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** May this request run the dispatcher. The secret header, and only that. */
export async function isDispatchAuthorized(req: Request, env: (name: string) => string | undefined): Promise<boolean> {
  const expected = env("DISPATCH_SECRET") ?? "";
  const given = req.headers.get("x-dispatch-secret") ?? "";
  // An unset secret must never match an absent header.
  if (expected.length === 0 || given.length === 0) return false;
  return await timingSafeEqual(expected, given);
}

export interface PushUserContext {
  userId: string;
  workspaceId: string;
  /** The workspace's mailboxes (ids only are used). */
  inboxIds(): Promise<string[]>;
  userAgent: string | null;
}

export interface PushRoutesDeps {
  store: PushStore;
  /** null when the VAPID secrets are not set. */
  sender: PushSender | null;
}

const notConfigured = () =>
  new ApiError(503, "provider_error", "Notifications are not available yet.", { toolCode: "push_not_configured" });

/** The signed-in routes. Returns the response body; throws ApiError. */
export async function handlePushUserRoute(
  deps: PushRoutesDeps,
  route: string,
  method: string,
  body: unknown,
  ctx: PushUserContext,
): Promise<{ body: unknown; fields: Record<string, unknown> }> {
  if (route === "/push/subscribe" && method === "POST") {
    if (!deps.sender) throw notConfigured();
    const subscription = parseSubscription(isRecord(body) ? body["subscription"] : undefined);
    const existing = await deps.store.subscriptionByEndpoint(subscription.endpoint);
    if (!existing || existing.user_id !== ctx.userId) {
      const held = await deps.store.countSubscriptions(ctx.userId);
      if (held >= MAX_SUBSCRIPTIONS_PER_USER) {
        throw new ApiError(409, "conflict", "Too many devices have notifications on. Turn them off on one you no longer use.", {
          toolCode: "push_subscription_limit",
        });
      }
    }
    await deps.store.upsertSubscription({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      ...subscription,
      userAgent: deviceLabel(ctx.userAgent),
    });
    return { body: { subscribed: true }, fields: { push: "subscribe" } };
  }

  if (route === "/push/subscribe" && method === "DELETE") {
    const endpoint = isRecord(body) ? body["endpoint"] : undefined;
    if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > 2048) {
      throw invalidRequest("'endpoint' is required.");
    }
    const removed = await deps.store.deleteSubscription(ctx.userId, endpoint);
    return { body: { removed }, fields: { push: "unsubscribe", removed } };
  }

  if (route === "/push/preferences" && method === "GET") {
    const inboxIds = await ctx.inboxIds();
    const [rows, subscriptions] = await Promise.all([
      deps.store.preferences(ctx.userId, inboxIds),
      deps.store.subscriptions(ctx.userId, ctx.workspaceId),
    ]);
    const byInbox = new Map(rows.map((row) => [row.inbox_id, row]));
    return {
      body: {
        configured: deps.sender !== null,
        subscribed_devices: subscriptions.length,
        inboxes: inboxIds.map((id) => toView(id, byInbox.get(id))),
      },
      fields: { push: "preferences_get" },
    };
  }

  if (route === "/push/preferences" && method === "PUT") {
    const list = isRecord(body) ? body["inboxes"] : undefined;
    if (!Array.isArray(list) || list.length === 0 || list.length > 100) {
      throw invalidRequest("'inboxes' must be a list of 1 to 100 mailbox settings.");
    }
    const inboxIds = await ctx.inboxIds();
    const allowed = new Set(inboxIds);
    const current = new Map((await deps.store.preferences(ctx.userId, inboxIds)).map((row) => [row.inbox_id, row]));
    const next: PreferenceRow[] = [];
    for (const item of list) {
      if (!isRecord(item)) throw invalidRequest("Each entry of 'inboxes' must be an object.");
      const unknown = Object.keys(item).filter((k) => !["inbox_id", "enabled", "payload_mode", "quiet_hours"].includes(k));
      if (unknown.length > 0) throw invalidRequest("Unknown mailbox setting.");
      const inboxId = typeof item["inbox_id"] === "string" && UUID_RE.test(item["inbox_id"]) ? item["inbox_id"].toLowerCase() : null;
      // Same answer for "not a mailbox" and "not a mailbox of this workspace".
      if (!inboxId || !allowed.has(inboxId)) throw new ApiError(404, "inbox_not_found", "Inbox not found.");
      const before = current.get(inboxId);
      const row: PreferenceRow = {
        inbox_id: inboxId,
        enabled: before?.enabled ?? DEFAULT_PREFERENCE.enabled,
        payload_mode: before?.payload_mode ?? DEFAULT_PREFERENCE.payload_mode,
        quiet_start: before?.quiet_start ?? null,
        quiet_end: before?.quiet_end ?? null,
        quiet_timezone: before?.quiet_timezone ?? null,
      };
      if (item["enabled"] !== undefined) {
        if (typeof item["enabled"] !== "boolean") throw invalidRequest("'enabled' must be true or false.");
        row.enabled = item["enabled"];
      }
      if (item["payload_mode"] !== undefined) {
        if (item["payload_mode"] !== "rich" && item["payload_mode"] !== "private") {
          throw invalidRequest("'payload_mode' must be \"rich\" or \"private\".");
        }
        row.payload_mode = item["payload_mode"];
      }
      if (item["quiet_hours"] !== undefined) {
        const quiet = item["quiet_hours"];
        if (quiet === null) {
          row.quiet_start = row.quiet_end = row.quiet_timezone = null;
        } else {
          if (!isRecord(quiet)) throw invalidRequest("'quiet_hours' must be an object or null.");
          const zone = quiet["timezone"];
          if (typeof zone !== "string" || zone.length === 0 || zone.length > 64 || !isValidTimezone(zone)) {
            throw invalidRequest("'quiet_hours.timezone' must be a time zone such as \"Europe/Oslo\".");
          }
          row.quiet_start = minutes(quiet["start"], "quiet_hours.start");
          row.quiet_end = minutes(quiet["end"], "quiet_hours.end");
          row.quiet_timezone = zone;
        }
      }
      next.push(row);
    }
    await deps.store.savePreferences(ctx.userId, next);
    const saved = new Map(next.map((row) => [row.inbox_id, row]));
    return {
      body: { inboxes: inboxIds.map((id) => toView(id, saved.get(id) ?? current.get(id))) },
      fields: { push: "preferences_put", inboxes: next.length },
    };
  }

  if (route === "/push/test" && method === "POST") {
    const sender = deps.sender;
    if (!sender) throw notConfigured();
    // The caller's own active subscriptions in this workspace. Nobody else's, ever.
    const subscriptions = await deps.store.subscriptions(ctx.userId, ctx.workspaceId);
    const results = { sent: [] as string[], gone: [] as string[], failed: [] as string[] };
    await Promise.all(subscriptions.slice(0, MAX_SUBSCRIPTIONS_PER_USER).map(async (subscription) => {
      const outcome = await sender.send({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        payload: TEST_PAYLOAD,
        // A test that arrives a minute late is not a test.
        ttlSec: 60,
        urgency: "high",
      });
      (outcome.kind === "sent" ? results.sent : outcome.kind === "gone" ? results.gone : results.failed).push(subscription.id);
    }));
    await deps.store.recordPushResults(results).catch(() => {});
    return {
      body: { devices: subscriptions.length, sent: results.sent.length, failed: results.failed.length, expired: results.gone.length },
      fields: { push: "test", pushes_sent: results.sent.length, pushes_failed: results.failed.length, subscriptions_gone: results.gone.length },
    };
  }

  throw new ApiError(404, "not_found", "No such route.");
}

/** POST /push/resubscribe. See the header for why the old auth secret is the credential. */
export async function handleResubscribe(deps: PushRoutesDeps, body: unknown): Promise<{ rotated: true }> {
  // One answer for every refusal: an endpoint that is not on file and a wrong
  // secret must be indistinguishable.
  const refused = () => new ApiError(403, "forbidden", "This subscription cannot be updated.");
  if (!isRecord(body)) throw invalidRequest("Request body must be an object.");
  const oldEndpoint = body["old_endpoint"];
  const oldAuth = body["old_auth"];
  if (typeof oldEndpoint !== "string" || oldEndpoint.length > 2048 || typeof oldAuth !== "string" || oldAuth.length > 64) {
    throw refused();
  }
  const next = parseSubscription(body["subscription"]);
  const existing = await deps.store.subscriptionByEndpoint(oldEndpoint);
  // Compared even when there is no row, so both refusals take the same time.
  const matches = await timingSafeEqual(existing?.auth ?? "missing-subscription", oldAuth);
  if (!existing || !matches) throw refused();
  if (next.endpoint !== existing.endpoint && await deps.store.subscriptionByEndpoint(next.endpoint)) {
    // The page already registered the new subscription itself.
    return { rotated: true };
  }
  await deps.store.rotateSubscription(existing.id, next);
  return { rotated: true };
}
