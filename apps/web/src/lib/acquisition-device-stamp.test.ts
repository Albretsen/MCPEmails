import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEVICE_STAMP_WINDOW_MS,
  shouldStampDeviceOnDashboard,
  stampAcquisitionDevice,
} from './acquisition-device-stamp.ts';
import { deviceClassFromHeaders } from './acquisition-device.mjs';

// Only reserved example data. Never a real customer's.

type Workspace = { id: string; owner_id: string; acquisition_device: string | null };

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

const NOW = Date.parse('2026-10-02T12:00:00Z');
const justNow = new Date(NOW - 5_000).toISOString();
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function workspaces(): Workspace[] {
  return [
    { id: 'ws-owner', owner_id: 'user-1', acquisition_device: null },
    // A workspace user-1 was invited to. Somebody else owns it.
    { id: 'ws-invited', owner_id: 'user-2', acquisition_device: null },
  ];
}

test('the class lands on the workspace the user owns, and only there', async () => {
  const rows = workspaces();
  const { db, state } = fakeDb(rows);
  await stampAcquisitionDevice(db, { ownerId: 'user-1', device: 'mobile' });
  assert.equal(state.statements, 1);
  assert.deepEqual(state.lastValues, { acquisition_device: 'mobile' });
  assert.equal(rows[0].acquisition_device, 'mobile');
  // An invited member's signup never describes the inviter's workspace.
  assert.equal(rows[1].acquisition_device, null);
});

test('first write wins: a value already there is never overwritten', async () => {
  const rows = workspaces();
  rows[0].acquisition_device = 'desktop';
  const { db, state } = fakeDb(rows);
  await stampAcquisitionDevice(db, { ownerId: 'user-1', device: 'mobile' });
  assert.equal(state.rowsChanged, 0);
  assert.equal(rows[0].acquisition_device, 'desktop');
});

test('a second stamp of the same signup changes nothing', async () => {
  const rows = workspaces();
  const { db, state } = fakeDb(rows);
  await stampAcquisitionDevice(db, { ownerId: 'user-1', device: 'tablet' });
  await stampAcquisitionDevice(db, { ownerId: 'user-1', device: 'desktop' });
  assert.equal(state.rowsChanged, 1);
  assert.equal(rows[0].acquisition_device, 'tablet');
});

test('an unknown class, or anything that is not one of the three words, is not written', async () => {
  for (const device of [null, undefined, '', 'Mobile', 'phone', 'unknown', IPHONE, "mobile'; --"]) {
    const rows = workspaces();
    const { db, state } = fakeDb(rows);
    await stampAcquisitionDevice(db, { ownerId: 'user-1', device });
    assert.equal(state.statements, 0, String(device));
    assert.equal(rows[0].acquisition_device, null);
  }
});

test('no owner writes nothing', async () => {
  for (const ownerId of [null, undefined, '']) {
    const { db, state } = fakeDb(workspaces());
    await stampAcquisitionDevice(db, { ownerId, device: 'mobile' });
    assert.equal(state.statements, 0);
  }
});

test('a failed write (for example the migration not applied yet) never throws', async () => {
  const { db } = fakeDb(workspaces(), { error: { message: 'column "acquisition_device" does not exist' } });
  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.doesNotReject(stampAcquisitionDevice(db, { ownerId: 'user-1', device: 'mobile' }));
    const throwing = { from() { throw new Error('boom'); } } as never;
    await assert.doesNotReject(stampAcquisitionDevice(throwing, { ownerId: 'user-1', device: 'mobile' }));
  } finally {
    console.error = originalError;
  }
});

/* ------------------------------------------------ the dashboard's gate */

test('the dashboard stamps a password account that is minutes old', () => {
  assert.equal(shouldStampDeviceOnDashboard({ provider: 'email', userCreatedAt: justNow }, NOW), true);
  assert.equal(shouldStampDeviceOnDashboard({ provider: 'email', userCreatedAt: NOW - DEVICE_STAMP_WINDOW_MS + 1 }, NOW), true);
  // Small clock skew between the auth server and this one.
  assert.equal(shouldStampDeviceOnDashboard({ provider: 'email', userCreatedAt: NOW + 60_000 }, NOW), true);
});

test('the dashboard leaves Google and GitHub signups to the callback', () => {
  for (const provider of ['google', 'github', undefined, null, '', 'Email', ['email']]) {
    assert.equal(shouldStampDeviceOnDashboard({ provider, userCreatedAt: justNow }, NOW), false, String(provider));
  }
});

test('a returning customer loading the dashboard is never stamped', () => {
  for (const userCreatedAt of [
    NOW - DEVICE_STAMP_WINDOW_MS,
    new Date(NOW - 24 * 60 * 60 * 1000).toISOString(),
    '2026-01-05T09:00:00Z',
    NOW + 10 * 60_000,
    'not a date',
    null,
    undefined,
  ]) {
    assert.equal(shouldStampDeviceOnDashboard({ provider: 'email', userCreatedAt }, NOW), false, String(userCreatedAt));
  }
});

// The dashboard's three lines, as it runs them: gate, classify the request's
// headers, write. The User-Agent goes in and only the word comes out.
async function dashboardRender(
  db: never,
  user: { id: string; created_at: string; app_metadata: { provider?: string } },
  headers: Headers,
) {
  if (shouldStampDeviceOnDashboard({ provider: user.app_metadata?.provider, userCreatedAt: user.created_at }, NOW)) {
    await stampAcquisitionDevice(db, { ownerId: user.id, device: deviceClassFromHeaders(headers) });
  }
}

test('password signup: the first dashboard render writes the class once, and never the User-Agent', async () => {
  const rows = workspaces();
  const { db, state } = fakeDb(rows);
  const user = { id: 'user-1', created_at: justNow, app_metadata: { provider: 'email' } };
  await dashboardRender(db, user, new Headers({ 'user-agent': IPHONE }));
  assert.equal(rows[0].acquisition_device, 'mobile');
  assert.equal(JSON.stringify(state.lastValues).includes('iPhone'), false);
  // The same person opening the dashboard on a laptop a minute later.
  await dashboardRender(db, user, new Headers({ 'user-agent': WINDOWS, 'sec-ch-ua-mobile': '?0' }));
  assert.equal(rows[0].acquisition_device, 'mobile');
  assert.equal(state.rowsChanged, 1);
});

test('password login by an existing account writes nothing at all', async () => {
  const rows = workspaces();
  const { db, state } = fakeDb(rows);
  const user = { id: 'user-1', created_at: '2026-08-01T10:00:00Z', app_metadata: { provider: 'email' } };
  await dashboardRender(db, user, new Headers({ 'user-agent': IPHONE }));
  assert.equal(state.statements, 0);
  assert.equal(rows[0].acquisition_device, null);
});

// The page itself is a server component and is not rendered here, so this
// pins that it still makes the three calls above: remove one and the password
// third of signups silently goes back to having no device.
test('the dashboard page gates, classifies its own request headers and writes after the response', () => {
  const page = readFileSync(
    fileURLToPath(new URL('../../app/dashboard/[[...section]]/page.js', import.meta.url)),
    'utf8',
  );
  assert.match(page, /if \(shouldStampDeviceOnDashboard\(\{ provider: user\.app_metadata\?\.provider, userCreatedAt: user\.created_at \}\)\) \{/);
  assert.match(page, /const device = deviceClassFromHeaders\(await headers\(\)\);/);
  assert.match(page, /after\(\(\) => stampAcquisitionDevice\(createServiceRoleClient\(\), \{ ownerId: user\.id, device \}\)\);/);
});
