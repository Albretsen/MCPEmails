/**
 * Client IP for rate limiting, stored only as a keyed hash.
 *
 * Same extraction as the OAuth routes (app/api/oauth/token, register, revoke):
 * the first entry of x-forwarded-for, which Vercel sets to the real client.
 * x-real-ip is the fallback for other proxies.
 *
 * Hashed with HMAC(CSRF_SECRET, 'support-ip') so the table never holds a raw
 * address and the hash cannot be reversed by brute-forcing the IPv4 space
 * without the secret. Null when there is no IP or no usable secret; the IP
 * limits are then skipped and the per-email limits still apply.
 */
import { supportHmac } from '@/lib/support/signing';

export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return forwarded;
  return headers.get('x-real-ip')?.trim() || null;
}

export function hashSupportIp(ip: string | null): string | null {
  if (!ip) return null;
  const mac = supportHmac('support-ip', ip.toLowerCase());
  return mac ? mac.toString('base64url') : null;
}
