// ---------------------------------------------------------------------------
// The /authorize consent screen for a connector-first user (onboarding WP-G).
//
// Run with: npm run test:authorize-connector-first-ui
//
//   - preferStandard (claude.ai, no mailbox yet): opens on Standard, and the
//     narrower Read-only card is still selectable;
//   - inboxStep: the inbox step comes first, with "Skip, connect later";
//     skipping or connecting reports one funnel event and shows the
//     permissions card; "Connect an inbox" under Specific inboxes goes back;
//   - without inboxStep the screen opens on the permissions card as before.
//
// next/dynamic is stubbed: the real inbox step is WP-E's and has its own tests.
// ---------------------------------------------------------------------------

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush } from '../../scripts/test-dom.mjs';

const window = installDom();

mock.module('next/dynamic', {
  defaultExport: () => function InboxStepStub(props) {
    return createElement('button', { type: 'button', 'data-testid': 'stub-inbox-step', onClick: props.onConnected }, 'connect');
  },
});

const { NextIntlClientProvider } = await import('next-intl');
const { AuthorizeApp } = await import('./AuthorizeApp.jsx');
const auth = (await import('../../messages/en/auth.json', { with: { type: 'json' } })).default;

window._virtualConsole?.removeAllListeners?.('jsdomError');

const events = [];
globalThis.fetch = async (url, init) => {
  if (String(url).includes('/api/onboarding/authorize-event')) events.push(JSON.parse(init.body));
  return new Response('{}', { status: 200 });
};

const ALL = [
  'read:email', 'search:email', 'send:email', 'manage:folders', 'delete:email',
  'manage:drafts', 'manage:contacts', 'schedule:email', 'manage:automations',
];
const menu = (scopes) => scopes.map((scope) => ({ scope, icon: 'key', title: scope, desc: '' }));

async function render(t, props) {
  const view = await mount(
    createElement(
      NextIntlClientProvider,
      { locale: 'en', messages: { auth } },
      createElement(AuthorizeApp, {
        client: { client_id: 'https://claude.ai/oauth/claude-code-client-metadata', client_name: 'Claude' },
        workspaceName: 'Acme',
        requestedScopes: menu(ALL),
        clientRequestedScopes: ['read:email'],
        inboxes: [],
        redirectUri: 'https://claude.ai/api/mcp/auth_callback',
        oauthState: 's',
        codeChallenge: 'c',
        challengeMethod: 'S256',
        csrfToken: 'csrf',
        ...props,
      }),
    ),
  );
  t.after(() => view.unmount());
  return view;
}

const preset = (container, id) =>
  [...container.querySelectorAll('.az-preset')].find((el) =>
    el.querySelector('.az-preset-title')?.textContent === auth.authorize.preset[id].title);

test('preferStandard opens on Standard; Read-only stays selectable', async (t) => {
  const { container } = await render(t, { preferStandard: true });
  assert.equal(preset(container, 'standard').getAttribute('aria-checked'), 'true');
  assert.equal(preset(container, 'readOnly').getAttribute('aria-disabled'), 'false');
  preset(container, 'readOnly').click();
  await flush();
  assert.equal(preset(container, 'readOnly').getAttribute('aria-checked'), 'true');
});

test('without preferStandard, read:email still opens on Read-only', async (t) => {
  const { container } = await render(t, {});
  assert.equal(preset(container, 'readOnly').getAttribute('aria-checked'), 'true');
  assert.equal(Boolean(container.querySelector('[data-testid="az-inbox-stage"]')), false);
});

test('inbox step first; skip reports authorize_skipped and shows the permissions card', async (t) => {
  events.length = 0;
  const { container } = await render(t, { inboxStep: { client: 'claude', userEmail: 'a@gmail.com', returnTo: '/authorize?client_id=x' } });
  await flush();
  assert.ok(container.querySelector('[data-testid="az-inbox-stage"]'), 'the inbox stage is shown');
  assert.equal(Boolean(container.querySelector('.az-preset')), false);
  assert.deepEqual(events.map((e) => e.stage), ['authorize_inbox_step_viewed']);

  container.querySelector('[data-testid="az-skip-inbox"]').click();
  await flush();
  assert.equal(Boolean(container.querySelector('[data-testid="az-inbox-stage"]')), false);
  assert.ok(preset(container, 'readOnly'), 'the permissions card is shown');
  assert.deepEqual(events.map((e) => [e.stage, e.client]), [
    ['authorize_inbox_step_viewed', 'claude'],
    ['authorize_skipped', 'claude'],
  ]);

  // Specific inboxes -> "Connect an inbox" returns to the step, OAuth intact.
  const specific = [...container.querySelectorAll('input[name="az-inbox-mode"]')][1];
  specific.click();
  await flush();
  container.querySelector('[data-testid="az-back-to-inbox-step"]').click();
  await flush();
  assert.ok(container.querySelector('[data-testid="az-inbox-stage"]'));
});

test('connecting on the step reports authorize_inbox_connected and says so on the card', async (t) => {
  events.length = 0;
  const { container } = await render(t, { inboxStep: { client: 'chatgpt', userEmail: '', returnTo: '/authorize?client_id=x' } });
  await flush();
  container.querySelector('[data-testid="stub-inbox-step"]').click();
  await flush();
  assert.ok(container.querySelector('[data-testid="az-inbox-connected"]'));
  assert.deepEqual(events.map((e) => e.stage), ['authorize_inbox_step_viewed', 'authorize_inbox_connected']);
});
