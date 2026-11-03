/**
 * Client IP for rate limiting, stored only as a keyed hash.
 *
 * Same extraction as the OAuth routes (app/api/oauth/token, register, revoke):
 * the first entry of x-forwarded-for, which Vercel sets to the real client.
 * x-real-ip is the fallback for other proxies.
 *
 * Hashed with HMAC(CSRF_SECRET, 'support-ip') so the table never holds a raw
 * address and the hash cannot be reversed by brute-forcing the IPv4 space
 * without the secret. IPv6 is hashed as its /64 (normaliseIp below). Null when there is no IP or no usable secret; the IP
 * limits are then skipped and the per-email limits still apply.
 */
import { supportHmac } from '@/lib/support/signing';

export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return forwarded;
  return headers.get('x-real-ip')?.trim() || null;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function ipv6Groups(addr: string): number[] | null {
  let s = addr;
  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two hex groups.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!IPV4.test(tail)) return null;
    const [a, b, c, d] = tail.split('.').map(Number);
    s = `${s.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const groups: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    groups.push(parseInt(g, 16));
  }
  return groups;
}

/**
 * The key an address is rate limited and counted under.
 *
 * IPv4 is the address itself (lowercased, so stored hashes stay the same as
 * before this function existed). IPv6 is its /64: one subscriber line usually
 * gets a whole /64, so rotating within it must not reset the per-IP limits.
 * An IPv4-mapped IPv6 address (::ffff:a.b.c.d) is the IPv4 address. Brackets
 * and a zone id (%eth0) are dropped. Anything unparseable is used as given.
 */
export function normaliseIp(ip: string): string {
  let s = ip.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracketed) s = bracketed[1];
  if (IPV4.test(s)) return s;
  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(s);
  if (ipv4WithPort && IPV4.test(ipv4WithPort[1])) return ipv4WithPort[1];
  if (!s.includes(':')) return s;
  const zone = s.indexOf('%');
  const groups = ipv6Groups(zone >= 0 ? s.slice(0, zone) : s);
  if (!groups) return s;
  const isMapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (isMapped) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}

export function hashSupportIp(ip: string | null): string | null {
  if (!ip) return null;
  const mac = supportHmac('support-ip', normaliseIp(ip));
  return mac ? mac.toString('base64url') : null;
}
