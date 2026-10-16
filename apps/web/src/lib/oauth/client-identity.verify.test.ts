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
import { isSafeRedirectScheme } from '@/lib/oauth/redirect-scheme';
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
