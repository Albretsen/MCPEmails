/**
 * HMAC helpers for the support system, keyed on the existing `CSRF_SECRET`.
 *
 * One secret, several uses, so every use carries its own label: a value
 * signed as a form token can never verify as a preview token or collide with
 * an IP hash, because the label is part of the MAC input. Labels in use:
 *
 *   'support-preview'  release-gate.ts, the staff preview cookie
 *   'support-form'     form-token.ts, the signed render timestamp
 *   'support-ip'       ip.ts, the stored client IP hash
 *
 * FAIL CLOSED. A missing or malformed secret returns null rather than
 * throwing, and every caller treats null as "does not verify". The secret is
 * read at call time, never at module load (same as src/lib/oauth/csrf.ts).
 */
import crypto from 'node:crypto';

export type SupportHmacLabel = 'support-preview' | 'support-form' | 'support-ip';

function key(): Buffer | null {
  const hex = process.env.CSRF_SECRET;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

/** HMAC-SHA256 over `label \n data`, or null when the secret is unusable. */
export function supportHmac(label: SupportHmacLabel, data: string): Buffer | null {
  const k = key();
  if (!k) return null;
  return crypto.createHmac('sha256', k).update(`${label}\n${data}`).digest();
}

/** Timing-safe check of a base64url MAC. False on any malformed input. */
export function verifySupportHmac(label: SupportHmacLabel, data: string, macB64u: string): boolean {
  const expected = supportHmac(label, data);
  if (!expected) return false;
  let given: Buffer;
  try {
    given = Buffer.from(macB64u, 'base64url');
  } catch {
    return false;
  }
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}
