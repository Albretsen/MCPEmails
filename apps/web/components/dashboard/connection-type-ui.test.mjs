// ---------------------------------------------------------------------------
// Inboxes > inbox > Advanced > Connection type.
//
// Run with: npm run test:connection-type-ui
//
// Renders the real InboxAdvancedSection and ConnectionTypeEditor against a
// stubbed PATCH /api/inboxes/[id]/connection, and asserts through the DOM and
// the requests:
//   - a generic IMAP/SMTP inbox has Connection type under Advanced, send-only
//     ones too (they have no Folders); branded and OAuth inboxes do not;
//   - narrowing shows one line saying what turns off, no fields, and Save
//     sends only the mode;
//   - widening shows only the added half's host, port and security, never a
//     password field, and Save sends that half alone;
//   - a failure is one line and nothing is reported as changed;
//   - a refused stored login brings up username and password, and the next
//     Save sends them;
//   - every locale has every key, without '<' or an em dash.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { useTranslations } from 'next-intl';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

installDom();

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { InboxAdvancedSection, inboxAdvancedAvailable } = await import('./Pages.jsx');
const { connectionTypeAvailable } = await import('./ConnectionTypeEditor.jsx');
const en = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;
const C = en.inboxes.detail.connection;

function inbox(connectionMode, overrides = {}) {
  return {
    id: 'ib-0001',
    label: 'box',
    address: 'box@example.invalid',
    provider: 'imap',
    service: 'generic',
    status: 'active',
    hasImap: true,
    connectionMode,
    imapHost: connectionMode === 'smtp' ? null : 'imap.example.invalid',
    imapPort: connectionMode === 'smtp' ? null : 993,
    smtpHost: connectionMode === 'imap' ? null : 'smtp.example.invalid',
    smtpPort: connectionMode === 'imap' ? null : 465,
    imapSecurity: 'tls',
    smtpSecurity: 'tls',
    username: null,
    ...overrides,
  };
}

/** Answers PATCH /connection from `answers` in order and records those requests. */
function stubFetch(t, answers) {
  const requests = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const json = (status, payload) => ({ ok: status < 400, status, json: async () => payload });
    // The Folders editor below mounts too and lists folders.
    if (String(url).endsWith('/folders')) return json(200, { folders: [], roles: [] });
    requests.push({ url: String(url), method, body: init.body ? JSON.parse(init.body) : null });
    const [status, payload] = answers.shift() ?? [500, {}];
    return json(status, payload);
  };
  t.after(() => { globalThis.fetch = previous; });
  return requests;
}

async function openAdvanced(t, ib) {
  const changes = [];
  function Advanced() {
    const tr = useTranslations('dashboard');
    return createElement(InboxAdvancedSection, { inbox: ib, t: tr, onConnectionChanged: (id, fields) => changes.push({ id, fields }) });
  }
  const view = await mount(createElement(AppLocaleProvider, null, createElement(Advanced)));
  t.after(() => view.unmount());
  const details = view.container.querySelector('details.inbox-advanced-details');
  await flush(async () => {
    details.open = true;
    details.dispatchEvent(new window.Event('toggle'));
  });
  await waitFor(() => view.container.querySelector('[data-connection-type]'), { message: 'the Connection type editor' });
  return { view, changes };
}

const q = (view, suffix) => view.container.querySelector(`#connection-ib-0001-${suffix}`);
const statusText = view => view.container.querySelector('[data-connection-type] [role="status"], [data-connection-type] [role="alert"]')?.textContent ?? '';
const button = (view, name) => [...view.container.querySelectorAll('[data-connection-type] button')].find(b => b.textContent.trim() === name);

async function choose(select, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  await flush(async () => {
    setter.call(select, value);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

async function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await flush(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

async function save(view) {
  const b = button(view, C.save);
  assert.ok(b, 'a Save button');
  await flush(async () => { b.click(); });
}

const savedBody = (mode, extra = {}) => ({ success: true, mode, imapHost: null, smtpHost: null, ...extra });

test('every locale has every Connection type key, without < or an em dash', async () => {
  const keys = (obj, prefix = '') =>
    Object.entries(obj).flatMap(([k, v]) => (typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
  const want = keys(C).sort();
  for (const locale of ['en', 'es', 'fr', 'nb', 'de']) {
    const messages = (await import(`../../messages/${locale}/dashboard.json`, { with: { type: 'json' } })).default;
    const connection = messages.inboxes.detail.connection;
    assert.deepEqual(keys(connection).sort(), want, `${locale} has the same keys`);
    const text = JSON.stringify(connection);
    assert.equal(text.includes('<'), false, `${locale}: no literal <`);
    assert.equal(text.includes('—'), false, `${locale}: no em dash`);
    assert.equal(/MCP Emails|mcpemails(?!\.)/.test(text), false, `${locale}: MCPEmails, one word`);
  }
});

test('available for generic IMAP/SMTP inboxes of every type, not branded or OAuth ones', () => {
  for (const mode of ['both', 'imap', 'smtp']) {
    assert.equal(connectionTypeAvailable(inbox(mode)), true, mode);
    assert.equal(inboxAdvancedAvailable(inbox(mode)), true, `${mode}: Advanced is shown`);
  }
  assert.equal(connectionTypeAvailable(inbox('both', { provider: 'icloud', service: 'icloud' })), false);
  assert.equal(connectionTypeAvailable(inbox('both', { provider: 'gmail', hasImap: false, connectionMode: null })), false);
  assert.equal(connectionTypeAvailable(inbox('both', { status: 'pending' })), false);
});

test('the inbox page shows the stored connection type under Advanced', async (t) => {
  stubFetch(t, []);
  const { view } = await openAdvanced(t, inbox('imap'));
  const select = q(view, 'mode');
  assert.ok(select, 'Connection type select on the inbox page');
  assert.equal(select.value, 'imap');
  assert.equal(select.disabled, false);
  assert.equal(button(view, C.save), undefined, 'no Save until the type changes');
});

test('narrowing: one line says what turns off, no fields, Save sends only the mode', async (t) => {
  const requests = stubFetch(t, [[200, savedBody('imap', { imapHost: 'imap.example.invalid', imapPort: 993 })]]);
  const { view, changes } = await openAdvanced(t, inbox('both'));
  await choose(q(view, 'mode'), 'imap');
  assert.ok(view.container.textContent.includes(C.turnsOff.smtp), 'says sending turns off');
  assert.equal(view.container.querySelectorAll('[data-connection-type] input').length, 0, 'nothing to type');
  await save(view);
  await waitFor(() => requests.length === 1, { message: 'the PATCH' });
  assert.equal(requests[0].method, 'PATCH');
  assert.ok(requests[0].url.endsWith('/api/inboxes/ib-0001/connection'));
  assert.deepEqual(requests[0].body, { mode: 'imap' });
  await waitFor(() => changes.length === 1, { message: 'the change reported' });
  assert.equal(changes[0].fields.connectionMode, 'imap');
  assert.equal(changes[0].fields.smtpHost, null);
  assert.equal(statusText(view), C.saved.imap);
});

test('widening: only the added half is asked for, never the password', async (t) => {
  const requests = stubFetch(t, [[200, savedBody('both', { imapHost: 'imap.example.invalid', smtpHost: 'smtp.example.invalid', smtpPort: 465 })]]);
  const { view, changes } = await openAdvanced(t, inbox('imap'));
  await choose(q(view, 'mode'), 'both');
  assert.ok(q(view, 'smtp-host'), 'SMTP host asked for');
  assert.ok(q(view, 'smtp-port'), 'SMTP port asked for');
  assert.ok(q(view, 'smtp-security'), 'SMTP security asked for');
  assert.equal(q(view, 'imap-host'), null, 'IMAP is not asked for again');
  assert.equal(q(view, 'password'), null, 'no password field');
  await type(q(view, 'smtp-host'), 'smtp.example.invalid');
  await save(view);
  await waitFor(() => requests.length === 1, { message: 'the PATCH' });
  assert.deepEqual(requests[0].body, { mode: 'both', smtpHost: 'smtp.example.invalid', smtpPort: 465, smtpSecurity: 'tls' });
  await waitFor(() => changes.length === 1, { message: 'the change reported' });
  assert.equal(changes[0].fields.connectionMode, 'both');
  assert.equal(statusText(view), C.saved.both);
});

test('widening with an empty host is refused on one line without a request', async (t) => {
  const requests = stubFetch(t, []);
  const { view } = await openAdvanced(t, inbox('smtp'));
  await choose(q(view, 'mode'), 'both');
  await type(q(view, 'imap-host'), '');
  await save(view);
  assert.equal(statusText(view), C.errors.hostRequired.replace('{server}', 'IMAP'));
  assert.equal(requests.length, 0);
});

test('a widening that fails is one line and changes nothing', async (t) => {
  stubFetch(t, [[422, { error: 'The server never answered.', error_code: 'timeout', half: 'smtp' }]]);
  const { view, changes } = await openAdvanced(t, inbox('imap'));
  await choose(q(view, 'mode'), 'both');
  await type(q(view, 'smtp-host'), 'smtp.example.invalid');
  await save(view);
  await waitFor(() => statusText(view) !== '', { message: 'the error line' });
  assert.equal(statusText(view), C.errors.unreachable.replace('{server}', 'SMTP'));
  assert.equal(changes.length, 0, 'nothing reported as changed');
});

test('a refused saved login asks for username and password, then sends them', async (t) => {
  const requests = stubFetch(t, [
    [422, { error: 'Login refused.', error_code: 'auth_failed', half: 'smtp', needs_login: true }],
    [200, savedBody('both', { imapHost: 'imap.example.invalid', smtpHost: 'smtp.example.invalid', username: 'other-login' })],
  ]);
  const { view, changes } = await openAdvanced(t, inbox('imap'));
  await choose(q(view, 'mode'), 'both');
  await type(q(view, 'smtp-host'), 'smtp.example.invalid');
  await save(view);
  await waitFor(() => q(view, 'password'), { message: 'the password field' });
  assert.equal(statusText(view), C.needsLogin.replace('{server}', 'SMTP'));
  await type(q(view, 'username'), 'other-login');
  await type(q(view, 'password'), 'other-secret');
  await save(view);
  await waitFor(() => requests.length === 2, { message: 'the second PATCH' });
  assert.equal(requests[1].body.username, 'other-login');
  assert.equal(requests[1].body.appPassword, 'other-secret');
  assert.equal(requests[1].body.smtpHost, 'smtp.example.invalid');
  await waitFor(() => changes.length === 1, { message: 'the change reported' });
  assert.equal(changes[0].fields.status, 'active');
});
