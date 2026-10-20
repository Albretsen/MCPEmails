import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stampAcquisitionCountry } from './acquisition-country-stamp.ts';
import { countryFromHeaders, sanitizedCountry } from './acquisition-country.mjs';

// Only reserved example data. Never a real customer's.

type Workspace = { id: string; owner_id: string; acquisition_country: string | null };

/** An in-memory workspaces table that honours `.eq` and `.is`, and counts writes. */
function fakeDb(rows: Workspace[], result: { error: { message: string } | null } = { error: null }) {
  const state = { statements: 0, rowsChanged: 0, lastValues: null as unknown };
  const db = {
    from(table: string) {
      assert.equal(table, 'workspaces');
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      let patch: Record<string, unknown> | null = null;
      const chain = {
        update(values: Record<string, unknown>) { patch = values; state.lastValues = values; return chain; },
        eq(col: string, v: unknown) { filters.push((r) => r[col] === v); return chain; },
        is(col: string, v: unknown) {
          filters.push((r) => r[col] === v);
          state.statements += 1;
          if (!result.error && patch) {
            for (const row of rows as unknown as Array<Record<string, unknown>>) {
              if (filters.every((f) => f(row))) { Object.assign(row, patch); state.rowsChanged += 1; }
            }
          }
          return Promise.resolve(result);
        },
      };
      return chain;
    },
  };
  return { db: db as never, state };
}

function workspaces(): Workspace[] {
  return [
    { id: 'ws-owner', owner_id: 'user-1', acquisition_country: null },
    // A workspace user-1 was invited to. Somebody else owns it.
    { id: 'ws-invited', owner_id: 'user-2', acquisition_country: null },
  ];
}

/* ------------------------------------------------------- the header */

test('a two-letter country code is kept as is', () => {
  for (const code of ['NO', 'FR', 'US', 'DE', 'CN', 'BR']) {
    assert.equal(countryFromHeaders(new Headers({ 'x-vercel-ip-country': code })), code);
  }
});

test('stray case and whitespace are normalised, not refused', () => {
  assert.equal(sanitizedCountry(' no '), 'NO');
  assert.equal(sanitizedCountry('fr'), 'FR');
});

test('a missing header is unknown', () => {
  assert.equal(countryFromHeaders(new Headers()), null);
  assert.equal(countryFromHeaders(null), null);
  assert.equal(countryFromHeaders(undefined), null);
});

test('placeholder and malformed values are unknown, never a country', () => {
  for (const value of ['', '  ', 'XX', 'xx', 'ZZ', 'T1', 'EU', 'AP', 'USA', 'N', '12', 'N0', 'NO,SE', '192.0.2.1', null, undefined, 47, {}]) {
    assert.equal(sanitizedCountry(value), null, JSON.stringify(value));
  }
});

test('only x-vercel-ip-country is read: other geo or IP headers do not count', () => {
  const headers = new Headers({
    'x-forwarded-for': '192.0.2.1',
    'x-real-ip': '192.0.2.1',
    'cf-ipcountry': 'SE',
    'x-country': 'SE',
  });
  assert.equal(countryFromHeaders(headers), null);
});

/* -------------------------------------------------------- the write */

test('the code lands on the workspace the user owns, and only there', async () => {
  const rows = workspaces();
  const { db, state } = fakeDb(rows);
  await stampAcquisitionCountry(db, { ownerId: 'user-1', country: 'NO' });
  assert.equal(state.statements, 1);
  assert.deepEqual(state.lastValues, { acquisition_country: 'NO' });
  assert.equal(rows[0].acquisition_country, 'NO');
  assert.equal(rows[1].acquisition_country, null);
});

test('first write wins: a value already there is never overwritten', async () => {
  const rows = workspaces();
  rows[0].acquisition_country = 'SE';
  const { db, state } = fakeDb(rows);
  await stampAcquisitionCountry(db, { ownerId: 'user-1', country: 'DE' });
  assert.equal(state.rowsChanged, 0);
  assert.equal(rows[0].acquisition_country, 'SE');
});

test('a second stamp of the same signup changes nothing', async () => {
  const rows = workspaces();
  const { db, state } = fakeDb(rows);
  await stampAcquisitionCountry(db, { ownerId: 'user-1', country: 'FR' });
  await stampAcquisitionCountry(db, { ownerId: 'user-1', country: 'ES' });
  assert.equal(state.rowsChanged, 1);
  assert.equal(rows[0].acquisition_country, 'FR');
});

test('an unknown or placeholder country is not written at all', async () => {
  for (const country of [null, undefined, '', 'XX', 'ZZ', 'T1', '192.0.2.1', "NO'; --"]) {
    const rows = workspaces();
    const { db, state } = fakeDb(rows);
    await stampAcquisitionCountry(db, { ownerId: 'user-1', country });
    assert.equal(state.statements, 0, String(country));
    assert.equal(rows[0].acquisition_country, null);
  }
});

test('no owner writes nothing', async () => {
  for (const ownerId of [null, undefined, '']) {
    const { db, state } = fakeDb(workspaces());
    await stampAcquisitionCountry(db, { ownerId, country: 'NO' });
    assert.equal(state.statements, 0);
  }
});

test('a failed write (for example the migration not applied yet) never throws', async () => {
  const { db } = fakeDb(workspaces(), { error: { message: 'column "acquisition_country" does not exist' } });
  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.doesNotReject(stampAcquisitionCountry(db, { ownerId: 'user-1', country: 'NO' }));
    const throwing = { from() { throw new Error('boom'); } } as never;
    await assert.doesNotReject(stampAcquisitionCountry(throwing, { ownerId: 'user-1', country: 'NO' }));
  } finally {
    console.error = originalError;
  }
});

/* ------------------------------------------- where it is wired, and the DB */

// The dashboard page is a server component and is not rendered here, so this
// pins that the password-signup path reads the same request's headers and
// writes the country after the response, behind the device gate.
test('the dashboard page stamps the country from its own request, behind the device gate', () => {
  const page = readFileSync(
    fileURLToPath(new URL('../../app/dashboard/[[...section]]/page.js', import.meta.url)),
    'utf8',
  );
  const gate = page.indexOf('if (shouldStampDeviceOnDashboard(');
  const stamp = page.indexOf('after(() => stampAcquisitionCountry(createServiceRoleClient(), { ownerId: user.id, country }));');
  assert.ok(gate > -1 && stamp > gate, 'the country write sits inside the device gate');
  assert.match(page, /const country = countryFromHeaders\(requestHeaders\);/);
});

test('the migration pins the same shape this file writes', () => {
  const sql = readFileSync(
    fileURLToPath(new URL('../../../../supabase/migrations/20261020140000_acquisition_country.sql', import.meta.url)),
    'utf8',
  );
  assert.match(sql, /ADD COLUMN IF NOT EXISTS acquisition_country text;/);
  assert.match(sql, /acquisition_country ~ '\^\[A-Z\]\{2\}\$'/);
});
