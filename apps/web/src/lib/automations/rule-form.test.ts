import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRuleAction,
  buildRuleFilter,
  duplicateRuleDraft,
  editPatch,
  filterConditions,
  hiddenActionFields,
  hiddenFilterFields,
} from './rule-form.ts';
import { ACTION_SCOPES, missingActionScopes } from './rules.ts';
import { PREVIEW_ERROR_MESSAGE_KEYS, previewFailureFor } from './preview-errors.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AI_RULE_FILTER = { from: 'billing@example.com', cc: 'accounts@example.com', since: '2026-09-01', unread: false };

/** The form's values for a stored rule, the way initialFormState builds them. */
function formFor(filter: Record<string, unknown>, action: Record<string, unknown> = { type: 'mark_read' }) {
  return {
    from: (filter.from as string) ?? '',
    to: (filter.to as string) ?? '',
    subject: (filter.subject as string) ?? '',
    body: (filter.body as string) ?? '',
    unread: filter.unread === true,
    has_attachment: filter.has_attachment === true,
    flagged: filter.flagged === true,
    hiddenFilter: hiddenFilterFields(filter),
    hiddenAction: hiddenActionFields(action),
    hiddenActionType: action.type as string,
    actionType: action.type as string,
    folder: (action.folder as string) ?? '',
    forwardTo: Array.isArray(action.to) ? action.to.join(', ') : '',
    forwardNote: (action.note as string) ?? '',
  };
}

test('an AI-made filter survives the form untouched, cc, since and an explicit false included', () => {
  assert.deepEqual(buildRuleFilter(formFor(AI_RULE_FILTER)), AI_RULE_FILTER);
});

test('renaming an AI-made rule sends the name and nothing else', () => {
  const rule = { name: 'Old', inbox_id: 'i1', api_key_id: 'k1', interval_minutes: 60, max_messages_per_run: 25, filter: AI_RULE_FILTER, action: { type: 'mark_read' } };
  const form = formFor(AI_RULE_FILTER);
  const patch = editPatch(rule, {
    name: 'New',
    inbox_id: 'i1',
    api_key_id: 'k1',
    interval_minutes: 60,
    max_messages_per_run: 25,
    filter: buildRuleFilter(form),
    action: buildRuleAction(form),
  });
  assert.deepEqual(patch, { name: 'New' });
});

test('filter keys in a different stored order do not count as a change', () => {
  const rule = { filter: { since: '2026-09-01', from: 'a@example.com' } };
  assert.deepEqual(editPatch(rule, { filter: { from: 'a@example.com', since: '2026-09-01' } }), {});
});

test('ticking a checkbox replaces a stored false, and unticking removes a stored true', () => {
  const ticked = { ...formFor({ unread: false, from: 'a@example.com' }), unread: true };
  assert.equal(buildRuleFilter(ticked).unread, true);
  const unticked = { ...formFor({ unread: true, from: 'a@example.com' }), unread: false };
  assert.equal('unread' in buildRuleFilter(unticked), false);
});

test('an action field the form has no input for stays, but only on the same action type', () => {
  const stored = { type: 'forward', to: ['a@example.com'], extra: 'kept' };
  const form = formFor({ from: 'x' }, stored);
  assert.deepEqual(buildRuleAction(form), stored);
  assert.deepEqual(buildRuleAction({ ...form, actionType: 'mark_read' }), { type: 'mark_read' });
});

test('a duplicate carries what the rule says and nothing it has earned', () => {
  const rule = {
    id: 'r1', enabled: true, name: 'Invoices', inbox_id: 'i1', api_key_id: 'k1', interval_minutes: 60,
    max_messages_per_run: 25, filter: AI_RULE_FILTER, action: { type: 'forward', to: ['a@example.com'] },
    created_at: 'x', last_run: {}, consecutive_failures: 2, no_approval: true, trusted_at: 'x', next_run_at: 'x',
    workspace_id: 'w1', created_by: 'u1',
  };
  const draft = duplicateRuleDraft(rule, 'Copy of Invoices', 2);
  assert.deepEqual(Object.keys(draft).sort(), [
    'action', 'api_key_id', 'filter', 'inbox_id', 'interval_minutes', 'max_messages_per_run', 'name',
  ]);
  // Two mailboxes: the person has to pick one.
  assert.equal(draft.inbox_id, '');
  assert.equal(duplicateRuleDraft(rule, 'x', 1).inbox_id, 'i1');
  // The hidden conditions come along too.
  assert.deepEqual(hiddenFilterFields(draft.filter), { cc: 'accounts@example.com', since: '2026-09-01', unread: false });
});

test('filterConditions reads in sentence order and skips nothing it can say', () => {
  assert.deepEqual(
    filterConditions({ since: '2026-09-01', subject: 'inv', from: 'a@example.com', unread: false }).map((c) => c.field),
    ['from', 'subject', 'unread', 'since'],
  );
});

test('the scope table matches the engine that enforces it', () => {
  const source = fs.readFileSync(path.resolve(HERE, '../../../../../supabase/functions/mcp-server/triage-engine.ts'), 'utf8');
  const block = /TRIAGE_ACTION_SCOPES: Record<TriageActionType, string> = \{([\s\S]*?)\n\};/.exec(source);
  assert.ok(block, 'TRIAGE_ACTION_SCOPES is no longer declared as a literal');
  const engine = Object.fromEntries([...block[1].matchAll(/^\s*(\w+): "([^"]+)",/gm)].map((m) => [m[1], m[2]]));
  assert.deepEqual(engine, ACTION_SCOPES);
});

test('a key without send:email cannot run a forward', () => {
  assert.deepEqual(missingActionScopes('forward', ['read:email', 'manage:folders']), ['send:email']);
  assert.deepEqual(missingActionScopes('forward', ['send:email']), []);
  // Draft replies read the original too, exactly as the engine requires.
  assert.deepEqual(missingActionScopes('draft_reply', ['manage:drafts']), ['read:email']);
  assert.deepEqual(missingActionScopes('move', null), ['manage:folders']);
  assert.deepEqual(missingActionScopes('unknown', []), []);
});

test('a preview failure never carries the upstream code as its message', () => {
  for (const code of ['unauthorized', 'scope_denied', 'search_failed', 'api_key_not_found', 'invalid_filter', 'something_new']) {
    const failure = previewFailureFor(400, code);
    assert.notEqual(failure.error, code);
    assert.doesNotMatch(failure.error, /^[a-z_]+$/);
    assert.ok(PREVIEW_ERROR_MESSAGE_KEYS[failure.code], `${failure.code} has no message for the form`);
  }
});

test('a refused key is reported as ours, not as the filter', () => {
  const failure = previewFailureFor(401, 'unauthorized');
  assert.equal(failure.code, 'preview_unavailable');
  assert.equal(failure.status, 503);
  assert.doesNotMatch(failure.error, /unauthorized/i);
  // A 404 naming an inbox is a real answer; a bare one means the route is missing.
  assert.equal(previewFailureFor(404, 'inbox_not_found').code, 'inbox_not_available');
  assert.equal(previewFailureFor(404, undefined).code, 'preview_unavailable');
});

test('every preview message exists in every locale', () => {
  for (const locale of ['en', 'nb', 'es', 'fr', 'de', 'zh']) {
    const file = path.resolve(HERE, `../../../messages/${locale}/dashboard.json`);
    const modal = JSON.parse(fs.readFileSync(file, 'utf8')).automations.modal;
    for (const key of Object.values(PREVIEW_ERROR_MESSAGE_KEYS)) {
      assert.ok(modal[key], `${locale} is missing automations.modal.${key}`);
    }
  }
});

test('a copy of a rule never carries Include past mail over', () => {
  const copy = duplicateRuleDraft({
    name: 'Invoices', inbox_id: 'i', api_key_id: 'k', interval_minutes: 60, max_messages_per_run: 25,
    filter: { from: 'a@example.com' }, action: { type: 'move', folder: 'F' }, include_past_mail: true, active_from: '2026-01-01T00:00:00Z',
  }, 'Invoices copy', 2);
  assert.equal(copy.include_past_mail, undefined);
  assert.equal(copy.active_from, undefined);
});
