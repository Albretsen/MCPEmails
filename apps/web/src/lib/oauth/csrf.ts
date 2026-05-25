import crypto from 'node:crypto';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { sha256hex } from './crypto';

const TTL_MS = 10 * 60 * 1000; // 10 minutes

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) throw new Error('ENCRYPTION_KEY missing or invalid.');
  return Buffer.from(hex, 'hex');
}

/**
 * Issue a signed, single-use CSRF token bound to the given user.
 * Format: `<userId>:<expiryMs>:<nonce>:<hmac>`
 * Stores the token hash in oauth_csrf_tokens for single-use enforcement.
 */
export async function issueCsrfToken(userId: string): Promise<string> {
  const expiry = Date.now() + TTL_MS;
  const nonce  = crypto.randomBytes(16).toString('hex');
  const payload = `${userId}:${expiry}:${nonce}`;
  const hmac    = crypto.createHmac('sha256', getKey()).update(payload).digest('hex');
  const token   = `${payload}:${hmac}`;

  const service = createServiceRoleClient();
  await service.from('oauth_csrf_tokens').insert({
    user_id:    userId,
    token_hash: sha256hex(token),
    expires_at: new Date(expiry).toISOString(),
  });

  return token;
}

/**
 * Validate a CSRF token. Returns true only if:
 *  - HMAC signature matches
 *  - Token has not expired
 *  - Token has not been consumed before (single-use)
 * Marks the token consumed on success.
 */
export async function validateCsrfToken(token: string, userId: string): Promise<boolean> {
  const parts = token.split(':');
  if (parts.length !== 4) return false;

  const [tokenUserId, expiryStr, nonce, submittedHmac] = parts;
  if (tokenUserId !== userId) return false;

  const expiry = parseInt(expiryStr, 10);
  if (isNaN(expiry) || Date.now() > expiry) return false;

  const payload  = `${tokenUserId}:${expiryStr}:${nonce}`;
  const expected = crypto.createHmac('sha256', getKey()).update(payload).digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const submittedBuf = Buffer.alloc(expectedBuf.length);
  Buffer.from(submittedHmac.slice(0, expectedBuf.length * 2), 'hex').copy(submittedBuf);
  if (!crypto.timingSafeEqual(expectedBuf, submittedBuf)) return false;

  const tokenHash = sha256hex(token);
  const service = createServiceRoleClient();

  const { data } = await service
    .from('oauth_csrf_tokens')
    .select('id')
    .eq('token_hash', tokenHash)
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (!data) return false;

  await service
    .from('oauth_csrf_tokens')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', (data as { id: string }).id);

  return true;
}
