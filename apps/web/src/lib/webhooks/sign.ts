import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signing, Node edition. The edge twin is
 * supabase/functions/client-api/webhooks/sign.ts; both are pinned to the same
 * known vector by their tests, so the test ping sent from here and the real
 * deliveries sent from the edge verify the same way.
 *
 *   MCPEmails-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + body)>
 *   MCPEmails-Event-Id:  evt_<32 hex>
 *
 * The HMAC key is the UTF-8 bytes of the whole secret, `whsec_` included.
 */

export const SIGNATURE_HEADER = 'MCPEmails-Signature';
export const EVENT_ID_HEADER = 'MCPEmails-Event-Id';
export const EVENT_TYPE_HEADER = 'MCPEmails-Event-Type';
export const SIGNATURE_TOLERANCE_SEC = 300;

export function hmacSha256Hex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

export function signatureHeader(secret: string, timestampSec: number, body: string): string {
  const t = Math.floor(timestampSec);
  return `t=${t},v1=${hmacSha256Hex(secret, `${t}.${body}`)}`;
}

/** What a receiver does; here so the docs example and the tests share one definition. */
export function verifySignature(
  header: string,
  secret: string,
  body: string,
  nowSec: number,
  toleranceSec = SIGNATURE_TOLERANCE_SEC,
): boolean {
  let t: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.trim().split('=', 2);
    if (k === 't' && /^\d{1,12}$/.test(v ?? '')) t = Number(v);
    if (k === 'v1' && /^[0-9a-f]{64}$/.test(v ?? '')) signatures.push(v);
  }
  if (t === null || signatures.length === 0) return false;
  if (Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = Buffer.from(hmacSha256Hex(secret, `${t}.${body}`));
  return signatures.some((s) => {
    const given = Buffer.from(s);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export function newEventId(): string {
  return `evt_${randomBytes(16).toString('hex')}`;
}

/** `whsec_` + 64 hex (256 bits). The prefix kept in clear is the first 12 characters. */
export function generateWebhookSecret(): { secret: string; prefix: string } {
  const secret = `whsec_${randomBytes(32).toString('hex')}`;
  return { secret, prefix: secret.slice(0, 12) };
}
