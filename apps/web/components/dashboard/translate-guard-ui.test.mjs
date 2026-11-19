// ---------------------------------------------------------------------------
// public/dom-guard.js: the connect modal keeps working while Chrome Translate
// has rewritten its text, and a certificate-name failure says so.
//
// Run with: npm run test:translate-guard-ui
//
// Chrome Translate replaces each text node with <font><font>...</font></font>.
// Without the guard, React's next removeChild/insertBefore on an original node
// throws NotFoundError and the whole tree unmounts (the user sees the error
// page). The first test proves the crash is real; the second that the guard
// fixes it.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

installDom();
globalThis.self ??= globalThis.window;
window.HTMLElement.prototype.scrollIntoView ??= function scrollIntoView() {};
globalThis.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { ConnectModal, resetConnectCheckMemoryForTests } = await import('./ConnectModal.jsx');
const { ToastProvider } = await import('./Toast.jsx');
const chrome = (await import('../../messages/en/dashboardChrome.json', { with: { type: 'json' } })).default;

const CERT_FAILURE = {
  error: "The server's security certificate is for *.fsi.pl, not mail.example.pl. Enter the server name your provider gives for mail.",
  error_code: 'tls_handshake_failed',
  host: 'mail.example.pl',
  phase: 'tls',
  cert_host: '*.fsi.pl',
  via_relay: false,
  relay_failed: false,
};

function stubFetch(t) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.startsWith('/api/inboxes/')) return { ok: false, status: 422, json: async () => CERT_FAILURE };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  t.after(() => { globalThis.fetch = previous; });
}

/** What Chrome Translate does to every text node under `root`. */
function translate(root) {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4);
  const nodes = [];
  while (walker.nextNode()) if (walker.currentNode.nodeValue.trim()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const outer = doc.createElement('font');
    const inner = doc.createElement('font');
    inner.textContent = node.nodeValue;
    outer.appendChild(inner);
    node.parentNode.replaceChild(outer, node);
  }
  return nodes.length;
}

const buttonNamed = (view, text) => [...view.container.querySelectorAll('button')].find((b) => b.textContent.trim() === text) ?? null;
const q = (view, selector) => view.container.querySelector(selector);

async function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await flush(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

async function translatedFailedConnect(t) {
  resetConnectCheckMemoryForTests();
  stubFetch(t);
  const view = await mount(createElement(AppLocaleProvider, null, createElement(ToastProvider, null,
    createElement(ConnectModal, {
      reconnect: null, onClose: () => {}, onConnect: () => {}, preselect: { card: 'generic' }, atInboxLimit: false,
      planName: 'Free', inboxCount: 0, maxInboxes: null, stripePrices: null, businessShaped: false, onAdminConsentLink: () => {},
    }))));
  t.after(async () => { try { await view.unmount(); } catch { /* the unguarded run is already gone */ } });
  await flush(async () => { buttonNamed(view, chrome.connect.enterCredentials).click(); });
  await waitFor(() => q(view, '#cm-imap-host'), { message: 'the credentials form' });
  await type(q(view, '#cm-email'), 'someone@example.pl');
  await type(q(view, '#cm-imap-host'), 'mail.example.pl');
  await type(q(view, '#cm-smtp-host'), 'mail.example.pl');
  await type(q(view, '#cm-password'), 'secret');
  assert.ok(translate(view.container) > 5, 'the page was translated');
  let thrown = null;
  try {
    await flush(async () => { buttonNamed(view, chrome.connect.connectInbox).click(); });
    await waitFor(() => q(view, '.cm-fix'), { message: 'the fix panel', timeout: 2000 });
  } catch (error) {
    thrown = String(error?.name ?? error);
  }
  return { view, thrown };
}

test('without the guard, a translated page crashes on a failed connect', async (t) => {
  const { view, thrown } = await translatedFailedConnect(t);
  assert.notEqual(thrown, null);
  assert.equal(q(view, '.cm-fix'), null);
});

test('with the guard, the translated page shows the certificate fix', async (t) => {
  // The guard runs in Node's global scope here; give it the browser's ErrorEvent.
  globalThis.ErrorEvent ??= window.ErrorEvent;
  window.eval(readFileSync(new URL('../../public/dom-guard.js', import.meta.url), 'utf8'));
  assert.equal(window.Node.prototype.__mcpeGuard, 1);
  const reports = [];
  window.addEventListener('error', (e) => reports.push(e.message));
  const { view, thrown } = await translatedFailedConnect(t);
  assert.equal(thrown, null);
  const panel = q(view, '.cm-fix');
  assert.equal(panel?.getAttribute('data-fix-row'), 'tls_cert_name');
  assert.equal(panel.textContent.includes('*.fsi.pl'), true);
  assert.equal(view.container.textContent.includes(chrome.connect.errorCertNameShort), true);
  await waitFor(() => reports.length > 0 || null, { message: 'a dom_guard report', timeout: 1000 });
  assert.equal(reports.some((m) => String(m).startsWith('dom_guard:')), true, 'the recovery is reported once');
});
