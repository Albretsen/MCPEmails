import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS } from './providers.mjs';
import {
  RELEASE_WAVES, isReleased, isHeld, releasedProviders, relatedProviders,
  releasedProviderParams, releaseStatus,
} from './release.mjs';

/** Waves parked with no date, and the providers sitting in them. */
const heldWaves = Object.keys(RELEASE_WAVES).filter((w) => isHeld(w)).map(Number);
const heldProviders = PROVIDERS.filter((p) => heldWaves.includes(p.wave));

const before = new Date('2026-08-30T00:00:00.000Z');
const wave1 = new Date('2026-09-01T00:00:00.000Z');
const wave3 = new Date('2026-09-15T00:00:00.000Z');
const after = new Date('2026-12-01T00:00:00.000Z');

test('every provider is assigned a wave the schedule knows about', () => {
  // A wave may legitimately have no date (it is held for review). A wave the
  // schedule has never heard of is a data error, and would leave the page
  // permanently unreachable with nothing saying so.
  for (const p of PROVIDERS) {
    assert.ok(p.wave, `${p.slug} has no wave`);
    assert.ok(Object.hasOwn(RELEASE_WAVES, p.wave), `${p.slug} wave ${p.wave} is not in the schedule`);
  }
});

test('a held wave never becomes public by the passage of time', () => {
  // The hold exists because someone has to read those pages first. A date-based
  // gate would quietly publish them on a deadline instead.
  assert.ok(heldProviders.length > 0, 'expected at least one held provider');
  for (const p of heldProviders) {
    assert.equal(isReleased(p, after), false, `${p.slug} released itself`);
  }
  const params = releasedProviderParams(after);
  const held = new Set(heldProviders.map((p) => p.slug));
  assert.ok(!params.some(({ provider }) => held.has(provider)), 'a held provider got a route');
});

test('the six providers already in production are in wave 1', () => {
  // Anything else would take a live page down, which is a regression, not a
  // rollout.
  for (const slug of ['gmail', 'fastmail', 'icloud', 'yahoo', 'zoho', 'yandex']) {
    assert.equal(PROVIDERS.find((p) => p.slug === slug).wave, 1, slug);
  }
});

test('waves open in order, and everything not held is public at the end', () => {
  assert.equal(releasedProviders(before).length, 0);
  const w1 = releasedProviders(wave1).length;
  const w3 = releasedProviders(wave3).length;
  assert.ok(w1 > 0 && w3 > w1, `expected growth, got ${w1} then ${w3}`);
  assert.equal(releasedProviders(after).length, PROVIDERS.length - heldProviders.length);
});

test('siblings never link into an unreleased wave', () => {
  for (const p of releasedProviders(wave3)) {
    for (const rel of relatedProviders(p.slug, 6, wave3)) {
      assert.ok(isReleased(rel, wave3), `${p.slug} links unreleased ${rel.slug}`);
    }
  }
});

test('no released page is left without sibling links', () => {
  // `generic` has one member, so /connect/imap used to render no links at all,
  // on the highest-priority page in the set. A short silo has to degrade into a
  // wider net, never into nothing.
  for (const when of [wave1, wave3, after]) {
    const pool = releasedProviders(when);
    for (const p of pool) {
      const rel = relatedProviders(p.slug, 6, when);
      assert.equal(rel.length, Math.min(6, pool.length - 1),
        `${p.slug} got ${rel.length} links at ${when.toISOString().slice(0, 10)}`);
      assert.equal(new Set(rel.map((r) => r.slug)).size, rel.length, `${p.slug} has duplicates`);
    }
  }
});

test('a provider never links to itself', () => {
  for (const p of releasedProviders(after)) {
    assert.ok(!relatedProviders(p.slug, 6, after).some((r) => r.slug === p.slug), p.slug);
  }
});

test('generated params cover only released providers, in their own locales', () => {
  const params = releasedProviderParams(wave3);
  const released = new Set(releasedProviders(wave3).map((p) => p.slug));
  for (const { locale, provider } of params) {
    assert.ok(released.has(provider), `${provider} is not released`);
    const p = PROVIDERS.find((x) => x.slug === provider);
    assert.ok(p.locales.includes(locale), `${provider} has no ${locale} copy`);
  }
});

test('no cohort is large enough to hide a systematic error', () => {
  // Waves no longer meter the rollout, but they still bound blast radius: a bad
  // hostname or a wrong ISP status shows up in one reviewable batch.
  const status = releaseStatus(after);
  const counts = status.map((w) => w.count);
  assert.ok(Math.max(...counts) <= 15, `largest wave is ${Math.max(...counts)}`);
  assert.equal(counts.reduce((a, b) => a + b, 0), PROVIDERS.length);
});

test('wave dates never go backwards, and held waves come last', () => {
  // Several waves now share a date: the number identifies the cohort a page was
  // generated in, not its turn in a queue. What must never happen is a later
  // cohort opening before an earlier one, which would publish the weaker-sourced
  // pages ahead of the stronger ones.
  const waves = Object.keys(RELEASE_WAVES).sort((a, b) => Number(a) - Number(b));
  let previous = 0;
  let seenHeld = false;
  for (const wave of waves) {
    const date = RELEASE_WAVES[wave];
    if (date === null) { seenHeld = true; continue; }
    assert.equal(seenHeld, false, `wave ${wave} is scheduled after a held wave`);
    const time = new Date(`${date}T00:00:00.000Z`).getTime();
    assert.ok(Number.isFinite(time), `wave ${wave} has an unparseable date: ${date}`);
    assert.ok(time >= previous, `wave ${wave} opens before the wave before it`);
    previous = time;
  }
});
