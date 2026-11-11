/**
 * A referrer's code and share link, for every surface that shows one: the
 * Invite page (GET /api/referrals) and the purchase confirmation email.
 *
 * NEVER in an MCP tool result, a tool description, the draft card or any
 * directory listing text: the AI directories' policies do not allow promotion
 * there. The dashboard and our own emails only.
 */

import { appUrl } from '@/lib/email/lifecycle';
import { generateReferralCode } from './code.ts';
import { referralsEnabledForOwner, type Db } from './server.ts';

/** The user's code, created on first use. A collision just draws again. */
export async function ensureReferralCode(db: Db, userId: string): Promise<{ code: string; disabled: boolean } | null> {
  const { data: existing } = await db
    .from('referral_codes')
    .select('code, disabled_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (existing) return { code: existing.code, disabled: existing.disabled_at != null };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateReferralCode();
    const { error } = await db.from('referral_codes').insert({ user_id: userId, code });
    if (!error) return { code, disabled: false };
    if (error.code !== '23505') {
      console.error('[referrals] code insert failed', { error: error.message });
      return null;
    }
    // 23505 on user_id: a parallel request created it. On code: draw again.
    const { data: raced } = await db
      .from('referral_codes')
      .select('code, disabled_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (raced) return { code: raced.code, disabled: raced.disabled_at != null };
  }
  return null;
}

/** `https://mcpemails.com/r/<CODE>`. */
export function referralLinkFor(code: string): string {
  return `${appUrl()}/r/${code}`;
}

/**
 * The user's share link, or null when the program is off for them (no owned
 * workspace with referral_enabled), their code is disabled, or anything fails.
 * Never throws: callers are emails that must go out either way.
 */
export async function referralLinkForUser(db: Db, userId: string): Promise<string | null> {
  try {
    if (!(await referralsEnabledForOwner(db, userId))) return null;
    const code = await ensureReferralCode(db, userId);
    if (!code || code.disabled) return null;
    return referralLinkFor(code.code);
  } catch (err) {
    console.error('[referrals] link lookup failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
