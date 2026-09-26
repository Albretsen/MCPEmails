// IMAP operations for seed-demo-mailbox.mjs, split out so the unit test can
// drive them against an in-memory fake client. `client` is an ImapFlow
// instance (or anything with the same list/getMailboxLock/fetch/
// messageDelete/mailboxDelete/mailboxCreate/append surface).

import { toRfc822 } from './fixtures.mjs';

export const ROLE_BY_SPECIAL_USE = {
  '\\Sent': 'sent', '\\Archive': 'archive', '\\Junk': 'junk', '\\Trash': 'trash', '\\Drafts': 'drafts',
  '\\All': 'all', '\\Flagged': 'flagged', '\\Important': 'important',
};
const ROLE_BY_NAME = [
  ['sent', /^(sent|sent messages|sent items|sent mail)$/i],
  ['archive', /^(archive|archives)$/i],
  ['junk', /^(junk|spam|junk e-?mail|bulk mail)$/i],
  ['trash', /^(trash|deleted messages|deleted items|bin)$/i],
  ['drafts', /^drafts?$/i],
];

/** Map the server's folder list to roles. Special-use flags win over names. */
export async function discover(client) {
  const list = await client.list();
  const roles = {}; // role -> path
  const system = new Set(['INBOX']);
  for (const m of list) {
    const role = ROLE_BY_SPECIAL_USE[m.specialUse];
    if (role) { roles[role] ??= m.path; system.add(m.path); }
  }
  for (const m of list) {
    if (m.path.toUpperCase() === 'INBOX' || system.has(m.path)) continue;
    // Name fallback only for top-level folders (or INBOX children on INBOX.-style servers).
    const parent = m.parentPath ?? '';
    if (parent && parent.toUpperCase() !== 'INBOX') continue;
    for (const [role, re] of ROLE_BY_NAME) {
      if (re.test(m.name) && !roles[role]) { roles[role] = m.path; system.add(m.path); break; }
    }
  }
  const inbox = list.find((m) => m.path.toUpperCase() === 'INBOX')?.path ?? 'INBOX';
  roles.inbox = inbox;
  system.add(inbox);
  const userFolders = list
    .filter((m) => !system.has(m.path))
    .sort((a, b) => b.path.length - a.path.length); // children before parents
  return { list, roles, userFolders };
}

export async function readFolder(client, path) {
  const lock = await client.getMailboxLock(path, { readOnly: true });
  try {
    const msgs = [];
    if (client.mailbox.exists === 0) return msgs;
    for await (const m of client.fetch('1:*', { uid: true, envelope: true, flags: true, internalDate: true })) {
      msgs.push({
        uid: m.uid,
        messageId: m.envelope?.messageId || '(no Message-ID)',
        subject: m.envelope?.subject ?? '',
        from: (m.envelope?.from ?? []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', '),
        date: m.envelope?.date ?? m.internalDate,
        internalDate: m.internalDate,
        seen: m.flags?.has('\\Seen') ?? false,
      });
    }
    return msgs;
  } finally {
    lock.release();
  }
}

const FIXTURE_FOLDER_ROLE = { INBOX: 'inbox', Archive: 'archive', Sent: 'sent' };

/** Read-only comparison. Returns 0 if the mailbox matches, 1 if not. */
export async function check(client, fixtures, log = console.log) {
  const { roles, userFolders } = await discover(client);
  const diffs = [];

  log('\nFolders: ' + Object.entries(roles).map(([r, p]) => `${r}=${JSON.stringify(p)}`).join(', '));
  for (const role of ['archive', 'sent']) {
    if (!roles[role]) diffs.push(`missing ${role} folder`);
  }
  for (const f of userFolders) diffs.push(`user-created folder present: ${JSON.stringify(f.path)}`);

  const expectedById = new Map(fixtures.map((x) => [x.messageId, x]));
  const seenIds = new Set();

  for (const role of ['inbox', 'archive', 'sent', 'junk', 'trash', 'drafts']) {
    const path = roles[role];
    if (!path) continue;
    const msgs = await readFolder(client, path);
    const unread = msgs.filter((m) => !m.seen).length;
    log(`\n== ${path} (${role}): ${msgs.length} messages, ${unread} unread ==`);
    for (const m of msgs.sort((a, b) => new Date(a.date) - new Date(b.date))) {
      const d = m.date ? new Date(m.date).toISOString().slice(0, 16).replace('T', ' ') : '?';
      log(`  ${m.seen ? '    ' : 'NEW '} ${d}  ${m.from}  |  ${m.subject}`);

      const fx = expectedById.get(m.messageId);
      if (!fx) { diffs.push(`${path}: unexpected message ${m.messageId} "${m.subject}"`); continue; }
      if (seenIds.has(m.messageId)) diffs.push(`${path}: duplicate of fixture #${fx.n} "${fx.subject}"`);
      seenIds.add(m.messageId);
      if (roles[FIXTURE_FOLDER_ROLE[fx.folder]] !== path) diffs.push(`fixture #${fx.n} "${fx.subject}" is in ${path}, expected ${fx.folder}`);
      if (fx.seen !== m.seen) diffs.push(`fixture #${fx.n} "${fx.subject}" is ${m.seen ? 'read' : 'unread'}, expected ${fx.seen ? 'read' : 'unread'}`);
      if (m.subject !== fx.subject) diffs.push(`fixture #${fx.n} subject is "${m.subject}", expected "${fx.subject}"`);
    }
  }
  for (const fx of fixtures) {
    if (!seenIds.has(fx.messageId)) diffs.push(`missing fixture #${fx.n} (${fx.folder}) "${fx.subject}"`);
  }

  if (diffs.length === 0) {
    log(`\nOK: mailbox matches the ${fixtures.length} fixtures (dates are relative to the last seed and are not compared).`);
    return 0;
  }
  log(`\nDIFFERS from the fixtures (${diffs.length}):`);
  for (const d of diffs) log(`  - ${d}`);
  return 1;
}

async function emptyFolder(client, path) {
  const lock = await client.getMailboxLock(path);
  try {
    const n = client.mailbox.exists;
    if (n > 0) await client.messageDelete('1:*'); // \Deleted + EXPUNGE
    return n;
  } finally {
    lock.release();
  }
}

export async function reset(client, fixtures, log = console.log) {
  const { roles, userFolders } = await discover(client);
  log('\nFolders: ' + Object.entries(roles).map(([r, p]) => `${r}=${JSON.stringify(p)}`).join(', '));

  // 1. User-created folders: print, then delete (children first).
  if (userFolders.length) {
    log('\nUser-created folders to DELETE (with all their messages):');
    for (const f of userFolders) log(`  - ${f.path}`);
    for (const f of userFolders) {
      await client.mailboxDelete(f.path);
      log(`  deleted ${f.path}`);
    }
  } else {
    log('\nNo user-created folders.');
  }

  // 2. Empty every system folder we manage.
  log('\nEmptying system folders:');
  for (const role of ['inbox', 'archive', 'sent', 'junk', 'trash', 'drafts']) {
    const path = roles[role];
    if (!path) continue;
    const n = await emptyFolder(client, path);
    log(`  ${path}: deleted ${n} message(s)`);
  }

  // 3. Make sure Archive and Sent exist.
  for (const [role, name] of [['archive', 'Archive'], ['sent', 'Sent']]) {
    if (!roles[role]) {
      log(`\nNo ${role} folder on the server; creating "${name}".`);
      const res = await client.mailboxCreate(name);
      roles[role] = res.path;
      try { await client.mailboxSubscribe(res.path); } catch { /* optional */ }
    }
  }

  // 4. Append fixtures in chronological order so UIDs follow dates.
  log(`\nAppending ${fixtures.length} fixtures:`);
  for (const fx of [...fixtures].sort((a, b) => a.date - b.date)) {
    const path = roles[FIXTURE_FOLDER_ROLE[fx.folder]];
    await client.append(path, toRfc822(fx), fx.seen ? ['\\Seen'] : [], fx.date);
    log(`  #${String(fx.n).padStart(2)} -> ${path}${fx.seen ? '' : ' (unread)'}  ${fx.subject}`);
  }
}
