import { createServiceRoleClient } from '@/lib/supabase/service';
import { sha256hex } from './crypto';

const TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Store an OAuth state nonce server-side, keyed to the user's session.
 * Called when the /authorize page first renders.
 */
export async function storeStateNonce(sessionId: string, state: string): Promise<void> {
  const stateHash = sha256hex(state);
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();

  const service = createServiceRoleClient();
  // Upsert (re-arm) rather than insert. Some MCP clients send a CONSTANT state
  // value across attempts (e.g. Glama sends the resource URL as `state`), and
  // users legitimately re-visit /authorize (reload, reconnect). A plain insert
  // hits the UNIQUE (session_id, state_hash) constraint on the second visit and
  // throws, which surfaces as a 500 on the consent page and blocks the whole
  // OAuth flow. Single-use is enforced at CONSUME time (consumed_at), not here,
  // so re-arming on a fresh authorization visit is safe: each visit refreshes
  // the TTL and clears any prior consumed_at, starting a new single-use cycle.
  const { error } = await service
    .from('oauth_state_nonces')
    .upsert(
      { session_id: sessionId, state_hash: stateHash, expires_at: expiresAt, consumed_at: null },
      { onConflict: 'session_id,state_hash' },
    );

  if (error) {
    throw new Error(`Failed to store state nonce: ${error.message}`);
  }
}

/**
 * Validate and consume a state nonce. Returns true only once per nonce;
 * subsequent calls with the same state return false (single-use).
 */
export async function consumeStateNonce(sessionId: string, state: string): Promise<boolean> {
  const stateHash = sha256hex(state);
  const service = createServiceRoleClient();

  const { data } = await service
    .from('oauth_state_nonces')
    .select('id')
    .eq('session_id', sessionId)
    .eq('state_hash', stateHash)
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (!data) return false;

  await service
    .from('oauth_state_nonces')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', (data as { id: string }).id);

  return true;
}
