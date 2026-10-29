// ---------------------------------------------------------------------------
// GET /r/<code>: the cookie and the redirect.
//
//   - a live code with the owner's flag on sets mcpe_ref (HttpOnly, Secure,
//     SameSite=Lax, 60 days, the code only) and lands on the home page with
//     ?acq=referral, in the visitor's language;
//   - an unknown, malformed or disabled code, or the flag off, sets no cookie
//     and lands on the plain home page;
//   - the code never appears in the destination URL.
//
// Run: npm run test:referrals-server
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { FakeSupabase } from '@/lib/billing/fake-supabase';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

let db = new FakeSupabase();
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => db } });

// Kept outside [code]/: node --test reads its arguments as globs.
const { GET } = await import('./[code]/route.ts');

const OWNER = '00000000-0000-4000-8000-0000000000a1';

function seed(options: { flag?: boolean; disabled?: boolean } = {}) {
  db = new FakeSupabase();
  db.seed('referral_codes', [
    { user_id: OWNER, code: 'ABCD2345', disabled_at: options.disabled ? '2026-11-01T00:00:00.000Z' : null },
  ]);
  db.seed('workspaces', [
    { id: 'ws-owner', owner_id: OWNER, plan: 'free', referral_enabled: options.flag ?? true, deleted_at: null },
  ]);
}

async function open(code: string, headers: Record<string, string> = {}, query = '') {
  const res = await GET(new Request(`https://mcpemails.test/r/${code}${query}`, { headers }), {
    params: Promise.resolve({ code }),
  });
  return { status: res.status, location: res.headers.get('location') ?? '', cookie: res.headers.get('set-cookie') };
}

test('a live code sets the referral cookie with every flag and lands with ?acq=referral', async () => {
  seed();
  const r = await open('abcd-2345');
  assert.equal(r.status, 307);
  assert.equal(r.location, 'https://mcpemails.test/?acq=referral');
  assert.ok(r.cookie, 'cookie set');
  const parts = r.cookie.split('; ');
  assert.equal(parts[0], 'mcpe_ref=ABCD2345');
  for (const flag of ['Path=/', `Max-Age=${60 * 24 * 60 * 60}`, 'HttpOnly', 'SameSite=Lax', 'Secure']) {
    assert.ok(parts.includes(flag), `cookie carries ${flag}`);
  }
});

test('the code never reaches the destination URL', async () => {
  seed();
  const r = await open('ABCD2345');
  assert.ok(!r.location.includes('ABCD2345'));
});

test('unknown, malformed, disabled and flag-off codes set no cookie and no banner', async () => {
  for (const [options, code] of [
    [{}, 'ZZZZ9999'],
    [{}, 'not-a-code-at-all'],
    [{ disabled: true }, 'ABCD2345'],
    [{ flag: false }, 'ABCD2345'],
  ] as const) {
    seed(options);
    const r = await open(code);
    assert.equal(r.status, 307, code);
    assert.equal(r.cookie, null, `${code} ${JSON.stringify(options)}`);
    assert.equal(r.location, 'https://mcpemails.test/', code);
  }
});

test('a lookup failure is a plain redirect, never an error page', async () => {
  seed();
  db.failOnce('referral_codes', { message: 'boom' });
  const r = await open('ABCD2345');
  assert.equal(r.status, 307);
  assert.equal(r.cookie, null);
});

test('the landing page follows ?lang, then Accept-Language, then English', async () => {
  seed();
  assert.equal((await open('ABCD2345', { 'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8' })).location, 'https://mcpemails.test/fr?acq=referral');
  assert.equal((await open('ABCD2345', { 'accept-language': 'no;q=0.9,de;q=0.5' })).location, 'https://mcpemails.test/nb?acq=referral');
  assert.equal((await open('ABCD2345', { 'accept-language': 'ja,pt;q=0.5' })).location, 'https://mcpemails.test/?acq=referral');
  assert.equal((await open('ABCD2345', { 'accept-language': 'fr' }, '?lang=es')).location, 'https://mcpemails.test/es?acq=referral');
  assert.equal((await open('ZZZZ9999', { 'accept-language': 'de' })).location, 'https://mcpemails.test/de');
});

test('plain http (local dev) drops Secure and keeps the rest', async () => {
  seed();
  const res = await GET(new Request('http://localhost:3000/r/ABCD2345'), { params: Promise.resolve({ code: 'ABCD2345' }) });
  const cookie = res.headers.get('set-cookie') ?? '';
  assert.ok(cookie.startsWith('mcpe_ref=ABCD2345'));
  assert.ok(!cookie.includes('Secure'));
});
