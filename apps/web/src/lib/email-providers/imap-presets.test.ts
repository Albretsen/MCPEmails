import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAP_PRESETS,
  isBrandedImapService,
  portForSecurity,
  securityForPort,
  normalizeAppPassword,
} from './imap-presets.ts';

test('security and port stay paired on the standard ports', () => {
  assert.equal(portForSecurity('imap', 'tls'), 993);
  assert.equal(portForSecurity('imap', 'starttls'), 143);
  assert.equal(portForSecurity('smtp', 'tls'), 465);
  assert.equal(portForSecurity('smtp', 'starttls'), 587);

  assert.equal(securityForPort('imap', 993), 'tls');
  assert.equal(securityForPort('imap', 143), 'starttls');
  assert.equal(securityForPort('smtp', 465), 'tls');
  assert.equal(securityForPort('smtp', 587), 'starttls');
});

test('a non-standard port implies nothing, so the user choice stands', () => {
  // Returning a default here would silently overwrite a deliberate setting on
  // hosts that serve IMAP somewhere unusual.
  assert.equal(securityForPort('imap', 1993), null);
  assert.equal(securityForPort('smtp', 2525), null);
  // The two protocols must not borrow each other's ports: 465 is SMTP's
  // implicit-TLS port and carries no meaning for IMAP.
  assert.equal(securityForPort('imap', 465), null);
  assert.equal(securityForPort('smtp', 993), null);
});

test('app passwords survive the ways they get copied', () => {
  // Google displays four space-separated blocks.
  assert.equal(normalizeAppPassword('abcd efgh ijkl mnop'), 'abcdefghijklmnop');
  // Trailing newline from a copy, non-breaking space from a rendered page,
  // and a zero-width space from a PDF or a password manager.
  assert.equal(normalizeAppPassword('abcdefgh\n'), 'abcdefgh');
  assert.equal(normalizeAppPassword('abcd efgh'), 'abcdefgh');
  assert.equal(normalizeAppPassword('abcd​efgh﻿'), 'abcdefgh');
  assert.equal(normalizeAppPassword('\tabcd efgh '), 'abcdefgh');
});

test('hyphens are preserved because Apple app-specific passwords contain them', () => {
  assert.equal(normalizeAppPassword('abcd-efgh-ijkl-mnop'), 'abcd-efgh-ijkl-mnop');
});

test('normalization leaves an already-clean credential untouched', () => {
  assert.equal(normalizeAppPassword('xkcd1234correct'), 'xkcd1234correct');
  assert.equal(normalizeAppPassword(''), '');
});

test('Gmail is a branded IMAP service on its documented transports', () => {
  // The whole point of the app-password path is that it never touches OAuth,
  // so it has to be reachable as a branded service: `isBrandedImapService` is
  // the connect route's gate, and a false here answers 422 "Unsupported
  // provider" for every Gmail connection.
  assert.equal(isBrandedImapService('gmail'), true);

  const gmail = IMAP_PRESETS.gmail;
  assert.equal(gmail.imapHost, 'imap.gmail.com');
  assert.equal(gmail.imapPort, 993);
  assert.equal(gmail.smtpHost, 'smtp.gmail.com');
  assert.equal(gmail.smtpPort, 465);
  assert.equal(gmail.smtpSecurity, 'tls');
  // 587/STARTTLS is Google's other documented submission transport. It is not
  // configured here on purpose: transport-autodetect retries it on its own
  // when 465 never yields a session, and pinning it would give up implicit
  // TLS for every account to serve the networks that block 465.
  assert.equal(portForSecurity('smtp', 'starttls'), 587);
});

test('every branded preset pairs its port with its security mode', () => {
  for (const preset of Object.values(IMAP_PRESETS)) {
    assert.equal(preset.imapPort, portForSecurity('imap', 'tls'), preset.service);
    assert.equal(preset.smtpPort, portForSecurity('smtp', preset.smtpSecurity), preset.service);
  }
});
