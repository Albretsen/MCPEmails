// The brand is written "MCP Emails" (two words) in anything a customer reads.
//
// AI answers called us "mcpemails" partly because our copy mixed
// "MCPEmails", "mcpemails" and "MCP Emails". This test keeps messages/*/*.json
// on one spelling: it fails when a string value uses "MCPEmails" or the bare
// word "mcpemails" / "Mcpemails" as the product name.
//
// Allowed, because they are technical values and not the brand in prose:
// - URLs and the domain: https://mcpemails.com/..., mcpemails.com, @mcpemails.com
// - anything inside <code>...</code> (app password nicknames, config keys)
// - the npm package (npx -y mcpemails), the registry id com.mcpemails/...
// - the GitHub repo Albretsen/MCPEmails
// - the CLI server name in "claude mcp add --transport http mcpemails https://..."
// - the legal trading name "MCPEmails" in the trading-as clause of the terms
//   and privacy policy (LEGAL_TRADING_NAME_KEYS). That is a legal name, and
//   the owner decides when it changes.
//
// To allow a new technical use, add a pattern to ALLOWED below with a comment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../messages');

// Removed from a value before it is checked.
const ALLOWED = [
  /<code>[\s\S]*?<\/code>/g, // code samples and literal values
  /\bhttps?:\/\/\S+/g, // URLs
  /[\w.+-]*@?(?:www\.)?mcpemails\.com\b/g, // the domain and addresses on it
  /\bcom\.mcpemails\/[\w-]+/g, // MCP registry id / _meta keys
  /\bnpx -y mcpemails\b/g, // npm package
  /\bAlbretsen\/MCPEmails\b/g, // GitHub repo
  /--transport http mcpemails\b/g, // CLI server name
];

// Values that state the legal trading name. "MCPEmails" is allowed here only.
const LEGAL_TRADING_NAME_KEYS = new Set(['privacy.json whoWeAre.p1', 'terms.json agreement.p1']);

const BAD = /MCPEmails|(?<![\w./@-])[Mm]cpemails(?![\w/@]|\.\w)/g;

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

test('the checker flags brand misspellings and allows technical values', () => {
  assert.deepEqual(brandProblems('Welcome to mcpemails'), ['mcpemails']);
  assert.deepEqual(brandProblems('MCPEmails is open source.'), ['MCPEmails']);
  assert.deepEqual(brandProblems('Mcpemails connects any inbox'), ['Mcpemails']);
  assert.deepEqual(brandProblems('Sign in with mcpemails.'), ['mcpemails']);
  assert.deepEqual(brandProblems('Opprett en mcpemails-konto'), ['mcpemails']); // write MCP Emails-konto
  assert.deepEqual(brandProblems('Paste <code>https://mcpemails.com/api/mcp</code> into MCP Emails'), []);
  assert.deepEqual(brandProblems('Write to legal@mcpemails.com or visit www.mcpemails.com.'), []);
  assert.deepEqual(brandProblems('Name it <code>mcpemails</code>'), []);
  assert.deepEqual(brandProblems('Run npx -y mcpemails, see github.com/Albretsen/MCPEmails'), []);
  assert.deepEqual(brandProblems('_meta["com.mcpemails/usage_limit"]'), []);
  assert.deepEqual(brandProblems('claude mcp add --transport http mcpemails https://mcpemails.com/api/mcp'), []);
});

test('messages/*/*.json say "MCP Emails", never "MCPEmails" or bare "mcpemails"', () => {
  const problems = [];
  let checked = 0;
  for (const locale of readdirSync(messagesDir)) {
    const dir = path.join(messagesDir, locale);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const json = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
      for (const [key, value] of strings(json, '')) {
        checked++;
        const checkedValue = LEGAL_TRADING_NAME_KEYS.has(`${file} ${key}`) ? value.replace(/MCPEmails/g, ' ') : value;
        for (const hit of brandProblems(checkedValue)) problems.push(`${locale}/${file} ${key}: "${hit}"`);
      }
    }
  }
  assert.ok(checked > 1000, `expected to check many strings, checked ${checked}`);
  assert.deepEqual(problems, [], `Write the brand as "MCP Emails":\n${problems.join('\n')}`);
});
