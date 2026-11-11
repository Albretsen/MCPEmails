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

test('recipientRuleAuditDetails: a diff of at most 15 per list, with counts, that fits the 16 KB row at the longest domains', async () => {
  const { recipientRuleAuditDetails, AUDIT_DOMAINS_PER_LIST } = await import('./recipient-rule.ts');
  // 100 domains of 251 characters each, all replaced: the worst case.
  const long = (i: number) => `${'a'.repeat(57)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${String(i).padStart(3, '0')}${'d'.repeat(54)}.example`;
  const before = Array.from({ length: 100 }, (_, i) => long(i));
  const after = Array.from({ length: 100 }, (_, i) => long(i + 100));
  const d = recipientRuleAuditDetails(before, after);
  assert.equal((d.to as string[]).length, AUDIT_DOMAINS_PER_LIST);
  assert.equal(d.to_count, 100);
  assert.equal(d.added_more, 85);
  assert.equal(d.removed_more, 85);
  assert.ok(Buffer.byteLength(JSON.stringify(d)) < 16384, `${Buffer.byteLength(JSON.stringify(d))} bytes`);
  assert.deepEqual(recipientRuleAuditDetails(null, ['a.com']), { to: ['a.com'], to_count: 1, added: ['a.com'], removed: [] });
  assert.deepEqual(recipientRuleAuditDetails(['a.com', 'b.com'], ['b.com', 'c.com']), {
    to: ['b.com', 'c.com'], to_count: 2, added: ['c.com'], removed: ['a.com'],
  });
});
