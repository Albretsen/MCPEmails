#!/usr/bin/env node
/**
 * Report who the saved session belongs to, and print the .env lines that
 * follow from it.
 *
 *   npm run whoami
 *
 * Read-only. It opens the dashboard with the session saved by `npm run auth`,
 * reads the signed-in account, the active workspace id and the inboxes already
 * connected, and prints a block you can paste into .env. Nothing is changed and
 * no credential is printed.
 *
 * This exists because DEMO_WORKSPACE_ID is a UUID that only appears in a cookie
 * and is required by `reset`, whose whole purpose is refusing to run against a
 * workspace it cannot confirm. Asking someone to go and find that by hand, to
 * satisfy a guard, is how a guard gets disabled instead of satisfied.
 */

import { existsSync } from 'node:fs';
import { emit, fail, heading, log, parseArgs, paths, loadEnv } from './lib/common.mjs';
import { launch, demoContext, readActiveWorkspace } from './lib/browser.mjs';

loadEnv();
const args = parseArgs();

const baseUrl = (process.env.DEMO_BASE_URL || 'https://mcpemails.com').replace(/\/$/, '');

if (!existsSync(paths.authState)) {
  fail('whoami', 'No saved session at .auth/demo.json. Run: npm run auth');
}

const browser = await launch({ headless: !args.headed });
const { context } = await demoContext(browser);
const page = await context.newPage();

heading('Reading the saved session');
log(`  site ${baseUrl}`);

await page.goto(`${baseUrl}/dashboard/inboxes`, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

if (/\/login/.test(page.url())) {
  await browser.close();
  fail('whoami', 'The saved session is no longer valid: the app redirected to /login. Run: npm run auth');
}

const { id: workspaceId, source: workspaceSource } = await readActiveWorkspace(page, context);

// Inbox addresses render in a .mono span on each row. The dashboard has no GET
// endpoint for them: its state is loaded server side and never crosses the
// network as JSON.
await page.waitForTimeout(1200);
const inboxes = [
  ...new Set(
    (await page.locator('.mono').allTextContents())
      .map((s) => s.trim())
      .filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)),
  ),
];

await page.goto(`${baseUrl}/dashboard/settings`, { waitUntil: 'domcontentloaded' });
let account = null;
try {
  await page.waitForSelector('#profile-email', { timeout: 30000 });
  account = (await page.inputValue('#profile-email')).trim();
} catch {
  log('  could not read the account email from /dashboard/settings');
}

await browser.close();

log('');
log(`  account    ${account ?? 'unknown'}`);
log(`  workspace  ${workspaceId ?? 'unknown'}${workspaceId ? ` (from the ${workspaceSource})` : ''}`);
log(`  inboxes    ${inboxes.length ? inboxes.join(', ') : 'none connected'}`);

log('');
heading('Paste into .env');
log('');
log(`DEMO_BASE_URL=${baseUrl}`);
if (account) log(`DEMO_ACCOUNT_EMAIL=${account}`);
if (workspaceId) log(`DEMO_WORKSPACE_ID=${workspaceId}`);
log('');
log('The mailbox credentials for the add-inbox shot are separate, and this');
log('cannot read them. They are the IMAP host, user and app password of the');
log('throwaway mailbox you intend to film:');
log('');
log('DEMO_IMAP_HOST=imap.migadu.com');
log('DEMO_IMAP_USER=<the throwaway mailbox>');
log('DEMO_IMAP_PASS=<its app password>');
log('DEMO_SMTP_HOST=smtp.migadu.com');

if (inboxes.length) {
  log('');
  log(`This workspace already has ${inboxes.length} inbox(es) connected. The add-inbox`);
  log('shot films connecting one, so it needs to start from an empty list:');
  log('');
  log('  npm run reset -- --yes');
}

emit({
  ok: true,
  script: 'whoami',
  account,
  workspaceId,
  workspaceSource,
  inboxes,
  baseUrl,
  needsReset: inboxes.length > 0,
});
