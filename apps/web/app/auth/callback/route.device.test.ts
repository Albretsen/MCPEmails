// ---------------------------------------------------------------------------
// The signup device class and country, end to end through GET /auth/callback:
// a Google or GitHub signup is stamped from the headers of the browser's own
// request, a returning account is not, a value already there survives, and
// nothing the URL claims about the device is listened to.
//
// Only the I/O is stubbed: the Supabase clients (an in-memory workspaces table
// that honours `.eq` and `.is`) and `next/server`. The gate, the classifier and
// the write run for real.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs app/auth/callback/route.device.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

type Workspace = {
  id: string;
  owner_id: string;
  acquisition_source: string | null;
  acquisition_device: string | null;
  acquisition_country: string | null;
};

let workspaces: Workspace[] = [];
let user: { id: string; created_at: string } | null = null;
/** Every value object handed to `.update()`, to prove what was (not) sent. */
let updates: Array<Record<string, unknown>> = [];
/** Simulates production before the migration: the column does not exist. */
let deviceColumnExists = true;
/** The same, for 20261020100000_acquisition_country.sql. */
let countryColumnExists = true;
/** Which client each `.update()` went through. */
let writers: Array<'user' | 'service'> = [];

/**
 * `role: 'user'` behaves like the user's own session after
 * 20261016160100_workspaces_server_owned_writes.sql: it holds no UPDATE
 * privilege on public.workspaces, so every write is refused with 42501.
 */
function fakeClient(role: 'user' | 'service') {
  return {
    auth: {
      exchangeCodeForSession: async () => ({ error: null }),
      getUser: async () => ({ data: { user } }),
    },
    from(table: string) {
      assert.equal(table, 'workspaces');
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      let patch: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {};
      builder.update = (values: Record<string, unknown>) => {
        patch = values;
        updates.push(values);
        writers.push(role);
        return builder;
      };
      builder.eq = (col: string, value: unknown) => {
        filters.push((r) => r[col] === value);
        return builder;
      };
      builder.is = (col: string, value: unknown) => {
        filters.push((r) => r[col] === value);
        return builder;
      };
      builder.then = (resolve: (v: unknown) => unknown) => {
        if (role === 'user') {
          return resolve({ error: { code: '42501', message: 'permission denied for table workspaces' } });
        }
        if ('acquisition_device' in patch && !deviceColumnExists) {
          return resolve({ error: { message: 'column "acquisition_device" does not exist' } });
        }
        if ('acquisition_country' in patch && !countryColumnExists) {
          return resolve({ error: { message: 'column "acquisition_country" does not exist' } });
        }
        for (const row of workspaces as unknown as Array<Record<string, unknown>>) {
          if (filters.every((f) => f(row))) Object.assign(row, patch);
        }
        return resolve({ error: null });
      };
      return builder;
    },
  };
}

nodeMock.module('@/lib/supabase/server', {
  namedExports: { createClient: async () => fakeClient('user') },
});
nodeMock.module('@/lib/supabase/service', {
  namedExports: { createServiceRoleClient: () => fakeClient('service') },
});
nodeMock.module('next/server', {
  namedExports: {
    NextResponse: {
      redirect: (url: string) => new Response(null, { status: 307, headers: { location: url } }),
    },
  },
});

const { GET } = await import('./route.ts');

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID_PHONE = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function reset(opts: { createdAt?: string; device?: string | null; source?: string | null; country?: string | null } = {}) {
  user = { id: 'user-1', created_at: opts.createdAt ?? new Date(Date.now() - 1500).toISOString() };
  workspaces = [
    {
      id: 'ws-own', owner_id: 'user-1', acquisition_source: opts.source ?? null,
      acquisition_device: opts.device ?? null, acquisition_country: opts.country ?? null,
    },
    { id: 'ws-other', owner_id: 'user-2', acquisition_source: null, acquisition_device: null, acquisition_country: null },
  ];
  updates = [];
  writers = [];
  deviceColumnExists = true;
  countryColumnExists = true;
}

/** The request the provider's redirect makes the browser send. */
function callback(headers: Record<string, string>, extraQuery = '') {
  return GET(new Request(
    `https://mcpemails.com/auth/callback?code=abc&acq=direct&landing=home&landing_path=%2F&acq_locale=en&referrer=direct&next=%2Fdashboard${extraQuery}`,
    { headers },
  ));
}

test('a Google or GitHub signup from a phone is stamped mobile, once, with the word only', async () => {
  reset();
  const res = await callback({ 'user-agent': IPHONE });
  assert.equal(res.headers.get('location'), 'https://mcpemails.com/dashboard');
  assert.equal(workspaces[0].acquisition_device, 'mobile');
  // Attribution is still written by its own statement.
  assert.equal(workspaces[0].acquisition_source, 'direct');
  const deviceWrites = updates.filter((u) => 'acquisition_device' in u);
  assert.deepEqual(deviceWrites, [{ acquisition_device: 'mobile' }]);
  // The User-Agent never reaches the database.
  assert.equal(JSON.stringify(updates).includes('iPhone'), false);
  assert.equal(JSON.stringify(updates).includes('Mozilla'), false);
  // Somebody else's workspace is untouched.
  assert.equal(workspaces[1].acquisition_device, null);
});

test('both signup stamps go through the service role, never the user session', async () => {
  // The user's session has no write privilege on workspaces any more. If a
  // stamp regressed to the user client it would be refused and the columns
  // would stay NULL, which this test would catch.
  reset();
  await callback({ 'user-agent': IPHONE });
  assert.equal(writers.length, 2);
  assert.deepEqual(writers, ['service', 'service']);
  assert.equal(workspaces[0].acquisition_source, 'direct');
  assert.equal(workspaces[0].acquisition_device, 'mobile');
  assert.equal(workspaces[1].acquisition_source, null);
});

test('the browser headers decide: client hint, tablet and desktop', async () => {
  for (const [headers, expected] of [
    [{ 'user-agent': ANDROID_PHONE, 'sec-ch-ua-mobile': '?1' }, 'mobile'],
    [{ 'user-agent': ANDROID_TABLET, 'sec-ch-ua-mobile': '?0' }, 'tablet'],
    [{ 'user-agent': WINDOWS, 'sec-ch-ua-mobile': '?0' }, 'desktop'],
    [{ 'user-agent': WINDOWS }, 'desktop'],
  ] as const) {
    reset();
    await callback(headers);
    assert.equal(workspaces[0].acquisition_device, expected, JSON.stringify(headers));
  }
});

test('an existing account signing in writes nothing', async () => {
  reset({ createdAt: '2026-08-01T10:00:00Z', source: 'reddit' });
  const res = await callback({ 'user-agent': IPHONE });
  assert.equal(res.status, 307);
  assert.deepEqual(updates, []);
  assert.equal(workspaces[0].acquisition_device, null);
  assert.equal(workspaces[0].acquisition_source, 'reddit');
});

test('a class that is already there is never overwritten', async () => {
  reset({ device: 'desktop' });
  await callback({ 'user-agent': IPHONE });
  assert.equal(workspaces[0].acquisition_device, 'desktop');
});

test('a device named in the URL is ignored, valid or not: only the request headers count', async () => {
  for (const query of [
    '&device=desktop',
    '&acquisition_device=desktop',
    '&acq_device=tablet',
    '&device=%3Cscript%3E',
  ]) {
    reset();
    await callback({ 'user-agent': IPHONE }, query);
    assert.equal(workspaces[0].acquisition_device, 'mobile', query);
  }
  // And it cannot supply a class the headers do not support.
  reset();
  await callback({ 'user-agent': 'node' }, '&device=mobile&acquisition_device=mobile');
  assert.equal(workspaces[0].acquisition_device, null);
  assert.equal(updates.some((u) => 'acquisition_device' in u), false);
});

test('an unclassifiable agent leaves the column NULL and sends no write', async () => {
  for (const headers of [{}, { 'user-agent': 'node' }, { 'user-agent': 'curl/8.7.1' }]) {
    reset();
    await callback(headers as Record<string, string>);
    assert.equal(workspaces[0].acquisition_device, null);
    assert.equal(updates.some((u) => 'acquisition_device' in u), false);
  }
});

test('before the migration is applied the sign-in and the attribution still succeed', async () => {
  reset();
  deviceColumnExists = false;
  const originalError = console.error;
  console.error = () => {};
  try {
    const res = await callback({ 'user-agent': IPHONE });
    assert.equal(res.status, 307);
    assert.equal(res.headers.get('location'), 'https://mcpemails.com/dashboard');
  } finally {
    console.error = originalError;
  }
  assert.equal(workspaces[0].acquisition_source, 'direct');
  assert.equal(workspaces[0].acquisition_device, null);
});

test('a callback without acquisition params (a magic link) does not stamp', async () => {
  reset();
  const res = await GET(new Request('https://mcpemails.com/auth/callback?code=abc', {
    headers: { 'user-agent': IPHONE },
  }));
  assert.equal(res.status, 307);
  assert.deepEqual(updates, []);
});

/* ------------------------------------------------------------- country */

// Reserved documentation address (RFC 5737). It is in the request so the tests
// can prove it never reaches a write.
const DOC_IP = '192.0.2.44';

test('a Google or GitHub signup is stamped with the country Vercel placed the browser in, and never the IP', async () => {
  reset();
  await callback({ 'user-agent': IPHONE, 'x-vercel-ip-country': 'NO', 'x-forwarded-for': DOC_IP, 'x-real-ip': DOC_IP });
  assert.equal(workspaces[0].acquisition_country, 'NO');
  assert.deepEqual(updates.filter((u) => 'acquisition_country' in u), [{ acquisition_country: 'NO' }]);
  assert.equal(JSON.stringify(updates).includes(DOC_IP), false);
  // Through the service role, like the other two stamps.
  assert.deepEqual(writers, ['service', 'service', 'service']);
  // Somebody else's workspace is untouched.
  assert.equal(workspaces[1].acquisition_country, null);
});

test('a missing, empty or placeholder country sends no write', async () => {
  for (const country of [undefined, '', 'XX', 'ZZ', 'T1', 'EU', 'USA', '1']) {
    reset();
    const headers: Record<string, string> = { 'user-agent': IPHONE };
    if (country !== undefined) headers['x-vercel-ip-country'] = country;
    await callback(headers);
    assert.equal(workspaces[0].acquisition_country, null, String(country));
    assert.equal(updates.some((u) => 'acquisition_country' in u), false, String(country));
    // The device is still recorded.
    assert.equal(workspaces[0].acquisition_device, 'mobile');
  }
});

test('a country that is already there is never overwritten', async () => {
  reset({ country: 'SE' });
  await callback({ 'user-agent': IPHONE, 'x-vercel-ip-country': 'DE' });
  assert.equal(workspaces[0].acquisition_country, 'SE');
});

test('an existing account signing in from another country writes nothing', async () => {
  reset({ createdAt: '2026-08-01T10:00:00Z', source: 'reddit' });
  await callback({ 'user-agent': IPHONE, 'x-vercel-ip-country': 'FR' });
  assert.deepEqual(updates, []);
  assert.equal(workspaces[0].acquisition_country, null);
});

test('a country named in the URL is ignored: only the request header counts', async () => {
  reset();
  await callback({ 'user-agent': IPHONE }, '&country=FR&acquisition_country=FR&x-vercel-ip-country=FR');
  assert.equal(workspaces[0].acquisition_country, null);
  assert.equal(updates.some((u) => 'acquisition_country' in u), false);
});

test('before the country migration is applied, the signup still completes and the other stamps land', async () => {
  reset();
  countryColumnExists = false;
  const originalError = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => { logged.push(args.map((a) => JSON.stringify(a)).join(' ')); };
  try {
    const res = await callback({ 'user-agent': IPHONE, 'x-vercel-ip-country': 'NO', 'x-forwarded-for': DOC_IP });
    assert.equal(res.headers.get('location'), 'https://mcpemails.com/dashboard');
  } finally {
    console.error = originalError;
  }
  assert.equal(workspaces[0].acquisition_source, 'direct');
  assert.equal(workspaces[0].acquisition_device, 'mobile');
  assert.equal(workspaces[0].acquisition_country, null);
  assert.ok(logged.some((line) => line.includes('[country] stamp failed')));
  assert.equal(logged.join('\n').includes(DOC_IP), false, 'the IP is never logged');
});
