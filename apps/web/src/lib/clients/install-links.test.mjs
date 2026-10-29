import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getInstallAction, decodeInstallTarget, installSlug, INSTALLABLE_CLIENTS, docsPageInstallAction,
  claudeInstallHref, cursorInstallHref, vscodeInstallHref, gooseInstallHref, cursorWebInstallHref, vscodeWebInstallHref, INSTALL_COMMANDS,
} from './install-links.mjs';
import { MCP_URL, PRODUCTION_MCP_URL } from './mcp-url.mjs';
import { MCP_URL as CLIENTS_MCP_URL, CLIENTS } from './clients.mjs';
import { EVENT_SCHEMA } from '../analytics.mjs';
import { clientUi } from './ui.mjs';

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

test('docs pages: an install action only where the page client really has one', () => {
  const kinds = Object.fromEntries(CLIENTS.map((c) => [c.slug, docsPageInstallAction(c.slug)?.kind ?? null]));
  assert.equal(kinds.claude, 'link');
  assert.equal(kinds.cowork, 'link');
  assert.equal(kinds.cursor, 'link');
  assert.equal(kinds.vscode, 'link');
  assert.equal(kinds['claude-code'], 'command');
  assert.equal(kinds.codex, 'command');
  assert.equal(kinds['gemini-cli'], 'command');
  // The Gemini app page must not get the Gemini CLI command through the alias.
  assert.equal(kinds.gemini, null);
  // ChatGPT has steps only, and they are the page already.
  assert.equal(kinds.chatgpt, null);
  for (const slug of ['cline', 'windsurf', 'zed', 'jetbrains', 'curl']) assert.equal(kinds[slug], null, slug);
  for (const c of CLIENTS) {
    const action = docsPageInstallAction(c.slug);
    if (action) assert.equal(decodeInstallTarget(action), MCP_URL, c.slug);
  }
});

test('docs pages: every action client is an allowed analytics value, and every locale has the install copy', () => {
  const allowed = EVENT_SCHEMA.install_link_clicked.client;
  for (const c of CLIENTS) {
    const action = docsPageInstallAction(c.slug);
    if (action) assert.ok(allowed.includes(action.client), c.slug);
  }
  for (const locale of ['en', 'nb', 'es', 'fr', 'zh', 'de']) {
    const install = clientUi(locale).page.install;
    for (const k of ['after', 'command', 'copy', 'copied']) assert.ok(install?.[k], `${locale}.${k}`);
    assert.ok(install.after.includes('{client}'), locale);
    assert.ok(!/[\u2014<>]/.test(Object.values(install).join(' ')), locale);
  }
});

test('README install badges are the links this file builds, for the production URL', () => {
  const readme = readFileSync(new URL('../../../../../README.md', import.meta.url), 'utf8');
  for (const href of [claudeInstallHref(PRODUCTION_MCP_URL), cursorWebInstallHref(PRODUCTION_MCP_URL), vscodeWebInstallHref(PRODUCTION_MCP_URL), INSTALL_COMMANDS['claude-code'](PRODUCTION_MCP_URL)]) {
    assert.ok(readme.includes(href), href);
  }
  // The web forms carry the same server as the app links they redirect to.
  const cursorConfig = new URL(cursorWebInstallHref(PRODUCTION_MCP_URL)).searchParams.get('config');
  assert.equal(cursorInstallHref(PRODUCTION_MCP_URL).endsWith(`config=${cursorConfig}`), true);
  assert.equal(JSON.parse(new URL(vscodeWebInstallHref(PRODUCTION_MCP_URL)).searchParams.get('config')).url, PRODUCTION_MCP_URL);
});
