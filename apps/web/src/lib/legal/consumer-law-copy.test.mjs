import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANCEL_COPY } from '../../../app/[locale]/cancel/content.mjs';
import { WITHDRAWAL_COPY } from '../../../app/[locale]/withdrawal/content.mjs';

/**
 * The consumer-law copy: /cancel, /withdrawal, and the strings in messages/
 * that carry a legal promise (VAT status, courts, class waiver, the in-app
 * pay button). Every locale must say the same thing as English, with the same
 * {tokens}, and none may slip back to the wording the 2026-10-20 audit
 * removed.
 */

const here = dirname(fileURLToPath(import.meta.url));
const messagesDir = join(here, '../../../messages');
const LOCALES = ['en', 'nb', 'es', 'fr', 'zh'];

function leaves(value, path = '', out = new Map()) {
  if (Array.isArray(value)) value.forEach((v, i) => leaves(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) leaves(v, path ? `${path}.${k}` : k, out);
  } else out.set(path, value);
  return out;
}
const tokens = (s) => [...(s.match(/\{\w+\}/g) ?? [])].sort();
const messages = (locale, ns) => JSON.parse(readFileSync(join(messagesDir, locale, `${ns}.json`), 'utf8'));

for (const [name, copy] of [['cancel', CANCEL_COPY], ['withdrawal', WITHDRAWAL_COPY]]) {
  test(`${name}: every locale exists and mirrors English`, () => {
    assert.deepEqual(Object.keys(copy).sort(), [...LOCALES].sort());
    const en = leaves(copy.en);
    for (const locale of LOCALES.filter((l) => l !== 'en')) {
      const tr = leaves(copy[locale]);
      assert.deepEqual([...tr.keys()].sort(), [...en.keys()].sort(), `${name}/${locale}: key structure differs`);
      let changed = 0;
      for (const [path, enValue] of en) {
        const value = tr.get(path);
        assert.equal(typeof value, 'string', `${name}/${locale} ${path}`);
        assert.ok(value.trim(), `${name}/${locale} ${path} is empty`);
        assert.deepEqual(tokens(value), tokens(enValue), `${name}/${locale} ${path}: tokens differ`);
        if (value !== enValue) changed++;
      }
      assert.ok(changed > en.size * 0.8, `${name}/${locale} looks untranslated`);
    }
  });

  test(`${name}: no em dash and no angle bracket in any string`, () => {
    for (const locale of LOCALES) {
      for (const [path, value] of leaves(copy[locale])) {
        assert.ok(!value.includes('—'), `${name}/${locale} ${path} has an em dash`);
        assert.ok(!/[<>]/.test(value), `${name}/${locale} ${path} has an angle bracket`);
      }
    }
  });
}

test('the withdrawal notice names the contact details and the online form in every locale', () => {
  for (const locale of LOCALES) {
    const notice = WITHDRAWAL_COPY[locale].notice.paras.join(' ');
    for (const token of ['{entity}', '{address}', '{email}', '{cancelLink}']) {
      assert.ok(notice.includes(token), `${locale} notice is missing ${token}`);
    }
    assert.equal(WITHDRAWAL_COPY[locale].form.lines.length, 8, `${locale} model form`);
  }
});

// Albretsen AS has applied for MVA registration but it is not confirmed. Until
// it is, no locale may print a VAT number or claim VAT registration. When
// Skatteetaten confirms it, flip these two checks back to requiring {vatNumber}.
const VAT_CLAIM = /\{vatNumber\}|Merverdiavgiftsregister|MVA-nummer|VAT (number|register)|TVA|IVA|增值税/;

test('terms: no VAT claim, no ODR link, courts and class waiver limited to businesses', () => {
  for (const locale of LOCALES) {
    const t = messages(locale, 'terms');
    assert.ok(!VAT_CLAIM.test(t.agreement.p1b), `${locale} p1b claims VAT registration`);
    assert.ok(!/odr/i.test(JSON.stringify(t)), `${locale} still links the EU ODR platform`);
    assert.ok(t.governingLaw.p93.includes('<withdrawal>') && t.governingLaw.p93.includes('<cancel>'), `${locale} p93 links`);
  }
  const en = messages('en', 'terms').governingLaw;
  assert.match(en.p92, /^If you use the Service as a business/);
  assert.match(en.p92, /If you are a consumer/);
  assert.match(en.p95, /^If you use the Service as a business/);
  assert.match(en.p95, /does not apply to consumers/);
});

test('privacy: no VAT claim in any locale', () => {
  for (const locale of LOCALES) {
    assert.ok(!VAT_CLAIM.test(messages(locale, 'privacy').whoWeAre.p4), locale);
  }
});

test('the legal entity is Albretsen AS everywhere, with no sole-proprietorship wording left', () => {
  const OLD = /Albretsen Consulting|926 646 753|enkeltpersonforetak|sole proprietor|entreprise individuelle|empresa individual|独资/;
  for (const locale of LOCALES) {
    for (const ns of ['terms', 'privacy', 'about', 'security', 'home']) {
      const raw = JSON.stringify(messages(locale, ns));
      assert.ok(!OLD.test(raw), `${locale}/${ns} still names the old entity`);
    }
    assert.match(messages(locale, 'home').footer.legalEntity, /Albretsen AS.*938 702 373/, `${locale} footer`);
    assert.match(messages(locale, 'about').trusting.entityOrgNo, /938 702 373$/, `${locale} about`);
  }
});

test('the in-app plan change button states the obligation to pay in every locale', () => {
  const pay = { en: /pay/i, nb: /betal/i, es: /pagar/i, fr: /payer/i, zh: /付款/ };
  for (const locale of LOCALES) {
    assert.match(messages(locale, 'dashboard').billing.confirmChange, pay[locale], locale);
  }
});

test('footer: withdrawal, cancellation and Impressum links in every locale', () => {
  for (const locale of LOCALES) {
    const f = messages(locale, 'home').footer;
    for (const key of ['linkWithdrawal', 'linkCancel', 'linkImpressum']) {
      assert.equal(typeof f[key], 'string', `${locale} footer.${key}`);
    }
  }
});
