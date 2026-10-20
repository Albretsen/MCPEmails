import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectSources, staleSources, report } from './compare-freshness.mjs';

// The staleness check itself never runs in CI (see the header of
// compare-freshness.mjs). These tests pin its logic on fixed dates, so they
// pass on any day.

const src = (checkedOn, label = checkedOn) => ({ page: '/p', label, url: 'https://example.com', checkedOn });

test('a source exactly maxAge days old is fresh; one day older is stale', () => {
  const stale = staleSources([src('2026-09-05'), src('2026-09-04')], '2026-10-20', 45);
  assert.deepEqual(stale.map((s) => s.checkedOn), ['2026-09-04']);
  assert.equal(stale[0].ageDays, 46);
});

test('an undated or malformed source is always stale, and listed first', () => {
  const stale = staleSources([src('2026-01-01', 'old'), src(null, 'none'), src('8 September 2026', 'prose')], '2026-10-20', 45);
  assert.deepEqual(stale.map((s) => s.label), ['none', 'prose', 'old']);
});

test('collects both pages, whichever SOURCES shape the ranking page uses', () => {
  const native = { PATH: '/n', SOURCES: [{ id: 'a', url: 'https://a', checkedOn: '2026-10-19' }] };
  const asObject = { PATH: '/b', SOURCES: { items: [{ label: 'b', url: 'https://b', checkedOn: '2026-10-20' }] } };
  const asArray = { PATH: '/b', SOURCES: [{ label: 'b', url: 'https://b' }] };
  assert.deepEqual(collectSources(asObject, native).map((s) => [s.page, s.checkedOn]), [['/b', '2026-10-20'], ['/n', '2026-10-19']]);
  assert.deepEqual(collectSources(asArray, native).map((s) => s.checkedOn), [null, '2026-10-19']);
});

test('the real sources all resolve to a page and a URL', () => {
  const all = collectSources();
  assert.ok(all.length > 0);
  for (const s of all) {
    assert.ok(s.page.startsWith('/'), `no page for ${s.label}`);
    assert.ok(s.url.startsWith('https://'), `${s.label}: url is not https`);
  }
});

test('the report names every stale source and how to fix it', () => {
  const out = report(staleSources([src('2026-01-01', 'Old source')], '2026-10-20', 45), '2026-10-20', 45);
  assert.match(out, /Old source/);
  assert.match(out, /native-connectors\.mjs/);
  assert.match(report([], '2026-10-20', 45), /within 45 days/);
});
