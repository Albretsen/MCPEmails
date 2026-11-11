// ---------------------------------------------------------------------------
// GET /api/approvals (the queue) decrypts nothing; GET /api/approvals/[id] (the
// decision dialog) returns one approval's Bcc addresses, role-gated.
//
// Run with: npm run test:approvals
// Only the Supabase clients and the active-workspace lookup are stubbed.
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

/* eslint-disable @typescript-eslint/no-explicit-any */

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

type Row = Record<string, any>;
let tables: Record<string, Row[]> = {};
let signedIn: { id: string } | null = { id: 'user-1' };

function query(table: string) {
  const filters: Array<[string, unknown]> = [];
  let columns: string[] | null = null;
  let embedsInbox = false;
  // Projects to the selected columns, as PostgREST does, so a route that
  // stopped selecting the payload really does not get it. An `inboxes(...)`
  // embed is resolved from the inboxes table by inbox_id.
  const project = (r: Row) => {
    const out: Row = columns ? Object.fromEntries(columns.filter((c) => c in r).map((c) => [c, r[c]])) : { ...r };
    if (embedsInbox) out.inboxes = (tables.inboxes ?? []).find((i) => i.id === r.inbox_id) ?? null;
    return out;
  };
  const extra: Array<(r: Row) => boolean> = [];
  const rows = () =>
    (tables[table] ?? [])
      .filter((r) => filters.every(([c, v]) => r[c] === v) && extra.every((keep) => keep(r)))
      .map(project);
  const builder: any = {
    select: (list = '*') => {
      embedsInbox = String(list).includes('inboxes(');
      const names = String(list).split(/,(?![^(]*\))/).map((c) => c.trim()).filter((c) => c && !c.includes('('));
      columns = names.includes('*') ? null : names;
      return builder;
    },
    eq: (c: string, v: unknown) => (filters.push([c, v]), builder),
    neq: (c: string, v: unknown) => (extra.push((r) => r[c] !== v), builder),
    // Only the queue's one `or`: null, or after the moment it names.
    or: (clause: string) => {
      const after = clause.split('.gt.')[1];
      extra.push((r) => r.expires_at == null || r.expires_at > after);
      return builder;
    },
    lte: (c: string, v: unknown) => (extra.push((r) => r[c] != null && r[c] <= (v as string)), builder),
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    then: (resolve: (v: any) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve),
  };
  return builder;
}
const db = { from: query };

nodeMock.module('@/lib/supabase/server', {
  namedExports: { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: signedIn } }) } }) },
});
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => db } });
nodeMock.module('@/lib/workspace/active', { namedExports: { resolveActiveWorkspaceId: async () => 'ws-1' } });
// The decision itself (atomic claim, dispatcher marker) is covered in
// src/lib/approvals/approvals.test.ts; here only WHO reaches it matters.
const decisions: Array<{ approvalId: string; userId: string; decision: string }> = [];
nodeMock.module('@/lib/approvals/decide', {
  namedExports: {
    canDecide: (role: string | null | undefined) => role === 'owner' || role === 'admin',
    parseRenderedRevision: (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? v : null),
    // Imported by the forward helpers the queue route uses (forward-again.ts).
    isExpired: (approval: { expires_at?: string | null } | null) => {
      const at = approval?.expires_at ? Date.parse(approval.expires_at) : Number.NaN;
      return Number.isFinite(at) && at <= Date.now();
    },
    kickDispatch: async () => {},
    decideApproval: async (args: { approvalId: string; userId: string; decision: string }) => {
      decisions.push({ approvalId: args.approvalId, userId: args.userId, decision: args.decision });
      return { ok: true };
    },
  },
});

const { encryptToken } = await import('../../../src/lib/crypto.ts');
const detail = (await import('./[id]/route.ts')) as any;
const list = (await import('./route.ts')) as any;

const ID = '11111111-1111-4111-8111-111111111111';

function seed(role: string, payload: Row, operation = 'email_send') {
  tables = {
    send_approvals: [{
      id: ID,
      workspace_id: 'ws-1',
      inbox_id: 'inbox-1',
      operation,
      status: 'pending',
      revision: 3,
      summary: { to: ['colleague@example.com'], cc: [], bcc_count: 1, subject: 'Notes' },
      payload: { v: 1, data: encryptToken(JSON.stringify(payload)) },
      payload_encrypted: true,
      created_at: '2026-10-16T10:00:00.000Z',
    }],
    workspace_members: [{ workspace_id: 'ws-1', user_id: 'user-1', role }],
    inboxes: [{ id: 'inbox-1', email_address: 'box@example.com', display_name: null, owner_user_id: 'owner-1', visibility: 'company' }],
  };
}

const get = (id = ID) => detail.GET(new Request(`https://mcpemails.test/api/approvals/${id}`), { params: Promise.resolve({ id }) });

test('details: an owner gets the Bcc addresses, the revision and approvability', async () => {
  seed('owner', { to: ['colleague@example.com'], bcc: ['drop@evil.example'], body: 'x' });
  const res = await get();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.bcc, ['drop@evil.example']);
  assert.equal(body.bcc_count, 1);
  assert.equal(body.revision, 3);
  assert.equal(body.approvable, true);
  assert.equal(body.subject, 'Notes');
  assert.equal('payload' in body, false, 'never the payload itself');
});

test('details: a viewer gets the count and no addresses', async () => {
  seed('viewer', { to: ['colleague@example.com'], bcc: ['drop@evil.example'], body: 'x' });
  const body = await (await get()).json();
  assert.deepEqual(body.bcc, []);
  assert.equal(body.bcc_count, 1);
});

test('details: a legacy draft send is reported as not approvable', async () => {
  seed('admin', { draft_id: 'g1', base_revision: 0 }, 'draft_send');
  assert.equal((await (await get()).json()).approvable, false);
});

test('details: no session is 401; another workspace and a bad id are the same 404', async () => {
  seed('owner', { bcc: [] });
  signedIn = null;
  assert.equal((await get()).status, 401);
  signedIn = { id: 'user-1' };
  tables.workspace_members = [];
  assert.equal((await get()).status, 404);
  assert.equal((await get('not-a-uuid')).status, 404);
});

test('queue: lists summaries with the revision, and no payload or Bcc addresses', async () => {
  seed('owner', { to: ['colleague@example.com'], bcc: ['drop@evil.example'], body: 'x' });
  const res = await list.GET();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.approvals.length, 1);
  assert.equal(body.approvals[0].revision, 3);
  assert.equal(JSON.stringify(body).includes('drop@evil.example'), false);
  assert.equal(JSON.stringify(body).includes('"data"'), false, 'no ciphertext either');
});

test('queue: a rule forward names its rule, kind and expiry', async () => {
  seed('owner', { to: ['colleague@example.com'] }, 'email_forward');
  Object.assign(tables.send_approvals[0], {
    triage_rule_id: 'rule-1',
    triage_rule_name: 'Invoices',
    expires_at: '2099-10-17T10:00:00.000Z',
  });
  const [row] = (await (await list.GET()).json()).approvals;
  assert.equal(row.kind, 'rule_forward');
  assert.equal(row.rule_id, 'rule-1');
  assert.equal(row.rule_name, 'Invoices');
  assert.equal(row.expires_at, '2099-10-17T10:00:00.000Z');
  assert.equal('triage_rule_id' in row, false, 'one name for the field');
});

test('queue: a rule forward whose rule row is gone still reads as one, by name', async () => {
  seed('owner', { to: ['colleague@example.com'] }, 'email_forward');
  Object.assign(tables.send_approvals[0], { triage_rule_id: null, triage_rule_name: 'Invoices' });
  const [row] = (await (await list.GET()).json()).approvals;
  assert.equal(row.kind, 'rule_forward');
  assert.equal(row.rule_id, null);
  assert.equal(row.rule_name, 'Invoices');
});

test('queue: an AI send has no rule', async () => {
  seed('owner', { to: ['colleague@example.com'] });
  Object.assign(tables.send_approvals[0], { expires_at: '2099-10-17T10:00:00.000Z' });
  const [row] = (await (await list.GET()).json()).approvals;
  assert.equal(row.kind, 'ai_send');
  assert.equal(row.rule_id, null);
  assert.equal(row.rule_name, null);
  assert.equal(row.expires_at, '2099-10-17T10:00:00.000Z');
});

// Since 2026-10-30 mcp-server stores the summary encrypted; older rows hold it
// in clear. Both must render the same.
function sealSummary() {
  const row = tables.send_approvals[0];
  row.summary = { v: 1, data: encryptToken(JSON.stringify(row.summary)) };
}

test('queue: an encrypted summary is returned decrypted, without ciphertext', async () => {
  seed('owner', { to: ['colleague@example.com'], body: 'x' });
  sealSummary();
  const body = await (await list.GET()).json();
  assert.equal(body.approvals[0].summary.subject, 'Notes');
  assert.deepEqual(body.approvals[0].summary.to, ['colleague@example.com']);
  assert.equal(JSON.stringify(body).includes('"data"'), false, 'no ciphertext');
});

test('details: an encrypted summary reads like a plaintext one', async () => {
  seed('owner', { to: ['colleague@example.com'], bcc: [], body: 'x' });
  sealSummary();
  const body = await (await get()).json();
  assert.equal(body.subject, 'Notes');
  assert.deepEqual(body.to, ['colleague@example.com']);
  assert.equal(body.bcc_count, 1);
});

test('details: a summary that does not decrypt reads as empty, not a 500', async () => {
  seed('owner', { to: ['colleague@example.com'], bcc: [], body: 'x' });
  tables.send_approvals[0].summary = { v: 1, data: 'not-ciphertext' };
  const res = await get();
  assert.equal(res.status, 200);
  assert.equal((await res.json()).subject, '');
});

// ---------------------------------------------------------------------------
// The deadline: an expired row is out of the queue, and in the decided list as
// expired, with no claim that anyone decided it.
// ---------------------------------------------------------------------------

test('queue: a row past its deadline is not offered, and is listed as expired', async () => {
  tables = {
    workspace_members: [{ workspace_id: 'ws-1', user_id: 'user-1', role: 'owner' }],
    send_approvals: [
      {
        id: 'late',
        workspace_id: 'ws-1',
        status: 'pending',
        operation: 'email_forward',
        summary: { to: ['a@example.com'], subject: 'S' },
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        triage_rule_id: null,
        triage_rule_name: 'Invoices',
      },
    ],
  };
  const payload = await (await list.GET()).json();
  assert.equal(payload.approvals.length, 0);
  assert.equal(payload.decided.length, 1);
  assert.equal(payload.decided[0].status, 'expired');
  assert.equal(payload.decided[0].decider, 'none');
  assert.equal(payload.decided[0].decided_via, null);
  assert.equal('decided_by' in payload.decided[0], false);
});

// ── Business privacy model (migration 20261111190000) ─────────────────────
// inbox-1 below is a PRIVATE inbox owned by 'owner-of-inbox'; the caller is
// user-1 with the role under test.

function seedPrivate(role: string, inboxOwner = 'owner-of-inbox') {
  seed(role, { to: ['colleague@example.com'], bcc: ['drop@evil.example'], body: 'secret words' });
  tables.inboxes = [{ id: 'inbox-1', email_address: 'box@example.com', display_name: 'Box', owner_user_id: inboxOwner, visibility: 'private' }];
}

const patch = (body: unknown) =>
  list.PATCH(new Request('https://mcpemails.test/api/approvals', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', origin: 'https://mcpemails.test', host: 'mcpemails.test' },
    body: JSON.stringify(body),
  }));

test('privacy queue: a member never sees a held send of someone else\'s private inbox', async () => {
  seedPrivate('member');
  const body = await (await list.GET()).json();
  assert.equal(body.approvals.length, 0);
  assert.equal(JSON.stringify(body).includes('Notes'), false);
});

test('privacy queue: owner and admin get metadata only, and may still decide', async () => {
  for (const role of ['owner', 'admin']) {
    seedPrivate(role);
    const body = await (await list.GET()).json();
    assert.equal(body.approvals.length, 1, role);
    const row = body.approvals[0];
    assert.equal(row.redacted, true);
    assert.equal(row.can_decide, true);
    assert.equal(row.inboxes.email_address, 'box@example.com');
    assert.deepEqual(row.summary, {});
    assert.equal(JSON.stringify(body).includes('Notes'), false, 'no subject');
    assert.equal(JSON.stringify(body).includes('colleague@example.com'), false, 'no recipients');
    assert.equal(JSON.stringify(body).includes('owner-of-inbox'), false, 'no owner id leaks through the embed');
  }
});

test('privacy queue: the inbox owner sees their own held send in full and may decide it as a member', async () => {
  seedPrivate('member', 'user-1');
  const body = await (await list.GET()).json();
  assert.equal(body.approvals.length, 1);
  assert.equal(body.approvals[0].redacted, undefined);
  assert.equal(body.approvals[0].summary.subject, 'Notes');
  assert.equal(body.approvals[0].can_decide, true);
});

test('privacy queue: a member on a company inbox sees it but cannot decide (unchanged)', async () => {
  seed('member', { to: ['colleague@example.com'], body: 'x' });
  const body = await (await list.GET()).json();
  assert.equal(body.approvals[0].summary.subject, 'Notes');
  assert.equal(body.approvals[0].can_decide, false);
});

test('privacy details: a member gets 404; owner/admin get no subject, recipients or Bcc', async () => {
  seedPrivate('member');
  assert.equal((await get()).status, 404);
  for (const role of ['owner', 'admin']) {
    seedPrivate(role);
    const res = await get();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.redacted, true);
    assert.equal(body.subject, '');
    assert.deepEqual(body.to, []);
    assert.deepEqual(body.bcc, []);
    assert.equal(body.bcc_count, 0);
    assert.equal(body.inbox_address, 'box@example.com');
    assert.equal(body.can_decide, true);
    assert.equal(JSON.stringify(body).includes('drop@evil.example'), false);
  }
});

test('privacy: a recipient-rule hold on someone else\'s private inbox shows owner/admin the recipients, never the subject', async () => {
  for (const role of ['owner', 'admin']) {
    seedPrivate(role);
    tables.send_approvals[0].hold_reason = 'recipient_rule';
    const queue = await (await list.GET()).json();
    const row = queue.approvals[0];
    assert.equal(row.redacted, true, role);
    assert.deepEqual(row.summary, { to: ['colleague@example.com'], cc: [], bcc_count: 1 }, role);
    assert.equal(JSON.stringify(queue).includes('Notes'), false, 'no subject in the queue');

    const body = await (await get()).json();
    assert.equal(body.redacted, true);
    assert.deepEqual(body.to, ['colleague@example.com']);
    assert.deepEqual(body.bcc, ['drop@evil.example'], 'the Bcc addresses the rule may have held');
    assert.equal(body.bcc_count, 1);
    assert.equal(body.subject, '');
    assert.equal(JSON.stringify(body).includes('Notes'), false, 'no subject');
    assert.equal(JSON.stringify(body).includes('secret words'), false, 'no body');
  }
  // A member still gets nothing.
  seedPrivate('member');
  tables.send_approvals[0].hold_reason = 'recipient_rule';
  assert.equal((await get()).status, 404);
});

test('privacy decide (PATCH): the inbox owner decides their own private inbox as a member', async () => {
  seedPrivate('member', 'user-1');
  decisions.length = 0;
  const res = await patch({ id: ID, decision: 'reject' });
  assert.equal(res.status, 200);
  assert.deepEqual(decisions, [{ approvalId: ID, userId: 'user-1', decision: 'reject' }]);
});

test('privacy decide (PATCH): a member cannot decide someone else\'s private send (404) or a company send (403)', async () => {
  seedPrivate('member');
  decisions.length = 0;
  assert.equal((await patch({ id: ID, decision: 'approve', revision: 3 })).status, 404);
  seed('member', { to: ['colleague@example.com'], body: 'x' });
  assert.equal((await patch({ id: ID, decision: 'approve', revision: 3 })).status, 403);
  assert.deepEqual(decisions, []);
});

test('privacy decide (PATCH): an owner may still decide a private send they cannot read', async () => {
  seedPrivate('owner');
  decisions.length = 0;
  assert.equal((await patch({ id: ID, decision: 'reject' })).status, 200);
  assert.equal(decisions.length, 1);
});

test('privacy: a lapsed rule forward from someone else\'s private inbox is listed for an owner without its rule, recipients or Forward again', async () => {
  tables = {
    workspace_members: [{ workspace_id: 'ws-1', user_id: 'user-1', role: 'owner' }],
    inboxes: [{ id: 'inbox-1', email_address: 'box@example.com', display_name: 'Box', owner_user_id: 'owner-of-inbox', visibility: 'private' }],
    triage_rules: [{ id: 'rule-1', deleted_at: null }],
    send_approvals: [
      {
        id: 'late',
        workspace_id: 'ws-1',
        inbox_id: 'inbox-1',
        status: 'pending',
        operation: 'email_forward',
        summary: { to: ['payroll@example.com'], subject: 'Salaries' },
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        triage_rule_id: 'rule-1',
        triage_rule_name: 'Payroll for Kari',
      },
    ],
  };
  const payload = await (await list.GET()).json();
  assert.equal(payload.decided.length, 1);
  const row = payload.decided[0];
  assert.equal(row.redacted, true);
  assert.equal(row.status, 'expired');
  assert.equal(row.kind, 'rule_forward');
  assert.equal(row.rule_name, null);
  assert.equal(row.can_forward_again, false);
  for (const secret of ['Payroll for Kari', 'payroll@example.com', 'Salaries', 'owner-of-inbox']) {
    assert.equal(JSON.stringify(payload).includes(secret), false, secret);
  }
  // A member does not see the row at all.
  tables.workspace_members[0].role = 'member';
  const member = await (await list.GET()).json();
  assert.equal(member.decided.length, 0);
});
