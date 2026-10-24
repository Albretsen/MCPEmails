import { guardHttpHost, type HostLookup } from '@/lib/email/host-guard';

/**
 * Which webhook URLs an endpoint may have, checked when one is created or
 * edited, and again before the test ping. The edge twin
 * (supabase/functions/client-api/webhooks/url-guard.ts) re-checks before EVERY
 * delivery, because a name accepted today can be repointed tomorrow.
 *
 *   - https only, no user:password@, no fragment, at most 2048 characters;
 *   - port 443 or 8443;
 *   - the host passes the SSRF address policy (lib/email/host-guard.ts,
 *     `guardHttpHost`): no private, loopback, link-local, CGNAT, metadata or
 *     documentation address in any encoding, and every DNS answer public.
 */

export const ALLOWED_WEBHOOK_PORTS: ReadonlySet<number> = new Set([443, 8443]);
export const MAX_WEBHOOK_URL_LENGTH = 2048;

export type WebhookUrlCode =
  | 'url_invalid'
  | 'url_not_https'
  | 'url_credentials'
  | 'port_not_allowed'
  | 'host_not_allowed'
  | 'host_not_found';

export const WEBHOOK_URL_MESSAGES: Record<WebhookUrlCode, string> = {
  url_invalid: 'Enter a valid https URL.',
  url_not_https: 'Webhook URLs must start with https://.',
  url_credentials: 'Remove the user name and password from the URL.',
  port_not_allowed: 'Webhook URLs use port 443 or 8443.',
  host_not_allowed: 'That URL points to a private or internal network address.',
  host_not_found: 'That host name does not resolve.',
};

export interface ParsedWebhookUrl {
  /** The normalised URL that is stored. */
  href: string;
  host: string;
  port: number;
  path: string;
  hostHeader: string;
}

export function parseWebhookUrl(raw: unknown): { ok: true; url: ParsedWebhookUrl } | { ok: false; code: WebhookUrlCode } {
  if (typeof raw !== 'string') return { ok: false, code: 'url_invalid' };
  const text = raw.trim();
  if (text.length === 0 || text.length > MAX_WEBHOOK_URL_LENGTH) return { ok: false, code: 'url_invalid' };
  if (/[\s\u0000-\u001f\u007f]/.test(text)) return { ok: false, code: 'url_invalid' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, code: 'url_invalid' };
  }
  if (url.protocol !== 'https:') return { ok: false, code: 'url_not_https' };
  if (url.username !== '' || url.password !== '') return { ok: false, code: 'url_credentials' };
  if (url.hash !== '') return { ok: false, code: 'url_invalid' };
  const port = url.port === '' ? 443 : Number(url.port);
  if (!ALLOWED_WEBHOOK_PORTS.has(port)) return { ok: false, code: 'port_not_allowed' };
  const hostname = url.hostname.toLowerCase();
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (host.length === 0) return { ok: false, code: 'url_invalid' };
  if (url.href.length > MAX_WEBHOOK_URL_LENGTH) return { ok: false, code: 'url_invalid' };
  return {
    ok: true,
    url: { href: url.href, host, port, path: `${url.pathname || '/'}${url.search}`, hostHeader: url.host },
  };
}

export type WebhookUrlVerdict =
  | { ok: true; url: ParsedWebhookUrl; address: string; family: 4 | 6 }
  | { ok: false; code: WebhookUrlCode; message: string };

export async function validateWebhookUrl(raw: unknown, options: { lookup?: HostLookup } = {}): Promise<WebhookUrlVerdict> {
  const deny = (code: WebhookUrlCode): WebhookUrlVerdict => ({ ok: false, code, message: WEBHOOK_URL_MESSAGES[code] });
  const parsed = parseWebhookUrl(raw);
  if (!parsed.ok) return deny(parsed.code);
  const verdict = await guardHttpHost(parsed.url.host, { lookup: options.lookup });
  if (!verdict.ok) {
    if (verdict.code === 'host_not_allowed') return deny('host_not_allowed');
    if (verdict.code === 'host_not_found') return deny('host_not_found');
    return deny('url_invalid');
  }
  return { ok: true, url: parsed.url, address: verdict.address, family: verdict.family };
}
