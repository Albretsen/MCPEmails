import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDomainVerificationRecord, type TxtResolver } from './dns-verify.ts';

// The resolver is always a stub: these tests never touch DNS.

const TOKEN = '0123456789abcdef0123456789abcdef';
const RECORD = `mcpemails-verification=${TOKEN}`;

function stub(answer: string[][] | Error): { resolve: TxtResolver; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    resolve: async (domain) => {
      asked.push(domain);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

function dnsError(code: string): Error {
  return Object.assign(new Error(`query failed: ${code}`), { code });
}

test('verifies when the exact record is among the TXT records, and asks for the exact domain', async () => {
  const s = stub([['v=spf1 include:_spf.example.net ~all'], [RECORD], ['google-site-verification=abc']]);
  assert.deepEqual(await checkDomainVerificationRecord('company-sso.example', TOKEN, s.resolve), { verified: true });
  assert.deepEqual(s.asked, ['company-sso.example']);
});

test('joins a record split into 255-byte chunks before comparing', async () => {
  const s = stub([[RECORD.slice(0, 10), RECORD.slice(10)]]);
  assert.deepEqual(await checkDomainVerificationRecord('company-sso.example', TOKEN, s.resolve), { verified: true });
});

test('a record for another token, or one that only contains ours, is not proof', async () => {
  const other = `mcpemails-verification=${'f'.repeat(32)}`;
  for (const records of [[[other]], [[`x${RECORD}`]], [[`${RECORD} trailing`]], [[TOKEN]]]) {
    assert.deepEqual(
      await checkDomainVerificationRecord('company-sso.example', TOKEN, stub(records).resolve),
      { verified: false, reason: 'record_missing' },
      JSON.stringify(records),
    );
  }
});

test('no TXT records at all, or a name that does not exist, is "no_txt_records"', async () => {
  assert.deepEqual(
    await checkDomainVerificationRecord('company-sso.example', TOKEN, stub([]).resolve),
    { verified: false, reason: 'no_txt_records' },
  );
  for (const code of ['ENODATA', 'ENOTFOUND']) {
    assert.deepEqual(
      await checkDomainVerificationRecord('company-sso.example', TOKEN, stub(dnsError(code)).resolve),
      { verified: false, reason: 'no_txt_records' },
      code,
    );
  }
});

test('a timeout or server failure is "lookup_failed", never verified', async () => {
  for (const code of ['ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED']) {
    assert.deepEqual(
      await checkDomainVerificationRecord('company-sso.example', TOKEN, stub(dnsError(code)).resolve),
      { verified: false, reason: 'lookup_failed' },
      code,
    );
  }
  assert.deepEqual(
    await checkDomainVerificationRecord('company-sso.example', TOKEN, stub(new Error('boom')).resolve),
    { verified: false, reason: 'lookup_failed' },
  );
});

test('a malformed token never verifies, even if DNS echoes it', async () => {
  const s = stub([['mcpemails-verification=']]);
  assert.deepEqual(
    await checkDomainVerificationRecord('company-sso.example', '', s.resolve),
    { verified: false, reason: 'record_missing' },
  );
});
