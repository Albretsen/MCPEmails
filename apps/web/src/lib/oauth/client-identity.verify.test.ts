// ---------------------------------------------------------------------------
// Independent verification of the u09 DCR consent fix (2026-10-16).
//
// Run: npm run test:oauth-identity-verify (from apps/web).
//
// 1. The real redirect URIs legitimate MCP clients register must never be
//    shown as Unverified or carry an impersonation warning.
// 2. Bypass attempts on the identity rule. The browser-handoff scheme cases
//    were marked `todo` because they FAILED against the first fix (a scheme such as
//    microsoft-edge: or x-safari-https: opens a web page in a browser, so the
//    code reaches a remote host while the screen says "On this device").
//    The `todo` markers were removed once the fix handled them.
// Only reserved example domains are used for attacker hosts.
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import { describeClientIdentity } from '@/lib/oauth/client-identity';
import { isRedirectToForRegisteredUri, isSafeRedirectScheme } from '@/lib/oauth/redirect-scheme';
import { isValidRedirectUri } from '@/lib/oauth/redirect-uri';

const dcr = (clientName: string, redirectUri: string) =>
  describeClientIdentity({ clientId: 'dyn_verify', clientName, isCimd: false, redirectUri });

// name, redirect_uri, expected verification
const LEGIT: Array<[string, string, 'verified' | 'local']> = [
  ['claudeai', 'https://claude.ai/api/mcp/auth_callback', 'verified'],
  ['Claude', 'https://claude.com/api/mcp/auth_callback', 'verified'],
  ['Claude', 'https://platform.claude.com/oauth/code/callback', 'verified'],
  ['ChatGPT', 'https://chatgpt.com/connector_platform_oauth_redirect', 'verified'],
  ['ChatGPT', 'https://chat.openai.com/aip/g-abc/oauth/callback', 'verified'],
  ['OpenAI', 'https://platform.openai.com/apps-manage/oauth', 'verified'],
  ['Claude Code (mcp-emails)', 'http://localhost:54123/callback', 'local'],
  ['Claude Desktop', 'claude://oauth/callback', 'local'],
  ['Codex', 'http://127.0.0.1:1455/auth/callback', 'local'],
  ['codex-mcp-client', 'http://localhost:1455/callback', 'local'],
  ['Cursor', 'cursor://anysphere.cursor-retrieval/oauth/user-mcpemails/callback', 'local'],
  ['Visual Studio Code', 'https://vscode.dev/redirect', 'verified'],
  ['Visual Studio Code', 'http://127.0.0.1:33418', 'local'],
  ['Visual Studio Code - Insiders', 'vscode-insiders://vscode.github-authentication/did-authenticate', 'local'],
  ['Windsurf', 'windsurf://codeium.windsurf/oauth', 'local'],
  ['Gemini CLI MCP Client', 'http://localhost:7777/oauth/callback', 'local'],
  ['goose', 'http://localhost:3000/oauth_callback', 'local'],
  ['MCP Inspector', 'http://localhost:6274/oauth/callback', 'local'],
  ['MCP Inspector', 'http://localhost:6274/oauth/callback/debug', 'local'],
];

for (const [name, uri, expected] of LEGIT) {
  test(`legitimate client stays trusted: ${name} -> ${uri}`, async () => {
    // https needs DNS; only the offline (loopback / native scheme) cases here.
    if (!uri.startsWith('https:')) assert.equal(await isValidRedirectUri(uri), true);
    assert.equal(isSafeRedirectScheme(uri), true);
    const id = dcr(name, uri);
    assert.equal(id.verification, expected);
    assert.equal(id.impersonates, null);
    // The heading is still the client's own name, not a host.
    assert.equal(id.displayName, name);
  });
}

test('a non-vendor web client is unverified but not called an impersonator', () => {
  const id = dcr('Le Chat', 'https://chat.mistral.ai/oauth/callback');
  assert.equal(id.verification, 'unverified');
  assert.equal(id.displayName, 'chat.mistral.ai');
  assert.equal(id.selfReportedName, 'Le Chat');
  assert.equal(id.impersonates, null);
});

test('suffix and look-alike hosts are not vendor hosts', () => {
  for (const uri of [
    'https://claude.ai.attacker.example/cb',
    'https://attacker.example/claude.ai/cb',
    'https://claude.ai@attacker.example/cb',
    'https://xn--claude-xyz.example/cb',
  ]) {
    const id = dcr('Claude', uri);
    assert.equal(id.verification, 'unverified', uri);
    assert.notEqual(id.impersonates, null, uri);
  }
});

test('zero-width and homoglyph names still count as impersonation', () => {
  for (const name of ['C​l​a​u​d​e', 'Сlaude', 'Chat GPT', 'ＣＵＲＳＯＲ', 'MCP-Emails']) {
    assert.notEqual(dcr(name, 'https://attacker.example/cb').impersonates, null, name);
  }
});

test('script and browser-internal schemes are refused, whatever the encoding', async () => {
  for (const uri of [' JaVa\tScript:alert(1)', '\u0000javascript:x', 'java\nscript:x', 'DATA:text/html,x', 'vbscript:x', 'blob:https://a.example/x', 'about:blank', 'file:///etc/passwd', 'view-source:https://a.example']) {
    assert.equal(isSafeRedirectScheme(uri), false, uri);
    assert.equal(await isValidRedirectUri(uri), false, uri);
  }
});

// A scheme that hands the URL to a web browser delivers the code to a remote
// host. The screen must not call that "On this device", and a vendor name
// must not pass without a warning.
const HANDOFF = [
  'microsoft-edge:https://attacker.example/cb',
  'x-safari-https://attacker.example/cb',
  'googlechromes://attacker.example/cb',
  'intent://attacker.example/cb#Intent;scheme=https;end',
];
for (const uri of HANDOFF) {
  test(`browser-handoff scheme is not "on this device": ${uri}`, async () => {
    const id = dcr('Claude', uri);
    assert.notEqual(id.verification, 'local');
    assert.notEqual(id.impersonates, null);
    assert.equal(isSafeRedirectScheme(uri), false, 'refused outright as a redirect scheme');
    assert.equal(await isValidRedirectUri(uri), false, 'refused at registration');
  });
}

// Round 2 (after e55ba5b3): more hand-off spellings. Each must be refused at
// registration AND by the scheme rule the authorize page and POST apply.
const HANDOFF_VARIANTS = [
  'X-SAFARI-HTTPS://attacker.example/cb',
  'x-safari-https:attacker.example/cb',
  'Microsoft-Edge:https://attacker.example/cb',
  'microsoft-edge-https://attacker.example/cb',
  'cursor:https://attacker.example/cb',
  'cursor:HTTPS://attacker.example/cb',
  'cursor:ht\ttps://attacker.example/cb',
  'cursor: https://attacker.example/cb',
  'claude:https://attacker.example/cb',
  'vscode:https://attacker.example/cb',
  'opera-https://attacker.example/cb',
  'opera-http://attacker.example/cb',
  'edge:https://attacker.example/cb',
  'ms-edge:https://attacker.example/cb',
  'intent:#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=https%3A%2F%2Fattacker.example;end',
  'INTENT://attacker.example#Intent;end',
  'googlechrome-x-callback://x-callback-url/open/?url=https%3A%2F%2Fattacker.example',
  'firefox://open-url?url=https://attacker.example',
  'brave://open-url?url=https://attacker.example',
  'WEB+foo:x',
];
for (const uri of HANDOFF_VARIANTS) {
  test(`hand-off variant refused: ${JSON.stringify(uri)}`, async () => {
    assert.equal(isSafeRedirectScheme(uri), false);
    assert.equal(await isValidRedirectUri(uri), false);
    const id = dcr('Claude', uri);
    assert.equal(id.verification, 'unverified');
    assert.notEqual(id.impersonates, null);
  });
}

// Schemes that are still accepted (not on any list) must never look local or
// trusted, and a vendor name on them must raise the alert.
for (const uri of [
  'ms-edge://attacker.example/cb',
  'org-chromium://attacker.example/cb',
  'ms-word:ofe|u|https://attacker.example/x',
  'itms-services://?action=download-manifest&url=https://attacker.example/m',
  'focus://open-url?url=https://attacker.example',
  'cursor://https://attacker.example/cb',
  'cursor:%68ttps://attacker.example/cb',
]) {
  test(`unlisted or wrapped scheme stays unverified for a vendor name: ${JSON.stringify(uri)}`, () => {
    const id = dcr('Claude', uri);
    assert.equal(id.verification, 'unverified');
    assert.notEqual(id.impersonates, null);
    assert.notEqual(id.displayName, 'Claude');
  });
}

// Documented OAuth clients (src/lib/clients/clients.mjs) on their native
// schemes stay "On this device" with their own name and no alert.
for (const [name, uri] of [
  ['Windsurf', 'windsurf://codeium.windsurf/oauth'],
  ['Zed', 'zed://oauth/callback'],
  ['Raycast', 'raycast://oauth?package_name=Extension'],
  ['Warp', 'warp://mcp/oauth2callback'],
  ['Kiro', 'kiro://kiro.kiroAgent/authenticate-success'],
  ['Cline', 'vscode://saoudrizwan.claude-dev/mcp-auth/callback'],
] as const) {
  test(`documented native client stays local: ${name}`, async () => {
    assert.equal(await isValidRedirectUri(uri), true);
    const id = dcr(name, uri);
    assert.equal(id.verification, 'local');
    assert.equal(id.impersonates, null);
    assert.equal(id.displayName, name);
  });
}

// Claude and ChatGPT may put the user's connector name in client_name.
for (const uri of ['https://claude.ai/api/mcp/auth_callback', 'https://chatgpt.com/connector_platform_oauth_redirect']) {
  test(`"MCP Emails" as client_name on a vendor host is verified, no alert: ${uri}`, () => {
    const id = dcr('MCP Emails', uri);
    assert.equal(id.verification, 'verified');
    assert.equal(id.impersonates, null);
  });
}

// Round 3 (after d81d9e55): the embedded-web-URL rule.
for (const uri of [
  'vscode://vscode.github-authentication/did-authenticate?windowid=1&nonce=4e8a2f9c1d',
  'vscode-insiders://vscode.github-authentication/did-authenticate?windowId=12&nonce=abc%2Fdef',
  'raycast://oauth?package_name=mcp%20emails',
  'cursor://anysphere.cursor-mcp/oauth/callback',
  'claude://claude.ai/mcp-auth/callback',
  'http://localhost:6274/oauth/callback?next=https://x.example',
]) {
  test(`no false positive on a native or loopback redirect: ${uri}`, async () => {
    assert.equal(isSafeRedirectScheme(uri), true);
    assert.equal(await isValidRedirectUri(uri), true);
    assert.equal(dcr('X', uri).verification, 'local');
  });
}

for (const uri of [
  'cursor:%2568ttps%253A%252F%252Fa.example',
  'cursor:redirect?u=https:\\\\a.example',
  'cursor:x?u=ｈｔｔｐｓ://a.example',
  'cursor:x?u=ht%09tps://a.example',
  'cursor:x?u=https:%5C%5Ca.example',
  'zed:x?u=http%3a%2f%2fa.example',
  'MS-EXCEL:ofv|u|https://a.example',
]) {
  test(`embedded web URL refused: ${JSON.stringify(uri)}`, async () => {
    assert.equal(isSafeRedirectScheme(uri), false);
    assert.equal(await isValidRedirectUri(uri), false);
  });
}

test('the embedded-URL scan stays linear on long inputs', () => {
  for (const body of ['%25'.repeat(300_000), 'a'.repeat(1_000_000), 'https:/'.repeat(140_000), '%'.repeat(1_000_000)]) {
    const started = performance.now();
    isSafeRedirectScheme(`cursor://x/${body}`);
    assert.ok(performance.now() - started < 1000, `took ${performance.now() - started}ms`);
  }
});

// AuthorizeApp used to re-run isSafeRedirectScheme on redirect_to, which by
// then carries the client's own `state`. A native client whose state contains
// a URL (percent-encoded by searchParams) was refused at Allow, after a code
// was minted. Fixed: AuthorizeApp now runs the full check on the REGISTERED
// redirect_uri and only requires redirect_to to be that URI plus a query
// (isRedirectToForRegisteredUri). The `todo` marker was removed with the fix;
// the assertion now targets the check AuthorizeApp actually runs.
test('a URL inside the client state does not break Allow for a native client', () => {
  const registered = 'cursor://anysphere.cursor-retrieval/oauth/user-mcpemails/callback';
  const redirectTo = new URL(registered);
  redirectTo.searchParams.set('code', 'abc');
  redirectTo.searchParams.set('state', 'https://example.com/return');
  assert.equal(isRedirectToForRegisteredUri(redirectTo.toString(), registered), true);
});

// Round 4 (after 943d22bb): isRedirectToForRegisteredUri, which AuthorizeApp
// runs on Allow. redirect_to comes from our own POST, which only adds `code`
// and `state` with searchParams.set, so the question is only whether a
// changed DESTINATION could pass. Spellings that normalise to the same
// scheme, host and path (case, :443, a resolved "..", backslashes) and a
// fragment (never sent anywhere) may pass; every real destination change
// must not.
{
  const reg = 'https://claude.ai/api/mcp/auth_callback';
  const compose = (r: string, state?: string) => {
    const u = new URL(r);
    u.searchParams.set('code', 'C');
    if (state) u.searchParams.set('state', state);
    return u.toString();
  };
  for (const [name, to, registered] of [
    ['https with URL state', compose(reg, 'https://example.com/r'), reg],
    ['loopback', compose('http://127.0.0.1:33418/'), 'http://127.0.0.1:33418/'],
    ['registered query kept', compose('raycast://oauth?package_name=mcp%20emails'), 'raycast://oauth?package_name=mcp%20emails'],
    ['native with URL state', compose('cursor://anysphere.cursor-mcp/oauth/callback', 'https://example.com/r'), 'cursor://anysphere.cursor-mcp/oauth/callback'],
  ] as const) {
    test(`Allow accepts the server's own composition: ${name}`, () => {
      assert.equal(isRedirectToForRegisteredUri(to, registered), true);
    });
  }
  for (const [name, to, registered] of [
    ['userinfo added', 'https://evil@claude.ai/api/mcp/auth_callback?code=C', reg],
    ['port added', 'https://claude.ai:8443/api/mcp/auth_callback?code=C', reg],
    ['path escapes via ..', 'https://claude.ai/api/mcp/auth_callback/../../evil?code=C', reg],
    ['%2F in path', 'https://claude.ai/api%2Fmcp/auth_callback?code=C', reg],
    ['trailing-dot host', 'https://claude.ai./api/mcp/auth_callback?code=C', reg],
    ['other host', 'https://attacker.example/api/mcp/auth_callback?code=C', reg],
    ['https to http', 'http://claude.ai/api/mcp/auth_callback?code=C', reg],
    ['native other host', 'cursor://attacker.example/cb?code=C', 'cursor://a/cb'],
    ['native opaque wraps web', 'cursor:https://attacker.example?code=C', 'cursor:x'],
    ['registered is a hand-off', compose('microsoft-edge:https://attacker.example/cb'), 'microsoft-edge:https://attacker.example/cb'],
    ['javascript redirect_to', 'javascript:alert(1)//?code=C', 'cursor://a/cb'],
    ['no registered uri', compose(reg), ''],
  ] as const) {
    test(`Allow refuses a changed destination: ${name}`, () => {
      assert.equal(isRedirectToForRegisteredUri(to, registered), false);
    });
  }
}
