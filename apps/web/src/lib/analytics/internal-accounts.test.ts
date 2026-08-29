import test from 'node:test';
import assert from 'node:assert/strict';
import { isInternalAccount, internalAccountMatchers } from './internal-accounts.ts';

process.env.GROWTH_INTERNAL_EMAILS = 'owner@gmail.com, Second.Person@Example.com';

test('an address we own is internal, whatever its case or padding', () => {
  assert.equal(isInternalAccount('owner@gmail.com'), true);
  assert.equal(isInternalAccount('  OWNER@Gmail.com  '), true);
  assert.equal(isInternalAccount('second.person@example.com'), true);
});

test('a plus-tagged alias of a listed address is the same person', () => {
  assert.equal(isInternalAccount('owner+test@gmail.com'), true);
  assert.equal(isInternalAccount('owner+kiosk-probe@gmail.com'), true);
});

test('a plus tag does not make an unlisted address internal', () => {
  assert.equal(isInternalAccount('customer+test@gmail.com'), false);
  assert.equal(isInternalAccount('+test@gmail.com'), false);
});

test('gmail dot aliasing is not emulated, because it would merge real people', () => {
  assert.equal(isInternalAccount('ow.ner@gmail.com'), false);
});

test('our own domains are internal outright', () => {
  assert.equal(isInternalAccount('anyone@mcpemails.com'), true);
  assert.equal(isInternalAccount('anyone@mcpemails.dev'), true);
});

test('everyone else is external, and nothing throws on rubbish', () => {
  assert.equal(isInternalAccount('kirill@unconditional.studio'), false);
  assert.equal(isInternalAccount(null), false);
  assert.equal(isInternalAccount(''), false);
  assert.equal(isInternalAccount('not-an-email'), false);
});

test('the SQL matchers carry both halves of the rule', () => {
  const matchers = internalAccountMatchers();
  assert.ok(matchers.emails.includes('owner@gmail.com'));
  assert.ok(matchers.domains.includes('@mcpemails.com'));
});
