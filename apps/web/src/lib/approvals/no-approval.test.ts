import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalJson,
  formCoverage,
  isExactAddress,
  noApprovalWriteError,
  parseExactAddresses,
  validateNoApprovalInput,
} from './no-approval.ts';

const ok = {
  name: 'Books',
  recipients: ['a@example.com'],
  scope: 'all_automations',
  daily_limit: 25,
  time_zone: 'Europe/Oslo',
  enabled: true,
};

test('an exact address and nothing else', () => {
  assert.equal(isExactAddress('a.b+c@example.com'), true);
  for (const bad of ['*@example.com', 'a@*.example.com', 'example.com', '@example.com', 'a@b', 'A b <a@example.com>', '%@example.com', 'a@example.com,b@example.com']) {
    assert.equal(isExactAddress(bad), false, bad);
  }
});

test('addresses are parsed, lowercased and deduplicated, and the bad ones named', () => {
  assert.deepEqual(parseExactAddresses('A@example.com, a@example.com\nb@example.com; *@x.example'), {
    addresses: ['a@example.com', 'b@example.com'],
    invalid: ['*@x.example'],
  });
});

test('the input check refuses what the database would', () => {
  const code = (change: object) => {
    const result = validateNoApprovalInput({ ...ok, ...change });
    return result.ok ? 'ok' : result.code;
  };
  assert.equal(code({}), 'ok');
  assert.equal(code({ name: ' ' }), 'invalid_name');
  assert.equal(code({ recipients: [] }), 'invalid_recipients');
  assert.equal(code({ recipients: ['*@example.com'] }), 'invalid_recipients');
  assert.equal(code({ recipients: ['example.com'] }), 'invalid_recipients');
  assert.equal(code({ recipients: Array.from({ length: 21 }, (_, i) => `a${i}@example.com`) }), 'invalid_recipients');
  assert.equal(code({ scope: 'any' }), 'invalid_scope');
  assert.equal(code({ scope: 'chosen_automations' }), 'invalid_automation');
  assert.equal(code({ scope: 'chosen_automations', automation_ids: [] }), 'automations_required');
  assert.equal(code({ daily_limit: 101 }), 'invalid_limit');
  assert.equal(code({ daily_limit: 0 }), 'invalid_limit');
  assert.equal(code({ inbox_ids: [] }), 'invalid_inbox');
});

test('defaults: limit 25, verified senders on, off unless asked', () => {
  const result = validateNoApprovalInput({ name: 'x', recipients: ['a@example.com'], scope: 'all_automations' });
  assert.ok(result.ok);
  assert.equal(result.value.daily_limit, 25);
  assert.equal(result.value.verified_senders_only, true);
  assert.equal(result.value.enabled, false);
  assert.equal(result.value.inbox_ids, null);
});

test('a refusal from the database keeps its meaning', () => {
  assert.deepEqual(noApprovalWriteError({ code: '42501', message: 'no_approval_forbidden' }), { status: 403, code: 'forbidden' });
  assert.deepEqual(noApprovalWriteError({ code: '22023', message: 'no_approval_invalid_limit' }), { status: 400, code: 'invalid_limit' });
  assert.deepEqual(noApprovalWriteError({ code: 'XX000', message: 'boom' }), { status: 500, code: 'save_failed' });
});

test('canonicalJson ignores key order', () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] }), canonicalJson({ a: [{ c: 2, d: 1 }], b: 1 }));
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 2 }));
});

const rule = (over: object = {}) => ({
  id: 'r1',
  recipients: ['a@example.com'],
  scope: 'all_automations' as const,
  inbox_ids: null,
  enabled: true,
  paused_at: null,
  automations: [],
  ...over,
});

test('the form says covered only when every address is', () => {
  const base = { ruleId: null, inboxId: 'i1', changed: true };
  const overview = { rules: [rule()] };
  assert.equal(formCoverage({ ...base, overview, to: ['A@example.com'] }), 'covered');
  assert.equal(formCoverage({ ...base, overview, to: ['a@example.com', 'b@example.com'] }), 'waits');
  assert.equal(formCoverage({ ...base, overview: { rules: [rule({ enabled: false })] }, to: ['a@example.com'] }), 'waits');
  assert.equal(formCoverage({ ...base, overview: { rules: [rule({ paused_at: 'x' })] }, to: ['a@example.com'] }), 'waits');
  assert.equal(formCoverage({ ...base, overview: { rules: [rule({ inbox_ids: ['other'] })] }, to: ['a@example.com'] }), 'waits');
  assert.equal(formCoverage({ ...base, overview: { paused_all: true, rules: [rule()] }, to: ['a@example.com'] }), 'waits');
});

test('a chosen automation: covered as saved, voids on a change, and a duplicate gets none', () => {
  const overview = { rules: [rule({ scope: 'chosen_automations', automations: [{ id: 'auto', voided: false }] })] };
  const base = { overview, inboxId: 'i1', to: ['a@example.com'] };
  assert.equal(formCoverage({ ...base, ruleId: 'auto', changed: false }), 'covered');
  assert.equal(formCoverage({ ...base, ruleId: 'auto', changed: true }), 'voids_on_save');
  // A duplicate is a new rule: it has no id, so chosen coverage can not reach it.
  assert.equal(formCoverage({ ...base, ruleId: null, changed: true }), 'waits');
  const voided = { rules: [rule({ scope: 'chosen_automations', automations: [{ id: 'auto', voided: true }] })] };
  assert.equal(formCoverage({ ...base, overview: voided, ruleId: 'auto', changed: false }), 'waits');
});
