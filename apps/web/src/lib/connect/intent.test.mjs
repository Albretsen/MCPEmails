// ---------------------------------------------------------------------------
// The connect hint: "this person came for IONOS".
//
// Run with: npm run test:connect-intent
//
// Two files are under test. intent-carry.mjs moves a slug from a landing page
// to the dashboard (a query parameter and one browser-storage record) and
// trusts nothing. intent.mjs checks it against the provider registry and says
// what the connect modal should preselect.
//
// What matters here is the refusals. An unknown slug, an unreleased page and a
// provider we cannot connect must all come out as null, which the dashboard
// treats as "there was no hint", and a hint must be readable exactly once.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PROVIDERS } from './providers.mjs';
import { RELEASE_WAVES, isHeld, isReleased } from './release.mjs';
import {
  CONNECT_INTENT_KEY,
  CONNECT_INTENT_PARAM,
  CONNECT_INTENT_TTL_MS,
  clearConnectIntent,
  connectIntentSlugShape,
  connectIntentStorage,
  readStoredConnectIntent,
  rememberConnectIntent,
  takeConnectIntent,
  withConnectIntent,
  withoutConnectIntent,
} from './intent-carry.mjs';
import {
  GENERIC_CARD,
  MODAL_CARD_BY_SLUG,
  connectPreselectFor,
  resolveConnectIntent,
} from './intent.mjs';

/** Every wave open, so the answers do not depend on the day the suite runs. */
const NOW = new Date('2026-12-01T00:00:00.000Z');
const T0 = Date.parse('2026-10-04T12:00:00.000Z');

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
  };
}

/** Site data blocked: every method throws, as Safari private mode does. */
const throwingStorage = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceededError'); },
  removeItem() { throw new Error('SecurityError'); },
};

// ── Resolving a slug ────────────────────────────────────────────────────────

test('a released, supported provider with fixed hosts resolves to the generic card with its settings', () => {
  const intent = resolveConnectIntent('ionos', NOW);
  assert.deepEqual(intent, {
    slug: 'ionos',
    name: 'IONOS',
    card: 'generic',
    settings: {
      imapHost: 'imap.ionos.com',
      imapPort: 993,
      imapSecurity: 'tls',
      smtpHost: 'smtp.ionos.com',
      smtpPort: 465,
      smtpSecurity: 'tls',
    },
  });
});

test('an unknown slug resolves to nothing', () => {
  for (const slug of ['not-a-provider', 'ionoss', 'constructor', '__proto__', 'toString']) {
    assert.equal(resolveConnectIntent(slug, NOW), null, slug);
  }
});

test('anything that is not shaped like a slug resolves to nothing', () => {
  const junk = [
    null, undefined, '', 42, {}, ['ionos'], 'IONOS', ' ionos', 'ionos ', 'ionos/../x',
    'ionos?x=1', '<script>', '-ionos', 'ionos-', 'a'.repeat(41), 'gmail.com',
  ];
  for (const value of junk) {
    assert.equal(connectIntentSlugShape(value), null, String(value));
    assert.equal(resolveConnectIntent(value, NOW), null, String(value));
  }
});

test('every registry slug passes the shape check, so none is dropped in transit', () => {
  for (const p of PROVIDERS) assert.equal(connectIntentSlugShape(p.slug), p.slug, p.slug);
});

test('a provider in a held wave resolves to nothing, however much time passes', () => {
  const heldWaves = Object.keys(RELEASE_WAVES).filter((w) => isHeld(w)).map(Number);
  const held = PROVIDERS.filter((p) => heldWaves.includes(p.wave));
  assert.ok(held.length > 0, 'expected at least one held provider');
  for (const p of held) {
    assert.equal(resolveConnectIntent(p.slug, NOW), null, p.slug);
    assert.equal(resolveConnectIntent(p.slug, new Date('2030-01-01T00:00:00.000Z')), null, p.slug);
  }
});

test('a provider whose wave has not opened yet resolves to nothing until it does', () => {
  const before = new Date('2026-08-30T00:00:00.000Z');
  assert.equal(resolveConnectIntent('ionos', before), null);
  assert.equal(resolveConnectIntent('ionos', new Date('2026-08-31T00:00:00.000Z'))?.slug, 'ionos');
});

test('the providers we cannot connect resolve to nothing', () => {
  for (const slug of ['hey', 'proton', 'tutanota']) {
    assert.equal(resolveConnectIntent(slug, NOW), null, slug);
  }
  // Not only those three by name: anything the registry marks as not supported.
  for (const p of PROVIDERS.filter((x) => x.category === 'blocked' || x.status !== 'supported')) {
    assert.equal(resolveConnectIntent(p.slug, NOW), null, p.slug);
  }
});

test('Gmail and Outlook preselect their own cards and are never given IMAP settings', () => {
  for (const [slug, card] of [
    ['gmail', 'gmail'],
    ['google-workspace', 'gmail'],
    ['outlook', 'outlook'],
    ['office365', 'outlook'],
  ]) {
    const intent = resolveConnectIntent(slug, NOW);
    assert.equal(intent?.card, card, slug);
    assert.equal(intent.settings, null, slug);
    const preselect = connectPreselectFor(intent, () => { throw new Error('must not be consulted'); });
    assert.equal(preselect.card, card, slug);
    assert.equal(preselect.form, null, slug);
  }
});

test('a provider with a card of its own preselects that card, with nothing to prefill', () => {
  for (const [slug, card] of Object.entries(MODAL_CARD_BY_SLUG)) {
    const intent = resolveConnectIntent(slug, NOW);
    assert.ok(intent, `${slug} is in the card map but does not resolve`);
    assert.equal(intent.card, card);
    assert.equal(intent.settings, null);
  }
});

test('a provider with no fixed hostname resolves to the generic card with nothing to prefill', () => {
  for (const slug of ['imap', 'cpanel', 'bluehost', 'dovecot', 'mailcow']) {
    const intent = resolveConnectIntent(slug, NOW);
    assert.equal(intent?.card, GENERIC_CARD, slug);
    assert.equal(intent.settings, null, slug);
    assert.deepEqual(connectPreselectFor(intent), {
      slug, card: GENERIC_CARD, label: intent.name, form: null,
    });
  }
});

test('every released, supported provider resolves, and only to a known card', () => {
  const cards = new Set([GENERIC_CARD, ...Object.values(MODAL_CARD_BY_SLUG)]);
  for (const p of PROVIDERS) {
    const intent = resolveConnectIntent(p.slug, NOW);
    const expected = isReleased(p, NOW) && p.category !== 'blocked' && p.status === 'supported';
    assert.equal(intent !== null, expected, p.slug);
    if (!intent) continue;
    assert.ok(cards.has(intent.card), `${p.slug} -> ${intent.card}`);
    if (intent.settings) {
      // What the form is prefilled with is exactly what the landing page lists.
      assert.equal(intent.card, GENERIC_CARD, p.slug);
      assert.equal(intent.settings.imapHost, p.imap.host, p.slug);
      assert.equal(intent.settings.smtpHost, p.smtp.host, p.slug);
      assert.ok([993, 143].includes(intent.settings.imapPort), p.slug);
      assert.ok([465, 587].includes(intent.settings.smtpPort), p.slug);
    }
  }
});

test('the preselect takes its hosts from the registry and its app-password rule from the modal table', () => {
  const intent = resolveConnectIntent('ionos', NOW);
  const asked = [];
  const preselect = connectPreselectFor(intent, (input) => {
    asked.push(input);
    return {
      imapHost: 'somewhere.else.example',
      requiresAppPassword: true,
      appPasswordHelpUrl: 'https://example.com/app-passwords',
    };
  });
  assert.deepEqual(asked, [{ host: 'imap.ionos.com' }]);
  assert.deepEqual(preselect, {
    slug: 'ionos',
    card: 'generic',
    label: 'IONOS',
    form: { ...intent.settings },
    requiresAppPassword: true,
    appPasswordHelpUrl: 'https://example.com/app-passwords',
  });

  // A host the table has never heard of, a missing lookup and a lookup that
  // throws all still prefill, just without the app-password note.
  for (const lookup of [() => null, null, () => { throw new Error('boom'); }]) {
    const plain = connectPreselectFor(intent, lookup);
    assert.deepEqual(plain.form, intent.settings);
    assert.equal(plain.requiresAppPassword, false);
    assert.equal(plain.appPasswordHelpUrl, null);
  }
  assert.equal(connectPreselectFor(null), null);
});

// ── Carrying it ─────────────────────────────────────────────────────────────

test('the hint is added to a destination as one parameter and nothing else', () => {
  assert.equal(withConnectIntent('/signup', 'ionos'), '/signup?provider=ionos');
  assert.equal(withConnectIntent('/dashboard?firstrun=1', 'ionos'), '/dashboard?firstrun=1&provider=ionos');
  assert.equal(
    withConnectIntent('/login?redirect=%2Finvite%2Fabc', 'mail-com'),
    '/login?redirect=%2Finvite%2Fabc&provider=mail-com',
  );
  assert.equal(withConnectIntent('/dashboard?provider=gmx', 'ionos'), '/dashboard?provider=ionos');
  assert.equal(withConnectIntent('/dashboard#top', 'ionos'), '/dashboard?provider=ionos#top');
  assert.equal(CONNECT_INTENT_PARAM, 'provider');
});

test('no hint, or a malformed one, leaves the destination byte for byte as it was', () => {
  for (const slug of [null, undefined, '', 'IONOS', 'a b', '../x', 'x&firstrun=0']) {
    assert.equal(withConnectIntent('/dashboard?firstrun=1', slug), '/dashboard?firstrun=1', String(slug));
    assert.equal(withConnectIntent('/dashboard', slug), '/dashboard', String(slug));
    assert.equal(withConnectIntent('/signup', slug), '/signup', String(slug));
  }
});

test('the parameter is removed from the address bar without disturbing the rest', () => {
  assert.equal(
    withoutConnectIntent('https://mcpemails.com/dashboard?firstrun=1&provider=ionos&signup_method=google'),
    'https://mcpemails.com/dashboard?firstrun=1&signup_method=google',
  );
  assert.equal(
    withoutConnectIntent('https://mcpemails.com/dashboard?provider=ionos'),
    'https://mcpemails.com/dashboard',
  );
  const untouched = 'https://mcpemails.com/dashboard?firstrun=1';
  assert.equal(withoutConnectIntent(untouched), untouched);
});

test('a remembered hint is read back, and holds only a slug and a time', () => {
  const storage = memoryStorage();
  assert.equal(rememberConnectIntent(storage, 'ionos', T0), true);
  assert.deepEqual(JSON.parse(storage.data.get(CONNECT_INTENT_KEY)), { v: 1, slug: 'ionos', at: T0 });
  assert.equal(readStoredConnectIntent(storage, T0 + 1000), 'ionos');
  // Its own key: the acquisition record is not where this lives.
  assert.deepEqual([...storage.data.keys()], ['mcpe-connect-intent']);
});

test('a malformed slug is never written', () => {
  const storage = memoryStorage();
  for (const slug of [null, '', 'IONOS', '<script>', 'a'.repeat(60)]) {
    assert.equal(rememberConnectIntent(storage, slug, T0), false);
  }
  assert.equal(storage.data.size, 0);
});

test('a stored hint expires after a day, and a record from the future is not believed', () => {
  const storage = memoryStorage();
  rememberConnectIntent(storage, 'ionos', T0);
  assert.equal(readStoredConnectIntent(storage, T0 + CONNECT_INTENT_TTL_MS - 1), 'ionos');
  assert.equal(readStoredConnectIntent(storage, T0 + CONNECT_INTENT_TTL_MS), null);
  assert.equal(readStoredConnectIntent(storage, T0 - 1), null);
});

test('a stored record is validated on read, never trusted', () => {
  const cases = [
    'not json',
    '"ionos"',
    'null',
    '[]',
    JSON.stringify({ v: 2, slug: 'ionos', at: T0 }),
    JSON.stringify({ v: 1, slug: 'IONOS', at: T0 }),
    JSON.stringify({ v: 1, slug: '../../etc', at: T0 }),
    JSON.stringify({ v: 1, slug: { toString: 'ionos' }, at: T0 }),
    JSON.stringify({ v: 1, slug: 'ionos' }),
    JSON.stringify({ v: 1, slug: 'ionos', at: 'yesterday' }),
  ];
  for (const raw of cases) {
    const storage = memoryStorage({ [CONNECT_INTENT_KEY]: raw });
    assert.equal(readStoredConnectIntent(storage, T0 + 1), null, raw);
  }
  // Well-formed but naming nothing real: it survives the carry (which only
  // knows shapes) and is refused by the registry.
  const storage = memoryStorage({
    [CONNECT_INTENT_KEY]: JSON.stringify({ v: 1, slug: 'made-up-host', at: T0 }),
  });
  const slug = takeConnectIntent({ storage, now: T0 + 1 });
  assert.equal(slug, 'made-up-host');
  assert.equal(resolveConnectIntent(slug, NOW), null);
});

test('taking the hint spends it: the second look finds nothing', () => {
  const storage = memoryStorage();
  rememberConnectIntent(storage, 'ionos', T0);
  assert.equal(takeConnectIntent({ search: '', storage, now: T0 + 5 }), 'ionos');
  assert.equal(storage.data.has(CONNECT_INTENT_KEY), false);
  assert.equal(takeConnectIntent({ search: '', storage, now: T0 + 6 }), null);
  assert.equal(readStoredConnectIntent(storage, T0 + 6), null);
});

test('the link wins over storage, and taking either one clears the stored record', () => {
  const storage = memoryStorage();
  rememberConnectIntent(storage, 'gmx', T0);
  assert.equal(takeConnectIntent({ search: '?firstrun=1&provider=ionos', storage, now: T0 + 5 }), 'ionos');
  assert.equal(storage.data.size, 0);
});

test('a stale, malformed or unusable record is still removed when it is looked at', () => {
  const stale = memoryStorage();
  rememberConnectIntent(stale, 'ionos', T0);
  assert.equal(takeConnectIntent({ storage: stale, now: T0 + CONNECT_INTENT_TTL_MS + 1 }), null);
  assert.equal(stale.data.size, 0);

  const junk = memoryStorage({ [CONNECT_INTENT_KEY]: 'not json' });
  assert.equal(takeConnectIntent({ storage: junk, now: T0 }), null);
  assert.equal(junk.data.size, 0);
});

test('a malformed link parameter is ignored and falls back to storage', () => {
  const storage = memoryStorage();
  rememberConnectIntent(storage, 'ionos', T0);
  assert.equal(takeConnectIntent({ search: '?provider=%3Cscript%3E', storage, now: T0 + 1 }), 'ionos');
  assert.equal(takeConnectIntent({ search: '?provider=', storage: memoryStorage(), now: T0 }), null);
});

test('with storage unavailable nothing throws, and the link alone still carries the hint', () => {
  assert.equal(rememberConnectIntent(throwingStorage, 'ionos', T0), false);
  assert.equal(rememberConnectIntent(null, 'ionos', T0), false);
  assert.equal(readStoredConnectIntent(throwingStorage, T0), null);
  assert.equal(readStoredConnectIntent(null, T0), null);
  assert.doesNotThrow(() => clearConnectIntent(throwingStorage));
  assert.doesNotThrow(() => clearConnectIntent(null));

  assert.equal(takeConnectIntent({ search: '?provider=ionos', storage: throwingStorage, now: T0 }), 'ionos');
  assert.equal(takeConnectIntent({ search: '?provider=ionos', storage: null, now: T0 }), 'ionos');
  assert.equal(takeConnectIntent({ search: '', storage: throwingStorage, now: T0 }), null);
  assert.equal(takeConnectIntent(), null);
});

test('reaching for localStorage is itself guarded', () => {
  const blocked = {};
  Object.defineProperty(blocked, 'localStorage', { get() { throw new Error('SecurityError'); } });
  assert.equal(connectIntentStorage(blocked), null);
  assert.equal(connectIntentStorage(undefined), null);
  const storage = memoryStorage();
  assert.equal(connectIntentStorage({ localStorage: storage }), storage);
});

// ── It stays a UI hint ──────────────────────────────────────────────────────

test('the hint never reaches the database, the signup metadata or attribution', () => {
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

  // The carrying half must not pull the registry into the auth and dashboard
  // first-load bundles, and neither half may touch attribution.
  const carry = read('./intent-carry.mjs');
  assert.ok(!/^import /m.test(carry), 'intent-carry.mjs must stay import-free');
  assert.ok(!/from '[^']*acquisition/.test(read('./intent.mjs')));

  // Attribution knows nothing about it.
  const acquisition = read('../acquisition-context.mjs');
  assert.ok(!acquisition.includes('connect-intent') && !acquisition.includes('intent-carry'));
  assert.notEqual(CONNECT_INTENT_KEY, 'mcpe-acquisition');

  // The OAuth callback writes the workspace row. It must not read the hint.
  const callback = read('../../../app/auth/callback/route.ts');
  assert.ok(!callback.includes('intent'), 'the auth callback must not handle the connect hint');

  // The password signup sends `options.data` to Supabase. The hint is not in it.
  const signup = read('../../../components/auth/SignupApp.jsx');
  const data = signup.slice(signup.indexOf('data: {'), signup.indexOf('...signupConsentMetadata'));
  assert.ok(data.includes('acquisition_source'), 'expected to be looking at the signUp metadata');
  assert.ok(!/connectProvider|provider/i.test(data), 'the hint leaked into the signup metadata');

  // The registry is loaded on demand in the browser, never statically.
  for (const file of [
    '../../../components/auth/SignupApp.jsx',
    '../../../components/auth/LoginApp.jsx',
    '../../../components/dashboard/App.jsx',
    '../../../components/dashboard/ConnectModal.jsx',
    '../supabase/middleware.ts',
  ]) {
    const source = read(file);
    assert.ok(!/^import [^;]*connect\/intent\.mjs/m.test(source), `${file} imports the registry statically`);
    assert.ok(!/^import [^;]*connect\/providers\.mjs/m.test(source), `${file} imports the registry statically`);
  }
});
