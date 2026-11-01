// Structural checks for the Arabic setup guide. These pin the rules a language
// review should not have to police.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { acquisitionFromLocation } from './acquisition-context.mjs';
import { PATH, MCP_URL, copy } from '../../app/[locale]/docs/claude-email-arabic/content.mjs';

const text = JSON.stringify(copy);

test('digits are Latin: no Arabic-Indic or Persian digits anywhere', () => {
  assert.doesNotMatch(text, /[٠-٩۰-۹]/);
});

test('public copy rules hold', () => {
  assert.doesNotMatch(text, /—/, 'no em dashes');
  assert.doesNotMatch(text, /SOC ?2/i);
  assert.doesNotMatch(text, /MCP Emails|mcpemails(?!\.com)/, 'MCPEmails is one word');
  assert.doesNotMatch(text, /</, 'no angle brackets');
  assert.doesNotMatch(text, /30 (days|يوم)/);
});

test('Claude only until the ChatGPT Plus and Go question is settled', () => {
  assert.doesNotMatch(text, /ChatGPT|شات جي بي تي/i);
});

test('the data section names both Stockholm and US East', () => {
  const data = JSON.stringify(copy.sections.find((s) => s.id === 'data'));
  assert.match(data, /ستوكهولم/);
  assert.match(data, /US East/);
});

test('it targets the Arabic product name, not "email assistant" terms', () => {
  assert.match(copy.meta.title, /كلود/);
  assert.match(copy.title, /كلود/);
  assert.doesNotMatch(text, /مساعد البريد/);
});

test('the answer and the steps give the real server URL', () => {
  assert.equal(MCP_URL, 'https://mcpemails.com/api/mcp');
  assert.ok(copy.answer.includes(MCP_URL));
  assert.ok(JSON.stringify(copy.sections.find((s) => s.id === 'claude')).includes(MCP_URL));
});

test('MCPEmails labels in the steps are the strings the product renders', () => {
  const read = (p) => JSON.parse(readFileSync(new URL(`../../messages/en/${p}.json`, import.meta.url), 'utf8'));
  const connect = read('dashboardChrome').connect;
  const inboxes = read('dashboard').inboxes;
  const scopes = JSON.stringify(read('auth'));
  const labels = [
    inboxes.title, inboxes.connectInbox,
    connect.connectWithMicrosoft, connect.enterCredentials, connect.genericLabel, connect.emailLabel,
    connect.imapHostLabel, connect.imapPortLabel, connect.smtpHostLabel, connect.smtpPortLabel,
    connect.passwordLabel, connect.advancedToggle, connect.usernameLabel,
  ];
  for (const label of labels) assert.ok(text.includes(`**${label}**`), label);
  for (const title of ['Read-only', 'Standard', 'Full access']) {
    assert.ok(scopes.includes(`"title":"${title}"`), title);
    assert.ok(text.includes(`**${title}**`), title);
  }
});

test('a visit is attributed to this page without touching the locale system', () => {
  const value = acquisitionFromLocation(new URL(`https://mcpemails.com${PATH}`));
  assert.equal(value.landingPath, PATH);
  assert.equal(value.landing, 'docs');
  assert.equal(value.locale, 'en');
});
