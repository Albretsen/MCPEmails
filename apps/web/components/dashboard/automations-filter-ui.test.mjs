// ---------------------------------------------------------------------------
// The automation form refuses a filter the inbox's provider cannot run.
//
// Run with: npm run test:automations-ui
//
// WHY THIS EXISTS, SEPARATELY FROM src/lib/automations/rules.test.ts. That
// suite proves the RULE: which criteria each dialect cannot honour, and that
// /api/automations refuses them. It cannot fail for any of the ways the rule
// can be right and the screen still wrong — the dashboard handing the panel an
// inbox list with no `provider` on it, the panel reading a field the server
// fetch does not send, the refusal rendering but Save staying live, or the
// message surviving after the user picks a mailbox that CAN run the filter.
//
// That wiring is the actual gap this round closed. F-04 (2026-09-20) found
// `has_attachment` silently dropped on generic IMAP; the edge function refuses
// such a rule at write time, and until 2026-09-21 the dashboard let it save and
// told the user days later, in a run log, as `filter_unsupported`.
//
// So this renders the REAL dashboard (`DashboardApp` in the real
// `AppLocaleProvider`, real English messages) and reads the DOM. `fetch` is the
// only thing replaced.
//
// Only reserved example domains appear below.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush } from '../../scripts/test-dom.mjs';

installDom();
globalThis.self ??= globalThis.window;
globalThis.IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { DashboardApp } = await import('./App.jsx');
const dashboard = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;

const modal = dashboard.automations.modal;
const WORKSPACE_ID = 'ws-0001';

/**
 * An inbox row shaped exactly as apps/web/app/dashboard/[[...section]]/page.js
 * builds it. `provider` is the BRANDED value that file writes ('yahoo' and
 * friends for the IMAP connectors, 'imap' only for the generic one), which is
 * the whole reason the panel maps it through searchDialectFor rather than
 * comparing it to 'imap'.
 */
function inbox(id, address, provider) {
  return {
    id,
    label: address.split('@')[0],
    displayName: null,
    address,
    provider,
    status: 'active',
    lastError: null,
    hasImap: provider !== 'gmail' && provider !== 'outlook',
    service: provider === 'imap' ? 'generic' : provider,
    calls: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    lastCallAt: null,
    draftEditorHidden: false,
    sendReviewMode: 'off',
    sendApprovalRequired: false,
  };
}

const INBOXES = [
  inbox('ib-0001', 'ops@acme.example', 'imap'),
  inbox('ib-0002', 'ada@example.com', 'gmail'),
  inbox('ib-0003', 'team@contoso.example', 'outlook'),
  inbox('ib-0004', 'ada@example.net', 'yahoo'),
];

const KEYS = [{ id: 'ak-0001', name: 'Assistant', scopes: ['read:email', 'manage:folders'], inboxIds: null }];

async function renderAutomations(t) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    // The panel loads its rules on mount. An empty workspace is enough: this
    // suite is about the create form, not the list.
    if (String(url).startsWith('/api/automations')) {
      return { ok: true, status: 200, json: async () => ({ role: 'owner', automations: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const view = await mount(createElement(AppLocaleProvider, null,
    createElement(DashboardApp, {
      initialRoute: 'automations',
      user: { displayName: 'Ada', email: 'ada@example.com', initials: 'A', id: 'u-0001' },
      workspace: {
        id: WORKSPACE_ID,
        slug: 'acme',
        plan: 'pro',
        compedScale: null,
        displayName: 'Acme',
        isOwner: true,
        draftEditorEnabled: false,
        draftEditorHidden: false,
      },
      workspaces: [],
      activeWorkspaceId: WORKSPACE_ID,
      mcpUrl: 'https://mcpemails.com/api/mcp',
      userRole: 'owner',
      planLimits: { maxInboxes: 10, historyDays: 90 },
      stripePrices: {},
      overviewStats: {},
      activityFeed: [],
      inboxes: INBOXES,
      apiKeys: KEYS,
      usageData: {},
      auditLog: [],
      members: [],
      pendingInvites: [],
    })));

  t.after(async () => {
    await view.unmount();
    globalThis.fetch = previousFetch;
  });

  // Let the mount-time load settle so the New button is rendered.
  await flush(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  return view;
}

const dialogOf = (view) => view.container.querySelector('[role="dialog"]');

async function click(node) {
  await flush(async () => { node.click(); });
}

async function openForm(view) {
  const button = [...view.container.querySelectorAll('button')]
    .find((b) => b.textContent.includes(dashboard.automations.newButton));
  assert.ok(button, 'the Automations page should have its "New automation" button');
  await click(button);
  const dialog = dialogOf(view);
  assert.ok(dialog, 'the create form should be open');
  return dialog;
}

/** Sets a controlled <select>, the way React hears it. */
async function choose(select, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  await flush(async () => {
    setter.call(select, value);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

const selectInbox = (dialog) => dialog.querySelector('#automation-inbox');

/**
 * Ticks one of the boolean filter checkboxes.
 *
 * `.click()` rather than the shared `toggle()` helper in test-dom.mjs, which
 * assigns `input.checked` first. React installs its own `checked` descriptor on
 * the node to track changes, so assigning through it updates the tracker and
 * React then concludes nothing changed and never fires onChange. A real click
 * flips the checkedness underneath that property, which is why the person at
 * the keyboard sees the refusal and the helper did not.
 */
async function toggleFilter(dialog, labelText) {
  const label = [...dialog.querySelectorAll('label')].find((l) => l.textContent.trim() === labelText);
  assert.ok(label, `the form should offer the "${labelText}" filter`);
  await flush(async () => { label.querySelector('input[type="checkbox"]').click(); });
}

/** Types into a controlled text input, bypassing React's value tracker. */
async function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await flush(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

const saveButton = (dialog) => [...dialog.querySelectorAll('button[type="submit"]')][0];

/** The refusal exactly as the English locale renders it, list and all. */
function refusal(labels, provider) {
  const quoted = labels.map((label) => modal.filterFieldQuoted.replace('{label}', label));
  const fields = quoted.length <= 1
    ? quoted.join('')
    : `${quoted.slice(0, -1).join(', ')} ${modal.filterFieldAnd} ${quoted[quoted.length - 1]}`;
  return modal.filterUnsupported.replaceAll('{fields}', fields).replaceAll('{provider}', provider);
}

/** The refusal's opening words, for asserting that it is NOT on screen. */
const REFUSAL_OPENING = modal.filterUnsupported.split('{')[0];

// ===========================================================================

test('an attachment filter on a generic IMAP inbox is refused before it is saved', async (t) => {
  const view = await renderAutomations(t);
  const dialog = await openForm(view);

  await choose(selectInbox(dialog), 'ib-0001');
  await toggleFilter(dialog, modal.filterHasAttachment);

  // The incident itself, on the screen: RFC 3501 SEARCH has no attachment
  // predicate, so this rule would act on every message matching the rest of
  // the filter, every fifteen minutes, unattended.
  assert.ok(
    dialog.textContent.includes(refusal([modal.filterHasAttachment], modal.dialectImap)),
    'the form should say which condition this provider cannot run, and which provider that is',
  );
  assert.equal(saveButton(dialog).disabled, true, 'Save must not be live while the rule cannot run');
});

test('the same filter on Gmail saves, and switching mailbox clears the refusal', async (t) => {
  const view = await renderAutomations(t);
  const dialog = await openForm(view);

  await choose(selectInbox(dialog), 'ib-0001');
  await toggleFilter(dialog, modal.filterHasAttachment);
  assert.equal(saveButton(dialog).disabled, true);

  // Gmail expresses every field this form offers. The refusal is a property of
  // the mailbox, not of the filter, so re-pointing the rule has to clear it —
  // the branded IMAP connectors below are the same test from the other side.
  await choose(selectInbox(dialog), 'ib-0002');
  assert.equal(
    dialog.textContent.includes(REFUSAL_OPENING),
    false,
    'a provider that can run the filter should leave no refusal behind',
  );
  assert.equal(saveButton(dialog).disabled, false, 'Save should be live again');
});

test('a branded IMAP connector is judged as IMAP, not as its brand', async (t) => {
  const view = await renderAutomations(t);
  const dialog = await openForm(view);

  // The dashboard shows Yahoo as 'yahoo', but it is an IMAP connector and has
  // no attachment predicate either. Reading the branded value literally would
  // have let this one save.
  await choose(selectInbox(dialog), 'ib-0004');
  await toggleFilter(dialog, modal.filterHasAttachment);

  assert.ok(dialog.textContent.includes(refusal([modal.filterHasAttachment], modal.dialectImap)));
  assert.equal(saveButton(dialog).disabled, true);
});

test('Outlook loses its whole $filter to a free-text criterion, and the form names every field', async (t) => {
  const view = await renderAutomations(t);
  const dialog = await openForm(view);

  await choose(selectInbox(dialog), 'ib-0003');
  // Flagged alone: Graph has no usable predicate for it in $search or $filter.
  await toggleFilter(dialog, modal.filterFlagged);
  assert.ok(dialog.textContent.includes(refusal([modal.filterFlagged], modal.dialectOutlook)));

  // Now the larger drop. Graph refuses to combine $search and $filter on
  // /messages, so a subject search abandons the whole $filter and takes
  // `unread` and `has_attachment` with it. BOTH have to be named, or the user
  // removes one and meets the other.
  await toggleFilter(dialog, modal.filterFlagged);
  await toggleFilter(dialog, modal.filterUnread);
  await toggleFilter(dialog, modal.filterHasAttachment);
  await type(dialog.querySelector('#automation-filter-subject'), 'invoice');

  assert.ok(
    dialog.textContent.includes(
      refusal([modal.filterUnread, modal.filterHasAttachment], modal.dialectOutlook),
    ),
    'a subject search on Outlook drops the rest of the $filter, and the form should name all of it',
  );
  assert.equal(saveButton(dialog).disabled, true);
});

test('a filter every provider can run leaves Save alone', async (t) => {
  const view = await renderAutomations(t);
  const dialog = await openForm(view);

  await choose(selectInbox(dialog), 'ib-0001');
  await toggleFilter(dialog, modal.filterUnread);

  assert.equal(dialog.textContent.includes(REFUSAL_OPENING), false);
  assert.equal(saveButton(dialog).disabled, false);
});
