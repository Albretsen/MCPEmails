/**
 * Carrying "which provider did this person come for" from a /connect/<slug>
 * landing page, through signup or login, to the first dashboard visit.
 *
 * WHY. A visitor reads /connect/ionos, presses "Connect IONOS free", signs up,
 * and used to land in a connect flow that had forgotten the word IONOS. Organic
 * signups from that page connected a mailbox at 6 of 12.
 *
 * WHAT THIS IS NOT. It is not attribution. The acquisition context
 * (src/lib/acquisition-context.mjs) records where a signup came from and is
 * written to the workspace. This is a UI hint with its own storage key: it is
 * never sent to the database, never read by analytics, and it is thrown away
 * the first time the dashboard looks at it.
 *
 * WHY THIS FILE IS SEPARATE FROM intent.mjs. The auth pages, the dashboard
 * shell and the session middleware all need to PASS a slug along, and none of
 * them needs to know whether it names a real provider. Deciding that takes the
 * provider registry, which is 80 KB of probe evidence. Keeping the carrying
 * half free of that import is what keeps the registry out of the /signup,
 * /login and /dashboard first-load bundles (scripts/bundle-budget.json). The
 * registry is consulted in intent.mjs, which the dashboard loads on demand and
 * only for someone who actually arrived with a hint.
 *
 * So nothing here is trusted. `connectIntentSlugShape` only says a string
 * COULD be a slug; `resolveConnectIntent` in intent.mjs is what decides.
 */

/** The query parameter, on /signup, /login and /dashboard alike. */
export const CONNECT_INTENT_PARAM = 'provider';

/** Its own key. Deliberately not a field on the acquisition record. */
export const CONNECT_INTENT_KEY = 'mcpe-connect-intent';

/** Envelope version. Bump it and old records are discarded, not misread. */
export const CONNECT_INTENT_VERSION = 1;

/**
 * One day, from the click and not sliding.
 *
 * Long enough for "pressed the button, went to find the password, came back
 * after lunch" and for an email confirmation opened in another tab. Short
 * enough that a hint nobody acted on does not open a connect modal on someone
 * a week later.
 */
export const CONNECT_INTENT_TTL_MS = 24 * 60 * 60 * 1000;

/** Every registry slug matches this; nothing else is ever stored or forwarded. */
const SLUG_SHAPE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** The value if it is shaped like a provider slug, otherwise null. */
export function connectIntentSlugShape(value) {
  return typeof value === 'string' && SLUG_SHAPE.test(value) ? value : null;
}

/**
 * `path` with the hint appended, or `path` unchanged when there is no hint.
 *
 * Takes and returns a same-origin relative path, because that is what every
 * caller holds (`/dashboard?firstrun=1`, the `next` of an OAuth round trip).
 * A slug is the only thing this ever adds to a URL.
 */
export function withConnectIntent(path, slug) {
  const clean = connectIntentSlugShape(slug);
  if (!clean) return path;
  const hashAt = path.indexOf('#');
  const hash = hashAt === -1 ? '' : path.slice(hashAt);
  const beforeHash = hashAt === -1 ? path : path.slice(0, hashAt);
  const queryAt = beforeHash.indexOf('?');
  const pathname = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const params = new URLSearchParams(queryAt === -1 ? '' : beforeHash.slice(queryAt + 1));
  params.set(CONNECT_INTENT_PARAM, clean);
  return `${pathname}?${params.toString()}${hash}`;
}

// Safari private mode, blocked site data and a full quota all throw on plain
// property access, so nothing here touches a storage object outside try/catch.
function safeGet(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeRemove(storage, key) {
  try {
    storage?.removeItem(key);
  } catch {}
}

/**
 * `window.localStorage`, or null where even reading the property throws.
 *
 * Local rather than session storage because the hint has to survive an email
 * confirmation link opening in a new tab, which session storage does not.
 */
export function connectIntentStorage(win = globalThis.window) {
  try {
    return win?.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Remember the hint. Returns false when it could not be stored, which is fine. */
export function rememberConnectIntent(storage, slug, now = Date.now()) {
  const clean = connectIntentSlugShape(slug);
  if (!clean) return false;
  try {
    if (!storage) return false;
    storage.setItem(
      CONNECT_INTENT_KEY,
      JSON.stringify({ v: CONNECT_INTENT_VERSION, slug: clean, at: now }),
    );
    return true;
  } catch {
    return false;
  }
}

/** The stored slug if there is a live, well-formed record; null otherwise. */
export function readStoredConnectIntent(storage, now = Date.now()) {
  const raw = safeGet(storage, CONNECT_INTENT_KEY);
  if (typeof raw !== 'string' || raw === '') return null;
  let record = null;
  try {
    record = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!record || typeof record !== 'object' || record.v !== CONNECT_INTENT_VERSION) return null;
  if (typeof record.at !== 'number' || !Number.isFinite(record.at)) return null;
  const age = now - record.at;
  if (age < 0 || age >= CONNECT_INTENT_TTL_MS) return null;
  return connectIntentSlugShape(record.slug);
}

export function clearConnectIntent(storage) {
  safeRemove(storage, CONNECT_INTENT_KEY);
}

/**
 * Read the hint and spend it, in one step.
 *
 * The link wins over storage: it is the more recent and the more explicit of
 * the two, and it is the only one that exists when site data is blocked.
 *
 * Whatever is found, the stored record is removed, including when it is stale,
 * malformed or names nothing. That is the "never shown again" rule: a hint is
 * looked at once, by the first dashboard that sees it, and a second visit finds
 * nothing. Stripping the parameter from the address bar is the caller's job
 * (`withoutConnectIntent`), since only the caller owns the history entry.
 *
 * Returns a slug-shaped string or null. It is still not validated.
 */
export function takeConnectIntent({ search = '', storage = null, now = Date.now() } = {}) {
  let fromUrl = null;
  try {
    fromUrl = connectIntentSlugShape(new URLSearchParams(search).get(CONNECT_INTENT_PARAM));
  } catch {
    fromUrl = null;
  }
  const fromStorage = readStoredConnectIntent(storage, now);
  clearConnectIntent(storage);
  return fromUrl ?? fromStorage;
}

/** `href` with the hint parameter removed, for `history.replaceState`. */
export function withoutConnectIntent(href) {
  const url = new URL(href);
  url.searchParams.delete(CONNECT_INTENT_PARAM);
  return url.toString();
}
