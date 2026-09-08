/**
 * RFC 8707 Resource Indicators for the OAuth 2.1 authorization server.
 *
 * The MCP authorization spec (2025-06-18 and later) has clients send
 * `resource=<MCP server URL>` on the authorization and token requests so the
 * authorization server can bind the issued token to that audience and refuse
 * to mint a token for a resource it does not serve.
 *
 * This server issues tokens for exactly ONE resource: the MCP endpoint whose
 * URL the Protected Resource Metadata document advertises. So validation is a
 * comparison against that single canonical value, derived here from the same
 * environment the PRM route reads, so the two can never drift apart.
 *
 * The parameter is optional. Clients built against older revisions of the MCP
 * spec do not send it, and they must keep working; a request with no
 * `resource` behaves exactly as before, and the absence is recorded (null)
 * rather than substituted with a default.
 */

export const OAUTH_INVALID_TARGET = 'invalid_target';

/** Path of the MCP endpoint under the app origin. */
export const MCP_RESOURCE_PATH = '/api/mcp';

/** The app origin every OAuth metadata document is derived from. */
export function oauthIssuerBase(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? 'https://mcpemails.com';
}

/** The one resource this authorization server issues tokens for. */
export function canonicalResource(): string {
  return `${oauthIssuerBase()}${MCP_RESOURCE_PATH}`;
}

export type ResourceIndicatorResult =
  | { ok: true; resource: string | null }
  | { ok: false; error: typeof OAUTH_INVALID_TARGET; description: string };

/**
 * Normalise an absolute URI for comparison: scheme and host lower-cased,
 * default port dropped, no fragment. Returns null when the value is not an
 * absolute URI at all (RFC 8707 §2 requires one).
 */
function normalizeAbsoluteUri(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.hash = '';
  // Strip a trailing slash on the path so `/api/mcp/` and `/api/mcp` compare
  // equal; a client that appends one is naming the same endpoint.
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

/**
 * Validate an incoming `resource` parameter against the canonical resource.
 *
 *   absent / empty  → ok, resource: null (older client; keep working)
 *   canonical       → ok, resource: the canonical string
 *   anything else   → invalid_target (RFC 8707 §2)
 *
 * `canonical` is injectable for tests; production callers use the default.
 */
export function validateResourceIndicator(
  raw: unknown,
  canonical: string = canonicalResource(),
): ResourceIndicatorResult {
  if (raw === undefined || raw === null) return { ok: true, resource: null };
  if (typeof raw !== 'string') {
    return { ok: false, error: OAUTH_INVALID_TARGET, description: 'resource must be a single absolute URI.' };
  }
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, resource: null };

  if (trimmed.includes('#')) {
    return { ok: false, error: OAUTH_INVALID_TARGET, description: 'resource must not contain a fragment.' };
  }

  const normalized = normalizeAbsoluteUri(trimmed);
  if (!normalized) {
    return { ok: false, error: OAUTH_INVALID_TARGET, description: 'resource must be an absolute https URI.' };
  }

  const wanted = normalizeAbsoluteUri(canonical);
  if (normalized !== wanted) {
    return {
      ok: false,
      error: OAUTH_INVALID_TARGET,
      description: `This authorization server only issues tokens for ${canonical}.`,
    };
  }

  return { ok: true, resource: canonical };
}

/**
 * Audience check at redemption: the resource named on the token request must
 * be the one recorded when the grant was issued. Either side may be null (an
 * older client that never sent it); only a mismatch between two present
 * values is a failure. Returns true when the pair is acceptable.
 */
export function resourceMatchesGrant(requested: string | null, granted: string | null): boolean {
  if (requested === null || granted === null) return true;
  return requested === granted;
}
