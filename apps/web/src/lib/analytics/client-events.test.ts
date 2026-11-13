import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_EVENTS_PER_BEACON,
  browserFromUserAgent,
  maskPath,
  maskSource,
  maskText,
  parseClientEvents,
} from './client-events.ts';

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SAFARI_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const ctx = { userAgent: CHROME_MAC, signedIn: true };

test('maskPath drops the query and masks ids, tokens and emails', () => {
  assert.equal(maskPath('/dashboard/settings?upgrade=personal&x=1#top'), '/dashboard/settings');
  assert.equal(maskPath('/api/workspaces/84804f7f-c689-499e-9b5d-9794cb0cb46f/brief'), '/api/workspaces/:id/brief');
  assert.equal(maskPath('/u/AbCdEfGhIjKlMnOpQrStUvWxYz012345'), '/u/:token');
  assert.equal(maskPath('/invite/someone@example.com'), '/invite/:email');
  assert.equal(maskPath('https://mcpemails.com/pricing?plan=solo'), '/pricing');
  assert.equal(maskPath(''), '/');
  assert.equal(maskPath(42), '/');
  assert.equal(maskPath('/' + 'a/'.repeat(200)).length, 160);
});

test('maskText removes emails, ids and long tokens and caps length', () => {
  assert.equal(
    maskText('Failed for jane.doe@example.com in cs_live_b1abcdefghijklmnopqrstuvwxyz', 300),
    'Failed for :email in :token',
  );
  assert.equal(maskText('  a\n  b ', 300), 'a b');
  assert.equal(maskText('word '.repeat(100), 300)?.length, 300);
  assert.equal(maskText('x'.repeat(500), 300), ':token');
  assert.equal(maskText('', 300), null);
  assert.equal(maskText({}, 300), null);
});

test('maskSource keeps our own script paths and names other hosts only', () => {
  assert.equal(maskSource('https://mcpemails.com/_next/static/chunks/app-1.js?dpl=abc'), '/_next/static/chunks/app-1.js');
  assert.equal(maskSource('https://js.stripe.com/v3/'), 'external:js.stripe.com');
  assert.equal(maskSource(''), null);
});

test('browserFromUserAgent gives a coarse label and flags bots', () => {
  assert.deepEqual(browserFromUserAgent(CHROME_MAC), { label: 'chrome/macos', bot: false });
  assert.deepEqual(browserFromUserAgent(SAFARI_IOS), { label: 'safari/ios/m', bot: false });
  assert.equal(browserFromUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1)').bot, true);
  assert.equal(browserFromUserAgent('Mozilla/5.0 HeadlessChrome/131.0').bot, true);
  assert.deepEqual(browserFromUserAgent(null), { label: null, bot: false });
});

test('parseClientEvents keeps known fields only and masks them', () => {
  const rows = parseClientEvents(
    {
      e: [
        {
          k: 'error',
          p: '/dashboard/settings?email=a@b.co',
          m: 'TypeError at a@b.co',
          s: 'https://mcpemails.com/_next/static/chunks/x.js',
          l: 12,
          w: 390,
          g: 'de',
          secret: 'dropped',
        },
        { k: 'buy', p: '/dashboard/inboxes', t: 'personal', w: 1400 },
        { k: 'page', p: '/pricing', h: false, w: 800 },
        { k: 'buy', p: '/x', t: 'not-a-label' },
        { k: 'nope', p: '/x' },
        'junk',
      ],
    },
    ctx,
  );
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], {
    kind: 'error',
    path: '/dashboard/settings',
    detail: { message: 'TypeError at :email', source: '/_next/static/chunks/x.js', line: 12, width: 'xs', lang: 'de' },
    browser: 'chrome/macos',
    signed_in: true,
  });
  assert.deepEqual(rows[1].detail, { target: 'personal', width: 'l' });
  assert.deepEqual(rows[2].detail, { hydrated: false, width: 'm' });
  assert.deepEqual(rows[3].detail, {});
});

test('parseClientEvents refuses bots, non-beacons and caps the batch', () => {
  assert.deepEqual(parseClientEvents({ e: [{ k: 'page', p: '/pricing' }] }, { userAgent: 'curl/8.0', signedIn: false }), []);
  assert.deepEqual(parseClientEvents(null, ctx), []);
  assert.deepEqual(parseClientEvents({ e: 'x' }, ctx), []);
  const many = { e: Array.from({ length: 50 }, () => ({ k: 'page', p: '/pricing' })) };
  assert.equal(parseClientEvents(many, ctx).length, MAX_EVENTS_PER_BEACON);
});
