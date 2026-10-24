// ---------------------------------------------------------------------------
// The referral program's copy, in every locale.
//
// Run with: npm run test:referral-ui
//
// Covers dashboard.referral, the sidebar entry, the home banner and Terms 5.8:
// every locale has every key with the same {tokens} as English, and none says
// "30 days" (the refund window is 14 days and the Free reward is "a month"),
// mentions an action cap, uses an em dash or an angle bracket, or spells the
// product as anything but MCPEmails.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const LOCALES = ['en', 'nb', 'es', 'fr', 'zh', 'de'];
const read = (locale, ns) => JSON.parse(readFileSync(join(here, '../../messages', locale, `${ns}.json`), 'utf8'));

function referralCopy(locale) {
  const terms = read(locale, 'terms').plansAndPayment;
  return {
    dashboard: read(locale, 'dashboard').referral,
    nav: read(locale, 'dashboardChrome').sidebar.navInvite,
    banner: read(locale, 'home').referralBanner,
    terms: { h58: terms.h58, p58a: terms.p58a, p58b: terms.p58b, p58c: terms.p58c },
  };
}

function leaves(value, path = '', out = new Map()) {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) leaves(v, path ? `${path}.${k}` : k, out);
  } else out.set(path, value);
  return out;
}
const tokens = (s) => [...(String(s).match(/\{\w+\}/g) ?? [])].sort();

test('every locale has every referral key, with the same tokens as English', () => {
  const en = leaves(referralCopy('en'));
  for (const locale of LOCALES) {
    const tr = leaves(referralCopy(locale));
    assert.deepEqual([...tr.keys()].sort(), [...en.keys()].sort(), `${locale}: keys`);
    for (const [path, enValue] of en) {
      const value = tr.get(path);
      assert.equal(typeof value, 'string', `${locale} ${path}`);
      assert.ok(value.trim(), `${locale} ${path} is empty`);
      assert.deepEqual(tokens(value), tokens(enValue), `${locale} ${path}: tokens`);
    }
  }
});

test('no em dash, no angle bracket, no "30 days", no action caps, MCPEmails one word', () => {
  const THIRTY = /\b30\s*(days?|dager|días|jours|Tage[n]?)\b|30\s*天/i;
  const CAPS = /\baction(s)?\b.*\b(cap|limit)|\bhandlingsgrense|\blímite de acciones|\blimite d'actions|\bAktionslimit|操作上限/i;
  for (const locale of LOCALES) {
    for (const [path, value] of leaves(referralCopy(locale))) {
      assert.ok(!value.includes('—'), `${locale} ${path}: em dash`);
      assert.ok(!/[<>]/.test(value), `${locale} ${path}: angle bracket`);
      assert.ok(!THIRTY.test(value), `${locale} ${path}: says 30 days`);
      assert.ok(!CAPS.test(value), `${locale} ${path}: mentions action caps`);
      assert.ok(!/MCP Emails|Mcpemails|mcpemails(?!\.com)/.test(value), `${locale} ${path}: brand spelling`);
      assert.ok(!/[‘’]/.test(value), `${locale} ${path}: curly apostrophe`);
    }
  }
});

test('plan names are tokens, never raw slugs', () => {
  for (const locale of LOCALES) {
    for (const [path, value] of leaves(referralCopy(locale))) {
      assert.ok(!/\b(solo|pro_month|personal_month)\b/.test(value), `${locale} ${path}: raw plan slug`);
    }
  }
  const en = referralCopy('en');
  assert.deepEqual(tokens(en.dashboard.howPaid), ['{free}', '{personal}']);
  assert.deepEqual(tokens(en.terms.p58b), ['{cap}', '{free}', '{personal}']);
});
