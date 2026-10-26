#!/usr/bin/env node
/**
 * Seeds the STAGING database (Supabase project wwsstwvvkjfqmuuasecu) with
 * synthetic test accounts. Never copies a production row. Implements the
 * staging plan, section 10, steps 1-4 and 7:
 *
 *   1. auth users on an allowlisted test domain, one per persona:
 *      owner+free@ (past the 3-day grace), owner+grace@ (inside it),
 *      owner+personal@, owner+pro@, owner+business@ (real sandbox
 *      subscriptions), owner+pass@ (an active 3-month pass) and owner+admin@
 *      (for ADMIN_EMAILS). The signup trigger creates their workspaces.
 *   2. plans and entitlements: workspaces.plan, user_billing, user_passes and
 *      the rollout flags. Paid personas get a real subscription in the Stripe
 *      sandbox (card pm_card_visa), optionally on a test clock, carrying
 *      metadata.user_id, so the staging webhook re-applies the same state the
 *      real way. The rows are also written here, so the seed is complete even
 *      before the webhook is wired.
 *   3. internal_accounts: the untagged owner@ address (plus variants match).
 *   4. pricing_switches and retention_switches.first30.
 *   7. one API key per persona (all scopes), raw keys written to the env file.
 *
 *   Steps 5 (connect test inboxes through /api/inboxes/imap) and 6 (seed
 *   mailbox content) come later: see connectInboxes() below.
 *
 * SAFETY. Refuses unless NEXT_PUBLIC_SUPABASE_URL is the staging project, the
 * email domain is in SEED_TEST_DOMAINS, and (for subscriptions) the Stripe key
 * is a test key of the staging sandbox. Reads only the staging env file
 * (default ~/.config/mcpemails-staging/staging.env) and the process
 * environment, never apps/web/.env.local, which points at production.
 *
 * Usage, from the repo root:
 *   node scripts/seed-staging.mjs                 # dry run: print the plan
 *   node scripts/seed-staging.mjs --apply         # write
 *     [--env-file <path>] [--domain staging.mcpemails.com]
 *     [--test-clock]                 new paid customers go on a test clock
 *     [--switch pro_inbox_cap=false] override a pricing switch (repeatable)
 *     [--rotate-keys]                mint fresh API keys even if the stored ones work
 *
 * Re-runnable: users, customers, subscriptions, passes and keys are found
 * before anything is created. The grace persona's workspace is re-dated to
 * now on every run so it stays inside its grace window.
 */

import { createHash, randomBytes } from 'node:crypto';

import {
  API_KEY_NAME,
  API_KEY_SCOPES,
  DEFAULT_STAGING_ENV,
  PERSONAS,
  ROLLOUT_FLAGS,
  SEED_TEST_DOMAINS,
  WEBHOOK_API_VERSION,
  apiKeyEnvName,
  assertStagingAccount,
  assertStagingSupabase,
  assertTestKey,
  formEncode,
  internalAccountEmail,
  readEnvFile,
  resolveSwitches,
  seedEmail,
  writeEnvFile,
} from './staging-lib.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const apply = flag('--apply');
const useTestClock = flag('--test-clock');
const rotateKeys = flag('--rotate-keys');
const envFile = option('--env-file') ?? DEFAULT_STAGING_ENV;
const fileEnv = readEnvFile(envFile);
const env = (name) => process.env[name] ?? fileEnv[name];

const supabaseUrl = env('NEXT_PUBLIC_SUPABASE_URL');
assertStagingSupabase(supabaseUrl);
const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set.');

const domain = option('--domain') ?? env('SEED_EMAIL_DOMAIN') ?? SEED_TEST_DOMAINS[0];
const switches = resolveSwitches(argv);
const envUpdates = {};

function log(line) {
  console.error(`${apply ? '' : '[dry-run] '}${line}`);
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

async function http(url, init, label) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} -> ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function rest(path, init = {}) {
  return http(
    `${supabaseUrl}/rest/v1/${path}`,
    {
      ...init,
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    },
    `${init.method ?? 'GET'} ${path}`,
  );
}

function authAdmin(path, init = {}) {
  return http(
    `${supabaseUrl}/auth/v1/admin/${path}`,
    {
      ...init,
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    },
    `${init.method ?? 'GET'} auth/admin/${path}`,
  );
}

let stripeKey = null;
async function stripe(method, path, params) {
  const url = new URL(`https://api.stripe.com/v1/${path}`);
  const init = { method, headers: { Authorization: `Bearer ${stripeKey}`, 'Stripe-Version': WEBHOOK_API_VERSION } };
  if (params && method === 'GET') {
    for (const [name, value] of formEncode(params)) url.searchParams.append(name, value);
  } else if (params) {
    init.headers['content-type'] = 'application/x-www-form-urlencoded';
    init.body = formEncode(params).toString();
  }
  return http(url, init, `${method} stripe/${path}`);
}

async function initStripe() {
  if (stripeKey) return;
  stripeKey = env('STRIPE_SECRET_KEY');
  assertTestKey(stripeKey);
  assertStagingAccount((await stripe('GET', 'account')).id);
}

const iso = (seconds) => (seconds ? new Date(seconds * 1000).toISOString() : null);

// ── 1. Users ────────────────────────────────────────────────────────────────

async function listAuthUsers() {
  const users = [];
  for (let page = 1; ; page++) {
    const body = await authAdmin(`users?page=${page}&per_page=1000`);
    users.push(...(body.users ?? []));
    if ((body.users ?? []).length < 1000) return users;
  }
}

let password = env('SEED_USER_PASSWORD');
if (!password) {
  password = randomBytes(18).toString('base64url');
  envUpdates.SEED_USER_PASSWORD = password;
}

async function ensureUser(persona, existing) {
  const email = seedEmail(persona.tier, domain);
  const found = existing.find((u) => u.email?.toLowerCase() === email);
  if (found) return found;
  log(`create auth user ${email}`);
  if (!apply) return { id: `(new:${persona.tier})`, email };
  return authAdmin('users', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: `Staging ${persona.tier}`, staging_seed: persona.tier },
    }),
  });
}

async function workspaceFor(userId) {
  // The signup trigger runs inside the auth insert, but allow a moment.
  for (let attempt = 0; attempt < 5; attempt++) {
    const rows = await rest(
      `workspaces?owner_id=eq.${userId}&deleted_at=is.null&select=id,plan,created_at,stripe_customer_id&order=created_at.asc&limit=1`,
    );
    if (rows.length) return rows[0];
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`No workspace for user ${userId}: is the signup trigger migrated?`);
}

// ── 2. Plans, subscriptions, passes ────────────────────────────────────────

async function ensureSubscription(persona, user) {
  await initStripe();
  const email = seedEmail(persona.tier, domain);
  const priceId = env(persona.priceEnv);
  if (!priceId) throw new Error(`${persona.priceEnv} is not set: run scripts/stripe-staging-setup.mjs --write-env first.`);

  const customers = await stripe('GET', 'customers', { email, limit: 10 });
  let customer = customers.data.find((c) => c.metadata?.user_id === user.id) ?? null;
  if (!customer) {
    let testClock;
    if (useTestClock) {
      log(`create test clock for ${email}`);
      if (apply) {
        testClock = (
          await stripe('POST', 'test_helpers/test_clocks', {
            frozen_time: Math.floor(Date.now() / 1000),
            name: `seed ${persona.tier}`,
          })
        ).id;
      }
    }
    log(`create Stripe customer ${email}${useTestClock ? ' (test clock)' : ''}`);
    if (!apply) return null;
    customer = await stripe('POST', 'customers', {
      email,
      name: `Staging ${persona.tier}`,
      payment_method: 'pm_card_visa',
      metadata: { user_id: user.id, staging_seed: persona.tier },
      test_clock: testClock,
    });
  }

  const subs = await stripe('GET', 'subscriptions', { customer: customer.id, status: 'all', limit: 20 });
  let sub = subs.data.find(
    (s) => s.metadata?.staging_seed === persona.tier && ['active', 'trialing', 'past_due'].includes(s.status),
  );
  if (!sub) {
    log(`create subscription ${persona.priceEnv} for ${email}`);
    if (!apply) return null;
    const methods = await stripe('GET', `customers/${customer.id}/payment_methods`, { type: 'card', limit: 1 });
    const paymentMethod = methods.data[0]?.id;
    if (!paymentMethod) throw new Error(`Customer ${customer.id} has no card attached.`);
    sub = await stripe('POST', 'subscriptions', {
      customer: customer.id,
      items: [{ price: priceId }],
      default_payment_method: paymentMethod,
      metadata: { user_id: user.id, staging_seed: persona.tier },
    });
  }
  return { customer, sub };
}

async function applyPlan(persona, user, workspace) {
  const now = new Date();
  const workspacePatch = { plan: persona.plan };
  const billing = { user_id: user.id, plan: persona.pass ? 'free' : persona.plan, updated_at: now.toISOString() };

  if (persona.ageDays !== undefined) {
    workspacePatch.created_at = new Date(now.getTime() - persona.ageDays * 86_400_000).toISOString();
  }
  if (persona.priceEnv) {
    const result = await ensureSubscription(persona, user);
    if (result) {
      const item = result.sub.items?.data?.[0];
      workspacePatch.stripe_customer_id = result.customer.id;
      Object.assign(billing, {
        stripe_customer_id: result.customer.id,
        stripe_subscription_id: result.sub.id,
        subscription_status: result.sub.status,
        current_period_start: iso(item?.current_period_start),
        current_period_end: iso(item?.current_period_end),
      });
    }
  }
  if (persona.tier !== 'free' && persona.tier !== 'grace') {
    for (const column of ROLLOUT_FLAGS) workspacePatch[column] = true;
  }

  log(`workspace ${workspace.id}: ${JSON.stringify(workspacePatch)}`);
  log(`user_billing ${user.email}: plan ${billing.plan}${billing.stripe_subscription_id ? ` (${billing.stripe_subscription_id})` : ''}`);
  if (!apply) return;
  await rest(`workspaces?id=eq.${workspace.id}`, { method: 'PATCH', body: JSON.stringify(workspacePatch) });
  await rest('user_billing?on_conflict=user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(billing),
  });

  if (persona.pass) {
    // A pass is bought through Checkout only (E-SCRIPTED tests the real
    // purchase); the seed writes the row the webhook would, with a synthetic
    // session id so it can never match a real Stripe object.
    const sessionId = `cs_seed_${persona.tier}_${user.id}`;
    const existing = await rest(`user_passes?stripe_checkout_session_id=eq.${sessionId}&select=id`);
    if (!existing.length) {
      log(`create active 3-month pass for ${user.email}`);
      const ends = new Date(now);
      ends.setUTCMonth(ends.getUTCMonth() + 3);
      await rest('user_passes', {
        method: 'POST',
        body: JSON.stringify({
          user_id: user.id,
          product: 'personal_pass_3m',
          plan: 'personal',
          stripe_checkout_session_id: sessionId,
          amount_minor: 2900,
          currency: 'usd',
          starts_at: now.toISOString(),
          ends_at: ends.toISOString(),
          status: 'active',
        }),
      });
    }
  }
}

// ── 3 + 4. internal_accounts and switches ───────────────────────────────────

async function applyAccountsAndSwitches() {
  const internal = internalAccountEmail(domain);
  log(`internal_accounts: ${internal}`);
  for (const [key, enabled] of Object.entries(switches)) log(`pricing_switches.${key} = ${enabled}`);
  log('retention_switches.first30 = dry_run, no auto go-live');
  if (!apply) return;
  await rest('internal_accounts?on_conflict=email', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{ email: internal, note: 'staging seed personas (scripts/seed-staging.mjs)' }]),
  });
  await rest('pricing_switches?on_conflict=key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(
      Object.entries(switches).map(([key, enabled]) => ({
        key,
        enabled,
        note: 'staging: set by scripts/seed-staging.mjs',
        updated_at: new Date().toISOString(),
      })),
    ),
  });
  await rest('retention_switches?on_conflict=key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{ key: 'first30', mode: 'dry_run', auto_go_live_at: null, updated_at: new Date().toISOString() }]),
  });
}

// ── 7. API keys ─────────────────────────────────────────────────────────────

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

async function ensureApiKey(persona, user, workspace) {
  const envName = apiKeyEnvName(persona.tier);
  const stored = env(envName);
  if (stored && !rotateKeys && apply) {
    const rows = await rest(`api_keys?key_hash=eq.${sha256(stored)}&deleted_at=is.null&select=id`);
    if (rows.length) return;
  }
  log(`mint API key "${API_KEY_NAME}" for ${user.email} -> ${envName}`);
  if (!apply) return;
  await rest(`api_keys?workspace_id=eq.${workspace.id}&name=eq.${API_KEY_NAME}&deleted_at=is.null`, {
    method: 'PATCH',
    body: JSON.stringify({ deleted_at: new Date().toISOString() }),
  });
  const suffix = randomBytes(32).toString('hex');
  const raw = `mcpe_${suffix}`;
  await rest('api_keys', {
    method: 'POST',
    body: JSON.stringify({
      workspace_id: workspace.id,
      created_by: user.id,
      name: API_KEY_NAME,
      key_prefix: suffix.slice(0, 8),
      key_hash: sha256(raw),
      scopes: [...API_KEY_SCOPES],
    }),
  });
  envUpdates[envName] = raw;
}

// ── 5 + 6. Later ────────────────────────────────────────────────────────────

/**
 * TODO(E-SEED, plan section 10 steps 5-6): connect the Migadu test mailboxes
 * (staging-a@, staging-b@) through the real POST /api/inboxes/imap route as
 * the seeded users, so credentials are encrypted with the STAGING
 * ENCRYPTION_KEY (never insert inbox rows directly), then seed their content
 * with scripts/seed-reviewer-mailbox.py. Blocked on O-MIGADU. Gmail and
 * Outlook are connected by hand (E-OWNER).
 */
async function connectInboxes(_seeded) {
  console.error('TODO: inbox connection and mailbox content are not seeded yet (steps 5-6).');
}

// ── Run ─────────────────────────────────────────────────────────────────────

console.error(`Staging seed for ${new URL(supabaseUrl).hostname}, domain ${domain}.${apply ? '' : ' Dry run: nothing is written.'}`);
const existingUsers = await listAuthUsers();
const seeded = [];
for (const persona of PERSONAS) {
  const user = await ensureUser(persona, existingUsers);
  const workspace = apply ? await workspaceFor(user.id) : { id: `(workspace of ${user.email})` };
  await applyPlan(persona, user, workspace);
  await ensureApiKey(persona, user, workspace);
  seeded.push({ persona, user, workspace });
}
await applyAccountsAndSwitches();
await connectInboxes(seeded);

if (apply && Object.keys(envUpdates).length) {
  writeEnvFile(envFile, envUpdates);
  console.error(`Wrote ${Object.keys(envUpdates).join(', ')} to ${envFile} (chmod 600).`);
}

const admin = seeded.find((s) => s.persona.admin);
console.log('# Vercel env for mcp-emails-web-staging, to match the seed:');
console.log(`ADMIN_EMAILS=${seedEmail(admin.persona.tier, domain)}`);
console.log(`GROWTH_INTERNAL_EMAILS=${internalAccountEmail(domain)}`);
console.log(`# EMAIL_RECIPIENT_ALLOWLIST must include @${domain} for these users to sign in.`);
