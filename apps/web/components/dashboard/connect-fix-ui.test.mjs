// ---------------------------------------------------------------------------
// ConnectModal: the fix panel under a failed connect, "Test again", the
// activation events, the check that survives a closed modal, the Outlook
// notices and the "Now connect your AI app" screen.
//
// Run with: npm run test:connect-fix-ui
//
// The real modal with the real English messages; only `fetch` is replaced.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

installDom();
globalThis.self ??= globalThis.window;
window.HTMLElement.prototype.scrollIntoView ??= function scrollIntoView() {};
globalThis.IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { ConnectModal, resetConnectCheckMemoryForTests } = await import('./ConnectModal.jsx');
const { ToastProvider } = await import('./Toast.jsx');
const chrome = (await import('../../messages/en/dashboardChrome.json', { with: { type: 'json' } })).default;
const fixCopy = chrome.connect.fix;

/**
 * Route `fetch`: `connect` answers the connect routes (a function of the
 * request body, or a promise for a slow check); everything else is recorded.
 */
function stubFetch(t, connect) {
  const requests = [];
  const events = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    if (path.startsWith('/api/inboxes/')) {
      const body = JSON.parse(init.body);
      requests.push(body);
      const reply = await connect(body, requests.length);
      return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
    }
    if (path === '/api/analytics/activation-event') {
      events.push(JSON.parse(init.body));
      return { ok: true, status: 204, json: async () => ({}) };
    }
    if (path === '/api/onboarding') return { ok: true, status: 200, json: async () => ({ onboarding_client: 'claude' }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  t.after(() => { globalThis.fetch = previous; });
  return { requests, events };
}

async function render(t, extra = {}) {
  const props = {
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
    ...extra,
  };
  const view = await mount(createElement(AppLocaleProvider, null, createElement(ToastProvider, null,
    createElement(ConnectModal, props))));
  let unmounted = false;
  const unmount = async () => {
    if (unmounted) return;
    unmounted = true;
    await view.unmount();
  };
  t.after(unmount);
  return { view, unmount };
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

async function openGenericForm(view) {
  await flush(async () => { buttonNamed(view, chrome.connect.enterCredentials).click(); });
  await waitFor(() => q(view, '#cm-imap-host'), { message: 'the credentials form' });
}

async function fill(view, { email, imapHost, smtpHost, password }) {
  await type(q(view, '#cm-email'), email);
  await type(q(view, '#cm-imap-host'), imapHost);
  await type(q(view, '#cm-smtp-host'), smtpHost);
  await type(q(view, '#cm-password'), password);
}

async function submit(view) {
  await flush(async () => { buttonNamed(view, chrome.connect.connectInbox).click(); });
}

test.beforeEach(() => resetConnectCheckMemoryForTests());

test('AOL typed as Other: the AOL fix, password cleared, Test again re-sends what is typed', async (t) => {
  const { requests, events } = stubFetch(t, () => ({
    status: 422,
    body: { error: 'x', error_code: 'auth_failed', auth_reason: 'password_rejected', host: 'imap.aol.com', phase: 'authentication', via_relay: false, relay_failed: false },
  }));
  const { view } = await render(t);
  await openGenericForm(view);
  await fill(view, { email: 'someone@aol.com', imapHost: 'imap.aol.com', smtpHost: 'smtp.aol.com', password: 'MyNormalPassword1' });
  await submit(view);
  const panel = await waitFor(() => q(view, '.cm-fix'), { message: 'the fix panel' });
  assert.equal(panel.getAttribute('data-fix-row'), 'aol_password_rejected');
  assert.equal(panel.textContent.includes('AOL'), true);
  assert.equal(q(view, '#cm-password').value, '', 'only the password is cleared');
  assert.equal(q(view, '#cm-email').value, 'someone@aol.com');
  assert.equal(q(view, '#cm-imap-host').value, 'imap.aol.com');

  await waitFor(() => events.some((e) => e.stage === 'connect_fix_shown'), { message: 'connect_fix_shown' });
  const shown = events.find((e) => e.stage === 'connect_fix_shown');
  assert.equal(shown.provider, 'generic_imap');
  assert.equal(shown.auth_reason, 'password_rejected');
  assert.equal(shown.phase, 'authentication');
  assert.equal(events.filter((e) => e.stage === 'connect_fix_shown').length, 1);

  const link = q(view, '[data-fix-link="aol_app_passwords"]');
  assert.equal(link.getAttribute('href'), 'https://login.aol.com/myaccount/security/app-password');
  await flush(async () => { link.click(); });
  assert.equal(events.filter((e) => e.stage === 'connect_fix_link_clicked').length, 1);

  const again = q(view, '.cm-fix-test-again');
  assert.equal(again.disabled, true, 'nothing to test until the new password is in');
  await type(q(view, '#cm-password'), 'abcd efgh ijkl mnop');
  assert.equal(q(view, '.cm-fix-test-again').disabled, false);
  await flush(async () => { q(view, '.cm-fix-test-again').click(); });
  await waitFor(() => requests.length === 2, { message: 'the second check' });
  assert.equal(requests[1].email, 'someone@aol.com');
  assert.equal(requests[1].imapHost, 'imap.aol.com');
  assert.equal(requests[1].appPassword, 'abcdefghijklmnop', 'spaces stripped from a generated token');
});

test('Office 365 host on the generic form: the panel switches to Microsoft sign-in', async (t) => {
  stubFetch(t, () => ({ status: 422, body: { error: 'x', error_code: 'auth_failed', auth_reason: 'password_rejected', host: 'outlook.office365.com', phase: 'authentication' } }));
  const { view } = await render(t);
  await openGenericForm(view);
  await fill(view, { email: 'me@firm.example', imapHost: 'outlook.office365.com', smtpHost: 'smtp.office365.com', password: 'Password1!' });
  await submit(view);
  const panel = await waitFor(() => q(view, '.cm-fix'), { message: 'the fix panel' });
  assert.equal(panel.getAttribute('data-fix-row'), 'office365_use_outlook');
  await flush(async () => { buttonNamed(view, fixCopy.useOutlook).click(); });
  await waitFor(() => q(view, '.cm-outlook-consent'), { message: 'the Outlook card with its consent explainer' });
  assert.equal(q(view, '.cm-outlook-consent').textContent.includes(fixCopy.outlookConsent.line1), true);
});

test('server never answered and the relay failed too: the plain sentence, and reading only is one click', async (t) => {
  const { requests } = stubFetch(t, (_body, n) => (n === 1
    ? { status: 422, body: { error: 'x', error_code: 'connection_timeout', host: 'smtp.firm.example', phase: 'smtp_tcp', via_relay: false, relay_failed: true, imap_ok: true } }
    : { status: 200, body: { ok: true } }));
  const { view } = await render(t);
  await openGenericForm(view);
  await fill(view, { email: 'me@firm.example', imapHost: 'imap.firm.example', smtpHost: 'smtp.firm.example', password: 'Password1!' });
  await submit(view);
  const panel = await waitFor(() => q(view, '.cm-fix'), { message: 'the fix panel' });
  assert.equal(panel.getAttribute('data-fix-row'), 'server_blocks_us');
  assert.equal(panel.textContent.includes(fixCopy.unreachable.blocked), true);
  assert.equal(panel.textContent.includes('smtp.firm.example'), true, 'names the host we tried');
  await flush(async () => { q(view, '.cm-fix-receive-only').click(); });
  await waitFor(() => requests.length === 2, { message: 'the read-only check' });
  assert.equal(requests[1].mode, 'imap');
  assert.equal('smtpHost' in requests[1], false);
});

test('closed mid-check and reopened: the progress line, then the answer, in the new modal', async (t) => {
  let answer;
  const pending = new Promise((resolve) => { answer = resolve; });
  stubFetch(t, () => pending);
  const first = await render(t);
  await openGenericForm(first.view);
  await fill(first.view, { email: 'me@gmx.net', imapHost: 'imap.gmx.net', smtpHost: 'mail.gmx.net', password: 'Password1!' });
  await submit(first.view);
  await waitFor(() => first.view.container.textContent.includes(fixCopy.progressLogin), { message: 'the progress line' });
  await first.unmount();

  const second = await render(t, { preselect: null });
  assert.equal(q(second.view, '#cm-email').value, 'me@gmx.net', 'the form is back');
  assert.equal(q(second.view, '#cm-password').value, '', 'never the password');
  assert.equal(second.view.container.textContent.includes(fixCopy.progressLogin), true, 'still checking');

  await flush(async () => {
    answer({ status: 422, body: { error: 'x', error_code: 'auth_failed', auth_reason: 'password_rejected', host: 'imap.gmx.net', phase: 'authentication' } });
  });
  const panel = await waitFor(() => q(second.view, '.cm-fix'), { message: 'the fix in the reopened modal' });
  assert.equal(panel.getAttribute('data-fix-row'), 'gmx_password_rejected');
});

test('a failure that landed while closed is shown on the next open', async (t) => {
  let answer;
  const pending = new Promise((resolve) => { answer = resolve; });
  stubFetch(t, () => pending);
  const first = await render(t);
  await openGenericForm(first.view);
  await fill(first.view, { email: 'me@web.de', imapHost: 'imap.web.de', smtpHost: 'smtp.web.de', password: 'Password1!' });
  await submit(first.view);
  await first.unmount();
  answer({ status: 422, body: { error: 'x', error_code: 'auth_failed', auth_reason: 'imap_disabled', host: 'imap.web.de', phase: 'authentication' } });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const second = await render(t, { preselect: null });
  const panel = await waitFor(() => q(second.view, '.cm-fix'), { message: 'the kept failure' });
  assert.equal(panel.getAttribute('data-fix-row'), 'web_de_imap_disabled');
});

test('first inbox connected: "Now connect your AI app", and the guide opens with the client', async (t) => {
  stubFetch(t, () => ({ status: 200, body: { ok: true } }));
  const connected = [];
  const opened = [];
  const { view } = await render(t, {
    showNextStepAfterConnect: true,
    onConnect: (row) => connected.push(row),
    onOpenClientGuide: (client) => opened.push(client),
  });
  await openGenericForm(view);
  await fill(view, { email: 'me@firm.example', imapHost: 'imap.firm.example', smtpHost: 'smtp.firm.example', password: 'Password1!' });
  await submit(view);
  await waitFor(() => view.container.textContent.includes(fixCopy.done.title), { message: 'the last screen' });
  assert.equal(connected.length, 1);
  assert.equal(connected[0].keepOpen, true);
  await waitFor(() => view.container.textContent.includes('Now connect Claude'), { message: 'the client from onboarding' });
  await flush(async () => { buttonNamed(view, fixCopy.done.openGuide).click(); });
  assert.deepEqual(opened, ['claude']);
});

test('not a first inbox: success closes as before', async (t) => {
  stubFetch(t, () => ({ status: 200, body: { ok: true } }));
  const connected = [];
  const { view } = await render(t, { showNextStepAfterConnect: false, onConnect: (row) => connected.push(row) });
  await openGenericForm(view);
  await fill(view, { email: 'me@firm.example', imapHost: 'imap.firm.example', smtpHost: 'smtp.firm.example', password: 'Password1!' });
  await submit(view);
  await waitFor(() => connected.length === 1, { message: 'onConnect' });
  assert.equal(connected[0].keepOpen, false);
  assert.equal(view.container.textContent.includes(fixCopy.done.title), false);
});

test('back from Microsoft with outlook_cancelled: a clear panel on the Outlook card', async (t) => {
  stubFetch(t, () => ({ status: 200, body: {} }));
  const { view } = await render(t, { preselect: null, returnNotice: 'outlook_cancelled' });
  const panel = await waitFor(() => q(view, '.cm-outlook-cancelled'), { message: 'the cancelled panel' });
  assert.equal(panel.textContent.includes(fixCopy.outlookCancelled.title), true);
  assert.equal(q(view, '.cm-outlook-try-again') === null, false);
});
