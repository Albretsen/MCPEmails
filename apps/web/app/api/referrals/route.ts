import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { clientIpFromHeaders } from '@/lib/sso/audit';
import { appUrl } from '@/lib/email/lifecycle';
import { generateReferralCode } from '@/lib/referrals/code';
import { CODE_ENTRY_WINDOW_DAYS, REWARD_CAP_PER_YEAR } from '@/lib/referrals/constants';
import { attachReferral } from '@/lib/referrals/attach';
import {
  billingRow,
  billingShowsPaidHistory,
  creditBalanceCents,
  recordReferralEvent,
  referralIpHash,
  referrerRewardsLast365d,
  type Db,
  type ReferralStripeApi,
} from '@/lib/referrals/server';

/**
 * /api/referrals: the signed-in user's own referral program.
 *
 * GET -> 200
 *   { enabled: false }                       the active workspace is not in the
 *                                            rollout (workspaces.referral_enabled)
 *   { enabled: true, code, link,             the code is created on first GET
 *     creditBalanceCents,                    remaining Stripe credit, 0 without a
 *                                            customer, null when Stripe failed
 *     rewardsLast365d, cap,                  referrer rewards toward the cap
 *     canEnterCode,                          inside the code-entry window, not
 *                                            referred yet, never paid
 *     referrals }                            my_referral_summary() rows: status
 *                                            and dates only, never the friend
 *
 * POST { code } -> attach the caller as a FRIEND of that code (via 'code').
 *   200 { ok: true }
 *   400 { error_code: 'invalid_code' }       malformed body or code
 *   422 { error_code: 'code_refused', error } every refusal, one sentence,
 *                                            whatever the reason (fraud.ts)
 * POST { event: 'link_copied' } -> 204, records referral_link_copied.
 *
 * 401 without a session, 403 without a workspace, 404 { enabled: false } on
 * POST when the active workspace is not in the rollout.
 */

export const dynamic = 'force-dynamic';

const DAY_MS = 24 * 60 * 60 * 1000;
const REFUSED = "This code can't be used for this account.";

type Session =
  | { ok: true; userId: string; user: { id: string; email?: string; created_at: string }; workspaceId: string; plan: string; enabled: boolean }
  | { ok: false; response: NextResponse };

async function session(): Promise<Session> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized.' }, { status: 401 }) };
  }
  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);
  if (!workspaceId) {
    return { ok: false, response: NextResponse.json({ error: 'Workspace not found.' }, { status: 403 }) };
  }
  // Membership is established under RLS with the user's own client.
  const { data: workspace } = await supabase
    .from('workspaces')
    .select('id, plan, referral_enabled')
    .eq('id', workspaceId)
    .maybeSingle();
  if (!workspace) {
    return { ok: false, response: NextResponse.json({ error: 'Workspace not found.' }, { status: 403 }) };
  }
  return {
    ok: true,
    userId: user.id,
    user,
    workspaceId,
    plan: workspace.plan,
    enabled: workspace.referral_enabled === true,
  };
}

/** The caller's code, created on first use. A collision just draws again. */
async function ensureCode(db: Db, userId: string): Promise<{ code: string; disabled: boolean } | null> {
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
    // 23505 on user_id: a parallel GET created it. On code: draw again.
    const { data: raced } = await db
      .from('referral_codes')
      .select('code, disabled_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (raced) return { code: raced.code, disabled: raced.disabled_at != null };
  }
  return null;
}

export async function GET(): Promise<NextResponse> {
  const s = await session();
  if (!s.ok) return s.response;
  if (!s.enabled) return NextResponse.json({ enabled: false });

  const db = createServiceRoleClient();
  const now = new Date();
  const code = await ensureCode(db, s.userId);
  if (!code) return NextResponse.json({ error: 'Referrals are temporarily unavailable.' }, { status: 503 });

  const [billing, rewardsLast365d, alreadyReferred, summary] = await Promise.all([
    billingRow(db, s.userId).catch(() => null),
    referrerRewardsLast365d(db, s.userId, now).catch(() => 0),
    db.from('referrals').select('id').eq('friend_user_id', s.userId).limit(1),
    // auth.uid() scoped: called with the user's own client, never service role.
    (await createClient()).rpc('my_referral_summary'),
  ]);

  let credit: number | null = 0;
  if (billing?.stripe_customer_id) {
    try {
      const { stripe } = await import('@/lib/stripe/client');
      credit = await creditBalanceCents(stripe, billing.stripe_customer_id);
    } catch (err) {
      console.error('[referrals] balance read failed', { error: err instanceof Error ? err.message : String(err) });
      credit = null;
    }
  }

  const ageMs = now.getTime() - Date.parse(s.user.created_at);
  const canEnterCode =
    ageMs <= CODE_ENTRY_WINDOW_DAYS * DAY_MS &&
    (alreadyReferred.data ?? []).length === 0 &&
    !billingShowsPaidHistory(billing);

  // referral_link_viewed is the Invite page's beacon (/api/analytics/referral),
  // not this GET: the Overview field and the Billing credit line read it too.

  return NextResponse.json({
    enabled: true,
    code: code.code,
    link: code.disabled ? null : `${appUrl()}/r/${code.code}`,
    creditBalanceCents: credit,
    rewardsLast365d,
    cap: REWARD_CAP_PER_YEAR,
    canEnterCode,
    referrals: summary.error ? [] : summary.data ?? [],
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  const s = await session();
  if (!s.ok) return s.response;
  if (!s.enabled) return NextResponse.json({ enabled: false }, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error_code: 'invalid_code', error: 'Invalid request body.' }, { status: 400 });
  }
  const payload = (body && typeof body === 'object' ? body : {}) as { code?: unknown; event?: unknown };
  const db = createServiceRoleClient();

  if (payload.event === 'link_copied') {
    await recordReferralEvent(db, s.workspaceId, 'referral_link_copied', { plan: s.plan });
    return new NextResponse(null, { status: 204 });
  }
  if (typeof payload.code !== 'string' || payload.code.trim() === '') {
    return NextResponse.json({ error_code: 'invalid_code', error: 'Enter a referral code.' }, { status: 400 });
  }

  // The window (30 days from signup, before the first paid charge) is
  // enforced inside attachReferral as 'not_new' and 'paid_before'.
  // Paid history is checked in Stripe too; without it the attach would be
  // decided on half the facts, so it is not attempted.
  let stripe: ReferralStripeApi;
  try {
    ({ stripe } = await import('@/lib/stripe/client'));
  } catch (err) {
    console.error('[referrals] Stripe client unavailable', { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Referrals are temporarily unavailable.' }, { status: 503 });
  }
  const outcome = await attachReferral(db, stripe, {
    code: payload.code,
    friend: s.user,
    via: 'code',
    ipHash: referralIpHash(clientIpFromHeaders(request.headers)),
  });
  if (outcome.ok) return NextResponse.json({ ok: true });
  return NextResponse.json({ ok: false, error_code: 'code_refused', error: REFUSED }, { status: 422 });
}
