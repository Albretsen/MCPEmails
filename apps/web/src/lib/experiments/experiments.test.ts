// ---------------------------------------------------------------------------
// The experiments library, tested without a database.
//
// Three things here can be wrong in ways that quietly ruin a result rather
// than break a page, which is why they get tests instead of a smoke check:
//
//   1. Bucketing. If the split is not even, or not stable per subject, every
//      number the admin panel shows afterwards is measuring the hash instead
//      of the change.
//   2. Precedence. Concluding an experiment has to override existing
//      assignments (that is how you ship a winner), and an owner previewing a
//      variant must never be recorded as a participant.
//   3. Stickiness. Once a subject is assigned, the STORED variant wins forever,
//      even after the weights move. Otherwise changing a split mid-flight
//      silently reshuffles people who were already counted.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/experiments/experiments.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import { hashUnit, isValidSubjectId, pickVariant, validateVariants } from './bucketing.ts';
import { generateSubjectId, parseOverrideCookie, serializeOverrideCookie } from './cookies.ts';
import { resolveVariant, type ExperimentStore } from './resolve.ts';
import { getExperimentDecision, getExperimentVariant } from './index.ts';
import type { ExperimentRecord, ExperimentVariant } from './constants.ts';

function variants(...entries: [string, number][]): ExperimentVariant[] {
  return entries.map(([id, weight]) => ({ id, label: id, weight }));
}

function experiment(patch: Partial<ExperimentRecord> = {}): ExperimentRecord {
  return {
    key: 'homepage_demo_video',
    name: 'Homepage demo video',
    description: null,
    status: 'running',
    variants: variants(['control', 50], ['video', 50]),
    winner_variant_id: null,
    retention_goal: 'mailbox_activity',
    retention_window_days: 7,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    started_at: null,
    concluded_at: null,
    ...patch,
  };
}

/**
 * A store with a real in-memory assignments table, so "sticky" means the same
 * thing here as it does in Postgres: the first write wins and every later call
 * gets the stored value back, whatever it proposes.
 */
function fakeStore(records: Record<string, ExperimentRecord | null>) {
  const assignments = new Map<string, string>();
  const calls: { key: string; subjectId: string; variantId: string }[] = [];
  const store: ExperimentStore = {
    async getExperiment(key: string) {
      return records[key] ?? null;
    },
    async assign(key: string, subjectId: string, variantId: string) {
      calls.push({ key, subjectId, variantId });
      const id = `${key}:${subjectId}`;
      const stored = assignments.get(id);
      if (stored) return stored;
      assignments.set(id, variantId);
      return variantId;
    },
  };
  return { store, calls, assignments };
}

/** 20,000 distinct, realistic subject ids. Not random, so a failure repeats. */
function subjectIds(count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(i.toString(16).padStart(8, '0').repeat(4).slice(0, 32));
  }
  return out;
}

test('hashUnit is deterministic, in range, and differs per experiment key', () => {
  const subject = 'a'.repeat(32);
  const first = hashUnit(subject, 'homepage_demo_video');
  assert.equal(first, hashUnit(subject, 'homepage_demo_video'));
  assert.ok(first >= 0 && first < 1, `expected [0,1), got ${first}`);

  // The same person must not be in the treatment arm of every experiment.
  assert.notEqual(first, hashUnit(subject, 'pricing_headline'));

  for (const id of subjectIds(500)) {
    const unit = hashUnit(id, 'homepage_demo_video');
    assert.ok(unit >= 0 && unit < 1, `unit out of range for ${id}: ${unit}`);
  }
});

test('a 50/50 split lands within 2 points of even over 20,000 subjects', () => {
  const split = variants(['control', 50], ['video', 50]);
  let video = 0;
  const ids = subjectIds(20_000);
  for (const id of ids) {
    if (pickVariant(split, hashUnit(id, 'homepage_demo_video')) === 'video') video += 1;
  }
  const share = (video / ids.length) * 100;
  assert.ok(Math.abs(share - 50) <= 2, `video share was ${share.toFixed(2)}%, expected 50% +/- 2`);
});

test('a 90/10 split lands within 2 points of its weights', () => {
  const split = variants(['control', 90], ['video', 10]);
  let video = 0;
  const ids = subjectIds(20_000);
  for (const id of ids) {
    if (pickVariant(split, hashUnit(id, 'homepage_demo_video')) === 'video') video += 1;
  }
  const share = (video / ids.length) * 100;
  assert.ok(Math.abs(share - 10) <= 2, `video share was ${share.toFixed(2)}%, expected 10% +/- 2`);
});

test('a zero-weight variant is never picked, at either end of the range', () => {
  const split = variants(['control', 100], ['video', 0]);
  for (const id of subjectIds(5_000)) {
    assert.equal(pickVariant(split, hashUnit(id, 'homepage_demo_video')), 'control');
  }
  // The exact boundaries, where rounding would otherwise walk off the end.
  assert.equal(pickVariant(split, 0), 'control');
  assert.equal(pickVariant(split, 0.999999999), 'control');
  assert.equal(pickVariant(split, 1), 'control');

  // A zero-weight FIRST variant is skipped too, not silently used as control.
  assert.equal(pickVariant(variants(['control', 0], ['video', 100]), 0), 'video');
});

test('validateVariants enforces the same rules as the database CHECK', () => {
  assert.equal(validateVariants(variants(['control', 50], ['video', 50])), null);
  assert.equal(validateVariants(variants(['control', 100], ['video', 0])), null);

  assert.match(String(validateVariants(variants(['control', 50], ['video', 40]))), /add up to 100/);
  assert.match(String(validateVariants(variants(['control', 50], ['control', 50]))), /used twice/);
  assert.match(String(validateVariants(variants(['Control', 50], ['video', 50]))), /lowercase/);
  assert.match(String(validateVariants(variants(['control', 50.5], ['video', 49.5]))), /whole-number/);
  assert.match(String(validateVariants([])), /at least one variant/);
  assert.match(String(validateVariants('control')), /must be a list/);
  assert.match(
    String(validateVariants([{ id: 'control', label: '', weight: 100 }])),
    /needs a label/,
  );
});

test('isValidSubjectId accepts only 32 lowercase hex characters', () => {
  assert.equal(isValidSubjectId(generateSubjectId()), true);
  assert.equal(isValidSubjectId('a'.repeat(32)), true);
  assert.equal(isValidSubjectId('A'.repeat(32)), false);
  assert.equal(isValidSubjectId('a'.repeat(31)), false);
  assert.equal(isValidSubjectId('a'.repeat(33)), false);
  assert.equal(isValidSubjectId(null), false);
  assert.equal(isValidSubjectId(12345), false);
});

test('generateSubjectId returns fresh, well-formed ids', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1_000; i += 1) seen.add(generateSubjectId());
  assert.equal(seen.size, 1_000, 'generateSubjectId produced a collision in 1,000 draws');
  for (const id of seen) assert.match(id, /^[a-f0-9]{32}$/);
});

test('an unknown experiment returns the fallback and records nothing', async () => {
  const { store, calls } = fakeStore({});
  const decision = await resolveVariant({
    experiment: null,
    subjectId: 'a'.repeat(32),
    assign: store.assign,
  });
  assert.deepEqual(decision, { variantId: 'control', reason: 'unknown' });
  assert.equal(calls.length, 0);

  const custom = await resolveVariant({
    experiment: null,
    subjectId: 'a'.repeat(32),
    fallback: 'video',
    assign: store.assign,
  });
  assert.equal(custom.variantId, 'video');
});

test('a concluded winner beats an existing assignment', async () => {
  const { store, calls } = fakeStore({});
  const subject = 'b'.repeat(32);
  // Bucket the subject first, so there is a stored assignment to override.
  await store.assign('homepage_demo_video', subject, 'control');

  const decision = await resolveVariant({
    experiment: experiment({ status: 'concluded', winner_variant_id: 'video' }),
    subjectId: subject,
    assign: store.assign,
  });
  assert.deepEqual(decision, { variantId: 'video', reason: 'winner' });
  assert.equal(calls.length, 1, 'concluding must not write a new assignment');
});

test('an override beats bucketing and is never recorded', async () => {
  const { store, calls } = fakeStore({});
  const decision = await resolveVariant({
    experiment: experiment(),
    subjectId: 'c'.repeat(32),
    overrides: { homepage_demo_video: 'video' },
    assign: store.assign,
  });
  assert.deepEqual(decision, { variantId: 'video', reason: 'override' });
  assert.equal(calls.length, 0, 'previewing a variant must not count as an exposure');
});

test('an override naming a variant that does not exist is ignored', async () => {
  const { store } = fakeStore({});
  const decision = await resolveVariant({
    experiment: experiment(),
    subjectId: 'c'.repeat(32),
    overrides: { homepage_demo_video: 'nonsense' },
    assign: store.assign,
  });
  assert.equal(decision.reason, 'assigned');
});

test('a draft shows the control to everyone and records nothing', async () => {
  const { store, calls } = fakeStore({});
  const decision = await resolveVariant({
    experiment: experiment({ status: 'draft' }),
    subjectId: 'd'.repeat(32),
    assign: store.assign,
  });
  assert.deepEqual(decision, { variantId: 'control', reason: 'draft' });
  assert.equal(calls.length, 0);
});

test('a running experiment with no subject shows the control and records nothing', async () => {
  const { store, calls } = fakeStore({});
  const decision = await resolveVariant({
    experiment: experiment(),
    subjectId: null,
    assign: store.assign,
  });
  assert.deepEqual(decision, { variantId: 'control', reason: 'draft' });
  assert.equal(calls.length, 0);
});

test('the first assignment sticks, even after the weights change', async () => {
  const { store, calls } = fakeStore({});
  // Find a subject the 50/50 split sends to video, then flip the weights so
  // the hash would now send it to control.
  const subject = subjectIds(200).find(
    (id) => pickVariant(variants(['control', 50], ['video', 50]), hashUnit(id, 'homepage_demo_video')) === 'video',
  );
  assert.ok(subject, 'expected at least one subject in the video arm');

  const first = await resolveVariant({ experiment: experiment(), subjectId: subject, assign: store.assign });
  assert.deepEqual(first, { variantId: 'video', reason: 'assigned' });

  const reweighted = experiment({ variants: variants(['control', 100], ['video', 0]) });
  assert.equal(
    pickVariant(reweighted.variants, hashUnit(subject!, 'homepage_demo_video')),
    'control',
    'the new weights should hash this subject to control',
  );

  const second = await resolveVariant({ experiment: reweighted, subjectId: subject, assign: store.assign });
  assert.deepEqual(second, { variantId: 'video', reason: 'assigned' }, 'the stored variant must win');
  assert.equal(calls.length, 2, 'both calls go to the store; the store is what dedupes');
});

test('a failing assign serves the hashed variant instead of breaking the page', async () => {
  const decision = await resolveVariant({
    experiment: experiment(),
    subjectId: 'e'.repeat(32),
    assign: async () => {
      throw new Error('connection reset');
    },
  });
  assert.equal(decision.reason, 'assigned');
  assert.ok(['control', 'video'].includes(decision.variantId));
});

test('the public API works for two unrelated experiments, one of them three-armed', async () => {
  const pricing = experiment({
    key: 'pricing_headline',
    name: 'Pricing headline',
    variants: variants(['control', 34], ['plain', 33], ['blunt', 33]),
  });
  const { store, assignments } = fakeStore({
    homepage_demo_video: experiment(),
    pricing_headline: pricing,
  });
  const subject = 'f'.repeat(32);

  const homepage = await getExperimentVariant('homepage_demo_video', subject, { store });
  assert.ok(['control', 'video'].includes(homepage));

  const headline = await getExperimentDecision('pricing_headline', subject, { store });
  assert.equal(headline.reason, 'assigned');
  assert.ok(['control', 'plain', 'blunt'].includes(headline.variantId));

  assert.equal(assignments.size, 2, 'each experiment gets its own assignment row');
  assert.equal(assignments.get(`homepage_demo_video:${subject}`), homepage);
  assert.equal(assignments.get(`pricing_headline:${subject}`), headline.variantId);

  // A key with no row falls back rather than throwing.
  const missing = await getExperimentDecision('no_such_experiment', subject, { store, fallback: 'control' });
  assert.deepEqual(missing, { variantId: 'control', reason: 'unknown' });

  // Overrides are per key: pinning one experiment leaves the other alone.
  const pinned = await getExperimentDecision('pricing_headline', subject, {
    store,
    overrides: { pricing_headline: 'blunt' },
  });
  assert.deepEqual(pinned, { variantId: 'blunt', reason: 'override' });
});

test('parseOverrideCookie tolerates garbage and drops illegal variant ids', () => {
  assert.deepEqual(parseOverrideCookie(undefined), {});
  assert.deepEqual(parseOverrideCookie(''), {});
  assert.deepEqual(parseOverrideCookie('not json at all'), {});
  assert.deepEqual(parseOverrideCookie('[1,2,3]'), {});
  assert.deepEqual(parseOverrideCookie('null'), {});
  assert.deepEqual(parseOverrideCookie('"a string"'), {});
  assert.deepEqual(parseOverrideCookie('{"homepage_demo_video":123}'), {});
  assert.deepEqual(parseOverrideCookie('{"homepage_demo_video":"NOT-A-VARIANT"}'), {});
  assert.deepEqual(parseOverrideCookie('{"a":"' + 'x'.repeat(33) + '"}'), {});
  assert.deepEqual(parseOverrideCookie('{"homepage_demo_video":"video","bad":"UP"}'), {
    homepage_demo_video: 'video',
  });
  // Percent-encoded, which is how a cookie value usually arrives.
  assert.deepEqual(parseOverrideCookie(encodeURIComponent('{"homepage_demo_video":"video"}')), {
    homepage_demo_video: 'video',
  });
});

test('serializeOverrideCookie round-trips and refuses illegal values', () => {
  const map = { homepage_demo_video: 'video', pricing_headline: 'blunt' };
  assert.deepEqual(parseOverrideCookie(serializeOverrideCookie(map)), map);
  assert.equal(serializeOverrideCookie({}), '{}');
  assert.equal(serializeOverrideCookie({ homepage_demo_video: 'NOPE' }), '{}');
});
