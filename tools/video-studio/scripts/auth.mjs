#!/usr/bin/env node
/**
 * Save a demo session, once, by hand.
 *
 *   npm run auth
 *
 * Opens a HEADED browser at the login page and waits for a HUMAN to sign in as
 * the demo account. Then it writes Playwright's storageState to .auth/demo.json
 * and every later capture loads that instead of touching a login form.
 *
 * This script deliberately cannot sign in by itself, and must not be changed so
 * that it can. Entering credentials is a person's job: an agent that can type a
 * password into a form is an agent that can be talked into typing it into the
 * wrong one. There is no DEMO_ACCOUNT_PASSWORD, and adding one would be a
 * regression, not a convenience.
 *
 * .auth/demo.json holds a live session token. It is gitignored, doctor fails if
 * it is ever tracked, and nothing prints its contents.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { emit, fail, log, paths, loadEnv } from './lib/common.mjs';
import { launch, VIEWPORT } from './lib/browser.mjs';

loadEnv();

// Defaults to production, like capture does. Requiring a .env before you can
// even sign in is friction for no safety gain: signing in to the real site as
// the demo account IS the documented path. `reset` is the script that must stay
// strict, because it deletes things.
const baseUrl = (process.env.DEMO_BASE_URL || 'https://mcpemails.com').replace(/\/$/, '');

// Optional. When set, the sign-in is checked against it and a mismatch throws
// the session away. When unset, whoever signed in is reported instead, so this
// still works for someone whose demo account is not the one in .env.example.
// `reset` hard-requires it either way: that is where getting it wrong is
// destructive.
const expectedEmail = process.env.DEMO_ACCOUNT_EMAIL;

const browser = await launch({ headless: false });
const context = await browser.newContext({
  viewport: VIEWPORT,
  colorScheme: 'dark',
  locale: 'en-US',
  timezoneId: 'Europe/Oslo',
});
const page = await context.newPage();

log('');
log('A browser window has opened.');
log(
  expectedEmail
    ? `Sign in as ${expectedEmail}, by hand, then leave the window alone.`
    : 'Sign in as the demo account, by hand, then leave the window alone.',
);
log(`Site: ${baseUrl}`);
log('This script is watching for the dashboard to load. It will not type anything.');
log('');

await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });

try {
  // Wait for the dashboard, not for a redirect: a magic-link or OAuth round
  // trip can pass through several URLs before landing.
  await page.waitForURL(/\/dashboard(\/|$|\?)/, { timeout: 10 * 60 * 1000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
} catch {
  await browser.close();
  fail('auth', 'Timed out after 10 minutes waiting for the dashboard. Nothing was saved.');
}

// Confirm which account actually signed in, before saving anything. A session
// for the wrong account is exactly the failure reset.mjs exists to prevent, and
// catching it here is cheaper than catching it there.
let signedInAs = null;
try {
  await page.goto(`${baseUrl}/dashboard/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#profile-email', { timeout: 30000 });
  signedInAs = await page.inputValue('#profile-email');
} catch {
  log('  Could not read the account email from the settings page.');
}

if (expectedEmail && signedInAs && signedInAs.trim().toLowerCase() !== expectedEmail.trim().toLowerCase()) {
  await browser.close();
  fail(
    'auth',
    `Signed in as ${signedInAs}, but DEMO_ACCOUNT_EMAIL is ${expectedEmail}. Nothing was saved. ` +
    'Sign out, re-run, and use the demo account.',
  );
}

mkdirSync(paths.auth, { recursive: true });
await context.storageState({ path: paths.authState });
await browser.close();

// Never print the file's contents, and never echo a token.
writeFileSync(
  `${paths.auth}/README.txt`,
  'demo.json is a LIVE session for the demo account. Gitignored on purpose.\n' +
  'Delete it when you are done filming. Regenerate with: npm run auth\n',
);

log('');
log(`Saved a session for ${signedInAs ?? 'the signed-in account'} to .auth/demo.json`);
if (!expectedEmail) {
  log('DEMO_ACCOUNT_EMAIL was not set, so nothing checked WHICH account that is.');
  log('Set it in .env before running reset, which refuses to touch a workspace it cannot confirm.');
}
log('Captures will use it automatically. Re-run this if it stops working.');

emit({
  ok: true,
  script: 'auth',
  account: signedInAs ?? null,
  accountVerified: Boolean(expectedEmail && signedInAs),
  baseUrl,
  state: '.auth/demo.json',
});
