import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FILTER_BOOLEAN_FIELDS,
  FILTER_DATE_FIELDS,
  FILTER_STRING_FIELDS,
  providerSearchLabel,
  unrunnableFilterFields,
  validateFilter,
  validateFilterForProvider,
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

// ── Criteria the inbox's provider cannot run (F-04, 2026-09-20) ──────────────
//
// The field NAME checks above say nothing about whether the provider under the
// rule can actually run the criterion. `has_attachment` is a legal field and a
// generic IMAP server has no predicate for it, so a rule carrying it acted on
// every message matching the rest of the filter, unattended, every fifteen
// minutes. The edge function has refused this at write time since 47c76e95; the
// dashboard's own write path did not until 2026-09-21, which is what these
// cover.
//
// Note what is NOT tested here: which fields each dialect drops. That list is
// not this module's to hold. It is imported from the translator that drops
// them (search-translate.ts) and pinned to the translator clauses by
// search-translate.test.ts over in the Deno suite, so there is no second copy
// to drift. What is tested here is that the dashboard consults it at all, on
// every write path, and says something a person can act on.

const errorOf = (result: ReturnType<typeof validateFilterForProvider>): string =>
  result.ok === false ? result.error : '';

test('a criterion this provider cannot run is refused when the rule is saved', () => {
  // The incident itself: attachment search over generic IMAP.
  const imap = validateFilterForProvider({ subject: 'invoice', has_attachment: true }, 'imap');
  assert.equal(imap.ok, false);
  assert.match(errorOf(imap), /has_attachment/);
  assert.match(errorOf(imap), /generic IMAP/);
  // The remedy has to be in the sentence, not just the complaint.
  assert.match(errorOf(imap), /unattended/);

  // Branded IMAP connectors are the same dialect under a different name, and
  // the dashboard passes the BRANDED provider ('yahoo', 'icloud', 'fastmail').
  for (const brand of ['yahoo', 'icloud', 'fastmail', 'zoho', 'yandex']) {
    assert.equal(
      validateFilterForProvider({ subject: 'invoice', has_attachment: true }, brand).ok,
      false,
      `${brand} is an IMAP connector and cannot search by attachment either`,
    );
  }

  // Outlook has no flagged predicate in either $search or $filter.
  const outlookFlagged = validateFilterForProvider({ flagged: true }, 'outlook');
  assert.equal(outlookFlagged.ok, false);
  assert.match(errorOf(outlookFlagged), /flagged/);
  assert.match(errorOf(outlookFlagged), /Outlook/);

  // The big one: Graph refuses to combine $search and $filter on /messages, so
  // a free-text criterion drops the whole $filter — unread, has_attachment,
  // since and before vanish TOGETHER.
  const outlookCombined = validateFilterForProvider(
    { subject: 'invoice', unread: true, since: '2026-08-25' },
    'outlook',
  );
  assert.equal(outlookCombined.ok, false);
  assert.match(errorOf(outlookCombined), /unread/);
  assert.match(errorOf(outlookCombined), /since/);
});

test('a filter the provider can run is left alone', () => {
  // Gmail expresses every field this product offers.
  const gmail = validateFilterForProvider(
    { subject: 'invoice', has_attachment: true, flagged: true, unread: true, since: '2026-08-25' },
    'gmail',
  );
  assert.equal(gmail.ok, true);

  // Outlook is fine as long as nothing forces the $search/$filter choice.
  assert.equal(validateFilterForProvider({ unread: true, has_attachment: true }, 'outlook').ok, true);
  assert.equal(validateFilterForProvider({ subject: 'invoice' }, 'outlook').ok, true);

  // IMAP is fine with everything except the attachment predicate.
  assert.equal(validateFilterForProvider({ subject: 'invoice', flagged: true }, 'imap').ok, true);
});

test('a negated flag is unrunnable on every provider, including the ones that support the field', () => {
  // No dialect emits a "has no attachment" or "is not flagged" predicate. The
  // form cannot produce these (it only ever writes `true`), but the REST API
  // and an imported MCP rule can, and validateFilter accepts either boolean.
  for (const provider of ['gmail', 'outlook', 'imap']) {
    assert.deepEqual(
      unrunnableFilterFields({ subject: 'x', flagged: false }, provider),
      ['flagged'],
      provider,
    );
    assert.deepEqual(
      unrunnableFilterFields({ subject: 'x', has_attachment: false }, provider),
      ['has_attachment'],
      provider,
    );
  }
});

test('an unreadable inbox row does not block a legal rule', () => {
  // Same posture as labelTargetFor: the runner re-validates before every run,
  // and refusing a rule because the dashboard could not read `inboxes.provider`
  // is the worse error.
  assert.deepEqual(unrunnableFilterFields({ has_attachment: true }, null), []);
  assert.equal(validateFilterForProvider({ has_attachment: true }, null).ok, true);
});

test('the dialect a provider is named by matches the one it is judged by', () => {
  assert.equal(providerSearchLabel('gmail'), 'Gmail');
  assert.equal(providerSearchLabel('outlook'), 'Outlook');
  assert.equal(providerSearchLabel('imap'), 'generic IMAP');
  // An unknown connector is treated as the IMAP baseline, which is the most
  // conservative of the three: it over-reports drops rather than under-reports.
  assert.equal(providerSearchLabel('something-new'), 'generic IMAP');
  assert.deepEqual(unrunnableFilterFields({ has_attachment: true }, 'something-new'), ['has_attachment']);
});

test('the edge function still refuses the same filters at write time', () => {
  // This module IMPORTS unappliedSearchFields from the edge function's
  // translator, so the two cannot disagree about WHICH fields are unrunnable.
  // What a shared function cannot guarantee is that the server still calls it
  // on its own write path: if validateAutomationBody stopped refusing, the
  // dashboard would be holding a second opinion rather than the same one, and
  // this is where that gets noticed.
  const engine = fs.readFileSync(ENGINE_COPY, 'utf8');
  const body = engine.slice(engine.indexOf('export function validateAutomationBody'));
  assert.notEqual(body, '', 'validateAutomationBody is no longer exported from triage-engine.ts');
  assert.match(
    body,
    /unappliedSearchFields\(check\.value, inboxProvider\)/,
    'validateAutomationBody no longer refuses unrunnable filters; the dashboard check below it is now a second opinion',
  );
});
