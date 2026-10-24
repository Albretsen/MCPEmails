// The brand is written "MCPEmails" (one word, camel case) in anything a
// customer or an AI engine reads. Owner decision, 2026-10-20: search engines
// treat "MCPEmails" as a distinct entity and "MCP Emails" as a generic phrase.
//
// This test keeps the customer copy on one spelling: it fails when a string
// uses "MCP Emails" / "MCP-Emails" or the bare word "mcpemails" / "Mcpemails"
// as the product name. It walks every string in messages/*/*.json and in the
// page-content JSON under src/lib (connect and client guides, help, status,
// comparisons), and reads the blog posts, their translations, the page copy
// modules and llms.txt as text.
//
// Allowed, because they are technical values and not the brand in prose:
// - URLs and the domain: https://mcpemails.com/..., mcpemails.com, @mcpemails.com
// - anything inside <code>...</code> or `...` (app password nicknames, config keys)
// - the npm package (npx -y mcpemails), the registry id com.mcpemails/...
// - the GitHub repo Albretsen/MCPEmails
// - the CLI server name in "claude mcp add --transport http mcpemails https://..."
//   and in "codex mcp add mcpemails" / "openclaw mcp login mcpemails"
// - the server key in a JSON config sample ("mcpemails": { ... })
// - a lowercase "MCP" next to the generic word "emails" ("an MCP server for
//   emails") is not the brand and never matches, because the check is case
//   sensitive on "Emails".
//
// To allow a new technical use, add a pattern to ALLOWED below with a comment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const messagesDir = path.join(webDir, 'messages');

// Removed from a value before it is checked.
const ALLOWED = [
  /<code>[\s\S]*?<\/code>/g, // code samples and literal values
  /\\?`[^`\n]*\\?`/g, // inline code in markdown
  /\bhttps?:\/\/\S+/g, // URLs
  /[\w.+-]*@?(?:www\.)?mcpemails\.com\b/g, // the domain and addresses on it
  /\bcom\.mcpemails\/[\w-]+/g, // MCP registry id / _meta keys
  /\bnpx -y mcpemails\b/g, // npm package
  /\bAlbretsen\/MCPEmails\b/g, // GitHub repo
  /--transport http mcpemails\b/g, // CLI server name
  /\b(?:codex|openclaw) mcp (?:add|login|logout|remove|get|show|status) mcpemails\b/g, // CLI server name (Codex, OpenClaw)
  /\\?"mcpemails\\?"\s*:/g, // server key in a JSON config sample
];

const BAD = /MCP[ -]Emails|(?<![\w./@-])[Mm]cpemails(?![\w/@]|\.\w)/g;

export function brandProblems(value) {
  let rest = value;
  for (const re of ALLOWED) rest = rest.replace(re, ' ');
  return rest.match(BAD) ?? [];
}

function* strings(node, keyPath) {
  if (typeof node === 'string') yield [keyPath, node];
  else if (Array.isArray(node)) for (const [i, v] of node.entries()) yield* strings(v, `${keyPath}[${i}]`);
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) yield* strings(v, keyPath ? `${keyPath}.${k}` : k);
}

function* walk(dir, ext) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full, ext);
    else if (ext.some((e) => name.endsWith(e)) && !/\.test\.\w+$/.test(name)) yield full;
  }
}

function jsonProblems(dirs) {
  const problems = [];
  let checked = 0;
  for (const dir of dirs) {
    for (const file of walk(dir, ['.json'])) {
      const json = JSON.parse(readFileSync(file, 'utf8'));
      for (const [key, value] of strings(json, '')) {
        checked++;
        for (const hit of brandProblems(value)) problems.push(`${path.relative(webDir, file)} ${key}: "${hit}"`);
      }
    }
  }
  return { problems, checked };
}

test('the checker flags brand misspellings and allows technical values', () => {
  assert.deepEqual(brandProblems('Welcome to mcpemails'), ['mcpemails']);
  assert.deepEqual(brandProblems('MCP Emails is open source.'), ['MCP Emails']);
  assert.deepEqual(brandProblems('Ihr MCP-Emails-Konto'), ['MCP-Emails']);
  assert.deepEqual(brandProblems('Mcpemails connects any inbox'), ['Mcpemails']);
  assert.deepEqual(brandProblems('Sign in with mcpemails.'), ['mcpemails']);
  assert.deepEqual(brandProblems('Opprett en mcpemails-konto'), ['mcpemails']); // write MCPEmails-konto
  assert.deepEqual(brandProblems('MCPEmails is open source. Opprett en MCPEmails-konto.'), []);
  assert.deepEqual(brandProblems('An MCP server for emails, and MCP emails in general'), []);
  assert.deepEqual(brandProblems('Paste <code>https://mcpemails.com/api/mcp</code> into MCPEmails'), []);
  assert.deepEqual(brandProblems('Write to legal@mcpemails.com or visit www.mcpemails.com.'), []);
  assert.deepEqual(brandProblems('Name it <code>mcpemails</code> or `mcpemails`'), []);
  assert.deepEqual(brandProblems('Run npx -y mcpemails, see github.com/Albretsen/MCPEmails'), []);
  assert.deepEqual(brandProblems('_meta["com.mcpemails/usage_limit"]'), []);
  assert.deepEqual(brandProblems('claude mcp add --transport http mcpemails https://mcpemails.com/api/mcp'), []);
  assert.deepEqual(brandProblems('codex mcp add mcpemails --url https://mcpemails.com/api/mcp'), []);
  assert.deepEqual(brandProblems('openclaw mcp login mcpemails'), []);
  assert.deepEqual(brandProblems('Use mcpemails to read mail'), ['mcpemails']);
  assert.deepEqual(brandProblems('{ "mcpServers": { "mcpemails": { "url": "https://mcpemails.com/api/mcp" } } }'), []);
});

test('messages/*/*.json say "MCPEmails", never "MCP Emails" or bare "mcpemails"', () => {
  const { problems, checked } = jsonProblems([messagesDir]);
  assert.ok(checked > 1000, `expected to check many strings, checked ${checked}`);
  assert.deepEqual(problems, [], `Write the brand as "MCPEmails":\n${problems.join('\n')}`);
});

test('page-content JSON under src/lib says "MCPEmails"', () => {
  const dirs = [
    'src/lib/connect/content',
    'src/lib/connect/chatgpt',
    'src/lib/connect/multi-mailbox',
    'src/lib/clients/content',
    'src/lib/support/help-content',
    'src/lib/status/content',
    'src/lib/compare',
  ].map((d) => path.join(webDir, d));
  const { problems, checked } = jsonProblems(dirs);
  assert.ok(checked > 5000, `expected to check many strings, checked ${checked}`);
  assert.deepEqual(problems, [], `Write the brand as "MCPEmails":\n${problems.join('\n')}`);
});

test('blog posts, page copy modules and llms.txt say "MCPEmails"', () => {
  const files = [
    ...walk(path.join(webDir, 'src/lib/blog'), ['.js', '.mjs']),
    ...walk(path.join(webDir, 'src/lib/clients'), ['.mjs']),
    ...walk(path.join(webDir, 'src/lib/connect'), ['.mjs']),
    path.join(webDir, 'src/lib/changelog/copy.mjs'),
    ...walk(path.join(webDir, 'app/[locale]'), ['content.mjs']),
    path.join(webDir, 'public/llms.txt'),
  ];
  const problems = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const [i, line] of lines.entries()) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue; // source comments
      for (const hit of brandProblems(line)) problems.push(`${path.relative(webDir, file)}:${i + 1}: "${hit}"`);
    }
  }
  assert.ok(files.length > 100, `expected many files, read ${files.length}`);
  assert.deepEqual(problems, [], `Write the brand as "MCPEmails":\n${problems.join('\n')}`);
});
