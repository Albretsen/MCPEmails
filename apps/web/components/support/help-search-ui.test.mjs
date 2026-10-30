// ---------------------------------------------------------------------------
// HelpSearch, rendered for real: combobox semantics and keyboard use.
//
// Run with: node --test --experimental-strip-types --import ./scripts/register-dom-tests.mjs components/support/help-search-ui.test.mjs
//
// Pins that the box is a combobox owning a listbox of options, that Up/Down
// move the active option through aria-activedescendant, that Enter opens it
// through the same path as a click, and that an empty result shows the
// contact link.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush } from '../../scripts/test-dom.mjs';

installDom();

const { default: HelpSearch } = await import('./HelpSearch.jsx');

const INDEX = [
  { id: 'article:connect-gmail', kind: 'article', title: 'Connect Gmail', hint: 'Paste an app password', href: '#article-connect-gmail', terms: 'gmail google' },
  { id: 'provider:gmail', kind: 'provider', title: 'Gmail', hint: 'Webmail', href: '/connect/gmail', terms: 'googlemail' },
  { id: 'provider:yahoo', kind: 'provider', title: 'Yahoo Mail', hint: 'Webmail', href: '/connect/yahoo', terms: 'rocketmail' },
];
const COPY = { label: 'Search help', placeholder: 'Search', empty: 'No match.', emptyLink: 'Write to us', kinds: {} };

async function render(t, props = {}) {
  const view = await mount(createElement(HelpSearch, { index: INDEX, copy: COPY, ...props }));
  t.after(() => view.unmount());
  return view;
}

const input = (view) => view.container.querySelector('#help-search-input');

async function type(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await flush(async () => {
    setter.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

async function key(el, k) {
  await flush(async () => {
    el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}

test('the box is a combobox that owns a listbox of options', async (t) => {
  const view = await render(t);
  const box = input(view);
  assert.equal(box.getAttribute('role'), 'combobox');
  assert.equal(box.getAttribute('aria-expanded'), 'false');
  await type(box, 'gmail');
  assert.equal(box.getAttribute('aria-expanded'), 'true');
  const list = view.container.querySelector(`#${box.getAttribute('aria-controls')}`);
  assert.equal(list?.getAttribute('role'), 'listbox');
  const options = [...list.querySelectorAll('[role="option"]')];
  assert.equal(options.length, 2);
  assert.equal(options.every((o) => o.getAttribute('aria-selected') === 'false'), true);
  assert.equal(box.hasAttribute('aria-activedescendant'), false);
});

test('Up and Down move the active option and wrap around', async (t) => {
  const view = await render(t);
  const box = input(view);
  await type(box, 'gmail');
  const options = () => [...view.container.querySelectorAll('[role="option"]')];
  await key(box, 'ArrowDown');
  assert.equal(box.getAttribute('aria-activedescendant'), options()[0].id);
  assert.equal(options()[0].getAttribute('aria-selected'), 'true');
  await key(box, 'ArrowDown');
  assert.equal(box.getAttribute('aria-activedescendant'), options()[1].id);
  await key(box, 'ArrowDown');
  assert.equal(box.getAttribute('aria-activedescendant'), options()[0].id, 'wraps to the first');
  await key(box, 'ArrowUp');
  assert.equal(box.getAttribute('aria-activedescendant'), options()[1].id, 'wraps to the last');
});

test('typing again resets the active option', async (t) => {
  const view = await render(t);
  const box = input(view);
  await type(box, 'gmail');
  await key(box, 'ArrowDown');
  await type(box, 'gmai');
  assert.equal(box.hasAttribute('aria-activedescendant'), false);
});

test('Enter opens the active option through onSelect', async (t) => {
  const picked = [];
  const view = await render(t, { onSelect: (entry) => { picked.push(entry.id); return true; } });
  const box = input(view);
  await type(box, 'gmail');
  await key(box, 'ArrowDown');
  await key(box, 'Enter');
  assert.equal(picked.join(','), 'article:connect-gmail');
  assert.equal(input(view).value, '', 'the box is cleared');
  assert.equal(input(view).getAttribute('aria-expanded'), 'false');
});

test('a filler-only query shows the contact link, not the list', async (t) => {
  const view = await render(t);
  await type(input(view), 'help');
  assert.equal(view.container.querySelectorAll('[role="option"]').length, 0);
  assert.equal(view.container.querySelector('.help-empty a')?.getAttribute('href'), '#contact');
});
