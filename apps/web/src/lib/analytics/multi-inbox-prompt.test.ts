import test from 'node:test';
import assert from 'node:assert/strict';
import {
  multiInboxPromptOutcome,
  parseMultiInboxPromptAction,
  recordMultiInboxPrompt,
} from './multi-inbox-prompt.ts';

/** A fake client: `existing` answers the dedupe lookup, inserts are captured. */
function fakeDb({ existing = null as unknown, plan = 'free' } = {}) {
  const inserts: Array<Record<string, unknown>> = [];
  const lookups: Array<Array<[string, unknown]>> = [];
  const db = {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const chain: Record<string, unknown> = {
        select() { return chain; },
        eq(col: string, v: unknown) { filters.push([col, v]); return chain; },
        limit() { return chain; },
        maybeSingle() {
          if (table === 'product_funnel_events') {
            lookups.push(filters);
            return Promise.resolve({ data: existing, error: null });
          }
          return Promise.resolve({ data: { plan }, error: null });
        },
        insert(row: Record<string, unknown>) {
          inserts.push({ table, ...row });
          return Promise.resolve({ error: null });
        },
      };
      return chain;
    },
  };
  return { db: db as never, inserts, lookups };
}

test('only the two declared actions are accepted', () => {
  assert.equal(parseMultiInboxPromptAction('shown'), 'shown');
  assert.equal(parseMultiInboxPromptAction('clicked'), 'clicked');
  for (const junk of ['SHOWN', 'dismissed', '', null, undefined, 1, { action: 'shown' }]) {
    assert.equal(parseMultiInboxPromptAction(junk), null);
  }
});

test('shown is started and clicked is success', () => {
  assert.equal(multiInboxPromptOutcome('shown'), 'started');
  assert.equal(multiInboxPromptOutcome('clicked'), 'success');
});

test('the first exposure writes one row, with the plan read from the database', async () => {
  const { db, inserts, lookups } = fakeDb({ plan: 'personal' });
  await recordMultiInboxPrompt(db, 'ws-1', 'shown');
  assert.equal(inserts.length, 1);
  assert.deepEqual(
    { stage: inserts[0].stage, outcome: inserts[0].outcome, category: inserts[0].category, workspace_id: inserts[0].workspace_id },
    { stage: 'multi_inbox_prompt', outcome: 'started', category: 'personal', workspace_id: 'ws-1' },
  );
  assert.deepEqual(lookups[0], [['workspace_id', 'ws-1'], ['stage', 'multi_inbox_prompt'], ['outcome', 'started']]);
});

test('a repeat of the same action writes nothing', async () => {
  const { db, inserts } = fakeDb({ existing: { id: 7 } });
  await recordMultiInboxPrompt(db, 'ws-1', 'clicked');
  assert.equal(inserts.length, 0);
});

test('no workspace writes nothing', async () => {
  const { db, inserts, lookups } = fakeDb();
  await recordMultiInboxPrompt(db, null, 'shown');
  assert.equal(inserts.length + lookups.length, 0);
});
