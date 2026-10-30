// ---------------------------------------------------------------------------
// The account-deletion confirmation: every locale has every line, the dates
// are right, and the copy follows the house rules.
//
// Run: npm run test:account-deleted-email
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  ACCOUNT_DELETED_LOCALES,
  accountDeletedCopy,
  accountDeletedLocale,
  buildAccountDeletedEmail,
} = await import('./account-deleted.ts');

const deletedAt = new Date('2026-10-30T10:00:00Z');

test('every locale renders the address, both dates and the support address', () => {
  for (const locale of ACCOUNT_DELETED_LOCALES) {
    const email = buildAccountDeletedEmail({ email: 'owner@example.test', deletedAt, locale, support: 'support@example.test' });
    assert.ok(email.subject.length > 0, locale);
    assert.ok(email.text.includes('owner@example.test'), locale);
    assert.ok(email.text.includes('support@example.test'), locale);
    assert.ok(email.text.includes('2026'), locale);
    assert.ok(email.html.includes(`lang="${locale}"`), locale);
  }
  const en = buildAccountDeletedEmail({ email: 'o@example.test', deletedAt, locale: 'en' });
  assert.match(en.text, /deleted on 30 October 2026/);
  assert.match(en.text, /erased by 29 November 2026/);
});

test('copy rules: no em dash, no angle bracket, no "30 days", MCPEmails as one word', () => {
  for (const locale of ACCOUNT_DELETED_LOCALES) {
    const c = accountDeletedCopy(locale);
    const all = [c.subject, c.greeting, c.deleted('a@b.c', 'd'), c.immediate, c.rest('d'), c.payments, c.notYou('s'), c.signoff].join(' ');
    assert.ok(!all.includes('—'), `${locale}: em dash`);
    assert.ok(!/[<>]/.test(all), `${locale}: angle bracket`);
    assert.ok(!/30/.test(all), `${locale}: a day count`);
    assert.ok(!/MCP Emails/.test(all), `${locale}: brand`);
  }
});

test('html escapes the address', () => {
  const email = buildAccountDeletedEmail({ email: 'a"<b>@example.test', deletedAt, locale: 'en' });
  assert.ok(!email.html.includes('<b>'));
});

test('locale mapping: region tags, Norwegian variants, junk', () => {
  assert.equal(accountDeletedLocale('fr-CA'), 'fr');
  assert.equal(accountDeletedLocale('no'), 'nb');
  assert.equal(accountDeletedLocale('nn'), 'nb');
  assert.equal(accountDeletedLocale('xx'), null);
  assert.equal(accountDeletedLocale(''), null);
  assert.equal(accountDeletedLocale(42), null);
});
