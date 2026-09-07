// ---------------------------------------------------------------------------
// The sender name is written straight into the From header by the MCP edge
// function, so the normaliser is a header-injection boundary. The cases that
// matter: a CRLF must never survive, angle brackets must never survive, and
// "clear" must round-trip as null rather than an empty string.
//
// Run: node --test --experimental-strip-types src/lib/inboxes/sender-name.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSenderName, SENDER_NAME_MAX_LENGTH } from './sender-name.ts';

test('plain name passes through unchanged', () => {
  assert.deepEqual(normalizeSenderName('Evancoe Bot'), { ok: true, value: 'Evancoe Bot' });
});

test('unicode name is preserved', () => {
  assert.deepEqual(normalizeSenderName('Åsgeir Ø'), { ok: true, value: 'Åsgeir Ø' });
});

test('CRLF header-injection attempt is flattened to one line', () => {
  const result = normalizeSenderName('Bot\r\nBcc: x@y.z');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value, 'BotBcc: x@y.z');
  assert.doesNotMatch(result.value ?? '', /[\r\n]/);
});

test('tabs and other control characters are stripped', () => {
  assert.deepEqual(normalizeSenderName('A\tB\u0000C\u001bD'), { ok: true, value: 'ABCD' });
});

test('angle brackets are stripped', () => {
  assert.deepEqual(
    normalizeSenderName('Bot <evil@example.com>'),
    { ok: true, value: 'Bot evil@example.com' },
  );
});

test('internal whitespace runs collapse to a single space', () => {
  assert.deepEqual(normalizeSenderName('  Evancoe   \n  Bot  '), { ok: true, value: 'Evancoe Bot' });
});

test('whitespace-only input clears the name (null)', () => {
  assert.deepEqual(normalizeSenderName('   \t\n '), { ok: true, value: null });
  assert.deepEqual(normalizeSenderName(''), { ok: true, value: null });
});

test('exactly the max length is accepted', () => {
  const name = 'a'.repeat(SENDER_NAME_MAX_LENGTH);
  assert.deepEqual(normalizeSenderName(name), { ok: true, value: name });
});

test('101 characters is rejected', () => {
  const result = normalizeSenderName('a'.repeat(SENDER_NAME_MAX_LENGTH + 1));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /100/);
});

test('length is measured after normalisation, so padding does not count', () => {
  const name = 'a'.repeat(SENDER_NAME_MAX_LENGTH);
  assert.deepEqual(normalizeSenderName(`   ${name}   `), { ok: true, value: name });
});

test('non-string input is rejected', () => {
  for (const bad of [null, undefined, 42, true, {}, ['Bot']]) {
    const result = normalizeSenderName(bad);
    assert.equal(result.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});
