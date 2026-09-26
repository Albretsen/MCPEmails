// ---------------------------------------------------------------------------
// Which access preset the /authorize consent screen starts on.
//
// WHY THIS MODULE EXISTS. The presets used to live as a literal in
// components/auth/AuthorizeApp.jsx with `recommended: true` hard-coded on
// "standard", and the initial mode was "standard if available, else the first
// available preset". That was written when a client's `scope` param told us
// almost nothing: every MCP client asked for everything it could, so there was
// no narrower request to honour, and a user who granted too little was simply
// stuck (a denied call came back as a dead-key error, not something a client
// could recover from).
//
// Both halves of that stopped being true on 2026-09-09:
//
//   1. app/api/mcp/route.ts now answers an unauthenticated call with
//      WWW-Authenticate scope="read:email" alone instead of all nine scopes, so
//      the authorize request claude.ai actually sends is `scope=read:email`.
//      Verified on the wire against real claude.ai.
//   2. supabase/functions/mcp-server/scope-challenge.ts answers a call that
//      needs a scope the token lacks with HTTP 403 and
//      error="insufficient_scope", so a client can step up, re-consent for that
//      one scope, and retry. Granting too little is now recoverable.
//
// So a consent screen that defaults to "standard" takes a request for reading
// and talks the user into send, drafts and contacts: exactly the over-asking
// that was just removed from the challenge, moved one screen later. This module
// is the fix, kept pure and out of the component so the decision is unit
// testable rather than only observable by rendering the page.
//
// THE EXCEPTION: OPENAI'S HOSTS (2026-09-25). Point 2 above is only true for a
// client that actually performs the RFC 6750 step-up. ChatGPT does not. OpenAI
// rejected our ChatGPT app on 2026-09-25 with this exact sequence: the reviewer
// added the connector, ChatGPT's authorize request carried `scope=read:email`
// (copied from our 401 challenge), the screen opened on "Read-only" with the
// Recommended badge, the reviewer clicked Allow, and every send and
// automation-create test then failed with insufficient_scope and never
// recovered. OpenAI's host ignores an HTTP 403 + WWW-Authenticate
// error="insufficient_scope"; the only re-link signal it acts on is
// `_meta["mcp/www_authenticate"]` on a tool RESULT. So for ChatGPT, and for
// Codex when it arrives through OpenAI's CIMD document, a narrow default is the
// unrecoverable case the no-`scope` branch below already exists to avoid, and
// the screen opens on "Full access" instead. Nothing is hidden or forced: every
// card and every per-scope toggle is still there and the user can narrow the
// grant before clicking Allow. Only the preselected card and the badge move.
// The client is identified by `identifyStepUpLimitedClient` below, from the
// validated client_id / redirect_uri HOST, never from the self-asserted
// DCR client_name.
//
// Run the tests: npm run test:oauth-presets (from apps/web).
// ---------------------------------------------------------------------------

import { VALID_SCOPES } from '@/lib/api-keys/scopes';

/** The id of a preset card, or 'custom' for the per-scope card. */
export type AccessMode = 'readOnly' | 'standard' | 'full' | 'custom';

export interface AccessPreset {
  id: Exclude<AccessMode, 'custom'>;
  scopes: readonly string[];
}

/**
 * The three named grants, narrowest first.
 *
 * Order is load-bearing twice over: `resolveDefaultAccess` walks it narrowest
 * first, and the cards render in this order so the radiogroup's arrow keys move
 * from less access to more.
 *
 * `search:email` stays in every preset ON PURPOSE, and specifically stays in
 * "readOnly" even though the narrowest thing a client asks for is `read:email`
 * alone. It is vestigial: no tool in supabase/functions/mcp-server/index.ts
 * names it as a `requiredScope`; it appears only as an `altScopes` entry on
 * `email_read{action:"search"}`, whose primary is already `read:email`. A token
 * holding `read:email` can therefore already search, and adding `search:email`
 * to it changes the capability set not at all. Taking it out of "readOnly" to
 * make the grant literally equal the request would look tidier and would cost
 * something real: a client that asks for `read:email search:email` (our own
 * .well-known advertises both) would then no longer match "readOnly" and would
 * fall through to "standard", which really does add send, drafts and contacts.
 * Trading a no-op scope for that is a bad trade, so the equivalence is handled
 * in `canonicalScopes` below instead of by shrinking the preset.
 */
export const ACCESS_PRESETS: readonly AccessPreset[] = [
  { id: 'readOnly', scopes: ['read:email', 'search:email'] },
  { id: 'standard', scopes: ['read:email', 'search:email', 'send:email', 'manage:drafts', 'manage:contacts'] },
  {
    id: 'full',
    scopes: [
      'read:email', 'search:email', 'send:email', 'manage:folders', 'delete:email',
      'manage:drafts', 'manage:contacts', 'schedule:email', 'manage:automations',
    ],
  },
];

export interface ResolvedPreset extends AccessPreset {
  /** The preset's scopes intersected with what the client may be granted. */
  effectiveScopes: string[];
  /** True only when EVERY scope of the preset is on offer. */
  available: boolean;
}

/**
 * Intersect each preset with the scopes this client is allowed to hold.
 *
 * A partially-offered preset is NOT available: a card labelled "Full access"
 * that quietly granted six of nine scopes would be a lie, and the UI greys it
 * out with a tooltip rather than silently narrowing it.
 */
export function resolvePresets(offeredScopes: readonly string[]): ResolvedPreset[] {
  const offered = new Set(offeredScopes);
  return ACCESS_PRESETS.map((preset) => {
    const effectiveScopes = preset.scopes.filter((s) => offered.has(s));
    return {
      ...preset,
      effectiveScopes,
      available: effectiveScopes.length === preset.scopes.length && effectiveScopes.length > 0,
    };
  });
}

/**
 * Reduce a scope set to the capabilities it actually confers, so two spellings
 * of the same grant compare equal.
 *
 * Today that is one rule: `search:email` alongside `read:email` adds nothing
 * (see ACCESS_PRESETS above), so it drops out. `search:email` on its own is NOT
 * dropped: that token can search and do nothing else, which is a genuinely
 * narrower grant than "readOnly" and must not be widened into one.
 */
export function canonicalScopes(scopes: readonly string[]): string[] {
  const set = new Set(scopes);
  if (set.has('read:email')) set.delete('search:email');
  return [...set].sort();
}

function sameScopes(a: readonly string[], b: readonly string[]): boolean {
  const ca = canonicalScopes(a);
  const cb = canonicalScopes(b);
  return ca.length === cb.length && ca.every((s, i) => s === cb[i]);
}

export interface DefaultAccess {
  /** The card that starts selected. */
  mode: AccessMode;
  /** The scopes ticked at first render, in the caller's offered order. */
  scopes: string[];
  /**
   * The card the RECOMMENDED badge sits on. Always equal to `mode`, and
   * exported as its own field so the component never re-derives it: the badge
   * must keep pointing at the DEFAULT after the user clicks a different card,
   * not follow the click.
   */
  recommendedMode: AccessMode;
  /**
   * Why we landed here. 'request' means the client told us what it wanted;
   * 'no-request' is the pre-2026-09-09 behaviour, kept for clients that send no
   * `scope` param at all. Surfaced for tests and for anyone reading a session
   * recording who wants to know which branch ran. 'client-cannot-step-up'
   * means the client was identified as one that never performs the HTTP 403
   * step-up (see the header and `identifyStepUpLimitedClient`), so the request
   * was deliberately not honoured narrowly.
   */
  basis: 'request' | 'no-request' | 'client-cannot-step-up';
}

export interface DefaultAccessInput {
  /** Every scope this client may be granted (its scopes_allowed), in canonical order. */
  offeredScopes: readonly string[];
  /** The scopes the client put in the `scope` query param. Empty/absent is the legacy case. */
  requestedScopes?: readonly string[] | null;
  /**
   * True when the authorizing client is known NOT to perform the RFC 6750
   * HTTP 403 step-up (today: OpenAI's hosts, via `identifyStepUpLimitedClient`).
   * Computed by the caller from the validated client, never from the request's
   * `scope`. Overrides the requested scope: the screen opens on the widest
   * available preset, because a narrow grant is unrecoverable for this client.
   */
  clientCannotStepUp?: boolean;
}

const VALID = new Set<string>(VALID_SCOPES);

/**
 * Decide which card the consent screen opens on, and with which scopes ticked.
 *
 * THE RULE: default to the narrowest option that satisfies what the client
 * actually asked for.
 *
 *   no `scope` param      the pre-2026-09-09 default, unchanged (see below)
 *   request == a preset   that preset, compared on capabilities not spelling
 *   anything else         Custom, with exactly the requested scopes ticked
 *
 * WHY A STRICT SUPERSET FALLS TO CUSTOM RATHER THAN CLIMBING THE LADDER. The
 * presets are nested (readOnly ⊂ standard ⊂ full), so "the narrowest preset
 * that covers all of them" is always well defined and would always find one.
 * Using it would mean a client asking for `read:email send:email` opens on
 * "standard", which also hands over drafts and contacts. That is a smaller
 * version of the bug this module exists to fix, so a request that matches no
 * preset gets Custom pre-ticked with exactly what was asked instead. Nothing is
 * taken away: every wider preset is still one click away, which is how a user
 * who would rather not be interrupted by step-up prompts grants more than the
 * client asked for.
 *
 * WHY THE NO-`scope` CASE KEEPS THE OLD DEFAULT. Not every client sends one:
 * the 2026-06-05 migration that widened dynamic clients was written because the
 * consent screen "could only ever offer those three (and, when the client sent
 * no `scope` param, nothing at all)", and 347 of the 348 consents on record
 * belong to dynamically-registered clients spanning Claude, Cursor, ChatGPT,
 * Codex, Smithery, Manus, Glama, Grok and Poke. Nothing in the schema records
 * the `scope` a request carried, so which of those omit it cannot be read back
 * out; what can be said is that a client that does not name the scopes it wants
 * is the client least likely to implement the RFC 6750 step-up dance that makes
 * a narrow default recoverable. Defaulting it to a read-only grant would leave
 * it with a token that cannot send and no way to ask for more. So: no `scope`,
 * no change.
 */
export function resolveDefaultAccess({
  offeredScopes,
  requestedScopes,
  clientCannotStepUp = false,
}: DefaultAccessInput): DefaultAccess {
  const offered = offeredScopes.filter((s) => VALID.has(s));
  const offeredSet = new Set(offered);
  const presets = resolvePresets(offered);

  // A client that cannot step up gets the WIDEST whole preset on offer ("full"
  // for every DCR and CIMD client, whose ceiling is all nine scopes), whatever
  // it asked for. See the header for the 2026-09-25 rejection this answers. If
  // no preset is wholly on offer, Custom with everything offered: still the
  // widest grant the ceiling allows, and still narrowable by the user.
  if (clientCannotStepUp) {
    const widest = [...presets].reverse().find((p) => p.available) ?? null;
    return widest
      ? { mode: widest.id, scopes: [...widest.effectiveScopes], recommendedMode: widest.id, basis: 'client-cannot-step-up' }
      : { mode: 'custom', scopes: [...offered], recommendedMode: 'custom', basis: 'client-cannot-step-up' };
  }

  // Unknown scope strings and scopes outside this client's ceiling are dropped
  // rather than rejected: RFC 6749 §3.3 lets the server ignore what it does not
  // recognise, and the POST at api/oauth/authorize filters against
  // scopes_allowed again anyway, so a default built from anything else would be
  // a default the server then refuses.
  const requested = (requestedScopes ?? []).filter((s) => offeredSet.has(s));

  if (requested.length === 0) {
    const fallback =
      presets.find((p) => p.id === 'standard' && p.available) ??
      presets.find((p) => p.available) ??
      null;
    return fallback
      ? { mode: fallback.id, scopes: [...fallback.effectiveScopes], recommendedMode: fallback.id, basis: 'no-request' }
      : { mode: 'custom', scopes: [...offered], recommendedMode: 'custom', basis: 'no-request' };
  }

  const match = presets.find((p) => p.available && sameScopes(p.effectiveScopes, requested));
  if (match) {
    return { mode: match.id, scopes: [...match.effectiveScopes], recommendedMode: match.id, basis: 'request' };
  }

  // Offered order, not the order the client happened to write them in, so the
  // ticked rows line up with the permission list underneath.
  const ticked = offered.filter((s) => requested.includes(s));
  return { mode: 'custom', scopes: ticked, recommendedMode: 'custom', basis: 'request' };
}

// ---------------------------------------------------------------------------
// Which clients cannot step up.
// ---------------------------------------------------------------------------

/** A client known to ignore the HTTP 403 insufficient_scope step-up. */
export type StepUpLimitedClient = 'chatgpt' | 'codex';

/**
 * OpenAI's hosts. Compared EXACTLY against URL.hostname (which the URL parser
 * has already lower-cased), never as a substring or suffix: `t.co` once matched
 * inside `chatgpt.com` in the acquisition classifier, and `evilchatgpt.com` or
 * `chatgpt.com.attacker.net` must not pass here either.
 */
const OPENAI_HOSTS: ReadonlySet<string> = new Set(['chatgpt.com', 'chat.openai.com']);

/**
 * OpenAI's CIMD client_id paths, all on an OPENAI_HOSTS origin:
 *   /oauth/client.json                  ChatGPT, documented stable id
 *   /oauth/{callback_id}/client.json    ChatGPT, documented per-connector id
 *   /oauth/codex/{id}/client.json       Codex, observed in oauth_consents (17
 *                                       grants to 2026-09-23)
 */
const OPENAI_CIMD_PATH = /^\/oauth\/(codex\/)?(?:[A-Za-z0-9_-]+\/)?client\.json$/;

/**
 * ChatGPT's connector redirect_uris. Documented: the stable
 * /connector_platform_oauth_redirect and the per-callback
 * /connector/oauth/{callback_id}. All 48 ChatGPT DCR rows in oauth_clients (to
 * 2026-09-16) use the second shape.
 */
function isChatGptRedirectPath(pathname: string): boolean {
  return pathname === '/connector_platform_oauth_redirect' || /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(pathname);
}

/** An https URL on an exact OpenAI host with no port and no userinfo, or null. */
function parseOpenAiUrl(raw: string | null | undefined): URL | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return null;
  return OPENAI_HOSTS.has(url.hostname) ? url : null;
}

/**
 * Identify a client that never performs the RFC 6750 HTTP 403 step-up, from
 * the two values the /authorize page has already VALIDATED: the client_id (a
 * CIMD URL is fetched and must be self-referential, so its origin is proof of
 * who published it) and the redirect_uri (checked against the registered or
 * CIMD-listed URIs, so a DCR client claiming chatgpt.com can only ever send the
 * code to chatgpt.com).
 *
 * Deliberately NOT consulted: the DCR `client_name`. It is free text any
 * registrant sets, and matching "ChatGPT" or "Codex" on it would let anyone
 * open the consent screen pre-set to Full access. This is also why the legacy
 * DCR Codex registrations (client_name "Codex", loopback
 * http://127.0.0.1:{port}/callback redirect) are NOT identified: nothing about
 * them is attributable to OpenAI, so they keep the ordinary request-based
 * default. Codex is identified only when it authorizes through OpenAI's own
 * CIMD document on chatgpt.com.
 */
export function identifyStepUpLimitedClient({
  clientId,
  redirectUri,
}: {
  clientId: string | null | undefined;
  redirectUri: string | null | undefined;
}): StepUpLimitedClient | null {
  const cimd = parseOpenAiUrl(clientId);
  if (cimd && cimd.search === '' && cimd.hash === '') {
    const m = OPENAI_CIMD_PATH.exec(cimd.pathname);
    if (m) return m[1] ? 'codex' : 'chatgpt';
  }
  const redirect = parseOpenAiUrl(redirectUri);
  if (redirect && isChatGptRedirectPath(redirect.pathname)) return 'chatgpt';
  return null;
}
