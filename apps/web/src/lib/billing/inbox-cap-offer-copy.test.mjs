// ---------------------------------------------------------------------------
// The business cap offer's COPY, in all five locales.
//
// Run with: npm run test:billing
//
// The rule (inbox-cap-offer.test.mjs) proves which keys are asked for. This
// file proves what those keys say, because the ways translated paywall copy
// goes wrong are all invisible to the rule: a key missing from one locale
// renders as a raw key path, a translator's "$50" sells a price Stripe will
// not charge, a copy-pasted English sentence ships in the Norwegian file, and
// an ICU special character renders literally in production (next-intl does not
// un-escape `'<'` the way the docs suggest).
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLANS } from '../stripe/plans.ts';
import { inboxCapOffer } from './inbox-cap-offer.mjs';

const LOCALES = ['en', 'es', 'fr', 'nb', 'zh'];

/** Every key this change added, by file. */
const NEW_KEYS = {
  'dashboardChrome.json': [
    'connect.businessUpgradeTitle',
    'connect.businessUpgradeBody',
    'connect.businessPersonalPitch',
    'connect.businessProPitch',
  ],
  'dashboard.json': ['inboxes.capBodyBusiness'],
};

function readMessages(locale, file) {
  return JSON.parse(
    readFileSync(new URL(`../../../messages/${locale}/${file}`, import.meta.url), 'utf8'),
  );
}

function lookup(messages, dottedKey) {
  return dottedKey.split('.').reduce((node, part) => node?.[part], messages);
}

/** [locale, file, key, value] for every new string. */
function everyNewString() {
  const rows = [];
  for (const locale of LOCALES) {
    for (const [file, keys] of Object.entries(NEW_KEYS)) {
      const messages = readMessages(locale, file);
      for (const key of keys) rows.push([locale, file, key, lookup(messages, key)]);
    }
  }
  return rows;
}

const dollars = cents => String(cents / 100);
const PERSONAL_PRICE = dollars(PLANS.personal.monthlyPriceCents); // "5"
const PRO_PRICE = dollars(PLANS.solo.monthlyPriceCents); // "15"

/** Whole-number match, so "15" does not count as quoting "5". */
function quotes(text, number) {
  return new RegExp(`(^|[^0-9])${number}([^0-9]|$)`).test(text);
}

test('the list of new keys is exactly what the business offer asks for', () => {
  // If the rule starts returning another new key, this file must learn it.
  const offer = inboxCapOffer(1, { businessShaped: true });
  const asked = new Set([
    offer.titleKey,
    offer.bodyKey,
    offer.noticeBodyKey,
    ...offer.offers.map(o => o.pitchKey),
  ]);
  const listed = new Set(Object.values(NEW_KEYS).flat());
  assert.deepEqual([...asked].sort(), [...listed].sort());
});

test('every new key exists in all five locales and is a non-empty string', () => {
  for (const [locale, file, key, value] of everyNewString()) {
    assert.equal(typeof value, 'string', `${locale}/${file}: ${key} is missing`);
    assert.ok(value.trim().length > 0, `${locale}/${file}: ${key} is empty`);
    assert.equal(value, value.trim(), `${locale}/${file}: ${key} has stray whitespace`);
  }
});

test('no new string contains an em dash, or any other long dash', () => {
  // U+2014 em dash, U+2013 en dash, U+2015 horizontal bar, U+2012 figure dash.
  for (const [locale, file, key, value] of everyNewString()) {
    assert.equal(/[‒-―]/.test(value), false, `${locale}/${file}: ${key} has a long dash`);
    assert.equal(value.includes('--'), false, `${locale}/${file}: ${key} has a double hyphen`);
  }
});

test('every non-English string is actually translated', () => {
  for (const [file, keys] of Object.entries(NEW_KEYS)) {
    const english = readMessages('en', file);
    for (const key of keys) {
      const seen = new Map([[lookup(english, key), 'en']]);
      for (const locale of LOCALES.filter(l => l !== 'en')) {
        const value = lookup(readMessages(locale, file), key);
        // Not equal to English, and not a copy of another locale either.
        assert.equal(
          seen.has(value),
          false,
          `${locale}/${file}: ${key} is identical to the ${seen.get(value)} string`,
        );
        seen.set(value, locale);
      }
    }
  }
});

test('Chinese is written in Chinese, and the others are not', () => {
  const han = /[一-鿿]/;
  for (const [locale, file, key, value] of everyNewString()) {
    assert.equal(han.test(value), locale === 'zh', `${locale}/${file}: ${key} is in the wrong script`);
  }
});

test('no ICU syntax: these strings take no arguments, and escapes render literally', () => {
  // `{` opens an argument, `<` opens a rich-text tag, and a doubled or
  // brace-adjacent apostrophe is an escape. None of these strings needs any of
  // that, and in production next-intl has rendered the escape itself.
  for (const [locale, file, key, value] of everyNewString()) {
    assert.equal(/[{}<>#|]/.test(value), false, `${locale}/${file}: ${key} has ICU syntax`);
    assert.equal(value.includes("''"), false, `${locale}/${file}: ${key} has a doubled apostrophe`);
  }
});

test('the prices quoted are the prices in plans.ts, in every locale', () => {
  assert.equal(PERSONAL_PRICE, '5');
  assert.equal(PRO_PRICE, '15');
  for (const locale of LOCALES) {
    const chrome = readMessages(locale, 'dashboardChrome.json');
    const dashboard = readMessages(locale, 'dashboard.json');

    const personalPitch = lookup(chrome, 'connect.businessPersonalPitch');
    assert.ok(quotes(personalPitch, PERSONAL_PRICE), `${locale}: Personal pitch must quote ${PERSONAL_PRICE}`);
    assert.equal(quotes(personalPitch, PRO_PRICE), false, `${locale}: Personal pitch quotes the Pro price`);

    const proPitch = lookup(chrome, 'connect.businessProPitch');
    assert.ok(quotes(proPitch, PRO_PRICE), `${locale}: Pro pitch must quote ${PRO_PRICE}`);
    assert.equal(quotes(proPitch, PERSONAL_PRICE), false, `${locale}: Pro pitch quotes the Personal price`);

    const notice = lookup(dashboard, 'inboxes.capBodyBusiness');
    assert.ok(quotes(notice, PERSONAL_PRICE), `${locale}: notice must quote ${PERSONAL_PRICE}`);
    assert.ok(quotes(notice, PRO_PRICE), `${locale}: notice must quote ${PRO_PRICE}`);
    // Personal before Pro, the same order as the buttons beside it.
    assert.ok(
      notice.indexOf('Personal') !== -1 && notice.indexOf('Personal') < notice.indexOf('Pro '),
      `${locale}: notice must name Personal before Pro`,
    );
  }
});

test('the only numbers in the new copy are the two prices', () => {
  // Personal's three inboxes are spelled out as a word in every locale, so any
  // other digit is a number nobody checked: a wrong price, a wrong cap, a
  // percentage that was never measured.
  const allowed = new Set([PERSONAL_PRICE, PRO_PRICE]);
  for (const [locale, file, key, value] of everyNewString()) {
    for (const number of value.match(/[0-9]+/g) ?? []) {
      assert.ok(allowed.has(number), `${locale}/${file}: ${key} quotes an unexpected number ${number}`);
    }
  }
});

test('the copy leads with the company-mailbox case', () => {
  // A role address ("info@", "post@") is what makes this the business copy
  // and not the consumer copy with a different key name.
  for (const locale of LOCALES) {
    const chrome = readMessages(locale, 'dashboardChrome.json');
    const dashboard = readMessages(locale, 'dashboard.json');
    for (const value of [
      lookup(chrome, 'connect.businessUpgradeBody'),
      lookup(chrome, 'connect.businessPersonalPitch'),
      lookup(dashboard, 'inboxes.capBodyBusiness'),
    ]) {
      assert.match(value, /[a-z]+@/, `${locale}: "${value}" names no company mailbox`);
    }
  }
});

test('the copy claims nothing the product does not have', () => {
  // Pro is ONE seat. There is no SOC 2 report, SSO and data residency are not
  // Pro features, and Outlook is on every plan, so it is not something the Pro
  // upgrade can sell. Checked in every locale, with the local words for
  // "team", "member" and "seat".
  const forbidden = [
    /outlook/i, /microsoft/i, /office\s?365/i, /\bm365\b/i, /soc\s?2/i, /\bsso\b/i,
    /resid/i, /\bseats?\b/i, /\bteams?\b/i, /\bmembers?\b/i, /\busers?\b/i,
    /equipo/i, /miembro/i, /usuario/i, /asiento/i,
    /équipe/i, /membre/i, /utilisateur/i, /siège/i,
    // Norwegian "bruker" is also the verb "uses", which the Pro pitch needs, so
    // only the unambiguous noun forms are listed.
    /\bmedlem/i, /\bbrukere\b/i, /\bbrukerne\b/i, /\blisens/i,
    /团队/, /成员/, /席位/, /用户/,
  ];
  for (const [locale, file, key, value] of everyNewString()) {
    for (const pattern of forbidden) {
      assert.equal(pattern.test(value), false, `${locale}/${file}: ${key} matches ${pattern}`);
    }
  }
});

test('the CONSUMER copy was not touched', () => {
  // The change is scoped to a segment. These are the sentences everybody else
  // still reads, pinned so an edit to the business copy cannot drift into them.
  const chrome = readMessages('en', 'dashboardChrome.json');
  const dashboard = readMessages('en', 'dashboard.json');
  assert.equal(
    lookup(chrome, 'connect.personalUpgradeBody'),
    'You were about to connect another inbox. Personal takes you to three for $5 a month: work, personal, and one more.',
  );
  assert.equal(lookup(chrome, 'connect.personalUpgradeTitle'), 'Personal connects three mailboxes');
  assert.equal(
    lookup(dashboard, 'inboxes.capBodyPersonal'),
    'Free connects one mailbox. Personal takes you to three for $5 a month, so work and personal can share the same agent.',
  );
});
