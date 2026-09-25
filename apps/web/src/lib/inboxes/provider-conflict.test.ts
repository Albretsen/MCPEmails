import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  findOtherProviderInbox,
  INBOX_EXISTS_OTHER_PROVIDER,
  isOtherProviderConflict,
  otherProviderErrorBody,
  providerFamily,
} from './provider-conflict.ts';

const webRoot = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel: string) => readFileSync(webRoot + rel, 'utf8');

// ─── the rule ────────────────────────────────────────────────────────────────

test('Outlook over an active IMAP inbox is a conflict (the 2026-09-25 incident)', () => {
  assert.equal(isOtherProviderConflict('imap', 'outlook'), true);
});

test('every cross-provider overwrite is refused, in both directions', () => {
  for (const [existing, incoming] of [
    ['imap', 'gmail'], ['gmail', 'imap'], ['outlook', 'imap'], ['gmail', 'outlook'], ['outlook', 'gmail'],
  ]) {
    assert.equal(isOtherProviderConflict(existing, incoming!), true, `${existing} -> ${incoming}`);
  }
});

test('same-provider reconnects keep working', () => {
  assert.equal(isOtherProviderConflict('outlook', 'outlook'), false);
  assert.equal(isOtherProviderConflict('gmail', 'gmail'), false);
  assert.equal(isOtherProviderConflict('imap', 'imap'), false);
});

test('no active row (never connected, or removed) is never a conflict', () => {
  assert.equal(isOtherProviderConflict(null, 'outlook'), false);
  assert.equal(isOtherProviderConflict(undefined, 'imap'), false);
});

test('a retired Fastmail OAuth row can still be repaired by the app-password route', () => {
  assert.equal(providerFamily('fastmail'), 'imap');
  assert.equal(isOtherProviderConflict('fastmail', 'imap'), false);
  assert.equal(isOtherProviderConflict('fastmail', 'outlook'), true);
});

test('the JSON refusal carries the stable code', () => {
  const body = otherProviderErrorBody('outlook');
  assert.equal(body.error_code, INBOX_EXISTS_OTHER_PROVIDER);
  assert.equal(body.existing_provider, 'outlook');
  assert.match(body.error, /Remove that inbox first/);
});

// ─── the query ───────────────────────────────────────────────────────────────

function fakeDb(row: { provider: string } | null) {
  const filters: [string, string, unknown][] = [];
  const builder = {
    select: () => builder,
    eq: (col: string, val: unknown) => (filters.push(['eq', col, val]), builder),
    is: (col: string, val: unknown) => (filters.push(['is', col, val]), builder),
    maybeSingle: async () => ({ data: row, error: null }),
  };
  const db = { from: (table: string) => (filters.push(['from', table, null]), builder) };
  return { db: db as unknown as Parameters<typeof findOtherProviderInbox>[0], filters };
}

test('the lookup reads the exact row the upsert would hit: workspace + address, not deleted', async () => {
  const { db, filters } = fakeDb({ provider: 'imap' });
  const result = await findOtherProviderInbox(db, 'ws-1', 'asgeir@mcpemails.com', 'outlook');
  assert.deepEqual(result, { conflict: true, existingProvider: 'imap' });
  assert.deepEqual(filters, [
    ['from', 'inboxes', null],
    ['eq', 'workspace_id', 'ws-1'],
    ['eq', 'email_address', 'asgeir@mcpemails.com'],
    ['is', 'deleted_at', null],
  ]);
});

test('the lookup lets a same-provider reconnect and a fresh address through', async () => {
  assert.deepEqual(await findOtherProviderInbox(fakeDb({ provider: 'outlook' }).db, 'ws', 'a@b.co', 'outlook'), { conflict: false });
  assert.deepEqual(await findOtherProviderInbox(fakeDb(null).db, 'ws', 'a@b.co', 'outlook'), { conflict: false });
});

// ─── wiring: every connect path checks BEFORE it upserts ─────────────────────

const ROUTES: [string, string][] = [
  ['app/auth/outlook/callback/route.ts', "'outlook'"],
  ['app/auth/gmail/callback/route.ts', "'gmail'"],
  ['app/api/inboxes/imap/route.ts', "'imap'"],
  ['app/api/inboxes/app-password/route.ts', "'imap'"],
  ['app/api/inboxes/fastmail-app-password/route.ts', "'imap'"],
];

for (const [route, provider] of ROUTES) {
  test(`${route} refuses another provider's inbox before its upsert`, () => {
    const src = read(route);
    const check = src.indexOf('await findOtherProviderInbox(');
    const upsert = src.indexOf(".from('inboxes').upsert(");
    assert.ok(check !== -1, 'the check is present');
    assert.ok(upsert !== -1, 'the upsert is where we expect it');
    assert.ok(check < upsert, 'the check runs before the upsert');
    assert.ok(src.slice(check, check + 200).includes(`, ${provider})`), `checks as ${provider}`);
    assert.match(src, /errorCategory: 'conflict'/, 'the refusal is recorded in the funnel');
  });
}

// ─── the dashboard says something for both new codes, in every locale ────────

test('the dashboard toasts both new callback codes and the modal names the 409', () => {
  const app = read('components/dashboard/App.jsx');
  assert.match(app, /errorParam === 'inbox_exists_other_provider'[\s\S]{0,600}tr\('app\.inboxExistsOtherProvider'\)/);
  assert.match(app, /errorParam === 'outlook_no_mailbox'[\s\S]{0,600}tr\('app\.outlookNoMailbox'\)/);
  const modal = read('components/dashboard/ConnectModal.jsx');
  assert.match(modal, /inbox_exists_other_provider: 'connect\.errorInboxOtherProviderShort'/);
  assert.match(read('app/auth/outlook/callback/route.ts'), /redirectWithError\('outlook_no_mailbox'\)/);
});

for (const locale of ['en', 'es', 'fr', 'nb', 'zh']) {
  test(`${locale}: the new strings exist and are not empty`, () => {
    const messages = JSON.parse(read(`messages/${locale}/dashboardChrome.json`));
    for (const key of ['inboxExistsOtherProvider', 'outlookNoMailbox']) {
      assert.ok(typeof messages.app?.[key] === 'string' && messages.app[key].length > 20, `app.${key}`);
    }
    assert.ok(typeof messages.connect?.errorInboxOtherProviderShort === 'string', 'connect.errorInboxOtherProviderShort');
    assert.match(messages.app.outlookNoMailbox, /IMAP/);
  });
}
