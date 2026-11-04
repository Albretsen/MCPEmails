import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { constants } from 'node:crypto';
import { LEGACY_RENEGOTIATION_HOSTS, legacyTlsOptions } from './legacy-tls.ts';

test('docomo hosts get legacy server connect, and nothing else changes', () => {
  for (const host of ['imap.spmode.ne.jp', 'imap2.spmode.ne.jp', 'smtp.spmode.ne.jp', ' IMAP.SPMODE.NE.JP. ']) {
    const options = legacyTlsOptions(host);
    assert.deepEqual(Object.keys(options), ['secureOptions'], host);
    assert.equal(options.secureOptions, constants.SSL_OP_LEGACY_SERVER_CONNECT, host);
  }
});

test('every other host, including lookalikes and subdomains, gets no extra option', () => {
  for (const host of [
    'imap.gmail.com',
    'imap.mail.yahoo.co.jp',
    'spmode.ne.jp',
    'imap3.spmode.ne.jp',
    'evil.imap.spmode.ne.jp',
    'imap.spmode.ne.jp.evil.example',
    'imap-spmode.ne.jp',
    '49.102.153.233',
    '',
    null,
    undefined,
  ]) {
    assert.deepEqual(legacyTlsOptions(host), {}, String(host));
  }
  assert.deepEqual([...LEGACY_RENEGOTIATION_HOSTS].sort(), ['imap.spmode.ne.jp', 'imap2.spmode.ne.jp', 'smtp.spmode.ne.jp']);
});

test('every TLS connect in the web mail clients passes the option and keeps certificate checks on', () => {
  const dir = new URL('./', import.meta.url);
  for (const file of ['validate-imap.ts', 'validate-smtp.ts', 'imap.ts']) {
    const source = readFileSync(new URL(file, dir), 'utf8');
    const connects = source.match(/tls\.connect\(/g) ?? [];
    assert.ok(connects.length > 0, file);
    assert.equal((source.match(/legacyTlsOptions\(/g) ?? []).length, connects.length, `${file}: every tls.connect spreads legacyTlsOptions`);
    assert.equal(/rejectUnauthorized:\s*false/.test(source), false, `${file} must never turn certificate checks off`);
  }
});
