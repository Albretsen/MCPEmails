import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getInstallAction, decodeInstallTarget, installSlug, INSTALLABLE_CLIENTS,
  claudeInstallHref, cursorInstallHref, vscodeInstallHref, gooseInstallHref,
} from './install-links.mjs';
import { MCP_URL, PRODUCTION_MCP_URL } from './mcp-url.mjs';
import { MCP_URL as CLIENTS_MCP_URL } from './clients.mjs';

test('one MCP URL: clients.mjs re-exports mcp-url.mjs, and it is production when no APP_URL is set', () => {
  assert.equal(CLIENTS_MCP_URL, MCP_URL);
  if (!process.env.NEXT_PUBLIC_APP_URL) assert.equal(MCP_URL, PRODUCTION_MCP_URL);
});

test('every installable client decodes back to the live MCP URL', () => {
  for (const slug of INSTALLABLE_CLIENTS) {
    const action = getInstallAction(slug);
    assert.ok(action, slug);
    assert.ok(['link', 'command', 'steps'].includes(action.kind), slug);
    assert.ok(action.label, slug);
    if (action.kind === 'steps') continue;
    assert.equal(decodeInstallTarget(action), MCP_URL, slug);
    if (action.alt) assert.equal(decodeInstallTarget({ kind: 'link', href: action.alt.href }), MCP_URL, `${slug} alt`);
  }
});

test('Claude prefill link matches the documented shape', () => {
  assert.equal(
    claudeInstallHref(PRODUCTION_MCP_URL),
    'https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=MCPEmails&connectorUrl=https%3A%2F%2Fmcpemails.com%2Fapi%2Fmcp',
  );
  const a = getInstallAction('claude');
  assert.equal(a.label, 'Add to Claude');
  assert.match(a.note, /one custom connector/);
});

test('Cursor link carries raw base64 of {"url": ...}', () => {
  assert.equal(
    cursorInstallHref(PRODUCTION_MCP_URL),
    'cursor://anysphere.cursor-deeplink/mcp/install?name=mcpemails&config=eyJ1cmwiOiJodHRwczovL21jcGVtYWlscy5jb20vYXBpL21jcCJ9',
  );
});

test('VS Code link is vscode:mcp/install with URL-encoded name/type/url JSON, plus Insiders', () => {
  const href = vscodeInstallHref(PRODUCTION_MCP_URL);
  assert.ok(href.startsWith('vscode:mcp/install?'));
  assert.deepEqual(JSON.parse(decodeURIComponent(href.split('?')[1])), { name: 'mcpemails', type: 'http', url: PRODUCTION_MCP_URL });
  assert.ok(vscodeInstallHref(PRODUCTION_MCP_URL, { insiders: true }).startsWith('vscode-insiders:mcp/install?'));
  assert.equal(getInstallAction('vscode').label, 'Install in VS Code');
});

test('Goose link is a streamable_http extension link', () => {
  const u = new URL(gooseInstallHref(PRODUCTION_MCP_URL));
  assert.equal(u.protocol, 'goose:');
  assert.equal(u.searchParams.get('type'), 'streamable_http');
  assert.equal(u.searchParams.get('url'), PRODUCTION_MCP_URL);
});

test('terminal clients get one copyable command', () => {
  assert.equal(getInstallAction('claude_code', { mcpUrl: PRODUCTION_MCP_URL }).command, 'claude mcp add --transport http mcpemails https://mcpemails.com/api/mcp');
  assert.equal(getInstallAction('codex', { mcpUrl: PRODUCTION_MCP_URL }).command, 'codex mcp add mcpemails --url https://mcpemails.com/api/mcp');
  assert.equal(getInstallAction('gemini', { mcpUrl: PRODUCTION_MCP_URL }).command, 'gemini mcp add --transport http mcpemails https://mcpemails.com/api/mcp');
});

test('ChatGPT has no deep link: steps only', () => {
  const a = getInstallAction('chatgpt');
  assert.equal(a.kind, 'steps');
  assert.equal(a.href, undefined);
  assert.equal(a.stepsKey, 'clients.chatgpt');
});

test('slugs from the dashboard, onboarding and /docs all resolve; unknown is null', () => {
  assert.equal(installSlug('claude_code'), 'claude-code');
  assert.equal(installSlug('gemini-cli'), 'gemini-cli');
  assert.equal(installSlug('cowork'), 'claude');
  assert.equal(getInstallAction('zed'), null);
  assert.equal(getInstallAction('curl'), null);
  assert.equal(getInstallAction(undefined), null);
});

test('labels and the Claude note exist in every locale, no em dashes, fall back to English', () => {
  for (const locale of ['en', 'de', 'fr', 'es', 'nb', 'zh']) {
    for (const slug of INSTALLABLE_CLIENTS) {
      const a = getInstallAction(slug, { locale });
      assert.ok(a.label && !a.label.includes('—'), `${locale} ${slug}`);
    }
    const note = getInstallAction('claude', { locale }).note;
    assert.ok(note && !note.includes('—') && !note.includes('<'), locale);
  }
  assert.notEqual(getInstallAction('claude', { locale: 'de' }).label, 'Add to Claude');
  assert.equal(getInstallAction('claude', { locale: 'pt-BR' }).label, 'Add to Claude');
  assert.equal(getInstallAction('claude', { locale: 'nb-NO' }).label, 'Legg til i Claude');
});

test('a custom mcpUrl (staging) flows into every action', () => {
  const staging = 'https://staging.example.test/api/mcp';
  for (const slug of INSTALLABLE_CLIENTS) {
    const a = getInstallAction(slug, { mcpUrl: staging });
    if (a.kind !== 'steps') assert.equal(decodeInstallTarget(a), staging, slug);
  }
});
