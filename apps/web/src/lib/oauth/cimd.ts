/**
 * Client ID Metadata Documents (CIMD) for the OAuth authorization server.
 *
 * draft-ietf-oauth-client-id-metadata-document lets a client identify itself
 * with an HTTPS URL that dereferences to its own OAuth registration metadata,
 * instead of registering through RFC 7591 Dynamic Client Registration first.
 *
 * ── Why we want it ──────────────────────────────────────────────────────────
 *
 * DCR has Claude register a brand new client on every fresh connection: one
 * `dyn_…` row in `oauth_clients` per connection, forever, none of which the
 * user or we can tell apart. Anthropic's connector docs say so outright and
 * recommend CIMD at directory scale. Under CIMD the `client_id` is a stable
 * URL, so one client is one identity no matter how many times it connects, and
 * there is no registration round trip and no row to write at all.
 *
 * CIMD is offered ALONGSIDE DCR, never instead of it. The authorization server
 * metadata keeps advertising `registration_endpoint`, and every client that
 * already registered keeps working untouched. Claude picks CIMD only when the
 * metadata advertises both `client_id_metadata_document_supported: true` and
 * `"none"` in `token_endpoint_auth_methods_supported`; anything else falls
 * back to the registration endpoint.
 *
 * ── Why the document is not evidence of anything ────────────────────────────
 *
 * The document is SELF-ASSERTED. Whoever controls the URL writes it, so the
 * only fact it can establish is "the operator of this origin says so". Three
 * consequences run through everything below:
 *
 *  1. The document must be self-referential: its `client_id` field has to equal
 *     the URL it was served from. Without that check, anyone could host a
 *     document claiming to be someone else's client_id and have us bind an
 *     authorization code to it.
 *
 *  2. The consent screen shows the HOST OF THE URL as the relying party, never
 *     the document's `client_name`. This is the one control that keeps CIMD
 *     safe for a human to read: the host is DNS-backed and the user can check
 *     it, while `client_name` is a free-text string an attacker sets to
 *     "Anthropic" for free. `client_name` is parsed and then deliberately
 *     dropped on the floor. It never reaches the UI.
 *
 *  3. The listed `redirect_uris` must be same-origin with the client_id URL,
 *     so control of the origin is what grants the ability to receive codes for
 *     it. The one exception is the loopback redirect a native app needs.
 *
 * ── Loopback matching ───────────────────────────────────────────────────────
 *
 * A native client binds an ephemeral port at runtime, so it cannot declare the
 * port ahead of time. RFC 8252 section 7.3 says to compare loopback redirect
 * URIs WITH THE PORT IGNORED, and that is what `redirectUriAllowed` does for
 * `http://127.0.0.1/…` and `http://[::1]/…`. RFC 8252 section 8.3 discourages
 * `http://localhost/…` (it depends on the resolver), but Claude Code declares
 * localhost in its own CIMD and binds an ephemeral port, so the same
 * port-agnostic rule is applied to it for compatibility. The HOST still has to
 * match exactly: a document listing 127.0.0.1 does not authorise a redirect to
 * localhost, only to another port on 127.0.0.1.
 *
 * ── The fetch is an outbound request to an attacker-chosen URL ──────────────
 *
 * Anyone can put any URL in `?client_id=` on a GET of /authorize, before there
 * is a session, and make this server fetch it. So the fetch is guarded the way
 * `guardMailHost` guards a mail socket, through the same range tables:
 *
 *   - HTTPS only, port 443 only, no userinfo, no fragment.
 *   - The host is resolved and EVERY answer must be a public address; private,
 *     loopback, link-local (169.254.169.254) and CGNAT ranges are refused.
 *   - The APPROVED ADDRESS is what gets dialled, via the `lookup` hook on
 *     node:https, so the name is not re-resolved between the check and the
 *     connect (host-guard rule 3). TLS still validates against the name.
 *   - 3 second deadline for the whole exchange, 64 KB body cap enforced while
 *     streaming, at most one redirect and only to the same origin.
 *   - The body is never echoed back to the caller. A failure renders a fixed
 *     sentence, so this cannot be used as an oracle for what a URL returns.
 *
 * Residual risk, stated plainly: pinning closes the rebinding window between
 * our resolution and our connect, but the fetch is still an HTTPS GET from our
 * egress IP to a public host of the requester's choosing. That is inherent to
 * CIMD. What it cannot do is reach anything private, spend more than three
 * seconds, or tell the requester what it saw.
 *
 * Callers additionally rate-limit by IP, and successful and failed lookups are
 * both cached in-process, so a consent screen render does not refetch and a
 * hot loop does not turn into a fetch loop.
 *
 * Everything above the `── Fetch ──` divider is pure and dependency-free so it
 * can be unit tested under a plain `node --test`.
 */

import https from 'node:https';
import { guardHttpHost } from '@/lib/email/host-guard';

/* ──────────────────────────────────────────────────────────────────────────
 * Shape
 * ────────────────────────────────────────────────────────────────────────── */

/** The subset of the metadata document this server acts on. */
export interface CimdDocument {
  /** Normalised, and equal to the URL the document was served from. */
  client_id: string;
  /** Only the entries that passed `listedRedirectUriAcceptable`. */
  redirect_uris: string[];
}

export type CimdFailureCode =
  | 'not_a_url'
  | 'not_https'
  | 'bad_url_shape'
  | 'host_not_allowed'
  | 'fetch_failed'
  | 'not_json'
  | 'not_self_referential'
  | 'unsupported_auth_method'
  | 'unsupported_grant'
  | 'no_usable_redirect_uri';

export type CimdResult<T> = { ok: true; value: T } | { ok: false; code: CimdFailureCode; message: string };

/**
 * User-facing sentences. Deliberately uniform about what went wrong on the
 * network: "could not be fetched" covers DNS failure, TLS failure, timeout,
 * a 404 and an oversized body alike, so the error page is not a probe result.
 */
export const CIMD_MESSAGES: Record<CimdFailureCode, string> = {
  not_a_url: 'The client_id is not a valid URL.',
  not_https:
    'A client_id URL must use https. An http:// client_id is refused: the document it points at could be rewritten in transit.',
  bad_url_shape:
    'A client_id URL must be a plain https URL on the default port, with no credentials and no fragment.',
  host_not_allowed:
    'The client_id URL points at a host this server will not fetch. It must resolve to a public internet address.',
  fetch_failed:
    'The client ID metadata document at that URL could not be fetched. Check that it is served over HTTPS as JSON and is reachable from the public internet.',
  not_json: 'The client ID metadata document is not a JSON object.',
  not_self_referential:
    'The client ID metadata document is not self-referential: its client_id field does not match the URL it was served from.',
  unsupported_auth_method:
    'This authorization server only supports public clients (token_endpoint_auth_method "none").',
  unsupported_grant:
    'The client ID metadata document does not declare the authorization_code grant with a code response type.',
  no_usable_redirect_uri:
    'The client ID metadata document lists no usable redirect_uris. They must be https URIs on the same origin as the client_id, or loopback URIs for a native client.',
};

function fail<T>(code: CimdFailureCode): CimdResult<T> {
  return { ok: false, code, message: CIMD_MESSAGES[code] };
}

/* ──────────────────────────────────────────────────────────────────────────
 * client_id parsing
 * ────────────────────────────────────────────────────────────────────────── */

/** Longest client_id URL we will look at. Well past any real one. */
const MAX_CLIENT_ID_LENGTH = 2048;

/**
 * Does this client_id want to be a URL at all?
 *
 * Matches http as well as https on purpose. A caller that branched only on
 * `https://` would send `http://evil.example/doc` down the registered-client
 * path, where it dies as "unknown client" and hides the real reason. Routing
 * both here means `parseCimdClientId` gets to say "http is refused", which is
 * the answer the client actually needs.
 */
export function looksLikeUrlClientId(value: unknown): boolean {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

/**
 * Normalise a client_id URL to the single string both sides of the
 * self-reference check, and every stored `client_id` column, compare against.
 *
 * `URL` already lower-cases the scheme and host and drops a default port, so
 * `HTTPS://Claude.AI:443/x` and `https://claude.ai/x` become the same value.
 * The path and query are kept byte-exact: they are case-sensitive, and two
 * documents at different paths on one origin are two different clients.
 */
export function normalizeCimdClientId(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}${url.search}`;
}

/**
 * Parse and vet a client_id URL. Returns the normalised form, which is what
 * gets persisted on the auth code and the refresh token.
 */
export function parseCimdClientId(raw: unknown): CimdResult<{ url: URL; normalized: string }> {
  if (typeof raw !== 'string') return fail('not_a_url');
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CLIENT_ID_LENGTH) return fail('not_a_url');

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return fail('not_a_url');
  }

  // http is not a typo to be forgiven. The document is the client's identity,
  // and over http anyone on the path rewrites it, including its redirect_uris.
  if (url.protocol === 'http:') return fail('not_https');
  if (url.protocol !== 'https:') return fail('not_a_url');

  // Credentials in the URL would be sent on our fetch, and a fragment is never
  // transmitted, so a client_id carrying one means two different strings would
  // have to compare equal. Both are refused rather than silently stripped.
  if (url.username || url.password) return fail('bad_url_shape');
  if (url.hash) return fail('bad_url_shape');
  if (!url.hostname) return fail('bad_url_shape');

  // Port allowlist, in the spirit of host-guard rule 4: without it the fetch
  // is a scanner pointed at any public host's any port. A metadata document is
  // served from a web server on 443.
  if (url.port !== '' && url.port !== '443') return fail('bad_url_shape');

  return { ok: true, value: { url, normalized: normalizeCimdClientId(url) } };
}

/* ──────────────────────────────────────────────────────────────────────────
 * redirect_uri matching
 * ────────────────────────────────────────────────────────────────────────── */

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '[::1]', 'localhost']);

/**
 * Is this a native client's loopback redirect, the one case where the port is
 * not knowable in advance? See the loopback note in the file header.
 */
export function isLoopbackRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  return url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname);
}

/**
 * May a document served from `clientIdUrl` list `uri` at all?
 *
 * Same-origin https, or a loopback http URI. Nothing else: not a custom scheme
 * (`claude://…`), not plain http to a routable host, and not https to a
 * different origin. The point is that control of the client_id origin, and
 * only that, confers the ability to receive authorization codes for it.
 */
export function listedRedirectUriAcceptable(clientIdUrl: string, uri: unknown): boolean {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > MAX_CLIENT_ID_LENGTH) return false;

  let listed: URL;
  let owner: URL;
  try {
    listed = new URL(uri);
    owner = new URL(clientIdUrl);
  } catch {
    return false;
  }

  if (listed.protocol === 'http:') return LOOPBACK_HOSTNAMES.has(listed.hostname);
  if (listed.protocol !== 'https:') return false;
  return listed.origin === owner.origin;
}

/**
 * Compare two redirect URIs, ignoring the port when the listed one is a
 * loopback URI (RFC 8252 section 7.3). Scheme, host, path and query must all
 * agree either way; only the port is allowed to float, and only for loopback.
 */
function redirectUriMatches(listed: string, requested: string): boolean {
  let a: URL;
  let b: URL;
  try {
    a = new URL(listed);
    b = new URL(requested);
  } catch {
    return false;
  }

  if (a.protocol !== b.protocol) return false;
  if (a.pathname !== b.pathname) return false;
  if (a.search !== b.search) return false;

  if (isLoopbackRedirectUri(listed)) {
    // Host still has to match exactly. 127.0.0.1 and localhost are different
    // names and a document that declared one has not authorised the other.
    return a.hostname === b.hostname;
  }

  return a.host === b.host;
}

/**
 * The gate: is `requested` authorised by this document?
 *
 * Entries that a document is not allowed to list are skipped rather than
 * failing the whole document, so a client that lists a custom scheme next to a
 * usable https callback still connects on the usable one.
 */
export function redirectUriAllowed(
  clientIdUrl: string,
  redirectUris: readonly string[],
  requested: unknown
): boolean {
  if (typeof requested !== 'string' || requested.length === 0) return false;
  return redirectUris.some(
    (listed) => listedRedirectUriAcceptable(clientIdUrl, listed) && redirectUriMatches(listed, requested)
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Document validation
 * ────────────────────────────────────────────────────────────────────────── */

/** More redirect_uris than any real client declares; a cheap upper bound. */
const MAX_REDIRECT_URIS = 20;

/**
 * Validate a parsed JSON body as the metadata document for `normalizedClientId`.
 *
 * Pure: the caller does the fetching. `client_name`, `client_uri` and
 * `logo_uri` are not read at all, because acting on any of them would put a
 * self-asserted claim in front of the user (see the file header).
 */
export function validateCimdDocument(raw: unknown, normalizedClientId: string): CimdResult<CimdDocument> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail('not_json');
  const doc = raw as Record<string, unknown>;

  // Self-referential, through the same normaliser both sides, so a document
  // that spells its own URL slightly differently still matches while one that
  // names a different origin or path never can.
  const declared = parseCimdClientId(doc['client_id']);
  if (!declared.ok || declared.value.normalized !== normalizedClientId) return fail('not_self_referential');

  // We have no client secret and never will, so a document announcing that it
  // can ONLY authenticate with one is refused rather than silently downgraded.
  //
  // Two fields can carry the answer and the plural one decides.
  // `token_endpoint_auth_methods_supported` lists everything the client is able
  // to do; the client then picks from the intersection with what this server
  // advertises, and this server advertises "none" alone. ChatGPT publishes
  // ["none", "private_key_jwt"] there while still carrying the legacy singular
  // `token_endpoint_auth_method: "private_key_jwt"` for servers that treat the
  // singular field as binding, so reading the singular field alone turned away
  // a client that would have connected as a public client. The singular field
  // is consulted only when the list is absent.
  const authMethods = doc['token_endpoint_auth_methods_supported'];
  if (Array.isArray(authMethods)) {
    if (!authMethods.includes('none')) return fail('unsupported_auth_method');
  } else {
    const authMethod = doc['token_endpoint_auth_method'];
    if (authMethod !== undefined && authMethod !== 'none') return fail('unsupported_auth_method');
  }

  // Only checked when declared. The fields are optional in the draft, and a
  // document that omits them is not claiming anything we disagree with.
  const grantTypes = doc['grant_types'];
  if (Array.isArray(grantTypes) && !grantTypes.includes('authorization_code')) return fail('unsupported_grant');
  const responseTypes = doc['response_types'];
  if (Array.isArray(responseTypes) && !responseTypes.includes('code')) return fail('unsupported_grant');

  const rawUris = doc['redirect_uris'];
  if (!Array.isArray(rawUris) || rawUris.length === 0) return fail('no_usable_redirect_uri');

  const redirectUris = rawUris
    .slice(0, MAX_REDIRECT_URIS)
    .filter((uri): uri is string => listedRedirectUriAcceptable(normalizedClientId, uri));

  if (redirectUris.length === 0) return fail('no_usable_redirect_uri');

  return { ok: true, value: { client_id: normalizedClientId, redirect_uris: redirectUris } };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Consent identity
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The string the consent screen names as the relying party: the HOST of the
 * client_id URL, and nothing the document said about itself.
 *
 * Falls back to the raw value only so a caller can never render `undefined`;
 * every route reaches this with an already-parsed URL.
 */
export function cimdDisplayHost(clientId: string): string {
  try {
    return new URL(clientId).host;
  } catch {
    return clientId;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Fetch
 * ────────────────────────────────────────────────────────────────────────── */

/** Whole-exchange deadline, connect through last byte. */
const FETCH_TIMEOUT_MS = 3_000;
/** Body cap, enforced while streaming rather than after the fact. */
const MAX_BODY_BYTES = 64 * 1024;
/** At most one hop, and only to the same origin. */
const MAX_REDIRECTS = 1;

const USER_AGENT = 'mcpemails-oauth-cimd/1.0 (+https://mcpemails.com/security)';

interface RawResponse {
  status: number;
  location: string | null;
  body: string;
}

/**
 * One GET, dialled at `address` rather than at the name (host-guard rule 3),
 * with the deadline and the size cap both enforced here rather than by a
 * caller that might forget.
 */
function requestOnce(url: URL, address: string, family: 4 | 6): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: 'https:',
        hostname: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        // SNI and certificate validation still run against the NAME, so
        // pinning the address does not weaken TLS.
        servername: url.hostname.replace(/^\[|\]$/g, ''),
        headers: {
          Host: url.host,
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          'Accept-Encoding': 'identity',
        },
        lookup: (
          _hostname: string,
          opts: { all?: boolean },
          cb: (
            err: NodeJS.ErrnoException | null,
            address: string | { address: string; family: number }[],
            family?: number
          ) => void
        ) => {
          if (opts && opts.all) cb(null, [{ address, family }]);
          else cb(null, address, family);
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_BODY_BYTES) {
            res.destroy();
            reject(new Error('cimd_body_too_large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            location: typeof res.headers.location === 'string' ? res.headers.location : null,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      }
    );

    // Two timers on purpose: `setTimeout` catches an idle socket, the hard
    // deadline catches a server that dribbles bytes forever under the cap.
    const deadline = setTimeout(() => req.destroy(new Error('cimd_deadline')), FETCH_TIMEOUT_MS);
    req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error('cimd_timeout')));
    req.on('error', reject);
    req.on('close', () => clearTimeout(deadline));
    req.end();
  });
}

/**
 * Resolve the host through the shared SSRF guard and GET the document,
 * following at most one same-origin redirect.
 */
async function fetchDocumentBody(url: URL): Promise<CimdResult<string>> {
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const guard = await guardHttpHost(current.hostname);
    if (!guard.ok) return fail('host_not_allowed');

    let res: RawResponse;
    try {
      res = await requestOnce(current, guard.address, guard.family);
    } catch {
      return fail('fetch_failed');
    }

    if (res.status >= 300 && res.status < 400 && res.location) {
      let next: URL;
      try {
        next = new URL(res.location, current);
      } catch {
        return fail('fetch_failed');
      }
      // Same origin only. A redirect that leaves the origin would let a public
      // URL hand the fetch to somewhere we did not vet, and would also break
      // the self-reference check the document still has to pass.
      if (next.origin !== current.origin) return fail('fetch_failed');
      if (next.port !== '' && next.port !== '443') return fail('fetch_failed');
      current = next;
      continue;
    }

    if (res.status !== 200) return fail('fetch_failed');
    return { ok: true, value: res.body };
  }

  return fail('fetch_failed');
}

/* ──────────────────────────────────────────────────────────────────────────
 * Cache
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * In-process, best-effort, per-instance. A consent screen render and the
 * consent POST that follows it are two requests seconds apart that ask the
 * same question, and neither should cost a second outbound fetch.
 *
 * Failures are cached too, for a shorter time, so a client_id that does not
 * resolve cannot be used to make us fetch on every page load.
 */
const SUCCESS_TTL_MS = 5 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

type CacheEntry = { at: number; result: CimdResult<CimdDocument> };
const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): CimdResult<CimdDocument> | null {
  const hit = cache.get(key);
  if (!hit) return null;
  const ttl = hit.result.ok ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
  if (Date.now() - hit.at > ttl) {
    cache.delete(key);
    return null;
  }
  return hit.result;
}

function cacheSet(key: string, result: CimdResult<CimdDocument>): void {
  // Insertion-ordered Map, so the first key is the oldest. Evicting one per
  // write is enough to hold the ceiling without a sweep.
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { at: Date.now(), result });
}

/** Test seam. Not called in production. */
export function clearCimdCache(): void {
  cache.clear();
}

/* ──────────────────────────────────────────────────────────────────────────
 * Entry point
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The synthetic client record a CIMD client_id stands in for.
 *
 * Field-for-field the shape the `/authorize` page and consent POST already get
 * from `oauth_clients`, so the two paths converge immediately and nothing
 * downstream has to know which one it is looking at. Nothing here is written
 * to the database: the whole point of CIMD is that there is no client row.
 *
 * `client_name` is the HOST, not the document's `client_name`. That is the
 * security requirement, and putting the host in the field the UI already
 * renders is what makes it hold without the consent component having to know
 * CIMD exists.
 */
export interface CimdClient {
  client_id: string;
  client_name: string;
  client_byline: string;
  redirect_uris: string[];
  scopes_allowed: string[];
  logo_url: null;
  is_first_party: false;
  deactivated_at: null;
}

/**
 * The scope ceiling a CIMD client may ask for: the full grantable set, exactly
 * as a dynamically-registered client gets (DYNAMIC_SCOPES in
 * app/api/oauth/register/route.ts). It is a ceiling, not a grant. The user
 * still picks, on the consent screen, which of these to hand over.
 */
export const CIMD_SCOPES: readonly string[] = [
  'read:email',
  'search:email',
  'send:email',
  'manage:folders',
  'delete:email',
  'manage:drafts',
  'manage:contacts',
  'schedule:email',
  'manage:automations',
];

/**
 * Turn a client_id URL into a client record, or into the reason it is not one.
 *
 * Parse, fetch, validate, cache. Callers rate-limit by IP before calling, and
 * must have already established that `looksLikeUrlClientId` is true.
 */
export async function resolveCimdClient(rawClientId: unknown): Promise<CimdResult<CimdClient>> {
  const parsed = parseCimdClientId(rawClientId);
  if (!parsed.ok) return parsed;

  const { url, normalized } = parsed.value;

  let doc = cacheGet(normalized);
  if (!doc) {
    const body = await fetchDocumentBody(url);
    if (!body.ok) {
      doc = { ok: false, code: body.code, message: body.message };
    } else {
      let json: unknown;
      try {
        json = JSON.parse(body.value);
      } catch {
        // No content-type check anywhere in this path on purpose: the document
        // has to be JSON that names its own URL to get past validation, which
        // is a far stronger test than any header, and a content-type rule is
        // exactly the kind of strictness that breaks a real client we cannot
        // test against before shipping.
        json = null;
      }
      doc = json === null ? fail<CimdDocument>('not_json') : validateCimdDocument(json, normalized);
    }
    cacheSet(normalized, doc);
  }

  if (!doc.ok) return { ok: false, code: doc.code, message: doc.message };

  return {
    ok: true,
    value: {
      client_id: doc.value.client_id,
      client_name: cimdDisplayHost(doc.value.client_id),
      client_byline: '',
      redirect_uris: doc.value.redirect_uris,
      scopes_allowed: [...CIMD_SCOPES],
      logo_url: null,
      is_first_party: false,
      deactivated_at: null,
    },
  };
}
