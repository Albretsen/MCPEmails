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
  const { error } = await service
    .from('oauth_state_nonces')
    .insert({ session_id: sessionId, state_hash: stateHash, expires_at: expiresAt });

  if (error) {
    // A unique-constraint violation means this state value was already stored
    // for this session. Treat it as an error — OAuth state must be single-use
    // and must not be refreshable by re-visiting /authorize with the same URL.
    throw new Error(`Failed to store state nonce: ${error.message}`);
  }
}

/**
 * Validate and consume a state nonce. Returns true only once per nonce —
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
