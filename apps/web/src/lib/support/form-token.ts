/**
 * The contact form's signed render timestamp.
 *
 * /help issues one when it renders; the ticket API checks it. A bot that
 * posts straight to the API has none, and one that loads the page and submits
 * at once is faster than any person can type a message. Not a CAPTCHA, just
 * cheap friction on top of the honeypot and the rate limits.
 *
 * Format: `<issuedMs>.<base64url HMAC>` under the 'support-form' label.
 */
import { supportHmac, verifySupportHmac } from '@/lib/support/signing';

/** Faster than this from render to submit is a bot. Silently dropped. */
export const FORM_MIN_FILL_MS = 3_000;
/** Older than this the page is stale; the visitor is asked to reload. */
export const FORM_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Tolerated clock skew for a token "from the future" (multi-region). */
const FUTURE_SKEW_MS = 60_000;

export type FormTokenCheck = 'ok' | 'too_fast' | 'invalid';

/** Signed render timestamp. Returns '' when the secret is unusable (the submit then fails as invalid_form_token). */
export function issueSupportFormToken(nowMs: number = Date.now()): string {
  const issued = String(Math.floor(nowMs));
  const mac = supportHmac('support-form', issued);
  return mac ? `${issued}.${mac.toString('base64url')}` : '';
}

export function checkSupportFormToken(token: unknown, nowMs: number = Date.now()): FormTokenCheck {
  if (typeof token !== 'string' || token.length > 200) return 'invalid';
  const match = /^(\d{1,16})\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!match) return 'invalid';
  if (!verifySupportHmac('support-form', match[1], match[2])) return 'invalid';
  const issued = Number(match[1]);
  const age = nowMs - issued;
  if (age < -FUTURE_SKEW_MS || age > FORM_MAX_AGE_MS) return 'invalid';
  if (age < FORM_MIN_FILL_MS) return 'too_fast';
  return 'ok';
}
