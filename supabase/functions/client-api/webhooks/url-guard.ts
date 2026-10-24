// ---------------------------------------------------------------------------
// Which webhook URLs may be dialled. Checked when an endpoint is created
// (apps/web/src/lib/webhooks/url.ts, the Node twin) and again here before
// EVERY attempt, because the name can be repointed after it was accepted.
//
//   - https only, no user:password@, no fragment, at most 2048 characters;
//   - port 443 or 8443 (an unrestricted port is an internal port scanner);
//   - the host passes the SSRF address policy of mcp-server/host-guard.ts:
//     literals in private, loopback, link-local, CGNAT, metadata, multicast
//     and documentation ranges are refused in every encoding, a name is
//     resolved and EVERY answer must be public, and the address that passed
//     is the one dialled (transport.ts). That module's port allow-list is for
//     mail; the address policy is reused through `guardMailHost` with a fixed
//     mail port, so the two policies can never fork.
//
// Redirects are never followed (transport.ts reads only the status line).
// ---------------------------------------------------------------------------

import { guardMailHost, type HostLookup } from "../../mcp-server/host-guard.ts";

export const ALLOWED_WEBHOOK_PORTS: ReadonlySet<number> = new Set([443, 8443]);
export const MAX_WEBHOOK_URL_LENGTH = 2048;

export type WebhookUrlCode =
  | "url_invalid"
  | "url_not_https"
  | "url_credentials"
  | "port_not_allowed"
  | "host_not_allowed"
  | "host_not_found";

export interface ParsedWebhookUrl {
  /** The hostname as written (lowercase, brackets removed for IPv6). For SNI and the Host header. */
  host: string;
  port: number;
  /** Path and query, never empty. */
  path: string;
  /** The Host header value: host, plus the port when it is not 443. */
  hostHeader: string;
}

export function parseWebhookUrl(raw: unknown): { ok: true; url: ParsedWebhookUrl } | { ok: false; code: WebhookUrlCode } {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_WEBHOOK_URL_LENGTH) return { ok: false, code: "url_invalid" };
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) return { ok: false, code: "url_invalid" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: "url_invalid" };
  }
  if (url.protocol !== "https:") return { ok: false, code: "url_not_https" };
  if (url.username !== "" || url.password !== "") return { ok: false, code: "url_credentials" };
  if (url.hash !== "") return { ok: false, code: "url_invalid" };
  const port = url.port === "" ? 443 : Number(url.port);
  if (!ALLOWED_WEBHOOK_PORTS.has(port)) return { ok: false, code: "port_not_allowed" };
  const hostname = url.hostname.toLowerCase();
  const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (host.length === 0) return { ok: false, code: "url_invalid" };
  return {
    ok: true,
    url: {
      host,
      port,
      path: `${url.pathname || "/"}${url.search}`,
      hostHeader: port === 443 ? url.host.replace(/:443$/, "") : url.host,
    },
  };
}

export type WebhookUrlVerdict =
  | { ok: true; url: ParsedWebhookUrl; address: string; family: 4 | 6 }
  | { ok: false; code: WebhookUrlCode };

/** Parse, then resolve and check the address. The approved address is what must be dialled. */
export async function guardWebhookUrl(raw: unknown, options: { lookup?: HostLookup } = {}): Promise<WebhookUrlVerdict> {
  const parsed = parseWebhookUrl(raw);
  if (!parsed.ok) return parsed;
  // 993 only satisfies host-guard's MAIL port check; the webhook port was
  // checked above. Everything else guardMailHost does is the address policy.
  const verdict = await guardMailHost(parsed.url.host, { protocol: "imap", port: 993, lookup: options.lookup });
  if (!verdict.ok) {
    if (verdict.code === "host_not_allowed") return { ok: false, code: "host_not_allowed" };
    if (verdict.code === "host_not_found") return { ok: false, code: "host_not_found" };
    return { ok: false, code: "url_invalid" };
  }
  return { ok: true, url: parsed.url, address: verdict.address, family: verdict.family };
}
