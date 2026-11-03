import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autofillLookupRow, logAutofillLookup } from './autofill-log.ts';

const USER = '00000000-0000-0000-0000-000000000001';

test('a found answer keeps its source and lowercased hosts', () => {
  const row = autofillLookupRow(USER, {
    surface: 'connect_modal',
    domain: 'Example.COM',
    source: 'srv',
    imapHost: 'IMAP.Migadu.com.',
    smtpHost: 'smtp.migadu.com',
  });
  assert.equal(row?.domain, 'example.com');
  assert.equal(row?.source, 'srv');
  assert.equal(row?.imap_host, 'imap.migadu.com');
  assert.equal(row?.smtp_host, 'smtp.migadu.com');
  assert.equal(row?.kind, null);
});

test('nothing found is source none with no hosts', () => {
  const row = autofillLookupRow(USER, { surface: 'onboarding', domain: 'example.org', source: 'none', kind: 'imap' });
  assert.equal(row?.source, 'none');
  assert.equal(row?.imap_host, null);
  assert.equal(row?.kind, 'imap');
});

test('an unknown source is stored as none, not passed to the check constraint', () => {
  assert.equal(autofillLookupRow(USER, { surface: 'onboarding', domain: 'a.io', source: 'bogus' })?.source, 'none');
  assert.equal(autofillLookupRow(USER, { surface: 'onboarding', domain: 'a.io', source: 'timeout' })?.source, 'timeout');
});

test('no row without a user or a domain', () => {
  assert.equal(autofillLookupRow('', { surface: 'onboarding', domain: 'a.io', source: 'mx' }), null);
  assert.equal(autofillLookupRow(USER, { surface: 'onboarding', domain: ' ', source: 'mx' }), null);
});

test('logAutofillLookup inserts the row and swallows a failing client', async () => {
  const inserted: unknown[] = [];
  const ok = () => ({ from: (table: string) => ({ insert: async (row: unknown) => { inserted.push([table, row]); return { error: null }; } }) });
  await logAutofillLookup(ok as never, USER, { surface: 'connect_modal', domain: 'a.io', source: 'mx', imapHost: 'imap.a.io' });
  assert.equal(inserted.length, 1);
  assert.equal((inserted[0] as [string])[0], 'inbox_autofill_lookups');

  const warn = console.warn;
  console.warn = () => {};
  try {
    await logAutofillLookup(() => { throw new Error('no env'); }, USER, { surface: 'connect_modal', domain: 'a.io', source: 'mx' });
  } finally {
    console.warn = warn;
  }
});
