/**
 * First touch acquisition storage: the rules, with no browser attached.
 *
 * This lives beside AcquisitionCapture.jsx rather than inside it because the
 * test runner here is plain `node --test` with no DOM and no JSX loader. Every
 * function below takes a storage-like object and an explicit `now` instead of
 * reaching for `window`, so the expiry and first-touch rules can be driven
 * directly, including the case where the storage itself throws.
 */

import {
  acquisitionFromLocation,
  sanitizedAcquisition,
} from '../../src/lib/acquisition-context.mjs';

export const ACQUISITION_KEY = 'mcpe-acquisition';

/** Envelope version. Bump it and old records are discarded, not misread. */
export const ACQUISITION_VERSION = 1;

/**
 * 30 days, measured from capture and deliberately NOT sliding.
 *
 * The record used to live in sessionStorage, so a visitor who read a blog post
 * on Monday and signed up on Thursday was filed as `direct`, which understates
 * every content and directory channel. A sliding window would swing the other
 * way: a visitor who keeps coming back would credit a first touch from months
 * ago forever. Expiry from `capturedAt` keeps the claim honest.
 */
export const ACQUISITION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Safari private mode, blocked site data and a full quota all throw on plain
// property access, so nothing here touches a storage object outside try/catch.
function safeGet(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeSet(storage, key, value) {
  try {
    storage?.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeRemove(storage, key) {
  try {
    storage?.removeItem(key);
  } catch {}
}

function parseObject(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The stored first touch, or null when there is none, it has expired, or the
 * value was hand edited into something we do not recognise. The result always
 * goes through `sanitizedAcquisition`, so a value typed into devtools can never
 * inject a category outside the allowlist.
 */
export function readStoredAcquisition(storage, now = Date.now()) {
  const envelope = parseObject(safeGet(storage, ACQUISITION_KEY));
  if (!envelope) return null;
  if (envelope.v !== ACQUISITION_VERSION) return null;
  if (!Number.isFinite(envelope.capturedAt)) return null;
  // A clock that moved backwards leaves a negative age. That is not an expiry,
  // so only a record that is genuinely old enough is dropped.
  if (now - envelope.capturedAt >= ACQUISITION_TTL_MS) return null;
  if (!envelope.value || typeof envelope.value !== 'object') return null;
  return sanitizedAcquisition(envelope.value);
}

/**
 * The pre-30-day record: a bare sanitized value under the same key in
 * sessionStorage. Visitors mid-session at deploy time still have one, and it is
 * the only attribution they have, so it is read rather than dropped.
 */
export function readLegacyAcquisition(storage) {
  const value = parseObject(safeGet(storage, ACQUISITION_KEY));
  if (!value) return null;
  return sanitizedAcquisition(value);
}

/** Write the envelope. Returns false when storage refused it. */
export function writeAcquisition(storage, value, now = Date.now()) {
  return safeSet(
    storage,
    ACQUISITION_KEY,
    JSON.stringify({ v: ACQUISITION_VERSION, capturedAt: now, value: sanitizedAcquisition(value) }),
  );
}

/**
 * Resolve the acquisition context for this page view and persist it.
 *
 * Order matters: an unexpired record always wins (first touch), then a legacy
 * session record is promoted, and only a visitor with neither is captured
 * fresh. Returns `{ value, origin }` where origin is one of 'existing',
 * 'legacy' or 'fresh'. It never throws.
 */
export function captureAcquisition({ local, session, url, referrer = null, now = Date.now() }) {
  const existing = readStoredAcquisition(local, now);
  if (existing) return { value: existing, origin: 'existing' };

  const legacy = readLegacyAcquisition(session);
  if (legacy) {
    // Only forget the session copy once the durable one is actually written,
    // otherwise a storage that refuses writes would lose the attribution.
    if (writeAcquisition(local, legacy, now)) safeRemove(session, ACQUISITION_KEY);
    return { value: legacy, origin: 'legacy' };
  }

  const fresh = url ? acquisitionFromLocation(url, referrer) : sanitizedAcquisition({});
  writeAcquisition(local, fresh, now);
  return { value: fresh, origin: 'fresh' };
}
