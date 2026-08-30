// ---------------------------------------------------------------------------
// The seat check is what stands between an admin and an invite, and it was
// wrong in production in the most expensive possible way: EVERY invite on EVERY
// plan was refused with a 403 telling the customer to upgrade their free plan,
// because the route handed this function a service-role client and the plan RPC
// is RLS-gated on auth.uid(). Zero rows, coalesced to 'free', maxMembers 1, and
// a workspace always has an owner, so every workspace read as "at limit". The
// Team feature was 100% unusable and the error message made it look like
// billing rather than a defect.
//
// So the property under test is not "does it count seats". It is: an
// UNRESOLVABLE plan must be reported as unresolvable, never as the most
// restrictive plan.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/plans/check-member-limit.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import { checkMemberLimit } from './check-member-limit.ts';

type EffectivePlanRow = { plan: string; comped_scale: boolean; unlimited_inboxes: boolean };

/**
 * Supabase client stub with exactly the surface this function touches: one
 * `.rpc()` and one counted `.from('workspace_members')` head query.
 *
 * `rpcRows` is passed through verbatim so a test can hand it the empty array
 * that a service-role caller really receives from effective_workspace_plan.
 */
function fakeSupabase(opts: {
  rpcRows: EffectivePlanRow[] | null;
  rpcError?: { message: string } | null;
  memberCount: number;
}) {
  return {
    rpc(name: string) {
      assert.equal(name, 'effective_workspace_plan');
      return Promise.resolve({ data: opts.rpcRows, error: opts.rpcError ?? null });
    },
    from(table: string) {
      assert.equal(table, 'workspace_members');
      const builder = {
        select: () => builder,
        eq: () => builder,
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ count: opts.memberCount, error: null }).then(resolve),
      };
      return builder;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const WORKSPACE = '00000000-0000-0000-0000-0000000000aa';

test('an empty plan RPC result is unresolved, NOT a free plan at its cap', async () => {
  // This is the exact shape a service-role client gets back: no error, no rows,
  // because `my_workspace_ids()` is empty without an auth.uid(). The old code
  // turned this into { plan: 'free', maxMembers: 1, atLimit: true }.
  const result = await checkMemberLimit(
    fakeSupabase({ rpcRows: [], memberCount: 2 }),
    WORKSPACE,
  );

  assert.equal(result.resolved, false, 'an empty RPC result must not resolve to a plan');
  if (result.resolved) return; // narrowing for the compiler

  // The union is the point: there is no `plan`, no `maxMembers` and no
  // `atLimit` to read on this branch, so a caller cannot accidentally enforce
  // a cap that was never determined.
  assert.ok(!('atLimit' in result), 'an unresolved result must expose no cap verdict');
  assert.ok(!('plan' in result), 'an unresolved result must expose no plan');
});

test('a null plan RPC result and an RPC error are both unresolved', async () => {
  const nullData = await checkMemberLimit(
    fakeSupabase({ rpcRows: null, memberCount: 1 }),
    WORKSPACE,
  );
  assert.equal(nullData.resolved, false);

  const errored = await checkMemberLimit(
    fakeSupabase({ rpcRows: null, rpcError: { message: 'permission denied' }, memberCount: 1 }),
    WORKSPACE,
  );
  assert.equal(errored.resolved, false);
  if (!errored.resolved) {
    // The reason is carried so the 500 the route logs says something useful
    // rather than repeating the misleading "upgrade your plan".
    assert.equal(errored.reason, 'permission denied');
  }
});

test('a Team workspace has unlimited seats and the Admin/Viewer roles', async () => {
  // The case that was broken in production. `pro` is sold as Team.
  const result = await checkMemberLimit(
    fakeSupabase({
      rpcRows: [{ plan: 'pro', comped_scale: false, unlimited_inboxes: false }],
      memberCount: 2,
    }),
    WORKSPACE,
  );

  assert.equal(result.resolved, true);
  if (!result.resolved) return;
  assert.equal(result.atLimit, false, 'a Team workspace must be able to invite');
  assert.equal(result.maxMembers, null, 'null means unlimited');
  assert.equal(result.teamRolesEnabled, true);
  assert.equal(result.currentCount, 2);
  assert.equal(result.plan, 'pro');
});

test('single-user plans are at their cap once the owner exists, without team roles', async () => {
  for (const plan of ['free', 'personal', 'solo']) {
    const result = await checkMemberLimit(
      fakeSupabase({
        rpcRows: [{ plan, comped_scale: false, unlimited_inboxes: false }],
        memberCount: 1,
      }),
      WORKSPACE,
    );
    assert.equal(result.resolved, true, plan);
    if (!result.resolved) continue;
    assert.equal(result.atLimit, true, `${plan} is single-user`);
    assert.equal(result.maxMembers, 1, plan);
    assert.equal(
      result.teamRolesEnabled,
      false,
      `${plan} must not offer the Admin and Viewer roles`,
    );
  }
});

test('a comped_scale grant is treated as Team for seats and roles', async () => {
  // resolvePlanLimits promotes a comped workspace to `pro` limits, so a comped
  // customer must not be refused an invite that a paying Team customer gets.
  const result = await checkMemberLimit(
    fakeSupabase({
      rpcRows: [{ plan: 'free', comped_scale: true, unlimited_inboxes: false }],
      memberCount: 5,
    }),
    WORKSPACE,
  );
  assert.equal(result.resolved, true);
  if (!result.resolved) return;
  assert.equal(result.atLimit, false);
  assert.equal(result.maxMembers, null);
  assert.equal(result.teamRolesEnabled, true);
});
