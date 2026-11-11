// ---------------------------------------------------------------------------
// "How did you hear about MCPEmails?": the one self-reported attribution
// question, asked once per workspace on the dashboard Overview after its first
// inbox connects (components/dashboard/HeardAboutCard.jsx).
//
// One click answers, one click dismisses, and either one ends it for good:
// workspaces.heard_about_at is stamped on both, and the card only shows while
// it is NULL (migration 20261111150000_heard_about.sql). Plain .mjs so the
// route, the component and the node:test suites share one copy.
// ---------------------------------------------------------------------------

/**
 * The option ids, in the order the card shows them. Must equal the CHECK on
 * workspaces.heard_about (heard-about.test.mjs reads the migration).
 */
export const HEARD_ABOUT_OPTIONS = Object.freeze([
  'chatgpt',
  'claude',
  'gemini',
  'google_search',
  'colleague',
  'directory',
  'video',
  'forum',
  'other',
]);

/** Longest "Other" text kept, in characters. Matches the column CHECK. */
export const HEARD_ABOUT_OTHER_MAX = 200;

/** True for a known option id. */
export function isHeardAboutOption(value) {
  return typeof value === 'string' && HEARD_ABOUT_OPTIONS.includes(value);
}

/**
 * Validates a POST body.
 *
 *   { dismiss: true }                      -> { ok, kind: 'dismiss' }
 *   { answer: '<id>' }                     -> { ok, kind: 'answer', answer, other: null }
 *   { answer: 'other', other: '<text>' }   -> other trimmed, empty -> null
 *
 * Text longer than HEARD_ABOUT_OTHER_MAX is refused rather than cut, so what is
 * stored is what the person typed. `other` on any answer but 'other' is
 * dropped. Anything else is { ok: false }.
 */
export function parseHeardAboutBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid_body' };
  if (body.dismiss === true) {
    if (body.answer !== undefined) return { ok: false, error: 'invalid_body' };
    return { ok: true, kind: 'dismiss' };
  }
  if (!isHeardAboutOption(body.answer)) return { ok: false, error: 'invalid_answer' };
  if (body.answer !== 'other') return { ok: true, kind: 'answer', answer: body.answer, other: null };
  if (body.other !== undefined && body.other !== null && typeof body.other !== 'string') {
    return { ok: false, error: 'invalid_other' };
  }
  const other = typeof body.other === 'string' ? body.other.replace(/\s+/g, ' ').trim() : '';
  if (other.length > HEARD_ABOUT_OTHER_MAX) return { ok: false, error: 'other_too_long' };
  return { ok: true, kind: 'answer', answer: 'other', other: other || null };
}

/**
 * Whether the Overview shows the card.
 *
 *   pending     the server's read: true only when heard_about_at is NULL and
 *               the column could be read. A failed read is false, so a
 *               missing migration never shows a card that cannot be saved.
 *   inboxCount  live inbox array length; the question waits for the first one.
 *   isOwner     only the person who set the workspace up is asked: an invited
 *               member heard about it from whoever invited them.
 *   closed      answered or dismissed in this page view.
 */
export function shouldShowHeardAbout({ pending = false, inboxCount = 0, isOwner = false, closed = false } = {}) {
  return pending === true && isOwner === true && closed !== true && inboxCount > 0;
}
