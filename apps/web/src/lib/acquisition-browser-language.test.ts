import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ARABIC_GUIDE_PATH, primaryLanguageFromHeader } from './acquisition-browser-language.mjs';
import { stampArabicGuideBrowserLanguage } from './acquisition-browser-language.ts';
import { PATH } from '../../app/[locale]/docs/claude-email-arabic/content.mjs';

function fakeDb(rows: unknown[], opts: { readError?: string; writeError?: string } = {}) {
  const filters: Record<string, unknown> = {};
  const writes: unknown[][] = [];
  const chain = {
    select: () => chain,
    eq: (column: string, value: unknown) => { filters[column] = value; return chain; },
    limit: () => Promise.resolve({
      data: opts.readError ? null : rows,
      error: opts.readError ? { message: opts.readError } : null,
    }),
  };
  const db = {
    from: () => chain,
    auth: {
      admin: {
        updateUserById: (...args: unknown[]) => {
          writes.push(args);
          return Promise.resolve({ error: opts.writeError ? { message: opts.writeError } : null });
        },
      },
    },
  };
  return { db: db as never, filters, writes };
}

test('the path constant matches the page', () => {
  assert.equal(ARABIC_GUIDE_PATH, PATH);
});

test('keeps only the primary subtag of the first language', () => {
  assert.equal(primaryLanguageFromHeader('ar-SA,ar;q=0.9,en;q=0.8'), 'ar');
  assert.equal(primaryLanguageFromHeader('EN-us'), 'en');
  assert.equal(primaryLanguageFromHeader('fil'), 'fil');
});

test('wildcard, empty and malformed values are unknown', () => {
  for (const value of ['*', '', ' ', 'not a language', '12', null, undefined, 7]) {
    assert.equal(primaryLanguageFromHeader(value), null, String(value));
  }
});

test('a signup from the guide gets its language stamped, merged into user_metadata', async () => {
  const { db, filters, writes } = fakeDb([{ id: 'ws-1' }]);
  await stampArabicGuideBrowserLanguage(db, { ownerId: 'user-1', acceptLanguage: 'ar-EG,en;q=0.8' });
  assert.equal(filters.owner_id, 'user-1');
  assert.equal(filters.acquisition_landing_path, PATH);
  assert.deepEqual(writes, [['user-1', { user_metadata: { acquisition_browser_language: 'ar' } }]]);
});

test('a signup from any other page keeps nothing', async () => {
  const { db, writes } = fakeDb([]);
  await stampArabicGuideBrowserLanguage(db, { ownerId: 'user-1', acceptLanguage: 'ar' });
  assert.equal(writes.length, 0);
});

test('no owner or no language writes nothing', async () => {
  for (const args of [{ ownerId: null, acceptLanguage: 'ar' }, { ownerId: 'user-1', acceptLanguage: '*' }]) {
    const { db, writes } = fakeDb([{ id: 'ws-1' }]);
    await stampArabicGuideBrowserLanguage(db, args);
    assert.equal(writes.length, 0);
  }
});

test('database and auth errors never throw', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    for (const opts of [{ readError: 'down' }, { writeError: 'down' }]) {
      const { db } = fakeDb([{ id: 'ws-1' }], opts);
      await assert.doesNotReject(stampArabicGuideBrowserLanguage(db, { ownerId: 'user-1', acceptLanguage: 'ar' }));
    }
    const throwing = { from: () => { throw new Error('boom'); } } as never;
    await assert.doesNotReject(stampArabicGuideBrowserLanguage(throwing, { ownerId: 'user-1', acceptLanguage: 'ar' }));
  } finally {
    console.error = originalError;
  }
});

test('both signup paths stamp it from their own request', () => {
  const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
  const page = read('../../app/dashboard/[[...section]]/page.js');
  const gate = page.indexOf('if (shouldStampDeviceOnDashboard(');
  assert.ok(gate > -1 && page.indexOf('stampArabicGuideBrowserLanguage(createServiceRoleClient()') > gate);
  const callback = read('../../app/auth/callback/route.ts');
  const attribution = callback.indexOf("acquisition_landing_path: acquisition.landingPath");
  assert.ok(attribution > -1 && callback.indexOf('await stampArabicGuideBrowserLanguage(service') > attribution);
  assert.match(callback, /acceptLanguage: request\.headers\.get\('accept-language'\)/);
});
