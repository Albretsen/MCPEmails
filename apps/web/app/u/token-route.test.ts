// ---------------------------------------------------------------------------
// GET /u/<token>: the chat checkout link (app/u/[token]/route.ts). This file
// sits beside the [token] folder, not in it: node --test reads a path with
// square brackets as a glob and silently runs nothing.
//
// What is pinned here, all of it from the plan's "Token" and "Web route"
// sections (Documents/plans/paywall-checkout-link-20261024.md):
//
//   - a malformed token never costs a database call;
//   - unknown and expired tokens land on the same /upgrade/expired page;
//   - the first open creates ONE session for the link's owner, through the
//     identity entry point of the checkout core, and records paywall_clicked;
//   - every later open goes to that same session (reuse, not single use);
//   - two racing first opens end on the first writer's session;
//   - no response ever sets a cookie, and every one is no-store, no-referrer
//     and noindex.
//
// The checkout core is stubbed: its own guards are tested in
// src/lib/stripe/checkout-core.test.ts. Stripe and Supabase are stubbed at the
// module seam, the same way checkout-core.test.ts does it.
//
// Run: npm run test:checkout-link
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock, beforeEach } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';

process.env.STRIPE_SECRET_KEY ??= 'sk_test_checkout_link_route';
process.env.NEXT_PUBLIC_APP_URL = 'https://mcpemails.test';

/** `mock.module` post-dates the pinned @types/node, same cast as checkout-core.test.ts. */
const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

const OWNER_ID = '00000000-0000-0000-0000-0000000000a1';
const WORKSPACE_ID = '00000000-0000-0000-0000-0000000000b1';
const LINK_ID = '11111111-2222-4333-8444-555555555555';

type LinkRow = {
  id: string;
  workspace_id: string;
  owner_user_id: string;
  plan_id: string;
  billing_interval: string;
  client_label: string;
  expires_at: string;
  stripe_session_id: string | null;
  stripe_session_expires_at: string | null;
  completed_at: string | null;
  open_count: number;
  live: boolean;
};

/** token_hash -> row, as the table would hold it. */
let links = new Map<string, LinkRow>();
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let workspace: { id: string; display_name: string; acquisition_locale: string | null } | null;
/** When set, attach behaves as if another request stored this id first. */
let attachWinner: string | null = null;

/** Stripe's view of the sessions that exist. */
let sessions = new Map<string, { id: string; status: string; url: string | null }>();
let coreCalls: Array<{ identity: Record<string, unknown>; input: Record<string, unknown>; options: Record<string, unknown> }> = [];
let coreOutcome: Record<string, unknown> | null = null;
let clicked: Array<string | null> = [];

beforeEach(() => {
  links = new Map();
  rpcCalls = [];
  workspace = { id: WORKSPACE_ID, display_name: 'Test Workspace', acquisition_locale: null };
  attachWinner = null;
  sessions = new Map();
  coreCalls = [];
  coreOutcome = null;
  clicked = [];
});

function hashOf(token: string): string {
  return `\\x${createHash('sha256').update(token, 'utf8').digest('hex')}`;
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

function addLink(token: string, overrides: Partial<LinkRow> = {}): LinkRow {
  const row: LinkRow = {
    id: LINK_ID,
    workspace_id: WORKSPACE_ID,
    owner_user_id: OWNER_ID,
    plan_id: 'personal',
    billing_interval: 'month',
    client_label: 'claude',
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    stripe_session_id: null,
    stripe_session_expires_at: null,
    completed_at: null,
    open_count: 0,
    live: true,
    ...overrides,
  };
  links.set(hashOf(token), row);
  return row;
}

nodeMock.module('@/lib/supabase/service', {
  namedExports: {
    createServiceRoleClient: () => ({
      async rpc(fn: string, args: Record<string, unknown>) {
        rpcCalls.push({ fn, args });
        if (fn === 'checkout_link_open') {
          const row = links.get(String(args.p_token_hash));
          // Mirrors the SQL: an expired row matches nothing and is not counted.
          if (!row || !row.live) return { data: [], error: null };
          row.open_count += 1;
          const { live: _live, open_count, ...rest } = row;
          return { data: [{ ...rest, first_open: open_count === 1 }], error: null };
        }
        if (fn === 'checkout_link_attach_session') {
          const row = [...links.values()].find((r) => r.id === args.p_id);
          if (!row) return { data: null, error: null };
          if (attachWinner && !row.stripe_session_id) row.stripe_session_id = attachWinner;
          if (!row.stripe_session_id) {
            row.stripe_session_id = String(args.p_session_id);
            row.stripe_session_expires_at = String(args.p_session_expires_at);
          }
          return { data: row.stripe_session_id, error: null };
        }
        throw new Error(`unexpected rpc ${fn}`);
      },
      from(table: string) {
        assert.equal(table, 'workspaces');
        const filters: Record<string, unknown> = {};
        const builder = {
          select: () => builder,
          eq: (col: string, value: unknown) => ((filters[col] = value), builder),
          is: (col: string, value: unknown) => ((filters[col] = value), builder),
          maybeSingle: async () => {
            const ok =
              workspace &&
              filters.id === workspace.id &&
              filters.owner_id === OWNER_ID &&
              filters.deleted_at === null;
            return { data: ok ? workspace : null, error: null };
          },
        };
        return builder;
      },
      auth: {
        admin: {
          getUserById: async (id: string) =>
            id === OWNER_ID
              ? { data: { user: { id, email: 'owner@example.com' } }, error: null }
              : { data: { user: null }, error: { message: 'User not found' } },
        },
      },
    }),
  },
});

nodeMock.module('@/lib/stripe/client', {
  namedExports: {
    stripe: {
      checkout: {
        sessions: {
          retrieve: async (id: string) => {
            const s = sessions.get(id);
            if (!s) throw new Error('No such checkout.session');
            return s;
          },
        },
      },
    },
  },
});

let sessionCounter = 0;
nodeMock.module('@/lib/stripe/checkout-core', {
  namedExports: {
    runCheckoutForIdentity: async (
      identity: Record<string, unknown>,
      input: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => {
      coreCalls.push({ identity, input, options });
      if (coreOutcome) return coreOutcome;
      sessionCounter += 1;
      const id = `cs_test_link${String(sessionCounter).padStart(8, '0')}`;
      const url = `https://checkout.stripe.com/c/pay/${id}`;
      sessions.set(id, { id, status: 'open', url });
      return { kind: 'checkout', url, sessionId: id };
    },
  },
});

nodeMock.module('@/lib/analytics/billing-funnel', {
  namedExports: {
    recordChatLinkOpened: async (workspaceId: string | null) => {
      clicked.push(workspaceId);
    },
  },
});

// Plain Node cannot resolve `next/server` outside the Next toolchain.
nodeMock.module('next/server', {
  namedExports: {
    NextRequest: Request,
    NextResponse: {
      json: (body: unknown, init?: ResponseInit) => Response.json(body, init),
      redirect: (url: string | URL, status: number) =>
        new Response(null, { status, headers: { location: String(url) } }),
    },
  },
});

const route = (await import('./[token]/route.ts')) as Record<string, unknown>;
const GET = route.GET as (req: unknown, ctx: unknown) => Promise<Response>;

/** Every response from every test, so the header rules can be checked on all of them. */
const allResponses: Response[] = [];

async function open(token: string, headers: Record<string, string> = {}) {
  const url = new URL(`https://mcpemails.test/u/${encodeURIComponent(token)}`);
  const req = Object.assign(new Request(url, { headers }), { nextUrl: url });
  const res = await GET(req, { params: Promise.resolve({ token }) });
  allResponses.push(res);
  assert.equal(res.status, 303);
  return { res, location: new URL(res.headers.get('location') ?? '') };
}

// ── Shape and lookup ───────────────────────────────────────────────────────

test('a malformed token goes to /upgrade/expired without a database call', async () => {
  for (const bad of ['', 'abc', 'x'.repeat(42), 'x'.repeat(44), `${'a'.repeat(42)}.`, `${'a'.repeat(42)}=`, `${'a'.repeat(40)}%2F`]) {
    const { location } = await open(bad);
    assert.equal(location.pathname, '/upgrade/expired', JSON.stringify(bad));
    assert.equal(location.search, '');
  }
  assert.deepEqual(rpcCalls, []);
});

test('an unknown token looks exactly like an expired one', async () => {
  const unknown = await open(newToken());
  const expiredToken = newToken();
  addLink(expiredToken, { live: false });
  const expired = await open(expiredToken);
  assert.equal(unknown.location.href, expired.location.href);
  assert.equal(unknown.location.pathname, '/upgrade/expired');
  assert.equal(coreCalls.length, 0);
  assert.deepEqual(clicked, []);
});

test('the lookup sends sha256 of the token string as a bytea hex literal', async () => {
  const token = newToken();
  await open(token);
  assert.equal(rpcCalls[0].fn, 'checkout_link_open');
  assert.match(String(rpcCalls[0].args.p_token_hash), /^\\x[0-9a-f]{64}$/);
  assert.equal(rpcCalls[0].args.p_token_hash, hashOf(token));
});

// ── First open ─────────────────────────────────────────────────────────────

test('the first open creates one session for the owner and redirects to Stripe', async () => {
  const token = newToken();
  addLink(token);
  const before = Math.floor(Date.now() / 1000);
  const { location } = await open(token);

  assert.equal(coreCalls.length, 1);
  const call = coreCalls[0];
  assert.deepEqual(call.identity, {
    userId: OWNER_ID,
    email: 'owner@example.com',
    workspaceId: WORKSPACE_ID,
    displayName: 'Test Workspace',
  });
  assert.deepEqual(call.input, { planId: 'personal', interval: 'month', locale: 'en' });
  assert.equal(call.options.successUrl, 'https://mcpemails.test/upgrade/done?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(call.options.cancelUrl, 'https://mcpemails.test/pricing?from=chat_link');
  assert.equal(call.options.entryPoint, 'chat_link');
  assert.deepEqual(call.options.extraMetadata, { checkout_link_id: LINK_ID });
  // Stripe's minimum is 30 minutes ahead; the route asks for 31.
  const expiresAt = Number(call.options.sessionExpiresAt);
  assert.ok(expiresAt >= before + 31 * 60 && expiresAt <= before + 31 * 60 + 5, String(expiresAt));
  assert.equal('confirmChange' in call.input, false);

  assert.equal(location.origin, 'https://checkout.stripe.com');
  const attach = rpcCalls.find((c) => c.fn === 'checkout_link_attach_session');
  assert.equal(attach?.args.p_id, LINK_ID);
  assert.equal(attach?.args.p_session_expires_at, new Date(expiresAt * 1000).toISOString());
});

test('the first open records paywall_clicked once, a reopen does not', async () => {
  const token = newToken();
  addLink(token);
  await open(token);
  await open(token);
  await open(token);
  assert.deepEqual(clicked, [WORKSPACE_ID]);
});

// ── Reuse and race ─────────────────────────────────────────────────────────

test('a reopen goes to the same session and creates nothing', async () => {
  const token = newToken();
  addLink(token);
  const first = await open(token);
  const second = await open(token);
  const third = await open(token);
  assert.equal(coreCalls.length, 1);
  assert.equal(second.location.href, first.location.href);
  assert.equal(third.location.href, first.location.href);
});

test('two racing first opens both end on the first writer\'s session', async () => {
  const token = newToken();
  addLink(token);
  const winner = 'cs_test_winner0000001';
  sessions.set(winner, { id: winner, status: 'open', url: 'https://checkout.stripe.com/c/pay/winner' });
  attachWinner = winner;
  const { location } = await open(token);
  assert.equal(location.href, 'https://checkout.stripe.com/c/pay/winner');
});

test('a paid session sends a reopen to /upgrade/done, an expired one to /upgrade/expired', async () => {
  const paidToken = newToken();
  addLink(paidToken, { stripe_session_id: 'cs_test_paid00000001' });
  sessions.set('cs_test_paid00000001', { id: 'cs_test_paid00000001', status: 'complete', url: null });
  const paid = await open(paidToken);
  assert.equal(paid.location.pathname, '/upgrade/done');
  assert.equal(paid.location.searchParams.get('session_id'), 'cs_test_paid00000001');

  const goneToken = newToken();
  addLink(goneToken, { stripe_session_id: 'cs_test_gone00000001' });
  sessions.set('cs_test_gone00000001', { id: 'cs_test_gone00000001', status: 'expired', url: null });
  const gone = await open(goneToken);
  assert.equal(gone.location.pathname, '/upgrade/expired');
  // A link gets one session. Its end is the link's end: no second one.
  assert.equal(coreCalls.length, 0);
});

// ── Refusals ───────────────────────────────────────────────────────────────

test('an owner who already has a plan lands on the subscribed variant', async () => {
  for (const reason of ['subscription_exists', 'comped', 'plan_not_self_service', 'already_on_plan_interval']) {
    const token = newToken();
    addLink(token);
    coreOutcome = { kind: 'error', reason, status: 409, message: 'x' };
    const { location } = await open(token);
    assert.equal(location.pathname, '/upgrade/expired', reason);
    assert.equal(location.searchParams.get('reason'), 'subscribed', reason);
  }
});

test('any other refusal is an error, never a raw Stripe failure', async () => {
  const token = newToken();
  addLink(token);
  coreOutcome = { kind: 'error', reason: 'stripe_session_failed', status: 500, message: 'x' };
  const { location } = await open(token);
  assert.equal(location.searchParams.get('reason'), 'error');
  assert.equal(rpcCalls.some((c) => c.fn === 'checkout_link_attach_session'), false);
});

test('a workspace the owner no longer owns ends the link, the core is never asked', async () => {
  const token = newToken();
  addLink(token);
  workspace = null;
  const { location } = await open(token);
  assert.equal(location.pathname, '/upgrade/expired');
  assert.equal(coreCalls.length, 0);
});

// ── Language ───────────────────────────────────────────────────────────────

test('the hosted page is German for a German workspace or browser, English otherwise', async () => {
  const cases: Array<[string | null, string | undefined, string]> = [
    ['de', undefined, 'de'],
    [null, 'de-DE,de;q=0.9,en;q=0.8', 'de'],
    [null, 'en-US,de;q=0.5', 'en'],
    ['nb', 'nb-NO', 'en'],
    [null, undefined, 'en'],
  ];
  for (const [acquisition, header, expected] of cases) {
    const token = newToken();
    addLink(token);
    workspace = { id: WORKSPACE_ID, display_name: 'Test Workspace', acquisition_locale: acquisition };
    coreCalls = [];
    await open(token, header ? { 'accept-language': header } : {});
    assert.equal(coreCalls[0].input.locale, expected, `${acquisition} / ${header}`);
  }
});

// ── Every response ─────────────────────────────────────────────────────────

test('no response from this route sets a cookie, and every one is no-store, no-referrer and noindex', () => {
  assert.ok(allResponses.length >= 20, `only ${allResponses.length} responses seen`);
  for (const res of allResponses) {
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal(res.headers.get('cache-control'), 'private, no-store, max-age=0');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.match(res.headers.get('x-robots-tag') ?? '', /noindex/);
  }
});

test('the route exports GET only; Next answers 405 to every other method', () => {
  const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  assert.deepEqual(methods.filter((m) => typeof route[m] === 'function'), ['GET']);
});
