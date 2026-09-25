// ---------------------------------------------------------------------------
// outlook-graph.ts — the Microsoft Graph transport for the Outlook connector.
//
// ── Why this is a module ───────────────────────────────────────────────────
// Until 2026-09-25 every Outlook call in index.ts was a hand-rolled `fetch`
// against graph.microsoft.com, forty-one of them, and none of that code had
// ever run against real Graph (zero Outlook inboxes in prod, ever). A pre-launch
// audit found the same handful of mistakes repeated across those call sites:
//
//   * no Retry-After handling, so one 429 from Exchange's per-mailbox throttle
//     failed the whole tool call;
//   * no `Prefer: IdType="ImmutableId"`, so every message id we handed out died
//     the moment the message was moved (and a sent draft's id was useless);
//   * 403 read as "reconnect", which sends a user whose tenant policy blocks an
//     operation around an OAuth loop that can never fix it;
//   * `$search` double-quoted, `$filter` + `$orderby` in an order Graph rejects
//     with InefficientFilter, folder names concatenated raw into URL paths;
//   * a reply built with custom `In-Reply-To` / `References` headers, which
//     Graph refuses outright (only `x-` headers are settable);
//   * no upload session, so any attachment past ~3 MB broke sendMail.
//
// Everything below is either the one wrapper those call sites now share
// ({@link graphFetch}) or a pure/injectable helper for the flows that need more
// than one request. index.ts calls `Deno.serve` at module load and exports
// nothing, so logic that only lives there can be pinned by a source scan and
// nothing more; here it can be run for real by outlook-graph.test.ts with a
// stubbed `globalThis.fetch`.
//
// ── Doc sources (checked 2026-09-25) ───────────────────────────────────────
//   Throttling + Retry-After, 4 concurrent requests per mailbox:
//     https://learn.microsoft.com/en-us/graph/throttling
//     https://learn.microsoft.com/en-us/graph/throttling-limits#outlook-service-limits
//   Immutable ids (and "the draft's immutable id IS the Sent Items copy"):
//     https://learn.microsoft.com/en-us/graph/outlook-immutable-id
//   $filter + $orderby rules (InefficientFilter):
//     https://learn.microsoft.com/en-us/graph/api/user-list-messages
//   $search syntax (whole value in double quotes, inner quotes backslashed):
//     https://learn.microsoft.com/en-us/graph/search-query-parameter
//   internetMessageHeaders only accepts `x-` headers; createReply / send:
//     https://learn.microsoft.com/en-us/graph/api/message-createreply
//     https://learn.microsoft.com/en-us/graph/api/message-send
//   Large attachments (upload session, 320 KiB-multiple chunks, no auth header
//   on the PUT):
//     https://learn.microsoft.com/en-us/graph/outlook-large-attachments
//   Token refresh rotates the refresh token:
//     https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#refresh-the-access-token
// ---------------------------------------------------------------------------

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/**
 * Sent on EVERY Graph request. Messages and attachments come back with ids that
 * survive a move between folders, and a draft keeps its id after it is sent
 * (the id then names the copy in Sent Items). Containers (mailFolders) ignore
 * it; their ids were always stable. Graph only honours the header on the
 * request that carries it, so it cannot be set once and forgotten.
 */
export const IMMUTABLE_ID_PREFER = 'IdType="ImmutableId"';

// ─────────────────────────────────────────────────────────────────────────────
// Retry policy
// ─────────────────────────────────────────────────────────────────────────────

export interface GraphRetryPolicy {
  /** Retries after the first attempt. 2 means at most 3 requests. */
  maxRetries: number;
  /** The most any single Retry-After wait may be. A longer ask is not honoured. */
  maxSingleWaitMs: number;
  /** The most all waits of one call may add up to. */
  maxTotalWaitMs: number;
}

/**
 * Two retries, never more than 8 seconds of waiting in total.
 *
 * The edge function's tool budget is 30 seconds and a search already spends
 * most of it on the request itself. A throttle that wants us gone for longer
 * than this is answered with the 429 it sent, which every caller already turns
 * into an honest error, rather than with a worker that dies of wall-clock.
 */
export const DEFAULT_GRAPH_RETRY: GraphRetryPolicy = {
  maxRetries: 2,
  maxSingleWaitMs: 5_000,
  maxTotalWaitMs: 8_000,
};

/**
 * 429 is Graph's throttle; 503 is "service unavailable", which Graph also sends
 * with a Retry-After when a backend is shedding load. Both mean the request was
 * NOT processed, so repeating it cannot duplicate a send. 504 is deliberately
 * absent: a gateway timeout says nothing about whether the work happened.
 */
const RETRYABLE_STATUS = new Set([429, 503]);

let sleepImpl: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Test seam: replace the sleeper so retry tests do not actually wait. */
export function setGraphSleepForTests(fn: ((ms: number) => Promise<void>) | null): void {
  sleepImpl = fn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

/**
 * Milliseconds a Retry-After header asks for, or null when absent/unreadable.
 * The header is either delta-seconds or an HTTP date (RFC 9110 §10.2.3).
 */
export function parseRetryAfterMs(value: string | null, nowMs = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - nowMs);
}

/**
 * `fetch` with Graph's throttling contract: on 429/503 wait what Retry-After
 * asks (1s, then 2s, when it asks nothing) and try again, within the policy's
 * bounds. The response that could not be retried is returned as it is, so the
 * caller's own status handling still decides what the failure means.
 *
 * `init.body` must be re-sendable (a string or bytes), which every caller here
 * satisfies; a stream would be consumed by the first attempt.
 */
export async function fetchWithGraphRetry(
  url: string,
  init: RequestInit,
  policy: GraphRetryPolicy = DEFAULT_GRAPH_RETRY,
): Promise<Response> {
  let waited = 0;
  for (let attempt = 0;; attempt++) {
    const resp = await fetch(url, init);
    if (!RETRYABLE_STATUS.has(resp.status) || attempt >= policy.maxRetries) return resp;
    const asked = parseRetryAfterMs(resp.headers.get("retry-after"));
    const wait = asked ?? 1000 * 2 ** attempt;
    if (wait > policy.maxSingleWaitMs || waited + wait > policy.maxTotalWaitMs) return resp;
    // The discarded response's body must be released, or Deno holds the
    // connection (and warns about a leaked resource in tests).
    await resp.body?.cancel().catch(() => {});
    waited += wait;
    await sleepImpl(wait);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// graphFetch — the one door to Graph
// ─────────────────────────────────────────────────────────────────────────────

export interface GraphRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | ArrayBuffer | null;
  /** Extra `Prefer` tokens, e.g. `outlook.body-content-type="text"`. */
  prefer?: string[];
  /** Override the retry policy (e.g. `{ ...DEFAULT_GRAPH_RETRY, maxRetries: 0 }`). */
  retry?: GraphRetryPolicy;
}

/**
 * An absolute Graph URL for a `/me/...` path; absolute URLs (nextLinks) pass
 * through untouched.
 *
 * In a path we built, `+` in the query can only be URLSearchParams'
 * form-encoding of a space (a literal plus is `%2B`), and it is rewritten to
 * `%20`: Graph's OData parser is documented with `%20`, and a `$search` or
 * `$filter` is exactly where a mis-decoded space turns into a 400.
 */
export function graphUrl(pathOrUrl: string): string {
  if (/^https:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const q = pathOrUrl.indexOf("?");
  const path = q === -1 ? pathOrUrl : `${pathOrUrl.slice(0, q)}?${pathOrUrl.slice(q + 1).replace(/\+/g, "%20")}`;
  return `${GRAPH_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
}

/**
 * Every Graph call goes through here: bearer auth, `Prefer: IdType=
 * "ImmutableId"` (merged with any other Prefer tokens), and the bounded
 * Retry-After retry. Status handling stays with the caller; see
 * {@link graphErrorFromResponse} for the shared mapping.
 */
export async function graphFetch(
  accessToken: string,
  pathOrUrl: string,
  init: GraphRequestInit = {},
): Promise<Response> {
  const url = graphUrl(pathOrUrl);
  let body: BodyInit | null | undefined;
  if (init.body instanceof Uint8Array) {
    // A plain ArrayBuffer view: Deno's fetch typings reject a Uint8Array over
    // ArrayBufferLike, and this makes the octets a BodyInit.
    body = init.body.slice().buffer as ArrayBuffer;
  } else {
    body = init.body;
  }
  const send = (token: string): Promise<Response> => {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    headers["Authorization"] = `Bearer ${token}`;
    const prefer = [IMMUTABLE_ID_PREFER, ...(init.prefer ?? [])];
    const callerPrefer = headers["Prefer"];
    if (callerPrefer) prefer.push(callerPrefer);
    headers["Prefer"] = prefer.join(", ");
    return fetchWithGraphRetry(url, { method: init.method ?? "GET", headers, body }, init.retry);
  };
  // A token an earlier 401 in this isolate already replaced is not sent again:
  // the caller may still hold the old string for the rest of its request.
  const token = replacedGraphTokens.get(accessToken) ?? accessToken;
  const resp = await send(token);
  return await recoverGraphAuth(token, url, resp, send);
}

/** `graphFetch` with a JSON body and Content-Type set. */
export function graphJson(
  accessToken: string,
  pathOrUrl: string,
  method: string,
  payload: unknown,
  extra: Omit<GraphRequestInit, "method" | "body"> = {},
): Promise<Response> {
  return graphFetch(accessToken, pathOrUrl, {
    ...extra,
    method,
    headers: { ...(extra.headers ?? {}), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A Graph failure that is not "sign in again".
 *
 * `name` is set so provider-error.ts can classify by name without importing
 * this module, the same convention the IMAP error classes follow. The message
 * keeps the `<context> error <status>` shape, which is what
 * `classifyProviderError` reads as an `http_error` and `providerErrorSignals`
 * turns into an `http_<status>` signal.
 */
export class OutlookGraphError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "OutlookGraphError";
    this.status = status;
    this.code = code;
  }
}

/** Graph's `{ error: { code, message } }` envelope, tolerating anything else. */
export async function readGraphError(
  resp: Response,
): Promise<{ code: string | null; message: string }> {
  let text = "";
  try {
    text = await resp.text();
  } catch {
    /* body already consumed or unreadable */
  }
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
    return {
      code: parsed.error?.code ?? null,
      message: parsed.error?.message ?? (resp.statusText || `HTTP ${resp.status}`),
    };
  } catch {
    return { code: null, message: text.trim().slice(0, 300) || resp.statusText || `HTTP ${resp.status}` };
  }
}

/**
 * The shared status mapping for a failed Graph response.
 *
 *   401                 → Error("outlook_auth_failed"). For a token from
 *                         outlookAccessTokenForGraph a caller never sees a
 *                         401: graphFetch has already refreshed and retried,
 *                         and turned a persistent 401 into OutlookNoMailboxError
 *                         (see "401 recovery" below). Only a failed refresh
 *                         (invalid_grant) means reconnect.
 *   403                 → OutlookGraphError naming a PERMISSION refusal. This
 *                         is tenant policy, a missing consent on a shared
 *                         mailbox, or an operation the account type does not
 *                         allow — none of which a reconnect repairs, so it
 *                         must never be reported as "reconnect".
 *   404 folder missing  → a message containing "does not exist", which both
 *                         FOLDER_MISSING_RE in index.ts and provider-error.ts
 *                         already read as folder_missing.
 *   anything else       → OutlookGraphError with Graph's own code and words.
 *
 * Call sites map their own 404 (message_not_found / draft_not_found) and 429
 * (quota_exceeded on the send paths) BEFORE calling this, because those depend
 * on what the call was addressing.
 */
export async function graphErrorFromResponse(resp: Response, context: string): Promise<Error> {
  if (resp.status === 401) {
    await resp.body?.cancel().catch(() => {});
    return new Error("outlook_auth_failed");
  }
  const { code, message } = await readGraphError(resp);
  const tag = code ? ` (${code})` : "";
  if (resp.status === 403) {
    return new OutlookGraphError(
      `${context} error 403${tag}: Microsoft refused this request for lack of permission: ` +
        `${message} This is a mailbox permission or organisation policy, not an expired ` +
        `sign-in, so reconnecting the inbox will not change it.`,
      403,
      code,
    );
  }
  if (resp.status === 404 && code === "ErrorFolderNotFound") {
    return new OutlookGraphError(
      `${context} error 404${tag}: the folder does not exist in this mailbox.`,
      404,
      code,
    );
  }
  return new OutlookGraphError(`${context} error ${resp.status}${tag}: ${message}`, resp.status, code);
}

// ─────────────────────────────────────────────────────────────────────────────
// 401 recovery and "this account has no mailbox"
// ─────────────────────────────────────────────────────────────────────────────
//
// A Graph 401 used to mean one thing here: "the token is dead, reconnect". That
// is wrong for a Microsoft account with NO Exchange Online mailbox behind it
// (an Entra admin account without an Exchange licence, a tenant whose mail is
// hosted elsewhere). Found live on 2026-09-25: such an account signs in, gets a
// perfectly valid token (scp "email Mail.ReadWrite Mail.Send openid profile"),
// and Graph answers /me/mailFolders/inbox and /me/messages with 401 and an
// EMPTY body, even straight after a refresh. Every tool call then marked the
// inbox 'error' and told the user to reconnect, which produced the same token
// and the same 401, forever.
//
// The rule now, applied in graphFetch so all ~60 Graph call sites share it:
//
//   * A 401 on a token that was NOT minted during this request: force one
//     refresh and send the request again with the new token.
//       - the refresh fails with invalid_grant / interaction_required: that is
//         the real "reconnect" case, and refreshOnce already throws
//         "outlook_auth_failed" after marking the inbox;
//       - the retry succeeds: it was a stale token, carry on;
//       - the retry is still 401: a freshly minted token being refused can only
//         mean there is no mailbox, so → no mailbox.
//   * A 401 on a token that WAS just minted: → no mailbox, without a second
//     pointless refresh.
//   * MailboxNotEnabledForRESTAPI / MailboxNotSupportedForRESTAPI /
//     ErrorMailboxNotFound with any status, or a 404 on a mailbox ROOT
//     (/me/messages, /me/mailFolders, /me/mailFolders/inbox — which exist in
//     every real mailbox): → no mailbox, directly.
//
// "No mailbox" marks the inbox 'error' with {@link OUTLOOK_NO_MAILBOX_MESSAGE}
// (the inbox cannot work, and the dashboard is where the user reads why) and
// throws {@link OutlookNoMailboxError}, whose message says the opposite of
// "reconnect". It is NOT "outlook_auth_failed", so none of the auth-failure
// branches in index.ts turn it back into a reconnect link.
//
// Recovery only runs for tokens registered through
// {@link outlookAccessTokenForGraph}; a bare graphFetch with an unregistered
// token behaves exactly as before, which keeps the request-shape tests honest.

/** The words shown to the agent, stored in `last_error`, and thrown. */
export const OUTLOOK_NO_MAILBOX_MESSAGE =
  "This Microsoft account has no Outlook / Exchange Online mailbox that Microsoft Graph can reach. " +
  "Microsoft accepted the sign-in, but there is no mailbox behind it: typically an administrator " +
  "account without an Exchange Online licence, or an organisation whose mail is hosted somewhere " +
  "else. Reconnecting will not change this. If the address's mail is hosted on another server, " +
  "remove this inbox and connect the address with IMAP instead.";

/** Thrown by graphFetch when the account has no mailbox. Never "reconnect". */
export class OutlookNoMailboxError extends Error {
  constructor() {
    super(OUTLOOK_NO_MAILBOX_MESSAGE);
    this.name = "OutlookNoMailboxError";
  }
}

/** Graph error codes that mean "there is no (REST-reachable) mailbox". */
const NO_MAILBOX_CODES = new Set([
  "MailboxNotEnabledForRESTAPI",
  "MailboxNotSupportedForRESTAPI",
  "ErrorMailboxNotFound",
]);

/**
 * Whether `url` addresses the mailbox itself rather than an item in it. A 404
 * on /me/messages/{id} is a missing MESSAGE; a 404 on /me/messages is a
 * missing mailbox.
 */
export function isGraphMailboxRoot(url: string): boolean {
  const path = url.replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/i, "").split("?")[0];
  return /^\/me\/(?:messages|mailFolders(?:\/inbox)?)\/?$/i.test(path);
}

/**
 * Pure verdict for one Graph response: is this "no mailbox", "unauthorized"
 * (a 401 that says nothing more), or neither.
 */
export function classifyGraphMailboxResponse(
  status: number,
  code: string | null,
  url: string,
): "no_mailbox" | "unauthorized" | "other" {
  if (code && NO_MAILBOX_CODES.has(code)) return "no_mailbox";
  if (status === 404 && isGraphMailboxRoot(url)) return "no_mailbox";
  if (status === 401) return "unauthorized";
  return "other";
}

interface GraphAuthRecovery {
  /** The token was minted by a refresh (or the code exchange) in this request. */
  fresh: boolean;
  /** Force one refresh; resolves to the new token. Throws outlook_auth_failed on invalid_grant. */
  refresh(): Promise<string>;
  /** Persist the no-mailbox state for the inbox. Must not throw. */
  noMailbox(): Promise<void>;
}

/** Keyed by access token: graphFetch sees only the token string. Bounded. */
const graphAuthRecovery = new Map<string, GraphAuthRecovery>();
/** Old token → the token a forced refresh replaced it with. Bounded. */
const replacedGraphTokens = new Map<string, string>();
/** One forced refresh per token, however many requests 401 at once. */
const inflightForcedRefresh = new Map<string, Promise<string>>();
const GRAPH_TOKEN_MAP_LIMIT = 500;

function rememberBounded<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > GRAPH_TOKEN_MAP_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** Attach 401 recovery to `token`. Exported for tests; production uses outlookAccessTokenForGraph. */
export function registerGraphAuthRecovery(token: string, recovery: GraphAuthRecovery): void {
  rememberBounded(graphAuthRecovery, token, recovery);
}

async function graphErrorCodeOf(resp: Response): Promise<string | null> {
  if (resp.ok) return null;
  return (await readGraphError(resp.clone())).code;
}

async function declareNoMailbox(recovery: GraphAuthRecovery, resp: Response): Promise<never> {
  await resp.body?.cancel().catch(() => {});
  await recovery.noMailbox();
  throw new OutlookNoMailboxError();
}

async function recoverGraphAuth(
  token: string,
  url: string,
  resp: Response,
  send: (token: string) => Promise<Response>,
): Promise<Response> {
  const recovery = graphAuthRecovery.get(token);
  if (!recovery || resp.ok) return resp;
  if (resp.status !== 401 && resp.status !== 404 && resp.status !== 403) return resp;

  const verdict = classifyGraphMailboxResponse(resp.status, await graphErrorCodeOf(resp), url);
  if (verdict === "no_mailbox") return await declareNoMailbox(recovery, resp);
  if (verdict !== "unauthorized") return resp;
  if (recovery.fresh) return await declareNoMailbox(recovery, resp);

  await resp.body?.cancel().catch(() => {});
  let pending = inflightForcedRefresh.get(token);
  if (!pending) {
    pending = recovery.refresh().finally(() => inflightForcedRefresh.delete(token));
    inflightForcedRefresh.set(token, pending);
  }
  const next = await pending; // outlook_auth_failed propagates: that one IS reconnect
  rememberBounded(replacedGraphTokens, token, next);

  const retried = await send(next);
  if (retried.ok) return retried;
  const again = classifyGraphMailboxResponse(retried.status, await graphErrorCodeOf(retried), url);
  if (again === "no_mailbox" || again === "unauthorized") {
    return await declareNoMailbox(graphAuthRecovery.get(next) ?? recovery, retried);
  }
  return retried;
}

// ─────────────────────────────────────────────────────────────────────────────
// Token refresh — rotation, persistence, single flight
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Entra authority segment for the token endpoint: `OUTLOOK_TENANT_ID` when
 * it is a plain tenant GUID or a domain name, `common` otherwise. The same rule
 * the web app's connect flow applies, so a refresh is redeemed against the
 * authority that issued the token. Anything else (a path, a URL, stray
 * whitespace inside) is ignored rather than concatenated into the URL.
 */
export function outlookAuthority(tenantId: string | undefined | null): string {
  const t = (tenantId ?? "").trim();
  // The well-known aliases the web app (outlookTenant) and the cron refresher
  // also accept; without this, OUTLOOK_TENANT_ID=organizations signed users in
  // under /organizations but refreshed them under /common.
  if (/^(common|organizations|consumers)$/i.test(t)) return t.toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return t;
  if (/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(t)) return t;
  return "common";
}

/** The v2.0 token endpoint for {@link outlookAuthority}'s tenant. */
export function outlookTokenUrl(tenantId: string | undefined | null): string {
  return `https://login.microsoftonline.com/${outlookAuthority(tenantId)}/oauth2/v2.0/token`;
}
export const OUTLOOK_REFRESH_SCOPE = "https://graph.microsoft.com/Mail.ReadWrite " +
  "https://graph.microsoft.com/Mail.Send " +
  "offline_access";

/** The four inbox columns a refresh reads and writes. */
export interface OutlookTokenRow {
  id: string;
  oauth_access_token: string | null;
  oauth_refresh_token: string | null;
  oauth_token_expires_at: string | null;
}

export interface OutlookTokenDeps {
  clientId: string | undefined;
  clientSecret: string | undefined;
  /** `OUTLOOK_TENANT_ID`; see {@link outlookAuthority}. */
  tenantId?: string | undefined;
  decrypt(stored: string): Promise<string>;
  encrypt(plain: string): Promise<string>;
  /**
   * Write the refreshed columns. AWAITED: Microsoft rotates the refresh token
   * on every refresh, and a rotation we fail to store leaves the row holding a
   * token that is one refresh older than the one Microsoft last issued.
   */
  persist(id: string, patch: Partial<OutlookTokenRow>): Promise<void>;
  /** Mark the inbox as needing a reconnect (invalid_grant / interaction_required). */
  markRevoked(id: string): Promise<void>;
  /**
   * Mark the inbox as having no Exchange Online mailbox (see
   * {@link OUTLOOK_NO_MAILBOX_MESSAGE}). Only {@link outlookAccessTokenForGraph}
   * uses it; failures are logged, never thrown.
   */
  markNoMailbox?(id: string): Promise<void>;
  /** Proactive window: refresh when the token expires sooner than this. */
  refreshThresholdMs: number;
  now?: () => number;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

interface RefreshOutcome {
  accessToken: string;
  patch: Partial<OutlookTokenRow>;
}

/**
 * One refresh per inbox per isolate. Two tool calls that land in the same
 * isolate with an expired token would otherwise both redeem the SAME refresh
 * token; Microsoft answers both, rotates twice, and whichever write lands
 * second decides which rotated token the row keeps.
 */
const inflightRefresh = new Map<string, Promise<RefreshOutcome>>();

/** Test seam. */
export function resetOutlookTokenStateForTests(): void {
  inflightRefresh.clear();
  graphAuthRecovery.clear();
  replacedGraphTokens.clear();
  inflightForcedRefresh.clear();
}

/**
 * Returns a usable Outlook access token for `row`, refreshing when it is within
 * `refreshThresholdMs` of expiry.
 *
 * On refresh: the new access token, the ROTATED refresh token when Microsoft
 * sent one, and the new expiry are encrypted and persisted before this
 * returns, and the same values are written onto `row` itself so that the next
 * Graph call in this request sees a fresh token instead of refreshing again.
 *
 * @throws Error("outlook_auth_failed") on invalid_grant / interaction_required
 *   (after marking the inbox), or when the row has no tokens at all.
 */
export async function freshOutlookAccessToken(
  row: OutlookTokenRow,
  deps: OutlookTokenDeps,
): Promise<string> {
  return (await acquireOutlookAccessToken(row, deps)).token;
}

async function acquireOutlookAccessToken(
  row: OutlookTokenRow,
  deps: OutlookTokenDeps,
): Promise<{ token: string; refreshed: boolean }> {
  if (!row.oauth_access_token || !row.oauth_refresh_token) {
    throw new Error(`Outlook inbox ${row.id} is missing OAuth tokens — user must reconnect.`);
  }
  const now = (deps.now ?? Date.now)();
  const expiresAt = row.oauth_token_expires_at ? new Date(row.oauth_token_expires_at).getTime() : 0;
  if (expiresAt > now + deps.refreshThresholdMs) {
    return { token: await deps.decrypt(row.oauth_access_token), refreshed: false };
  }
  return { token: await sharedRefresh(row, deps), refreshed: true };
}

/** The single-flight refresh, used by both the proactive and the forced path. */
async function sharedRefresh(row: OutlookTokenRow, deps: OutlookTokenDeps): Promise<string> {
  let pending = inflightRefresh.get(row.id);
  if (!pending) {
    pending = refreshOnce(row, deps).finally(() => inflightRefresh.delete(row.id));
    inflightRefresh.set(row.id, pending);
  }
  const outcome = await pending;
  Object.assign(row, outcome.patch);
  return outcome.accessToken;
}

/**
 * {@link freshOutlookAccessToken}, plus 401 recovery for every Graph call made
 * with the returned token (see "401 recovery" above). This is what index.ts
 * hands to its Graph call sites.
 *
 * The token is registered as `fresh` when it was minted by a refresh just now,
 * so a 401 on it is read as "no mailbox" without refreshing a second time. A
 * forced refresh registers its own token as fresh, so the retry that follows
 * cannot trigger another one.
 */
export async function outlookAccessTokenForGraph(
  row: OutlookTokenRow,
  deps: OutlookTokenDeps,
): Promise<string> {
  const { token, refreshed } = await acquireOutlookAccessToken(row, deps);
  registerOutlookRecovery(token, refreshed, row, deps);
  return token;
}

function registerOutlookRecovery(
  token: string,
  fresh: boolean,
  row: OutlookTokenRow,
  deps: OutlookTokenDeps,
): void {
  registerGraphAuthRecovery(token, {
    fresh,
    refresh: async () => {
      if (!row.oauth_refresh_token) {
        throw new Error(`Outlook inbox ${row.id} is missing OAuth tokens — user must reconnect.`);
      }
      const next = await sharedRefresh(row, deps);
      registerOutlookRecovery(next, true, row, deps);
      deps.log?.("outlook_graph_401_forced_refresh", { inbox_id: row.id });
      return next;
    },
    noMailbox: async () => {
      deps.log?.("outlook_no_mailbox", { inbox_id: row.id });
      try {
        await deps.markNoMailbox?.(row.id);
      } catch (e) {
        deps.log?.("outlook_no_mailbox_mark_failed", {
          inbox_id: row.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  });
}

async function refreshOnce(row: OutlookTokenRow, deps: OutlookTokenDeps): Promise<RefreshOutcome> {
  if (!deps.clientId || !deps.clientSecret) {
    throw new Error(
      "OUTLOOK_CLIENT_ID or OUTLOOK_CLIENT_SECRET is not configured in Edge Function secrets.",
    );
  }
  const refreshToken = await deps.decrypt(row.oauth_refresh_token as string);
  const resp = await fetch(outlookTokenUrl(deps.tenantId), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: deps.clientId,
      client_secret: deps.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: OUTLOOK_REFRESH_SCOPE,
    }).toString(),
  });

  if (!resp.ok) {
    let error: string | undefined;
    try {
      error = ((await resp.json()) as { error?: string }).error;
    } catch { /* non-JSON error body */ }
    if (error === "invalid_grant" || error === "interaction_required") {
      try {
        await deps.markRevoked(row.id);
      } catch (e) {
        deps.log?.("outlook_token_revoked_mark_failed", {
          inbox_id: row.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      throw new Error("outlook_auth_failed");
    }
    throw new Error(`Outlook token refresh failed: ${error ?? resp.statusText}`);
  }

  const tokens = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  const nowMs = (deps.now ?? Date.now)();
  const patch: Partial<OutlookTokenRow> = {
    oauth_access_token: await deps.encrypt(tokens.access_token),
    oauth_token_expires_at: new Date(nowMs + tokens.expires_in * 1_000).toISOString(),
  };
  if (tokens.refresh_token) {
    patch.oauth_refresh_token = await deps.encrypt(tokens.refresh_token);
  }
  try {
    await deps.persist(row.id, patch);
  } catch (e) {
    // The token itself is good for this request; only the stored copy is
    // stale. Microsoft keeps the previous refresh token redeemable, so the
    // next refresh still works — log loudly and carry on.
    deps.log?.("outlook_token_persist_failed", {
      inbox_id: row.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return { accessToken: tokens.access_token, patch };
}

// ─────────────────────────────────────────────────────────────────────────────
// Query building: $search and $filter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `$search` parameter value for a KQL expression: the WHOLE expression in
 * one pair of double quotes, with any `"` or `\` inside it backslash-escaped.
 *
 *   from:alice subject:"q3 report"  →  "from:alice subject:\"q3 report\""
 *
 * URLSearchParams then percent-encodes the result. Quoting each clause and then
 * the whole again (the pre-2026-09-25 behaviour) produced `""from:a" AND …"`,
 * which Graph rejects as a syntax error.
 */
export function graphSearchParam(kql: string): string {
  return `"${kql.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Earliest instant that is still a valid Exchange date; a no-op lower bound. */
export const GRAPH_EPOCH_FILTER = "receivedDateTime ge 1900-01-01T00:00:00Z";

/**
 * A `$filter` that may be sent beside `$orderby=receivedDateTime desc`.
 *
 * Graph's rule for messages: every `$orderby` property must also appear in
 * `$filter`, in the same order, BEFORE any other property. Otherwise the
 * request fails with 400 InefficientFilter ("The restriction or sort order is
 * too complex for this operation"). So the receivedDateTime clauses move to the
 * front, and when there are none a no-op lower bound is prepended.
 *
 * Clauses are split on the top-level ` and ` only; every filter this server
 * builds is a flat conjunction (see toGraphSearch), so no parenthesis-aware
 * parsing is needed.
 */
export function graphFilterForDateOrder(filter: string | undefined | null): string {
  const clauses = (filter ?? "")
    .split(/\s+and\s+/i)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  const dated = clauses.filter((c) => /^receivedDateTime\b/i.test(c));
  const rest = clauses.filter((c) => !/^receivedDateTime\b/i.test(c));
  const ordered = dated.length > 0 ? [...dated, ...rest] : [GRAPH_EPOCH_FILTER, ...rest];
  return ordered.join(" and ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Folders: the whole tree, with paths
// ─────────────────────────────────────────────────────────────────────────────

export interface OutlookFolderNode {
  id: string;
  displayName: string;
  /** "Parent/Child" for nested folders; the display name for top-level ones. */
  path: string;
  parentFolderId: string | null;
  depth: number;
  totalItemCount: number | null;
  unreadItemCount: number | null;
}

export interface OutlookFolderTree {
  folders: OutlookFolderNode[];
  /** True when a cap stopped the walk before every folder was seen. */
  truncated: boolean;
}

/** Hard ceilings on one folder walk. Exchange mailboxes can hold thousands. */
export const OUTLOOK_FOLDER_WALK_LIMITS = {
  maxFolders: 1000,
  maxDepth: 10,
  maxRequests: 80,
  /** Graph allows 4 concurrent requests per mailbox; never exceed it. */
  concurrency: 4,
};

const FOLDER_SELECT = "id,displayName,parentFolderId,childFolderCount,totalItemCount,unreadItemCount";

interface RawGraphFolder {
  id: string;
  displayName: string;
  parentFolderId?: string;
  childFolderCount?: number;
  totalItemCount?: number;
  unreadItemCount?: number;
}

/**
 * Walk every mail folder, following `@odata.nextLink` on each page and
 * descending into `childFolders` wherever `childFolderCount > 0`.
 *
 * Until 2026-09-25 the listing was ONE page of `$top=100` top-level folders, so
 * a folder nested under Inbox — which is where most Outlook users file mail —
 * could not be listed, resolved, searched or moved into by name.
 */
export async function listOutlookFolderTree(
  accessToken: string,
  limits = OUTLOOK_FOLDER_WALK_LIMITS,
): Promise<OutlookFolderTree> {
  const folders: OutlookFolderNode[] = [];
  let requests = 0;
  let truncated = false;

  async function fetchAll(firstUrl: string): Promise<RawGraphFolder[]> {
    const out: RawGraphFolder[] = [];
    let url: string | undefined = firstUrl;
    while (url) {
      if (requests >= limits.maxRequests) {
        truncated = true;
        break;
      }
      requests++;
      const resp = await graphFetch(accessToken, url);
      if (!resp.ok) throw await graphErrorFromResponse(resp, "Outlook mailFolders");
      const data = (await resp.json()) as { value?: RawGraphFolder[]; "@odata.nextLink"?: string };
      out.push(...(data.value ?? []));
      url = data["@odata.nextLink"];
    }
    return out;
  }

  const params = `?$top=100&$select=${FOLDER_SELECT}`;
  let level: { raw: RawGraphFolder; parentPath: string | null }[] =
    (await fetchAll(`/me/mailFolders${params}`)).map((raw) => ({ raw, parentPath: null }));

  for (let depth = 0; level.length > 0; depth++) {
    const expand: OutlookFolderNode[] = [];
    for (const { raw, parentPath } of level) {
      if (folders.length >= limits.maxFolders) {
        truncated = true;
        break;
      }
      const node: OutlookFolderNode = {
        id: raw.id,
        displayName: raw.displayName,
        path: parentPath === null ? raw.displayName : `${parentPath}/${raw.displayName}`,
        parentFolderId: raw.parentFolderId ?? null,
        depth,
        totalItemCount: raw.totalItemCount ?? null,
        unreadItemCount: raw.unreadItemCount ?? null,
      };
      folders.push(node);
      if ((raw.childFolderCount ?? 0) > 0) {
        if (depth + 1 >= limits.maxDepth) truncated = true;
        else expand.push(node);
      }
    }
    if (folders.length >= limits.maxFolders) break;

    const next: { raw: RawGraphFolder; parentPath: string | null }[] = [];
    for (let i = 0; i < expand.length; i += limits.concurrency) {
      const batch = expand.slice(i, i + limits.concurrency);
      const children = await Promise.all(
        batch.map((parent) =>
          fetchAll(`/me/mailFolders/${encodeURIComponent(parent.id)}/childFolders${params}`)
        ),
      );
      batch.forEach((parent, j) => {
        for (const raw of children[j]) next.push({ raw, parentPath: parent.path });
      });
    }
    level = next;
  }

  return { folders, truncated };
}

/**
 * Folder references for name resolution: every folder by its full path, plus
 * each nested folder by its bare display name WHEN that name is unique in the
 * mailbox and is not already some folder's path. "Receipts" filed under Inbox
 * then resolves by either spelling, and two "Receipts" under different parents
 * resolve only by path rather than by a coin flip.
 */
export function outlookFolderReferences(tree: OutlookFolderTree): { id: string; name: string }[] {
  const refs = tree.folders.map((f) => ({ id: f.id, name: f.path }));
  const taken = new Set(refs.map((r) => r.name.toLowerCase()));
  const leafCount = new Map<string, number>();
  for (const f of tree.folders) {
    const k = f.displayName.toLowerCase();
    leafCount.set(k, (leafCount.get(k) ?? 0) + 1);
  }
  for (const f of tree.folders) {
    if (f.depth === 0) continue;
    const k = f.displayName.toLowerCase();
    if (leafCount.get(k) === 1 && !taken.has(k)) {
      refs.push({ id: f.id, name: f.displayName });
      taken.add(k);
    }
  }
  return refs;
}

/**
 * The folder id for Outlook's `archive` role.
 *
 * `archive` is a Graph well-known name, but some consumer (outlook.com)
 * mailboxes have never had the folder provisioned and answer 404
 * ErrorFolderNotFound. Then: an existing top-level folder named "Archive",
 * and failing that, a newly created one — the same thing Outlook's own
 * Archive button does on such a mailbox.
 */
export async function resolveOutlookArchiveFolderId(accessToken: string): Promise<string> {
  const wk = await graphFetch(accessToken, "/me/mailFolders/archive?$select=id");
  if (wk.ok) return ((await wk.json()) as { id: string }).id;
  if (wk.status !== 404) throw await graphErrorFromResponse(wk, "Outlook archive folder");
  await wk.body?.cancel().catch(() => {});

  const findByName = async (): Promise<string | null> => {
    const q = new URLSearchParams({
      $filter: "displayName eq 'Archive'",
      $select: "id,displayName",
    });
    const r = await graphFetch(accessToken, `/me/mailFolders?${q}`);
    if (!r.ok) throw await graphErrorFromResponse(r, "Outlook archive folder lookup");
    const data = (await r.json()) as { value?: { id: string }[] };
    return data.value?.[0]?.id ?? null;
  };

  const existing = await findByName();
  if (existing) return existing;

  const created = await graphJson(accessToken, "/me/mailFolders", "POST", { displayName: "Archive" });
  if (created.ok) return ((await created.json()) as { id: string }).id;
  if (created.status === 409) {
    // Created concurrently between our lookup and our create.
    await created.body?.cancel().catch(() => {});
    const raced = await findByName();
    if (raced) return raced;
  }
  throw await graphErrorFromResponse(created, "Outlook archive folder create");
}

// ─────────────────────────────────────────────────────────────────────────────
// Composing: drafts, attachments (incl. upload sessions), send
// ─────────────────────────────────────────────────────────────────────────────

export interface GraphAttachmentInput {
  filename: string;
  mime_type: string;
  /** Standard base64 (whitespace tolerated). Ignored when `bytes` is given. */
  data?: string;
  /**
   * The raw octets, for a caller that already holds them (the forward relay's
   * 25 MB original): saves a base64 round trip of the whole file in memory.
   */
  bytes?: Uint8Array;
  isInline?: boolean;
  contentId?: string;
}

/** Standard base64 of `bytes`, 3-aligned chunks so padding only lands at the end. */
export function bytesToBase64Chunked(bytes: Uint8Array): string {
  const CHUNK = 8190; // multiple of 3
  let out = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += btoa(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return out;
}

function attachmentBase64(att: GraphAttachmentInput): string {
  if (att.bytes) return bytesToBase64Chunked(att.bytes);
  return (att.data ?? "").replace(/\s/g, "");
}

function attachmentBytes(att: GraphAttachmentInput): Uint8Array {
  return att.bytes ?? decodeBase64(att.data ?? "");
}

function attachmentSize(att: GraphAttachmentInput): number {
  return att.bytes ? att.bytes.length : base64DecodedLength(att.data ?? "");
}

/**
 * sendMail's JSON body and the attachments POST are both capped at 4 MB per
 * request. Base64 inflates by a third, so the whole-message inline path is
 * safe up to ~3 MB of encoded payload; past that the message goes through a
 * draft and each large file through an upload session.
 */
export const GRAPH_INLINE_PAYLOAD_MAX_BYTES = 3 * 1024 * 1024;

/**
 * The largest MIME message Graph's MIME sendMail can take: the body is the
 * message base64-encoded, the request is capped at 4 MB, and base64 inflates by
 * a third. Above this, a forward goes through createForward instead.
 */
export const GRAPH_MIME_SEND_MAX_BYTES = Math.floor((GRAPH_INLINE_PAYLOAD_MAX_BYTES * 3) / 4);

/** A single attachment POST is fine below this many DECODED bytes. */
export const GRAPH_SMALL_ATTACHMENT_MAX_BYTES = 3_000_000;

/** Upload-session chunk: a 320 KiB multiple, as Graph requires. 12 × 320 KiB = 3.75 MiB. */
export const GRAPH_UPLOAD_CHUNK_BYTES = 12 * 320 * 1024;

/** Decoded size of a base64 string, without decoding it. */
export function base64DecodedLength(b64: string): number {
  const clean = b64.replace(/\s/g, "");
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - pad);
}

/** True when a message with these attachments must not be sent as one JSON request. */
export function needsDraftUpload(attachments: readonly GraphAttachmentInput[]): boolean {
  let total = 0;
  for (const a of attachments) {
    total += a.bytes ? Math.ceil(a.bytes.length / 3) * 4 : (a.data ?? "").replace(/\s/g, "").length;
  }
  return total > GRAPH_INLINE_PAYLOAD_MAX_BYTES;
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The Graph fileAttachment object for an inline (JSON) attachment. */
export function graphFileAttachment(att: GraphAttachmentInput): Record<string, unknown> {
  return {
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: att.filename,
    contentType: att.mime_type,
    contentBytes: attachmentBase64(att),
    ...(att.isInline ? { isInline: true } : {}),
    ...(att.contentId ? { contentId: att.contentId } : {}),
  };
}

/**
 * Create a draft (`POST /me/messages`) and return its immutable id. The
 * message goes to Drafts; `attachments` must NOT be in `message` when any of
 * them is large — add those with {@link graphAddAttachments}.
 */
export async function graphCreateDraft(
  accessToken: string,
  message: Record<string, unknown>,
): Promise<{ id: string; conversationId: string | null; createdDateTime: string | null }> {
  const resp = await graphJson(accessToken, "/me/messages", "POST", message);
  if (!resp.ok) throw await graphErrorFromResponse(resp, "Outlook create draft");
  const data = (await resp.json()) as { id: string; conversationId?: string; createdDateTime?: string };
  return { id: data.id, conversationId: data.conversationId ?? null, createdDateTime: data.createdDateTime ?? null };
}

/** Upload one file through an upload session. Exported for the chunking test. */
export async function graphUploadLargeAttachment(
  accessToken: string,
  messageId: string,
  att: GraphAttachmentInput,
  chunkBytes = GRAPH_UPLOAD_CHUNK_BYTES,
): Promise<void> {
  if (chunkBytes % (320 * 1024) !== 0) {
    throw new Error("upload chunk size must be a multiple of 320 KiB");
  }
  const bytes = attachmentBytes(att);
  const session = await graphJson(
    accessToken,
    `/me/messages/${encodeURIComponent(messageId)}/attachments/createUploadSession`,
    "POST",
    {
      AttachmentItem: {
        attachmentType: "file",
        name: att.filename,
        size: bytes.length,
        contentType: att.mime_type,
        ...(att.isInline ? { isInline: true } : {}),
        ...(att.contentId ? { contentId: att.contentId } : {}),
      },
    },
  );
  if (!session.ok) throw await graphErrorFromResponse(session, "Outlook attachment upload session");
  const { uploadUrl } = (await session.json()) as { uploadUrl?: string };
  if (!uploadUrl) throw new Error("Outlook attachment upload session returned no uploadUrl");

  for (let start = 0; start < bytes.length; start += chunkBytes) {
    const end = Math.min(start + chunkBytes, bytes.length);
    const chunk = bytes.slice(start, end);
    // The uploadUrl is pre-authenticated. Sending the bearer token to it is
    // documented as a cause of 401s, so this PUT goes out WITHOUT graphFetch.
    const put = await fetchWithGraphRetry(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(chunk.length),
        "Content-Range": `bytes ${start}-${end - 1}/${bytes.length}`,
      },
      body: chunk.buffer as ArrayBuffer,
    });
    if (!put.ok) {
      // Abandon the session so the half-written attachment does not linger.
      await fetch(uploadUrl, { method: "DELETE" }).then((r) => r.body?.cancel()).catch(() => {});
      throw await graphErrorFromResponse(put, "Outlook attachment upload");
    }
    await put.body?.cancel().catch(() => {});
  }
}

/**
 * Attach files to an existing draft: a plain POST for each small one, an
 * upload session for each large one. Sequential on purpose — each upload is
 * already several requests, and Graph meters concurrency per mailbox.
 */
export async function graphAddAttachments(
  accessToken: string,
  messageId: string,
  attachments: readonly GraphAttachmentInput[],
): Promise<void> {
  for (const att of attachments) {
    if (attachmentSize(att) <= GRAPH_SMALL_ATTACHMENT_MAX_BYTES) {
      const resp = await graphJson(
        accessToken,
        `/me/messages/${encodeURIComponent(messageId)}/attachments`,
        "POST",
        graphFileAttachment(att),
      );
      if (!resp.ok) throw await graphErrorFromResponse(resp, "Outlook add attachment");
      await resp.body?.cancel().catch(() => {});
    } else {
      await graphUploadLargeAttachment(accessToken, messageId, att);
    }
  }
}

/** `PATCH /me/messages/{id}`. */
export async function graphPatchMessage(
  accessToken: string,
  messageId: string,
  patch: Record<string, unknown>,
  context = "Outlook update message",
): Promise<void> {
  const resp = await graphJson(accessToken, `/me/messages/${encodeURIComponent(messageId)}`, "PATCH", patch);
  if (!resp.ok) throw await graphErrorFromResponse(resp, context);
  await resp.body?.cancel().catch(() => {});
}

/**
 * `POST /me/messages/{id}/send`. Returns the raw response so the caller keeps
 * its own status mapping: this is the transmission step, and what a failure
 * here means for delivery is the caller's to say.
 */
export function graphSendDraft(accessToken: string, draftId: string): Promise<Response> {
  return graphFetch(accessToken, `/me/messages/${encodeURIComponent(draftId)}/send`, {
    method: "POST",
    headers: { "Content-Length": "0" },
  });
}

/** Best-effort cleanup of a draft we created and could not finish. Never throws. */
export async function graphDeleteDraftQuietly(accessToken: string, draftId: string): Promise<void> {
  try {
    const r = await graphFetch(accessToken, `/me/messages/${encodeURIComponent(draftId)}`, {
      method: "DELETE",
    });
    await r.body?.cancel().catch(() => {});
  } catch {
    /* the draft stays in Drafts; nothing was sent either way */
  }
}

/**
 * `createReply` / `createReplyAll` / `createForward` on `messageId`: a draft
 * that Graph threads natively (its own In-Reply-To / References, conversation
 * id, and the quoted original in the body).
 */
export async function graphCreateResponseDraft(
  accessToken: string,
  messageId: string,
  kind: "createReply" | "createReplyAll" | "createForward",
): Promise<{
  id: string;
  conversationId: string | null;
  subject: string | null;
  body: { contentType: string; content: string };
  createdDateTime: string | null;
  toRecipients: { name: string; email: string }[];
}> {
  const resp = await graphJson(
    accessToken,
    `/me/messages/${encodeURIComponent(messageId)}/${kind}`,
    "POST",
    {},
  );
  if (!resp.ok) {
    if (resp.status === 404) {
      await resp.body?.cancel().catch(() => {});
      throw new Error("message_not_found");
    }
    throw await graphErrorFromResponse(resp, `Outlook ${kind}`);
  }
  const data = (await resp.json()) as {
    id: string;
    conversationId?: string;
    subject?: string;
    body?: { contentType?: string; content?: string };
    createdDateTime?: string;
    toRecipients?: { emailAddress?: { name?: string; address?: string } }[];
  };
  return {
    toRecipients: (data.toRecipients ?? []).map((r) => ({
      name: r.emailAddress?.name ?? "",
      email: r.emailAddress?.address ?? "",
    })),
    id: data.id,
    conversationId: data.conversationId ?? null,
    subject: data.subject ?? null,
    body: { contentType: data.body?.contentType ?? "html", content: data.body?.content ?? "" },
    createdDateTime: data.createdDateTime ?? null,
  };
}

/**
 * The compose half of a reply or forward: create Graph's threaded response
 * draft, PATCH it (addressing plus the caller's content merged ABOVE Graph's
 * quote), and attach files. Everything here happens in the sender's Drafts
 * folder; nothing is sent. On any failure the draft is deleted again and the
 * error rethrown, so the caller's "not sent, safe to retry" stays true.
 *
 * The caller sends with {@link graphSendDraft}. The split exists because
 * send-stages.ts must be able to say which side of transmission a failure was.
 */
export async function graphPrepareResponseDraft(
  accessToken: string,
  opts: {
    messageId: string;
    kind: "createReply" | "createReplyAll" | "createForward";
    /** Written as-is onto the draft: subject, toRecipients, ccRecipients, … */
    patch: Record<string, unknown>;
    html?: string | null;
    text?: string | null;
    attachments?: readonly GraphAttachmentInput[];
    /** Forward with include_attachments: false — drop the original's files. */
    removeFileAttachments?: boolean;
  },
): Promise<{
  id: string;
  conversationId: string | null;
  subject: string | null;
  toRecipients: { name: string; email: string }[];
  createdDateTime: string | null;
}> {
  const draft = await graphCreateResponseDraft(accessToken, opts.messageId, opts.kind);
  try {
    await graphPatchMessage(accessToken, draft.id, {
      ...opts.patch,
      body: mergeResponseBody(draft.body, { html: opts.html, text: opts.text }),
    }, `Outlook ${opts.kind} draft`);
    if (opts.removeFileAttachments) {
      for (const att of await graphListAttachmentMeta(accessToken, draft.id)) {
        if (att.isInline) continue;
        const del = await graphFetch(
          accessToken,
          `/me/messages/${encodeURIComponent(draft.id)}/attachments/${encodeURIComponent(att.id)}`,
          { method: "DELETE" },
        );
        if (!del.ok) throw await graphErrorFromResponse(del, "Outlook attachment removal");
        await del.body?.cancel().catch(() => {});
      }
    }
    if (opts.attachments && opts.attachments.length > 0) {
      await graphAddAttachments(accessToken, draft.id, opts.attachments);
    }
  } catch (e) {
    await graphDeleteDraftQuietly(accessToken, draft.id);
    throw e;
  }
  return {
    id: draft.id,
    conversationId: draft.conversationId,
    subject: draft.subject,
    toRecipients: draft.toRecipients,
    createdDateTime: draft.createdDateTime,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Plain text as an HTML fragment that keeps its line breaks. */
export function textToHtmlFragment(text: string): string {
  return `<div style="white-space:pre-wrap">${escapeHtml(text)}</div>`;
}

/**
 * Put the caller's new content ABOVE the quoted original that createReply /
 * createForward generated, instead of replacing it.
 *
 * Graph returns the draft body as HTML with the quote inside `<body>`. The new
 * content is inserted right after the opening `<body…>` tag (or prepended when
 * the draft is a bare fragment). A text-typed draft body — which Graph uses
 * when the mailbox composes in plain text — gets text prepended instead.
 */
export function mergeResponseBody(
  draftBody: { contentType: string; content: string },
  add: { html?: string | null; text?: string | null },
): { contentType: "HTML" | "Text"; content: string } {
  const isHtml = draftBody.contentType.toLowerCase() === "html";
  if (!isHtml) {
    const text = add.text ?? (add.html ? add.html.replace(/<[^>]+>/g, "") : "");
    return { contentType: "Text", content: text ? `${text}\r\n\r\n${draftBody.content}` : draftBody.content };
  }
  const fragment = add.html && add.html.trim()
    ? add.html
    : add.text
    ? textToHtmlFragment(add.text)
    : "";
  if (!fragment) return { contentType: "HTML", content: draftBody.content };
  const bodyOpen = draftBody.content.match(/<body\b[^>]*>/i);
  if (bodyOpen && bodyOpen.index !== undefined) {
    const at = bodyOpen.index + bodyOpen[0].length;
    return {
      contentType: "HTML",
      content: `${draftBody.content.slice(0, at)}${fragment}${draftBody.content.slice(at)}`,
    };
  }
  return { contentType: "HTML", content: `${fragment}${draftBody.content}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading attachments without downloading them
// ─────────────────────────────────────────────────────────────────────────────

export interface GraphAttachmentMeta {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
  /** file | item | reference, from `@odata.type`. */
  kind: "file" | "item" | "reference";
}

/**
 * List a message's attachments as METADATA only. Without `$select`, Graph
 * returns every fileAttachment's `contentBytes` inline, so listing a message
 * with a 20 MB attachment used to download all 20 MB just to print its name.
 */
export async function graphListAttachmentMeta(
  accessToken: string,
  messageId: string,
): Promise<GraphAttachmentMeta[]> {
  const out: GraphAttachmentMeta[] = [];
  let url: string | undefined = `/me/messages/${encodeURIComponent(messageId)}/attachments` +
    `?$select=id,name,contentType,size,isInline`;
  while (url) {
    const resp = await graphFetch(accessToken, url);
    if (!resp.ok) {
      if (resp.status === 404) {
        await resp.body?.cancel().catch(() => {});
        throw new Error("message_not_found");
      }
      throw await graphErrorFromResponse(resp, "Outlook attachments");
    }
    const data = (await resp.json()) as {
      value?: {
        id: string;
        name?: string;
        contentType?: string;
        size?: number;
        isInline?: boolean;
        "@odata.type"?: string;
      }[];
      "@odata.nextLink"?: string;
    };
    for (const a of data.value ?? []) {
      const t = (a["@odata.type"] ?? "").toLowerCase();
      const kind = t.includes("itemattachment") ? "item" : t.includes("referenceattachment") ? "reference" : "file";
      out.push({
        id: a.id,
        name: a.name ?? "attachment",
        contentType: a.contentType ?? (kind === "item" ? "message/rfc822" : "application/octet-stream"),
        size: a.size ?? 0,
        isInline: a.isInline === true,
        kind,
      });
    }
    url = data["@odata.nextLink"];
  }
  return out;
}

/**
 * One attachment's bytes via `/$value`: the raw file for a fileAttachment, the
 * MIME of the attached item for an itemAttachment. A referenceAttachment is a
 * link to a cloud file and has no bytes to give; callers skip it.
 */
export async function graphDownloadAttachment(
  accessToken: string,
  messageId: string,
  attachmentId: string,
): Promise<Uint8Array> {
  const resp = await graphFetch(
    accessToken,
    `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`,
  );
  if (!resp.ok) throw await graphErrorFromResponse(resp, "Outlook attachment download");
  return new Uint8Array(await resp.arrayBuffer());
}
