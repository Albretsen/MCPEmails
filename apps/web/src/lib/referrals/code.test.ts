import assert from 'node:assert/strict';
import test from 'node:test';

import { CODE_ALPHABET, CODE_LENGTH } from './constants.ts';
import { generateReferralCode, normalizeReferralCode } from './code.ts';

test('the alphabet is 31 characters with no look-alikes', () => {
  assert.equal(CODE_ALPHABET.length, 31);
  assert.equal(new Set(CODE_ALPHABET).size, 31);
  for (const ch of '0O1IL') assert.ok(!CODE_ALPHABET.includes(ch), ch);
  assert.equal(CODE_LENGTH, 8);
});

test('generated codes are eight alphabet characters', () => {
  for (let i = 0; i < 200; i += 1) {
    const code = generateReferralCode();
    assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    assert.equal(normalizeReferralCode(code), code);
  }
});

test('injected bytes give a deterministic code', () => {
  const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i);
  assert.equal(generateReferralCode(bytes), CODE_ALPHABET.slice(0, 8));
  assert.equal(generateReferralCode(bytes), generateReferralCode(bytes));
});

test('bytes at or above 248 are rejected, not folded onto the alphabet', () => {
  // 248..255 would map to the first eight characters under a plain modulo.
  let calls = 0;
  const bytes = (n: number) => {
    calls += 1;
    return calls === 1
      ? Uint8Array.from({ length: n }, (_, i) => (i < 8 ? 248 + i : 30))
      : new Uint8Array(n).fill(30);
  };
  assert.equal(generateReferralCode(bytes), '99999999');
});

test('every byte below 248 maps uniformly: each character from exactly 8 values', () => {
  const counts = new Map<string, number>();
  for (let b = 0; b < 248; b += 1) {
    const code = generateReferralCode(n => new Uint8Array(n).fill(b));
    counts.set(code[0], (counts.get(code[0]) ?? 0) + 1);
  }
  assert.equal(counts.size, 31);
  for (const n of counts.values()) assert.equal(n, 8);
});

test('a source that never yields a usable byte throws instead of looping', () => {
  assert.throws(() => generateReferralCode(n => new Uint8Array(n).fill(255)));
});

test('normalization forgives case, spaces and dashes', () => {
  assert.equal(normalizeReferralCode('abcd-efgh'), 'ABCDEFGH');
  assert.equal(normalizeReferralCode('  ABCD EFGH '), 'ABCDEFGH');
  assert.equal(normalizeReferralCode('ab-cd ef-gh'), 'ABCDEFGH');
  assert.equal(normalizeReferralCode('k7m2-p9q3'), 'K7M2P9Q3');
});

test('normalization refuses look-alikes, wrong lengths and non-strings', () => {
  for (const bad of ['ABCDEFG0', 'ABCDEFGO', 'ABCDEFG1', 'ABCDEFGI', 'ABCDEFGL', 'abcdefgl']) {
    assert.equal(normalizeReferralCode(bad), null, bad);
  }
  assert.equal(normalizeReferralCode('ABCDEFG'), null);
  assert.equal(normalizeReferralCode('ABCDEFGHJ'), null);
  assert.equal(normalizeReferralCode(''), null);
  assert.equal(normalizeReferralCode('ABCD_EFGH'), null);
  assert.equal(normalizeReferralCode(null), null);
  assert.equal(normalizeReferralCode(12345678), null);
});
