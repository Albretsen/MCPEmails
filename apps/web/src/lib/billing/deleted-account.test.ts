/**
 * Tests for accountState(): the question the billing dispatcher and the
 * webhook ask before mailing anyone about a subscription.
 *
 * The stand-in is the one auth.admin call the helper makes. Nothing here
 * touches a network.
 *
 * Run:
 *   node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
 *     src/lib/billing/deleted-account.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { accountState, type AuthAdminReader } from '@/lib/billing/deleted-account';

const USER = '00000000-0000-4000-8000-0000000000d1';
const NOW = Date.parse('2026-10-19T12:00:00.000Z');

type Answer = Awaited<ReturnType<AuthAdminReader['auth']['admin']['getUserById']>>;

function reader(answer: Answer | (() => never)): AuthAdminReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    auth: {
      admin: {
        async getUserById(id: string) {
          calls.push(id);
          return typeof answer === 'function' ? answer() : answer;
        },
      },
    },
  };
}

function user(fields: { banned_until?: string | null; app_metadata?: Record<string, unknown> }): Answer {
  return { data: { user: { banned_until: null, app_metadata: {}, ...fields } }, error: null };
}

test('an account delete-account stamped with deleted_at is deleted', async () => {
  const db = reader(user({ app_metadata: { deleted_at: '2026-10-01T00:00:00.000Z' } }));
  assert.equal(await accountState(db, USER, NOW), 'deleted');
  assert.deepEqual(db.calls, [USER]);
});

test('a ban that has not run out is deleted, even without the stamp', async () => {
  // delete-account sets both in one call; a ban alone is still its signature.
  const db = reader(user({ banned_until: '2126-10-01T00:00:00.000Z' }));
  assert.equal(await accountState(db, USER, NOW), 'deleted');
});

test('a ban that already ran out is live', async () => {
  const db = reader(user({ banned_until: '2026-10-01T00:00:00.000Z' }));
  assert.equal(await accountState(db, USER, NOW), 'live');
});

test('an ordinary account is live', async () => {
  assert.equal(await accountState(reader(user({})), USER, NOW), 'live');
});

test('an auth user that no longer exists is deleted', async () => {
  const notFound: Answer = { data: { user: null }, error: { message: 'User not found', status: 404 } };
  assert.equal(await accountState(reader(notFound), USER, NOW), 'deleted');
  assert.equal(await accountState(reader({ data: { user: null }, error: null }), USER, NOW), 'deleted');
});

test('a failed auth read is unknown, never live and never deleted', async () => {
  const down: Answer = { data: { user: null }, error: { message: 'upstream timeout', status: 500 } };
  assert.equal(await accountState(reader(down), USER, NOW), 'unknown');
  const throws = reader(() => {
    throw new Error('fetch failed');
  });
  assert.equal(await accountState(throws, USER, NOW), 'unknown');
});

test('no user id asks nothing and is live', async () => {
  const db = reader(user({ app_metadata: { deleted_at: 'x' } }));
  assert.equal(await accountState(db, null, NOW), 'live');
  assert.deepEqual(db.calls, []);
});
