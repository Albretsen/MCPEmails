// ---------------------------------------------------------------------------
// Inboxes > inbox > Advanced > Folders.
//
// Run with: npm run test:folder-overrides-ui
//
// Renders the real FolderOverridesEditor and InboxAdvancedSection against a
// stubbed /api/inboxes/[id]/folders, and asserts through the DOM and the
// requests:
//   - the section shows only for password IMAP inboxes that can read, on TLS;
//   - nothing is fetched until Advanced is opened;
//   - each role reads "Automatic (<detected folder>)" or "Automatic (not
//     found)", greyed while automatic;
//   - picking a folder PUTs {role, folder} and says so on one line, and
//     "Reset to automatic" PUTs folder null;
//   - a folder another role uses is disabled; a refusal is one line;
//   - every locale has every key, without '<' or an em dash.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { useTranslations } from 'next-intl';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

installDom();

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { FolderOverridesEditor } = await import('./FolderOverridesEditor.jsx');
const { InboxAdvancedSection, folderChoiceAvailable } = await import('./Pages.jsx');
const en = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;
const F = en.inboxes.detail.folders;

const INBOX = {
  id: 'ib-0001',
  label: 'work',
  address: 'owner@ovh.example',
  provider: 'ovh',
  status: 'active',
  hasImap: true,
  connectionMode: 'both',
  imapSecurity: 'tls',
};

const FOLDERS = ['INBOX.Éléments envoyés', 'INBOX.INBOX.Sent', 'INBOX.Brouillons', 'INBOX.Corbeille'];

function settings(overrides = {}) {
  const automatic = { sent: null, drafts: 'INBOX.Brouillons', trash: 'INBOX.Corbeille', spam: null, archive: null };
  return {
    folders: FOLDERS,
    roles: ['sent', 'drafts', 'trash', 'spam', 'archive'].map(role => ({ role, automatic: automatic[role], override: overrides[role] ?? null })),
  };
}

/** A stub for the folders route that answers from `state` and records calls. */
function stubFetch(t, state) {
  const requests = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url: String(url), method, body });
    const json = (status, payload) => ({ ok: status < 400, status, json: async () => payload });
    if (!String(url).endsWith('/api/inboxes/ib-0001/folders')) return json(404, {});
    if (method === 'GET') return state.loadError ? json(502, { error: state.loadError }) : json(200, settings(state.overrides));
    if (state.refuse) return json(409, { error: state.refuse });
    if (body.folder === null) delete state.overrides[body.role];
    else state.overrides[body.role] = body.folder;
    return json(200, { overrides: state.overrides });
  };
  t.after(() => { globalThis.fetch = previous; });
  return requests;
}

function Editor() {
  const t = useTranslations('dashboard');
  return createElement(FolderOverridesEditor, { inbox: INBOX, t });
}

function Advanced() {
  const t = useTranslations('dashboard');
  return createElement(InboxAdvancedSection, { inbox: INBOX, t });
}

async function renderEditor(t) {
  const view = await mount(createElement(AppLocaleProvider, null, createElement(Editor)));
  t.after(() => view.unmount());
  await waitFor(() => !view.container.textContent.includes(F.loading), { message: 'folders loaded' });
  return view;
}

const select = (view, role) => view.container.querySelector(`[data-role="${role}"] select`);
const reset = (view, role) => view.container.querySelector(`[data-role="${role}"] button`);
const statusText = view => view.container.querySelector('[role="status"], [role="alert"]')?.textContent ?? '';

async function choose(el, value) {
  await flush(async () => {
    el.value = value;
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

test('every locale has every Folders key, without < or an em dash', async () => {
  const keys = (obj, prefix = '') =>
    Object.entries(obj).flatMap(([k, v]) => (typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
  const want = keys(F).sort();
  for (const locale of ['en', 'es', 'fr', 'nb', 'de']) {
    const messages = (await import(`../../messages/${locale}/dashboard.json`, { with: { type: 'json' } })).default;
    const detail = messages.inboxes.detail;
    assert.equal(typeof detail.advanced, 'string', `${locale}: advanced`);
    assert.deepEqual(keys(detail.folders).sort(), want, `${locale} has the same keys`);
    const text = JSON.stringify({ advanced: detail.advanced, folders: detail.folders });
    assert.equal(text.includes('<'), false, `${locale}: no literal <`);
    assert.equal(text.includes('—'), false, `${locale}: no em dash`);
    assert.equal(/MCP Emails|mcpemails(?!\.)/.test(text), false, `${locale}: MCPEmails, one word`);
  }
});

test('shown only for password IMAP inboxes that can read, on implicit TLS', () => {
  assert.equal(folderChoiceAvailable(INBOX), true);
  assert.equal(folderChoiceAvailable({ ...INBOX, connectionMode: 'imap' }), true, 'receive-only still has folders');
  assert.equal(folderChoiceAvailable({ ...INBOX, connectionMode: 'smtp' }), false, 'send-only has none');
  assert.equal(folderChoiceAvailable({ ...INBOX, imapSecurity: 'starttls' }), false);
  assert.equal(folderChoiceAvailable({ ...INBOX, status: 'pending' }), false);
  assert.equal(folderChoiceAvailable({ ...INBOX, provider: 'gmail', hasImap: false, connectionMode: null }), false);
  assert.equal(folderChoiceAvailable({ ...INBOX, provider: 'outlook', hasImap: false, connectionMode: null }), false);
});

test('Advanced is collapsed and fetches nothing until it is opened', async (t) => {
  const requests = stubFetch(t, { overrides: {} });
  const view = await mount(createElement(AppLocaleProvider, null, createElement(Advanced)));
  t.after(() => view.unmount());
  const details = view.container.querySelector('details.inbox-advanced-details');
  assert.equal(details.open, false);
  assert.equal(details.querySelector('summary').textContent, en.inboxes.detail.advanced);
  await flush();
  assert.equal(requests.length, 0, 'opening the inbox does not dial its mail server');
  await flush(async () => {
    details.open = true;
    details.dispatchEvent(new window.Event('toggle'));
  });
  await waitFor(() => view.container.querySelector('[data-role="sent"] select'), { message: 'rows after opening' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
});

test('each role starts on Automatic, labelled with the detected folder or not found, greyed', async (t) => {
  stubFetch(t, { overrides: {} });
  const view = await renderEditor(t);
  assert.equal(view.container.querySelectorAll('.folder-override-row').length, 5);
  const sent = select(view, 'sent');
  assert.equal(sent.value, '');
  assert.equal(sent.options[0].textContent, F.automaticNone);
  assert.equal(select(view, 'drafts').options[0].textContent, F.automatic.replace('{folder}', 'INBOX.Brouillons'));
  assert.equal(sent.classList.contains('folder-override-automatic'), true);
  assert.deepEqual([...sent.options].slice(1).map(o => o.value), FOLDERS, 'the decoded names, INBOX left out');
  assert.equal(reset(view, 'sent') ?? 'none', 'none', 'no reset while automatic');
});

test('picking a folder saves it on one line; reset goes back to automatic', async (t) => {
  const state = { overrides: {} };
  const requests = stubFetch(t, state);
  const view = await renderEditor(t);

  await choose(select(view, 'sent'), 'INBOX.Éléments envoyés');
  await waitFor(() => statusText(view).length > 0, { message: 'saved line' });
  const saved = requests.find(r => r.method === 'PUT');
  assert.deepEqual(saved.body, { role: 'sent', folder: 'INBOX.Éléments envoyés' });
  assert.equal(statusText(view), F.saved.replace('{role}', F.roles.sent).replace('{folder}', 'INBOX.Éléments envoyés'));
  assert.equal(select(view, 'sent').value, 'INBOX.Éléments envoyés');
  assert.equal(select(view, 'sent').classList.contains('folder-override-automatic'), false);

  const resetLink = reset(view, 'sent');
  assert.equal(resetLink.textContent, F.reset);
  await flush(async () => { resetLink.click(); });
  await waitFor(() => select(view, 'sent').value === '', { message: 'back to automatic' });
  assert.deepEqual(requests.filter(r => r.method === 'PUT').at(-1).body, { role: 'sent', folder: null });
  assert.equal(statusText(view), F.resetDone.replace('{role}', F.roles.sent));
});

test('a folder another role uses is disabled in the other selects', async (t) => {
  stubFetch(t, { overrides: { drafts: 'INBOX.Brouillons' } });
  const view = await renderEditor(t);
  const inTrash = [...select(view, 'trash').options].find(o => o.value === 'INBOX.Brouillons');
  assert.equal(inTrash.disabled, true);
  const inDrafts = [...select(view, 'drafts').options].find(o => o.value === 'INBOX.Brouillons');
  assert.equal(inDrafts.disabled, false);
});

test('a refusal is one line and the select keeps its saved value', async (t) => {
  stubFetch(t, { overrides: {}, refuse: 'used_by_other_role' });
  const view = await renderEditor(t);
  await choose(select(view, 'trash'), 'INBOX.Brouillons');
  await waitFor(() => statusText(view).length > 0, { message: 'error line' });
  assert.equal(statusText(view), F.errors.used_by_other_role);
  assert.equal(view.container.querySelector('[role="alert"]') !== null, true);
  assert.equal(select(view, 'trash').value, '');
});

test('a mail server that cannot be reached is one line instead of the rows', async (t) => {
  stubFetch(t, { overrides: {}, loadError: 'folders_unreachable' });
  const view = await mount(createElement(AppLocaleProvider, null, createElement(Editor)));
  t.after(() => view.unmount());
  await waitFor(() => statusText(view).length > 0, { message: 'load error' });
  assert.equal(statusText(view), F.errors.folders_unreachable);
  assert.equal(view.container.querySelectorAll('select').length, 0);
});
