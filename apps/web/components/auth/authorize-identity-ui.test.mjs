// ---------------------------------------------------------------------------
// The /authorize consent screen: who it says is asking, where it says the code
// goes, and that it never navigates to a script-running redirect.
//
// Run with: npm run test:authorize-identity-ui
//
// Renders the real AuthorizeApp with the real English messages and an identity
// built by the real describeClientIdentity, exactly as app/authorize/page.js
// builds it, so a regression in either the rule or the wiring shows up here.
// `next/navigation` is the test stub, re-mocked below so router.push is
// recorded; fetch is replaced per test. Nothing leaves the process.
//
// Attacker hosts use reserved example domains only.
// ---------------------------------------------------------------------------

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

const window = installDom();

const pushes = [];
mock.module(new URL('../../scripts/test-stubs/next-navigation.mjs', import.meta.url).href, {
  namedExports: {
    useRouter: () => ({
      push: (href) => pushes.push(href),
      replace: () => {},
      refresh: () => {},
      back: () => {},
      forward: () => {},
      prefetch: () => {},
    }),
    useSearchParams: () => new URLSearchParams(),
    usePathname: () => '/authorize',
    useParams: () => ({}),
  },
});

const { NextIntlClientProvider } = await import('next-intl');
const { AuthorizeApp } = await import('./AuthorizeApp.jsx');
const { describeClientIdentity } = await import('../../src/lib/oauth/client-identity.ts');
const auth = (await import('../../messages/en/auth.json', { with: { type: 'json' } })).default;

window._virtualConsole?.removeAllListeners?.('jsdomError');

const SCOPES = [
  { scope: 'read:email', icon: 'inbox', title: 'Read your inbox', desc: '', required: false, destructive: false },
  { scope: 'search:email', icon: 'search', title: 'Search your emails', desc: '', required: false, destructive: false },
];

/** Exactly the props page.js passes, from a raw oauth_clients row. */
function propsFor({ clientId, clientName, clientByline = '', isCimd = false, redirectUri }) {
  const identity = describeClientIdentity({ clientId, clientName, clientByline, isCimd, redirectUri });
  return {
    client: {
      client_id: clientId,
      client_name: identity.displayName,
      client_byline: identity.byline,
      logo_url: null,
      is_first_party: false,
    },
    identity: {
      verification: identity.verification,
      selfReportedName: identity.selfReportedName,
      destinationKind: identity.destinationKind,
      destinationLabel: identity.destinationLabel,
      impersonates: identity.impersonates,
    },
    workspaceName: 'Acme',
    requestedScopes: SCOPES,
    clientRequestedScopes: ['read:email'],
    inboxes: [{ id: 'ib1', email_address: 'person@example.com', display_name: 'Person', provider: 'imap', status: 'connected' }],
    redirectUri,
    oauthState: 'st',
    codeChallenge: 'cc',
    challengeMethod: 'S256',
    csrfToken: 'csrf',
  };
}

async function render(t, props) {
  const view = await mount(
    createElement(NextIntlClientProvider, { locale: 'en', messages: { auth } }, createElement(AuthorizeApp, props)),
  );
  t.after(async () => {
    await view.unmount();
    pushes.length = 0;
  });
  return view;
}

const q = (c, id) => c.querySelector(`[data-testid="${id}"]`);
const button = (c, label) => [...c.querySelectorAll('button')].find((b) => b.textContent.trim() === label);

test('THE ATTACK: "Claude · anthropic.com" redirecting to an attacker host reads as that host, unverified, with a warning', async (t) => {
  const { container } = await render(t, propsFor({
    clientId: 'dyn_0123456789abcdef01234567',
    clientName: 'Claude',
    clientByline: 'anthropic.com',
    redirectUri: 'https://claude-connect.example/cb',
  }));
  const h1 = container.querySelector('h1').textContent;
  assert.equal(h1, 'Authorize claude-connect.example?');
  // A pattern, not a substring test: this asserts the byline text is absent
  // (any case), it never validates a URL.
  const who = container.querySelector('.who').textContent;
  assert.doesNotMatch(who, /anthropic\.com/i, 'self-asserted byline is not shown');
  assert.doesNotMatch(who, /Claude/, 'self-asserted name is not the requesting party');
  assert.equal(q(container, 'az-destination-host').textContent, 'claude-connect.example');
  assert.equal(q(container, 'az-destination-badge').textContent, 'Unverified');
  assert.match(q(container, 'az-self-reported').textContent, /Calls itself Claude\. This name is self-reported/);
  const warning = q(container, 'az-impersonation');
  assert.ok(warning, 'impersonation warning is rendered');
  assert.equal(warning.getAttribute('role'), 'alert');
  assert.match(warning.textContent, /uses the name Claude \(Anthropic\), but access would be sent to claude-connect\.example/);
});

test('an unknown web host without a vendor name: unverified notice, no impersonation alert', async (t) => {
  const { container } = await render(t, propsFor({
    clientId: 'dyn_0123456789abcdef01234567',
    clientName: 'Smithery',
    redirectUri: 'https://smithery.example/oauth/callback',
  }));
  assert.equal(container.querySelector('h1').textContent, 'Authorize smithery.example?');
  assert.equal(q(container, 'az-impersonation'), null);
  assert.match(q(container, 'az-unverified').textContent, /has not verified this app.*trust smithery\.example/);
});

test('LEGIT: Claude on claude.ai keeps its name, shows claude.ai as Verified, no warnings', async (t) => {
  const { container } = await render(t, propsFor({
    clientId: 'dyn_0123456789abcdef01234567',
    clientName: 'Claude',
    clientByline: 'https://claude.ai',
    redirectUri: 'https://claude.ai/api/mcp/auth_callback',
  }));
  assert.equal(container.querySelector('h1').textContent, 'Authorize Claude?');
  assert.equal(q(container, 'az-destination-host').textContent, 'claude.ai');
  assert.equal(q(container, 'az-destination-badge').textContent, 'Verified');
  assert.equal(q(container, 'az-impersonation'), null);
  assert.equal(q(container, 'az-unverified'), null);
  assert.match(q(container, 'az-self-reported').textContent, /“Claude” is a self-reported name\. The destination above is verified\./);
});

test('LEGIT: ChatGPT on chatgpt.com keeps its name and is Verified', async (t) => {
  const { container } = await render(t, propsFor({
    clientId: 'dyn_0123456789abcdef01234567',
    clientName: 'ChatGPT',
    redirectUri: 'https://chatgpt.com/connector/oauth/abc_123',
  }));
  assert.equal(container.querySelector('h1').textContent, 'Authorize ChatGPT?');
  assert.equal(q(container, 'az-destination-badge').textContent, 'Verified');
});

test('LEGIT: Cursor on cursor:// keeps its name and says the code stays on this device', async (t) => {
  const { container } = await render(t, propsFor({
    clientId: 'dyn_0123456789abcdef01234567',
    clientName: 'Cursor',
    redirectUri: 'cursor://anysphere.cursor-mcp/oauth/callback',
  }));
  assert.equal(container.querySelector('h1').textContent, 'Authorize Cursor?');
  assert.equal(q(container, 'az-destination-host').textContent, 'the app that opens cursor:// links on this device');
  assert.equal(q(container, 'az-destination-badge').textContent, 'On this device');
  assert.equal(q(container, 'az-impersonation'), null);
  assert.equal(q(container, 'az-unverified'), null);
  assert.match(q(container, 'az-self-reported').textContent, /“Cursor” is the name the app reported/);
});

test('LEGIT: a loopback client shows its port on this device', async (t) => {
  const { container } = await render(t, propsFor({
    clientId: 'dyn_0123456789abcdef01234567',
    clientName: 'Claude Code',
    redirectUri: 'http://localhost:54212/callback',
  }));
  assert.equal(container.querySelector('h1').textContent, 'Authorize Claude Code?');
  assert.equal(q(container, 'az-destination-host').textContent, 'an app on this device (localhost:54212)');
  assert.equal(q(container, 'az-impersonation'), null);
});

test('a seeded first-party row keeps its byline', async (t) => {
  const { container } = await render(t, propsFor({
    clientId: 'claude-desktop',
    clientName: 'Claude Desktop',
    clientByline: 'by Anthropic',
    redirectUri: 'claude://oauth/callback',
  }));
  assert.match(container.querySelector('.who').textContent, /Claude Desktop · by Anthropic is requesting access/);
  assert.equal(q(container, 'az-destination-badge').textContent, 'Verified');
});

test('Deny never navigates to a javascript: redirect; it goes back to the dashboard', async (t) => {
  const props = propsFor({ clientId: 'dyn_0123456789abcdef01234567', clientName: 'x', redirectUri: 'https://app.example/cb' });
  props.redirectUri = "javascript:alert(document.domain)//";
  const before = window.location.href;
  const { container } = await render(t, props);
  await flush(() => button(container, 'Deny').click());
  assert.deepEqual(pushes, ['/dashboard']);
  assert.equal(window.location.href, before);
});

test('Deny on a safe redirect does not fall back to the dashboard', async (t) => {
  const { container } = await render(t, propsFor({ clientId: 'dyn_0123456789abcdef01234567', clientName: 'Cursor', redirectUri: 'cursor://anysphere.cursor-mcp/oauth/callback' }));
  await flush(() => button(container, 'Deny').click());
  assert.deepEqual(pushes, []);
});

test('Allow refuses a javascript: redirect_to from the server and shows an error instead of navigating', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ redirect_to: 'javascript:alert(1)//?code=abc' }), { status: 200, headers: { 'content-type': 'application/json' } });
  t.after(() => { globalThis.fetch = realFetch; });
  const before = window.location.href;
  const { container } = await render(t, propsFor({ clientId: 'dyn_0123456789abcdef01234567', clientName: 'Cursor', redirectUri: 'cursor://anysphere.cursor-mcp/oauth/callback' }));
  await flush(() => button(container, 'Allow access').click());
  await waitFor(() => container.textContent.includes('Authorization failed'), { message: 'error step' });
  assert.ok(container.textContent.includes("This app's redirect address is not allowed"));
  assert.equal(window.location.href, before);
});

test('THE BYPASS: a browser hand-off scheme reads as the web host, unverified, with the impersonation alert', async (t) => {
  const { container } = await render(t, propsFor({
    clientId: 'dyn_0123456789abcdef01234567',
    clientName: 'Claude',
    redirectUri: 'microsoft-edge:https://attacker.example/cb',
  }));
  assert.equal(container.querySelector('h1').textContent, 'Authorize attacker.example (microsoft-edge:)?');
  assert.equal(q(container, 'az-destination-host').textContent, 'attacker.example (microsoft-edge:)');
  assert.equal(q(container, 'az-destination-badge').textContent, 'Unverified');
  assert.ok(!container.textContent.includes('On this device'));
  assert.ok(!container.textContent.includes('stays on this device'));
  assert.ok(q(container, 'az-impersonation'));
});

test('an unknown custom scheme shows the scheme itself, unverified, not "the app that opens" copy', async (t) => {
  const { container } = await render(t, propsFor({
    clientId: 'dyn_0123456789abcdef01234567',
    clientName: 'My Tool',
    redirectUri: 'com.example.app:/oauth2redirect',
  }));
  assert.equal(q(container, 'az-destination-host').textContent, 'com.example.app:');
  assert.equal(q(container, 'az-destination-badge').textContent, 'Unverified');
  assert.match(q(container, 'az-self-reported').textContent, /Calls itself My Tool/);
});

test('Allow follows a native redirect_to whose state holds a URL (no false "not allowed")', async (t) => {
  const registered = 'cursor://anysphere.cursor-mcp/oauth/callback';
  const to = new URL(registered);
  to.searchParams.set('code', 'c0de');
  to.searchParams.set('state', 'https://example.com/return');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ redirect_to: to.toString() }), { status: 200, headers: { 'content-type': 'application/json' } });
  t.after(() => { globalThis.fetch = realFetch; });
  const props = propsFor({ clientId: 'dyn_0123456789abcdef01234567', clientName: 'Cursor', redirectUri: registered });
  props.oauthState = 'https://example.com/return';
  const { container } = await render(t, props);
  await flush(() => button(container, 'Allow access').click());
  // Navigation is not implemented in jsdom; what matters is that the screen
  // went to "granting" and never to the error step.
  await waitFor(() => container.textContent.includes('Issuing token for Cursor'), { message: 'granting step' });
  await flush(() => new Promise((r) => setTimeout(r, 20)));
  assert.ok(!container.textContent.includes('Authorization failed'));
});

test('Allow refuses a redirect_to on another host than the registered redirect', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ redirect_to: 'cursor://evil.example/cb?code=c' }), { status: 200, headers: { 'content-type': 'application/json' } });
  t.after(() => { globalThis.fetch = realFetch; });
  const { container } = await render(t, propsFor({ clientId: 'dyn_0123456789abcdef01234567', clientName: 'Cursor', redirectUri: 'cursor://anysphere.cursor-mcp/oauth/callback' }));
  await flush(() => button(container, 'Allow access').click());
  await waitFor(() => container.textContent.includes('Authorization failed'), { message: 'error step' });
});
