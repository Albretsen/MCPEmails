// ---------------------------------------------------------------------------
// The referral share link for the purchase email and the Invite page.
//
// Pins: a user whose owned workspace has the flag gets /r/<code>, created on
// first use and reused after; the flag off, a disabled code or a failing
// database gives null and never throws.
//
// Run: npm run test:referrals-server
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeSupabase } from '@/lib/billing/fake-supabase';
import { referralLinkForUser } from './link.ts';
import type { Db } from './server.ts';

process.env.NEXT_PUBLIC_APP_URL = 'https://mcpemails.test';

const ME = '00000000-0000-4000-8000-0000000000c3';

function setup(flag: boolean) {
  const db = new FakeSupabase();
  db.unique('referral_codes', ['user_id']);
  db.unique('referral_codes', ['code']);
  db.seed('workspaces', [
    { id: 'ws-me', owner_id: ME, plan: 'solo', referral_enabled: flag, deleted_at: null, created_at: '2026-10-01T00:00:00.000Z' },
  ]);
  return db;
}

test('flag on: a link to /r/<code>, created once and reused', async () => {
  const db = setup(true);
  const first = await referralLinkForUser(db as unknown as Db, ME);
  assert.match(first ?? '', /^https:\/\/mcpemails\.test\/r\/[A-Z2-9]{8}$/);
  const second = await referralLinkForUser(db as unknown as Db, ME);
  assert.equal(second, first);
  assert.equal(db.table('referral_codes').length, 1);
});

test('flag off: no link and no code minted', async () => {
  const db = setup(false);
  assert.equal(await referralLinkForUser(db as unknown as Db, ME), null);
  assert.equal(db.table('referral_codes').length, 0);
});

test('a disabled code: no link', async () => {
  const db = setup(true);
  db.seed('referral_codes', [{ user_id: ME, code: 'ABCD2345', disabled_at: '2026-11-01T00:00:00.000Z' }]);
  assert.equal(await referralLinkForUser(db as unknown as Db, ME), null);
});

test('a database that throws: null, not an exception', async () => {
  const broken = { from: () => { throw new Error('boom'); } };
  assert.equal(await referralLinkForUser(broken as unknown as Db, ME), null);
});
