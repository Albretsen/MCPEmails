/**
 * Browser-side events (public/ce.js -> POST /api/analytics/client-event ->
 * public.client_events). Pure parsing and masking, no I/O, so the route stays
 * thin and every rule here is unit-tested.
 *
 * The browser is untrusted: everything it sends is validated against a fixed
 * vocabulary, capped, and masked before it is stored. Nothing here can carry a
 * user id, an email address, a query string or a token into the table.
 */

export const CLIENT_EVENT_KINDS = [
  'page',
  'error',
  'rejection',
  'resource',
  'buy',
  'buy_stalled',
  'contact',
] as const;
export type ClientEventKind = (typeof CLIENT_EVENT_KINDS)[number];

/** At most this many events are accepted from one beacon. */
export const MAX_EVENTS_PER_BEACON = 10;
/** Request bodies above this are ignored whole. */
export const MAX_BODY_BYTES = 8_192;

export interface ClientEventRow {
  kind: ClientEventKind;
  path: string;
  detail: Record<string, string | number | boolean>;
  browser: string | null;
  signed_in: boolean;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Opaque tokens: long runs of url-safe characters (chat checkout links,
// invite tokens, session ids, Stripe ids).
const TOKEN = /[A-Za-z0-9_-]{20,}/g;

/** A path with no query or hash, ids and tokens masked, capped at 160. */
export function maskPath(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) return '/';
  let path = input;
  try {
    // Accept a full URL too; keep only its path.
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
  } catch {
    return '/';
  }
  path = path.split(/[?#]/)[0] || '/';
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(EMAIL, ':email').replace(UUID, ':id');
  // Any segment that is a long opaque token becomes :token.
  path = path
    .split('/')
    .map((seg) => (seg.length >= 20 && /^[A-Za-z0-9_-]+$/.test(seg) ? ':token' : seg))
    .join('/');
  return path.slice(0, 160);
}

/** Free text from the browser: emails, uuids and tokens masked, capped. */
export function maskText(input: unknown, max: number): string | null {
  if (typeof input !== 'string') return null;
  const text = input
    .replace(EMAIL, ':email')
    .replace(UUID, ':id')
    .replace(TOKEN, ':token')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0 ? text.slice(0, max) : null;
}

/** A script URL reduced to its path on our own origin, or "external". */
export function maskSource(input: unknown): string | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  try {
    const url = new URL(input, 'https://mcpemails.com');
    const ours = /(^|\.)mcpemails\.com$/.test(url.hostname) || url.hostname === 'localhost';
    if (!ours) return `external:${url.hostname.slice(0, 60)}`;
    return maskPath(url.pathname);
  } catch {
    return null;
  }
}

/**
 * Coarse browser label from a user agent ("chrome/macos", "safari/ios/m").
 * `bot` is true for crawlers, headless browsers and monitors, whose events
 * are dropped.
 */
export function browserFromUserAgent(ua: string | null | undefined): { label: string | null; bot: boolean } {
  if (!ua) return { label: null, bot: false };
  if (/bot|crawl|spider|slurp|headless|lighthouse|pingdom|uptime|monitor|preview|python|curl|wget|node-fetch|axios/i.test(ua)) {
    return { label: null, bot: true };
  }
  const family = /Edg\//.test(ua)
    ? 'edge'
    : /OPR\//.test(ua)
      ? 'opera'
      : /SamsungBrowser/.test(ua)
        ? 'samsung'
        : /Firefox\/|FxiOS/.test(ua)
          ? 'firefox'
          : /CriOS|Chrome\//.test(ua)
            ? 'chrome'
            : /Safari\//.test(ua)
              ? 'safari'
              : 'other';
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'ios'
    : /Android/.test(ua)
      ? 'android'
      : /Windows/.test(ua)
        ? 'windows'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macos'
          : /Linux|CrOS/.test(ua)
            ? 'linux'
            : 'other';
  const mobile = /Mobi|iPhone|Android.*Mobile/.test(ua) ? '/m' : '';
  return { label: `${family}/${os}${mobile}`, bot: false };
}

function isKind(value: unknown): value is ClientEventKind {
  return typeof value === 'string' && (CLIENT_EVENT_KINDS as readonly string[]).includes(value);
}

function smallInt(value: unknown, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), max) : null;
}

const LABELS = new Set([
  'personal',
  'pro',
  'business',
  'pass',
  'checkout_link',
  'signup_checkout',
  'chat_link',
  'plan_button',
  'mailto',
  'help',
  'support_form',
]);

/**
 * The rows to store for one beacon body, or [] when it is not a valid beacon.
 * Unknown fields are dropped, known ones capped and masked.
 */
export function parseClientEvents(
  body: unknown,
  context: { userAgent: string | null; signedIn: boolean },
): ClientEventRow[] {
  const { label: browser, bot } = browserFromUserAgent(context.userAgent);
  if (bot) return [];
  const list = Array.isArray((body as { e?: unknown } | null)?.e) ? (body as { e: unknown[] }).e : null;
  if (!list) return [];

  const rows: ClientEventRow[] = [];
  for (const raw of list.slice(0, MAX_EVENTS_PER_BEACON)) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    if (!isKind(e.k)) continue;

    const detail: Record<string, string | number | boolean> = {};
    const message = maskText(e.m, 300);
    if (message) detail.message = message;
    const source = maskSource(e.s);
    if (source) detail.source = source;
    const line = smallInt(e.l, 1_000_000);
    if (line !== null) detail.line = line;
    if (typeof e.t === 'string' && LABELS.has(e.t)) detail.target = e.t;
    if (typeof e.h === 'boolean') detail.hydrated = e.h;
    const width = smallInt(e.w, 10_000);
    if (width !== null) detail.width = width < 480 ? 'xs' : width < 768 ? 's' : width < 1200 ? 'm' : 'l';
    if (typeof e.g === 'string' && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(e.g)) detail.lang = e.g;
    const ms = smallInt(e.ms, 600_000);
    if (ms !== null) detail.ms = ms;

    rows.push({ kind: e.k, path: maskPath(e.p), detail, browser, signed_in: context.signedIn });
  }
  return rows;
}
