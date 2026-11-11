/**
 * Tests for the one rule that picks the lifecycle arm (lifecycle-region.ts).
 *
 * Run:
 *   node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
 *     src/lib/email/lifecycle-region.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const region = await import('@/lib/email/lifecycle-region');

test('ownerRegion: positively non-European only with a known, non-European country', () => {
  assert.equal(region.ownerRegion(['US']), 'non_european');
  assert.equal(region.ownerRegion(['us', null]), 'non_european');
  assert.equal(region.ownerRegion(['BR', 'JP']), 'non_european');
});

test('ownerRegion: Europe is EU plus IS LI NO CH GB', () => {
  for (const c of ['DE', 'FR', 'NO', 'IS', 'LI', 'CH', 'GB', 'SE', 'IE']) assert.equal(region.ownerRegion([c]), 'european', c);
  assert.equal(region.ownerRegion(['US', 'NO']), 'european');
});

test('ownerRegion: unknown, placeholders and junk are unknown', () => {
  assert.equal(region.ownerRegion([]), 'unknown');
  assert.equal(region.ownerRegion([null, undefined, '']), 'unknown');
  assert.equal(region.ownerRegion(['XX', 'EU', 'ZZ', 'usa']), 'unknown');
});

test('lifecycleArm: consent wins, unknown falls to the service notice', () => {
  assert.equal(region.lifecycleArm({ consented: true, region: 'european' }), 'consented');
  assert.equal(region.lifecycleArm({ consented: true, region: 'unknown' }), 'consented');
  assert.equal(region.lifecycleArm({ consented: false, region: 'non_european' }), 'soft_opt_in');
  assert.equal(region.lifecycleArm({ consented: false, region: 'european' }), 'service_notice');
  assert.equal(region.lifecycleArm({ consented: false, region: 'unknown' }), 'service_notice');
  assert.equal(region.mayPromote('service_notice'), false);
  assert.equal(region.mayPromote('soft_opt_in'), true);
});

test('expansionConfig: unset start means nobody, dry run unless exactly false', () => {
  assert.deepEqual(region.expansionConfig({}), { startAt: null, live: false });
  assert.equal(region.expansionConfig({ LIFECYCLE_EXPANSION_START_AT: 'soon' }).startAt, null);
  const c = region.expansionConfig({ LIFECYCLE_EXPANSION_START_AT: '2026-12-02T07:00:00Z', LIFECYCLE_EXPANSION_DRY_RUN: 'false' });
  assert.equal(c.startAt?.toISOString(), '2026-12-02T07:00:00.000Z');
  assert.equal(c.live, true);
  assert.equal(
    region.expansionConfig({ LIFECYCLE_EXPANSION_START_AT: '2026-12-02T07:00:00Z', LIFECYCLE_EXPANSION_DRY_RUN: 'flase' }).live,
    false,
  );
  assert.equal(region.expansionCovers(c, Date.parse('2026-12-02T06:59:59Z')), false);
  assert.equal(region.expansionCovers(c, Date.parse('2026-12-02T07:00:00Z')), true);
  assert.equal(region.expansionCovers({ startAt: null, live: true }, Date.now()), false);
});
