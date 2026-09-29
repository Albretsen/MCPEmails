import test from 'node:test';
import assert from 'node:assert/strict';
import { SEGMENT_STAMP_WINDOW_MS, shouldStampSegment, stampAcquisitionSegment } from './record-segment.ts';

// Only reserved example domains. Never a real customer's.

type Call = { table: string; values: unknown; filters: Array<[string, string, unknown]> };

function fakeDb(result: { error: { message: string } | null } = { error: null }) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const call: Call = { table, values: undefined, filters: [] };
      calls.push(call);
      const chain = {
        update(values: unknown) { call.values = values; return chain; },
        eq(col: string, v: unknown) { call.filters.push(['eq', col, v]); return chain; },
        is(col: string, v: unknown) { call.filters.push(['is', col, v]); return Promise.resolve(result); },
      };
      return chain;
    },
  };
  return { db: db as never, calls };
}

const NOW = Date.parse('2026-09-29T12:00:00Z');
const justNow = new Date(NOW - 60_000).toISOString();

test('a new owner is stamped with the segment of their signup email, first write only', async () => {
  const { db, calls } = fakeDb();
  await stampAcquisitionSegment(db, { workspaceId: 'ws-1', ownerEmail: 'info@acme.example', userCreatedAt: justNow, now: NOW });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].table, 'workspaces');
  assert.deepEqual(calls[0].values, { acquisition_email_segment: 'business' });
  assert.deepEqual(calls[0].filters, [
    ['eq', 'id', 'ws-1'],
    // Never overwrites what was true at signup.
    ['is', 'acquisition_email_segment', null],
  ]);
});

test('consumer, school and unreadable addresses get their own words, never business', async () => {
  for (const [email, expected] of [
    ['ada@gmail.com', 'consumer'],
    ['ada@cs.example.edu', 'academic'],
    [null, 'unknown'],
  ] as const) {
    const { db, calls } = fakeDb();
    await stampAcquisitionSegment(db, { workspaceId: 'ws-1', ownerEmail: email, userCreatedAt: justNow, now: NOW });
    assert.deepEqual(calls[0].values, { acquisition_email_segment: expected }, String(email));
  }
});

test('a returning customer costs no write at all', async () => {
  const { db, calls } = fakeDb();
  const old = new Date(NOW - SEGMENT_STAMP_WINDOW_MS - 1).toISOString();
  await stampAcquisitionSegment(db, { workspaceId: 'ws-1', ownerEmail: 'info@acme.example', userCreatedAt: old, now: NOW });
  assert.equal(calls.length, 0);
});

test('no workspace, or no usable creation time, writes nothing', async () => {
  for (const args of [
    { workspaceId: null, userCreatedAt: justNow },
    { workspaceId: 'ws-1', userCreatedAt: 'not a date' },
    { workspaceId: 'ws-1', userCreatedAt: null },
  ]) {
    const { db, calls } = fakeDb();
    await stampAcquisitionSegment(db, { ...args, ownerEmail: 'info@acme.example', now: NOW });
    assert.equal(calls.length, 0);
  }
});

test('a failed write (for example the migration not applied yet) never throws', async () => {
  const { db } = fakeDb({ error: { message: 'column "acquisition_email_segment" does not exist' } });
  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.doesNotReject(
      stampAcquisitionSegment(db, { workspaceId: 'ws-1', ownerEmail: 'info@acme.example', userCreatedAt: justNow, now: NOW }),
    );
    const throwing = { from() { throw new Error('boom'); } } as never;
    await assert.doesNotReject(
      stampAcquisitionSegment(throwing, { workspaceId: 'ws-1', ownerEmail: 'info@acme.example', userCreatedAt: justNow, now: NOW }),
    );
  } finally {
    console.error = originalError;
  }
});

test('the window tolerates small clock skew and ends at 24 hours', () => {
  assert.equal(shouldStampSegment(NOW + 60_000, NOW), true);
  assert.equal(shouldStampSegment(NOW - SEGMENT_STAMP_WINDOW_MS + 1, NOW), true);
  assert.equal(shouldStampSegment(NOW - SEGMENT_STAMP_WINDOW_MS, NOW), false);
  assert.equal(shouldStampSegment(NOW + 10 * 60_000, NOW), false);
});
