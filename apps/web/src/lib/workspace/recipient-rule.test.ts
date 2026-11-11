// The recipient rule's list parsing (src/lib/workspace/recipient-rule.ts).
// Run: npm run test:recipient-rule
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_ALLOWED_RECIPIENT_DOMAINS,
  parseRecipientDomains,
  storedRecipientDomains,
} from './recipient-rule.ts';

test('a comma-separated string: trimmed, lower-cased, @ and trailing dot dropped, de-duplicated', () => {
  assert.deepEqual(parseRecipientDomains(' Example.com, @partner.co.uk ;sales.example.com.  example.com '), {
    ok: true,
    domains: ['example.com', 'partner.co.uk', 'sales.example.com'],
  });
});

test('a list works the same way', () => {
  assert.deepEqual(parseRecipientDomains(['A.com', 'b.no']), { ok: true, domains: ['a.com', 'b.no'] });
});

test('empty, blank, null and an empty list all mean any recipient', () => {
  for (const v of ['', '  , ,', null, undefined, []]) {
    assert.deepEqual(parseRecipientDomains(v), { ok: true, domains: null }, String(v));
  }
});

test('punycode passes', () => {
  assert.deepEqual(parseRecipientDomains('xn--bcher-kva.de, xn--fiqs8s.xn--fiqz9s'), {
    ok: true,
    domains: ['xn--bcher-kva.de', 'xn--fiqs8s.xn--fiqz9s'],
  });
});

test('anything that is not a domain name is refused, naming it', () => {
  for (const bad of ['localhost', 'a@b.com', 'http://x.com', '*.example.com', '-a.com', 'a-.com', 'a..com', 'exa mple.com x', '.com', 'example.c']) {
    const r = parseRecipientDomains(bad);
    assert.equal(r.ok, false, bad);
  }
  const r = parseRecipientDomains('ok.com, not a domain!');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /is not a domain name/);
});

test('wrong types are refused', () => {
  for (const v of [42, { a: 1 }, ['ok.com', 3], true]) assert.equal(parseRecipientDomains(v).ok, false);
});

test('at most the CHECK constraint ceiling', () => {
  const list = Array.from({ length: MAX_ALLOWED_RECIPIENT_DOMAINS + 1 }, (_, i) => `d${i}.com`);
  assert.equal(parseRecipientDomains(list).ok, false);
  assert.equal(parseRecipientDomains(list.slice(1)).ok, true);
});

test('storedRecipientDomains: null or a non-empty list', () => {
  assert.equal(storedRecipientDomains(null), null);
  assert.equal(storedRecipientDomains([]), null);
  assert.deepEqual(storedRecipientDomains(['a.com']), ['a.com']);
});
