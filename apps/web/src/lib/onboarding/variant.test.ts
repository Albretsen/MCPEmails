import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ENROLL_WINDOW_MS,
  clientOnboardingVariant,
  getOnboardingVariant,
  onboardingPublicEnrollment,
  onboardingSubject,
  type OnboardingExperimentStore,
} from './variant.ts';
import type { ExperimentRecord } from '@/lib/experiments/constants';

const WS = '0b9c6a3e-1d2f-4a5b-8c7d-112233445566';
const NOW = Date.parse('2026-11-03T12:00:00Z');
const FRESH = new Date(NOW - 60_000).toISOString();
const OLD = new Date(NOW - ENROLL_WINDOW_MS - 60_000).toISOString();

function experiment(key: string, status: ExperimentRecord['status'], winner: string | null = null): ExperimentRecord {
  const variants = key === 'onb_flow'
    ? [{ id: 'control', label: 'c', weight: 50 }, { id: 'new', label: 'n', weight: 50 }]
    : [{ id: 'off', label: 'o', weight: 50 }, { id: 'on', label: 'o', weight: 50 }];
  return {
    key, name: key, description: null, status, variants, winner_variant_id: winner,
    retention_goal: 'any_tool_call', retention_window_days: 7,
    created_at: '', updated_at: '', started_at: null, concluded_at: null,
  };
}

function fakeStore(status: ExperimentRecord['status'], opts: { stored?: Record<string, string>; winner?: Record<string, string> } = {}) {
  const writes: Array<[string, string, string]> = [];
  const reads: string[] = [];
  const store: OnboardingExperimentStore = {
    async getExperiment(key) { return experiment(key, status, opts.winner?.[key] ?? null); },
    async assign(key, subject, variant) { writes.push([key, subject, variant]); return opts.stored?.[key] ?? variant; },
    async readAssignment(key) { reads.push(key); return opts.stored?.[key] ?? null; },
  };
  return { store, writes, reads };
}

const base = { db: {} as never, internalEmails: new Set<string>(), now: NOW };

test('the subject is the workspace uuid without dashes', () => {
  assert.equal(onboardingSubject(WS), '0b9c6a3e1d2f4a5b8c7d112233445566');
  assert.equal(onboardingSubject('not-a-uuid'), null);
  assert.equal(onboardingSubject(null), null);
});

test('v1: internal accounts get new/on and are never enrolled', async () => {
  const { store, writes } = fakeStore('running');
  for (const email of ['asgeir@mcpemails.com', 'someone+test@listed.example']) {
    const got = await getOnboardingVariant(WS, {
      ...base, store, publicEnrollment: true, ownerEmail: email, workspaceCreatedAt: FRESH,
      internalEmails: new Set(['someone@listed.example']),
    });
    assert.deepEqual(got, { flow: 'new', convert: 'on', internal: true, enrolled: false }, email);
  }
  assert.deepEqual(writes, []);
});

test('v1: everyone else is control/off and untouched while public enrollment is off', async () => {
  const { store, writes, reads } = fakeStore('running');
  const got = await getOnboardingVariant(WS, { ...base, store, publicEnrollment: false, ownerEmail: 'customer@example.com', workspaceCreatedAt: FRESH });
  assert.deepEqual(got, { flow: 'control', convert: 'off', internal: false, enrolled: false });
  assert.deepEqual(writes, []);
  assert.deepEqual(reads, []);
});

test('public on but experiment still draft: control, nothing written', async () => {
  const { store, writes } = fakeStore('draft');
  const got = await getOnboardingVariant(WS, { ...base, store, publicEnrollment: true, ownerEmail: 'customer@example.com', workspaceCreatedAt: FRESH });
  assert.deepEqual(got, { flow: 'control', convert: 'off', internal: false, enrolled: false });
  assert.deepEqual(writes, []);
});

test('public on and running: a new workspace is bucketed on both keys and stored', async () => {
  const { store, writes } = fakeStore('running');
  const got = await getOnboardingVariant(WS, { ...base, store, publicEnrollment: true, ownerEmail: 'customer@example.com', workspaceCreatedAt: FRESH });
  assert.equal(got.enrolled, true);
  assert.equal(got.internal, false);
  assert.ok(['control', 'new'].includes(got.flow));
  assert.ok(['off', 'on'].includes(got.convert));
  assert.deepEqual(writes.map(([key, subject]) => [key, subject]).sort(), [
    ['onb_convert', '0b9c6a3e1d2f4a5b8c7d112233445566'],
    ['onb_flow', '0b9c6a3e1d2f4a5b8c7d112233445566'],
  ]);
});

test('the stored arm wins over the hash', async () => {
  const { store } = fakeStore('running', { stored: { onb_flow: 'new', onb_convert: 'off' } });
  const got = await getOnboardingVariant(WS, { ...base, store, publicEnrollment: true, ownerEmail: 'customer@example.com', workspaceCreatedAt: FRESH });
  assert.deepEqual(got, { flow: 'new', convert: 'off', internal: false, enrolled: true });
});

test('an old workspace is never enrolled late, only read', async () => {
  const { store, writes, reads } = fakeStore('running');
  const got = await getOnboardingVariant(WS, { ...base, store, publicEnrollment: true, ownerEmail: 'customer@example.com', workspaceCreatedAt: OLD });
  assert.deepEqual(got, { flow: 'control', convert: 'off', internal: false, enrolled: false });
  assert.deepEqual(writes, []);
  assert.deepEqual(reads.sort(), ['onb_convert', 'onb_flow']);

  const enrolledEarlier = fakeStore('running', { stored: { onb_flow: 'new', onb_convert: 'on' } });
  const again = await getOnboardingVariant(WS, { ...base, store: enrolledEarlier.store, publicEnrollment: true, ownerEmail: 'customer@example.com', workspaceCreatedAt: OLD });
  assert.deepEqual(again, { flow: 'new', convert: 'on', internal: false, enrolled: true });
});

test('a concluded experiment serves its winner to everyone, without writing', async () => {
  const { store, writes } = fakeStore('concluded', { winner: { onb_flow: 'new', onb_convert: 'off' } });
  const got = await getOnboardingVariant(WS, { ...base, store, publicEnrollment: true, ownerEmail: 'customer@example.com', workspaceCreatedAt: OLD });
  assert.deepEqual(got, { flow: 'new', convert: 'off', internal: false, enrolled: false });
  assert.deepEqual(writes, []);
});

test('a broken store or a bad id is the control, never a throw', async () => {
  const broken: OnboardingExperimentStore = {
    async getExperiment() { throw new Error('down'); },
    async assign() { throw new Error('down'); },
    async readAssignment() { throw new Error('down'); },
  };
  const got = await getOnboardingVariant(WS, { ...base, store: broken, publicEnrollment: true, ownerEmail: 'customer@example.com', workspaceCreatedAt: FRESH });
  assert.equal(got.flow, 'control');
  assert.deepEqual(await getOnboardingVariant('nope', base), { flow: 'control', convert: 'off', internal: false, enrolled: false });
});

test('the client prop carries only the two arms', () => {
  assert.deepEqual(clientOnboardingVariant({ flow: 'new', convert: 'on', internal: true, enrolled: false } as never), { flow: 'new', convert: 'on' });
  assert.deepEqual(clientOnboardingVariant(null), { flow: 'control', convert: 'off' });
  assert.equal(onboardingPublicEnrollment({ ONBOARDING_EXPERIMENT_PUBLIC: '1' } as never), true);
  assert.equal(onboardingPublicEnrollment({} as never), false);
});
