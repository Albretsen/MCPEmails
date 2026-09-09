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
   * recording who wants to know which branch ran.
   */
  basis: 'request' | 'no-request';
}

export interface DefaultAccessInput {
  /** Every scope this client may be granted (its scopes_allowed), in canonical order. */
  offeredScopes: readonly string[];
  /** The scopes the client put in the `scope` query param. Empty/absent is the legacy case. */
  requestedScopes?: readonly string[] | null;
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
export function resolveDefaultAccess({ offeredScopes, requestedScopes }: DefaultAccessInput): DefaultAccess {
  const offered = offeredScopes.filter((s) => VALID.has(s));
  const offeredSet = new Set(offered);
  const presets = resolvePresets(offered);

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
