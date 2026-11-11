// ---------------------------------------------------------------------------
// The "How did you hear about MCPEmails?" rules: body validation and when the
// card shows. Also pins the option ids to the CHECK in the migration.
//
// Run: npm run test:heard-about
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  HEARD_ABOUT_OPTIONS,
  HEARD_ABOUT_OTHER_MAX,
  parseHeardAboutBody,
  shouldShowHeardAbout,
} from './heard-about.mjs';

test('the option ids are exactly the ones the migration CHECK allows', () => {
  const sql = readFileSync(new URL('../../../../../supabase/migrations/20261111150000_heard_about.sql', import.meta.url), 'utf8');
  const check = sql.match(/workspaces_heard_about_check\s+CHECK \(heard_about IS NULL OR heard_about IN \(([^)]*)\)/);
  assert.ok(check, 'CHECK found');
  const ids = [...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...ids].sort(), [...HEARD_ABOUT_OPTIONS].sort());
  assert.equal(sql.includes(`char_length(heard_about_other) <= ${HEARD_ABOUT_OTHER_MAX}`), true);
});

test('parse: one option id is an answer', () => {
  assert.deepEqual(parseHeardAboutBody({ answer: 'chatgpt' }), { ok: true, kind: 'answer', answer: 'chatgpt', other: null });
  assert.deepEqual(parseHeardAboutBody({ answer: 'colleague', other: 'ignored' }), { ok: true, kind: 'answer', answer: 'colleague', other: null });
});

test('parse: dismiss', () => {
  assert.deepEqual(parseHeardAboutBody({ dismiss: true }), { ok: true, kind: 'dismiss' });
  assert.equal(parseHeardAboutBody({ dismiss: true, answer: 'claude' }).ok, false);
  assert.equal(parseHeardAboutBody({ dismiss: 'yes' }).ok, false);
});

test('parse: other keeps trimmed text up to the limit, refuses longer', () => {
  assert.deepEqual(parseHeardAboutBody({ answer: 'other', other: '  a   podcast ' }), { ok: true, kind: 'answer', answer: 'other', other: 'a podcast' });
  assert.deepEqual(parseHeardAboutBody({ answer: 'other' }), { ok: true, kind: 'answer', answer: 'other', other: null });
  assert.deepEqual(parseHeardAboutBody({ answer: 'other', other: '   ' }), { ok: true, kind: 'answer', answer: 'other', other: null });
  assert.equal(parseHeardAboutBody({ answer: 'other', other: 'x'.repeat(HEARD_ABOUT_OTHER_MAX) }).ok, true);
  assert.equal(parseHeardAboutBody({ answer: 'other', other: 'x'.repeat(HEARD_ABOUT_OTHER_MAX + 1) }).error, 'other_too_long');
  assert.equal(parseHeardAboutBody({ answer: 'other', other: 42 }).error, 'invalid_other');
});

test('parse: anything else is refused', () => {
  for (const body of [null, undefined, 'chatgpt', [], {}, { answer: 'tiktok' }, { answer: 'CHATGPT' }, { answer: 'dismissed' }]) {
    assert.equal(parseHeardAboutBody(body).ok, false, JSON.stringify(body));
  }
});

test('show: owner, pending, at least one inbox, not closed', () => {
  const base = { pending: true, inboxCount: 1, isOwner: true, closed: false };
  assert.equal(shouldShowHeardAbout(base), true);
  assert.equal(shouldShowHeardAbout({ ...base, pending: false }), false, 'answered or dismissed before, or unreadable');
  assert.equal(shouldShowHeardAbout({ ...base, inboxCount: 0 }), false, 'waits for the first inbox');
  assert.equal(shouldShowHeardAbout({ ...base, isOwner: false }), false, 'members are not asked');
  assert.equal(shouldShowHeardAbout({ ...base, closed: true }), false, 'gone after one click');
  assert.equal(shouldShowHeardAbout(), false);
});
