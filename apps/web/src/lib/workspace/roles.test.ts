// ---------------------------------------------------------------------------
// The role predicates are the only thing standing between a read-only viewer
// and a workspace's mailboxes, so the cases below are written as the ways a
// real person gets hurt if a predicate drifts:
//
//   1. A viewer must be refused everywhere. Proven live against production: a
//      viewer member of somebody else's workspace reached the destructive
//      branch of DELETE /api/inboxes/[id] and got past authorization on
//      POST /api/inboxes/imap.
//   2. A non-member (fetchWorkspaceRole → null) must be refused. A predicate
//      that returns true for null would make every gate a no-op for anyone the
//      membership lookup failed for.
//   3. An UNRECOGNISED role must be refused, not waved through. The role list
//      is a CHECK constraint on workspace_members.role, so a value outside it
//      means something is already wrong.
//   4. A plain `member` must NOT be refused from inbox management. Member is
//      the default invite role, and connecting your own mailbox is the thing
//      people are invited in order to do; refusing it would close a viewer
//      hole by breaking the product's main team flow.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/workspace/roles.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canManageInboxes,
  canManageWorkspace,
  canOperateWorkspace,
  fetchWorkspaceRole,
  insufficientRoleBody,
  isViewer,
  isWorkspaceRole,
  WORKSPACE_ROLES,
} from './roles.ts';

const NOT_ROLES = [null, undefined, '', 'OWNER', 'Admin', 'superuser', 'owner ', '0', 'true'];

test('canManageWorkspace is owner and admin only', () => {
  assert.equal(canManageWorkspace('owner'), true);
  assert.equal(canManageWorkspace('admin'), true);
  assert.equal(canManageWorkspace('member'), false);
  assert.equal(canManageWorkspace('viewer'), false);
});

test('canOperateWorkspace admits member but never viewer', () => {
  assert.equal(canOperateWorkspace('owner'), true);
  assert.equal(canOperateWorkspace('admin'), true);
  assert.equal(canOperateWorkspace('member'), true, 'member is the default invite role');
  assert.equal(canOperateWorkspace('viewer'), false, 'viewer is read-only');
});

test('the inbox gate refuses a viewer and admits every operator', () => {
  // This is the predicate the six inbox routes call. Written out per role
  // rather than delegated to canOperateWorkspace so that decoupling the two
  // later cannot silently change the inbox policy.
  assert.equal(canManageInboxes('owner'), true);
  assert.equal(canManageInboxes('admin'), true);
  assert.equal(canManageInboxes('member'), true);
  assert.equal(canManageInboxes('viewer'), false);
});

test('every predicate refuses a missing or unrecognised role', () => {
  for (const value of NOT_ROLES) {
    assert.equal(canManageWorkspace(value), false, `canManageWorkspace(${String(value)})`);
    assert.equal(canOperateWorkspace(value), false, `canOperateWorkspace(${String(value)})`);
    assert.equal(canManageInboxes(value), false, `canManageInboxes(${String(value)})`);
    assert.equal(isWorkspaceRole(value), false, `isWorkspaceRole(${String(value)})`);
  }
});

test('isWorkspaceRole accepts exactly the four stored roles', () => {
  for (const role of WORKSPACE_ROLES) assert.equal(isWorkspaceRole(role), true);
  assert.equal(WORKSPACE_ROLES.length, 4);
});

test('isViewer identifies only the viewer role', () => {
  assert.equal(isViewer('viewer'), true);
  for (const role of ['owner', 'admin', 'member', null, undefined]) {
    assert.equal(isViewer(role), false, String(role));
  }
});

test('the refusal body carries the shared error_code', () => {
  const body = insufficientRoleBody('Workspace viewers cannot connect an inbox.');
  // Matches the viewer-scope refusal already shipped by app/api/api-keys/route.ts
  // so a client can branch on one code for every role refusal.
  assert.equal(body.error_code, 'insufficient_role');
  assert.equal(body.error, 'Workspace viewers cannot connect an inbox.');
});

// --- fetchWorkspaceRole ------------------------------------------------------

function fakeSupabase(response: { data: unknown; error: unknown }) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () => Promise.resolve(response),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: () => builder } as any;
}

const WORKSPACE = '00000000-0000-0000-0000-0000000000aa';
const USER = '00000000-0000-0000-0000-0000000000bb';

test('fetchWorkspaceRole returns the stored role', async () => {
  const role = await fetchWorkspaceRole(
    fakeSupabase({ data: { role: 'admin' }, error: null }),
    WORKSPACE,
    USER,
  );
  assert.equal(role, 'admin');
});

test('fetchWorkspaceRole returns null for a non-member', async () => {
  const role = await fetchWorkspaceRole(
    fakeSupabase({ data: null, error: null }),
    WORKSPACE,
    USER,
  );
  assert.equal(role, null);
  // And the gates must refuse that, which is what makes a non-member's request
  // fail closed rather than fall through to the handler body.
  assert.equal(canManageInboxes(role), false);
});

test('fetchWorkspaceRole returns null when the lookup errors', async () => {
  // A failed membership read must never be mistaken for a role. Returning
  // anything truthy here would turn a transient database error into an
  // authorization bypass.
  const role = await fetchWorkspaceRole(
    fakeSupabase({ data: { role: 'owner' }, error: { message: 'boom' } }),
    WORKSPACE,
    USER,
  );
  assert.equal(role, null);
});

test('fetchWorkspaceRole rejects a role value outside the constraint', async () => {
  const role = await fetchWorkspaceRole(
    fakeSupabase({ data: { role: 'superuser' }, error: null }),
    WORKSPACE,
    USER,
  );
  assert.equal(role, null);
});
