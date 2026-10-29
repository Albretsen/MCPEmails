import test from 'node:test';
import assert from 'node:assert/strict';
import {
  armTotals,
  baseline,
  chanceBeats,
  compare,
  coverage,
  normalCdf,
  onboardingChecks,
  onboardingVerdict,
  releaseState,
  sampleRatioP,
  type OnboardingExperimentRow,
} from './onboarding-test.ts';
import type { GrowthOnboardingArmRow, GrowthOnboardingDayRow } from './growth-types.ts';

const arm = (p: Partial<GrowthOnboardingArmRow>): GrowthOnboardingArmRow => ({
  flow: 'control',
  convert: 'off',
  assigned: 0,
  first_assigned_at: null,
  mature_1d: 0,
  inbox_1d: 0,
  value_1d: 0,
  mature_3d: 0,
  draft_3d: 0,
  mature_7d: 0,
  habit_7d: 0,
  mature_30d: 0,
  paid_30d: 0,
  paid_any: 0,
  connect_ws: 0,
  connect_failed_ws: 0,
  completed: 0,
  ...p,
});

const day = (p: Partial<GrowthOnboardingDayRow>): GrowthOnboardingDayRow => ({
  day: '2026-11-03',
  created: 0,
  flow_control: 0,
  flow_new: 0,
  convert_off: 0,
  convert_on: 0,
  mature_1d: 0,
  value_1d: 0,
  ...p,
});

const exp = (key: string, status: string, extra: Partial<OnboardingExperimentRow> = {}): OnboardingExperimentRow => ({
  key,
  status,
  started_at: null,
  concluded_at: null,
  winner_variant_id: null,
  ...extra,
});

test('normalCdf is symmetric and right at the usual points', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-4);
  assert.ok(Math.abs(normalCdf(-1.96) - 0.025) < 1e-4);
});

test('chanceBeats: equal rates are a coin flip, a clear gap is near certain', () => {
  assert.ok(Math.abs(chanceBeats({ num: 50, den: 100 }, { num: 50, den: 100 })! - 0.5) < 1e-9);
  assert.ok(chanceBeats({ num: 40, den: 400 }, { num: 120, den: 400 })! > 0.999);
  assert.ok(chanceBeats({ num: 120, den: 400 }, { num: 40, den: 400 })! < 0.001);
  assert.equal(chanceBeats({ num: 0, den: 0 }, { num: 1, den: 2 }), null);
});

test('sampleRatioP: 50/50 is fine, 60/40 of 1000 is not', () => {
  assert.ok(sampleRatioP(500, 500)! > 0.999);
  assert.ok(sampleRatioP(600, 400)! < 0.001);
  assert.equal(sampleRatioP(0, 0), null);
});

test('armTotals sums one margin of the 2x2, tolerating bigint strings', () => {
  const rows = [
    arm({ flow: 'control', convert: 'off', assigned: 10 }),
    arm({ flow: 'control', convert: 'on', assigned: '5' as unknown as number }),
    arm({ flow: 'new', convert: 'on', assigned: 7 }),
  ];
  assert.equal(armTotals(rows, 'flow', 'control').assigned, 15);
  assert.equal(armTotals(rows, 'convert', 'on').assigned, 12);
});

test('compare flips the chance for lower-is-better metrics', () => {
  const rows = [
    arm({ flow: 'control', connect_ws: 200, connect_failed_ws: 60 }),
    arm({ flow: 'new', connect_ws: 200, connect_failed_ws: 20 }),
  ];
  const failed = compare(rows, 'flow').find((c) => c.metric.key === 'connect_failed')!;
  assert.ok(failed.better! > 0.99, 'fewer failures in the new flow is better');
});

test('coverage skips the partial start day and today', () => {
  const daily = [
    day({ day: '2026-11-02', created: 30, flow_control: 3, flow_new: 3 }),
    day({ day: '2026-11-03', created: 40, flow_control: 20, flow_new: 19 }),
    day({ day: '2026-11-04', created: 10, flow_control: 2, flow_new: 2 }),
  ];
  assert.deepEqual(coverage(daily, '2026-11-02T09:00:00Z', '2026-11-04'), { num: 39, den: 40 });
  assert.deepEqual(coverage(daily, null, '2026-11-04'), { num: 0, den: 0 });
});

test('baseline sums every customer workspace', () => {
  assert.deepEqual(baseline([day({ mature_1d: 10, value_1d: 6 }), day({ mature_1d: 5, value_1d: 2 })]), { num: 8, den: 15 });
});

test('releaseState: draft rows are off, running without the env var is stuck', () => {
  assert.equal(releaseState([exp('onb_flow', 'draft'), exp('onb_convert', 'draft')], false).kind, 'off');
  const stuck = releaseState([exp('onb_flow', 'running'), exp('onb_convert', 'running')], false);
  assert.equal(stuck.kind, 'stuck');
  assert.match((stuck as { detail: string }).detail, /ONBOARDING_EXPERIMENT_PUBLIC/);
  assert.equal(releaseState([exp('onb_flow', 'draft')], true).kind, 'stuck');
  const running = releaseState(
    [exp('onb_flow', 'running', { started_at: '2026-11-02T08:00:00Z' }), exp('onb_convert', 'running', { started_at: '2026-11-02T08:01:00Z' })],
    true,
  );
  assert.deepEqual(running, { kind: 'running', startedAt: '2026-11-02T08:00:00Z' });
  const done = releaseState(
    [exp('onb_flow', 'concluded', { winner_variant_id: 'new' }), exp('onb_convert', 'concluded', { winner_variant_id: 'off' })],
    true,
  );
  assert.deepEqual(done, { kind: 'concluded', winners: { flow: 'new', convert: 'off' } });
});

test('checks wait on little data, and the verdict says too early', () => {
  const rows = [arm({ flow: 'control', convert: 'off', assigned: 5, mature_1d: 5 }), arm({ flow: 'new', convert: 'on', assigned: 5, mature_1d: 5 })];
  const checks = onboardingChecks(rows, [], '2026-11-02T08:00:00Z', '2026-11-03');
  assert.ok(checks.every((c) => c.state === 'wait'));
  assert.equal(onboardingVerdict({ kind: 'running', startedAt: '2026-11-02T08:00:00Z' }, checks).headline, 'Too early');
});

test('a setup dialog that loses first calls fails the harm check', () => {
  const rows = [
    arm({ flow: 'control', convert: 'off', assigned: 300, mature_1d: 300, value_1d: 180 }),
    arm({ flow: 'new', convert: 'on', assigned: 300, mature_1d: 300, value_1d: 120 }),
  ];
  const daily = [day({ day: '2026-11-03', created: 600, flow_control: 300, flow_new: 300 })];
  const checks = onboardingChecks(rows, daily, '2026-11-02T08:00:00Z', '2026-11-10');
  assert.equal(checks.find((c) => c.key === 'harm_flow')!.state, 'fail');
  assert.equal(checks.find((c) => c.key === 'coverage')!.state, 'pass');
  const verdict = onboardingVerdict({ kind: 'running', startedAt: '2026-11-02T08:00:00Z' }, checks);
  assert.equal(verdict.level, 'down');
});

test('a balanced, healthy test runs clean', () => {
  const rows = ['control', 'new'].flatMap((flow) =>
    ['off', 'on'].map((convert) =>
      arm({ flow, convert, assigned: 100, mature_1d: 100, value_1d: 58, connect_ws: 80, connect_failed_ws: 8 }),
    ),
  );
  const daily = [day({ day: '2026-11-03', created: 400, flow_control: 200, flow_new: 200 })];
  const checks = onboardingChecks(rows, daily, '2026-11-02T08:00:00Z', '2026-11-10');
  assert.ok(checks.every((c) => c.state === 'pass'), JSON.stringify(checks));
  assert.equal(onboardingVerdict({ kind: 'running', startedAt: null }, checks).level, 'ok');
});
