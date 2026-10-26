// ---------------------------------------------------------------------------
// Shared, side-effect-free helpers for the two staging scripts:
//   scripts/stripe-staging-setup.mjs  (Stripe sandbox catalog, coupons, webhook)
//   scripts/seed-staging.mjs          (test users, plans, switches, API keys)
//
// Everything here is pure or takes its I/O as an argument, so
// scripts/staging-lib.test.mjs can cover the guards and the planners without
// a network. Nothing in this file talks to production: the guards below are
// the reason the two scripts cannot.
// ---------------------------------------------------------------------------

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** The only Stripe account the setup script will touch (the staging sandbox). */
export const STAGING_STRIPE_ACCOUNT = 'acct_1UUs5wPI08gnOkR5';
/** The only Supabase project the seed script will touch. */
export const STAGING_SUPABASE_REF = 'wwsstwvvkjfqmuuasecu';
/** Default location of the staging secrets file. Never inside the repo. */
export const DEFAULT_STAGING_ENV = resolve(homedir(), '.config/mcpemails-staging/staging.env');

export const STAGING_WEBHOOK_URL = 'https://staging.mcpemails.com/api/stripe/webhook';
/** Same API version as the production webhook endpoint, so payloads match. */
export const WEBHOOK_API_VERSION = '2025-05-28.basil';

/**
 * Every event apps/web/app/api/stripe/webhook/route.ts handles. The EUR
 * launch preflight (src/lib/stripe/eur-launch-run.ts) checks a subset.
 */
export const WEBHOOK_EVENTS = Object.freeze([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
  'invoice.payment_action_required',
  'invoice.payment_succeeded',
  'invoice.paid',
  'invoice.voided',
  'charge.refunded',
  'charge.dispute.created',
]);

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** Throws unless the key is a Stripe test-mode secret or restricted key. */
export function assertTestKey(key) {
  if (typeof key !== 'string' || !/^(sk|rk)_test_[A-Za-z0-9]+$/.test(key)) {
    throw new Error(
      'Refusing: STRIPE_SECRET_KEY must be a test-mode key (sk_test_ or rk_test_). ' +
        'This script only ever runs against the staging sandbox.',
    );
  }
}

/** Throws unless the account the key belongs to is the staging sandbox. */
export function assertStagingAccount(accountId) {
  if (accountId !== STAGING_STRIPE_ACCOUNT) {
    throw new Error(
      `Refusing: the key belongs to ${accountId || 'an unknown account'}, ` +
        `not the staging sandbox ${STAGING_STRIPE_ACCOUNT}.`,
    );
  }
}

/** Throws unless the Supabase URL is the staging project's. */
export function assertStagingSupabase(url) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    // fall through to the refusal
  }
  if (host !== `${STAGING_SUPABASE_REF}.supabase.co`) {
    throw new Error(
      `Refusing: NEXT_PUBLIC_SUPABASE_URL is not the staging project (${STAGING_SUPABASE_REF}). ` +
        'The seed script never runs against any other database.',
    );
  }
}

// ---------------------------------------------------------------------------
// Env file handling (the staging secrets file, chmod 600, outside the repo)
// ---------------------------------------------------------------------------

/** Parses KEY=value lines. Quotes around a value are stripped. */
export function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    out[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * Returns `text` with each KEY in `updates` replaced in place, or appended
 * when absent. Other lines (comments, blanks, other keys) are kept verbatim.
 */
export function upsertEnvText(text, updates) {
  const lines = text.length ? text.replace(/\n$/, '').split('\n') : [];
  const pending = new Map(Object.entries(updates));
  const next = lines.map((line) => {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/.exec(line);
    if (match && pending.has(match[1])) {
      const value = pending.get(match[1]);
      pending.delete(match[1]);
      return `${match[1]}=${value}`;
    }
    return line;
  });
  for (const [key, value] of pending) next.push(`${key}=${value}`);
  return `${next.join('\n')}\n`;
}

/** Loads the env file into a plain object. Missing file = {}. */
export function readEnvFile(path) {
  if (!existsSync(path)) return {};
  return parseEnv(readFileSync(path, 'utf8'));
}

/** Upserts keys into the env file and keeps it readable by the owner only. */
export function writeEnvFile(path, updates) {
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  writeFileSync(path, upsertEnvText(before, updates), { mode: 0o600 });
  chmodSync(path, 0o600);
}

// ---------------------------------------------------------------------------
// Stripe form encoding (no SDK: the scripts run with plain `node`)
// ---------------------------------------------------------------------------

/** Flattens nested params to Stripe's bracket form: a[b][0]=c. */
export function formEncode(params, prefix = '', out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value === null) {
      out.append(name, '');
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item !== null && typeof item === 'object') formEncode(item, `${name}[${index}]`, out);
        else out.append(`${name}[${index}]`, String(item));
      });
    } else if (typeof value === 'object') {
      formEncode(value, name, out);
    } else {
      out.append(name, String(value));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The catalog: STRIPE_SPEC.md (staging tracker), read from the live account
// on 2026-10-26. Amounts are USD cents. `staging_key` in metadata is how a
// re-run finds what an earlier run created.
// ---------------------------------------------------------------------------

const TAX_CODE = 'txcd_10000000';

export const PRODUCTS = Object.freeze([
  {
    key: 'personal',
    name: 'MCP Emails Personal',
    description:
      'Three connected inboxes for one person. Send, reply, schedule, and organise across work, personal, and one more.',
    statement_descriptor: 'MCP Emails',
    metadata: { plan_id: 'personal', value_metric: 'inboxes' },
  },
  {
    key: 'pro',
    name: 'MCP Emails Pro',
    description:
      'Unlimited connected inboxes for one person. Send, reply, schedule, and organise across every mailbox you own.',
    statement_descriptor: 'MCP Emails',
    metadata: { plan_id: 'solo', value_metric: 'inboxes' },
  },
  {
    key: 'business',
    name: 'MCPEmails Business',
    description:
      '10 mailboxes included, $3 a month for each extra. Unlimited members with roles, admins approve held sends, several workspaces on one subscription.',
    tax_code: TAX_CODE,
    metadata: {},
  },
  {
    key: 'pass',
    name: 'MCPEmails Personal, 3 months',
    description: 'Personal plan for 3 months, paid once. Does not renew.',
    tax_code: TAX_CODE,
    metadata: {},
  },
  {
    key: 'team_legacy',
    name: 'MCP Emails Team',
    description: 'Unlimited inboxes shared across a team. Retired plan, kept so legacy billing paths can be tested.',
    statement_descriptor: 'MCP Emails',
    metadata: { plan_id: 'pro', value_metric: 'inboxes' },
  },
  {
    key: 'japan_route',
    name: 'MCP Emails Japan sending route',
    description: 'Outgoing mail for one mailbox is sent from a server in Japan. Billed yearly.',
    tax_code: TAX_CODE,
    metadata: {},
  },
]);

// `tax`: the USD tax_behavior prod has today ('unspecified' on four prices,
// which the EUR launch flips to exclusive). `eur`: what --with-eur adds, per
// the launch rule (same digits as USD, inclusive) except where noted.
// `eurAlways`: an option prod already carries, created on every run.
export const PRICES = Object.freeze([
  { env: 'STRIPE_PRICE_PERSONAL_MONTHLY_V2', product: 'personal', amount: 900, interval: 'month', tax: 'exclusive' },
  { env: 'STRIPE_PRICE_PERSONAL_YEARLY_V2', product: 'personal', amount: 8640, interval: 'year', tax: 'exclusive' },
  { env: 'STRIPE_PRICE_SOLO_MONTHLY', product: 'pro', amount: 1500, interval: 'month', tax: 'exclusive', nickname: 'Pro-Monthly' },
  { env: 'STRIPE_PRICE_SOLO_YEARLY', product: 'pro', amount: 14400, interval: 'year', tax: 'exclusive', nickname: 'Pro-Yearly' },
  { env: 'STRIPE_PRICE_SOLO_MONTHLY_V2', product: 'pro', amount: 1900, interval: 'month', tax: 'exclusive', nickname: 'Pro-Monthly-19' },
  { env: 'STRIPE_PRICE_SOLO_YEARLY_V2', product: 'pro', amount: 18240, interval: 'year', tax: 'exclusive', nickname: 'Pro-Yearly-182.40' },
  { env: 'STRIPE_PRICE_BUSINESS_MONTHLY', product: 'business', amount: 3900, interval: 'month', tax: 'exclusive', nickname: 'Business-Monthly' },
  { env: 'STRIPE_PRICE_BUSINESS_YEARLY', product: 'business', amount: 37440, interval: 'year', tax: 'unspecified', nickname: 'Business-Yearly' },
  { env: 'STRIPE_PRICE_BUSINESS_MAILBOX_MONTHLY', product: 'business', amount: 300, interval: 'month', tax: 'unspecified', nickname: 'Business-Mailbox-Monthly' },
  { env: 'STRIPE_PRICE_BUSINESS_MAILBOX_YEARLY', product: 'business', amount: 2880, interval: 'year', tax: 'unspecified', nickname: 'Business-Mailbox-Yearly' },
  {
    env: 'STRIPE_PRICE_BUSINESS_FOUNDER_MONTHLY', product: 'business', amount: 2900, interval: 'month', tax: 'exclusive',
    nickname: 'Business founder monthly', lookup_key: 'business_founder_month', metadata: { offer: 'founder2026' },
    eurAlways: { unit_amount: 2900, tax_behavior: 'exclusive' },
  },
  {
    env: 'STRIPE_PRICE_BUSINESS_FOUNDER_YEARLY', product: 'business', amount: 27840, interval: 'year', tax: 'exclusive',
    nickname: 'Business founder yearly', lookup_key: 'business_founder_year', metadata: { offer: 'founder2026' },
    eurAlways: { unit_amount: 27840, tax_behavior: 'exclusive' },
  },
  { env: 'STRIPE_PRICE_PERSONAL_PASS_3M', product: 'pass', amount: 2900, interval: null, tax: 'exclusive', noEur: true },
  { env: 'STRIPE_PRICE_JAPAN_ROUTE_YEARLY', product: 'japan_route', amount: 12000, interval: 'year', tax: 'unspecified', eurAmount: 10800 },
  // Legacy, still billing in prod. Never get EUR options (not in SOLD_PRICE_ENV).
  { env: 'STRIPE_PRICE_PERSONAL_MONTHLY', product: 'personal', amount: 500, interval: 'month', tax: 'exclusive', nickname: 'Personal-Monthly', legacy: true },
  { env: 'STRIPE_PRICE_PERSONAL_YEARLY', product: 'personal', amount: 4800, interval: 'year', tax: 'exclusive', nickname: 'Personal-Yearly', legacy: true },
  { env: 'STRIPE_PRICE_PRO_MONTHLY', product: 'team_legacy', amount: 7900, interval: 'month', tax: 'exclusive', nickname: 'Team-Monthly', legacy: true },
  { env: 'STRIPE_PRICE_PRO_YEARLY', product: 'team_legacy', amount: 75600, interval: 'year', tax: 'exclusive', nickname: 'Team-Yearly', legacy: true },
]);

/** BW2026 coupons: seasonal-offer-server.ts checks amount_off against the yearly prices. */
export const COUPONS = Object.freeze([
  { id: 'BW2026_PERSONAL_Y1', name: 'Black Week first-year price', amount_off: 2740, currency: 'usd', duration: 'once', redeem_by: 1796191200 },
  { id: 'BW2026_PRO_Y1', name: 'Black Week first-year price', amount_off: 4500, currency: 'usd', duration: 'once', redeem_by: 1796191200 },
  // Staging only: internal test coupon behind the promotion code below.
  { id: 'STAGING_TEST_100', name: 'Staging test (100% off once)', percent_off: 100, duration: 'once' },
]);

export const PROMOTION_CODE = Object.freeze({ code: 'STAGINGTEST100', coupon: 'STAGING_TEST_100' });

/** EUR currency option a price should carry, or null. */
export function eurOptionFor(price, withEur) {
  if (price.eurAlways) return price.eurAlways;
  if (!withEur || price.legacy || price.noEur) return null;
  return { unit_amount: price.eurAmount ?? price.amount, tax_behavior: 'inclusive' };
}

/** USD tax_behavior a price should be created with. --with-eur mirrors prod after launch. */
export function taxBehaviorFor(price, withEur) {
  if (withEur && price.tax === 'unspecified' && eurOptionFor(price, withEur)) return 'exclusive';
  return price.tax;
}

/** Create params for a price (USD, plus EUR when wanted). */
export function priceCreateParams(price, productId, withEur) {
  const params = {
    product: productId,
    currency: 'usd',
    unit_amount: price.amount,
    tax_behavior: taxBehaviorFor(price, withEur),
    metadata: { ...(price.metadata ?? {}), staging_key: price.env },
  };
  if (price.interval) params.recurring = { interval: price.interval, interval_count: 1, usage_type: 'licensed' };
  if (price.nickname) params.nickname = price.nickname;
  if (price.lookup_key) params.lookup_key = price.lookup_key;
  const eur = eurOptionFor(price, withEur);
  if (eur) params.currency_options = { eur };
  return params;
}

/**
 * Compares an existing Stripe price with the spec. Returns
 * { drift: string[] } for immutable mismatches (a new price is needed) and
 * { update: object|null } for what a price update can still fix.
 */
export function planPriceReconcile(existing, price, withEur) {
  const drift = [];
  if (existing.currency !== 'usd') drift.push(`currency ${existing.currency}`);
  if (existing.unit_amount !== price.amount) drift.push(`unit_amount ${existing.unit_amount} != ${price.amount}`);
  const interval = existing.recurring?.interval ?? null;
  if (interval !== price.interval) drift.push(`interval ${interval} != ${price.interval}`);
  if ((existing.recurring?.interval_count ?? 1) !== 1) drift.push('interval_count != 1');

  const update = {};
  const wantTax = taxBehaviorFor(price, withEur);
  if (existing.tax_behavior !== wantTax) {
    if (existing.tax_behavior === 'unspecified') update.tax_behavior = wantTax;
    else drift.push(`tax_behavior ${existing.tax_behavior} != ${wantTax}`);
  }
  const wantEur = eurOptionFor(price, withEur);
  const haveEur = existing.currency_options?.eur ?? null;
  if (wantEur) {
    if (!haveEur) {
      update.currency_options = { eur: wantEur };
    } else if (haveEur.unit_amount !== wantEur.unit_amount || haveEur.tax_behavior !== wantEur.tax_behavior) {
      drift.push(
        `eur option ${haveEur.unit_amount}/${haveEur.tax_behavior} != ${wantEur.unit_amount}/${wantEur.tax_behavior}`,
      );
    }
  }
  if (!existing.active) update.active = true;
  return { drift, update: Object.keys(update).length ? update : null };
}

/** Events the endpoint lacks, so an existing endpoint can be topped up. */
export function missingWebhookEvents(enabled) {
  if (enabled.includes('*')) return [];
  return WEBHOOK_EVENTS.filter((event) => !enabled.includes(event));
}

/** Coupon fields that differ from the spec (coupons are immutable apart from name/metadata). */
export function couponDrift(existing, spec) {
  const fields = ['amount_off', 'currency', 'percent_off', 'duration', 'redeem_by'];
  return fields.filter((field) => (existing[field] ?? null) !== (spec[field] ?? null));
}

// ---------------------------------------------------------------------------
// Seed plan (PLAN.md section 10)
// ---------------------------------------------------------------------------

/** Domains test users may live on. No inbound mail, owned by us, not a person. */
export const SEED_TEST_DOMAINS = Object.freeze(['staging.mcpemails.com']);

/**
 * One row per seeded persona. `plan` is the workspaces.plan id (solo = Pro,
 * pro = Business). `priceEnv` = a real sandbox subscription on that price.
 */
export const PERSONAS = Object.freeze([
  { tier: 'free', plan: 'free', ageDays: 10 },
  { tier: 'grace', plan: 'free', ageDays: 0 },
  { tier: 'personal', plan: 'personal', priceEnv: 'STRIPE_PRICE_PERSONAL_MONTHLY_V2' },
  { tier: 'pro', plan: 'solo', priceEnv: 'STRIPE_PRICE_SOLO_MONTHLY' },
  { tier: 'business', plan: 'pro', priceEnv: 'STRIPE_PRICE_BUSINESS_MONTHLY' },
  { tier: 'pass', plan: 'personal', pass: true },
  { tier: 'admin', plan: 'free', admin: true },
]);

export function seedEmail(tier, domain) {
  if (!SEED_TEST_DOMAINS.includes(domain)) {
    throw new Error(`Refusing: ${domain} is not an allowlisted test domain (${SEED_TEST_DOMAINS.join(', ')}).`);
  }
  return `owner+${tier}@${domain}`;
}

/** The untagged address for internal_accounts (plus variants match in SQL). */
export function internalAccountEmail(domain) {
  if (!SEED_TEST_DOMAINS.includes(domain)) throw new Error(`Refusing: ${domain} is not a test domain.`);
  return `owner@${domain}`;
}

/** Switch states under test. Override any with --switch key=true|false. */
export const DEFAULT_PRICING_SWITCHES = Object.freeze({
  pro_inbox_cap: true,
  pro_features_public: true,
  business_founder_price: true,
  eur_launch_live: false,
});

/** Parses repeated `--switch key=true|false` flags over the defaults. */
export function resolveSwitches(argv, defaults = DEFAULT_PRICING_SWITCHES) {
  const out = { ...defaults };
  argv.forEach((arg, index) => {
    if (arg !== '--switch') return;
    const raw = argv[index + 1] ?? '';
    const match = /^([a-z0-9_]+)=(true|false|on|off)$/.exec(raw);
    if (!match) throw new Error(`Bad --switch value "${raw}": use key=true|false.`);
    out[match[1]] = match[2] === 'true' || match[2] === 'on';
  });
  return out;
}

/** Rollout flags turned on for the paid and admin personas so staging can test them. */
export const ROLLOUT_FLAGS = Object.freeze([
  'draft_editor_enabled',
  'web_client_enabled',
  'referral_enabled',
  'chat_send_confirm_enabled',
  'subscription_cleanup_enabled',
]);

export const API_KEY_NAME = 'staging-seed';
export const API_KEY_SCOPES = Object.freeze([
  'read:email',
  'search:email',
  'send:email',
  'manage:folders',
  'delete:email',
  'manage:drafts',
  'manage:contacts',
  'schedule:email',
  'manage:automations',
]);

export function apiKeyEnvName(tier) {
  return `STAGING_API_KEY_${tier.toUpperCase()}`;
}
