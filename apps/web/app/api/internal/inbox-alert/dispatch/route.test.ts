// ---------------------------------------------------------------------------
// POST /api/internal/inbox-alert/dispatch: the secret and the off switch.
// The run itself is src/lib/retention/inbox-alert.test.ts.
//
// Run: npm run test:inbox-alert-route
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

let dbTouched = 0;
nodeMock.module('@/lib/supabase/service', {
  namedExports: {
    createServiceRoleClient: () => {
      dbTouched += 1;
      return {
        rpc: async () => ({ data: [], error: null }),
        from: () => {
          const q: Record<string, unknown> = {};
          for (const m of ['select', 'is', 'order', 'in', 'eq']) q[m] = () => q;
          q.range = async () => ({ data: [], error: null });
          return q;
        },
      };
    },
  },
});

process.env.DISPATCH_SECRET = 'dispatch-unit-secret';
const { POST } = await import('./route.ts');

const call = (secret?: string, query = '') =>
  POST(new Request(`https://mcpemails.test/api/internal/inbox-alert/dispatch${query}`, {
    method: 'POST',
    headers: secret === undefined ? {} : { 'x-dispatch-secret': secret },
    body: '{}',
  }));

test('no, wrong or wrong-length secret: 403, no database', async () => {
  process.env.INBOX_ALERT_ENABLED = 'on';
  dbTouched = 0;
  for (const secret of [undefined, 'dispatch-unit-secreT', 'short']) {
    assert.equal((await call(secret)).status, 403);
  }
  assert.equal(dbTouched, 0);
});

test('off by default: 200, skipped, no database', async () => {
  delete process.env.INBOX_ALERT_ENABLED;
  dbTouched = 0;
  const res = await call('dispatch-unit-secret');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { skipped: 'INBOX_ALERT_ENABLED is off' });
  assert.equal(dbTouched, 0);
});

test('dry run: runs and reports, mode dry_run', async () => {
  process.env.INBOX_ALERT_ENABLED = 'dry_run';
  const res = await call('dispatch-unit-secret');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'dry_run');
  assert.equal(body.candidates, 0);
});

test('?dry_run=1 makes a live route quieter', async () => {
  process.env.INBOX_ALERT_ENABLED = 'on';
  const body = await (await call('dispatch-unit-secret', '?dry_run=1')).json();
  assert.equal(body.mode, 'dry_run');
});
