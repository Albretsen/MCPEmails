// ---------------------------------------------------------------------------
// SAML single sign-on section on the Security page.
//
// Run with: npm run test:sso-settings-ui
//
// Renders the real SsoSettingsSection against a stubbed /api/sso and asserts
// through the DOM and the requests:
//   - a member or viewer gets nothing, and no request is made;
//   - a 403 from the API (not enterprise) renders nothing;
//   - an owner sees our three SAML values with copy buttons;
//   - "Require single sign-on" is disabled until a verified domain and a test
//     sign-in exist, and then PATCHes { enforced: true };
//   - "Check now" POSTs to the domain's verify route;
//   - every locale has every key, without '<' or an em dash.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

installDom();

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { ToastProvider } = await import('./Toast.jsx');
const { SsoSettingsSection } = await import('./SsoSettingsSection.jsx');
const en = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;
const S = en.sso;

const SAML = {
  entityId: 'https://ref.supabase.example/auth/v1/sso/saml/metadata',
  acsUrl: 'https://ref.supabase.example/auth/v1/sso/saml/acs',
  metadataUrl: 'https://ref.supabase.example/auth/v1/sso/saml/metadata',
};

function baseState(over = {}) {
  return {
    saml: SAML,
    managementConfigured: true,
    connection: { id: 'c1', status: 'active', enforced: false, defaultRole: 'member', hasProvider: true, updatedAt: '2026-10-19T10:00:00Z' },
    domains: [{ id: 'd1', domain: 'company-sso.example', verified: false, verifiedAt: null, txtRecord: 'mcpemails-verification=0123456789abcdef0123456789abcdef' }],
    testSignInSeen: false,
    events: [],
    ...over,
  };
}

function stubFetch(t, { getStatus = 200, state = baseState() } = {}) {
  const requests = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url: String(url), method, body });
    const json = (status, payload) => ({ ok: status < 400, status, json: async () => payload });
    if (String(url) === '/api/sso' && method === 'GET') {
      return getStatus === 200 ? json(200, state) : json(getStatus, { error_code: 'plan_required' });
    }
    return json(200, {});
  };
  t.after(() => { globalThis.fetch = previous; });
  return requests;
}

async function render(t, userRole) {
  const view = await mount(
    createElement(AppLocaleProvider, null,
      createElement(ToastProvider, null, createElement(SsoSettingsSection, { userRole }))),
  );
  t.after(() => view.unmount());
  return view;
}

const button = (view, text) => [...view.container.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
const enforceBox = (view) => view.container.querySelector('input[name="sso-enforced"]');

test('every locale has every SSO key, without < or an em dash', async () => {
  const keys = (obj, prefix = '') =>
    Object.entries(obj).flatMap(([k, v]) => (typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
  const want = keys(S).sort();
  for (const locale of ['en', 'es', 'fr', 'nb', 'zh']) {
    const messages = (await import(`../../messages/${locale}/dashboard.json`, { with: { type: 'json' } })).default;
    assert.deepEqual(keys(messages.sso).sort(), want, `${locale} has the same keys`);
    const text = JSON.stringify(messages.sso);
    assert.equal(text.includes('<'), false, `${locale}: no literal <`);
    assert.equal(text.includes('—'), false, `${locale}: no em dash`);
  }
});

for (const role of ['member', 'viewer']) {
  test(`${role}: renders nothing and never calls the API`, async (t) => {
    const requests = stubFetch(t);
    const view = await render(t, role);
    await flush();
    assert.equal(view.container.textContent, '');
    assert.equal(requests.length, 0);
  });
}

test('not entitled (403): renders nothing', async (t) => {
  stubFetch(t, { getStatus: 403 });
  const view = await render(t, 'owner');
  await waitFor(() => !view.container.textContent.includes(S.loading), { message: 'load finished' });
  assert.equal(view.container.textContent, '');
});

test('owner sees our SAML values with copy buttons', async (t) => {
  stubFetch(t);
  const view = await render(t, 'owner');
  await waitFor(() => view.container.querySelector('[data-sso-section]'), { message: 'section rendered' });
  const copies = [...view.container.querySelectorAll('[data-sso-copy]')].map((b) => b.getAttribute('data-sso-copy'));
  assert.ok(copies.includes(SAML.entityId));
  assert.ok(copies.includes(SAML.acsUrl));
  assert.equal(view.container.textContent.includes(S.entityId), true);
  assert.equal(view.container.textContent.includes(S.acsUrl), true);
});

test('require is locked without a verified domain and a test sign-in', async (t) => {
  stubFetch(t, { state: baseState({ testSignInSeen: true }) });
  const view = await render(t, 'admin');
  await waitFor(() => enforceBox(view), { message: 'enforce box' });
  assert.equal(enforceBox(view).disabled, true, 'no verified domain yet');
  assert.equal(view.container.textContent.includes(S.enforceLocked), true);
});

test('require unlocks with a verified domain and a test sign-in, and PATCHes enforced', async (t) => {
  const state = baseState({
    testSignInSeen: true,
    domains: [{ id: 'd1', domain: 'company-sso.example', verified: true, verifiedAt: '2026-10-19T11:00:00Z', txtRecord: 'x' }],
  });
  const requests = stubFetch(t, { state });
  const view = await render(t, 'owner');
  await waitFor(() => enforceBox(view), { message: 'enforce box' });
  assert.equal(enforceBox(view).disabled, false);
  await flush(async () => { enforceBox(view).click(); });
  const patch = await waitFor(() => requests.find((r) => r.method === 'PATCH'), { message: 'PATCH sent' });
  assert.equal(patch.url, '/api/sso/connection');
  assert.deepEqual(patch.body, { enforced: true });
});

test('"Check now" POSTs to that domain\'s verify route', async (t) => {
  const requests = stubFetch(t);
  const view = await render(t, 'owner');
  await waitFor(() => button(view, S.checkNow), { message: 'check now button' });
  await flush(async () => { button(view, S.checkNow).click(); });
  const post = await waitFor(() => requests.find((r) => r.method === 'POST'), { message: 'verify sent' });
  assert.equal(post.url, '/api/sso/domains/d1/verify');
});
