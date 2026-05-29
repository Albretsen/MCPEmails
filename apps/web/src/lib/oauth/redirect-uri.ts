import dns from 'node:dns/promises';

// DNS result cache: hostname → { addresses, cachedAt }
const dnsCache = new Map<string, { addresses: string[]; cachedAt: number }>();
const DNS_CACHE_TTL_MS = 60_000;

const PRIVATE_IPV4 = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./, // link-local / cloud metadata
  /^127\./,
];

const PRIVATE_IPV6 = [
  /^::1$/,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
];

function isPrivateAddress(addr: string): boolean {
  return (
    PRIVATE_IPV4.some((r) => r.test(addr)) ||
    PRIVATE_IPV6.some((r) => r.test(addr))
  );
}

async function resolveHostname(hostname: string): Promise<string[]> {
  const cached = dnsCache.get(hostname);
  if (cached && Date.now() - cached.cachedAt < DNS_CACHE_TTL_MS) {
    return cached.addresses;
  }

  const [v4, v6] = await Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname),
  ]);

  const addresses = [
    ...(v4.status === 'fulfilled' ? v4.value : []),
    ...(v6.status === 'fulfilled' ? v6.value : []),
  ];

  dnsCache.set(hostname, { addresses, cachedAt: Date.now() });
  return addresses;
}

/**
 * Validate a redirect URI for SSRF safety.
 *
 * Rules:
 * - Custom protocol schemes (claude://, cursor://, etc.) are always allowed;
 *   they cannot resolve to private network addresses via HTTP.
 * - http://localhost and http://127.0.0.1 are allowed for development clients.
 * - http:// to any other host is rejected (must use HTTPS).
 * - https:// URIs are DNS-resolved; any private IP in the result is rejected.
 * - Wildcard or path-traversal hostnames are rejected.
 */
export async function isValidRedirectUri(uri: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }

  const { protocol, hostname } = url;

  // Wildcard hostnames are never valid
  if (hostname.includes('*')) return false;

  // Custom protocol schemes (non-http/https) are for native apps and safe
  if (protocol !== 'http:' && protocol !== 'https:') return true;

  // Allow loopback for development clients
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1';
  if (protocol === 'http:' && isLoopback) return true;

  // All other http:// URIs require HTTPS
  if (protocol === 'http:') return false;

  // For https://, resolve and check for private IPs
  try {
    const addresses = await resolveHostname(hostname);
    if (addresses.length === 0) return false;
    if (addresses.some(isPrivateAddress)) return false;
  } catch {
    return false;
  }

  return true;
}
