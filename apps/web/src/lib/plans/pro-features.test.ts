// ---------------------------------------------------------------------------
// The dashboard's Pro feature gate. Same table as
// supabase/functions/mcp-server/pro-features.test.ts, plus the loader's
// fail-closed reads.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/plans/pro-features.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';

import {
  CLOSED_PRO_GATE,
  decideProFeatureAccess,
  loadProFeatureAccess,
  PRO_FEATURES_PUBLIC_SWITCH,
} from './pro-features.ts';

const PLANS = ['free', 'personal', 'solo', 'pro', 'enterprise', 'unknown'];

test('hidden without the rollout flag or the launch switch, on every plan', () => {
  for (const plan of PLANS) {
    assert.deepEqual(decideProFeatureAccess({ plan, rolloutEnabled: false, publicLaunch: false }), {
      visible: false,
      allowed: false,
      plan,
    });
  }
});

test('visible with either switch, allowed only on solo (Pro) and pro (Business)', () => {
  for (const [rolloutEnabled, publicLaunch] of [[true, false], [false, true], [true, true]]) {
    for (const plan of PLANS) {
      const access = decideProFeatureAccess({ plan, rolloutEnabled, publicLaunch });
      assert.equal(access.visible, true);
      assert.equal(access.allowed, plan === 'solo' || plan === 'pro', plan);
    }
  }
});

test('an unresolved plan is never allowed; the closed inputs are hidden', () => {
  assert.equal(decideProFeatureAccess({ plan: null, rolloutEnabled: true, publicLaunch: true }).allowed, false);
  assert.deepEqual(decideProFeatureAccess(CLOSED_PRO_GATE), { visible: false, allowed: false, plan: null });
});

type Client = SupabaseClient<Database>;

type World = {
  effectivePlan: { plan: string; comped_scale: boolean } | null;
  workspaceRow: { pro_features_enabled: boolean } | null;
  workspaceError?: boolean;
  switchRow: { enabled: boolean } | null;
};

/** One `.rpc()` and two `.from(...).select().eq().maybeSingle()` chains. */
function clients(world: World) {
  const from = (allowed: string) => (table: string) => {
    assert.equal(table, allowed);
    const builder = {
      select: () => builder,
      eq: (column: string, value: string) => {
        if (table === 'pricing_switches') assert.deepEqual([column, value], ['key', PRO_FEATURES_PUBLIC_SWITCH]);
        return builder;
      },
      maybeSingle: () =>
        Promise.resolve(
          table === 'workspaces'
            ? { data: world.workspaceRow, error: world.workspaceError ? { message: 'boom' } : null }
            : { data: world.switchRow, error: null },
        ),
    };
    return builder;
  };
  const user = {
    rpc(name: string) {
      assert.equal(name, 'effective_workspace_plan');
      return Promise.resolve({
        data: world.effectivePlan
          ? [{ ...world.effectivePlan, unlimited_inboxes: false, pro_unlimited_inboxes: false }]
          : [],
        error: null,
      });
    },
    from: from('workspaces'),
  };
  const service = { from: from('pricing_switches') };
  return [user as unknown as Client, service as unknown as Client] as const;
}

test('loader: internal Pro workspace before launch is visible and allowed', async () => {
  const [user, service] = clients({
    effectivePlan: { plan: 'solo', comped_scale: false },
    workspaceRow: { pro_features_enabled: true },
    switchRow: { enabled: false },
  });
  assert.deepEqual(await loadProFeatureAccess(user, service, 'ws'), { visible: true, allowed: true, plan: 'solo' });
});

test('loader: a Personal workspace after launch is visible but not allowed', async () => {
  const [user, service] = clients({
    effectivePlan: { plan: 'personal', comped_scale: false },
    workspaceRow: { pro_features_enabled: false },
    switchRow: { enabled: true },
  });
  assert.deepEqual(await loadProFeatureAccess(user, service, 'ws'), { visible: true, allowed: false, plan: 'personal' });
});

test('loader: a comped workspace resolves to pro and is allowed once visible', async () => {
  const [user, service] = clients({
    effectivePlan: { plan: 'pro', comped_scale: true },
    workspaceRow: { pro_features_enabled: false },
    switchRow: { enabled: true },
  });
  assert.equal((await loadProFeatureAccess(user, service, 'ws')).allowed, true);
});

test('loader: a customer Pro workspace before launch sees nothing', async () => {
  const [user, service] = clients({
    effectivePlan: { plan: 'solo', comped_scale: false },
    workspaceRow: { pro_features_enabled: false },
    switchRow: { enabled: false },
  });
  assert.deepEqual(await loadProFeatureAccess(user, service, 'ws'), { visible: false, allowed: false, plan: 'solo' });
});

test('loader: fails closed when the plan, the row or the switch cannot be read', async () => {
  const unresolved = clients({ effectivePlan: null, workspaceRow: { pro_features_enabled: true }, switchRow: null });
  assert.deepEqual(await loadProFeatureAccess(unresolved[0], unresolved[1], 'ws'), {
    visible: false,
    allowed: false,
    plan: null,
  });
  const rowError = clients({
    effectivePlan: { plan: 'solo', comped_scale: false },
    workspaceRow: null,
    workspaceError: true,
    switchRow: { enabled: true },
  });
  assert.equal((await loadProFeatureAccess(rowError[0], rowError[1], 'ws')).visible, false);
  const noSwitch = clients({
    effectivePlan: { plan: 'solo', comped_scale: false },
    workspaceRow: { pro_features_enabled: false },
    switchRow: null,
  });
  assert.equal((await loadProFeatureAccess(noSwitch[0], noSwitch[1], 'ws')).visible, false);
});
