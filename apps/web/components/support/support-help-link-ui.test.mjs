// ---------------------------------------------------------------------------
// SupportHelpLink: the "Help & support" link on the error pages.
//
// Run with: npm run test:support-entry-points
//
// A plain link for every visitor, signed in or not: it renders at once and
// makes no request.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount } from '../../scripts/test-dom.mjs';

installDom();

const { SupportHelpLink } = await import('./SupportHelpLink.jsx');

async function render(t, props = {}) {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200 };
  };
  const view = await mount(createElement(SupportHelpLink, props));
  t.after(async () => {
    await view.unmount();
    globalThis.fetch = previousFetch;
  });
  return { view, calls };
}

const link = (view) => view.container.querySelector('a');

test('signed out, no cookies: the link to /help, no request', async (t) => {
  const { view, calls } = await render(t);
  const a = link(view);
  assert.equal(a === null, false);
  assert.equal(a.getAttribute('href'), '/help');
  assert.equal(a.textContent, 'Help & support');
  assert.equal(calls.length, 0);
});

test('a caller-supplied label and href', async (t) => {
  const { view } = await render(t, { label: 'Hjelp og kundestøtte', href: '/nb/help' });
  const a = link(view);
  assert.equal(a.getAttribute('href'), '/nb/help');
  assert.equal(a.textContent, 'Hjelp og kundestøtte');
});

test('a caller-supplied LinkComponent renders the link', async (t) => {
  const LinkComponent = ({ href, children }) => createElement('a', { href, 'data-custom': '1' }, children);
  const { view } = await render(t, { LinkComponent });
  const a = link(view);
  assert.equal(a.getAttribute('data-custom'), '1');
  assert.equal(a.getAttribute('href'), '/help');
});
