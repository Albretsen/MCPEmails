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

// ---------------------------------------------------------------------------
// `entry_point` on the connect modal's funnel rows (product-funnel.ts).
// ---------------------------------------------------------------------------

import { connectEntryPoint, recordProductFunnelEvent } from './product-funnel.ts';
import { CONNECT_ENTRY_POINTS } from './connect-entry-point.mjs';
import { readFileSync } from 'node:fs';

/** A fake client whose insert answers with the queued errors, then succeeds. */
function insertDb(errors: Array<{ code: string; message: string } | null> = []) {
  const inserts: Array<Record<string, unknown>> = [];
  const db = {
    from() {
      return {
        insert(row: Record<string, unknown>) {
          inserts.push(row);
          return Promise.resolve({ error: errors.shift() ?? null });
        },
      };
    },
  };
  return { db: db as never, inserts };
}

test('an entry point is a name from the closed list or nothing', () => {
  for (const name of CONNECT_ENTRY_POINTS) assert.equal(connectEntryPoint(name), name);
  for (const junk of ['HEADER', 'sidebar', '', null, undefined, 3, { entry_point: 'header' }, 'info@acme.example']) {
    assert.equal(connectEntryPoint(junk), null);
  }
});

test('the closed list in the app is the closed list in the migration', () => {
  const sql = readFileSync(new URL('../../../../../supabase/migrations/20261005120000_funnel_entry_point.sql', import.meta.url), 'utf8');
  const check = sql.slice(sql.indexOf('CHECK (entry_point IS NULL OR entry_point IN ('), sql.indexOf('COMMENT ON COLUMN'));
  const inSql = [...check.matchAll(/^\s*'([a-z_]+)',?\s*$/gm)].map((m) => m[1]);
  assert.deepEqual([...inSql].sort(), [...CONNECT_ENTRY_POINTS].sort());
});

test('a paywall row carries its entry point, and a row without one is the insert it always was', async () => {
  const withEntry = insertDb();
  await recordProductFunnelEvent(withEntry.db, {
    workspaceId: 'ws-1', stage: 'paywall_reached', outcome: 'started', category: 'free',
    connectionType: 'first_connect', entryPoint: 'header',
  });
  assert.equal(withEntry.inserts.length, 1);
  assert.equal(withEntry.inserts[0].entry_point, 'header');
  assert.equal(withEntry.inserts[0].category, 'free', 'the plan stays in category');

  const without = insertDb();
  await recordProductFunnelEvent(without.db, { workspaceId: 'ws-1', stage: 'pricing_viewed', outcome: 'started', category: 'pricing_page' });
  assert.equal('entry_point' in without.inserts[0], false);
});

test('deployed ahead of the migration, the row is kept and only the entry point is dropped', async () => {
  for (const error of [
    { code: 'PGRST204', message: "Could not find the 'entry_point' column of 'product_funnel_events' in the schema cache" },
    { code: '42703', message: 'column "entry_point" of relation "product_funnel_events" does not exist' },
  ]) {
    const { db, inserts } = insertDb([error]);
    await recordProductFunnelEvent(db, {
      workspaceId: 'ws-1', stage: 'paywall_reached', outcome: 'started', category: 'free',
      connectionType: 'first_connect', entryPoint: 'inboxes_page',
    });
    assert.equal(inserts.length, 2);
    assert.equal('entry_point' in inserts[1], false);
    assert.equal(inserts[1].stage, 'paywall_reached');
  }
  // Any other failure is not retried.
  const { db, inserts } = insertDb([{ code: '23514', message: 'violates check constraint' }]);
  await recordProductFunnelEvent(db, {
    workspaceId: 'ws-1', stage: 'paywall_reached', outcome: 'started', category: 'free', entryPoint: 'header',
  });
  assert.equal(inserts.length, 1);
});
