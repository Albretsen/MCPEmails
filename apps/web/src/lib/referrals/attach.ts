/**
 * Attach a friend to a referral code: the one write shared by /auth/callback
 * (via 'cookie') and POST /api/referrals (via 'code').
 *
 * Every rule is decided by attachRefusalReason (fraud.ts); this file only
 * gathers its inputs from the database and Stripe. A refusal is quiet: the
 * caller shows one generic line whatever the reason, the reason goes to the
 * log and a `referral_attach_refused` row records that one happened.
 *
 * Fails closed. A Stripe or database error while checking paid history
 * refuses the attach ('error') rather than rewarding someone we could not
 * check. The caller decides what that means for its response; the callback
 * ignores it entirely, because no referral problem may ever break a login.
 */

import { normalizeReferralCode } from './code.ts';
import { attachRefusalReason, normalizeEmail, type AttachRefusalReason } from './fraud.ts';
import {
  friendHasPaidHistory,
  primaryOwnedWorkspace,
  recordReferralEvent,
  referralsEnabledForOwner,
  usersShareWorkspace,
  type Db,
  type ReferralStripeApi,
} from './server.ts';

export interface AttachFriend {
  id: string;
  email?: string | null;
  created_at?: string | null;
}

export interface AttachInput {
  code: unknown;
  friend: AttachFriend;
  via: 'cookie' | 'code';
  ipHash: string | null;
  now?: Date;
}

export type AttachOutcome =
  | { ok: true; referralId: string }
  | { ok: false; reason: AttachRefusalReason | 'unknown_code' | 'flag_off' | 'error' };

export async function attachReferral(
  db: Db,
  stripe: ReferralStripeApi | null,
  input: AttachInput,
): Promise<AttachOutcome> {
  const now = input.now ?? new Date();
  const code = normalizeReferralCode(input.code);
  if (!code) return { ok: false, reason: 'unknown_code' };

  const { data: codeRow, error: codeError } = await db
    .from('referral_codes')
    .select('user_id, code, disabled_at')
    .eq('code', code)
    .maybeSingle();
  if (codeError) {
    console.error('[referrals] code lookup failed', { error: codeError.message });
    return { ok: false, reason: 'error' };
  }
  if (!codeRow) return { ok: false, reason: 'unknown_code' };
  const referrerId = codeRow.user_id;

  // Flag off for the referrer: nothing happens, and nothing is recorded.
  if (!(await referralsEnabledForOwner(db, referrerId))) return { ok: false, reason: 'flag_off' };

  const workspace = await primaryOwnedWorkspace(db, input.friend.id);
  const refuse = async (reason: AttachRefusalReason | 'error'): Promise<AttachOutcome> => {
    console.log('[referrals] attach refused', { reason, via: input.via });
    await recordReferralEvent(db, workspace?.id ?? null, 'referral_attach_refused', {
      failure: true,
      plan: workspace?.plan ?? null,
    });
    return { ok: false, reason };
  };

  const friendEmail = input.friend.email?.trim() ?? '';
  const createdAt = input.friend.created_at ? new Date(input.friend.created_at) : null;
  if (!friendEmail || !createdAt || Number.isNaN(createdAt.getTime())) return refuse('error');

  let reason: AttachRefusalReason | null;
  try {
    const { data: referrer } = await db.from('users').select('email').eq('id', referrerId).maybeSingle();
    const { data: existing, error: existingError } = await db
      .from('referrals')
      .select('id')
      .eq('friend_user_id', input.friend.id)
      .limit(1);
    if (existingError) throw new Error(existingError.message);
    // Cheapest rules first: no Stripe call for a self-referral.
    const self = referrerId === input.friend.id;
    const shared = self ? false : await usersShareWorkspace(db, referrerId, input.friend.id);
    const paid = self || shared
      ? false
      : await friendHasPaidHistory(db, stripe, { id: input.friend.id, email: friendEmail }, normalizeEmail(friendEmail));
    reason = attachRefusalReason({
      referrerUserId: referrerId,
      friendUserId: input.friend.id,
      referrerEmail: (referrer as { email?: string } | null)?.email ?? '',
      friendEmail,
      friendCreatedAt: createdAt,
      now,
      friendHasPaidHistory: paid,
      friendAlreadyReferred: (existing ?? []).length > 0,
      referrerIsMemberOfFriendWorkspace: shared,
      codeDisabled: codeRow.disabled_at != null,
    });
  } catch (err) {
    console.error('[referrals] attach checks failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return refuse('error');
  }
  if (reason) return refuse(reason);

  const { data: inserted, error: insertError } = await db
    .from('referrals')
    .insert({
      code,
      referrer_user_id: referrerId,
      friend_user_id: input.friend.id,
      friend_workspace_id: workspace?.id ?? null,
      attached_via: input.via,
      attached_at: now.toISOString(),
      status: 'attached',
      ip_hash: input.ipHash,
    })
    .select('id')
    .single();
  if (insertError || !inserted) {
    // 23505 on friend_user_id: a concurrent attach won. One referral per friend.
    if (insertError?.code === '23505') return refuse('already_referred');
    console.error('[referrals] attach insert failed', { error: insertError?.message ?? 'no row' });
    return refuse('error');
  }

  await recordReferralEvent(db, workspace?.id ?? null, 'referral_attached', { plan: workspace?.plan ?? null });
  return { ok: true, referralId: (inserted as { id: string }).id };
}
