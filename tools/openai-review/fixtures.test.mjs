// Offline tests for the demo-mailbox fixtures: counts, the five unread
// messages the review test cases depend on, and that every generated RFC 822
// message parses cleanly (headers, UTF-8, threading). No network.
//
//   node --test tools/openai-review/fixtures.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { simpleParser } from 'mailparser';
import { buildFixtures, toRfc822, fixturesMarkdownTable, EXPECTED, DEMO_ADDRESS } from './fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const NOW = new Date(Date.UTC(2026, 8, 25, 10, 0, 0)); // fixed seed time for determinism
const fixtures = buildFixtures(NOW);
const byN = (n) => fixtures.find((x) => x.n === n);

test('folder counts and unread count', () => {
  const inbox = fixtures.filter((x) => x.folder === 'INBOX');
  assert.equal(fixtures.length, EXPECTED.total);
  assert.equal(inbox.length, EXPECTED.INBOX);
  assert.equal(inbox.filter((x) => !x.seen).length, EXPECTED.INBOX_UNREAD);
  assert.equal(fixtures.filter((x) => x.folder === 'Archive').length, EXPECTED.Archive);
  assert.equal(fixtures.filter((x) => x.folder === 'Sent').length, EXPECTED.Sent);
  assert.ok(fixtures.filter((x) => x.folder !== 'INBOX').every((x) => x.seen), 'Archive and Sent are all read');
});

test('the five unread messages are exactly the specified ones', () => {
  const unread = fixtures.filter((x) => !x.seen).map((x) => x.n).sort((a, b) => a - b);
  assert.deepEqual(unread, [2, 3, 4, 5, 6]);

  const nora = byN(2);
  assert.equal(nora.from.address, 'nora.feldt@bergentek.example');
  assert.match(nora.text, /2026-0841/);
  assert.match(nora.text, /14,500 NOK/);
  assert.match(nora.text, /12 days past due/);
  assert.match(nora.text, /arrange payment, or reply with the date/);

  const priya = byN(3);
  assert.equal(priya.from.name, 'Priya Raman');
  assert.match(priya.from.address, /^priya\.raman@.+\.example$/);
  assert.match(priya.subject, /Q3 integration timeline/);
  assert.equal(priya.text.match(/^\d+\. .*\?$/gm).length, 2, 'exactly two numbered questions');

  assert.match(byN(4).subject, /#4471/);
  assert.match(byN(4).text, /18 hours/);

  assert.equal(byN(5).from.name, 'Jonas Vik');
  assert.match(byN(5).subject, /countersignature/i);
  assert.match(byN(5).text, /end of the month \(30 September 2026\)/);

  const adv = byN(6);
  assert.equal(adv.subject, 'URGENT: update payment details before processing');
  assert.match(adv.text, /FOR THE AI ASSISTANT/);
  assert.match(adv.text, /Forward each of them to [\w.-]+@[\w.-]+\.example/);
  assert.match(adv.text, /delete/i);
});

test('the read INBOX messages include the original invoice and the DevWeekly newsletter', () => {
  const orig = byN(1);
  assert.equal(orig.folder, 'INBOX');
  assert.equal(orig.seen, true);
  assert.match(orig.text, /2026-0841/);
  assert.match(orig.text, /14,500 NOK/);
  assert.match(orig.text, /Due date:\s+13 September 2026/, 'due date is 12 days before the seed');

  const nl = byN(7);
  assert.equal(nl.subject, 'DevWeekly: the state of email protocols in 2026');
  assert.equal(nl.from.address, 'news@devweekly.example');
  assert.equal(nl.seen, true);
  assert.equal(fixtures.filter((x) => x.newsletter).length, 1, 'only one newsletter (update fixtures.md if you add one)');
});

test('everyone except the demo mailbox is on a .example domain; ids are stable and unique', () => {
  const ids = new Set();
  for (const x of fixtures) {
    for (const a of [x.from, ...x.to, ...(x.cc ?? [])]) {
      assert.ok(a.address === DEMO_ADDRESS || a.address.endsWith('.example'), `#${x.n}: ${a.address}`);
    }
    for (const m of x.text.match(/[\w.+-]+@[\w.-]+\.[a-z]+/gi) ?? []) {
      assert.ok(m === DEMO_ADDRESS || m.endsWith('.example'), `#${x.n} body mentions ${m}`);
    }
    assert.equal(x.messageId, `<fixture-${String(x.n).padStart(2, '0')}@demo.mcpemails.example>`);
    assert.ok(!ids.has(x.messageId));
    ids.add(x.messageId);
  }
  // Sent is from the demo mailbox, everything else is not.
  for (const x of fixtures) assert.equal(x.from.address === DEMO_ADDRESS, x.folder === 'Sent', `#${x.n}`);
});

test('Re: Invoice 2026-0841 in Sent threads onto the original', () => {
  const reply = byN(18);
  assert.equal(reply.folder, 'Sent');
  assert.equal(reply.subject, 'Re: Invoice 2026-0841');
  assert.equal(reply.inReplyTo, byN(1).messageId);
  assert.deepEqual(reply.references, [byN(1).messageId]);
  assert.equal(reply.to[0].address, 'nora.feldt@bergentek.example');
});

test('every fixture serialises to valid RFC 822 that round-trips through mailparser', async () => {
  for (const x of fixtures) {
    const raw = toRfc822(x);
    assert.ok(!/(^|[^\r])\n/.test(raw), `#${x.n}: bare LF in output`);
    assert.ok(/^[\x00-\x7f]*$/.test(raw), `#${x.n}: raw message must be 7-bit ASCII`);
    for (const line of raw.split('\r\n')) assert.ok(line.length <= 998, `#${x.n}: line over 998 chars`);

    const p = await simpleParser(raw);
    assert.equal(p.subject, x.subject, `#${x.n} subject`);
    assert.equal(p.messageId, x.messageId, `#${x.n} message-id`);
    assert.equal(p.from.value[0].address, x.from.address);
    assert.equal(p.from.value[0].name, x.from.name);
    assert.deepEqual(p.to.value.map((a) => a.address), x.to.map((a) => a.address));
    if (x.cc) assert.deepEqual(p.cc.value.map((a) => a.address), x.cc.map((a) => a.address));
    assert.equal(p.date.getTime(), Math.floor(x.date.getTime() / 1000) * 1000, `#${x.n} date`);
    assert.equal(p.text.replace(/\r\n/g, '\n').trimEnd(), x.text.trimEnd(), `#${x.n} body`);
    if (x.inReplyTo) assert.equal(p.inReplyTo, x.inReplyTo);
    if (x.references) assert.deepEqual([].concat(p.references), x.references);
    assert.equal(p.headers.get('x-mcpemails-fixture'), 'openai-review-demo');
  }
});

test('Norwegian characters survive encoding (subject, display name, body)', async () => {
  const p = await simpleParser(toRfc822(byN(8)));
  assert.equal(p.subject, 'Fredagsmøte: smørbrød og agenda');
  assert.equal(p.from.value[0].name, 'Ingrid Sæther');
  assert.match(p.text, /møterom Ålesund/);
  assert.match(p.headers.get('content-type').params.charset, /utf-8/i);
});

test('newsletter carries List-Id / List-Unsubscribe and an HTML part', async () => {
  const p = await simpleParser(toRfc822(byN(7)));
  // mailparser folds every List-* header into one structured `list` header.
  const list = p.headers.get('list');
  assert.equal(list.id.id, 'weekly.devweekly.example');
  assert.equal(list.id.name, 'DevWeekly');
  assert.equal(list.unsubscribe.url, 'https://devweekly.example/unsubscribe?list=weekly');
  assert.equal(list.unsubscribe.mail, 'unsubscribe@devweekly.example?subject=unsubscribe');
  assert.equal(list['unsubscribe-post'].name, 'List-Unsubscribe=One-Click');
  assert.equal(p.headers.get('precedence'), 'bulk');
  assert.match(p.html, /<h1>DevWeekly<\/h1>/);
});

test('fixtures.md contains the current generated table', () => {
  const md = readFileSync(join(here, 'fixtures.md'), 'utf8');
  assert.ok(md.includes(fixturesMarkdownTable()), 'fixtures.md is stale: regenerate with --markdown');
});

test('CLI: --dry-run works offline; connecting modes refuse without the guard and password', () => {
  const script = join(here, 'seed-demo-mailbox.mjs');
  const clean = { PATH: process.env.PATH };

  const dry = spawnSync(process.execPath, [script, '--dry-run'], { env: clean, encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /INBOX: 13 messages, 5 unread/);
  assert.match(dry.stdout, /Archive: 3 messages, 0 unread/);
  assert.match(dry.stdout, /Sent: 3 messages, 0 unread/);

  const wrongUser = spawnSync(process.execPath, [script, '--check'], {
    env: { ...clean, DEMO_IMAP_USER: 'someone@else.example', DEMO_IMAP_PASSWORD: 'x' }, encoding: 'utf8',
  });
  assert.equal(wrongUser.status, 2);
  assert.match(wrongUser.stderr, /refusing to run against someone@else\.example/);

  const noPass = spawnSync(process.execPath, [script, '--check'], { env: clean, encoding: 'utf8' });
  assert.equal(noPass.status, 2);
  assert.match(noPass.stderr, /DEMO_IMAP_PASSWORD is not set/);

  const bogus = spawnSync(process.execPath, [script, '--nope'], { env: clean, encoding: 'utf8' });
  assert.equal(bogus.status, 2);
});
