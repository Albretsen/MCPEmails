// ---------------------------------------------------------------------------
// The generic IMAP/SMTP form, connected with only one half.
//
// Run with: npm run test:connect-mode-ui
//
// A receive-only mailbox has no SMTP server to give, and a send-only one has no
// IMAP server. This renders the real ConnectModal and pins that:
//
//   - the form opens on "send and receive", with both host rows;
//   - choosing one half hides the other half's host, port and security fields;
//   - the request carries `mode` and only the half it names, even when the
//     hidden fields still hold what was typed before the switch;
//   - an empty host in the one visible half is refused naming that half alone.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

installDom();
globalThis.self ??= globalThis.window;
// jsdom lays nothing out, so it has no scrollIntoView; the form calls it to
// bring a validation error into view.
window.HTMLElement.prototype.scrollIntoView ??= function scrollIntoView() {};
globalThis.IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { ConnectModal } = await import('./ConnectModal.jsx');
const { ToastProvider } = await import('./Toast.jsx');
const chrome = (await import('../../messages/en/dashboardChrome.json', { with: { type: 'json' } })).default;

/**
 * Mount the modal on the generic card and go to its credentials step.
 * Returns the view and every request the modal sent to the connect route.
 */
async function openGenericForm(t) {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url) === '/api/inboxes/imap') {
      requests.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ success: true, transport_adjusted: false }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const view = await mount(createElement(AppLocaleProvider, null, createElement(ToastProvider, null,
    createElement(ConnectModal, {
      reconnect: null,
      onClose: () => {},
      onConnect: () => {},
      preselect: { card: 'generic' },
      atInboxLimit: false,
      planName: 'Free',
      inboxCount: 0,
      maxInboxes: null,
      stripePrices: null,
      businessShaped: false,
      onAdminConsentLink: () => {},
    }))));
  t.after(async () => {
    await view.unmount();
    globalThis.fetch = previousFetch;
  });
  const next = buttonNamed(view, chrome.connect.enterCredentials);
  assert.ok(next, 'step 1 should offer the button that opens the credentials form');
  await flush(async () => { next.click(); });
  await waitFor(() => view.container.querySelector('#cm-connection-mode'), { message: 'the credentials form' });
  return { view, requests };
}

function buttonNamed(view, text) {
  return [...view.container.querySelectorAll('button')].find((b) => b.textContent.trim() === text) ?? null;
}

const q = (view, id) => view.container.querySelector(`#${id}`);

/** Sets a controlled <select>, the way React hears it. */
async function choose(select, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  await flush(async () => {
    setter.call(select, value);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

/** Types into a controlled text input, bypassing React's value tracker. */
async function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await flush(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

async function submit(view) {
  const connect = buttonNamed(view, chrome.connect.connectInbox);
  assert.ok(connect, 'the credentials step should have its Connect button');
  await flush(async () => { connect.click(); });
}

test('the form opens on send and receive, with both host rows', async (t) => {
  const { view } = await openGenericForm(t);
  assert.equal(q(view, 'cm-connection-mode').value, 'both');
  assert.ok(q(view, 'cm-imap-host'), 'IMAP host shown');
  assert.ok(q(view, 'cm-smtp-host'), 'SMTP host shown');
});

test('send only hides IMAP and submits only the SMTP half', async (t) => {
  const { view, requests } = await openGenericForm(t);
  // Typed before the switch: must not reach the server.
  await type(q(view, 'cm-imap-host'), 'imap.example.com');
  await choose(q(view, 'cm-connection-mode'), 'smtp');
  assert.equal(q(view, 'cm-imap-host'), null, 'IMAP host hidden');
  assert.equal(q(view, 'cm-imap-port'), null, 'IMAP port hidden');
  assert.ok(q(view, 'cm-smtp-host'), 'SMTP host still shown');

  await type(q(view, 'cm-email'), 'noreply@example.com');
  await type(q(view, 'cm-smtp-host'), 'smtp.example.com');
  await type(q(view, 'cm-password'), 'a-long-enough-password');
  await submit(view);
  await waitFor(() => requests.length === 1, { message: 'the connect request' });

  const [body] = requests;
  assert.equal(body.mode, 'smtp');
  assert.equal(body.smtpHost, 'smtp.example.com');
  assert.ok(Number(body.smtpPort) > 0);
  assert.equal('imapHost' in body, false, 'no IMAP host is sent');
  assert.equal('imapPort' in body, false, 'no IMAP port is sent');
});

test('receive only hides SMTP and submits only the IMAP half', async (t) => {
  const { view, requests } = await openGenericForm(t);
  await choose(q(view, 'cm-connection-mode'), 'imap');
  assert.equal(q(view, 'cm-smtp-host'), null, 'SMTP host hidden');
  assert.ok(q(view, 'cm-imap-host'), 'IMAP host still shown');

  await type(q(view, 'cm-email'), 'archive@example.com');
  await type(q(view, 'cm-imap-host'), 'imap.example.com');
  await type(q(view, 'cm-password'), 'a-long-enough-password');
  await submit(view);
  await waitFor(() => requests.length === 1, { message: 'the connect request' });

  const [body] = requests;
  assert.equal(body.mode, 'imap');
  assert.equal(body.imapHost, 'imap.example.com');
  assert.equal('smtpHost' in body, false, 'no SMTP host is sent');
});

test('an empty host in a one-sided form names only that half', async (t) => {
  const { view, requests } = await openGenericForm(t);
  await choose(q(view, 'cm-connection-mode'), 'smtp');
  await type(q(view, 'cm-email'), 'noreply@example.com');
  await type(q(view, 'cm-password'), 'a-long-enough-password');
  await submit(view);
  await waitFor(
    () => view.container.textContent.includes(chrome.connect.errorSmtpHostRequired),
    { message: 'the SMTP-only host error' },
  );
  assert.equal(view.container.textContent.includes(chrome.connect.errorHostRequired), false);
  assert.equal(requests.length, 0, 'nothing was sent');
});
