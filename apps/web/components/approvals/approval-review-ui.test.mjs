// ---------------------------------------------------------------------------
// The two approve surfaces, wired: the /approvals/<id> review page and the
// dashboard decision dialog.
//
// Run with: npm run test:approvals-ui
//
// Security review 2026-10-16. What these pin, on the real components with the
// real English messages (fetch is the only thing replaced):
//   * each decision carries the revision the surface rendered;
//   * a `changed` answer is shown, never a silent failure, and nothing can be
//     decided again until the current version is on screen;
//   * the Bcc addresses are shown to a reviewer, not just a count.
// Only reserved example domains appear below.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

installDom();
globalThis.self ??= globalThis.window;
globalThis.IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { NextIntlClientProvider } = await import('next-intl');
const { ApprovalReview } = await import('./ApprovalReview.jsx');
const { ApprovalsPanel } = await import('../dashboard/ApprovalsPanel.jsx');
const { ToastProvider } = await import('../dashboard/Toast.jsx');
const dashboard = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;
const dashboardChrome = (await import('../../messages/en/dashboardChrome.json', { with: { type: 'json' } })).default;

const ID = '11111111-1111-4111-8111-111111111111';

function review(overrides = {}) {
  return {
    id: ID,
    operation: 'email_send',
    status: 'pending',
    state: 'pending',
    created_at: '2026-10-16T10:00:00.000Z',
    decided_at: null,
    decided_via: null,
    decided_by_label: null,
    expires_at: '2026-10-17T10:00:00.000Z',
    send_at: null,
    identity: { inbox_id: 'inbox-1', email_address: 'me@example.com', display_name: null, provider: 'gmail', service: null },
    recipients: { to: ['colleague@example.com'], cc: [], bcc: ['drop@evil.example'], bcc_count: 1 },
    subject: 'Notes',
    attachment_count: 0,
    forward_carries_original: false,
    attachments: [],
    body: { text: 'Harmless words', html: null, truncated: false, unavailable: null },
    provider: { labelKey: 'gmail', route: 'users.messages.send', caveatKeys: [] },
    role: 'owner',
    canDecide: true,
    recipientsResolvedAtSend: false,
    revision: 1,
    ...overrides,
  };
}

function page(props) {
  return createElement(NextIntlClientProvider, { locale: 'en', messages: { dashboard } },
    createElement(ApprovalReview, props));
}

function stubFetch(t, respond) {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    const { status = 200, body = {} } = respond(String(url), init, calls.length);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  t.after(() => { globalThis.fetch = previous; });
  return calls;
}

const button = (container, label) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === label);

async function click(el) {
  await flush(() => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
}

test('review page: the Bcc addresses are listed, not just counted', async (t) => {
  const view = await mount(page({ review: review(), csrfToken: 'tok-1' }));
  t.after(() => view.unmount());
  assert.match(view.container.textContent, /drop@evil\.example/);
});

test('review page: a viewer-shaped model (no addresses) still shows the count', async (t) => {
  const view = await mount(page({
    review: review({ recipients: { to: ['colleague@example.com'], cc: [], bcc: [], bcc_count: 2 }, canDecide: false, role: 'viewer' }),
    csrfToken: null,
  }));
  t.after(() => view.unmount());
  assert.match(view.container.textContent, /2 hidden recipients/);
});

test('review page: approve sends the rendered revision', async (t) => {
  const calls = stubFetch(t, () => ({ body: { success: true } }));
  const view = await mount(page({ review: review({ revision: 7 }), csrfToken: 'tok-1' }));
  t.after(() => view.unmount());
  await click(button(view.container, dashboard.approvals.review.approve));
  await waitFor(() => calls.length === 1, { message: 'the decision POST' });
  assert.equal(calls[0].url, `/api/approvals/${ID}/decide`);
  assert.deepEqual(calls[0].body, { decision: 'approve', csrf_token: 'tok-1', revision: 7 });
  await waitFor(() => view.container.textContent.includes(dashboard.approvals.review.done.approvedTitle), { message: 'the approved banner' });
});

test('review page: a changed request is announced, blocks deciding, and the fresh version can be approved', async (t) => {
  const calls = stubFetch(t, (_url, _init, n) =>
    n === 1
      ? { status: 409, body: { code: 'changed', error: 'This request changed after you opened it.' } }
      : { body: { success: true } });
  const view = await mount(page({ review: review(), csrfToken: 'tok-1' }));
  t.after(() => view.unmount());

  await click(button(view.container, dashboard.approvals.review.approve));
  await waitFor(() => view.container.textContent.includes(dashboard.approvals.review.states.changedTitle), { message: 'the changed banner' });
  assert.ok(!view.container.textContent.includes(dashboard.approvals.review.done.approvedTitle), 'not shown as approved');
  assert.equal(button(view.container, dashboard.approvals.review.approve).disabled, true, 'approve disabled until the fresh version arrives');
  assert.equal(button(view.container, dashboard.approvals.review.reject).disabled, true, 'reject too');

  // The server refresh delivers the edited request with a new token.
  await view.update(page({
    review: review({ revision: 2, body: { text: 'Edited words', html: null, truncated: false, unavailable: null } }),
    csrfToken: 'tok-2',
  }));
  assert.match(view.container.textContent, /Edited words/);
  assert.ok(view.container.textContent.includes(dashboard.approvals.review.states.changedBody), 'tells the reviewer to look again');
  const approve = button(view.container, dashboard.approvals.review.approve);
  assert.equal(approve.disabled, false);

  await click(approve);
  await waitFor(() => calls.length === 2, { message: 'the second POST' });
  assert.deepEqual(calls[1].body, { decision: 'approve', csrf_token: 'tok-2', revision: 2 });
});

// ---------------------------------------------------------------------------
// Dashboard decision dialog
// ---------------------------------------------------------------------------

function panel() {
  return createElement(NextIntlClientProvider, { locale: 'en', messages: { dashboard, dashboardChrome } },
    createElement(ToastProvider, null, createElement(ApprovalsPanel, { userRole: 'owner' })));
}

function pendingItem(overrides = {}) {
  return {
    id: ID,
    inbox_id: 'inbox-1',
    operation: 'email_send',
    summary: { to: ['colleague@example.com'], cc: [], bcc_count: 1, subject: 'Notes' },
    status: 'pending',
    created_at: '2026-10-16T10:00:00.000Z',
    revision: 1,
    bcc: ['drop@evil.example'],
    inboxes: { email_address: 'me@example.com', display_name: null },
    ...overrides,
  };
}

test('dashboard dialog: shows the Bcc addresses and a link to the full review, and sends the revision', async (t) => {
  const calls = stubFetch(t, (url, init) =>
    (init.method ?? 'GET') === 'GET'
      ? { body: { approvals: [pendingItem({ revision: 3 })], decided: [] } }
      : { body: { success: true } });
  const view = await mount(panel());
  t.after(() => view.unmount());
  await waitFor(() => button(view.container, 'Review & approve'), { message: 'the queue row' });
  await click(button(view.container, 'Review & approve'));
  const dialog = await waitFor(() => view.container.querySelector('[role="dialog"]'), { message: 'the dialog' });
  assert.match(dialog.textContent, /drop@evil\.example/);
  const link = [...dialog.querySelectorAll('a')].find((a) => a.getAttribute('href') === `/approvals/${ID}`);
  assert.ok(link, 'links to the full review');

  await click(button(dialog, 'Approve & queue'));
  await waitFor(() => calls.some((c) => c.method === 'PATCH'), { message: 'the PATCH' });
  assert.deepEqual(calls.find((c) => c.method === 'PATCH').body, { id: ID, decision: 'approve', revision: 3 });
});

test('dashboard dialog: a changed request reloads, stays open on the current version, and says so', async (t) => {
  let gets = 0;
  let patches = 0;
  const calls = stubFetch(t, (url, init) => {
    if ((init.method ?? 'GET') === 'GET') {
      gets++;
      return {
        body: {
          approvals: [gets === 1
            ? pendingItem()
            : pendingItem({ revision: 2, bcc: ['drop@evil.example', 'second@evil.example'], summary: { to: ['colleague@example.com'], bcc_count: 2, subject: 'Edited' } })],
          decided: [],
        },
      };
    }
    patches++;
    return patches === 1
      ? { status: 409, body: { code: 'changed', error: 'This request changed after you opened it.' } }
      : { body: { success: true } };
  });
  const view = await mount(panel());
  t.after(() => view.unmount());
  await waitFor(() => button(view.container, 'Review & approve'), { message: 'the queue row' });
  await click(button(view.container, 'Review & approve'));
  let dialog = await waitFor(() => view.container.querySelector('[role="dialog"]'), { message: 'the dialog' });
  await click(button(dialog, 'Approve & queue'));

  dialog = await waitFor(() => {
    const d = view.container.querySelector('[role="dialog"]');
    return d && d.textContent.includes(dashboard.approvals.panel.changedNotice) ? d : null;
  }, { message: 'the changed notice in the dialog' });
  assert.match(dialog.textContent, /second@evil\.example/, 'the current Bcc list');
  assert.match(dialog.textContent, /Edited/, 'the current subject');

  await click(button(dialog, 'Approve & queue'));
  await waitFor(() => patches === 2, { message: 'the second PATCH' });
  const last = calls.filter((c) => c.method === 'PATCH').at(-1);
  assert.deepEqual(last.body, { id: ID, decision: 'approve', revision: 2 });
});
