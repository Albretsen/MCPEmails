import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SSO_VERIFICATION_TXT_PREFIX,
  checkSsoDomain,
  hasSsoVerificationRecord,
  ssoVerificationRecord,
} from './domains.ts';

// Only reserved example domains, plus public consumer mail services.

const TOKEN = '0123456789abcdef0123456789abcdef';

test('a company domain is accepted and normalised like the database trigger', () => {
  assert.deepEqual(checkSsoDomain('  Company-SSO.Example. '), { ok: true, domain: 'company-sso.example' });
  assert.deepEqual(checkSsoDomain('Person@Company-SSO.example'), { ok: true, domain: 'company-sso.example' });
});

test('consumer mail domains are refused, including brand families and subdomains', () => {
  for (const domain of ['gmail.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com',
    'yahoo.com', 'yahoo.co.jp', 'Yahoo.FR', 'hotmail.no', 'eu.icloud.com', 'someone@proton.me']) {
    assert.deepEqual(checkSsoDomain(domain), { ok: false, reason: 'consumer' }, domain);
  }
});

test('a brand word inside a company domain is not a consumer domain', () => {
  assert.equal(checkSsoDomain('yahoo.company-sso.example').ok, true);
  assert.equal(checkSsoDomain('livestock.example').ok, true);
});

test('anything that is not a domain is invalid', () => {
  for (const input of ['', 'localhost', '10.0.0.1', 'not a domain', '-bad.example', undefined, 42, null]) {
    assert.deepEqual(checkSsoDomain(input), { ok: false, reason: 'invalid' }, String(input));
  }
});

test('the TXT record value is the prefix plus the token', () => {
  assert.equal(SSO_VERIFICATION_TXT_PREFIX, 'mcpemails-verification=');
  assert.equal(ssoVerificationRecord(TOKEN), `mcpemails-verification=${TOKEN}`);
});

test('verification matches an exact record, joining chunked TXT strings', () => {
  assert.equal(hasSsoVerificationRecord([['v=spf1 -all'], [`mcpemails-verification=${TOKEN}`]], TOKEN), true);
  assert.equal(hasSsoVerificationRecord([['mcpemails-verification=', TOKEN]], TOKEN), true);
  assert.equal(hasSsoVerificationRecord([` mcpemails-verification=${TOKEN} `], TOKEN), true);
});

test('verification refuses near misses', () => {
  const other = 'ffffffffffffffffffffffffffffffff';
  assert.equal(hasSsoVerificationRecord([], TOKEN), false);
  assert.equal(hasSsoVerificationRecord([[`mcpemails-verification=${other}`]], TOKEN), false);
  assert.equal(hasSsoVerificationRecord([[`x mcpemails-verification=${TOKEN}`]], TOKEN), false);
  assert.equal(hasSsoVerificationRecord([[`mcpemails-verification=${TOKEN}x`]], TOKEN), false);
  assert.equal(hasSsoVerificationRecord([[TOKEN]], TOKEN), false);
  // An empty or malformed token never matches, even a record with the bare prefix.
  assert.equal(hasSsoVerificationRecord([['mcpemails-verification=']], ''), false);
});
