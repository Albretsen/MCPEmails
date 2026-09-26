#!/usr/bin/env node
// Reset the OpenAI app-review demo mailbox (demo@mcpemails.com) to a known
// fixture set. DESTRUCTIVE: in reset mode it deletes every message in the
// system folders and every user-created folder. See README.md.
//
//   node tools/openai-review/seed-demo-mailbox.mjs --dry-run   # no network
//   DEMO_IMAP_PASSWORD=... node tools/openai-review/seed-demo-mailbox.mjs --check
//   DEMO_IMAP_PASSWORD=... node tools/openai-review/seed-demo-mailbox.mjs
//
// Exit codes: 0 = mailbox matches the fixtures (or dry-run ok),
//             1 = mailbox differs from the fixtures,
//             2 = usage / connection / safety error.

import { buildFixtures, toRfc822, fixturesMarkdownTable, formatRfc5322Date, EXPECTED, DEMO_ADDRESS } from './fixtures.mjs';
import { check, reset } from './mailbox-ops.mjs';

const OVERRIDE_FLAG = '--i-know-this-is-not-the-demo-mailbox';
const KNOWN_FLAGS = new Set(['--dry-run', '--check', '--markdown', '--print-mime', '--help', '-h', OVERRIDE_FLAG]);

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('-')));
for (const f of flags) {
  if (!KNOWN_FLAGS.has(f)) die(`Unknown option ${f}. Try --help.`);
}

if (flags.has('--help') || flags.has('-h')) {
  console.log(`Usage: node seed-demo-mailbox.mjs [--dry-run | --check | --markdown | --print-mime N] [${OVERRIDE_FLAG}]

  (no flag)     RESET the mailbox: delete user folders, empty system folders, append the ${EXPECTED.total} fixtures
  --dry-run     print the plan and the fixtures; does not connect, needs no password
  --check       connect read-only, print each folder, diff against the fixtures (exit 1 if different)
  --markdown    print the fixture table used in fixtures.md
  --print-mime N  print the raw RFC 822 source of fixture N (no network)

Environment:
  DEMO_IMAP_USER       default ${DEMO_ADDRESS}
  DEMO_IMAP_PASSWORD   required for --check and reset; read from the environment only
  DEMO_IMAP_HOST       default imap.migadu.com
  DEMO_IMAP_PORT       default 993 (implicit TLS)
  DEMO_IMAP_SECURE     default true; set to "false" only for a local test server`);
  process.exit(0);
}

const config = {
  user: process.env.DEMO_IMAP_USER || DEMO_ADDRESS,
  host: process.env.DEMO_IMAP_HOST || 'imap.migadu.com',
  port: Number(process.env.DEMO_IMAP_PORT || 993),
  secure: (process.env.DEMO_IMAP_SECURE ?? 'true').toLowerCase() !== 'false',
};

function die(msg, code = 2) {
  console.error(`seed-demo-mailbox: ${msg}`);
  process.exit(code);
}

// ------------------------------------------------------------ offline modes

const now = new Date();
const fixtures = buildFixtures(now);

if (flags.has('--markdown')) {
  console.log(fixturesMarkdownTable());
  process.exit(0);
}

if (flags.has('--print-mime')) {
  const n = Number(argv[argv.indexOf('--print-mime') + 1]);
  const fx = fixtures.find((x) => x.n === n);
  if (!fx) die(`--print-mime needs a fixture number 1..${fixtures.length}`);
  process.stdout.write(toRfc822(fx));
  process.exit(0);
}

if (flags.has('--dry-run')) {
  printPlanHeader('DRY RUN (no connection will be made)');
  console.log(`Password in environment: ${process.env.DEMO_IMAP_PASSWORD ? 'yes' : 'no'} (not needed for --dry-run)`);
  console.log(`Safety guard: ${isDemoUser() ? 'user is the demo mailbox' : flags.has(OVERRIDE_FLAG) ? 'OVERRIDDEN' : 'WOULD REFUSE (user is not the demo mailbox)'}`);
  console.log(`
Reset plan:
  1. LIST folders; discover Sent / Archive / Junk / Trash / Drafts by special-use flag, falling back to name.
  2. Print, then DELETE, every folder that is not INBOX and not a special-use/system folder
     (e.g. a reviewer-created "Newsletters"). Children are deleted before parents.
  3. Delete EVERY message in INBOX, Archive, Sent, Junk/Spam, Trash and Drafts (expunged, not recoverable).
  4. Create INBOX-level "Archive" / "Sent" if the server has none.
  5. APPEND the ${fixtures.length} fixtures below with their \\Seen flag and internal date.
  6. Re-run --check and exit 0 only if the mailbox now matches.
`);
  printFixtures(fixtures);
  process.exit(0);
}

// ------------------------------------------------------------ online modes

function isDemoUser() {
  return config.user.trim().toLowerCase() === DEMO_ADDRESS;
}

if (!isDemoUser() && !flags.has(OVERRIDE_FLAG)) {
  die(`refusing to run against ${config.user}: this tool is destructive and only for ${DEMO_ADDRESS}.\n`
    + `  Pass ${OVERRIDE_FLAG} if you really mean a different (disposable) mailbox.`);
}
const password = process.env.DEMO_IMAP_PASSWORD;
if (!password) die('DEMO_IMAP_PASSWORD is not set. It is read from the environment only.');

let ImapFlow;
try {
  ({ ImapFlow } = await import('imapflow'));
} catch {
  die('imapflow is not installed. Run: npm install --prefix tools/openai-review');
}

const client = new ImapFlow({
  host: config.host,
  port: config.port,
  secure: config.secure,
  auth: { user: config.user, pass: password },
  logger: false, // never log protocol traffic (it would include AUTH)
});
client.on('error', (err) => console.error(`IMAP error: ${err.message}`));


// ------------------------------------------------------------ helpers

function printPlanHeader(mode) {
  console.log(`MCP Emails review mailbox seeder: ${mode}`);
  console.log(`Target: ${config.user} @ ${config.host}:${config.port} (${config.secure ? 'TLS' : 'PLAINTEXT'})`);
  console.log(`Seed time: ${now.toISOString()}`);
}

function printFixtures(list) {
  for (const folder of ['INBOX', 'Archive', 'Sent']) {
    const inFolder = list.filter((x) => x.folder === folder);
    const unread = inFolder.filter((x) => !x.seen).length;
    console.log(`\n== ${folder}: ${inFolder.length} messages, ${unread} unread ==`);
    for (const x of inFolder) {
      console.log(`  #${String(x.n).padStart(2)} ${x.seen ? '     ' : 'UNREAD'} ${formatRfc5322Date(x.date)}  ${x.from.name} <${x.from.address}>`);
      console.log(`      Subject: ${x.subject}`);
      console.log(`      ${x.messageId}${x.inReplyTo ? `  In-Reply-To ${x.inReplyTo}` : ''}`);
    }
  }
}

// ------------------------------------------------------------ run

let exitCode = 2;
try {
  await client.connect();
  if (flags.has('--check')) {
    printPlanHeader('CHECK (read-only)');
    exitCode = await check(client, fixtures);
  } else {
    printPlanHeader('RESET');
    await reset(client, fixtures);
    console.log('\nVerifying...');
    exitCode = await check(client, fixtures);
    console.log(exitCode === 0 ? '\nReset complete: mailbox matches the fixtures.' : '\nReset finished but the mailbox does NOT match. See the diff above.');
  }
} catch (err) {
  // Error messages from imapflow carry server response text, never the password.
  console.error(`\nFailed: ${err.responseText || err.message}`);
  exitCode = 2;
} finally {
  try { await client.logout(); } catch { /* already closed */ }
}
process.exit(exitCode);
