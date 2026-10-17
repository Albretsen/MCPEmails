// ---------------------------------------------------------------------------
// The redirect scheme block-list and the consent screen's client identity.
//
// Run: npm run test:oauth-identity (from apps/web).
//
// Two holes closed on 2026-10-16:
//   1. isValidRedirectUri accepted every non-http(s) scheme, javascript: and
//      data: included, and the consent screen navigates to the redirect on our
//      own origin.
//   2. An anonymous DCR registrant chose the name and byline the consent
//      screen showed as the requesting party, while the code went to a host the
//      screen never printed.
// Only reserved example domains are used for attacker hosts.
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import { BLOCKED_REDIRECT_SCHEMES, isRedirectToForRegisteredUri, isSafeRedirectScheme } from '@/lib/oauth/redirect-scheme';
import { isValidRedirectUri } from '@/lib/oauth/redirect-uri';
import {
  describeClientIdentity,
  describeRedirectDestination,
  vendorForHost,
  vendorForName,
} from '@/lib/oauth/client-identity';

// ── Scheme block-list ───────────────────────────────────────────────────────

const DANGEROUS = [
  "javascript:fetch('/api/api-keys')//",
  'javascript://%0aalert(1)',
  'JavaScript:alert(1)',
  ' javascript:alert(1)',
  '\tjava\nscript:alert(1)',
  'vbscript:msgbox(1)',
  'data:text/html,<script>alert(1)</script>',
  'data:text/html;base64,PHNjcmlwdD4=',
  'file:///etc/passwd',
  'blob:https://mcpemails.com/0b7c2a1e-0000-0000-0000-000000000000',
  'about:blank',
  'view-source:https://mcpemails.com/',
  'filesystem:https://mcpemails.com/temporary/x',
];

const NATIVE_OK = [
  'cursor://anysphere.cursor-mcp/oauth/callback',
  'cursor://mcp/callback',
  'vscode://vscode.github-authentication/did-authenticate',
  'vscode-insiders://callback',
  'claude://oauth/callback',
  'com.example.app:/oauth2redirect',
];

test('isSafeRedirectScheme refuses script-running and browser-internal schemes, however they are spelled', () => {
  for (const uri of DANGEROUS) assert.equal(isSafeRedirectScheme(uri), false, uri);
});

test('isSafeRedirectScheme keeps native-app, https and loopback redirects', () => {
  for (const uri of [
    ...NATIVE_OK,
    'https://claude.ai/api/mcp/auth_callback',
    'https://chatgpt.com/connector/oauth/abc123',
    'http://127.0.0.1:33418/',
    'http://localhost:6274/oauth/callback',
    'http://[::1]:8080/cb',
  ]) {
    assert.equal(isSafeRedirectScheme(uri), true, uri);
  }
});

test('isSafeRedirectScheme refuses what is not a URL at all', () => {
  for (const v of ['', 'not a url', '/relative/path', null, undefined, 42]) {
    assert.equal(isSafeRedirectScheme(v), false, String(v));
  }
});

test('every blocked scheme is stored the way URL#protocol reports it', () => {
  for (const s of BLOCKED_REDIRECT_SCHEMES) assert.match(s, /^[a-z][a-z0-9+.-]*:$/, s);
});

test('isValidRedirectUri (register + authorize page) refuses the dangerous schemes', async () => {
  for (const uri of DANGEROUS) assert.equal(await isValidRedirectUri(uri), false, uri);
});

test('isValidRedirectUri still accepts native-app schemes and loopback http (no DNS involved)', async () => {
  for (const uri of NATIVE_OK) assert.equal(await isValidRedirectUri(uri), true, uri);
  assert.equal(await isValidRedirectUri('http://127.0.0.1:33418/callback'), true);
  assert.equal(await isValidRedirectUri('http://localhost:3334/callback'), true);
  assert.equal(await isValidRedirectUri('http://attacker.example/cb'), false, 'plain http off-loopback stays refused');
});

// ── Vendor names and hosts ──────────────────────────────────────────────────

test('vendorForName sees through case, spacing, accents, full-width and Cyrillic look-alikes', () => {
  for (const name of ['Claude', 'claude', 'Claude Code', 'C l a u d e', 'Cl-aude', 'ＣＬＡＵＤＥ', 'Сlaude', 'Cláude', 'Anthropic Connector', 'claude.ai']) {
    assert.equal(vendorForName(name), 'anthropic', name);
  }
  for (const name of ['ChatGPT', 'Chat GPT', 'OpenAI', 'Codex', 'codex-cli']) assert.equal(vendorForName(name), 'openai', name);
  for (const name of ['Cursor', 'cursor-mcp', 'Anysphere']) assert.equal(vendorForName(name), 'cursor', name);
  for (const name of ['VS Code', 'Visual Studio Code']) assert.equal(vendorForName(name), 'vscode', name);
  for (const name of ['MCP Emails', 'mcpemails', 'MCP-Email']) assert.equal(vendorForName(name), 'mcpemails', name);
});

test('vendorForName does not flag unrelated names', () => {
  for (const name of ['Smithery', 'Glama', 'Manus', 'Poke', 'Precursor Labs', 'Dynamic Client', 'n8n workflow', '', null]) {
    assert.equal(vendorForName(name as string), null, String(name));
  }
});

test('vendorForHost matches exact hostnames only', () => {
  assert.equal(vendorForHost('claude.ai'), 'anthropic');
  assert.equal(vendorForHost('claude.com'), 'anthropic');
  assert.equal(vendorForHost('chatgpt.com'), 'openai');
  assert.equal(vendorForHost('cursor.com'), 'cursor');
  for (const h of ['evilclaude.ai', 'claude.ai.attacker.example', 'claude-connect.example', 'chatgpt.com.attacker.net', 'xchatgpt.com']) {
    assert.equal(vendorForHost(h), null, h);
  }
});

test('describeRedirectDestination classifies web, loopback and app redirects', () => {
  assert.deepEqual(describeRedirectDestination('https://claude.ai/api/mcp/auth_callback'), { kind: 'web', host: 'claude.ai', hostname: 'claude.ai' });
  assert.deepEqual(describeRedirectDestination('https://attacker.example:8443/cb'), { kind: 'web', host: 'attacker.example:8443', hostname: 'attacker.example' });
  assert.deepEqual(describeRedirectDestination('http://127.0.0.1:33418/'), { kind: 'loopback', host: '127.0.0.1:33418' });
  assert.deepEqual(describeRedirectDestination('http://localhost:6274/cb'), { kind: 'loopback', host: 'localhost:6274' });
  assert.deepEqual(describeRedirectDestination('http://[::1]:9/cb'), { kind: 'loopback', host: '[::1]:9' });
  assert.deepEqual(describeRedirectDestination('cursor://anysphere.cursor-mcp/oauth/callback'), { kind: 'app', scheme: 'cursor', native: true, webHost: null });
  assert.deepEqual(describeRedirectDestination('myapp://callback'), { kind: 'app', scheme: 'myapp', native: false, webHost: null });
  assert.deepEqual(describeRedirectDestination('microsoft-edge:https://attacker.example/cb'), { kind: 'app', scheme: 'microsoft-edge', native: false, webHost: 'attacker.example' });
  assert.deepEqual(describeRedirectDestination('x-safari-https://attacker.example/cb'), { kind: 'app', scheme: 'x-safari-https', native: false, webHost: 'attacker.example' });
  assert.deepEqual(describeRedirectDestination('cursor:https://attacker.example/cb'), { kind: 'app', scheme: 'cursor', native: false, webHost: 'attacker.example' }, 'an allow-listed scheme wrapping a web URL is not native');
  assert.deepEqual(describeRedirectDestination('nope'), { kind: 'invalid' });
});

// ── The consent identity ────────────────────────────────────────────────────

const DYN = 'dyn_0123456789abcdef01234567';

test('THE ATTACK: DCR "Claude · anthropic.com" redirecting to an attacker host shows the host, unverified, with an impersonation warning', () => {
  const id = describeClientIdentity({
    clientId: DYN,
    clientName: 'Claude',
    clientByline: 'anthropic.com',
    isCimd: false,
    redirectUri: 'https://claude-connect.example/cb',
  });
  assert.equal(id.verification, 'unverified');
  assert.equal(id.displayName, 'claude-connect.example', 'the heading is the DNS host, not the self-asserted name');
  assert.equal(id.selfReportedName, 'Claude', 'the name survives only as a labelled secondary line');
  assert.equal(id.byline, '', 'the self-asserted client_uri byline is never shown');
  assert.equal(id.destinationLabel, 'claude-connect.example');
  assert.equal(id.impersonates, 'Claude (Anthropic)');
});

test('DCR with an unknown web host and an ordinary name: host heading, unverified, no impersonation', () => {
  const id = describeClientIdentity({ clientId: DYN, clientName: 'Smithery', clientByline: 'https://smithery.example', isCimd: false, redirectUri: 'https://smithery.example/oauth/callback' });
  assert.equal(id.verification, 'unverified');
  assert.equal(id.displayName, 'smithery.example');
  assert.equal(id.selfReportedName, 'Smithery');
  assert.equal(id.impersonates, null);
});

test('LEGIT: Claude via DCR on claude.ai keeps its name and is verified', () => {
  for (const redirectUri of ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback']) {
    const id = describeClientIdentity({ clientId: DYN, clientName: 'Claude', clientByline: 'https://claude.ai', isCimd: false, redirectUri });
    assert.equal(id.verification, 'verified', redirectUri);
    assert.equal(id.displayName, 'Claude');
    assert.equal(id.selfReportedName, 'Claude', 'still labelled as self-reported');
    assert.equal(id.byline, '');
    assert.equal(id.impersonates, null);
    assert.equal(id.destinationVendor, 'anthropic');
  }
});

test('LEGIT: ChatGPT via DCR on chatgpt.com keeps its name and is verified', () => {
  const id = describeClientIdentity({ clientId: DYN, clientName: 'ChatGPT', isCimd: false, redirectUri: 'https://chatgpt.com/connector/oauth/abc_123' });
  assert.equal(id.verification, 'verified');
  assert.equal(id.displayName, 'ChatGPT');
  assert.equal(id.destinationLabel, 'chatgpt.com');
});

test('LEGIT: Cursor via DCR on cursor:// keeps its name and is a local app', () => {
  const id = describeClientIdentity({ clientId: DYN, clientName: 'Cursor', isCimd: false, redirectUri: 'cursor://anysphere.cursor-mcp/oauth/callback' });
  assert.equal(id.verification, 'local');
  assert.equal(id.displayName, 'Cursor');
  assert.equal(id.destinationLabel, 'cursor://');
  assert.equal(id.destinationVendor, 'cursor');
  assert.equal(id.impersonates, null, 'a code delivered to a local app cannot be phished from a link');
});

test('LEGIT: loopback clients (Claude Code, Codex, VS Code) keep their name and are local', () => {
  for (const [clientName, redirectUri] of [
    ['Claude Code', 'http://localhost:54212/callback'],
    ['Codex', 'http://127.0.0.1:1455/callback'],
    ['Visual Studio Code', 'http://127.0.0.1:33418/'],
  ]) {
    const id = describeClientIdentity({ clientId: DYN, clientName, isCimd: false, redirectUri });
    assert.equal(id.verification, 'local', clientName);
    assert.equal(id.displayName, clientName);
    assert.equal(id.impersonates, null);
  }
});

test('on a known vendor HOST no impersonation alert is raised: the code goes to that vendor anyway', () => {
  // ChatGPT and Claude put the user's own connector name in client_name.
  for (const [clientName, redirectUri] of [
    ['MCP Emails', 'https://chatgpt.com/connector/oauth/abc_123'],
    ['MCP Emails', 'https://claude.ai/api/mcp/auth_callback'],
    ['ChatGPT', 'https://claude.ai/api/mcp/auth_callback'],
  ]) {
    const id = describeClientIdentity({ clientId: DYN, clientName, isCimd: false, redirectUri });
    assert.equal(id.impersonates, null, `${clientName} -> ${redirectUri}`);
    assert.equal(id.verification, 'verified');
    assert.equal(id.displayName, clientName);
    assert.equal(id.selfReportedName, clientName);
  }
});

test('THE BYPASS: browser hand-off schemes are refused and never read as "on this device"', async () => {
  for (const uri of [
    'microsoft-edge:https://attacker.example/cb',
    'microsoft-edge-https://attacker.example/cb',
    'x-safari-https://attacker.example/cb',
    'x-safari-http://attacker.example/cb',
    'googlechrome://attacker.example/cb',
    'googlechromes://attacker.example/cb',
    'firefox://open-url?url=https://attacker.example/cb',
    'opera-https://attacker.example/cb',
    'brave://open-url?url=https://attacker.example/cb',
    'intent://attacker.example/cb#Intent;scheme=https;end',
    'web+mcp:https://attacker.example/cb',
    'anything:https://attacker.example/cb',
    'cursor:https://attacker.example/cb',
  ]) {
    assert.equal(isSafeRedirectScheme(uri), false, uri);
    assert.equal(await isValidRedirectUri(uri), false, uri);
    const id = describeClientIdentity({ clientId: DYN, clientName: 'Claude', isCimd: false, redirectUri: uri });
    assert.equal(id.verification, 'unverified', uri);
    assert.equal(id.destinationKind, 'other', uri);
    assert.equal(id.impersonates, 'Claude (Anthropic)', uri);
    assert.equal(id.selfReportedName, 'Claude', uri);
    assert.notEqual(id.displayName, 'Claude', uri);
  }
  const edge = describeClientIdentity({ clientId: DYN, clientName: 'Claude', isCimd: false, redirectUri: 'microsoft-edge:https://attacker.example/cb' });
  assert.equal(edge.destinationLabel, 'attacker.example (microsoft-edge:)', 'the real web host is what the screen prints');
});

test('an unknown custom scheme is unverified with the scheme as the destination', () => {
  const id = describeClientIdentity({ clientId: DYN, clientName: 'My Tool', isCimd: false, redirectUri: 'com.example.app:/oauth2redirect' });
  assert.equal(id.verification, 'unverified');
  assert.equal(id.destinationKind, 'other');
  assert.equal(id.destinationLabel, 'com.example.app:');
  assert.equal(id.displayName, 'com.example.app:');
  assert.equal(id.selfReportedName, 'My Tool');
  assert.equal(id.impersonates, null);
});

test('a vendor name on another vendor\'s app scheme or an unknown scheme is flagged', () => {
  const onCursor = describeClientIdentity({ clientId: DYN, clientName: 'Claude', isCimd: false, redirectUri: 'cursor://x/cb' });
  assert.equal(onCursor.impersonates, 'Claude (Anthropic)');
  assert.equal(onCursor.verification, 'unverified');
  const onUnknown = describeClientIdentity({ clientId: DYN, clientName: 'ChatGPT', isCimd: false, redirectUri: 'myapp://cb' });
  assert.equal(onUnknown.impersonates, 'ChatGPT (OpenAI)');
  const own = describeClientIdentity({ clientId: DYN, clientName: 'Claude Desktop', isCimd: false, redirectUri: 'claude://oauth/callback' });
  assert.equal(own.impersonates, null);
  assert.equal(own.verification, 'local');
  const windsurf = describeClientIdentity({ clientId: DYN, clientName: 'Windsurf', isCimd: false, redirectUri: 'windsurf://codeium.windsurf/oauth' });
  assert.equal(windsurf.verification, 'local');
});

test('seeded rows (not dyn_, not a URL) keep their own name and byline', () => {
  const id = describeClientIdentity({ clientId: 'claude-desktop', clientName: 'Claude Desktop', clientByline: 'by Anthropic', isCimd: false, redirectUri: 'claude://oauth/callback' });
  assert.equal(id.verification, 'registered');
  assert.equal(id.displayName, 'Claude Desktop');
  assert.equal(id.byline, 'by Anthropic');
  assert.equal(id.impersonates, null);
});

test('CIMD keeps the client_id host as its name; verified on a vendor host, unverified elsewhere', () => {
  const claude = describeClientIdentity({ clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata', clientName: 'claude.ai', isCimd: true, redirectUri: 'https://claude.ai/api/mcp/auth_callback' });
  assert.equal(claude.verification, 'verified');
  assert.equal(claude.displayName, 'claude.ai');
  assert.equal(claude.selfReportedName, null);

  const other = describeClientIdentity({ clientId: 'https://app.example/client.json', clientName: 'app.example', isCimd: true, redirectUri: 'https://app.example/cb' });
  assert.equal(other.verification, 'unverified');
  assert.equal(other.displayName, 'app.example');
  assert.equal(other.selfReportedName, null, 'a CIMD name is already the host, nothing self-reported to show');
  assert.equal(other.impersonates, null);
});

// ── Web URLs smuggled inside a custom scheme (round 3) ──────────────────────

const SMUGGLED = [
  'cursor://https://attacker.example/cb',
  'cursor:%68ttps://attacker.example/cb',
  'cursor:redirect?u=https://attacker.example/cb',
  'cursor://anysphere.cursor-mcp/oauth/callback?next=https%3A%2F%2Fattacker.example',
  'cursor://x/cb?u=%2568ttps%253A%252F%252Fattacker.example',
  'vscode://ext/cb?u=https:\\\\attacker.example',
  'claude://oauth/callback#https://attacker.example',
  'windsurf://cb?u=ｈttps://attacker.example',
  'myapp://open?url=http://attacker.example',
  'ms-word:ofe|u|https://attacker.example/doc.docx',
  'ms-word:ofv|u|attacker.example',
  'ms-excel:ofe|u|https://attacker.example/x.xlsx',
  'ms-powerpoint:ofe|u|https://attacker.example/x.pptx',
  'ms-visio:ofe|u|x',
  'ms-access:x',
  'ms-project:x',
  'ms-publisher:x',
  'ms-spd:x',
  'ms-infopath:x',
  'itms-services://?action=download-manifest&url=https://attacker.example/m.plist',
];

test('a custom scheme carrying an http(s) URL anywhere, encoded or not, and the Office ms-* handlers are refused', async () => {
  for (const uri of SMUGGLED) {
    assert.equal(isSafeRedirectScheme(uri), false, uri);
    assert.equal(await isValidRedirectUri(uri), false, uri);
    const id = describeClientIdentity({ clientId: DYN, clientName: 'Cursor', isCimd: false, redirectUri: uri });
    assert.notEqual(id.verification, 'local', uri);
  }
});

const DOCUMENTED_NATIVE = [
  ['Claude Desktop', 'claude://oauth/callback'],
  ['Cursor', 'cursor://anysphere.cursor-retrieval/oauth/user-mcpemails/callback'],
  ['Cursor', 'cursor://anysphere.cursor-mcp/oauth/callback'],
  ['Cursor', 'cursor://mcp/callback'],
  ['Cline', 'vscode://saoudrizwan.claude-dev/mcp-auth/callback'],
  ['Visual Studio Code', 'vscode://vscode.github-authentication/did-authenticate?windowid=1&nonce=abc'],
  ['Visual Studio Code - Insiders', 'vscode-insiders://vscode.github-authentication/did-authenticate'],
  ['Windsurf', 'windsurf://codeium.windsurf/oauth'],
  ['Zed', 'zed://oauth/callback'],
  ['Raycast', 'raycast://oauth?package_name=Extension'],
  ['Warp', 'warp://mcp/oauth2callback'],
  ['Kiro', 'kiro://kiro.kiroAgent/authenticate-success'],
];

test('every documented native redirect (query params included) still registers and reads "On this device"', async () => {
  for (const [clientName, uri] of DOCUMENTED_NATIVE) {
    assert.equal(isSafeRedirectScheme(uri), true, uri);
    assert.equal(await isValidRedirectUri(uri), true, uri);
    const id = describeClientIdentity({ clientId: DYN, clientName, isCimd: false, redirectUri: uri });
    assert.equal(id.verification, 'local', uri);
    assert.equal(id.destinationKind, 'app', uri);
    assert.equal(id.displayName, clientName, uri);
  }
});

// ── Round 4: state at Allow, single-slash, decode depth ────────────────────

function composed(registered: string, state: string): string {
  const u = new URL(registered);
  u.searchParams.set('code', 'c0de');
  u.searchParams.set('state', state);
  return u.toString();
}

test('Allow: a state holding a URL does not make a native or loopback redirect_to unsafe', () => {
  for (const registered of [
    'cursor://anysphere.cursor-retrieval/oauth/user-mcpemails/callback',
    'claude://oauth/callback',
    'vscode://saoudrizwan.claude-dev/mcp-auth/callback',
    'vscode://vscode.github-authentication/did-authenticate?windowid=1&nonce=abc',
    'raycast://oauth?package_name=Extension',
    'http://127.0.0.1:33418',
    'https://claude.ai/api/mcp/auth_callback',
  ]) {
    for (const state of ['https://example.com/return', 'http:/x.example', 'javascript:alert(1)', '%68ttps://x.example']) {
      assert.equal(isRedirectToForRegisteredUri(composed(registered, state), registered), true, `${registered} state=${state}`);
    }
  }
});

test('Allow: redirect_to must be the registered URI; another scheme, host or path, or an unsafe registered URI, is refused', () => {
  const reg = 'cursor://anysphere.cursor-mcp/oauth/callback';
  for (const to of [
    'javascript:alert(1)//?code=c',
    'cursor://evil.example/oauth/callback?code=c',
    'cursor://anysphere.cursor-mcp/other?code=c',
    'vscode://anysphere.cursor-mcp/oauth/callback?code=c',
    'https://attacker.example/?code=c',
    'not a url',
  ]) {
    assert.equal(isRedirectToForRegisteredUri(to, reg), false, to);
  }
  assert.equal(isRedirectToForRegisteredUri('javascript:alert(1)?code=c', 'javascript:alert(1)'), false);
  assert.equal(isRedirectToForRegisteredUri('cursor:%68ttps://h?code=c', 'cursor:%68ttps://h'), false);
  assert.equal(isRedirectToForRegisteredUri(null, reg), false);
});

test('a single-slash embedded web URL is refused like a double-slash one', async () => {
  for (const uri of ['cursor:https:/attacker.example', 'cursor://x/cb?u=https:/attacker.example', 'claude://cb?u=http:\\attacker.example', 'zed:x?u=https%3A%2Fattacker.example']) {
    assert.equal(isSafeRedirectScheme(uri), false, uri);
    assert.equal(await isValidRedirectUri(uri), false, uri);
  }
});

test('percent-decoding runs to a fixed point well past two rounds', () => {
  // https:// encoded six times over.
  let enc = 'https://attacker.example';
  for (let i = 0; i < 6; i++) enc = encodeURIComponent(enc);
  assert.equal(isSafeRedirectScheme(`cursor://x/cb?u=${enc}`), false);
});

// ── Google and xAI Grok as verified vendors (2026-10-17) ────────────────────
// Production registrations: "Google" on three oauth-redirect*.googleusercontent
// .com hosts, "Grok" on grok.com. Both showed as Unverified before.

const GOOGLE_HOSTS = [
  'oauth-redirect.googleusercontent.com',
  'oauth-redirect-test.googleusercontent.com',
  'oauth-redirect-sandbox.googleusercontent.com',
];

test('LEGIT: Google via DCR on each oauth-redirect*.googleusercontent.com host is verified, heading "Google", no alert', () => {
  for (const host of GOOGLE_HOSTS) {
    const id = describeClientIdentity({ clientId: DYN, clientName: 'Google', isCimd: false, redirectUri: `https://${host}/callback` });
    assert.equal(id.verification, 'verified', host);
    assert.equal(id.displayName, 'Google', host);
    assert.equal(id.selfReportedName, 'Google', host);
    assert.equal(id.destinationLabel, host);
    assert.equal(id.destinationVendor, 'google', host);
    assert.equal(id.destinationKind, 'web', host);
    assert.equal(id.impersonates, null, host);
    assert.equal(vendorForHost(host), 'google', host);
    assert.equal(vendorForHost(host.toUpperCase()), 'google', 'hostnames compare case-insensitively');
  }
});

test('LEGIT: Grok via DCR on grok.com is verified, heading "Grok", no alert', () => {
  const id = describeClientIdentity({ clientId: DYN, clientName: 'Grok', isCimd: false, redirectUri: 'https://grok.com/oauth/callback' });
  assert.equal(id.verification, 'verified');
  assert.equal(id.displayName, 'Grok');
  assert.equal(id.destinationLabel, 'grok.com');
  assert.equal(id.destinationVendor, 'xai');
  assert.equal(id.impersonates, null);
  assert.equal(vendorForHost('grok.com'), 'xai');
});

test('a user-chosen connector name on a Google or Grok host is still verified with no alert', () => {
  for (const redirectUri of [`https://${GOOGLE_HOSTS[0]}/cb`, 'https://grok.com/cb']) {
    for (const clientName of ['MCP Emails', 'Claude', 'Grok', 'Google']) {
      const id = describeClientIdentity({ clientId: DYN, clientName, isCimd: false, redirectUri });
      assert.equal(id.verification, 'verified', `${clientName} -> ${redirectUri}`);
      assert.equal(id.impersonates, null, `${clientName} -> ${redirectUri}`);
    }
  }
});

test('THE ATTACK: "Google", "Gemini", "Grok" or "xAI" on a non-vendor host is unverified with an impersonation alert', () => {
  const cases: Array<[string, string]> = [
    ['Google', 'Google'],
    ['Gemini', 'Google'],
    ['Google Gemini', 'Google'],
    ['GOOGLE', 'Google'],
    ['G o o g l e', 'Google'],
    ['G00gle', 'Google'],
    ['Gооgle', 'Google'], // Cyrillic о
    ['Ｇｏｏｇｌｅ', 'Google'],
    ['Grok', 'Grok (xAI)'],
    ['xAI', 'Grok (xAI)'],
    ['x.ai', 'Grok (xAI)'],
    ['xAI Grok', 'Grok (xAI)'],
    ['Grok-xAI', 'Grok (xAI)'],
  ];
  for (const [clientName, label] of cases) {
    const id = describeClientIdentity({ clientId: DYN, clientName, isCimd: false, redirectUri: 'https://attacker.example/cb' });
    assert.equal(id.verification, 'unverified', clientName);
    assert.equal(id.displayName, 'attacker.example', clientName);
    assert.equal(id.selfReportedName, clientName, clientName);
    assert.equal(id.impersonates, label, clientName);
  }
  // On an unknown app scheme too.
  const onScheme = describeClientIdentity({ clientId: DYN, clientName: 'Grok', isCimd: false, redirectUri: 'grokbot://oauth/callback' });
  assert.equal(onScheme.verification, 'unverified');
  assert.equal(onScheme.impersonates, 'Grok (xAI)');
});

test('third-party tools that merely mention Google, Gmail, Gemini or grok are unverified but never called impersonators', () => {
  for (const [clientName, redirectUri] of [
    ['Google Sheets MCP', 'https://sheets-mcp.example/oauth/callback'],
    ['Gmail via Zapier', 'https://zapier.example/oauth/cb'],
    ['Gmail', 'https://gmail-tool.example/cb'],
    ['Gemini Mail Assistant', 'https://assistant.example/cb'],
    ['Grokking Mail', 'https://grokking.example/cb'],
    ['My Google Workspace Bot', 'https://bot.example/cb'],
    ['Googler tools', 'https://tools.example/cb'],
  ]) {
    const id = describeClientIdentity({ clientId: DYN, clientName, isCimd: false, redirectUri });
    assert.equal(id.verification, 'unverified', clientName);
    assert.equal(id.displayName, new URL(redirectUri).host, clientName);
    assert.equal(id.selfReportedName, clientName, clientName);
    assert.equal(id.impersonates, null, clientName);
    assert.equal(vendorForName(clientName), null, clientName);
  }
});

test('vendorForName: Google and xAI only as the whole name', () => {
  for (const name of ['Google', 'Gemini', 'Google Gemini', 'google-gemini']) assert.equal(vendorForName(name), 'google', name);
  for (const name of ['Grok', 'xAI', 'XAI', 'xAI Grok']) assert.equal(vendorForName(name), 'xai', name);
  for (const name of ['Google Sheets MCP', 'Gmail', 'Gemini CLI MCP Client', 'Grokking', 'Grok 4 mail', 'Maxai', 'Exaile']) {
    assert.equal(vendorForName(name), null, name);
  }
});

test('Google and Grok look-alike hosts (suffix, prefix, embedded) are not verified', () => {
  for (const host of [
    'evil.googleusercontent.com',
    'lh3.googleusercontent.com',
    'googleusercontent.com',
    'oauth-redirect.googleusercontent.com.evil.example',
    'oauth-redirect.googleusercontent.co',
    'xoauth-redirect.googleusercontent.com',
    'oauth-redirect-evil.googleusercontent.com',
    'grok.com.evil.example',
    'xgrok.com',
    'www.grok.com',
    'evil.grok.com',
    'x.com',
    'twitter.com',
  ]) {
    assert.equal(vendorForHost(host), null, host);
    const id = describeClientIdentity({ clientId: DYN, clientName: host.includes('grok') ? 'Grok' : 'Google', isCimd: false, redirectUri: `https://${host}/cb` });
    assert.equal(id.verification, 'unverified', host);
    assert.equal(id.displayName, host, host);
    assert.notEqual(id.impersonates, null, host);
  }
  // A Google host in the path, userinfo or query does not count either.
  for (const uri of [
    'https://attacker.example/oauth-redirect.googleusercontent.com/cb',
    'https://oauth-redirect.googleusercontent.com@attacker.example/cb',
    'https://attacker.example/cb?h=grok.com',
  ]) {
    const id = describeClientIdentity({ clientId: DYN, clientName: 'Google', isCimd: false, redirectUri: uri });
    assert.equal(id.verification, 'unverified', uri);
    assert.equal(id.displayName, 'attacker.example', uri);
    assert.equal(id.impersonates, 'Google', uri);
  }
});

test('"Cursor" on the grokbot:// scheme keeps its impersonation alert (production registrations, 2026-10-17)', () => {
  const id = describeClientIdentity({ clientId: DYN, clientName: 'Cursor', isCimd: false, redirectUri: 'grokbot://oauth/callback' });
  assert.equal(id.verification, 'unverified');
  assert.equal(id.destinationKind, 'other');
  assert.equal(id.destinationLabel, 'grokbot:');
  assert.equal(id.displayName, 'grokbot:');
  assert.equal(id.selfReportedName, 'Cursor');
  assert.equal(id.impersonates, 'Cursor');
  assert.deepEqual(describeRedirectDestination('grokbot://oauth/callback'), { kind: 'app', scheme: 'grokbot', native: false, webHost: null });
});

test('the existing Claude / ChatGPT / Cursor / VS Code matrix is unchanged by the new vendors', () => {
  const matrix: Array<[string, string, string, string | null]> = [
    ['Claude', 'https://claude.ai/api/mcp/auth_callback', 'verified', null],
    ['ChatGPT', 'https://chatgpt.com/connector/oauth/x', 'verified', null],
    ['Cursor', 'cursor://anysphere.cursor-mcp/oauth/callback', 'local', null],
    ['Visual Studio Code', 'https://vscode.dev/redirect', 'verified', null],
    ['Visual Studio Code', 'vscode://vscode.github-authentication/did-authenticate', 'local', null],
    ['Claude', 'https://attacker.example/cb', 'unverified', 'Claude (Anthropic)'],
    ['ChatGPT', 'https://attacker.example/cb', 'unverified', 'ChatGPT (OpenAI)'],
    ['Cursor', 'https://attacker.example/cb', 'unverified', 'Cursor'],
    ['VS Code', 'https://attacker.example/cb', 'unverified', 'Visual Studio Code'],
    ['Claude', `https://${GOOGLE_HOSTS[0]}/cb`, 'verified', null],
    ['Claude', 'cursor://x/cb', 'unverified', 'Claude (Anthropic)'],
  ];
  for (const [clientName, redirectUri, verification, impersonates] of matrix) {
    const id = describeClientIdentity({ clientId: DYN, clientName, isCimd: false, redirectUri });
    assert.equal(id.verification, verification, `${clientName} -> ${redirectUri}`);
    assert.equal(id.impersonates, impersonates, `${clientName} -> ${redirectUri}`);
  }
});
