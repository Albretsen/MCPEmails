import test from 'node:test';
import assert from 'node:assert/strict';
import { rates, releaseChecks, releaseVerdict, totals, CARD_FAMILIES } from './draft-card.ts';
import type { GrowthDraftCardStatsRow } from './growth-types.ts';

const row = (p: Partial<GrowthDraftCardStatsRow>): GrowthDraftCardStatsRow => ({
  period: 'after',
  family: 'claude',
  drafted: 0,
  drafted_card: 0,
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
  lines: 0,
  w_lines: 0,
  w_touched: 0,
  w_deleted: 0,
  mature_lines: 0,
  w_mature: 0,
  w_sent_day: 0,
  w_calls: 0,
  w_errors: 0,
  eligible_card: 0,
  returned_card: 0,
  eligible_plain: 0,
  returned_plain: 0,
  lines_listed: 0,
  w_lines_listed: 0,
  w_touched_listed: 0,
  mature_listed: 0,
  w_mature_listed: 0,
  w_sent_day_listed: 0,
  ...p,
});

/** `n` new drafts, all a day old, `sent` of them sent within a day; weights equal raw. */
const per = (n: number, sent: number, extra: Partial<GrowthDraftCardStatsRow> = {}) => ({
  drafted: n,
  lines: n,
  w_lines: n,
  lines_listed: n,
  w_lines_listed: n,
  mature_lines: n,
  w_mature: n,
  w_sent_day: sent,
  mature_listed: n,
  w_mature_listed: n,
  w_sent_day_listed: sent,
  ...extra,
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
  const checks = releaseChecks([row({ period: 'before', ...per(50, 25) })], reach, false);
  assert.ok(checks.every((c) => c.state === 'wait'));
  assert.equal(releaseVerdict(checks, false).headline, 'Not released');
});

test('too few card drafts: too early', () => {
  const rows = [row({ ...per(20, 10), w_touched: 10, w_touched_listed: 10 })];
  assert.equal(releaseVerdict(releaseChecks(rows, reach, true), true).headline, 'Too early');
});

test('enough drafts but none a day old yet: the send check waits', () => {
  const rows = [
    row({ period: 'before', ...per(200, 100) }),
    row({ ...per(200, 0), mature_lines: 0, w_mature: 0, mature_listed: 0, w_mature_listed: 0, w_touched: 60, w_touched_listed: 60 }),
  ];
  const checks = releaseChecks(rows, reach, true);
  assert.equal(checks.find((c) => c.key === 'harm')?.state, 'wait');
  assert.equal(checks.find((c) => c.key === 'used')?.state, 'pass');
});

test('the rates use the workspace-weighted counts, not the raw ones', () => {
  // One workspace made 700 drafts and sent none; weighted down to 20.
  const t = totals([row({ family: 'other', drafted: 720, lines: 720, w_lines: 40, mature_lines: 720, w_mature: 40, w_sent_day: 20 })], 'after', ['other']);
  assert.equal(rates(t).sent, 0.5);
  assert.equal(t.drafted, 720);
});

test('healthy release: keep it', () => {
  const rows = [
    row({ period: 'before', ...per(200, 100), w_calls: 1000, w_errors: 20 }),
    row({ ...per(200, 100), drafted_card: 200, w_touched: 60, w_touched_listed: 60, sent_card: 40, sent_agent: 60, w_calls: 1000, w_errors: 25 }),
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
    row({ period: 'before', ...per(200, 100) }),
    row({ ...per(200, 60), w_touched: 60, w_touched_listed: 60 }),
    row({ period: 'before', family: 'other', ...per(100, 50) }),
    row({ family: 'other', ...per(100, 50) }),
  ];
  const checks = releaseChecks(rows, reach, true);
  assert.equal(checks.find((c) => c.key === 'harm')?.state, 'fail');
  assert.equal(releaseVerdict(checks, true).level, 'down');
});

test('send rate falls everywhere alike: harm passes (net of other clients)', () => {
  const rows = [
    row({ period: 'before', ...per(200, 100) }),
    row({ ...per(200, 60), w_touched: 60, w_touched_listed: 60 }),
    row({ period: 'before', family: 'other', ...per(100, 50) }),
    row({ family: 'other', ...per(100, 30) }),
  ];
  assert.equal(releaseChecks(rows, reach, true).find((c) => c.key === 'harm')?.state, 'pass');
});

test('many workspaces hide it: rejected fails, verdict degraded', () => {
  const rows = [
    row({ period: 'before', ...per(200, 100) }),
    row({ ...per(200, 100), w_touched: 60, w_touched_listed: 60 }),
  ];
  const checks = releaseChecks(rows, { ...reach, hidden_workspaces: 10 }, true);
  assert.equal(checks.find((c) => c.key === 'rejected')?.state, 'fail');
  assert.equal(releaseVerdict(checks, true).level, 'degraded');
});

test('too few other-client drafts: harm is judged on the card clients alone', () => {
  const rows = [
    row({ period: 'before', ...per(200, 100) }),
    row({ ...per(200, 95), w_touched: 60, w_touched_listed: 60 }),
    row({ period: 'before', family: 'other', ...per(100, 50) }),
    // Five day-old drafts, all sent: +100% if it were netted out, which
    // would fail the card's 5% drop.
    row({ family: 'other', ...per(5, 5) }),
  ];
  const harm = releaseChecks(rows, reach, true).find((c) => c.key === 'harm');
  assert.equal(harm?.state, 'pass');
  assert.match(harm?.detail ?? '', /other clients too few to compare \(5 of 30/);
});

test('used the card counts only drafts where the card could show', () => {
  const rows = [
    row({ period: 'before', ...per(200, 100) }),
    // Claude.ai: every draft from a connection that carried the card.
    row({ ...per(150, 75), w_touched: 30, w_touched_listed: 30 }),
    // ChatGPT on a tool list from before the release: no card drawn.
    row({ family: 'chatgpt', ...per(300, 150), lines_listed: 0, w_lines_listed: 0 }),
  ];
  const used = releaseChecks(rows, reach, true).find((c) => c.key === 'used');
  // 30 of 150, not 30 of 450.
  assert.equal(rates(totals(rows, 'after', CARD_FAMILIES)).touched, 0.2);
  assert.equal(used?.state, 'pass');
  assert.match(used?.detail ?? '', /of 150 drafts where the card could show \(450 in all\)/);
});

test('used the card waits until enough drafts could show it', () => {
  const rows = [row({ ...per(300, 150), lines_listed: 40, w_lines_listed: 40, w_touched_listed: 20 })];
  assert.equal(releaseChecks(rows, reach, true).find((c) => c.key === 'used')?.state, 'wait');
});

test('send check: after the release only drafts where the card could show count', () => {
  const rows = [
    row({ period: 'before', ...per(200, 60) }),
    // Card clients sent 30%: 60 of 200.
    row({ ...per(200, 60), w_touched: 40, w_touched_listed: 40 }),
    // An old ChatGPT connection: 300 day-old drafts, none sent, no card drawn.
    row({ family: 'chatgpt', ...per(300, 0), lines_listed: 0, w_lines_listed: 0, mature_listed: 0, w_mature_listed: 0, w_sent_day_listed: 0 }),
  ];
  const harm = releaseChecks(rows, reach, true).find((c) => c.key === 'harm');
  assert.equal(harm?.state, 'pass');
  assert.match(harm?.detail ?? '', /30\.0% after \(200 drafts a day old where the card could show, 500 in all\)/);
});

test('send check waits until enough day-old drafts could show the card', () => {
  const rows = [
    row({ period: 'before', ...per(200, 60) }),
    row({ ...per(300, 0), mature_listed: 50, w_mature_listed: 50, w_sent_day_listed: 15 }),
  ];
  assert.equal(releaseChecks(rows, reach, true).find((c) => c.key === 'harm')?.state, 'wait');
});
