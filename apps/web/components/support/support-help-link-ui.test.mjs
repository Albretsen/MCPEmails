// ---------------------------------------------------------------------------
// SupportHelpLink: the "Help & support" link on error pages and the footer.
//
// Run with: npm run test:support-entry-points
//
// SUPPORT_RELEASE_GATE. In v1 the link appears only for visitors the server
// says may see /help (`GET /api/support/visibility` answers 204). The
// component must make NO request at all for a visitor without a Supabase auth
// cookie or the preview cookie (every signed-out marketing page view), and
// must render nothing unless the answer is 204.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

installDom();

const { SupportHelpLink, mightSeeSupport, SUPPORT_VISIBILITY_CACHE_KEY } = await import('./SupportHelpLink.jsx');

/** Remove every cookie jsdom holds for this document. */
function clearCookies() {
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0].trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

async function render(t, { cookie = null, status = 204, props = {} } = {}) {
  clearCookies();
  window.sessionStorage.clear();
  if (cookie) document.cookie = `${cookie}; path=/`;
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push([String(url), init]);
    return { ok: status >= 200 && status < 300, status };
  };
  const view = await mount(createElement(SupportHelpLink, props));
  t.after(async () => {
    await view.unmount();
    globalThis.fetch = previousFetch;
    clearCookies();
    window.sessionStorage.clear();
  });
  // Let the effect and any reply settle.
  await flush(() => new Promise((resolve) => setTimeout(resolve, 20)));
  return { view, calls };
}

const link = (view) => view.container.querySelector('a');

test('no cookies: no request, nothing rendered', async (t) => {
  const { view, calls } = await render(t);
  assert.equal(calls.length, 0);
  assert.equal(link(view) === null, true);
  assert.equal(view.container.innerHTML, '');
});

test('unrelated cookies only: still no request', async (t) => {
  const { view, calls } = await render(t, { cookie: 'mcpe-locale=nb' });
  assert.equal(calls.length, 0);
  assert.equal(link(view) === null, true);
});

test('Supabase auth cookie + 204: one probe, then the link', async (t) => {
  const { view, calls } = await render(t, { cookie: 'sb-abcdefghij-auth-token=base64-xyz', status: 204 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/support/visibility');
  const a = await waitFor(() => link(view), { message: 'the help link' });
  assert.equal(a.getAttribute('href'), '/help');
  assert.equal(a.textContent, 'Help & support');
  assert.equal(window.sessionStorage.getItem(SUPPORT_VISIBILITY_CACHE_KEY), '1');
});

test('preview cookie + 204: the link, with a caller-supplied label', async (t) => {
  const { view, calls } = await render(t, {
    cookie: 'mcpe_support_preview=signed.token',
    props: { label: 'Hjelp og kundestøtte', href: '/nb/help' },
  });
  assert.equal(calls.length, 1);
  const a = await waitFor(() => link(view), { message: 'the help link' });
  assert.equal(a.getAttribute('href'), '/nb/help');
  assert.equal(a.textContent, 'Hjelp og kundestøtte');
});

test('auth cookie + 404: probe made, nothing rendered, answer cached', async (t) => {
  const { view, calls } = await render(t, { cookie: 'sb-abcdefghij-auth-token.0=chunk', status: 404 });
  assert.equal(calls.length, 1);
  assert.equal(link(view) === null, true);
  assert.equal(window.sessionStorage.getItem(SUPPORT_VISIBILITY_CACHE_KEY), '0');
});

test('a cached answer is used without a second request', async (t) => {
  clearCookies();
  window.sessionStorage.clear();
  document.cookie = 'sb-abcdefghij-auth-token=x; path=/';
  window.sessionStorage.setItem(SUPPORT_VISIBILITY_CACHE_KEY, '1');
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 204 }; };
  const view = await mount(createElement(SupportHelpLink));
  t.after(async () => {
    await view.unmount();
    globalThis.fetch = previousFetch;
    clearCookies();
    window.sessionStorage.clear();
  });
  const a = await waitFor(() => link(view), { message: 'the cached link' });
  assert.equal(a.getAttribute('href'), '/help');
  assert.equal(calls.length, 0);
});

test('a network failure renders nothing', async (t) => {
  clearCookies();
  window.sessionStorage.clear();
  document.cookie = 'sb-abcdefghij-auth-token=x; path=/';
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  const view = await mount(createElement(SupportHelpLink));
  t.after(async () => {
    await view.unmount();
    globalThis.fetch = previousFetch;
    clearCookies();
    window.sessionStorage.clear();
  });
  await flush(() => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(link(view) === null, true);
  assert.equal(window.sessionStorage.getItem(SUPPORT_VISIBILITY_CACHE_KEY) === null, true);
});

test('mightSeeSupport: cookie-name matching', () => {
  assert.equal(mightSeeSupport(''), false);
  assert.equal(mightSeeSupport(undefined), false);
  assert.equal(mightSeeSupport('sb-x-auth-token=1'), true);
  assert.equal(mightSeeSupport('a=1; sb-x-auth-token.1=2'), true);
  assert.equal(mightSeeSupport('mcpe_support_preview=t'), true);
  assert.equal(mightSeeSupport('sb-x-other=1; xsb-auth-token=1'), false);
  assert.equal(mightSeeSupport('a=sb-x-auth-token'), false, 'a value is not a name');
});
