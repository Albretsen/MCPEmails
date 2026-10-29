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
  test(`"MCPEmails" as client_name on a vendor host is verified, no alert: ${uri}`, () => {
    const id = dcr('MCPEmails', uri);
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

// ── u13 verification: Google and xAI Grok vendors (2026-10-17) ──────────────
// Independent bypass attempts on the new exact-host vendors and the new
// whole-name impersonation rule. Attacker hosts are reserved example domains.

const U13_PIN = '/r/user_bound_custom-mcp-111522063632794171720-mcpemails_com';

test('u13: no Google/Grok look-alike host is Verified, and no alert is suppressed', () => {
  // Google look-alikes carry the PINNED path, so only the host is wrong.
  const LOOKALIKES = [
    `https://oauth-redirect.googleusercontent.com.${U13_PIN}`,
    `https://oauth-redirect.googleusercontent.com@evil.example${U13_PIN}`,
    `https://oauth-redirect.googleusercontent.com%2eevil.example${U13_PIN}`,
    `https://oauth-redirect.googleusercontent.com.evil.example${U13_PIN}`,
    `https://evil.googleusercontent.com${U13_PIN}`,
    `https://googleusercontent.com${U13_PIN}`,
    `https://oauth-redirect-evil.googleusercontent.com${U13_PIN}`,
    `https://\u043Eauth-redirect.googleusercontent.com${U13_PIN}`,
    `https://evil.example${U13_PIN}`,
    'https://oauth-redirect.googleusercontent.com./cb', // trailing dot
    'https://oauth-redirect.googleusercontent.com@evil.example/cb', // userinfo
    'https://oauth-redirect.googleusercontent.com%2eevil.example/cb', // %2e in host
    'https://oauth-redirect.googleusercontent.com.evil.example/cb',
    'https://evil.googleusercontent.com/cb',
    'https://googleusercontent.com/cb',
    'https://oauth-redirect-evil.googleusercontent.com/cb',
    'https://оauth-redirect.googleusercontent.com/cb', // Cyrillic o -> punycode
    'https://grok.com./cb',
    'https://grok.com.evil.example/cb',
    'https://xgrok.com/cb',
    'https://www.grok.com/cb',
    'https://x.com/cb',
    'https://grоk.com/cb', // Cyrillic o
    'https://evil.example\\@grok.com/cb',
    'https://evil.example#@grok.com',
    'https://evil.example/https://grok.com',
    'https://[::ffff:7f00:1]/cb',
    'grok://grok.com/cb',
    'grokbot://cb',
    'googleusercontent://oauth-redirect.googleusercontent.com/cb',
  ];
  for (const uri of LOOKALIKES) {
    for (const name of ['Google', 'Grok']) {
      const id = dcr(name, uri);
      assert.notEqual(id.verification, 'verified', `${name} -> ${uri}`);
      assert.notEqual(id.displayName, name, `${name} -> ${uri} must not be the heading`);
      assert.ok(id.impersonates, `${name} -> ${uri} must raise the alert`);
    }
  }
});

test('u13: an invalid-punycode Google host is never Verified, whether or not this Node version parses it', () => {
  // Node 22's URL parser refuses this host; Node 24 (CI, .nvmrc) accepts it, and
  // registration may then accept it too. Either way it is not one of Google's
  // exact hosts, so it must stay Unverified with the Google alert.
  for (const uri of [
    'https://xn--oauth-redirect.googleusercontent.com/cb',
    'https://xn--oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-111522063632794171720-mcpemails_com',
  ]) {
    const id = dcr('Google', uri);
    assert.equal(id.verification, 'unverified', uri);
    assert.notEqual(id.destinationVendor ?? null, 'google', uri);
  }
});

test('u13: only URL forms that a browser itself sends to the real host are Verified', () => {
  const SAME_HOST = [
    'https://OAUTH-REDIRECT.GOOGLEUSERCONTENT.COM/r/user_bound_custom-mcp-111522063632794171720-mcpemails_com',
    'HTTPS://oauth-redirect-test.googleusercontent.com/r/user_bound_custom-mcp-111522063632794171720-mcpemails_com',
    'https://user@oauth-redirect-sandbox.googleusercontent.com/r/user_bound_custom-mcp-111522063632794171720-mcpemails_com',
    'https://oauth-redirect%2Egoogleusercontent.com/r/user_bound_custom-mcp-111522063632794171720-mcpemails_com',
    'https://GROK.COM/cb',
    'https://grok%2Ecom/cb',
    'https://ｇｒｏｋ.com/cb', // full-width, IDNA-maps to grok.com
    'https://grok.com\\.evil.example/cb', // backslash is a path separator in https
  ];
  for (const uri of SAME_HOST) {
    const id = dcr('Google', uri);
    const browserHost = new URL(uri).hostname;
    assert.equal(id.verification, 'verified', uri);
    assert.ok(['grok.com', 'oauth-redirect.googleusercontent.com', 'oauth-redirect-test.googleusercontent.com', 'oauth-redirect-sandbox.googleusercontent.com'].includes(browserHost), uri);
    assert.equal(id.destinationLabel.split(':')[0], browserHost, uri);
  }
});

test('u13: the Google pinned path cannot be imitated (case, encoding, trailing chars, unicode digits, params, dot segments)', () => {
  const H = 'https://oauth-redirect.googleusercontent.com';
  const BAD = [
    `${H}/cb`, `${H}/r/evil-project`, `${H}/r/user_bound_custom-mcp-1-evil_com`,
    `${H}/R${U13_PIN.slice(2)}`, `${H}${U13_PIN.toUpperCase()}`,
    `${H}${U13_PIN}//`, `${H}/${U13_PIN}`, `${H}${U13_PIN}?`, `${H}${U13_PIN}#`, `${H}${U13_PIN}?x=1`, `${H}${U13_PIN}#x`,
    `${H}${U13_PIN};x`, `${H}${U13_PIN}%2F`, `${H}${U13_PIN}%20`, `${H}${U13_PIN}%00`, `${H}${U13_PIN}%23`, `${H}${U13_PIN}x`, `${H}${U13_PIN}.evil`,
    `${H}${U13_PIN.replace('_bound', '%5Fbound')}`, `${H}${U13_PIN.replace('_bound', '%255Fbound')}`,
    `${H}${U13_PIN.replace('/r/', '/r%2F')}`, `${H}${U13_PIN.replace('111', '\u0661\u0661\u0661')}`, `${H}${U13_PIN.replace('111', '\uFF11\uFF11\uFF11')}`,
    `${H}${U13_PIN.replace('-mcp-1', '-mcp--1')}`, `${H}${U13_PIN.replace(/\d+/, '')}`,
    `${H}/x/..${U13_PIN}`, `${H}/x/%2e%2e${U13_PIN}`, `${H}/x/.%2E${U13_PIN}`, `${H}\\${U13_PIN.slice(1)}`,
    `${H}/r/user_bound_custom-mcp-1-mcpemails_com/../evil`, `${H}/r/user_bound_custom-mcp-1-mcpemails_com/r/evil`,
  ];
  for (const uri of BAD) {
    const id = dcr('Google', uri);
    assert.equal(id.verification, 'unverified', uri);
    assert.notEqual(id.displayName, 'Google', uri);
    assert.equal(id.impersonates, 'Google', uri);
  }
});

test('u13: legitimate Gemini redirects (r and a, all three hosts, optional trailing slash) are Verified', () => {
  for (const host of ['oauth-redirect', 'oauth-redirect-test', 'oauth-redirect-sandbox']) {
    for (const seg of ['r', 'a']) {
      for (const tail of ['', '/']) {
        const uri = `https://${host}.googleusercontent.com/${seg}/user_bound_custom-mcp-111522063632794171720-mcpemails_com${tail}`;
        for (const name of ['Google', 'MCPEmails']) {
          const id = dcr(name, uri);
          assert.equal(id.verification, 'verified', `${name} -> ${uri}`);
          assert.equal(id.displayName, name, uri);
          assert.equal(id.impersonates, null, uri);
          assert.equal(id.destinationVendor, 'google', uri);
        }
      }
    }
  }
});

test('u13: whole-name evasions of Google/Gemini/Grok/xAI still raise the alert', () => {
  for (const name of [
    'Google\u2122', 'Google(TM)', 'Google Inc', 'Google Inc.', 'Google LLC', 'Google Ltd.', 'Gemini AI', 'Gemini Official',
    'Grok 3', 'Grok AI', 'Grok\u2122 3', 'Grok \u0663', 'xAI Grok Assistant', 'xAI Inc', 'Google\u200D Inc', 'G00gle Inc',
    '\uFF27\uFF2F\uFF2F\uFF27\uFF2C\uFF25\u3000\uFF29\uFF2E\uFF23',
    'Google.', 'Google ®', 'Googlе', 'Goo​gle', 'Goo‍gle', 'Goo­gle', 'Goog1e',
    'Gооgle', 'ɢoogle'.replace('ɢ', 'G'), 'GEMINI', 'Gemini.', 'Grоk', 'X-AI', 'x ai', 'Grok xAI',
  ]) {
    const id = dcr(name, 'https://attacker.example/cb');
    assert.equal(id.verification, 'unverified', name);
    assert.equal(id.displayName, 'attacker.example', name);
    assert.ok(id.impersonates, `${JSON.stringify(name)} must raise the alert`);
  }
});

test('u13: names the whole-name rule lets through still never become the heading or Verified', () => {
  // Accepted false negatives after filler stripping (glued filler, or a
  // longer phrase): the heading is the attacker host with the amber
  // Unverified badge; only the red alert is missing.
  for (const name of ['GoogleTM', 'GoogleInc', 'GrokAI', 'Sign in with Google', 'Google Account', 'Google Login']) {
    const id = dcr(name, 'https://attacker.example/cb');
    assert.equal(id.verification, 'unverified', name);
    assert.equal(id.displayName, 'attacker.example', name);
    assert.equal(id.selfReportedName, name, name);
  }
});

test('u13: honest third-party names carrying Google/Gmail/Gemini/grok are not called impersonators', () => {
  for (const name of [
    'Google Sheets MCP', 'Gmail via Zapier', 'Gmail', 'Grokking Mail', 'Gemini CLI helper', 'Google Drive Sync', 'Grok Mail Helper',
    // Filler stripping must not turn filler-only or filler-plus-generic names into a vendor.
    'AI Mail App', 'Official Gmail Backup Tool', 'Inc Mail', 'App 2', 'AI', 'Inc', 'App', 'TM', 'Official App', 'Mail AI',
    'Official MCP App', 'Ltd Mail Co', 'My App 2000', 'Gmail App', 'Gmail Official', 'Gemini 2.5 Pro', 'Grok 4 Heavy', 'Google AI Studio', 'Appgoogle',
  ]) {
    const id = dcr(name, 'https://tool.example/cb');
    assert.equal(id.verification, 'unverified', name);
    assert.equal(id.impersonates, null, name);
  }
  // Gemini CLI on loopback stays local, no alert.
  const cli = dcr('Gemini CLI', 'http://127.0.0.1:7777/oauth/callback');
  assert.equal(cli.verification, 'local');
  assert.equal(cli.impersonates, null);
});

test('u13: "Cursor" on grokbot:// keeps the impersonation alert, and grokbot is not a native app', () => {
  const id = dcr('Cursor', 'grokbot://oauth/callback');
  assert.equal(id.verification, 'unverified');
  assert.equal(id.destinationKind, 'other');
  assert.equal(id.impersonates, 'Cursor');
});

test('u13: the new vendors do not change the Claude/ChatGPT/Cursor/VS Code matrix', () => {
  const expect: Array<[string, string, string, string | null]> = [
    ['Claude', 'https://claude.ai/api/mcp/auth_callback', 'verified', null],
    ['ChatGPT', 'https://chatgpt.com/connector_platform_oauth_redirect', 'verified', null],
    ['Cursor', 'cursor://anysphere.cursor-mcp/oauth/callback', 'local', null],
    ['Visual Studio Code', 'http://127.0.0.1:33418/', 'local', null],
    ['Claude', 'https://attacker.example/cb', 'unverified', 'Claude (Anthropic)'],
    ['Cursor', 'https://attacker.example/cb', 'unverified', 'Cursor'],
    ['Claude', `https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-111522063632794171720-mcpemails_com`, 'verified', null],
    // Not the pinned path: Google's shared redirect, another project's code.
    ['Claude', `https://oauth-redirect.googleusercontent.com/cb`, 'unverified', 'Claude (Anthropic)'],
  ];
  for (const [name, uri, verification, imp] of expect) {
    const id = dcr(name, uri);
    assert.equal(id.verification, verification, `${name} -> ${uri}`);
    assert.equal(id.impersonates, imp, `${name} -> ${uri}`);
  }
});

test('u13 round 3: whitespace/control chars in a vendor redirect are never Verified; clean URIs and non-web kinds unchanged', () => {
  const CLEAN: Array<[string, string]> = [
    ['Claude', 'https://claude.ai/api/mcp/auth_callback'],
    ['ChatGPT', 'https://chatgpt.com/connector_platform_oauth_redirect'],
    ['MCPEmails', 'https://mcpemails.com/cb'],
    ['Google', `https://oauth-redirect.googleusercontent.com${U13_PIN}`],
    ['Google', `https://oauth-redirect-sandbox.googleusercontent.com/a/user_bound_custom-mcp-1-mcpemails_com/`],
    ['Grok', 'https://grok.com/oauth/callback'],
  ];
  const MUTATIONS = [
    (u: string) => `${u}\t`, (u: string) => `${u}\n`, (u: string) => ` ${u}`, (u: string) => `${u} `, (u: string) => `${u}\r\n`,
    (u: string) => u.replace('https://', 'https://\t'), (u: string) => `${u}\x7f`, (u: string) => `${u}\x00`, (u: string) => `${u} `,
    (u: string) => u.replace(/\/([^/]*)$/, '/.\t./$1'),
  ];
  for (const [name, uri] of CLEAN) {
    const clean = dcr(name, uri);
    assert.equal(clean.verification, 'verified', uri);
    assert.equal(clean.impersonates, null, uri);
    for (const m of MUTATIONS) {
      const bad = m(uri);
      const id = dcr(name, bad);
      assert.notEqual(id.verification, 'verified', JSON.stringify(bad));
      assert.notEqual(id.displayName, name === 'MCPEmails' ? '\u0000never' : name, JSON.stringify(bad));
      // The name claims the vendor whose host it was, so the alert must fire.
      if (name !== 'MCPEmails') assert.ok(id.impersonates, `alert for ${JSON.stringify(bad)}`);
    }
  }
  // Loopback and native schemes do not go through vendorForWebRedirect.
  assert.equal(dcr('Visual Studio Code', 'http://127.0.0.1:33418/').verification, 'local');
  assert.equal(dcr('Cursor', 'cursor://anysphere.cursor-mcp/oauth/callback').verification, 'local');
  assert.equal(dcr('Claude Code', 'http://localhost:5555/callback').verification, 'local');
});
