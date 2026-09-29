// ---------------------------------------------------------------------------
// Marketing consent: the record of what people agreed to.
//
// Run with: npm run test:marketing-consent
//
// The two drift checks here are the point. Consent is only provable if the
// version stored on a user row maps to the words that were on the screen, so:
//   * the English checkbox text in messages/en/auth.json must equal the wording
//     recorded for the CURRENT version (change the copy, and this fails until a
//     new version is added), and
//   * the versions the database accepts must be exactly the versions this
//     module has wording for.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MARKETING_CONSENT_COOKIE,
  MARKETING_CONSENT_VERSION,
  MARKETING_CONSENT_WORDING,
  clearConsentCookieString,
  consentCookieString,
  consentVersionFromCookieHeader,
  isKnownConsentVersion,
  rememberOAuthConsent,
  signupConsentMetadata,
} from './marketing-consent.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../..');
const repoRoot = path.resolve(webRoot, '../..');
const LOCALES = ['en', 'es', 'fr', 'nb', 'zh'];

function authMessages(locale) {
  return JSON.parse(readFileSync(path.join(webRoot, 'messages', locale, 'auth.json'), 'utf8'));
}

test('the English checkbox text is exactly the wording recorded for the current version', () => {
  assert.equal(
    authMessages('en').signup.marketingConsent,
    MARKETING_CONSENT_WORDING[MARKETING_CONSENT_VERSION],
    'The signup checkbox copy changed. Add a new version to MARKETING_CONSENT_WORDING (never edit an old one), point MARKETING_CONSENT_VERSION at it, and allow it in a new migration.',
  );
});

test('every locale has the checkbox and the terms/privacy line, with both links', () => {
  for (const locale of LOCALES) {
    const { signup } = authMessages(locale);
    assert.equal(typeof signup.marketingConsent, 'string', `${locale}: signup.marketingConsent`);
    assert.ok(signup.marketingConsent.length > 0, `${locale}: signup.marketingConsent is empty`);
    assert.match(signup.legalNotice, /<terms>[^<]+<\/terms>/, `${locale}: legalNotice needs <terms>`);
    assert.match(signup.legalNotice, /<privacy>[^<]+<\/privacy>/, `${locale}: legalNotice needs <privacy>`);
    for (const text of [signup.marketingConsent, signup.legalNotice]) {
      assert.ok(!text.includes('—'), `${locale}: no em dashes in signup copy`);
    }
  }
});

test('the versions the database accepts are exactly the versions with recorded wording', () => {
  const dir = path.join(repoRoot, 'supabase', 'migrations');
  const sql = readdirSync(dir)
    .filter((f) => f.includes('marketing_consent'))
    .sort()
    .map((f) => readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
  // The LAST definition wins, as it does when the migrations run in order.
  const check = [...sql.matchAll(/users_marketing_consent_source_known\s+CHECK\s*\([^)]*IN\s*\(([^)]*)\)/g)].at(-1);
  assert.ok(check, 'could not find the users_marketing_consent_source_known CHECK');
  const inDb = [...check[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(inDb, Object.keys(MARKETING_CONSENT_WORDING).sort());
});

test('an unticked box sends no consent keys at all; a ticked one sends the version', () => {
  assert.deepEqual(signupConsentMetadata(false), {});
  assert.deepEqual(signupConsentMetadata(undefined), {});
  assert.deepEqual(signupConsentMetadata('true'), {}, 'only a real boolean true counts');
  assert.deepEqual(signupConsentMetadata(true), {
    marketing_consent: true,
    marketing_consent_version: MARKETING_CONSENT_VERSION,
  });
  assert.ok(!('marketing_consent_at' in signupConsentMetadata(true)), 'the browser never sends a timestamp');
});

test('version check accepts only recorded versions', () => {
  assert.equal(isKnownConsentVersion(MARKETING_CONSENT_VERSION), true);
  assert.equal(isKnownConsentVersion('signup_checkbox_v99'), false);
  assert.equal(isKnownConsentVersion('__proto__'), false);
  assert.equal(isKnownConsentVersion(null), false);
});

test('the OAuth cookie is scoped to /auth, short-lived, and Secure on https', () => {
  const set = consentCookieString({ secure: true });
  assert.match(set, new RegExp(`^${MARKETING_CONSENT_COOKIE}=${MARKETING_CONSENT_VERSION};`));
  assert.match(set, /Path=\/auth;/);
  assert.match(set, /Max-Age=900;/);
  assert.match(set, /SameSite=Lax; Secure$/);
  assert.doesNotMatch(consentCookieString({ secure: false }), /Secure/);
  assert.match(clearConsentCookieString({ secure: true }), /Max-Age=0;/);
});

test('rememberOAuthConsent sets the cookie only for a ticked box and clears it otherwise', () => {
  const doc = { cookie: '' };
  rememberOAuthConsent(true, doc, { protocol: 'https:' });
  assert.match(doc.cookie, /Max-Age=900/);
  rememberOAuthConsent(false, doc, { protocol: 'https:' });
  assert.match(doc.cookie, /Max-Age=0/);
  rememberOAuthConsent('yes', doc, { protocol: 'https:' });
  assert.match(doc.cookie, /Max-Age=0/, 'anything but true clears');
});

test('the callback reads only a known version from the Cookie header', () => {
  assert.equal(consentVersionFromCookieHeader(null), null);
  assert.equal(consentVersionFromCookieHeader(''), null);
  assert.equal(consentVersionFromCookieHeader('sb-access=abc; theme=dark'), null);
  assert.equal(
    consentVersionFromCookieHeader(`sb-access=abc; ${MARKETING_CONSENT_COOKIE}=${MARKETING_CONSENT_VERSION}; x=1`),
    MARKETING_CONSENT_VERSION,
  );
  assert.equal(consentVersionFromCookieHeader(`${MARKETING_CONSENT_COOKIE}=signup_checkbox_v99`), null);
  assert.equal(consentVersionFromCookieHeader(`${MARKETING_CONSENT_COOKIE}=`), null);
  assert.equal(consentVersionFromCookieHeader(`x${MARKETING_CONSENT_COOKIE}=${MARKETING_CONSENT_VERSION}`), null);
});
