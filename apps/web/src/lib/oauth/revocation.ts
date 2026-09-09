/**
 * RFC 7009 token revocation, as a grant-level operation.
 *
 * ── Why this is not "delete the row the token points at" ────────────────────
 *
 * An OAuth connection here is TWO rows, not one:
 *
 *   api_keys              the mcpe_ access token, rotated in place every hour
 *   oauth_refresh_tokens  the mcpr_ chain, a new row per refresh, old one
 *                         revoked, all of them pointing at that one api_keys.id
 *
 * Killing one half does not end the connection. Kill only the refresh chain and
 * the access token stays valid for up to an hour, so the client keeps reading
 * mail after the user believed they had cut it off. Kill only the api_keys row
 * and the refresh token is, in principle, the thing that mints a replacement;
 * the token endpoint's `deleted_at` guard happens to catch that today, but a
 * revocation endpoint that relies on another endpoint's guard to be complete is
 * one refactor away from leaving a live credential behind.
 *
 * So revocation resolves the token to its GRANT (the api_keys row id that the
 * whole chain hangs off) and then revokes both halves, exactly the way
 * PATCH /api/api-keys/[id]/revoke does for the dashboard button.
 *
 * ── Why the token type hint is advisory and nothing more ────────────────────
 *
 * RFC 7009 §2.1 makes `token_type_hint` an optimisation and requires the server
 * to extend its search to the other types when the hint does not find the
 * token, precisely so a client that guesses wrong still gets revocation rather
 * than a silent no-op. Both of our token types hash the same way (SHA-256 hex
 * of the UTF-8 value; `hashApiKey` and `sha256hex` are the same function under
 * two names), so "search both" costs one extra indexed lookup and never a
 * second hash. The hint and the `mcpe_`/`mcpr_` prefix therefore only decide
 * which table we ask FIRST.
 *
 * ── Why an already-revoked token is still looked up ─────────────────────────
 *
 * The refresh-token lookup deliberately does NOT filter on `revoked_at IS
 * NULL`. A grant can be half-revoked (a crash between the two writes, or the
 * historical version of this endpoint that only touched one table), and the
 * whole point of presenting the token again is to finish the job. Finding a
 * fully-revoked grant and writing nothing is also correct and still answers
 * 200, per §2.2.
 *
 * Nothing in the return value is safe to put in an HTTP response body: RFC 7009
 * §2.2 requires 200 for an unknown or already-revoked token so the endpoint
 * cannot be used as an oracle for token validity. The outcome exists for the
 * audit log.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { hashApiKey } from '@/lib/api-keys/generate';
import { looksLikeUrlClientId, parseCimdClientId } from '@/lib/oauth/cimd';
import { sha256hex } from '@/lib/oauth/crypto';

export type RevocationTokenKind = 'access_token' | 'refresh_token';

export interface RevocationOutcome {
  /** Did this call write anything? False for unknown and already-revoked tokens. */
  revoked: boolean;
  /** Which table the token was actually found in, regardless of the hint. */
  matchedAs: RevocationTokenKind | null;
  /** The grant: the api_keys row the whole chain hangs off. Null for a legacy chain. */
  apiKeyId: string | null;
  workspaceId: string | null;
  clientId: string | null;
  keyPrefix: string | null;
  /** Rows actually transitioned by this call, for the audit log. */
  accessTokensRevoked: number;
  refreshTokensRevoked: number;
}

const NOTHING: RevocationOutcome = {
  revoked: false,
  matchedAs: null,
  apiKeyId: null,
  workspaceId: null,
  clientId: null,
  keyPrefix: null,
  accessTokensRevoked: 0,
  refreshTokensRevoked: 0,
};

/**
 * The order in which the two tables are searched. Always both kinds: the hint
 * only moves the likely one to the front (RFC 7009 §2.1).
 *
 * The prefix beats the hint when they disagree, because the prefix is a fact
 * about the token we are holding and the hint is a claim by the caller.
 */
export function revocationLookupOrder(
  token: string,
  tokenTypeHint?: string | null,
): RevocationTokenKind[] {
  const refreshFirst: RevocationTokenKind[] = ['refresh_token', 'access_token'];
  const accessFirst: RevocationTokenKind[] = ['access_token', 'refresh_token'];

  if (token.startsWith('mcpr_')) return refreshFirst;
  if (token.startsWith('mcpe_')) return accessFirst;
  if (tokenTypeHint === 'refresh_token') return refreshFirst;
  if (tokenTypeHint === 'access_token') return accessFirst;
  return accessFirst;
}

/**
 * The `client_id` a caller sent, as it should appear in the audit log.
 *
 * It is never used to decide WHETHER to revoke (see the route header), only to
 * make the log line comparable across calls. A CIMD client_id is an HTTPS URL
 * rather than a `dyn_` id, and the same client can spell that URL more than one
 * way, so it is normalised the same way /authorize and /token normalise it. A
 * URL that does not parse is dropped rather than logged raw: it is
 * attacker-controlled free text and there is nothing to learn from it.
 */
export function loggableClientId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!looksLikeUrlClientId(raw)) return raw.slice(0, 200);
  const parsed = parseCimdClientId(raw);
  return parsed.ok ? parsed.value.normalized : null;
}

interface ResolvedGrant {
  matchedAs: RevocationTokenKind;
  apiKeyId: string | null;
  workspaceId: string | null;
  clientId: string | null;
  keyPrefix: string | null;
  /** Set only for a legacy chain with no api_key_id, so we can still revoke it. */
  refreshRowId: string | null;
}

async function findByAccessToken(
  db: SupabaseClient,
  hash: string,
): Promise<ResolvedGrant | null> {
  // No deleted_at filter: an already-soft-deleted key may still have a live
  // refresh chain hanging off it (a half-revoked grant), and this call is how
  // that gets finished.
  const { data } = await db
    .from('api_keys')
    .select('id, workspace_id, key_prefix')
    .eq('key_hash', hash)
    .maybeSingle();

  if (!data) return null;
  return {
    matchedAs: 'access_token',
    apiKeyId: data.id,
    workspaceId: data.workspace_id,
    clientId: null,
    keyPrefix: data.key_prefix,
    refreshRowId: null,
  };
}

async function findByRefreshToken(
  db: SupabaseClient,
  hash: string,
): Promise<ResolvedGrant | null> {
  const { data } = await db
    .from('oauth_refresh_tokens')
    .select('id, api_key_id, workspace_id, client_id')
    .eq('refresh_hash', hash)
    .maybeSingle();

  if (!data) return null;
  return {
    matchedAs: 'refresh_token',
    apiKeyId: data.api_key_id ?? null,
    workspaceId: data.workspace_id,
    clientId: data.client_id,
    keyPrefix: null,
    refreshRowId: data.id,
  };
}

/**
 * Revoke the whole grant a token belongs to.
 *
 * Never throws and never reports failure to the caller: the endpoint answers
 * 200 either way, so a thrown error would only turn a partial revocation into
 * a 500 that tells an attacker something. Write failures surface in the audit
 * log via the zero counts.
 */
export async function revokeGrantByToken(
  db: SupabaseClient,
  args: { token: string; tokenTypeHint?: string | null; now?: Date },
): Promise<RevocationOutcome> {
  const token = args.token;
  if (!token) return NOTHING;

  const stamp = (args.now ?? new Date()).toISOString();

  // One hash, two column names. See the header note.
  const accessHash = hashApiKey(token);
  const refreshHash = sha256hex(token);

  let grant: ResolvedGrant | null = null;
  for (const kind of revocationLookupOrder(token, args.tokenTypeHint)) {
    grant =
      kind === 'access_token'
        ? await findByAccessToken(db, accessHash)
        : await findByRefreshToken(db, refreshHash);
    if (grant) break;
  }

  if (!grant) return NOTHING;

  let accessTokensRevoked = 0;
  let refreshTokensRevoked = 0;

  if (grant.apiKeyId) {
    // Same two writes, same order, as the dashboard revoke button. The
    // `is(..., null)` guards make a repeat call a no-op rather than a
    // timestamp-shuffling update, so `deleted_at` keeps naming the moment
    // access actually ended.
    const { data: keys } = await db
      .from('api_keys')
      .update({ deleted_at: stamp })
      .eq('id', grant.apiKeyId)
      .is('deleted_at', null)
      .select('id, key_prefix, workspace_id');

    accessTokensRevoked = keys?.length ?? 0;

    // Every row in the chain, not just the one presented: rotation can leave a
    // second live row behind when a refresh fails between insert and revoke.
    const { data: refreshes } = await db
      .from('oauth_refresh_tokens')
      .update({ revoked_at: stamp })
      .eq('api_key_id', grant.apiKeyId)
      .is('revoked_at', null)
      .select('id, client_id, workspace_id');

    refreshTokensRevoked = refreshes?.length ?? 0;

    grant.keyPrefix = grant.keyPrefix ?? keys?.[0]?.key_prefix ?? null;
    grant.clientId = grant.clientId ?? refreshes?.[0]?.client_id ?? null;
    grant.workspaceId =
      grant.workspaceId ?? keys?.[0]?.workspace_id ?? refreshes?.[0]?.workspace_id ?? null;
  } else if (grant.refreshRowId) {
    // Legacy chain issued before connections were linked to a single api_keys
    // row. There is no key to revoke, so the chain is the whole grant.
    const { data: refreshes } = await db
      .from('oauth_refresh_tokens')
      .update({ revoked_at: stamp })
      .eq('id', grant.refreshRowId)
      .is('revoked_at', null)
      .select('id');

    refreshTokensRevoked = refreshes?.length ?? 0;
  }

  return {
    revoked: accessTokensRevoked + refreshTokensRevoked > 0,
    matchedAs: grant.matchedAs,
    apiKeyId: grant.apiKeyId,
    workspaceId: grant.workspaceId,
    clientId: grant.clientId,
    keyPrefix: grant.keyPrefix,
    accessTokensRevoked,
    refreshTokensRevoked,
  };
}
