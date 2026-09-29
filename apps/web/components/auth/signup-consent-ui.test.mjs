// ---------------------------------------------------------------------------
// The signup form's marketing-consent checkbox: the WIRING.
//
// Run with: npm run test:signup-consent-ui
//
// marketing-consent.test.mjs proves the helpers. This renders the real
// SignupApp with the real English messages and checks what a person would
// actually cause: the box starts unticked, an unticked signup sends no consent
// keys to Supabase, a ticked one sends them (and never a timestamp), and the
// OAuth cookie is set only when the box is ticked. `@/lib/supabase/client` is
// mocked below (the jsx hooks already point it at a stub with no signUp), so
// the signUp call lands in this file and nothing leaves the process.
//
// Only reserved example domains appear below.
// ---------------------------------------------------------------------------

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush } from '../../scripts/test-dom.mjs';

const window = installDom();

let onSignUp = null;
mock.module(new URL('../../scripts/test-stubs/supabase-client.mjs', import.meta.url).href, {
  namedExports: {
    createClient: () => ({
      auth: {
        signUp: async (params) => onSignUp(params),
        getUser: async () => ({ data: { user: null }, error: null }),
      },
    }),
  },
});
const { NextIntlClientProvider } = await import('next-intl');
const { SignupApp } = await import('./SignupApp.jsx');
const auth = (await import('../../messages/en/auth.json', { with: { type: 'json' } })).default;
const { MARKETING_CONSENT_COOKIE, MARKETING_CONSENT_VERSION } = await import('../../src/lib/marketing-consent.mjs');

// jsdom does not navigate; the OAuth handlers assign location.href, which
// would otherwise print "Not implemented: navigation" for every click.
window._virtualConsole?.removeAllListeners?.('jsdomError');

async function render(t) {
  const calls = [];
  onSignUp = async (params) => {
    calls.push(params);
    return { data: { user: null, session: null }, error: null };
  };
  const view = await mount(
    createElement(NextIntlClientProvider, { locale: 'en', messages: { auth } }, createElement(SignupApp)),
  );
  t.after(async () => {
    onSignUp = null;
    await view.unmount();
    document.cookie = `${MARKETING_CONSENT_COOKIE}=; Path=/auth; Max-Age=0`;
  });
  return { ...view, calls };
}

function setInput(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

async function submitPasswordSignup(container) {
  await flush(() => {
    setInput(container.querySelector('#signup-email'), 'person@example.com');
    setInput(container.querySelector('#signup-password'), 'correct-horse-battery');
  });
  await flush(() => {
    container.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
}

// The cookie is Path=/auth and the test document lives at /dashboard, so
// document.cookie cannot read it back. Record what the component WRITES.
function captureCookieWrites(t) {
  const writes = [];
  const original = Object.getOwnPropertyDescriptor(window.Document.prototype, 'cookie');
  Object.defineProperty(window.document, 'cookie', {
    configurable: true,
    get: () => original.get.call(window.document),
    set: (v) => { writes.push(v); original.set.call(window.document, v); },
  });
  t.after(() => { delete window.document.cookie; });
  return writes;
}

// A real click, the way a person ticks it: jsdom flips `checked` and fires the
// event React's onChange listens to. (Setting `.checked` by hand first, as
// test-dom's toggle() does, updates React's value tracker too, so a controlled
// checkbox sees "no change" and its state never moves.)
async function tick(box) {
  await flush(() => box.click());
}

function googleButton(container) {
  return [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Google'));
}

test('the consent checkbox is rendered, labelled, and unticked by default', async (t) => {
  const { container } = await render(t);
  const box = container.querySelector('#signup-marketing-consent');
  assert.ok(box, 'checkbox is rendered');
  assert.equal(box.type, 'checkbox');
  assert.equal(box.checked, false, 'must start unticked');
  assert.equal(box.defaultChecked, false);
  const label = container.querySelector('label[for="signup-marketing-consent"]');
  assert.ok(label, 'checkbox has a <label for>');
  assert.equal(label.textContent.trim(), auth.signup.marketingConsent);
  const links = [...container.querySelectorAll('.auth-legal a')].map((a) => a.getAttribute('href'));
  assert.deepEqual(links, ['/terms', '/privacy']);
});

test('an unticked signup sends no consent to the server', async (t) => {
  const { container, calls } = await render(t);
  await submitPasswordSignup(container);
  assert.equal(calls.length, 1, 'signUp was called once');
  const data = calls[0].options.data;
  assert.ok(!('marketing_consent' in data), 'no marketing_consent key');
  assert.ok(!('marketing_consent_version' in data), 'no version key');
  assert.equal(calls[0].email, 'person@example.com');
});

test('a ticked signup sends the consent flag and version, never a timestamp', async (t) => {
  const { container, calls } = await render(t);
  await tick(container.querySelector('#signup-marketing-consent'));
  assert.equal(container.querySelector('#signup-marketing-consent').checked, true);
  await submitPasswordSignup(container);
  assert.equal(calls.length, 1);
  const data = calls[0].options.data;
  assert.equal(data.marketing_consent, true);
  assert.equal(data.marketing_consent_version, MARKETING_CONSENT_VERSION);
  assert.ok(!Object.keys(data).some((k) => k.endsWith('_at')), 'the client never sends a consent time');
});

test('ticking then unticking sends no consent', async (t) => {
  const { container, calls } = await render(t);
  const box = container.querySelector('#signup-marketing-consent');
  await tick(box);
  await tick(box);
  assert.equal(box.checked, false);
  await submitPasswordSignup(container);
  assert.ok(!('marketing_consent' in calls[0].options.data));
});

test('Google without the box ticked only clears the consent cookie', async (t) => {
  const writes = captureCookieWrites(t);
  const { container } = await render(t);
  const google = googleButton(container);
  assert.ok(google, 'Google button is rendered');
  writes.length = 0;
  await flush(() => google.click());
  assert.ok(writes.length > 0, 'the click wrote the cookie state');
  assert.ok(writes.every((c) => c.includes('Max-Age=0')), 'an unticked click never sets consent');
});

test('Google with the box ticked sets the consent cookie', async (t) => {
  const writes = captureCookieWrites(t);
  const { container } = await render(t);
  await tick(container.querySelector('#signup-marketing-consent'));
  writes.length = 0;
  await flush(() => googleButton(container).click());
  const last = writes.at(-1);
  assert.ok(last, 'a cookie was written');
  assert.match(last, new RegExp(`^${MARKETING_CONSENT_COOKIE}=${MARKETING_CONSENT_VERSION};`));
  assert.match(last, /Path=\/auth/);
  assert.match(last, /Max-Age=900/);
});
