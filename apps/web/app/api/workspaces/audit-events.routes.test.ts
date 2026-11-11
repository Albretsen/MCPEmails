// ---------------------------------------------------------------------------
// Team changes land in workspace_audit_events (migration 20261111130000),
// written server-side by the route that made the change, only once the change
// has landed, with who did it:
//
//   POST   /api/workspaces/invite                  invite_sent
//   POST   /api/workspaces/invite-resend/[id]      invite_sent (resend)
//   DELETE /api/workspaces/invite-cancel/[id]      invite_cancelled
//   DELETE /api/workspaces/invite/[token]          invite_cancelled
//   POST   /api/workspaces/invite/[token]/accept   invite_accepted
//   DELETE /api/workspaces/members/[userId]        member_removed
//   PATCH  /api/workspaces/members/[userId]        role_changed
//   POST   /api/workspaces/[id]/leave              member_left
//   PATCH  /api/inboxes/[id]/visibility            inbox_visibility_changed
//
// (recipient_rule_changed: app/api/workspaces/[id]/recipient-rule/route.test.ts)
// A refused or failed change writes nothing. The writer itself never throws.
//
// Run: npm run test:workspace-audit-events
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

const WS = '11111111-1111-4111-8111-111111111111';
const CALLER = '00000000-0000-4000-8000-0000000000a1';
const TARGET = '00000000-0000-4000-8000-0000000000a2';
const INVITE = '33333333-3333-4333-8333-333333333333';
const INBOX = '22222222-2222-4222-8222-222222222222';

let callerRole: string | null = 'owner';
let targetRole = 'member';
let writeError: { message: string } | null = null;
let deleteCount = 1;
let events: Array<Record<string, unknown>> = [];
let rpcResult: { data: unknown; error: { message: string } | null } = { data: null, error: null };
let inboxRow: Record<string, unknown> | null = null;

const realNextServer = await import('next/server');
nodeMock.module('next/server', {
  namedExports: {
    NextRequest: realNextServer.NextRequest,
    NextResponse: realNextServer.NextResponse,
    after: () => {},
  },
});

nodeMock.module('@/lib/workspace/audit-events', {
  namedExports: {
    recordWorkspaceAuditEvent: async (_db: unknown, event: Record<string, unknown>) => {
      events.push(event);
      return true;
    },
  },
});

/** A chainable fake: every filter returns itself; terminal reads answer per table. */
function fake(kind: 'user' | 'service') {
  return {
    auth: { getUser: async () => ({ data: { user: { id: CALLER, email: 'caller@example.test' } }, error: null }) },
    rest: {},
    rpc(this: { rest?: object }) {
      return Promise.resolve(rpcResult);
    },
    from(table: string) {
      let op = 'select';
      let columns = '';
      const b: Record<string, unknown> = {};
      const chain = () => b;
      const terminal = async () => {
        if (table === 'workspace_members') return { data: { role: kind === 'user' ? callerRole : targetRole }, error: null };
        // The resend's lookup names the address; the invite route's duplicate check does not.
        if (table === 'workspace_invites' && op === 'select') {
          return { data: columns.includes('email') ? { id: INVITE, email: 'new@example.test', role: 'admin' } : null, error: null };
        }
        if (table === 'workspace_invites' && op === 'insert') {
          return { data: { id: INVITE, email: 'new@example.test', role: 'admin', expires_at: 'x', created_at: 'y' }, error: writeError };
        }
        if (table === 'users' && !columns.includes('display_name')) return { data: null, error: null };
        if (table === 'inboxes' && op === 'select') return { data: inboxRow, error: inboxRow ? null : { message: 'none' } };
        if (table === 'inboxes' && op === 'update') return { data: writeError ? null : { visibility: 'company' }, error: writeError };
        if (table === 'users') return { data: { display_name: 'Caller', email: 'caller@example.test' }, error: null };
        if (table === 'workspaces') return { data: { display_name: 'Team' }, error: null };
        return { data: null, error: null };
      };
      Object.assign(b, {
        select: (c?: string) => { if (op === 'select') columns = c ?? ''; return b; },
        eq: chain,
        is: chain,
        gt: chain,
        ilike: chain,
        limit: chain,
        update: () => { op = 'update'; return b; },
        delete: () => { op = 'delete'; return b; },
        insert: () => { op = 'insert'; return b; },
        single: terminal,
        maybeSingle: terminal,
        then: (resolve: (v: unknown) => unknown) => {
          const res = op === 'delete'
            ? { data: deleteCount ? [{ email: 'gone@example.test', role: 'viewer' }] : [], count: deleteCount, error: writeError }
            : { data: null, error: writeError };
          return Promise.resolve(res).then(resolve);
        },
      });
      return b;
    },
  };
}

nodeMock.module('@/lib/supabase/server', { namedExports: { createClient: async () => fake('user') } });
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => fake('service') } });
nodeMock.module('@/lib/workspace/roles', {
  namedExports: {
    fetchWorkspaceRole: async () => callerRole,
    canManageWorkspace: (r: string | null) => r === 'owner' || r === 'admin',
    canManageInboxes: (r: string | null) => r != null && r !== 'viewer',
    insufficientRoleBody: (error: string) => ({ error, error_code: 'insufficient_role' }),
  },
});
nodeMock.module('@/lib/workspace/membership', {
  namedExports: {
    removeWorkspaceMember: async () => ({ error: writeError }),
    revokeApiKeysBeyondViewerScopes: async () => ({ revokedKeyIds: [], error: null }),
    demotionRevocationNotice: () => '',
  },
});
nodeMock.module('@/lib/plans/check-member-limit', {
  namedExports: {
    checkMemberLimit: async () => ({ resolved: true, atLimit: false, plan: 'pro', currentCount: 2, maxMembers: null, teamRolesEnabled: true }),
  },
});
nodeMock.module('@/lib/stripe/business-seats', {
  namedExports: { syncBusinessSeatsForWorkspace: async () => ({ status: 'unchanged' }) },
});
nodeMock.module('@/lib/stripe/mailbox-addon', {
  namedExports: { syncMailboxAddonForWorkspace: async () => ({ status: 'unchanged' }) },
});
let emailsSent = 0;
nodeMock.module('@/lib/email/send-invite', { namedExports: { sendInviteEmail: async () => { emailsSent++; } } });

const members = await import('./members/[userId]/route.ts');
const leave = await import('./[id]/leave/route.ts');
const invite = await import('./invite/route.ts');
const resend = await import('./invite-resend/[id]/route.ts');
const cancelById = await import('./invite-cancel/[id]/route.ts');
const cancelByToken = await import('./invite/[token]/route.ts');
const accept = await import('./invite/[token]/accept/route.ts');
const visibility = await import('../inboxes/[id]/visibility/route.ts');

function reset(opts: { caller?: string | null; target?: string; fail?: boolean; deleted?: number } = {}) {
  callerRole = opts.caller === undefined ? 'owner' : opts.caller;
  targetRole = opts.target ?? 'member';
  writeError = opts.fail ? { message: 'boom' } : null;
  deleteCount = opts.deleted ?? 1;
  events = [];
  rpcResult = { data: [{ workspace_id: WS, workspace_slug: 'team', role: 'member' }], error: null };
  inboxRow = { id: INBOX, workspace_id: WS, owner_user_id: CALLER, visibility: 'private', email_address: 'me@example.test' };
  emailsSent = 0;
}

const req = (url: string, init?: { method: string; body?: string; headers?: Record<string, string> }) =>
  new realNextServer.NextRequest(new URL(url, 'https://mcpemails.com'), init);
const json = (method: string, body: unknown) => ({
  method,
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', origin: 'https://mcpemails.com' },
});

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
}

test('invite sent: who sent it, to which address, with what role', async () => {
  reset();
  const res = await quiet(() => invite.POST(req('/api/workspaces/invite', json('POST', { workspaceId: WS, email: 'New@Example.test', role: 'admin' }))));
  assert.equal(res.status, 201);
  assert.equal(emailsSent, 1);
  assert.deepEqual(events, [{ workspaceId: WS, actorUserId: CALLER, kind: 'invite_sent', target: 'new@example.test', details: { role: 'admin' } }]);
});

test('invite refused for a member: no event', async () => {
  reset({ caller: 'member' });
  const res = await invite.POST(req('/api/workspaces/invite', json('POST', { workspaceId: WS, email: 'a@example.test', role: 'member' })));
  assert.equal(res.status, 403);
  assert.equal(events.length, 0);
});

test('invite resent: invite_sent marked as a resend', async () => {
  reset();
  const res = await quiet(() => resend.POST(req(`/api/workspaces/invite-resend/${INVITE}`, json('POST', { workspaceId: WS })), { params: Promise.resolve({ id: INVITE }) }));
  assert.equal(res.status, 200);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'invite_sent');
  assert.deepEqual(events[0].details, { role: 'admin', resend: true });
});

test('invite cancelled by id and by token: the address that was cancelled', async () => {
  reset();
  const byId = await cancelById.DELETE(req(`/api/workspaces/invite-cancel/${INVITE}`, json('DELETE', { workspaceId: WS })), { params: Promise.resolve({ id: INVITE }) });
  assert.equal(byId.status, 200);
  const byToken = await cancelByToken.DELETE(req('/api/workspaces/invite/tok', json('DELETE', { workspaceId: WS })), { params: Promise.resolve({ token: 'tok' }) });
  assert.equal(byToken.status, 200);
  assert.deepEqual(events.map((e) => [e.kind, e.target, e.actorUserId]), [
    ['invite_cancelled', 'gone@example.test', CALLER],
    ['invite_cancelled', 'gone@example.test', CALLER],
  ]);
});

test('cancelling an invite that is not there writes nothing', async () => {
  reset({ deleted: 0 });
  const res = await cancelById.DELETE(req(`/api/workspaces/invite-cancel/${INVITE}`, json('DELETE', { workspaceId: WS })), { params: Promise.resolve({ id: INVITE }) });
  assert.equal(res.status, 404);
  assert.equal(events.length, 0);
});

test('invite accepted: the person who joined, and their role', async () => {
  reset();
  const res = await accept.POST(req('/api/workspaces/invite/tok/accept', { method: 'POST' }), { params: Promise.resolve({ token: 'tok' }) });
  assert.equal(res.status, 200);
  assert.deepEqual(events, [{ workspaceId: WS, actorUserId: CALLER, kind: 'invite_accepted', target: 'caller@example.test', details: { role: 'member' } }]);
});

test('an accept the RPC refused writes nothing', async () => {
  reset();
  rpcResult = { data: null, error: { message: 'invite_expired' } };
  const res = await quiet(() => accept.POST(req('/api/workspaces/invite/tok/accept', { method: 'POST' }), { params: Promise.resolve({ token: 'tok' }) }));
  assert.notEqual(res.status, 200);
  assert.equal(events.length, 0);
});

test('member removed: by whom, which member, their role', async () => {
  reset({ target: 'admin' });
  const res = await members.DELETE(req(`/api/workspaces/members/${TARGET}?workspaceId=${WS}`, { method: 'DELETE' }), { params: Promise.resolve({ userId: TARGET }) });
  assert.equal(res.status, 200);
  assert.deepEqual(events, [{ workspaceId: WS, actorUserId: CALLER, kind: 'member_removed', target: TARGET, details: { role: 'admin' } }]);
});

test('a removal that failed writes nothing', async () => {
  reset({ fail: true });
  const res = await quiet(() => members.DELETE(req(`/api/workspaces/members/${TARGET}?workspaceId=${WS}`, { method: 'DELETE' }), { params: Promise.resolve({ userId: TARGET }) }));
  assert.equal(res.status, 500);
  assert.equal(events.length, 0);
});

test('role changed: from and to', async () => {
  reset({ target: 'member' });
  const res = await members.PATCH(req(`/api/workspaces/members/${TARGET}`, json('PATCH', { workspaceId: WS, role: 'admin' })), { params: Promise.resolve({ userId: TARGET }) });
  assert.equal(res.status, 200);
  assert.deepEqual(events, [{ workspaceId: WS, actorUserId: CALLER, kind: 'role_changed', target: TARGET, details: { from: 'member', to: 'admin' } }]);
});

test('a role "change" to the same role, or by an admin, writes nothing', async () => {
  reset({ target: 'member' });
  await members.PATCH(req(`/api/workspaces/members/${TARGET}`, json('PATCH', { workspaceId: WS, role: 'member' })), { params: Promise.resolve({ userId: TARGET }) });
  assert.equal(events.length, 0);
  reset({ caller: 'admin' });
  const res = await members.PATCH(req(`/api/workspaces/members/${TARGET}`, json('PATCH', { workspaceId: WS, role: 'viewer' })), { params: Promise.resolve({ userId: TARGET }) });
  assert.equal(res.status, 403);
  assert.equal(events.length, 0);
});

test('member left: the leaver is actor and target', async () => {
  reset({ caller: 'member' });
  const res = await leave.POST(req(`/api/workspaces/${WS}/leave`, { method: 'POST' }), { params: Promise.resolve({ id: WS }) });
  assert.equal(res.status, 200);
  assert.deepEqual(events, [{ workspaceId: WS, actorUserId: CALLER, kind: 'member_left', target: CALLER, details: { role: 'member' } }]);
});

test('the owner cannot leave, so nothing is written', async () => {
  reset({ caller: 'owner' });
  const res = await leave.POST(req(`/api/workspaces/${WS}/leave`, { method: 'POST' }), { params: Promise.resolve({ id: WS }) });
  assert.equal(res.status, 403);
  assert.equal(events.length, 0);
});

test('inbox visibility changed: which inbox, from and to', async () => {
  reset();
  const res = await visibility.PATCH(req(`/api/inboxes/${INBOX}/visibility`, json('PATCH', { visibility: 'company' })), { params: Promise.resolve({ id: INBOX }) });
  assert.equal(res.status, 200);
  assert.deepEqual(events, [{
    workspaceId: WS,
    actorUserId: CALLER,
    kind: 'inbox_visibility_changed',
    target: INBOX,
    details: { from: 'private', to: 'company', inbox: 'me@example.test' },
  }]);
});

test('a visibility change refused (not the owner) or failed writes nothing', async () => {
  reset();
  inboxRow = { ...inboxRow!, owner_user_id: TARGET, visibility: 'company' };
  const refused = await visibility.PATCH(req(`/api/inboxes/${INBOX}/visibility`, json('PATCH', { visibility: 'private' })), { params: Promise.resolve({ id: INBOX }) });
  assert.equal(refused.status, 403);
  reset({ fail: true });
  const failed = await quiet(() => visibility.PATCH(req(`/api/inboxes/${INBOX}/visibility`, json('PATCH', { visibility: 'company' })), { params: Promise.resolve({ id: INBOX }) }));
  assert.equal(failed.status, 500);
  assert.equal(events.length, 0);
});
