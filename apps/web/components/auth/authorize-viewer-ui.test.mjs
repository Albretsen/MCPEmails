// ---------------------------------------------------------------------------
// The /authorize consent screen for a workspace VIEWER.
//
// Run with: npm run test:authorize-viewer-ui
//
// page.js cuts the scope menu down to the read-only allow-list for a viewer
// and passes `roleLimited`. This renders the real AuthorizeApp and pins what
// the person sees:
//
//   - a one-line note saying why only read-only access is offered;
//   - Read-only selected; Standard and Full greyed out with a viewer tooltip
//     (not "this app didn't request these permissions", which would be false);
//   - Allow sends read-only scopes only;
//   - nothing grantable left: a viewer-specific message and Allow disabled;
//   - for everyone else, the screen is what it was: no note, Standard and
//     Full selectable, the original tooltip.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush } from '../../scripts/test-dom.mjs';

const window = installDom();

const { NextIntlClientProvider } = await import('next-intl');
const { AuthorizeApp } = await import('./AuthorizeApp.jsx');
const auth = (await import('../../messages/en/auth.json', { with: { type: 'json' } })).default;

window._virtualConsole?.removeAllListeners?.('jsdomError');

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
        client: { client_id: 'dyn_test', client_name: 'Test Client' },
        workspaceName: 'Acme',
        requestedScopes: menu(ALL),
        inboxes: [{ id: 'ib-1', email_address: 'a@acme.test', provider: 'imap', status: 'connected' }],
        redirectUri: 'https://client.example.test/cb',
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
const allowButton = (container) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent.includes(auth.authorize.allowAccess));

test('viewer: the note explains the read-only limit, wider levels are greyed with a viewer tooltip', async (t) => {
  const { container } = await render(t, { requestedScopes: menu(['read:email', 'search:email']), roleLimited: true });

  const note = container.querySelector('.az-role-note');
  assert.ok(note, 'the viewer note is shown');
  assert.equal(note.textContent, auth.authorize.viewerScopeNote.replace('{workspace}', 'Acme'));

  assert.equal(preset(container, 'readOnly').getAttribute('aria-checked'), 'true');
  for (const id of ['standard', 'full']) {
    assert.equal(preset(container, id).getAttribute('aria-disabled'), 'true', id);
    assert.equal(preset(container, id).getAttribute('title'), auth.authorize.presetViewerUnavailable, id);
  }
});

test('viewer: Allow posts read-only scopes only', async (t) => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const { container } = await render(t, { requestedScopes: menu(['read:email', 'search:email']), roleLimited: true });
  allowButton(container).click();
  await flush();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].scopes, ['read:email', 'search:email']);
});

test('viewer with nothing grantable: a viewer-specific message and Allow disabled', async (t) => {
  const { container } = await render(t, { requestedScopes: [], roleLimited: true });
  assert.ok(container.textContent.includes(auth.authorize.viewerNoScopes));
  assert.ok(!container.textContent.includes(auth.authorize.noScopes));
  assert.equal(allowButton(container).disabled, true);
});

test('owner/admin/member: no note, every level selectable, original tooltip text kept', async (t) => {
  const { container } = await render(t, {});
  assert.ok(container.querySelector('.az-role-note') === null, 'no viewer note');
  for (const id of ['readOnly', 'standard', 'full']) {
    assert.equal(preset(container, id).getAttribute('aria-disabled'), 'false', id);
  }
});

test('non-viewer with a narrow client: the greyed tooltip still says the app did not ask', async (t) => {
  const { container } = await render(t, { requestedScopes: menu(['read:email', 'search:email']) });
  assert.ok(container.querySelector('.az-role-note') === null, 'no viewer note');
  assert.equal(preset(container, 'full').getAttribute('title'), auth.authorize.presetNotOffered);
});
