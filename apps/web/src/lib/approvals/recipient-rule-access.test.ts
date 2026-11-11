// A send the workspace recipient rule held (send_approvals.hold_reason =
// 'recipient_rule', migration 20261111190100) is decided by an owner or admin
// only: the inbox owner's own right to decide a held send on their private
// inbox does not reach it. Plus the never-throwing audit writer.
//
// Run: npm run test:approvals
import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalAccess, holdReasonOf, RECIPIENT_RULE_HOLD_REASON } from './access.ts';
import { recordWorkspaceAuditEvent, workspaceAuditRow, WORKSPACE_AUDIT_KINDS } from '../workspace/audit-events.ts';

const ME = 'user-me';
const mine = { visibility: 'private', owner_user_id: ME };
const company = { visibility: 'company', owner_user_id: 'someone' };

test('a member decides an ordinary hold on their own private inbox, not a recipient-rule hold', () => {
  assert.equal(approvalAccess('member', ME, mine).canDecide, true);
  assert.equal(approvalAccess('member', ME, mine, null).canDecide, true);
  const rule = approvalAccess('member', ME, mine, RECIPIENT_RULE_HOLD_REASON);
  assert.equal(rule.canDecide, false);
  // They still see it: it is their own message.
  assert.equal(rule.hidden, false);
  assert.equal(rule.redacted, false);
});

test('owners and admins decide a recipient-rule hold on any inbox', () => {
  for (const role of ['owner', 'admin']) {
    assert.equal(approvalAccess(role, ME, company, RECIPIENT_RULE_HOLD_REASON).canDecide, true, role);
    assert.equal(approvalAccess(role, ME, { visibility: 'private', owner_user_id: 'other' }, RECIPIENT_RULE_HOLD_REASON).canDecide, true, role);
    assert.equal(approvalAccess(role, ME, null, RECIPIENT_RULE_HOLD_REASON).canDecide, true, role);
  }
});

test('a recipient-rule hold on a hidden inbox shows owner/admin the recipients; an ordinary hold does not', () => {
  const hidden = { visibility: 'private', owner_user_id: 'other' };
  for (const role of ['owner', 'admin']) {
    const rule = approvalAccess(role, ME, hidden, RECIPIENT_RULE_HOLD_REASON);
    assert.equal(rule.redacted, true, role);
    assert.equal(rule.showRecipients, true, role);
    assert.equal(approvalAccess(role, ME, hidden, null).showRecipients, undefined, role);
  }
  assert.equal(approvalAccess('member', ME, hidden, RECIPIENT_RULE_HOLD_REASON).hidden, true);
});

test('viewers and members never decide a recipient-rule hold on a company inbox', () => {
  assert.equal(approvalAccess('viewer', ME, company, RECIPIENT_RULE_HOLD_REASON).canDecide, false);
  assert.equal(approvalAccess('member', ME, company, RECIPIENT_RULE_HOLD_REASON).canDecide, false);
});

test('holdReasonOf reads the selected column', () => {
  assert.equal(holdReasonOf({ hold_reason: 'recipient_rule' }), 'recipient_rule');
  assert.equal(holdReasonOf({ hold_reason: null }), null);
  assert.equal(holdReasonOf({}), null);
  assert.equal(holdReasonOf(null), null);
});

test('workspaceAuditRow: column names, target capped, details default', () => {
  assert.deepEqual(workspaceAuditRow({ workspaceId: 'w', actorUserId: 'u', kind: 'member_left' }), {
    workspace_id: 'w', actor_user_id: 'u', kind: 'member_left', target: null, details: {},
  });
  assert.equal((workspaceAuditRow({ workspaceId: 'w', actorUserId: null, kind: 'invite_sent', target: 'x'.repeat(400) }).target as string).length, 320);
  assert.equal(WORKSPACE_AUDIT_KINDS.length, 8);
});

test('recordWorkspaceAuditEvent never throws: an error, a throw, a factory that throws', async () => {
  const original = console.error;
  console.error = () => {};
  try {
    const inserted: unknown[] = [];
    const ok = { from: (t: string) => ({ insert: async (row: unknown) => { inserted.push([t, row]); return { error: null }; } }) };
    assert.equal(await recordWorkspaceAuditEvent(ok, { workspaceId: 'w', actorUserId: 'u', kind: 'role_changed', target: 't', details: { from: 'member', to: 'admin' } }), true);
    assert.deepEqual(inserted, [['workspace_audit_events', { workspace_id: 'w', actor_user_id: 'u', kind: 'role_changed', target: 't', details: { from: 'member', to: 'admin' } }]]);
    const err = { from: () => ({ insert: async () => ({ error: { message: 'nope' } }) }) };
    assert.equal(await recordWorkspaceAuditEvent(err, { workspaceId: 'w', actorUserId: 'u', kind: 'member_left' }), false);
    const throws = { from: () => { throw new Error('boom'); } };
    assert.equal(await recordWorkspaceAuditEvent(throws, { workspaceId: 'w', actorUserId: 'u', kind: 'member_left' }), false);
    assert.equal(await recordWorkspaceAuditEvent(() => { throw new Error('no env'); }, { workspaceId: 'w', actorUserId: 'u', kind: 'member_left' }), false);
  } finally {
    console.error = original;
  }
});
