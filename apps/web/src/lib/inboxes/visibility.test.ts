// ---------------------------------------------------------------------------
// The shared inbox-visibility helpers (migration 20261111190000). Every
// service-role route leans on these, so the one property that matters most is
// pinned first: on any doubt (an RPC error, a throw, a row without the
// columns) the answer is "not visible".
//
// Run: npm run test:inbox-route-roles
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allVisible,
  canAccessInbox,
  checkConnectTarget,
  hiddenInboxDirectory,
  isInboxVisibleTo,
  ownsInbox,
  visibleInboxIds,
} from './visibility.ts';

const ME = 'user-me';
const OTHER = 'user-other';

test('isInboxVisibleTo: company for everyone, private for its owner only, missing columns fail closed', () => {
  assert.equal(isInboxVisibleTo({ visibility: 'company', owner_user_id: OTHER }, ME), true);
  assert.equal(isInboxVisibleTo({ visibility: 'private', owner_user_id: ME }, ME), true);
  assert.equal(isInboxVisibleTo({ visibility: 'private', owner_user_id: OTHER }, ME), false);
  assert.equal(isInboxVisibleTo({ visibility: 'private', owner_user_id: null }, ME), false, 'an owner who left: nobody');
  assert.equal(isInboxVisibleTo({}, ME), false);
  assert.equal(isInboxVisibleTo(null, ME), false);
  assert.equal(isInboxVisibleTo({ visibility: 'company' }, null), false);
});

test('ownsInbox: only the owner, never a null owner', () => {
  assert.equal(ownsInbox({ owner_user_id: ME }, ME), true);
  assert.equal(ownsInbox({ owner_user_id: OTHER }, ME), false);
  assert.equal(ownsInbox({ owner_user_id: null }, null), false);
});

test('canAccessInbox and visibleInboxIds fail closed on an error or a throw', async () => {
  const ok = { rpc: async (name: string) => ({ data: name === 'inbox_visible_to' ? true : ['A-1', 'b-2'], error: null }) };
  const err = { rpc: async () => ({ data: null, error: { message: 'boom' } }) };
  const thrown = { rpc: async () => { throw new Error('network'); } };
  assert.equal(await canAccessInbox(ok, 'i', ME), true);
  assert.equal(await canAccessInbox(err, 'i', ME), false);
  assert.equal(await canAccessInbox(thrown, 'i', ME), false);
  assert.equal(await canAccessInbox(ok, '', ME), false);
  assert.deepEqual([...(await visibleInboxIds(ok, 'ws', ME))], ['a-1', 'b-2']);
  assert.equal((await visibleInboxIds(err, 'ws', ME)).size, 0);
  assert.equal((await visibleInboxIds(thrown, 'ws', ME)).size, 0);
  assert.equal(allVisible(['A-1'], new Set(['a-1'])), true);
  assert.equal(allVisible(['a-1', 'c-3'], new Set(['a-1'])), false);
});

function inboxDb(row: Record<string, unknown> | null, error: unknown = null) {
  const filters: Record<string, unknown> = {};
  const chain = {
    select: () => chain,
    eq: (c: string, v: unknown) => ((filters[c] = v), chain),
    is: (c: string, v: unknown) => ((filters[c] = v), chain),
    maybeSingle: async () => {
      assert.equal(filters.deleted_at, null, 'only a LIVE row can block');
      return { data: row, error };
    },
  };
  return { from: () => chain };
}

test("checkConnectTarget: a new address, one's own and a company inbox connect; someone else's private one does not", async () => {
  assert.deepEqual(await checkConnectTarget(inboxDb(null), 'ws', 'a@x.test', ME), { ok: true, exists: false });
  assert.deepEqual(
    await checkConnectTarget(inboxDb({ id: 'i', owner_user_id: ME, visibility: 'private' }), 'ws', 'a@x.test', ME),
    { ok: true, exists: true },
  );
  assert.deepEqual(
    await checkConnectTarget(inboxDb({ id: 'i', owner_user_id: OTHER, visibility: 'company' }), 'ws', 'a@x.test', ME),
    { ok: true, exists: true },
  );
  assert.deepEqual(
    await checkConnectTarget(inboxDb({ id: 'i', owner_user_id: OTHER, visibility: 'private' }), 'ws', 'a@x.test', ME),
    { ok: false, reason: 'owned_by_other' },
  );
  assert.deepEqual(
    await checkConnectTarget(inboxDb(null, { message: 'boom' }), 'ws', 'a@x.test', ME),
    { ok: false, reason: 'unavailable' },
  );
});

test('hiddenInboxDirectory: only rows the caller cannot open, and nothing on an error', async () => {
  const rows = [
    { id: 'a', can_access: true },
    { id: 'b', can_access: false },
  ];
  const ok = { rpc: async () => ({ data: rows, error: null }) };
  const err = { rpc: async () => ({ data: null, error: { message: 'boom' } }) };
  assert.deepEqual((await hiddenInboxDirectory(ok, 'ws')).map((r) => r.id), ['b']);
  assert.deepEqual(await hiddenInboxDirectory(err, 'ws'), []);
});
