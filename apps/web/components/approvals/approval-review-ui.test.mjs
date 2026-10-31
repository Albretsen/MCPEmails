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
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
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

  await click(button(dialog, dashboard.approvals.panel.approveAndSend));
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
  assert.equal(button(dialog, dashboard.approvals.panel.approveAndSend).disabled, true);
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
    return d && !button(d, dashboard.approvals.panel.approveAndSend)?.disabled ? d : null;
  }, { message: 'details loaded' });
  await click(button(dialog, dashboard.approvals.panel.approveAndSend));

  dialog = await waitFor(() => {
    const d = view.container.querySelector('[role="dialog"]');
    return d && d.textContent.includes(dashboard.approvals.panel.changedNotice) && /second@evil\.example/.test(d.textContent) ? d : null;
  }, { message: 'the changed notice with the current details' });
  assert.match(dialog.textContent, /Edited/, 'the current subject');

  await click(button(dialog, dashboard.approvals.panel.approveAndSend));
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

// ---------------------------------------------------------------------------
// Rule forwards: what the queue says, deadlines, delivery, Forward again and
// Approve all.
// ---------------------------------------------------------------------------

const ADDRESS = 'ap@example.com';

function ruleRow(id, overrides = {}) {
  return {
    id,
    kind: 'rule_forward',
    rule_id: 'rule-1',
    rule_name: 'Invoices',
    rule_deleted: false,
    operation: 'email_forward',
    status: 'pending',
    revision: 2,
    created_at: '2026-10-30T10:00:00.000Z',
    expires_at: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000 + 60_000).toISOString(),
    inboxes: { email_address: 'me@example.com', display_name: null },
    summary: { to: [ADDRESS], subject: `Invoice ${id}` },
    ...overrides,
  };
}

function panelFetch({ approvals = [], decided = [], routes = {} }) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const route = routes[String(url)];
    if (route) return route(init);
    if (String(url) === '/api/approvals') {
      return new Response(JSON.stringify({ approvals, decided }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: 'unavailable', reason: 'mailbox' }), { status: 200 });
  };
  return calls;
}

function mountPanel(role = 'owner') {
  return mount(
    createElement(
      NextIntlClientProvider,
      { locale: 'en', messages: { dashboard, dashboardChrome } },
      createElement(ToastProvider, null, createElement(ApprovalsPanel, { userRole: role })),
    ),
  );
}

const mountReview = (model) => mount(page({ review: model, csrfToken: 'tok-1' }));
const buttonNamed = (name) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === name);

test('queue: a rule forward shows its rule, Forward, the address and the time left', async () => {
  panelFetch({ approvals: [ruleRow('a')] });
  const root = await mountPanel();
  await waitFor(() => document.body.textContent.includes('Invoices'));
  const text = document.body.textContent;
  assert.equal(text.includes('Forward'), true);
  assert.equal(text.includes(ADDRESS), true);
  assert.equal(text.includes('6 days left'), true);
  root.unmount();
});

test('queue: an expired row is not offered, and is listed as Expired with nobody deciding', async () => {
  panelFetch({
    approvals: [],
    decided: [ruleRow('b', { status: 'expired', decider: 'none', decided_via: null, can_forward_again: true })],
  });
  const root = await mountPanel();
  await waitFor(() => document.body.textContent.includes('Recently decided'));
  const text = document.body.textContent;
  assert.equal(text.includes('Expired'), true);
  assert.equal(text.includes('Nobody decided'), true);
  assert.equal(text.includes('Decided in the dashboard'), false);
  assert.equal(buttonNamed('Review & approve') === undefined, true);
  root.unmount();
});

test('queue: a member sees no Forward again and no Approve all', async () => {
  panelFetch({
    approvals: [ruleRow('a'), ruleRow('c')],
    decided: [ruleRow('b', { status: 'expired', decider: 'none', can_forward_again: true })],
  });
  const root = await mountPanel('member');
  await waitFor(() => document.body.textContent.includes('Recently decided'));
  assert.equal(buttonNamed('Forward again') === undefined, true);
  assert.equal(buttonNamed('Approve all from this rule') === undefined, true);
  root.unmount();
});

test('decided list: an approved send shows Sent or Failed with a plain reason, never the raw error', async () => {
  panelFetch({
    decided: [
      ruleRow('s', { status: 'approved', decider: 'person', decided_via: 'dashboard', delivery: { state: 'sent', reason: null, at: null } }),
      ruleRow('f', { status: 'approved', decider: 'person', decided_via: 'dashboard', delivery: { state: 'failed', reason: 'original_ambiguous', at: null } }),
    ],
  });
  const root = await mountPanel();
  await waitFor(() => document.body.textContent.includes('Recently decided'));
  const text = document.body.textContent;
  assert.equal(text.includes('Sent'), true);
  assert.equal(text.includes('Failed'), true);
  assert.equal(text.includes('same Message-ID'), true);
  root.unmount();
});

test('decided list: an automatic decision does not read as a person in the dashboard', async () => {
  panelFetch({
    decided: [ruleRow('z', { status: 'approved', decider: 'automatic', decided_via: 'auto_rule', delivery: null })],
  });
  const root = await mountPanel();
  await waitFor(() => document.body.textContent.includes('Recently decided'));
  assert.equal(document.body.textContent.includes('Decided automatically'), true);
  root.unmount();
});

test('Forward again posts an empty body: no address can be supplied', async () => {
  const calls = panelFetch({
    decided: [ruleRow('b', { status: 'expired', decider: 'none', can_forward_again: true })],
    routes: {
      '/api/approvals/b/forward-again': async () => new Response(JSON.stringify({ success: true, id: 'n' }), { status: 201 }),
    },
  });
  const root = await mountPanel();
  await waitFor(() => buttonNamed('Forward again'));
  await flush(() => buttonNamed('Forward again').click());
  assert.equal(document.body.textContent.includes(ADDRESS), true, 'the confirmation names the address');
  await flush(() => buttonNamed('Create request').click());
  await waitFor(() => calls.some((call) => call.url === '/api/approvals/b/forward-again'));
  const post = calls.find((call) => call.url === '/api/approvals/b/forward-again');
  assert.equal(post.init.body, '{}');
  root.unmount();
});

test('Approve all shows the count and address, sends the rows seen, and reports each row', async () => {
  const calls = panelFetch({
    approvals: [ruleRow('a'), ruleRow('c')],
    routes: {
      '/api/approvals/approve-rule': async () =>
        new Response(JSON.stringify({ outcomes: [{ id: 'a', outcome: 'approved' }, { id: 'c', outcome: 'expired' }] }), { status: 200 }),
    },
  });
  const root = await mountPanel();
  await waitFor(() => buttonNamed('Approve all from this rule'));
  await flush(() => buttonNamed('Approve all from this rule').click());
  assert.equal(document.body.textContent.includes('2 forwards from the rule "Invoices" will go to ap@example.com.'), true);
  await flush(() => buttonNamed('Approve 2').click());
  await waitFor(() => document.body.textContent.includes('1 of 2 approved'));
  const post = calls.find((call) => call.url === '/api/approvals/approve-rule');
  assert.deepEqual(JSON.parse(post.init.body), {
    rule_id: 'rule-1',
    address: ADDRESS,
    items: [{ id: 'a', revision: 2 }, { id: 'c', revision: 2 }],
  });
  assert.equal(document.body.textContent.includes('Expired, skipped'), true);
  root.unmount();
});

test('Approve all is not offered for rows going to two addresses', async () => {
  panelFetch({ approvals: [ruleRow('a'), ruleRow('c', { summary: { to: ['other@example.com'], subject: 'x' } })] });
  const root = await mountPanel();
  await waitFor(() => document.body.textContent.includes('more than one address'));
  assert.equal(buttonNamed('Approve all from this rule') === undefined, true);
  root.unmount();
});

test('the dialog closes on an expired answer, with a message, and offers no retry', async () => {
  panelFetch({
    approvals: [ruleRow('a')],
    routes: {
      '/api/approvals/a': async () => new Response(JSON.stringify({ revision: 2, to: [ADDRESS], subject: 'x', approvable: true }), { status: 200 }),
    },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url) === '/api/approvals' && init.method === 'PATCH') {
      return new Response(JSON.stringify({ code: 'expired', error: 'x' }), { status: 409 });
    }
    return realFetch(url, init);
  };
  const root = await mountPanel();
  await waitFor(() => buttonNamed('Review & approve'));
  await flush(() => buttonNamed('Review & approve').click());
  await waitFor(() => buttonNamed('Approve & send') && !buttonNamed('Approve & send').disabled);
  await flush(() => buttonNamed('Approve & send').click());
  await waitFor(() => document.body.textContent.includes('This request expired'));
  assert.equal(document.querySelector('[role="dialog"]') === null, true);
  root.unmount();
});

test('review page: the original is read live, and a failed read still allows Reject', async () => {
  const calls = panelFetch({});
  const root = await mountReview(
    review({ kind: 'rule_forward', rule_name: 'Invoices', operation: 'email_forward', forward_carries_original: true, body: { text: null, html: null, truncated: false, unavailable: 'absent' }, role: 'owner' }),
  );
  await waitFor(() => document.body.textContent.includes('The mailbox could not be read'));
  assert.equal(calls.some((call) => call.url === `/api/approvals/${ID}/original`), true);
  assert.equal(document.body.textContent.includes('This request has no message text'), false);
  assert.equal(document.body.textContent.includes('The rule "Invoices" prepared this forward'), true);
  assert.equal(buttonNamed('Reject').disabled, false);
  root.unmount();
});

test('review page: names, date, preview and files of the original are shown as text', async () => {
  panelFetch({
    routes: {
      [`/api/approvals/${ID}/original`]: async () => new Response(JSON.stringify({
        status: 'ok', moved: true, from_name: 'Billing', from_email: 'b@example.com', date: '2026-10-30T10:00:00.000Z',
        preview: '<img src=x onerror=alert(1)>', attachments: [{ filename: 'invoice.pdf', size_bytes: 2048 }],
      }), { status: 200 }),
    },
  });
  const root = await mountReview(review({ kind: 'rule_forward', rule_name: 'Invoices', operation: 'email_forward', role: 'owner' }));
  await waitFor(() => document.body.textContent.includes('invoice.pdf'));
  assert.equal(document.body.textContent.includes('b@example.com'), true);
  assert.equal(document.body.textContent.includes('2 KB'), true);
  assert.equal(document.body.textContent.includes('<img src=x'), true, 'markup stays text');
  assert.equal(document.querySelector('.original-message img') === null, true);
  assert.equal(document.body.textContent.includes('has moved'), true);
  root.unmount();
});

test('review page: an expired rule forward does not say someone decided, and points at Forward again', async () => {
  panelFetch({});
  const root = await mountReview(
    review({ kind: 'rule_forward', rule_name: 'Invoices', operation: 'email_forward', state: 'expired', status: 'expired', decided_at: '2026-10-20T10:00:00.000Z', decided_via: null, role: 'owner' }),
  );
  await flush();
  const text = document.body.textContent;
  assert.equal(text.includes('This request expired'), true);
  assert.equal(text.includes('forward it again'), true);
  assert.equal(text.includes('Ask your assistant'), false);
  assert.equal(text.includes('Decided in'), false);
  root.unmount();
});
