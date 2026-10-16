// ---------------------------------------------------------------------------
// The human approve paths are bound to what the human was shown.
//
// Run with: npm run test:approvals
//
// Security review 2026-10-16:
//   F-04-02 an MCP key could rewrite a pending send after the review page had
//           rendered it, and the approve claimed whatever was current;
//   F-04-05 approvers saw only a Bcc count, so a hidden recipient was approved
//           blind;
//   F-04-04 a draft send never showed its body.
//
// `decideApproval` and `loadApprovalForReview` take the database as an
// argument, so a small in-memory PostgREST stand-in exercises the real code.
// The revision trigger (migration 20261016160600) is mirrored by the fake and
// proven against Postgres in supabase/tests/send_approval_revision.sql.
// Only reserved example domains appear below.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

const { decideApproval, parseRenderedRevision, CHANGED_ERROR } = await import('./decide.ts');
const { loadApprovalForReview, reviewerBccFor } = await import('./review.ts');
const { encryptToken } = await import('../crypto.ts');

/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private op: 'select' | 'update' | 'insert' = 'select';
  private patch: Row = {};
  private db: FakeDb;
  private table: string;
  constructor(db: FakeDb, table: string) {
    this.db = db;
    this.table = table;
  }
  select() { return this; }
  insert(row: Row) { this.op = 'insert'; this.patch = row; return this; }
  update(patch: Row) { this.op = 'update'; this.patch = patch; return this; }
  eq(column: string, value: unknown) { this.filters.push([column, value]); return this; }
  neq() { return this; }
  order() { return this; }
  limit() { return this; }
  maybeSingle() { return this.run(true); }
  then(resolve: (v: any) => unknown, reject?: (e: unknown) => unknown) {
    return this.run(false).then(resolve, reject);
  }
  private async run(single: boolean) {
    const rows = (this.db.tables[this.table] ??= []);
    if (this.op === 'insert') {
      rows.push({ ...this.patch });
      return { data: null, error: null };
    }
    if (this.op === 'update') this.db.beforeUpdate?.(this.table);
    const matched = rows.filter((row) => this.filters.every(([c, v]) => row[c] === v));
    if (this.op === 'update') {
      for (const row of matched) {
        const before = JSON.stringify([row.payload, row.summary, row.send_at]);
        const { revision: _ignored, ...patch } = this.patch;
        Object.assign(row, patch);
        if (this.table === 'send_approvals' && JSON.stringify([row.payload, row.summary, row.send_at]) !== before) {
          row.revision += 1;
        }
      }
    }
    return { data: single ? (matched[0] ?? null) : matched, error: null };
  }
}

class FakeDb {
  beforeUpdate?: (table: string) => void;
  tables: Record<string, Row[]>;
  constructor(tables: Record<string, Row[]>) {
    this.tables = tables;
  }
  from(table: string) { return new FakeQuery(this, table); }
}

const WS = 'ws-0001';
const ID = '11111111-1111-4111-8111-111111111111';
const USER = 'user-0001';

function approval(overrides: Row = {}): Row {
  return {
    id: ID,
    workspace_id: WS,
    inbox_id: 'inbox-1',
    operation: 'email_send',
    status: 'pending',
    revision: 1,
    send_at: null,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    summary: { to: ['colleague@example.com'], cc: [], bcc_count: 1, subject: 'Notes' },
    payload: {
      v: 1,
      data: encryptToken(JSON.stringify({
        to: ['colleague@example.com'],
        bcc: ['drop@evil.example'],
        subject: 'Notes',
        body: 'Harmless words',
      })),
    },
    payload_encrypted: true,
    ...overrides,
  };
}

function db(row: Row = approval(), role = 'owner') {
  return new FakeDb({
    send_approvals: [row],
    scheduled_sends: [],
    workspace_members: [{ workspace_id: WS, user_id: USER, role }],
    users: [],
  });
}

function decide(fake: FakeDb, decision: 'approve' | 'reject', revision: number | null) {
  return decideApproval({
    db: fake,
    approvalId: ID,
    workspaceId: WS,
    userId: USER,
    decision,
    via: 'review_page',
    revision,
  });
}

// ---------------------------------------------------------------------------
// decideApproval
// ---------------------------------------------------------------------------

test('approving the revision that was rendered approves it and queues the send', async () => {
  const fake = db();
  const outcome = await decide(fake, 'approve', 1);
  assert.deepEqual(outcome, { ok: true, decision: 'approve' });
  assert.equal(fake.tables.send_approvals[0].status, 'approved');
  assert.equal(fake.tables.scheduled_sends.length, 1);
  assert.deepEqual(fake.tables.scheduled_sends[0].payload, { approval_id: ID });
});

test('F-04-02: approval_update after the page rendered: the stale approve is refused as changed', async () => {
  const fake = db();
  // The page rendered revision 1. The agent then rewrites the body.
  const row = fake.tables.send_approvals[0];
  await fake.from('send_approvals').update({ payload: { v: 1, data: encryptToken('{"body":"secrets"}') } }).eq('id', ID);
  assert.equal(row.revision, 2, 'the edit bumped the revision');

  const outcome = await decide(fake, 'approve', 1);
  assert.deepEqual(outcome, { ok: false, code: 'changed', status: 409, error: CHANGED_ERROR });
  assert.equal(row.status, 'pending', 'still pending: nobody approved the new content');
  assert.equal(fake.tables.scheduled_sends.length, 0, 'nothing queued for delivery');

  // Reviewing again (revision 2) approves.
  assert.equal((await decide(fake, 'approve', 2)).ok, true);
});

test('an edit that lands between the read and the claim is refused as changed too', async () => {
  const fake = db();
  let edited = false;
  fake.beforeUpdate = (table) => {
    if (table !== 'send_approvals' || edited) return;
    edited = true;
    const row = fake.tables.send_approvals[0];
    row.summary = { ...row.summary, subject: 'Swapped' };
    row.revision += 1;
  };
  const outcome = await decide(fake, 'approve', 1);
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.code, 'changed');
  assert.equal(fake.tables.send_approvals[0].status, 'pending');
  assert.equal(fake.tables.scheduled_sends.length, 0);
});

test('an approve that names no revision approves nothing', async () => {
  const fake = db();
  const outcome = await decide(fake, 'approve', null);
  assert.equal(!outcome.ok && outcome.code, 'changed');
  assert.equal(fake.tables.send_approvals[0].status, 'pending');
});

test('a request decided elsewhere still reads not_pending, not changed', async () => {
  const fake = db(approval({ status: 'approved' }));
  const outcome = await decide(fake, 'approve', 1);
  assert.equal(!outcome.ok && outcome.code, 'not_pending');
});

test('rejecting needs no revision: it is fail-safe whatever the content says', async () => {
  const fake = db(approval({ revision: 5 }));
  assert.deepEqual(await decide(fake, 'reject', null), { ok: true, decision: 'reject' });
  assert.equal(fake.tables.send_approvals[0].status, 'rejected');
  assert.equal(fake.tables.scheduled_sends.length, 0);
});

test('an expired request is still refused and retired', async () => {
  const fake = db(approval({ expires_at: new Date(Date.now() - 1000).toISOString() }));
  const outcome = await decide(fake, 'approve', 1);
  assert.equal(!outcome.ok && outcome.code, 'expired');
  assert.equal(fake.tables.send_approvals[0].status, 'expired');
});

test('parseRenderedRevision accepts only a positive integer', () => {
  assert.equal(parseRenderedRevision(3), 3);
  for (const bad of [undefined, null, 0, -1, 1.5, '1', [1], {}]) {
    assert.equal(parseRenderedRevision(bad), null, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// loadApprovalForReview
// ---------------------------------------------------------------------------

test('F-04-05: owner, admin and member see every Bcc address; the revision is on the model', async () => {
  for (const role of ['owner', 'admin', 'member']) {
    const review = await loadApprovalForReview(db(approval({ revision: 4 }), role), ID, USER);
    assert.notEqual(review, 'not_found');
    if (review === 'not_found') return;
    assert.deepEqual(review.recipients.bcc, ['drop@evil.example'], role);
    assert.equal(review.recipients.bcc_count, 1);
    assert.equal(review.revision, 4);
  }
});

test('a viewer sees the Bcc count only, as before', async () => {
  const review = await loadApprovalForReview(db(approval(), 'viewer'), ID, USER);
  assert.notEqual(review, 'not_found');
  if (review === 'not_found') return;
  assert.deepEqual(review.recipients.bcc, []);
  assert.equal(review.recipients.bcc_count, 1);
  assert.equal(review.body.unavailable, 'withheld_role');
});

test('a Bcc the summary under-counts is shown as what will be sent', async () => {
  const review = await loadApprovalForReview(
    db(approval({ summary: { to: ['colleague@example.com'], bcc_count: 0, subject: 'Notes' } })),
    ID,
    USER,
  );
  if (review === 'not_found') throw new Error('not found');
  assert.equal(review.recipients.bcc_count, 1);
  assert.deepEqual(review.recipients.bcc, ['drop@evil.example']);
});

test('F-04-04: a draft send shows the recorded body, files and Bcc', async () => {
  const row = approval({
    operation: 'draft_send',
    summary: { to: ['partner@example.com'], cc: [], bcc_count: 1, subject: 'Q3 notes', attachment_count: 0 },
    payload: {
      v: 1,
      data: encryptToken(JSON.stringify({
        draft_id: 'g1',
        base_revision: 0,
        draft_snapshot: {
          v: 1,
          to: ['partner@example.com'],
          cc: [],
          bcc: ['drop@evil.example'],
          subject: 'Q3 notes',
          body_text: 'Harvested data here',
          body_html: '<p>Harvested data here</p>',
          body_truncated: false,
          attachments: [{ filename: 'notes.pdf', size_bytes: 2048, mime_type: 'application/pdf' }],
        },
        draft_digest: 'f'.repeat(64),
      })),
    },
  });
  const review = await loadApprovalForReview(db(row), ID, USER);
  if (review === 'not_found') throw new Error('not found');
  assert.equal(review.body.unavailable, null);
  assert.equal(review.body.text, 'Harvested data here');
  assert.equal(review.body.html, '<p>Harvested data here</p>');
  assert.deepEqual(review.recipients.bcc, ['drop@evil.example']);
  assert.equal(review.attachment_count, 1);
  assert.deepEqual(review.attachments, [{ filename: 'notes.pdf', mime_type: 'application/pdf', size_bytes: 2048 }]);
});

test('a draft send queued before snapshots still says the text is with the provider', async () => {
  const row = approval({
    operation: 'draft_send',
    payload: { v: 1, data: encryptToken(JSON.stringify({ draft_id: 'g1', base_revision: 0 })) },
  });
  const review = await loadApprovalForReview(db(row), ID, USER);
  if (review === 'not_found') throw new Error('not found');
  assert.equal(review.body.unavailable, 'stored_with_provider');
});

test('reviewerBccFor: addresses for deciding roles, nothing for viewer or an unreadable payload', () => {
  assert.deepEqual(reviewerBccFor(approval(), 'admin'), ['drop@evil.example']);
  assert.deepEqual(reviewerBccFor(approval(), 'viewer'), []);
  assert.deepEqual(reviewerBccFor(approval({ payload: { v: 1, data: 'garbage' } }), 'owner'), []);
});
