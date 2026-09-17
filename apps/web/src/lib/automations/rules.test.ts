import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FILTER_BOOLEAN_FIELDS,
  FILTER_DATE_FIELDS,
  FILTER_STRING_FIELDS,
  validateFilter,
} from './rules.ts';

// What this file is for: the fields an automation filter may carry are stated
// in two runtimes that cannot import from one another. This module validates
// what the dashboard and the REST API write; the edge function's copy in
// triage-engine.ts validates the same row again before EVERY run. A field this
// module accepts and that one refuses is the worst of the failure modes on
// offer: the rule saves cleanly, looks healthy in the UI, and then fails every
// single run for as long as nobody looks at the run log.
//
// `raw` was exactly that shape of mistake in the other direction. Both copies
// accepted it while the MCP tool schemas said, in three places, that
// provider-native raw queries are NOT accepted for automations. It was removed
// from both on 2026-09-15; these tests are what stops it, or anything else,
// from coming back on one side only.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_COPY = path.resolve(HERE, '../../../../../supabase/functions/mcp-server/triage-engine.ts');

/** Read one `const NAME = ["a", "b"] as const;` list out of the edge copy. */
function engineList(name: string): string[] {
  const source = fs.readFileSync(ENGINE_COPY, 'utf8');
  const match = new RegExp(`${name} = \\[([^\\]]*)\\]`).exec(source);
  assert.ok(match, `${name} is no longer declared in triage-engine.ts as a literal list`);
  return match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

test('the two copies of the automation filter field lists agree', () => {
  const pairs: [string[], string][] = [
    [[...FILTER_STRING_FIELDS], 'ALLOWED_FILTER_STRING_FIELDS'],
    [[...FILTER_BOOLEAN_FIELDS], 'ALLOWED_FILTER_BOOL_FIELDS'],
    [[...FILTER_DATE_FIELDS], 'ALLOWED_FILTER_DATE_FIELDS'],
  ];
  for (const [webCopy, engineName] of pairs) {
    assert.deepEqual(
      [...webCopy].sort(),
      engineList(engineName).sort(),
      `${engineName} and its web counterpart have drifted; a rule saved here would fail every run`,
    );
  }
});

test('a provider-native raw query cannot be saved as an automation filter', () => {
  // Not a style preference: `{raw: 'ALL'}` passes the "at least one condition"
  // rule and then matches the entire mailbox on IMAP, on a schedule, with
  // nobody in the loop.
  const result = validateFilter({ raw: 'ALL' });
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : '', /raw/);
  assert.equal(validateFilter({ from: 'billing@acme.com', raw: 'ALL' }).ok, false);
});

test('the structured fields the form offers are still accepted', () => {
  const filter = {
    from: 'billing@acme.com',
    subject: 'invoice',
    unread: true,
    since: '2026-08-25',
  };
  const result = validateFilter(filter);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok === true ? result.value : null, filter);
});

test('a filter with no conditions is refused', () => {
  assert.equal(validateFilter({}).ok, false);
});
