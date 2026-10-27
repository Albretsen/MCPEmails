import test from 'node:test';
import assert from 'node:assert/strict';
import { rates, releaseChecks, releaseVerdict, totals, CARD_FAMILIES } from './draft-card.ts';
import type { GrowthDraftCardStatsRow } from './growth-types.ts';

const row = (p: Partial<GrowthDraftCardStatsRow>): GrowthDraftCardStatsRow => ({
  period: 'after',
  family: 'claude',
  drafted: 0,
  drafted_card: 0,
  card_lines: 0,
  saved: 0,
  sent_card: 0,
  sent_agent: 0,
  deleted_card: 0,
  deleted_agent: 0,
  hidden: 0,
  workspaces: 0,
  card_workspaces: 0,
  calls: 0,
  errors: 0,
  eligible_card: 0,
  returned_card: 0,
  eligible_plain: 0,
  returned_plain: 0,
  ...p,
});

const reach = { workspaces: 100, enabled: 100, hidden_workspaces: 1, hidden_inboxes: 0, enabled_inboxes: 150 };

test('totals sums only the period and families asked for, numeric strings included', () => {
  const rows = [
    row({ family: 'claude', drafted: 10 }),
    row({ family: 'chatgpt', drafted: '5' as unknown as number }),
    row({ family: 'other', drafted: 99 }),
    row({ period: 'before', family: 'claude', drafted: 7 }),
  ];
  assert.equal(totals(rows, 'after', CARD_FAMILIES).drafted, 15);
  assert.equal(totals(rows, 'before', CARD_FAMILIES).drafted, 7);
});

test('rates are null on an empty denominator', () => {
  const r = rates(totals([], 'after', CARD_FAMILIES));
  assert.equal(r.touched, null);
  assert.equal(r.sent, null);
});

test('not released: verdict says so, checks wait', () => {
  const checks = releaseChecks([row({ period: 'before', drafted: 50, sent_agent: 25 })], reach, false);
  assert.ok(checks.every((c) => c.state === 'wait'));
  assert.equal(releaseVerdict(checks, false).headline, 'Not released');
});

test('too few card drafts: too early', () => {
  const rows = [row({ drafted: 20, drafted_card: 20, card_lines: 10 })];
  assert.equal(releaseVerdict(releaseChecks(rows, reach, true), true).headline, 'Too early');
});

test('healthy release: keep it', () => {
  const rows = [
    row({ period: 'before', drafted: 200, sent_agent: 100, calls: 1000, errors: 20 }),
    row({ drafted: 200, drafted_card: 200, card_lines: 60, sent_card: 40, sent_agent: 60, calls: 1000, errors: 25 }),
  ];
  const checks = releaseChecks(rows, reach, true);
  assert.deepEqual(
    checks.map((c) => c.state),
    ['pass', 'pass', 'pass', 'pass', 'wait'],
  );
  assert.equal(releaseVerdict(checks, true).headline, 'Keep it');
});

test('send rate falls, other clients flat: harm fails, verdict down', () => {
  const rows = [
    row({ period: 'before', drafted: 200, sent_agent: 100 }),
    row({ drafted: 200, drafted_card: 200, card_lines: 60, sent_agent: 60 }),
    row({ period: 'before', family: 'other', drafted: 100, sent_agent: 50 }),
    row({ family: 'other', drafted: 100, sent_agent: 50 }),
  ];
  const checks = releaseChecks(rows, reach, true);
  assert.equal(checks.find((c) => c.key === 'harm')?.state, 'fail');
  assert.equal(releaseVerdict(checks, true).level, 'down');
});

test('send rate falls everywhere alike: harm passes (net of other clients)', () => {
  const rows = [
    row({ period: 'before', drafted: 200, sent_agent: 100 }),
    row({ drafted: 200, drafted_card: 200, card_lines: 60, sent_agent: 60 }),
    row({ period: 'before', family: 'other', drafted: 100, sent_agent: 50 }),
    row({ family: 'other', drafted: 100, sent_agent: 30 }),
  ];
  assert.equal(releaseChecks(rows, reach, true).find((c) => c.key === 'harm')?.state, 'pass');
});

test('many workspaces hide it: rejected fails, verdict degraded', () => {
  const rows = [
    row({ period: 'before', drafted: 200, sent_agent: 100 }),
    row({ drafted: 200, drafted_card: 200, card_lines: 60, sent_agent: 100 }),
  ];
  const checks = releaseChecks(rows, { ...reach, hidden_workspaces: 10 }, true);
  assert.equal(checks.find((c) => c.key === 'rejected')?.state, 'fail');
  assert.equal(releaseVerdict(checks, true).level, 'degraded');
});
