// ---------------------------------------------------------------------------
// resolveEffectiveWorkspacePlan: the referral month (20261025090000). A Free
// workspace whose owner earned a month of Personal keeps plan "free" (checkout
// and billing read the stored plan) but gets Personal's limits.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/plans/effective-plan.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveEffectiveWorkspacePlan } from './effective-plan.ts';
import { PLANS } from '@/lib/stripe/plans';

function fakeSupabase(row: Record<string, unknown> | null, error: { message: string } | null = null) {
  return {
    rpc(name: string) {
      assert.equal(name, 'effective_workspace_plan');
      return Promise.resolve({ data: row ? [row] : [], error });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const BASE = { comped_scale: false, unlimited_inboxes: false, pro_unlimited_inboxes: false };

test('an active referral month gives a Free workspace Personal limits, plan stays free', async () => {
  const r = await resolveEffectiveWorkspacePlan(fakeSupabase({ ...BASE, plan: 'free', referral_personal: true }), 'ws');
  assert.equal(r.resolved, true);
  if (!r.resolved) return;
  assert.equal(r.plan, 'free');
  assert.equal(r.referralPersonal, true);
  assert.equal(r.limits.maxInboxes, PLANS.personal.limits.maxInboxes);
  assert.equal(r.limits.maxRequestsPerMinute, PLANS.personal.limits.maxRequestsPerMinute);
});

test('no referral month, or an RPC without the column, is plain Free', async () => {
  for (const row of [{ ...BASE, plan: 'free', referral_personal: false }, { ...BASE, plan: 'free' }]) {
    const r = await resolveEffectiveWorkspacePlan(fakeSupabase(row), 'ws');
    assert.equal(r.resolved, true);
    if (!r.resolved) continue;
    assert.equal(r.referralPersonal, false);
    assert.equal(r.limits.maxInboxes, PLANS.free.limits.maxInboxes);
  }
});

test('a paid plan ignores the flag', async () => {
  const r = await resolveEffectiveWorkspacePlan(fakeSupabase({ ...BASE, plan: 'pro', referral_personal: true }), 'ws');
  assert.equal(r.resolved, true);
  if (!r.resolved) return;
  assert.equal(r.referralPersonal, false);
  assert.equal(r.limits.maxInboxes, PLANS.pro.limits.maxInboxes);
});

test('zero rows is unresolved, never Free', async () => {
  const r = await resolveEffectiveWorkspacePlan(fakeSupabase(null), 'ws');
  assert.equal(r.resolved, false);
});
