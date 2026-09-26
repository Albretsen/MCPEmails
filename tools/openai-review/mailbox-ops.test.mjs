// Drives check() and reset() against an in-memory fake of the ImapFlow API,
// starting from a "dirty after a review" mailbox. No network.
//
//   node --test tools/openai-review/mailbox-ops.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';
import { buildFixtures, toRfc822 } from './fixtures.mjs';
import { check, reset, discover } from './mailbox-ops.mjs';

class FakeImap {
  constructor(folders) {
    this.folders = new Map();
    this.nextUid = 1;
    this.writes = [];
    this.mailbox = null;
    this.readOnly = false;
    for (const f of folders) this.addFolder(f);
  }
  addFolder({ path, specialUse, delimiter = '/' }) {
    const parts = path.split(delimiter);
    this.folders.set(path, {
      path, specialUse, delimiter,
      name: parts.at(-1),
      parentPath: parts.slice(0, -1).join(delimiter),
      messages: [],
    });
  }
  put(path, raw, flags = [], date = new Date()) {
    this.folders.get(path).messages.push({ uid: this.nextUid++, raw, flags: new Set(flags), internalDate: date });
  }
  async list() {
    return [...this.folders.values()].map(({ path, name, parentPath, specialUse, delimiter }) =>
      ({ path, name, parentPath, specialUse, delimiter, flags: new Set() }));
  }
  async getMailboxLock(path, opts = {}) {
    const f = this.folders.get(path);
    if (!f) throw new Error(`no such mailbox ${path}`);
    this.readOnly = !!opts.readOnly;
    this.mailbox = { path, exists: f.messages.length };
    return { release: () => { this.mailbox = null; } };
  }
  async *fetch() {
    for (const m of this.folders.get(this.mailbox.path).messages) {
      const p = await simpleParser(m.raw);
      yield {
        uid: m.uid,
        flags: m.flags,
        internalDate: m.internalDate,
        envelope: { messageId: p.messageId, subject: p.subject, date: p.date, from: p.from?.value ?? [] },
      };
    }
  }
  async messageDelete(range) {
    assert.ok(!this.readOnly, 'messageDelete on a read-only lock');
    assert.equal(range, '1:*');
    this.writes.push(['expunge', this.mailbox.path]);
    this.folders.get(this.mailbox.path).messages = [];
    return true;
  }
  async mailboxDelete(path) {
    const children = [...this.folders.keys()].filter((p) => p.startsWith(`${path}/`));
    assert.equal(children.length, 0, `deleting ${path} before its children`);
    this.writes.push(['delete', path]);
    this.folders.delete(path);
    return { path };
  }
  async mailboxCreate(path) {
    this.writes.push(['create', path]);
    this.addFolder({ path });
    return { path, created: true };
  }
  async mailboxSubscribe() { return true; }
  async append(path, raw, flags, date) {
    assert.ok(this.folders.has(path), `append to missing ${path}`);
    this.writes.push(['append', path]);
    this.put(path, raw, flags, date);
    return { destination: path };
  }
}

const quiet = () => {};
const junkMail = (subject) => `From: Reviewer <reviewer@openai-test.example>\r\nTo: demo@mcpemails.com\r\nSubject: ${subject}\r\nMessage-ID: <${subject.replace(/\W/g, '')}@reviewer.example>\r\nDate: Thu, 24 Sep 2026 10:00:00 +0000\r\n\r\nhello\r\n`;

/** A mailbox the way a previous review left it. */
function dirtyMigaduLike(fixtures) {
  const c = new FakeImap([
    { path: 'INBOX' },
    { path: 'Sent', specialUse: '\\Sent' },
    { path: 'Junk', specialUse: '\\Junk' },
    { path: 'Trash', specialUse: '\\Trash' },
    { path: 'Drafts', specialUse: '\\Drafts' },
    { path: 'Newsletters' },
    { path: 'Newsletters/Old' },
    // Note: no Archive folder at all.
  ]);
  for (const fx of fixtures) {
    const folder = fx.n === 7 ? 'Newsletters' : fx.folder === 'Archive' ? 'INBOX' : fx.folder;
    const seen = fx.n === 2 ? true : fx.seen; // a reviewer opened the reminder
    c.put(folder, toRfc822(fx), seen ? ['\\Seen'] : [], fx.date);
  }
  c.put('Sent', junkMail('Test from reviewer'), ['\\Seen']);
  c.put('Trash', junkMail('Deleted thing'), ['\\Seen']);
  c.put('Drafts', junkMail('Half written'), []);
  c.put('Newsletters/Old', junkMail('Old newsletter'), ['\\Seen']);
  return c;
}

test('check is read-only and reports every way a review dirtied the mailbox', async () => {
  const fixtures = buildFixtures();
  const c = dirtyMigaduLike(fixtures);
  const out = [];
  const code = await check(c, fixtures, (s) => out.push(s));
  assert.equal(code, 1);
  assert.deepEqual(c.writes, [], 'check must not write');
  const text = out.join('\n');
  assert.match(text, /missing archive folder/);
  assert.match(text, /user-created folder present: "Newsletters"/);
  assert.match(text, /user-created folder present: "Newsletters\/Old"/);
  assert.match(text, /fixture #2 .* is read, expected unread/);
  assert.match(text, /fixture #14 .* is in INBOX, expected Archive/);
  assert.match(text, /missing fixture #7 /);
  assert.match(text, /Sent: unexpected message .*Test from reviewer/);
  assert.match(text, /Trash: unexpected message/);
  assert.match(text, /Drafts: unexpected message/);
});

test('reset restores the exact fixture set, and a second check passes', async () => {
  const fixtures = buildFixtures();
  const c = dirtyMigaduLike(fixtures);
  await reset(c, fixtures, quiet);

  // Children deleted before parents, user folders gone, Archive created.
  const deletes = c.writes.filter((w) => w[0] === 'delete').map((w) => w[1]);
  assert.deepEqual(deletes, ['Newsletters/Old', 'Newsletters']);
  assert.ok(c.writes.some((w) => w[0] === 'create' && w[1] === 'Archive'));
  assert.equal(c.writes.filter((w) => w[0] === 'append').length, 19);

  const count = (p) => c.folders.get(p).messages.length;
  const unread = (p) => c.folders.get(p).messages.filter((m) => !m.flags.has('\\Seen')).length;
  assert.equal(count('INBOX'), 13);
  assert.equal(unread('INBOX'), 5);
  assert.equal(count('Archive'), 3);
  assert.equal(count('Sent'), 3);
  for (const p of ['Junk', 'Trash', 'Drafts']) assert.equal(count(p), 0, p);

  // Internal dates are the fixture dates.
  const inv = c.folders.get('INBOX').messages.find((m) => m.raw.includes('<fixture-01@'));
  assert.equal(inv.internalDate.getTime(), fixtures[0].date.getTime());

  c.writes = [];
  assert.equal(await check(c, fixtures, quiet), 0);
  assert.deepEqual(c.writes, []);

  // Idempotent: a second reset lands on the same state.
  await reset(c, fixtures, quiet);
  assert.equal(await check(c, fixtures, quiet), 0);
});

test('without special-use flags, system folders are found by name and never deleted', async () => {
  const c = new FakeImap([
    { path: 'INBOX' }, { path: 'Sent Messages' }, { path: 'Archive' }, { path: 'Spam' },
    { path: 'Deleted Messages' }, { path: 'Drafts' }, { path: 'Projects' },
  ]);
  const { roles, userFolders } = await discover(c);
  assert.deepEqual(roles, {
    sent: 'Sent Messages', archive: 'Archive', junk: 'Spam', trash: 'Deleted Messages', drafts: 'Drafts', inbox: 'INBOX',
  });
  assert.deepEqual(userFolders.map((f) => f.path), ['Projects']);

  const fixtures = buildFixtures();
  await reset(c, fixtures, quiet);
  assert.ok(!c.folders.has('Projects'));
  assert.equal(c.folders.get('Sent Messages').messages.length, 3);
  assert.equal(await check(c, fixtures, quiet), 0);
});
