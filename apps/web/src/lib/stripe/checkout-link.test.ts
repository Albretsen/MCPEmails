// ---------------------------------------------------------------------------
// The shared helpers of the chat checkout link (src/lib/stripe/checkout-link.ts):
// the token shape and hash the redeem route relies on, the hosted page's
// language, the status the success page and its poll read, and the webhook's
// "mark paid" call.
//
// Run: npm run test:checkout-link
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock, beforeEach } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';

process.env.STRIPE_SECRET_KEY ??= 'sk_test_checkout_link_lib';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

const LINK_ID = '11111111-2222-4333-8444-555555555555';
const WORKSPACE_ID = '00000000-0000-0000-0000-0000000000b1';
const SESSION_ID = 'cs_test_a1B2c3D4e5F6g7H8';

let session: { id: string; status: string; metadata: Record<string, string> | null } | null;
let linkRow: { workspace_id: string; stripe_session_id: string } | null;
let workspacePlan: string | null;
let rpcCalls: Array<{ fn: string; args: unknown }> = [];

beforeEach(() => {
  session = { id: SESSION_ID, status: 'complete', metadata: { checkout_link_id: LINK_ID, user_id: 'u' } };
  linkRow = { workspace_id: WORKSPACE_ID, stripe_session_id: SESSION_ID };
  workspacePlan = 'personal';
  rpcCalls = [];
});

nodeMock.module('@/lib/stripe/client', {
  namedExports: {
    stripe: {
      checkout: {
        sessions: {
          retrieve: async (id: string) => {
            if (!session || session.id !== id) throw new Error('No such checkout.session');
            return session;
          },
        },
      },
    },
  },
});

nodeMock.module('@/lib/supabase/service', {
  namedExports: {
    createServiceRoleClient: () => ({
      async rpc(fn: string, args: unknown) {
        rpcCalls.push({ fn, args });
        return { data: null, error: null };
      },
      from(table: string) {
        const filters: Record<string, unknown> = {};
        const builder = {
          select: () => builder,
          eq: (col: string, value: unknown) => ((filters[col] = value), builder),
          maybeSingle: async () => {
            if (table === 'checkout_links') {
              const ok = linkRow && filters.id === LINK_ID && filters.stripe_session_id === linkRow.stripe_session_id;
              return { data: ok ? { workspace_id: linkRow!.workspace_id } : null, error: null };
            }
            assert.equal(table, 'workspaces');
            assert.equal(filters.id, WORKSPACE_ID);
            return { data: workspacePlan ? { plan: workspacePlan } : null, error: null };
          },
        };
        return builder;
      },
    }),
  },
});

const lib = await import('./checkout-link.ts');

/** Keep the expected console.error lines out of the test output. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

test('a token is exactly 43 base64url characters, the shape of 32 bytes unpadded', () => {
  for (let i = 0; i < 50; i++) assert.ok(lib.isCheckoutLinkToken(randomBytes(32).toString('base64url')));
  for (const bad of ['', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}=`, `${'a'.repeat(42)}+`, `${'a'.repeat(42)}/`, null, 42, ['a'.repeat(43)]]) {
    assert.equal(lib.isCheckoutLinkToken(bad), false, JSON.stringify(bad));
  }
});

test('the hash is sha256 over the UTF-8 token string, as a bytea hex literal', () => {
  const token = randomBytes(32).toString('base64url');
  const expected = createHash('sha256').update(Buffer.from(token, 'utf8')).digest('hex');
  assert.equal(lib.checkoutLinkTokenHash(token), `\\x${expected}`);
  // Not the hash of the decoded bytes: the edge function hashes the string.
  const decoded = createHash('sha256').update(Buffer.from(token, 'base64url')).digest('hex');
  assert.notEqual(lib.checkoutLinkTokenHash(token), `\\x${decoded}`);
});

test('the session outlives Stripe\'s 30-minute minimum', () => {
  assert.ok(lib.CHECKOUT_LINK_SESSION_TTL_SECONDS > 30 * 60);
  assert.ok(lib.CHECKOUT_LINK_SESSION_TTL_SECONDS <= 35 * 60);
});

test('the hosted page is German for a German workspace or a German first browser language only', () => {
  assert.equal(lib.checkoutLinkLocale('de', null), 'de');
  assert.equal(lib.checkoutLinkLocale(null, 'de'), 'de');
  assert.equal(lib.checkoutLinkLocale(null, 'de-AT,en;q=0.5'), 'de');
  assert.equal(lib.checkoutLinkLocale(null, 'en-US,de;q=0.9'), 'en');
  assert.equal(lib.checkoutLinkLocale('fr', 'fr-FR'), 'en');
  assert.equal(lib.checkoutLinkLocale(undefined, undefined), 'en');
  assert.equal(lib.checkoutLinkLocale(null, 'deu'), 'en');
});

test('a paid link session on a paid workspace is active', async () => {
  assert.equal(await lib.checkoutLinkStatus(SESSION_ID), 'active');
});

test('paid but the webhook has not moved the plan yet is activating', async () => {
  workspacePlan = 'free';
  assert.equal(await lib.checkoutLinkStatus(SESSION_ID), 'activating');
});

test('an open or expired link session is unpaid', async () => {
  session!.status = 'open';
  assert.equal(await lib.checkoutLinkStatus(SESSION_ID), 'unpaid');
  session!.status = 'expired';
  assert.equal(await lib.checkoutLinkStatus(SESSION_ID), 'unpaid');
});

test('a session no chat link created reads as unknown, even when it is paid', async () => {
  session!.metadata = { user_id: 'u', plan_id: 'personal' };
  assert.equal(await lib.checkoutLinkStatus(SESSION_ID), 'unknown');
  session!.metadata = { checkout_link_id: 'not-a-uuid' };
  assert.equal(await lib.checkoutLinkStatus(SESSION_ID), 'unknown');
});

test('a session whose link row stores a different session reads as unknown', async () => {
  linkRow = { workspace_id: WORKSPACE_ID, stripe_session_id: 'cs_test_someoneElse01' };
  assert.equal(await lib.checkoutLinkStatus(SESSION_ID), 'unknown');
});

test('a malformed session id never reaches Stripe, and a Stripe failure is unknown', async () => {
  assert.equal(await lib.checkoutLinkStatus('pi_123'), 'unknown');
  assert.equal(await lib.checkoutLinkStatus(undefined), 'unknown');
  assert.equal(await quiet(() => lib.checkoutLinkStatus('cs_test_doesNotExist01')), 'unknown');
});

test('the webhook marks a link paid by its uuid, and ignores anything else', async () => {
  await lib.markCheckoutLinkComplete(LINK_ID.toUpperCase());
  assert.deepEqual(rpcCalls, [{ fn: 'checkout_link_complete', args: { p_id: LINK_ID } }]);
  rpcCalls = [];
  for (const bad of [undefined, '', 'x', 42, `${LINK_ID}x`]) await lib.markCheckoutLinkComplete(bad);
  assert.deepEqual(rpcCalls, []);
});
