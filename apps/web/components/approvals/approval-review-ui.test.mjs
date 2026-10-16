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
    reply_to: [],
    approvable: true,
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

/** What GET /api/approvals/[id] answers for the dialog. */
function details(overrides = {}) {
  return {
    id: ID,
    status: 'pending',
    revision: 1,
    to: ['colleague@example.com'],
    cc: [],
    subject: 'Notes',
    bcc: ['drop@evil.example'],
    bcc_count: 1,
    approvable: true,
    ...overrides,
  };
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
    inboxes: { email_address: 'me@example.com', display_name: null },
    ...overrides,
  };
}


const isList = (url, init) => url === '/api/approvals' && (init.method ?? 'GET') === 'GET';
const isDetails = (url) => url === `/api/approvals/${ID}`;

async function openDialog(t, respond, label = 'Review & approve') {
  const calls = stubFetch(t, respond);
  const view = await mount(panel());
  t.after(() => view.unmount());
  await waitFor(() => button(view.container, label), { message: 'the queue row' });
  await click(button(view.container, label));
  const dialog = await waitFor(() => view.container.querySelector('[role="dialog"]'), { message: 'the dialog' });
  return { calls, view, dialog };
}

test('dashboard: the queue loads no Bcc; the dialog fetches this one approval and shows its addresses', async (t) => {
  const { calls, dialog } = await openDialog(t, (url, init) =>
    isList(url, init) ? { body: { approvals: [pendingItem({ revision: 3 })], decided: [] } }
      : isDetails(url) ? { body: details({ revision: 4 }) }
      : { body: { success: true } });
  await waitFor(() => /drop@evil\.example/.test(dialog.textContent), { message: 'the Bcc addresses' });
  assert.ok(calls.some((c) => isDetails(c.url)), 'details fetched on open');
  const link = [...dialog.querySelectorAll('a')].find((a) => a.getAttribute('href') === `/approvals/${ID}`);
  assert.ok(link, 'links to the full review');

  await click(button(dialog, 'Approve & queue'));
  await waitFor(() => calls.some((c) => c.method === 'PATCH'), { message: 'the PATCH' });
  // The revision of the details shown, not the (older) queue row's.
  assert.deepEqual(calls.find((c) => c.method === 'PATCH').body, { id: ID, decision: 'approve', revision: 4 });
});

test('dashboard: Approve waits for the details, and stays off if they cannot be loaded; Reject does not wait', async (t) => {
  const { dialog } = await openDialog(t, (url, init) =>
    isList(url, init) ? { body: { approvals: [pendingItem()], decided: [] } }
      : isDetails(url) ? { status: 500, body: { error: 'boom' } }
      : { body: { success: true } });
  await waitFor(() => dialog.textContent.includes(dashboard.approvals.panel.detailsFailed), { message: 'the failure notice' });
  const confirm = [...dialog.querySelectorAll('.modal-foot button')].at(-1);
  assert.equal(confirm.disabled, true, 'no approve without the details');
});

test('dashboard: reject is available even when the details fail to load', async (t) => {
  const { calls, dialog } = await openDialog(t, (url, init) =>
    isList(url, init) ? { body: { approvals: [pendingItem()], decided: [] } }
      : isDetails(url) ? { status: 500, body: {} }
      : { body: { success: true } }, 'Reject');
  await waitFor(() => dialog.textContent.includes(dashboard.approvals.panel.detailsFailed), { message: 'the failure notice' });
  const reject = button(dialog, 'Reject request');
  assert.equal(reject.disabled, false);
  await click(reject);
  await waitFor(() => calls.some((c) => c.method === 'PATCH'), { message: 'the PATCH' });
  assert.deepEqual(calls.find((c) => c.method === 'PATCH').body, { id: ID, decision: 'reject', revision: null });
});

test('dashboard: a legacy draft send cannot be approved from the dialog, and says why', async (t) => {
  const { dialog } = await openDialog(t, (url, init) =>
    isList(url, init) ? { body: { approvals: [pendingItem({ operation: 'draft_send' })], decided: [] } }
      : isDetails(url) ? { body: details({ approvable: false }) }
      : { body: { success: true } });
  await waitFor(() => dialog.textContent.includes(dashboard.approvals.review.bodyStoredWithProvider), { message: 'the explanation' });
  assert.equal(button(dialog, 'Approve & queue').disabled, true);
});

test('dashboard: a changed request reloads, stays open on the current version, and says so', async (t) => {
  let patches = 0;
  let detailReads = 0;
  const { calls, view } = await openDialog(t, (url, init) => {
    if (isList(url, init)) return { body: { approvals: [pendingItem()], decided: [] } };
    if (isDetails(url)) {
      detailReads++;
      return {
        body: detailReads === 1
          ? details()
          : details({ revision: 2, bcc: ['drop@evil.example', 'second@evil.example'], bcc_count: 2, subject: 'Edited' }),
      };
    }
    patches++;
    return patches === 1
      ? { status: 409, body: { code: 'changed', error: 'This request changed after you opened it.' } }
      : { body: { success: true } };
  });
  let dialog = await waitFor(() => {
    const d = view.container.querySelector('[role="dialog"]');
    return d && !button(d, 'Approve & queue')?.disabled ? d : null;
  }, { message: 'details loaded' });
  await click(button(dialog, 'Approve & queue'));

  dialog = await waitFor(() => {
    const d = view.container.querySelector('[role="dialog"]');
    return d && d.textContent.includes(dashboard.approvals.panel.changedNotice) && /second@evil\.example/.test(d.textContent) ? d : null;
  }, { message: 'the changed notice with the current details' });
  assert.match(dialog.textContent, /Edited/, 'the current subject');

  await click(button(dialog, 'Approve & queue'));
  await waitFor(() => patches === 2, { message: 'the second PATCH' });
  const last = calls.filter((c) => c.method === 'PATCH').at(-1);
  assert.deepEqual(last.body, { id: ID, decision: 'approve', revision: 2 });
});

test('review page: a legacy draft send offers Reject only, with the reason shown', async (t) => {
  const view = await mount(page({
    review: review({
      operation: 'draft_send',
      approvable: false,
      body: { text: null, html: null, truncated: false, unavailable: 'stored_with_provider' },
    }),
    csrfToken: 'tok-1',
  }));
  t.after(() => view.unmount());
  assert.ok(view.container.textContent.includes(dashboard.approvals.review.bodyStoredWithProvider));
  assert.equal(button(view.container, dashboard.approvals.review.approve).disabled, true);
  assert.equal(button(view.container, dashboard.approvals.review.reject).disabled, false);
});

test('review page: a Reply-To is shown', async (t) => {
  const view = await mount(page({ review: review({ reply_to: ['desk@example.com'] }), csrfToken: 'tok-1' }));
  t.after(() => view.unmount());
  assert.ok(view.container.textContent.includes(dashboard.approvals.review.replyTo));
  assert.match(view.container.textContent, /desk@example\.com/);
});
