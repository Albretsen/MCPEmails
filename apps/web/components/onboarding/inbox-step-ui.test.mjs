// ---------------------------------------------------------------------------
// The onboarding inbox step (WP-E, plan A3-A5): email-first detection, the
// provider checklist with tracked links, the trust panel and format warning,
// failure fallbacks with "Send this error to support" after the second
// failure, and the proof card.
//
// Run with: npm run test:onboarding-inbox-ui
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

installDom();
globalThis.self ??= globalThis.window;

const { default: OnboardingLocaleProvider } = await import('../i18n/OnboardingLocaleProvider.jsx');
const { InboxStep } = await import('./steps/InboxStep.jsx');

/** A fetch stub: `routes` maps a path prefix to (body, init) => { status, json }. Every call is recorded. */
function stubFetch(t, routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, body, method: init.method ?? 'GET' });
    const key = Object.keys(routes).find((prefix) => path.startsWith(prefix));
    const answer = key ? await routes[key](body, path) : { status: 204, json: null };
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => answer.json,
    };
  };
  window.fetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; window.fetch = original; });
  return calls;
}

async function render(t, props = {}) {
  const view = await mount(createElement(OnboardingLocaleProvider, null, createElement(InboxStep, {
    step: 'inbox',
    status: { inboxes: { count: 0, sinceReset: 0, items: [] } },
    refreshStatus: async () => null,
    clientLabel: 'Claude',
    provider: null,
    userEmail: 'owner@example.org',
    goNext: () => {},
    ...props,
  })));
  t.after(() => view.unmount());
  return view;
}

async function typeInto(el, value) {
  await flush(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

const q = (view, sel) => view.container.querySelector(sel);
const text = (view) => view.container.textContent;

test('the signup address is a chip, never a prefill', async (t) => {
  stubFetch(t, {});
  const view = await render(t);
  assert.equal(q(view, '[data-testid="onb-email"]').value, '');
  const chip = q(view, '[data-testid="onb-use-signup"]');
  assert.ok(chip.textContent.includes('owner@example.org'));
  await flush(() => chip.click());
  assert.equal(q(view, '[data-testid="onb-email"]').value, 'owner@example.org');
});

test('a Gmail address shows the 2-Step checklist up front, and link clicks are recorded', async (t) => {
  const calls = stubFetch(t, {});
  const view = await render(t);
  await typeInto(q(view, '[data-testid="onb-email"]'), 'me@gmail.com');
  await waitFor(() => q(view, '.onb-provider[data-kind="gmail"]'), { message: 'gmail panel' });
  assert.ok(text(view).includes('Turn on 2-Step Verification.'));
  assert.ok(q(view, '[data-testid="onb-gmail-missing"]').textContent.includes('No App passwords page?'));
  const twoStep = q(view, 'a[data-link="two_step"]');
  assert.ok(twoStep.getAttribute('href').includes('authuser=me%40gmail.com'));
  await flush(() => twoStep.click());
  const beacon = calls.find((c) => c.path === '/api/analytics/activation-event');
  assert.deepEqual(beacon?.body, { stage: 'app_password_link_clicked', provider: 'gmail', link: 'two_step' });
  // The trust panel sits at the password field: no SOC 2, no badges.
  const trust = q(view, '[data-testid="onb-trust"]').textContent;
  assert.ok(trust.includes('Stockholm'));
  assert.equal(/SOC/.test(trust), false);
});

test('a normal password gets a warning that never blocks Connect', async (t) => {
  stubFetch(t, {});
  const view = await render(t);
  await typeInto(q(view, '[data-testid="onb-email"]'), 'me@gmail.com');
  await waitFor(() => q(view, '[data-testid="onb-password"]'), { message: 'password field' });
  await typeInto(q(view, '[data-testid="onb-password"]'), 'Sommer2024!');
  assert.ok(q(view, '[data-testid="onb-format-warning"]').textContent.includes('normal password'));
  assert.equal(q(view, '[data-testid="onb-connect"]').disabled, false);
  await typeInto(q(view, '[data-testid="onb-password"]'), 'abcd efgh ijkl mnop');
  assert.equal(q(view, '[data-testid="onb-format-warning"]'), null);
});

test('the password fields do not read as a sign-in form for this site', async (t) => {
  stubFetch(t, {});
  const view = await render(t);
  await typeInto(q(view, '[data-testid="onb-email"]'), 'me@icloud.com');
  await waitFor(() => q(view, '[data-testid="onb-password"]'), { message: 'password field' });
  for (const el of [q(view, '[data-testid="onb-email"]'), q(view, '[data-testid="onb-password"]')]) {
    assert.equal(el.getAttribute('autocomplete'), 'off');
    assert.equal(/^(email|password|username)$/.test(el.getAttribute('name')), false);
  }
});

test('an unknown domain asks the server; nothing found shows the provider list', async (t) => {
  const calls = stubFetch(t, {
    '/api/onboarding/detect': () => ({ status: 200, json: { detection: { kind: 'imap', label: null, source: 'none', settings: null, customDomain: true } } }),
  });
  const view = await render(t);
  await typeInto(q(view, '[data-testid="onb-email"]'), 'me@small-shop.org');
  await waitFor(() => q(view, '[data-testid="onb-chooser"]'), { message: 'chooser' });
  assert.ok(calls.some((c) => c.path === '/api/onboarding/detect?domain=small-shop.org'));
  assert.ok(q(view, '[data-testid="onb-manual-servers"]'), 'manual servers for an unknown IMAP host');
  await flush(() => q(view, '[data-testid="onb-chooser"] [data-kind="microsoft365"]').click());
  assert.ok(q(view, '[data-testid="onb-admin-note"]'), 'Microsoft 365 shows admin approval up front');
  assert.ok(q(view, '[data-testid="onb-microsoft-connect"]'));
  assert.equal(q(view, '[data-testid="onb-password"]'), null, 'no password for Microsoft');
});

test('?provider= preselects a panel before an address is typed', async (t) => {
  stubFetch(t, {});
  const view = await render(t, { provider: 'yahoo' });
  assert.ok(q(view, '.onb-provider[data-kind="yahoo"]'));
});

test('failures keep the address, show the fix, and offer a support email after the second', async (t) => {
  const calls = stubFetch(t, {
    '/api/inboxes/app-password': () => ({ status: 422, json: { error_code: 'auth_failed', auth_reason: 'account_password_used', phase: 'authentication' } }),
  });
  const view = await render(t);
  await typeInto(q(view, '[data-testid="onb-email"]'), 'me@gmail.com');
  await waitFor(() => q(view, '[data-testid="onb-password"]'), { message: 'password field' });
  await typeInto(q(view, '[data-testid="onb-password"]'), 'Sommer2024!');
  await flush(() => q(view, '[data-testid="onb-connect"]').click());
  await waitFor(() => q(view, '[data-testid="onb-failure"]'), { message: 'first failure' });

  const sent = calls.find((c) => c.path === '/api/inboxes/app-password');
  assert.deepEqual(sent.body, { service: 'gmail', email: 'me@gmail.com', appPassword: 'Sommer2024!' });
  assert.equal(q(view, '[data-testid="onb-email"]').value, 'me@gmail.com', 'address kept');
  assert.equal(q(view, '[data-testid="onb-password"]').value, '', 'password cleared for the new one');
  assert.equal(q(view, '[data-testid="onb-failure"]').getAttribute('data-message'), 'reason.account_password_used');
  assert.ok(q(view, '[data-testid="onb-different"]'));
  assert.equal(q(view, '[data-testid="onb-support"]'), null, 'no support offer after one failure');

  await typeInto(q(view, '[data-testid="onb-password"]'), 'Sommer2025!');
  await flush(() => q(view, '[data-testid="onb-connect"]').click());
  await waitFor(() => q(view, '[data-testid="onb-support"]'), { message: 'support offer' });
  const mail = q(view, '[data-testid="onb-support-send"]').getAttribute('href');
  assert.ok(mail.startsWith('mailto:support@mcpemails.com?subject='), mail);
  const body = decodeURIComponent(mail.slice(mail.indexOf('&body=') + 6));
  assert.ok(body.includes('Error code: auth_failed') && body.includes('Auth reason: account_password_used') && body.includes('Failed attempts: 2'), body);
  assert.equal(mail.includes('Sommer'), false, 'never the password');
});

test('success ticks the checks and ends on the proof card', async (t) => {
  let next = 0;
  stubFetch(t, {
    '/api/inboxes/app-password': () => ({ status: 200, json: { success: true } }),
    '/api/onboarding/inbox-proof': () => ({ status: 200, json: { available: true, count: 1284, subjects: ['Invoice 42', '', 'Lunch?'] } }),
  });
  const view = await render(t, {
    refreshStatus: async () => ({ inboxes: { count: 1, sinceReset: 1, items: [{ id: '00000000-0000-0000-0000-000000000001', address: 'me@icloud.com' }] } }),
    goNext: () => { next += 1; },
  });
  await typeInto(q(view, '[data-testid="onb-email"]'), 'me@icloud.com');
  await waitFor(() => q(view, '[data-testid="onb-password"]'), { message: 'password field' });
  await typeInto(q(view, '[data-testid="onb-password"]'), 'abcd-efgh-ijkl-mnop');
  await flush(() => q(view, '[data-testid="onb-connect"]').click());
  await waitFor(() => q(view, '[data-testid="onb-proof-card"]'), { message: 'proof card', timeout: 6000 });
  assert.ok(q(view, '[data-testid="onb-proof-count"]').textContent.includes('1,284'));
  const subjects = [...view.container.querySelectorAll('.onb-proof-subjects li')].map((li) => li.textContent);
  assert.deepEqual(subjects, ['Invoice 42', '(no subject)', 'Lunch?']);
  await flush(() => q(view, '[data-testid="onb-proof-continue"]').click());
  assert.equal(next, 1);
});

test('after a reset: "Use" is remembered, and "Connect another" has a way back (WP-Z m2, m3)', async (t) => {
  const calls = stubFetch(t, { '/api/onboarding': () => ({ status: 200, json: { ok: true } }) });
  let next = 0;
  const status = { inboxes: { count: 1, sinceReset: 0, items: [{ id: 'i1', address: 'old@example.org', provider: 'imap', status: 'active', createdAt: '2026-10-20T10:00:00Z' }] } };
  const view = await render(t, { status, goNext: () => { next += 1; } });
  assert.ok(q(view, '[data-testid="onb-reuse-inbox"]'));
  await flush(() => q(view, '[data-testid="onb-connect-another"]').click());
  assert.ok(q(view, '[data-testid="onb-inbox-connect"]'));
  const back = q(view, '[data-testid="onb-inbox-back"]');
  assert.equal(back.textContent, 'Back');
  await flush(() => back.click());
  await flush(() => q(view, '[data-testid="onb-reuse"]').click());
  assert.equal(next, 1);
  assert.equal(calls.some((c) => c.path === '/api/onboarding' && c.body?.action === 'inbox_reused'), true);
});

test('a first inbox has no Back link; a second one goes back to It works', async (t) => {
  stubFetch(t, {});
  const first = await render(t);
  assert.equal(q(first, '[data-testid="onb-inbox-back"]') === null, true);
  let went = '';
  const second = await render(t, { secondInbox: true, goTo: (id) => { went = id; } });
  await flush(() => q(second, '[data-testid="onb-inbox-back"]').click());
  assert.equal(went, 'it_works');
});

test('onProof fires once the inbox connects (a chat link skips straight to "Go back")', async (t) => {
  let proofs = 0;
  stubFetch(t, {
    '/api/inboxes/app-password': () => ({ status: 200, json: { success: true } }),
    '/api/onboarding/inbox-proof': () => ({ status: 200, json: { available: true, count: 3, subjects: ['Hi'] } }),
  });
  const view = await render(t, {
    refreshStatus: async () => ({ inboxes: { count: 1, sinceReset: 1, items: [{ id: '00000000-0000-0000-0000-000000000001', address: 'me@icloud.com' }] } }),
    onProof: () => { proofs += 1; },
  });
  await typeInto(q(view, '[data-testid="onb-email"]'), 'me@icloud.com');
  await waitFor(() => q(view, '[data-testid="onb-password"]'), { message: 'password field' });
  await typeInto(q(view, '[data-testid="onb-password"]'), 'abcd-efgh-ijkl-mnop');
  assert.equal(proofs, 0);
  await flush(() => q(view, '[data-testid="onb-connect"]').click());
  await waitFor(() => proofs === 1, { message: 'onProof', timeout: 6000 });
  assert.equal(proofs, 1);
});
