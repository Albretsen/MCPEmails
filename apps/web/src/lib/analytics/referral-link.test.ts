import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReferralLinkAction, recordReferralLinkEvent, referralLinkStage, utcDayStart } from './referral-link.ts';

function fakeDb({ existing = null as unknown, plan = 'free' } = {}) {
  const inserts: Array<Record<string, unknown>> = [];
  const lookups: Array<Array<[string, string, unknown]>> = [];
  const db = {
    from(table: string) {
      const filters: Array<[string, string, unknown]> = [];
      const chain: Record<string, unknown> = {
        select() { return chain; },
        eq(col: string, v: unknown) { filters.push(['eq', col, v]); return chain; },
        gte(col: string, v: unknown) { filters.push(['gte', col, v]); return chain; },
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
  assert.equal(parseReferralLinkAction('viewed'), 'viewed');
  assert.equal(parseReferralLinkAction('copied'), 'copied');
  for (const junk of ['VIEWED', 'shown', '', null, undefined, 1, { action: 'viewed' }]) {
    assert.equal(parseReferralLinkAction(junk), null);
  }
  assert.equal(referralLinkStage('viewed'), 'referral_link_viewed');
  assert.equal(referralLinkStage('copied'), 'referral_link_copied');
});

test('the first event of the UTC day writes one row with the plan from the database', async () => {
  const { db, inserts, lookups } = fakeDb({ plan: 'solo' });
  const now = new Date('2026-11-05T17:30:00Z');
  await recordReferralLinkEvent(db, 'ws-1', 'copied', now);
  assert.equal(inserts.length, 1);
  assert.deepEqual(
    { stage: inserts[0].stage, outcome: inserts[0].outcome, category: inserts[0].category, workspace_id: inserts[0].workspace_id },
    { stage: 'referral_link_copied', outcome: 'success', category: 'solo', workspace_id: 'ws-1' },
  );
  assert.deepEqual(lookups[0], [
    ['eq', 'workspace_id', 'ws-1'], ['eq', 'stage', 'referral_link_copied'], ['gte', 'occurred_at', utcDayStart(now)],
  ]);
  assert.equal(utcDayStart(now), '2026-11-05T00:00:00.000Z');
});

test('a repeat on the same day, or no workspace, writes nothing', async () => {
  const seen = fakeDb({ existing: { id: 3 } });
  await recordReferralLinkEvent(seen.db, 'ws-1', 'viewed');
  assert.equal(seen.inserts.length, 0);
  const none = fakeDb();
  await recordReferralLinkEvent(none.db, null, 'viewed');
  assert.equal(none.inserts.length + none.lookups.length, 0);
});
