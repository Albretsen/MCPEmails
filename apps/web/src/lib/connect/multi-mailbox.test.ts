import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS } from './providers.mjs';
import { MULTI_MAILBOX_CATEGORIES, multiMailboxFaq, showsMultiMailbox, withProvider } from './multi-mailbox.mjs';
import { PLANS } from '../stripe/plans.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOCALES = ['en', 'es', 'fr', 'nb', 'zh'];
const copy = (locale: string) =>
  JSON.parse(readFileSync(path.join(here, 'multi-mailbox', `${locale}.json`), 'utf8')) as Record<string, string>;

const EM_DASH = new RegExp('[' + String.fromCharCode(0x2014, 0x2015) + ']');
const BANNED_CLAIMS = /exchange online|soc\s*-?\s*2|data residency|enterprise|hipaa|iso\s*27001|gdpr[- ]compliant/i;
const PRICE = /[$€£¥]\s*\d|\d\s*[$€£¥]/;

test('exactly the business, hosting, cPanel and self-hosted pages carry the block', () => {
  const shown = PROVIDERS.filter((p) => showsMultiMailbox(p)).map((p) => p.slug);
  for (const p of PROVIDERS) {
    const expected = MULTI_MAILBOX_CATEGORIES.includes(p.category) && p.status === 'supported';
    assert.equal(shown.includes(p.slug), expected, p.slug);
  }
  // The pages the business segment actually lands on.
  for (const slug of ['ionos', 'zoho', 'namecheap', 'strato', 'migadu', 'office365', 'google-workspace']) {
    assert.ok(shown.includes(slug), `${slug} should carry the block`);
  }
  // Consumer pages and the generic IMAP page (which has its own persona link) do not.
  for (const slug of ['gmail', 'yahoo', 'icloud', 'aol', 'imap']) {
    assert.equal(shown.includes(slug), false, `${slug} should not carry the block`);
  }
  assert.equal(showsMultiMailbox(null), false);
  assert.equal(showsMultiMailbox({ category: 'hosting', status: 'blocked' }), false);
});

test('every locale has the same keys, filled, and actually translated', () => {
  const english = copy('en');
  for (const locale of LOCALES) {
    const c = copy(locale);
    assert.deepEqual(Object.keys(c).sort(), Object.keys(english).sort(), locale);
    for (const [key, value] of Object.entries(c)) {
      assert.ok(value.trim().length > 0, `${locale} ${key} is empty`);
      if (locale !== 'en') assert.notEqual(value, english[key], `${locale} ${key} is still English`);
    }
  }
});

test('the provider name is filled into the title, the body and the FAQ, in every locale', () => {
  for (const locale of LOCALES) {
    const c = copy(locale);
    for (const key of ['title', 'body', 'faqQ', 'faqA']) {
      assert.ok(c[key].includes('{provider}'), `${locale} ${key} lost its {provider}`);
    }
    const faq = multiMailboxFaq(c, 'IONOS');
    assert.ok(faq.q.includes('IONOS') && !faq.q.includes('{provider}'), locale);
    assert.ok(faq.a.includes('IONOS') && !faq.a.includes('{provider}'), locale);
    // No ICU syntax: this copy is filled by plain replacement.
    for (const value of Object.values(c)) {
      assert.ok(!/\{(?!provider\})/.test(value), `${locale}: unexpected brace in "${value}"`);
    }
  }
  assert.equal(withProvider('{provider} and {provider}', 'STRATO'), 'STRATO and STRATO');
});

test('no em dash, no claim the product cannot back, and no price to go stale', () => {
  for (const locale of LOCALES) {
    for (const [key, value] of Object.entries(copy(locale))) {
      assert.ok(!EM_DASH.test(value), `${locale} ${key} has an em dash`);
      assert.ok(!BANNED_CLAIMS.test(value), `${locale} ${key} makes a banned claim`);
      assert.ok(!PRICE.test(value), `${locale} ${key} quotes a price`);
    }
  }
});

test('the inbox counts quoted are the plan catalogue\'s', () => {
  assert.equal(PLANS.free.limits.maxInboxes, 1);
  assert.equal(PLANS.personal.limits.maxInboxes, 3);
  assert.equal(PLANS.solo.limits.maxInboxes, Infinity);
  const en = copy('en');
  for (const text of [en.plans, en.faqA]) {
    assert.match(text, /Free connects one mailbox, Personal three, and Pro every mailbox you run/);
  }
});
