// ---------------------------------------------------------------------------
// DELETE /api/user/delete-account and the Stripe subscription.
//
// Deleting an account soft-deletes every workspace and bans the auth user, but
// the subscription lives in Stripe and nothing used to cancel it, so a paying
// customer who deleted their account kept being charged. The route now cancels
// every live subscription first, and if Stripe fails it stops before tearing
// anything down. These tests pin both halves, and the ordering between them.
//
// Only the I/O is stubbed (Supabase, Stripe, next/server). Every Supabase call
// is written to one ordered log alongside the Stripe calls, so "Stripe was
// called before the first write" is a fact about the log, not about mocks.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs \
//        app/api/user/delete-account/route.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock, beforeEach } from 'node:test';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

/** `mock.module` post-dates the pinned @types/node, same cast as checkout-core.test.ts. */
const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

const USER = { id: '00000000-0000-4000-8000-00000000d31e', email: 'owner@example.test' };

type Sub = { id: string; status: string; customer: string };

interface World {
  authed: boolean;
  workspaces: Array<{ id: string; stripe_customer_id: string | null }>;
  billing: { stripe_customer_id: string | null } | null;
  billingError: { message: string } | null;
  subs: Sub[];
  stripeFails: boolean;
  /** Every Supabase and Stripe call, in order. */
  log: string[];
  /** The filters of each Supabase call, keyed like `log` entries, in order. */
  calls: Array<{ entry: string; filters: Array<[string, string, unknown]> }>;
  cancelParams: Array<{ id: string; params: Record<string, unknown> }>;
  /** Gmail inbox rows the grant lookup returns (tokens encrypted). */
  inboxes: Array<Record<string, unknown>>;
  /** Google revoke calls, by token. */
  revoked: string[];
  googleFails: boolean;
  /** Work queued with next/server `after()`. */
  after: Array<() => unknown>;
  emails: Array<{ to: string; locale: string }>;
}

let world: World;

function reset(overrides: Partial<World> = {}): void {
  world = {
    authed: true,
    workspaces: [{ id: 'ws-1', stripe_customer_id: null }],
    billing: { stripe_customer_id: 'cus_owner' },
    billingError: null,
    subs: [
      { id: 'sub_live', status: 'active', customer: 'cus_owner' },
      { id: 'sub_old', status: 'canceled', customer: 'cus_owner' },
    ],
    stripeFails: false,
    log: [],
    calls: [],
    cancelParams: [],
    inboxes: [],
    revoked: [],
    googleFails: false,
    after: [],
    emails: [],
    ...overrides,
  };
}

/** A chainable PostgREST stand-in that logs `table.op` when the query runs. */
function query(table: string, op: string) {
  const filters: Array<[string, string, unknown]> = [];
  const result = () => {
    world.log.push(`db:${table}.${op}`);
    world.calls.push({ entry: `db:${table}.${op}`, filters });
    if (table === 'workspaces' && op === 'select') return { data: world.workspaces, error: null };
    if (table === 'inboxes' && op === 'select') return { data: world.inboxes, error: null };
    if (table === 'user_billing' && op === 'select') {
      return { data: world.billing, error: world.billingError };
    }
    return { data: null, error: null };
  };
  const builder: Record<string, unknown> = {};
  for (const name of ['select', 'order', 'range']) {
    builder[name] = () => builder;
  }
  for (const name of ['eq', 'is', 'in']) {
    builder[name] = (column: string, value: unknown) => {
      filters.push([name, column, value]);
      return builder;
    };
  }
  builder.maybeSingle = async () => result();
  builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve().then(result).then(resolve, reject);
  return builder;
}

nodeMock.module('@/lib/supabase/server', {
  namedExports: {
    createClient: async () => ({
      auth: {
        getUser: async () => ({
          data: { user: world.authed ? USER : null },
          error: null,
        }),
        signOut: async () => {
          world.log.push('auth:signOut');
          return { error: null };
        },
      },
    }),
  },
});

nodeMock.module('@/lib/supabase/service', {
  namedExports: {
    createServiceRoleClient: () => ({
      from: (table: string) => ({
        select: () => query(table, 'select'),
        update: () => query(table, 'update'),
        delete: () => query(table, 'delete'),
      }),
      auth: {
        admin: {
          updateUserById: async () => {
            world.log.push('auth:ban');
            return { error: null };
          },
        },
      },
    }),
  },
});

nodeMock.module('@/lib/stripe/client', {
  namedExports: {
    stripe: {
      subscriptions: {
        list: async (params: { customer: string }) => {
          world.log.push(`stripe:list:${params.customer}`);
          if (world.stripeFails) throw new Error('Stripe is down');
          return {
            data: world.subs.filter((s) => s.customer === params.customer),
            has_more: false,
          };
        },
        cancel: async (id: string, params: Record<string, unknown>) => {
          world.log.push(`stripe:cancel:${id}`);
          world.cancelParams.push({ id, params });
          return { id, status: 'canceled' };
        },
      },
    },
  },
});

// Plain Node cannot resolve `next/server` outside the Next toolchain.
nodeMock.module('@/lib/email/account-deleted', {
  namedExports: {
    accountDeletedLocale: (v: unknown) => (typeof v === 'string' && ['en', 'nb', 'fr'].includes(v) ? v : null),
    sendAccountDeletedEmail: async (p: { to: string; locale: string }) => {
      world.emails.push({ to: p.to, locale: p.locale });
    },
  },
});

// Google's revoke endpoint is the only fetch the route makes.
globalThis.fetch = (async (input: string | URL) => {
  const url = new URL(String(input));
  world.log.push('google:revoke');
  if (world.googleFails) throw new Error('Google is down');
  world.revoked.push(url.searchParams.get('token') ?? '');
  return new Response('', { status: 200 });
}) as typeof fetch;

nodeMock.module('next/server', {
  namedExports: {
    after: (fn: () => unknown) => {
      world.after.push(fn);
    },
    NextRequest: Request,
    NextResponse: {
      json: (body: unknown, init?: ResponseInit) => Response.json(body, init),
    },
  },
});

const route = (await import('./route.ts')) as Record<string, unknown>;
const DELETE = route.DELETE as (req: Request) => Promise<Response>;

function request(body: unknown = { confirmEmail: USER.email }): Request {
  return new Request('https://mcpemails.test/api/user/delete-account', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A Supabase call that changes something, as opposed to a read. */
const isWrite = (entry: string) =>
  /^db:.*\.(update|delete)$/.test(entry) || entry === 'auth:ban' || entry === 'auth:signOut';

beforeEach(() => reset());

// ── Every HTTP method ──────────────────────────────────────────────────────
// Only DELETE is exported, so Next answers every other method with 405 before
// any of this code runs. A GET or POST handler added here later would be a
// second, unreviewed way into account deletion.
for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'OPTIONS']) {
  test(`${method} is not handled (Next answers 405)`, () => {
    assert.equal(route[method], undefined, `${method} must not be exported`);
  });
}

test('DELETE is the only handler', () => {
  assert.equal(typeof DELETE, 'function');
});

// ── DELETE ─────────────────────────────────────────────────────────────────

test('DELETE cancels the live subscription immediately, before anything is torn down', async () => {
  const res = await DELETE(request());
  assert.equal(res.status, 200);

  assert.deepEqual(
    world.cancelParams.map((c) => c.id),
    ['sub_live'],
    'the live subscription is cancelled; the already-cancelled one is left alone',
  );
  assert.deepEqual(world.cancelParams[0].params, {
    invoice_now: false,
    prorate: false,
    cancellation_details: { comment: 'account_deleted' },
  });

  const cancelAt = world.log.indexOf('stripe:cancel:sub_live');
  const firstWrite = world.log.findIndex(isWrite);
  assert.ok(firstWrite > cancelAt, `cancel must precede every write: ${world.log.join(', ')}`);
  assert.ok(world.log.includes('auth:ban'), 'the account is still banned');
});

test('DELETE also cancels on a customer id found only on a legacy workspace row', async () => {
  reset({
    billing: null,
    workspaces: [{ id: 'ws-1', stripe_customer_id: 'cus_legacy' }],
    subs: [{ id: 'sub_legacy', status: 'past_due', customer: 'cus_legacy' }],
  });
  const res = await DELETE(request());
  assert.equal(res.status, 200);
  assert.deepEqual(world.cancelParams.map((c) => c.id), ['sub_legacy']);
});

test('DELETE asks Stripe once per customer when both rows name the same one', async () => {
  reset({ workspaces: [{ id: 'ws-1', stripe_customer_id: 'cus_owner' }] });
  await DELETE(request());
  assert.equal(world.log.filter((e) => e === 'stripe:list:cus_owner').length, 1);
});

test('DELETE stops with a one-line error and touches nothing when Stripe fails', async () => {
  reset({ stripeFails: true });
  const res = await DELETE(request());
  assert.equal(res.status, 502);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /subscription/i);
  assert.doesNotMatch(body.error, /\n/);
  assert.deepEqual(world.log.filter(isWrite), [], `no write may happen: ${world.log.join(', ')}`);
});

test('DELETE stops and touches nothing when the billing row cannot be read', async () => {
  reset({ billingError: { message: 'connection reset' } });
  const res = await DELETE(request());
  assert.equal(res.status, 500);
  assert.deepEqual(world.log.filter((e) => e.startsWith('stripe:')), []);
  assert.deepEqual(world.log.filter(isWrite), []);
});

test('DELETE for a free user with no Stripe customer never calls Stripe', async () => {
  reset({ billing: null, subs: [] });
  const res = await DELETE(request());
  assert.equal(res.status, 200);
  assert.deepEqual(world.log.filter((e) => e.startsWith('stripe:')), []);
});

test('DELETE without a session is 401 and never calls Stripe', async () => {
  reset({ authed: false });
  const res = await DELETE(request());
  assert.equal(res.status, 401);
  assert.deepEqual(world.log, []);
});

test('DELETE with the wrong confirmation email is 400 and never calls Stripe', async () => {
  const res = await DELETE(request({ confirmEmail: 'someone@else.test' }));
  assert.equal(res.status, 400);
  assert.deepEqual(world.log, []);
});

// ── The user's own credentials, in EVERY workspace ─────────────────────────
// Owned workspaces are torn down wholesale, but in a team workspace the user
// was only a member of, dropping the membership row used to leave every key
// they minted there (and every OAuth chain that can mint more) fully live.

/** The calls that revoke the user's own credentials, by user id, not workspace. */
function ownCredentialCalls() {
  const credentialWrites = new Set(['db:api_keys.update', 'db:oauth_refresh_tokens.update', 'db:oauth_auth_codes.delete']);
  return world.calls.filter((c) =>
    credentialWrites.has(c.entry)
    && c.filters.some(([op, column, value]) =>
      op === 'eq' && (column === 'created_by' || column === 'user_id') && value === USER.id)
    && !c.filters.some(([, column]) => column === 'workspace_id'));
}

test('DELETE revokes the user\'s keys, refresh chains and pending codes everywhere, before memberships go', async () => {
  // A member-only account: owns nothing, belongs to someone else's workspace.
  reset({ workspaces: [], billing: null, subs: [] });
  const res = await DELETE(request());
  assert.equal(res.status, 200);

  const own = ownCredentialCalls().map((c) => c.entry);
  assert.ok(own.includes('db:api_keys.update'), `keys by created_by: ${own.join(', ')}`);
  assert.ok(own.includes('db:oauth_refresh_tokens.update'), 'refresh chains by user_id');
  assert.ok(own.includes('db:oauth_auth_codes.delete'), 'pending codes by user_id');

  const membershipsGone = world.log.indexOf('db:workspace_members.delete');
  assert.ok(membershipsGone > -1);
  for (const entry of ['db:api_keys.update', 'db:oauth_refresh_tokens.update', 'db:oauth_auth_codes.delete']) {
    assert.ok(world.log.indexOf(entry) < membershipsGone, `${entry} must precede the membership delete: ${world.log.join(', ')}`);
  }
});

test('DELETE for an owner still revokes their own credentials in workspaces they do not own', async () => {
  const res = await DELETE(request());
  assert.equal(res.status, 200);
  assert.equal(ownCredentialCalls().length, 3);
});

test('DELETE still touches no credential when Stripe fails', async () => {
  reset({ stripeFails: true });
  await DELETE(request());
  assert.deepEqual(ownCredentialCalls(), []);
});

// ── Google grants (F) ───────────────────────────────────────────────────────
// Single-inbox disconnect always revoked the Google grant; account delete only
// nulled the tokens, which leaves the grant listed in the user's Google
// account. It now revokes first, best effort.

const { encryptToken } = await import('../../../../src/lib/crypto.ts');

function gmailInboxes() {
  return [
    { id: 'in-1', imap_host: null, oauth_refresh_token: encryptToken('refresh-1'), oauth_access_token: encryptToken('access-1') },
    { id: 'in-2', imap_host: null, oauth_refresh_token: null, oauth_access_token: encryptToken('access-2') },
    // An app-password Gmail inbox has no grant.
    { id: 'in-3', imap_host: 'imap.gmail.com', oauth_refresh_token: null, oauth_access_token: null },
  ];
}

test('DELETE revokes the Google grant of every Gmail inbox, before the tokens are nulled', async () => {
  reset({ inboxes: gmailInboxes() });
  const res = await DELETE(request());
  assert.equal(res.status, 200);
  assert.deepEqual(world.revoked.sort(), ['access-2', 'refresh-1'], 'refresh token preferred, app-password skipped');
  const lastRevoke = world.log.lastIndexOf('google:revoke');
  const tokensNulled = world.log.indexOf('db:inboxes.update');
  assert.ok(lastRevoke > -1 && tokensNulled > lastRevoke, `revoke before the inbox update: ${world.log.join(', ')}`);
  const lookup = world.calls.find((c) => c.entry === 'db:inboxes.select');
  assert.ok(lookup?.filters.some(([op, col, v]) => op === 'eq' && col === 'provider' && v === 'gmail'));
});

test('DELETE still deletes the account when Google revocation fails', async () => {
  reset({ inboxes: gmailInboxes(), googleFails: true });
  const res = await DELETE(request());
  assert.equal(res.status, 200);
  assert.ok(world.log.includes('db:inboxes.update'), 'the inboxes are still torn down');
  assert.ok(world.log.includes('auth:ban'));
});

test('DELETE never asks Google anything when Stripe fails', async () => {
  reset({ inboxes: gmailInboxes(), stripeFails: true });
  await DELETE(request());
  assert.deepEqual(world.revoked, []);
});

// ── Queued mail (B5) and the confirmation email (B6) ──────────────────────

test('DELETE cancels pending scheduled sends and held approvals of the owned workspaces', async () => {
  const res = await DELETE(request());
  assert.equal(res.status, 200);
  for (const table of ['scheduled_sends', 'send_approvals']) {
    const call = world.calls.find((c) => c.entry === `db:${table}.update`);
    assert.ok(call, `${table} updated`);
    assert.ok(call.filters.some(([op, col, v]) => op === 'in' && col === 'workspace_id' && JSON.stringify(v) === '["ws-1"]'));
    assert.ok(call.filters.some(([op, col, v]) => op === 'eq' && col === 'status' && v === 'pending'));
  }
});

test('DELETE sends the confirmation after the response, in the requested language', async () => {
  const res = await DELETE(request({ confirmEmail: USER.email, locale: 'nb' }));
  assert.equal(res.status, 200);
  assert.equal(world.emails.length, 0, 'not before the response');
  for (const fn of world.after) await fn();
  assert.deepEqual(world.emails, [{ to: USER.email, locale: 'nb' }]);
});

test('DELETE falls back to English for an unknown language, and sends nothing when it fails', async () => {
  await DELETE(request({ confirmEmail: USER.email, locale: 'xx' }));
  for (const fn of world.after) await fn();
  assert.deepEqual(world.emails, [{ to: USER.email, locale: 'en' }]);

  reset({ stripeFails: true });
  await DELETE(request());
  for (const fn of world.after) await fn();
  assert.deepEqual(world.emails, []);
});
