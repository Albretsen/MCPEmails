import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EXCEPTIONS, advisoryId, failingAdvisories, judge } from './audit-with-exceptions.mjs';

const BRACES = 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm';
const OTHER = 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc';

/** The shape `npm audit --json` returned on 2026-10-03, reduced. */
function report(extra = {}) {
  return {
    metadata: { vulnerabilities: { low: 0, moderate: 0, high: 3, critical: 0 } },
    vulnerabilities: {
      braces: { severity: 'high', via: [{ source: 1240992, name: 'braces', url: BRACES, severity: 'high' }] },
      micromatch: { severity: 'high', via: ['braces'] },
      'fast-glob': { severity: 'high', via: ['micromatch'] },
      ...extra,
    },
  };
}

const exception = [{ id: 'GHSA-vfj7-8cjw-p6xm', expires: '2026-11-03', reason: 'test' }];

test('advisoryId reads the GHSA id off an advisory URL', () => {
  assert.equal(advisoryId(BRACES), 'GHSA-vfj7-8cjw-p6xm');
  assert.equal(advisoryId('https://example.com/nothing'), null);
  assert.equal(advisoryId(undefined), null);
});

test('dependents that only name a package add no advisory of their own', () => {
  assert.deepEqual(failingAdvisories(report()).map((a) => a.id), ['GHSA-vfj7-8cjw-p6xm']);
});

test('a live exception lets its one advisory through, and says so', () => {
  const result = judge(report(), exception, '2026-10-03');
  assert.equal(result.failing.length, 0);
  assert.deepEqual(result.excepted.map((a) => a.id), ['GHSA-vfj7-8cjw-p6xm']);
  assert.equal(result.unreadable, false);
});

test('the exception stops applying on its expiry date', () => {
  assert.equal(judge(report(), exception, '2026-11-02').failing.length, 0);
  const onTheDay = judge(report(), exception, '2026-11-03');
  assert.deepEqual(onTheDay.failing.map((a) => a.id), ['GHSA-vfj7-8cjw-p6xm']);
  assert.equal(onTheDay.expired.length, 1);
});

test('any other high or critical advisory still fails, with the exception live', () => {
  for (const severity of ['high', 'critical']) {
    const result = judge(
      report({ lodash: { severity, via: [{ source: 2, name: 'lodash', url: OTHER, severity }] } }),
      exception,
      '2026-10-03',
    );
    assert.deepEqual(result.failing.map((a) => a.id), ['GHSA-aaaa-bbbb-cccc']);
  }
});

test('a second advisory on the excepted package is not covered', () => {
  const result = judge(
    report({
      braces: {
        severity: 'high',
        via: [
          { source: 1240992, name: 'braces', url: BRACES, severity: 'high' },
          { source: 3, name: 'braces', url: OTHER, severity: 'high' },
        ],
      },
    }),
    exception,
    '2026-10-03',
  );
  assert.deepEqual(result.failing.map((a) => a.id), ['GHSA-aaaa-bbbb-cccc']);
});

test('low and moderate advisories do not fail the job, as before', () => {
  const result = judge(
    {
      metadata: { vulnerabilities: { low: 1, moderate: 1, high: 0, critical: 0 } },
      vulnerabilities: {
        a: { severity: 'low', via: [{ source: 4, name: 'a', url: OTHER, severity: 'low' }] },
        b: { severity: 'moderate', via: [{ source: 5, name: 'b', url: OTHER, severity: 'moderate' }] },
      },
    },
    [],
    '2026-10-03',
  );
  assert.equal(result.failing.length, 0);
  assert.equal(result.unreadable, false);
});

test('an advisory with no readable id can never be excepted', () => {
  const result = judge(
    report({ odd: { severity: 'high', via: [{ source: 9, name: 'odd', severity: 'high' }] } }),
    exception,
    '2026-10-03',
  );
  assert.equal(result.failing.length, 1);
  assert.match(result.failing[0].id, /^unidentified:/);
});

test('a report that counts high vulnerabilities but lists none readable fails', () => {
  const result = judge(
    { metadata: { vulnerabilities: { high: 2, critical: 0 } }, vulnerabilities: { x: { severity: 'high', via: ['y'] } } },
    exception,
    '2026-10-03',
  );
  assert.equal(result.unreadable, true);
});

test('a clean report passes', () => {
  const result = judge({ metadata: { vulnerabilities: { high: 0, critical: 0 } }, vulnerabilities: {} }, exception, '2026-10-03');
  assert.deepEqual([result.failing.length, result.excepted.length, result.unreadable], [0, 0, false]);
});

test('every shipped exception has a GHSA id, a dated expiry and a real reason', () => {
  for (const entry of EXCEPTIONS) {
    assert.match(entry.id, /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/);
    assert.match(entry.expires, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(entry.reason.length > 40, 'a reason that explains the exposure');
  }
});
