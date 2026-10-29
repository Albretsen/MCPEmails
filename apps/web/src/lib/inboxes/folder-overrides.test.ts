// ---------------------------------------------------------------------------
// Folder choice per inbox: the order of steps around the shared rules.
//
// The rules themselves (INBOX, duplicates, listing, the automatic pick) are
// pinned in supabase/functions/mcp-server/folder-overrides.test.ts; this file
// pins what the dashboard's routes do with them:
//   - load reports every pickable folder, the automatic pick and the user's
//     pick per role, and hides a pick the server no longer lists;
//   - a save is checked against a FRESH listing and the other roles, and
//     nothing is written when it is refused;
//   - clearing never dials the mail server;
//   - a missing column is 'unavailable', an unreachable server is one error.
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FOLDER_ERROR_STATUS,
  folderChoiceApplies,
  loadFolderSettings,
  saveFolderOverride,
  type FolderDeps,
  type FolderOverrides,
  type MailboxListEntry,
  type StoredOverrides,
} from './folder-overrides.ts';

const OVH: MailboxListEntry[] = [
  { name: 'INBOX', delimiter: '.', flags: [] },
  { name: 'INBOX.Éléments envoyés', delimiter: '.', flags: [] },
  { name: 'INBOX.INBOX.Sent', delimiter: '.', flags: [] },
  { name: 'INBOX.Brouillons', delimiter: '.', flags: [] },
  { name: 'INBOX.Corbeille', delimiter: '.', flags: [] },
];

function world(opts: { stored?: StoredOverrides; mailboxes?: MailboxListEntry[] | Error } = {}) {
  const state = {
    lists: 0,
    writes: [] as Array<FolderOverrides | null>,
    stored: opts.stored ?? ({ ok: true, raw: null } as StoredOverrides),
  };
  const deps: FolderDeps = {
    listMailboxes: async () => {
      state.lists += 1;
      if (opts.mailboxes instanceof Error) throw opts.mailboxes;
      return opts.mailboxes ?? OVH;
    },
    readOverrides: async () => state.stored,
    writeOverrides: async (next) => {
      state.writes.push(next);
      state.stored = { ok: true, raw: next };
    },
  };
  return { deps, state };
}

test('applies to password IMAP inboxes on implicit TLS only', () => {
  const imap = { provider: 'imap', imap_host: 'imap.example', imap_security: 'tls', imap_password: 'ct', oauth_access_token: null };
  assert.equal(folderChoiceApplies(imap), true);
  assert.equal(folderChoiceApplies({ ...imap, imap_security: null }), true, 'legacy rows default to TLS');
  assert.equal(folderChoiceApplies({ ...imap, imap_security: 'starttls' }), false);
  assert.equal(folderChoiceApplies({ ...imap, provider: 'gmail', imap_host: null, imap_password: null, oauth_access_token: 'ct' }), false);
  assert.equal(folderChoiceApplies({ ...imap, imap_host: null }), false, 'send-only');
});

test('load: folders without INBOX, automatic picks, no picks yet', async () => {
  const { deps } = world();
  const result = await loadFolderSettings(deps);
  assert.ok(result.ok);
  assert.deepEqual(result.value.folders, ['INBOX.Éléments envoyés', 'INBOX.INBOX.Sent', 'INBOX.Brouillons', 'INBOX.Corbeille']);
  const byRole = Object.fromEntries(result.value.roles.map((r) => [r.role, r]));
  assert.deepEqual(Object.keys(byRole), ['sent', 'drafts', 'trash', 'spam', 'archive']);
  assert.equal(byRole.drafts.automatic, 'INBOX.Brouillons');
  assert.equal(byRole.trash.automatic, 'INBOX.Corbeille');
  assert.equal(byRole.archive.automatic, null);
  assert.ok(result.value.roles.every((r) => r.override === null));
});

test('load: a stored pick shows; one the server no longer lists does not', async () => {
  const { deps } = world({ stored: { ok: true, raw: { sent: 'INBOX.Éléments envoyés', trash: 'Deleted long ago' } } });
  const result = await loadFolderSettings(deps);
  assert.ok(result.ok);
  const byRole = Object.fromEntries(result.value.roles.map((r) => [r.role, r]));
  assert.equal(byRole.sent.override, 'INBOX.Éléments envoyés');
  assert.equal(byRole.trash.override, null, 'automatic is what the server uses for it');
});

test('load: missing column is unavailable, an unreachable server is folders_unreachable', async () => {
  const missing = await loadFolderSettings(world({ stored: { ok: false, unavailable: true } }).deps);
  assert.deepEqual(missing, { ok: false, error: 'unavailable' });
  assert.equal(FOLDER_ERROR_STATUS.unavailable, 503);
  const down = await loadFolderSettings(world({ mailboxes: new Error('ETIMEDOUT') }).deps);
  assert.deepEqual(down, { ok: false, error: 'folders_unreachable' });
});

test('save: a listed folder is stored, merged with the other roles', async () => {
  const { deps, state } = world({ stored: { ok: true, raw: { drafts: 'INBOX.Brouillons' } } });
  const result = await saveFolderOverride(deps, 'sent', 'INBOX.Éléments envoyés');
  assert.deepEqual(result, { ok: true, value: { overrides: { drafts: 'INBOX.Brouillons', sent: 'INBOX.Éléments envoyés' } } });
  assert.deepEqual(state.writes, [{ drafts: 'INBOX.Brouillons', sent: 'INBOX.Éléments envoyés' }]);
  assert.equal(state.lists, 1, 'checked against a fresh listing');
});

test('save: refusals write nothing', async () => {
  const cases: Array<[string, string, string]> = [
    ['trash', 'INBOX', 'inbox_not_allowed'],
    ['sent', 'INBOX.Sent', 'not_listed'],
    ['trash', 'INBOX.Brouillons', 'used_by_other_role'],
  ];
  for (const [role, folder, error] of cases) {
    const { deps, state } = world({ stored: { ok: true, raw: { drafts: 'INBOX.Brouillons' } } });
    const result = await saveFolderOverride(deps, role as 'sent', folder);
    assert.deepEqual(result, { ok: false, error }, `${role} -> ${folder}`);
    assert.equal(state.writes.length, 0);
  }
});

test('save: clearing never dials the mail server, and the last clear stores null', async () => {
  const { deps, state } = world({ stored: { ok: true, raw: { sent: 'INBOX.Éléments envoyés' } }, mailboxes: new Error('down') });
  const result = await saveFolderOverride(deps, 'sent', null);
  assert.deepEqual(result, { ok: true, value: { overrides: {} } });
  assert.deepEqual(state.writes, [null]);
  assert.equal(state.lists, 0);
});

test('save: an unreachable server refuses a pick without writing', async () => {
  const { deps, state } = world({ mailboxes: new Error('down') });
  assert.deepEqual(await saveFolderOverride(deps, 'sent', 'INBOX.Éléments envoyés'), { ok: false, error: 'folders_unreachable' });
  assert.equal(state.writes.length, 0);
});

test('save: a failed write is save_failed', async () => {
  const { deps } = world();
  deps.writeOverrides = async () => {
    throw new Error('23514');
  };
  assert.deepEqual(await saveFolderOverride(deps, 'sent', 'INBOX.Éléments envoyés'), { ok: false, error: 'save_failed' });
});
