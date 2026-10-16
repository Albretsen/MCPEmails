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

import { BLOCKED_REDIRECT_SCHEMES, isSafeRedirectScheme } from '@/lib/oauth/redirect-scheme';
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
