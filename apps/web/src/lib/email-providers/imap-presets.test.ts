import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
