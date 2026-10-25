import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flashDirection, flashTone, parseDisplayNumber } from './flash-math.ts';

test('parseDisplayNumber reads formatted figures', () => {
  assert.equal(parseDisplayNumber('1,234'), 1234);
  assert.equal(parseDisplayNumber('$1,234.50'), 1234.5);
  assert.equal(parseDisplayNumber('42%'), 42);
  assert.equal(parseDisplayNumber('—'), null);
});

test('flashDirection: unchanged text never flashes', () => {
  assert.equal(flashDirection('12', '12'), null);
});

test('flashDirection: numbers compare, everything else is just changed', () => {
  assert.equal(flashDirection('$120', '$129'), 'up');
  assert.equal(flashDirection('1,200', '999'), 'down');
  assert.equal(flashDirection('—', '3'), 'changed');
  assert.equal(flashDirection('Gmail', 'Outlook'), 'changed');
});

test('flashTone follows the tile’s good direction', () => {
  assert.equal(flashTone('up'), 'good');
  assert.equal(flashTone('down'), 'bad');
  assert.equal(flashTone('up', 'down'), 'bad');
  assert.equal(flashTone('down', 'down'), 'good');
  assert.equal(flashTone('changed', 'down'), 'warn');
});
