#!/usr/bin/env node
/**
 * Put the demo mailbox's fixture mail back to a known state, so a transcript
 * recorded today sees the same inbox as one recorded last week.
 *
 *   npm run seed -- --yes            clear old fixtures, append fresh ones
 *   npm run seed -- --dry-run        report what would change, touch nothing
 *
 * Run it before every `npm run transcript`. A chat plan that searches for "the
 * overdue invoice" needs one to exist, dated today, and a plan that archives
 * mail needs it back in the inbox afterwards.
 *
 * THE SAME MAILBOX HOLDS THE OPENAI REVIEWER CORPUS (19 messages, including a
 * deliberate prompt-injection fixture) that the directory review test cases
 * depend on. This script must never disturb it. So it deletes exactly one
 * thing: in every folder, messages FROM one of the sender addresses listed in
 * fixtures/inbox.json, which are reserved for video fixtures and appear nowhere
 * in the reviewer corpus. Then it appends fresh copies, into their own folder
 * (fixtures/inbox.json "folder", "Demo"), because the review test cases also
 * check INBOX's exact count and unread count. Chat plans read that folder:
 * `"args": { "action": "list", "folder": "Demo" }`.
 *
 * Why FROM and not a marker header: Migadu's `SEARCH HEADER` returns nothing,
 * silently, even when matching mail exists. A header-based clear finds nothing
 * and every run doubles the fixtures. FROM, BODY and ALL work. The marker
 * header is still written, for a human reading the raw message.
 *
 * Guards, all in code:
 *   1. --yes, explicitly.
 *   2. DEMO_IMAP_USER is on a domain in DEMO_SAFE_INBOX_DOMAINS.
 *   3. DEMO_IMAP_USER equals DEMO_ACCOUNT_EMAIL: the mailbox seeded is the one
 *      the demo workspace has connected, not some other throwaway.
 *   4. Every fixture sender is on a `.example` domain, checked before connecting.
 *   5. No fixture sender is in RESERVED_SENDERS, the reviewer corpus's own.
 */

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { emit, fail, heading, log, parseArgs, paths, readJson, loadEnv } from './lib/common.mjs';
import { Imap } from './lib/imap.mjs';

loadEnv();
const args = parseArgs();
const DRY = Boolean(args['dry-run']);
const HEADER = 'X-Video-Studio-Fixture';

const host = process.env.DEMO_IMAP_HOST;
const user = (process.env.DEMO_IMAP_USER ?? '').trim();
const pass = process.env.DEMO_IMAP_PASS;
const account = (process.env.DEMO_ACCOUNT_EMAIL ?? '').trim().toLowerCase();
const safeDomains = (process.env.DEMO_SAFE_INBOX_DOMAINS ?? 'example')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

if (!host || !user || !pass) fail('seed', 'DEMO_IMAP_HOST, DEMO_IMAP_USER and DEMO_IMAP_PASS must be set in .env.');
if (!DRY && !args.yes) fail('seed', 'Guard 1: pass --yes. This deletes fixture mail in the demo mailbox and appends fresh copies.');

const domain = user.toLowerCase().split('@')[1] ?? '';
if (!safeDomains.some((d) => domain === d || domain.endsWith(`.${d}`))) {
  fail('seed', `Guard 2: ${user} is not on a domain in DEMO_SAFE_INBOX_DOMAINS (${safeDomains.join(', ')}).`);
}
if (user.toLowerCase() !== account) {
  fail('seed', `Guard 3: DEMO_IMAP_USER (${user}) is not DEMO_ACCOUNT_EMAIL (${account || 'unset'}). Seed only the mailbox the demo workspace films.`);
}

// --- Fixtures --------------------------------------------------------------

/** Senders in the reviewer corpus. Deleting by any of these would eat it. */
const RESERVED_SENDERS = [
  'billing-update@vendor-payments.example',
  'escalations@helpdesk.example',
  'nora.feldt@bergentek.example',
  'priya.raman@lumenworks.example',
  'jonas.vik@fjordlegal.example',
  'ingrid.saether@fjordlett.example',
  'news@devweekly.example',
  'sam.okafor@northwind-labs.example',
  'orders@deskgear.example',
  'elena.rossi@studiorossi.example',
  'bookings@railtrip.example',
  'marcus.chen@lumenworks.example',
  'hilde@brekkeregnskap.example',
];

const fixtureFile = resolve(paths.fixtures, 'inbox.json');
const fixtures = readJson(fixtureFile);
const ASCII = /^[\x20-\x7E]*$/;
for (const [i, m] of fixtures.messages.entries()) {
  const w = `fixtures/inbox.json message ${i}`;
  if (!/^[^@\s]+@[a-z0-9.-]+\.example$/i.test(m.from)) fail('seed', `Guard 4: ${w}: sender "${m.from}" is not on a .example domain.`);
  for (const k of ['fromName', 'subject']) {
    if (typeof m[k] !== 'string' || !ASCII.test(m[k])) fail('seed', `${w}: "${k}" must be printable ASCII (headers are not encoded).`);
  }
  if (typeof m.body !== 'string' || /—/.test(m.body + m.subject)) fail('seed', `${w}: "body" must be a string with no em dash.`);
  const strays = (m.body.match(/[^\s@]+@[^\s@]+/g) ?? []).filter((a) => !/\.example\b/i.test(a));
  if (strays.length) fail('seed', `${w}: body mentions ${strays.join(', ')}. Only .example addresses may appear.`);
  if (typeof m.ageHours !== 'number' || m.ageHours < 0) fail('seed', `${w}: "ageHours" must be a non-negative number.`);
  // FROM is a substring search, so a fixture sender that CONTAINS a reserved
  // one (or is contained by it) would match reviewer mail too.
  const clash = RESERVED_SENDERS.find((r) => r.includes(m.from.toLowerCase()) || m.from.toLowerCase().includes(r));
  if (clash) fail('seed', `Guard 5: ${w}: sender "${m.from}" overlaps the reviewer corpus sender "${clash}". Pick another address.`);
}
const senders = [...new Set(fixtures.messages.map((m) => m.from.toLowerCase()))];
// One search per folder, the senders OR-ed together. Migadu allows 60 searches
// a minute, and a search per sender per folder ran out of them in one run.
const fromAny = senders.reduceRight((acc, s, i) => (i === senders.length - 1 ? `FROM "${s}"` : `OR FROM "${s}" ${acc}`), '');
const FOLDER = fixtures.folder;
if (typeof FOLDER !== 'string' || !FOLDER || /^(inbox|archive|sent|drafts|junk|trash)$/i.test(FOLDER)) {
  fail('seed', 'fixtures/inbox.json "folder" must name a dedicated folder, not INBOX, Archive, Sent, Drafts, Junk or Trash, which hold the reviewer corpus.');
}

const now = Date.now();
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');

function rfc822(m, date) {
  const headers = [
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `From: "${m.fromName}" <${m.from}>`,
    `To: "${fixtures.recipientName ?? 'Demo'}" <${user}>`,
    `Subject: ${m.subject}`,
    `Message-ID: <${randomUUID()}@video-studio.example>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    `${HEADER}: 1`,
  ];
  return crlf(`${headers.join('\n')}\n\n${m.body}\n`);
}

// --- Mailbox ---------------------------------------------------------------

heading(`${DRY ? 'Dry run: ' : ''}seeding ${user}`);

const imap = new Imap({ host, user, pass });
const removed = {};
let appended = 0;
try {
  await imap.connect();
  const folders = await imap.list();
  if (!folders.some((f) => f.name === FOLDER)) {
    log(`  ${FOLDER}: ${DRY ? 'would create' : 'creating'} the folder`);
    if (!DRY) await imap.create(FOLDER);
  }

  for (const f of folders) {
    await imap.select(f.name);
    const uids = await imap.search(fromAny);
    if (uids.length === 0) continue;
    removed[f.name] = uids.length;
    log(`  ${f.name}: ${DRY ? 'would remove' : 'removing'} ${uids.length} fixture message(s)`);
    if (!DRY) await imap.deleteUids(uids);
  }

  // Oldest first, so the newest fixture gets the highest UID and lists first.
  const ordered = [...fixtures.messages].sort((a, b) => b.ageHours - a.ageHours);
  for (const m of ordered) {
    const date = new Date(now - m.ageHours * 3_600_000);
    if (!DRY) await imap.append(FOLDER, rfc822(m, date), { seen: Boolean(m.seen), date });
    appended++;
  }
  log(`  ${FOLDER}: ${DRY ? 'would append' : 'appended'} ${appended} fixture message(s)`);

  if (!DRY) {
    await imap.select(FOLDER);
    const all = await imap.search('ALL');
    const ours = (await imap.search(fromAny)).length;
    log(`  ${FOLDER} now holds ${all.length} message(s), ${ours} of them video fixtures`);
    if (ours !== fixtures.messages.length) {
      throw new Error(`expected ${fixtures.messages.length} video fixtures in ${FOLDER} after seeding, found ${ours}`);
    }
    await imap.select('INBOX');
    log(`  INBOX holds ${(await imap.search('ALL')).length} message(s), untouched (the reviewer corpus expects 13)`);
  }
} catch (e) {
  await imap.logout();
  fail('seed', `IMAP: ${e.message}`);
}
await imap.logout();

emit({ ok: true, script: 'seed', mailbox: user, dryRun: DRY, removed, appended });
