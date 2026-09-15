import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACQUISITION_KEY,
  ACQUISITION_TTL_MS,
  ACQUISITION_VERSION,
  captureAcquisition,
  readLegacyAcquisition,
  readStoredAcquisition,
  writeAcquisition,
} from './acquisition-storage.mjs';

// The runner has no DOM, so storage is a plain Map with the three methods the
// helpers use. `throwingStorage` stands in for Safari private mode and for a
// browser with site data switched off.
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

function throwingStorage() {
  const boom = () => { throw new Error('SecurityError: site data is blocked'); };
  return { getItem: boom, setItem: boom, removeItem: boom };
}

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 15, 9, 0, 0);

const BLOG_URL = new URL('https://mcpemails.com/blog/connect-claude-to-email');
const REDDIT = new URL('https://www.reddit.com/r/mcp/comments/abc/');
const PRICING_URL = new URL('https://mcpemails.com/nb/pricing');

function envelopeIn(storage) {
  return JSON.parse(storage.map.get(ACQUISITION_KEY));
}

test('a first visit is captured into local storage as a versioned envelope', () => {
  const local = fakeStorage();
  const session = fakeStorage();

  const { value, origin } = captureAcquisition({
    local, session, url: BLOG_URL, referrer: REDDIT, now: T0,
  });

  assert.equal(origin, 'fresh');
  assert.equal(value.source, 'reddit');
  assert.equal(value.landing, 'blog');
  assert.equal(value.landingPath, '/blog/connect-claude-to-email');

  const envelope = envelopeIn(local);
  assert.deepEqual(Object.keys(envelope).sort(), ['capturedAt', 'v', 'value']);
  assert.equal(envelope.v, ACQUISITION_VERSION);
  assert.equal(envelope.capturedAt, T0);
  assert.deepEqual(envelope.value, value);
  assert.equal(session.map.size, 0);
});

test('first touch wins: a later visit never overwrites an unexpired record', () => {
  const local = fakeStorage();
  const session = fakeStorage();
  captureAcquisition({ local, session, url: BLOG_URL, referrer: REDDIT, now: T0 });

  const second = captureAcquisition({
    local, session, url: PRICING_URL, referrer: null, now: T0 + 3 * DAY,
  });

  assert.equal(second.origin, 'existing');
  assert.equal(second.value.source, 'reddit');
  assert.equal(second.value.landing, 'blog');
  // Not sliding: the stamp stays on the day of the first touch.
  assert.equal(envelopeIn(local).capturedAt, T0);
});

test('the window is 30 days and does not slide', () => {
  const local = fakeStorage();
  writeAcquisition(local, { source: 'github', landing: 'docs', landingPath: '/docs' }, T0);

  const justInside = readStoredAcquisition(local, T0 + ACQUISITION_TTL_MS - 1);
  assert.equal(justInside.source, 'github');

  // Exactly 30 days old is expired, as is anything past it.
  assert.equal(readStoredAcquisition(local, T0 + ACQUISITION_TTL_MS), null);
  assert.equal(readStoredAcquisition(local, T0 + ACQUISITION_TTL_MS + DAY), null);
});

test('an expired record is replaced by a fresh capture', () => {
  const local = fakeStorage();
  const session = fakeStorage();
  writeAcquisition(local, { source: 'github', landing: 'docs', landingPath: '/docs' }, T0);

  const { value, origin } = captureAcquisition({
    local, session, url: PRICING_URL, referrer: null, now: T0 + 31 * DAY,
  });

  assert.equal(origin, 'fresh');
  assert.equal(value.source, 'direct');
  assert.equal(value.landing, 'pricing');
  assert.equal(value.locale, 'nb');
  assert.equal(envelopeIn(local).capturedAt, T0 + 31 * DAY);
});

test('malformed or unrecognised records are discarded, never thrown', () => {
  const cases = [
    'not json at all',
    '',
    '[]',
    'null',
    JSON.stringify({ v: 99, capturedAt: T0, value: { source: 'reddit' } }),
    JSON.stringify({ v: 1, value: { source: 'reddit' } }),
    JSON.stringify({ v: 1, capturedAt: 'yesterday', value: { source: 'reddit' } }),
    JSON.stringify({ v: 1, capturedAt: T0, value: null }),
  ];
  for (const raw of cases) {
    const local = fakeStorage({ [ACQUISITION_KEY]: raw });
    assert.equal(readStoredAcquisition(local, T0), null, `expected to discard: ${raw}`);
  }

  const local = fakeStorage({ [ACQUISITION_KEY]: '{oops' });
  const { origin, value } = captureAcquisition({
    local, session: fakeStorage(), url: BLOG_URL, referrer: REDDIT, now: T0,
  });
  assert.equal(origin, 'fresh');
  assert.equal(value.source, 'reddit');
});

test('a hand edited value cannot inject a category outside the allowlist', () => {
  const local = fakeStorage({
    [ACQUISITION_KEY]: JSON.stringify({
      v: 1,
      capturedAt: T0,
      value: {
        source: 'partner-kickback',
        landing: 'checkout',
        landingPath: '/dashboard/inboxes?token=secret',
        locale: 'de',
        referrer: 'evil.example',
        utmMedium: 'billboard',
        utmCampaign: 'user-42',
      },
    }),
  });

  const value = readStoredAcquisition(local, T0 + DAY);
  assert.equal(value.source, 'direct');
  assert.equal(value.landing, 'other');
  assert.equal(value.landingPath, '/other');
  assert.equal(value.locale, 'en');
  assert.equal(value.referrer, 'direct');
  assert.equal(value.utmMedium, 'other');
  assert.equal(value.utmCampaign, 'other');
});

test('a legacy session record is promoted into local storage and cleaned up', () => {
  const legacy = { source: 'glama', landing: 'blog', landingPath: '/blog', locale: 'en', referrer: 'glama' };
  const local = fakeStorage();
  const session = fakeStorage({ [ACQUISITION_KEY]: JSON.stringify(legacy) });

  const { value, origin } = captureAcquisition({
    local, session, url: PRICING_URL, referrer: null, now: T0,
  });

  assert.equal(origin, 'legacy');
  assert.equal(value.source, 'glama');
  assert.equal(value.landing, 'blog');
  // Stamped with now, since the old record carried no capture time.
  assert.equal(envelopeIn(local).capturedAt, T0);
  assert.equal(envelopeIn(local).value.source, 'glama');
  assert.equal(session.map.has(ACQUISITION_KEY), false);
});

test('a legacy record is kept when the durable write is refused', () => {
  const legacy = { source: 'glama', landing: 'blog', landingPath: '/blog' };
  const session = fakeStorage({ [ACQUISITION_KEY]: JSON.stringify(legacy) });

  const { value, origin } = captureAcquisition({
    local: throwingStorage(), session, url: PRICING_URL, referrer: null, now: T0,
  });

  assert.equal(origin, 'legacy');
  assert.equal(value.source, 'glama');
  assert.equal(session.map.has(ACQUISITION_KEY), true);
});

test('a legacy session record never beats an unexpired local one', () => {
  const local = fakeStorage();
  writeAcquisition(local, { source: 'reddit', landing: 'blog', landingPath: '/blog' }, T0);
  const session = fakeStorage({ [ACQUISITION_KEY]: JSON.stringify({ source: 'github', landing: 'docs' }) });

  const { value, origin } = captureAcquisition({
    local, session, url: PRICING_URL, referrer: null, now: T0 + DAY,
  });

  assert.equal(origin, 'existing');
  assert.equal(value.source, 'reddit');
});

test('a malformed legacy record is ignored', () => {
  const session = fakeStorage({ [ACQUISITION_KEY]: 'nonsense' });
  assert.equal(readLegacyAcquisition(session), null);
});

test('storage that throws degrades to no stored context', () => {
  const storage = throwingStorage();
  assert.equal(readStoredAcquisition(storage, T0), null);
  assert.equal(readLegacyAcquisition(storage), null);
  assert.equal(writeAcquisition(storage, { source: 'reddit' }, T0), false);

  const { value, origin } = captureAcquisition({
    local: storage, session: storage, url: BLOG_URL, referrer: REDDIT, now: T0,
  });
  assert.equal(origin, 'fresh');
  assert.equal(value.source, 'reddit');
});

test('missing storage objects behave like empty ones', () => {
  assert.equal(readStoredAcquisition(undefined, T0), null);
  const { origin, value } = captureAcquisition({
    local: null, session: null, url: BLOG_URL, referrer: REDDIT, now: T0,
  });
  assert.equal(origin, 'fresh');
  assert.equal(value.source, 'reddit');
});

test('the stored shape stays exactly what sanitizedAcquisition produces', () => {
  const local = fakeStorage();
  captureAcquisition({
    local,
    session: fakeStorage(),
    url: new URL('https://mcpemails.com/blog?utm_source=reddit&utm_medium=social&utm_campaign=launch-week'),
    referrer: null,
    now: T0,
  });
  assert.deepEqual(Object.keys(envelopeIn(local).value).sort(), [
    'landing', 'landingPath', 'locale', 'referrer', 'source', 'utmCampaign', 'utmMedium', 'utmSource',
  ]);
  assert.deepEqual(readStoredAcquisition(local, T0), {
    source: 'reddit',
    landing: 'blog',
    landingPath: '/blog',
    locale: 'en',
    referrer: 'direct',
    utmSource: 'reddit',
    utmMedium: 'social',
    utmCampaign: 'launch',
  });
});
