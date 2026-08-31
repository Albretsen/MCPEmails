#!/usr/bin/env node
/**
 * Put the demo workspace back to zero inboxes, so the "add an inbox" shot can
 * start from an empty list.
 *
 *   npm run reset -- --yes
 *
 * READ THIS BEFORE EDITING.
 *
 * This disconnects inboxes. It runs against a real deployment holding real
 * customer data in other workspaces. It is the single most dangerous thing in
 * this tool, and the danger is not that it is complicated: it is that pointing
 * it at the wrong workspace takes one edited environment variable.
 *
 * So the guards are HERE, in the code, not in the documentation. All five must
 * hold or nothing is touched:
 *
 *   1. DEMO_WORKSPACE_ID is set, and equals the workspace the session is
 *      actually active in.
 *   2. The signed-in account's email equals DEMO_ACCOUNT_EMAIL.
 *   3. Every inbox in the workspace is on a safe domain (`.example`, or one
 *      listed in DEMO_SAFE_INBOX_DOMAINS). One address that is not, and the run
 *      aborts without disconnecting anything, including the safe ones.
 *   4. The workspace holds no more than MAX_INBOXES. A demo workspace with a
 *      dozen mailboxes in it is not a demo workspace.
 *   5. --yes was passed explicitly.
 *
 * Guard 3 is checked across the WHOLE list before any deletion, deliberately.
 * A partial delete that stops when it reaches the surprising address has
 * already destroyed the ones before it.
 */

import { emit, fail, heading, log, parseArgs, loadEnv } from './lib/common.mjs';
import { launch, demoContext } from './lib/browser.mjs';

loadEnv();
const args = parseArgs();

const MAX_INBOXES = 4;

const baseUrl = (process.env.DEMO_BASE_URL ?? '').replace(/\/$/, '');
const expectedEmail = (process.env.DEMO_ACCOUNT_EMAIL ?? '').trim().toLowerCase();
const expectedWorkspace = (process.env.DEMO_WORKSPACE_ID ?? '').trim();
const safeDomains = (process.env.DEMO_SAFE_INBOX_DOMAINS ?? 'example')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// --- Guards that need no browser ------------------------------------------

if (!baseUrl) fail('reset', 'DEMO_BASE_URL is not set.');
if (!expectedEmail) fail('reset', 'Guard 2 cannot run: DEMO_ACCOUNT_EMAIL is not set.');
if (!expectedWorkspace) fail('reset', 'Guard 1 cannot run: DEMO_WORKSPACE_ID is not set.');
if (!args.yes) {
  fail(
    'reset',
    'Guard 5 failed: --yes was not passed. This disconnects inboxes. Re-run as: npm run reset -- --yes',
  );
}

const browser = await launch({ headless: !args.headed });
const { context } = await demoContext(browser);
const page = await context.newPage();

const abort = async (message, guard) => {
  await browser.close();
  log(`\nGuard ${guard} failed. NOTHING was disconnected.`);
  fail('reset', message, { guard });
};

// --- Guard 1: the active workspace -----------------------------------------

heading('Guards');

await page.goto(`${baseUrl}/dashboard/inboxes`, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

if (/\/login/.test(page.url())) {
  await abort('The saved session is no longer valid: the app redirected to /login. Run: npm run auth', 0);
}

// The active workspace is authoritative in the cookie the server reads, not in
// anything rendered, so read the cookie.
const cookies = await context.cookies();
const activeWorkspace = cookies.find((c) => c.name === 'mcpe_active_ws')?.value ?? null;

if (!activeWorkspace) {
  await abort(
    'Could not read the active workspace cookie (mcpe_active_ws). Refusing to guess which workspace this is.',
    1,
  );
}
if (activeWorkspace !== expectedWorkspace) {
  await abort(
    `The session's active workspace is ${activeWorkspace}, but DEMO_WORKSPACE_ID is ${expectedWorkspace}. ` +
    'Switch workspace in the dashboard, or fix DEMO_WORKSPACE_ID. Do not change one to match the other without checking which is right.',
    1,
  );
}
log(`  [ok  ] guard 1: active workspace is ${activeWorkspace}`);

// --- Guard 2: the account --------------------------------------------------

await page.goto(`${baseUrl}/dashboard/settings`, { waitUntil: 'domcontentloaded' });
let signedInAs = null;
try {
  await page.waitForSelector('#profile-email', { timeout: 30000 });
  signedInAs = (await page.inputValue('#profile-email')).trim().toLowerCase();
} catch {
  await abort('Could not read the signed-in account email from /dashboard/settings.', 2);
}
if (signedInAs !== expectedEmail) {
  await abort(`Signed in as ${signedInAs}, but DEMO_ACCOUNT_EMAIL is ${expectedEmail}.`, 2);
}
log(`  [ok  ] guard 2: signed in as ${signedInAs}`);

// --- Guards 3 and 4: what is actually in the workspace ---------------------

await page.goto(`${baseUrl}/dashboard/inboxes`, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1200);

// Addresses render in a .mono span inside each inbox row. Reading the DOM
// rather than an API because the dashboard has no GET endpoint for inboxes:
// its state is loaded server side and never crosses the network as JSON.
const addresses = (
  await page.locator('.mono').allTextContents()
)
  .map((s) => s.trim())
  .filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));

const unique = [...new Set(addresses)];
log(`  found ${unique.length} inbox address(es): ${unique.join(', ') || 'none'}`);

if (unique.length === 0) {
  await browser.close();
  log('\nNothing to disconnect. The workspace is already empty.');
  emit({ ok: true, script: 'reset', workspace: activeWorkspace, disconnected: 0, alreadyEmpty: true });
  process.exit(0);
}

if (unique.length > MAX_INBOXES) {
  await abort(
    `The workspace holds ${unique.length} inboxes, more than the ${MAX_INBOXES} a demo workspace should ever have. ` +
    'This does not look like the demo workspace.',
    4,
  );
}
log(`  [ok  ] guard 4: ${unique.length} inbox(es), at or under the limit of ${MAX_INBOXES}`);

const isSafe = (address) => {
  const domain = address.split('@')[1]?.toLowerCase() ?? '';
  // `.example` is reserved by RFC 2606 and can never be registered, so an
  // address on it cannot belong to a real person.
  if (domain === 'example' || domain.endsWith('.example')) return true;
  return safeDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
};

const unsafe = unique.filter((a) => !isSafe(a));
if (unsafe.length) {
  await abort(
    `Refusing to touch this workspace: ${unsafe.join(', ')} ${unsafe.length === 1 ? 'is' : 'are'} not on a safe domain. ` +
    `Safe domains are *.example plus: ${safeDomains.join(', ')}. ` +
    'No inbox was disconnected, including the safe ones.',
    3,
  );
}
log(`  [ok  ] guard 3: every address is on a safe domain`);
log(`  [ok  ] guard 5: --yes was passed`);

// --- Disconnect ------------------------------------------------------------

heading('Disconnecting');

const disconnected = [];
for (const address of unique) {
  // Drive the product's own disconnect flow rather than calling the API
  // directly. It is slower, and it is the path a person would take, so it
  // cannot get ahead of what the UI actually permits.
  const row = page.locator('article, tr, li').filter({ hasText: address }).first();
  const trash = row.getByRole('button', { name: /disconnect/i }).first();

  try {
    await trash.click({ timeout: 15000 });
  } catch {
    log(`  [warn] could not find a disconnect control for ${address}, skipping`);
    continue;
  }

  const confirm = page.getByRole('button', { name: /^disconnect$/i }).last();
  await confirm.click({ timeout: 15000 });
  await page.waitForTimeout(1500);

  disconnected.push(address);
  log(`  disconnected ${address}`);
}

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
const remaining = (await page.locator('.mono').allTextContents())
  .map((s) => s.trim())
  .filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));

await browser.close();

log('');
log(`Disconnected ${disconnected.length}, ${remaining.length} remaining.`);

emit({
  ok: remaining.length === 0,
  script: 'reset',
  workspace: activeWorkspace,
  account: signedInAs,
  disconnected,
  remaining,
});

process.exit(remaining.length === 0 ? 0 : 1);
