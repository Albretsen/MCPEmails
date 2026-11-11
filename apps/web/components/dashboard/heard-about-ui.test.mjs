// ---------------------------------------------------------------------------
// Overview > "How did you hear about MCPEmails?": the WIRING.
//
// Run with: npm run test:heard-about-ui
//
// lib/onboarding/heard-about.test.mjs proves the rules. This renders the real
// HeardAboutCard with English messages, stubs only `fetch`, and checks:
//   - nothing for a member, before the first inbox, or once answered;
//   - one click on an option hides the card and POSTs that answer;
//   - Dismiss hides it and POSTs { dismiss: true };
//   - Other opens a text field and Send POSTs the text;
//   - every locale has every key, without '<' or an em dash.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush } from '../../scripts/test-dom.mjs';

installDom();

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { HeardAboutCard } = await import('./HeardAboutCard.jsx');
const en = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;
const H = en.heardAbout;

function stubFetch(t) {
  const requests = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  t.after(() => { globalThis.fetch = previous; });
  return requests;
}

async function render(t, props = {}) {
  const view = await mount(createElement(AppLocaleProvider, null, createElement(HeardAboutCard, {
    pending: true,
    inboxCount: 1,
    isOwner: true,
    ...props,
  })));
  t.after(() => view.unmount());
  return view;
}

const shown = (view) => Boolean(view.container.querySelector('[data-heard-about]'));
const buttonByText = (view, text) => [...view.container.querySelectorAll('button')].find((b) => b.textContent.trim() === text);

function keysOf(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) => (v && typeof v === 'object' ? keysOf(v, `${prefix}${k}.`) : [`${prefix}${k}`])).sort();
}

test('every locale has every heardAbout key, without < or an em dash', async () => {
  const want = keysOf(H);
  for (const locale of ['en', 'nb', 'es', 'fr', 'de', 'pt', 'ja', 'zh']) {
    const messages = (await import(`../../messages/${locale}/dashboard.json`, { with: { type: 'json' } })).default;
    assert.deepEqual(keysOf(messages.heardAbout ?? {}), want, `${locale} has the same keys`);
    const text = JSON.stringify(messages.heardAbout);
    assert.equal(text.includes('<'), false, `${locale}: no literal <`);
    assert.equal(text.includes('—'), false, `${locale}: no em dash`);
    assert.equal(/MCP Emails|mcpemails(?!\.)/.test(text), false, `${locale}: MCPEmails, one word`);
  }
});

test('hidden for a member, before the first inbox, and once answered', async (t) => {
  stubFetch(t);
  assert.equal(shown(await render(t, { isOwner: false })), false);
  assert.equal(shown(await render(t, { inboxCount: 0 })), false);
  assert.equal(shown(await render(t, { pending: false })), false);
  assert.equal(shown(await render(t)), true);
});

test('one click on an option answers and hides the card', async (t) => {
  const requests = stubFetch(t);
  const view = await render(t);
  assert.equal(view.container.querySelectorAll('button').length, 10, 'nine options and Dismiss');
  await flush(() => buttonByText(view, H.options.claude).click());
  assert.equal(shown(view), false);
  assert.deepEqual(requests, [{ url: '/api/onboarding/heard-about', method: 'POST', body: { answer: 'claude' } }]);
});

test('Dismiss hides the card and saves the dismissal', async (t) => {
  const requests = stubFetch(t);
  const view = await render(t);
  await flush(() => buttonByText(view, H.dismiss).click());
  assert.equal(shown(view), false);
  assert.deepEqual(requests.map((r) => r.body), [{ dismiss: true }]);
});

test('Other opens a text field; Send saves the text', async (t) => {
  const requests = stubFetch(t);
  const view = await render(t);
  await flush(() => buttonByText(view, H.options.other).click());
  assert.equal(requests.length, 0, 'opening Other saves nothing yet');
  const input = view.container.querySelector('[data-heard-other]');
  assert.equal(input.getAttribute('maxlength'), '200');
  const setter = Object.getOwnPropertyDescriptor(globalThis.window.HTMLInputElement.prototype, 'value').set;
  await flush(() => {
    setter.call(input, 'a podcast');
    input.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }));
  });
  await flush(() => buttonByText(view, H.send).click());
  assert.equal(shown(view), false);
  assert.deepEqual(requests.map((r) => r.body), [{ answer: 'other', other: 'a podcast' }]);
});
