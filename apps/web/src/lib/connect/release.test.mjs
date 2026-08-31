import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS } from './providers.mjs';
import {
  RELEASE_WAVES, isReleased, releasedProviders, relatedProviders,
  releasedProviderParams, releaseStatus,
} from './release.mjs';

const before = new Date('2026-08-30T00:00:00.000Z');
const wave1 = new Date('2026-09-01T00:00:00.000Z');
const wave3 = new Date('2026-09-15T00:00:00.000Z');
const after = new Date('2026-12-01T00:00:00.000Z');

test('every provider is assigned a wave that has a date', () => {
  for (const p of PROVIDERS) {
    assert.ok(p.wave, `${p.slug} has no wave`);
    assert.ok(RELEASE_WAVES[p.wave], `${p.slug} wave ${p.wave} has no date`);
  }
});

test('the six providers already in production are in wave 1', () => {
  // Anything else would take a live page down, which is a regression, not a
  // rollout.
  for (const slug of ['gmail', 'fastmail', 'icloud', 'yahoo', 'zoho', 'yandex']) {
    assert.equal(PROVIDERS.find((p) => p.slug === slug).wave, 1, slug);
  }
});

test('waves open in order and everything is public at the end', () => {
  assert.equal(releasedProviders(before).length, 0);
  const w1 = releasedProviders(wave1).length;
  const w3 = releasedProviders(wave3).length;
  assert.ok(w1 > 0 && w3 > w1, `expected growth, got ${w1} then ${w3}`);
  assert.equal(releasedProviders(after).length, PROVIDERS.length);
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

test('waves are spread rather than back-loaded into one drop', () => {
  const status = releaseStatus(after);
  const counts = status.map((w) => w.count);
  assert.ok(Math.max(...counts) <= 15, `largest wave is ${Math.max(...counts)}`);
  assert.equal(counts.reduce((a, b) => a + b, 0), PROVIDERS.length);
});

test('wave dates are strictly increasing', () => {
  const dates = Object.keys(RELEASE_WAVES)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => new Date(RELEASE_WAVES[k]).getTime());
  for (let i = 1; i < dates.length; i += 1) {
    assert.ok(dates[i] > dates[i - 1], `wave ${i + 1} is not after wave ${i}`);
  }
});
