// node --test scripts/staging-lib.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CONTENT_MAILBOX,
  COUPONS,
  PERSONAS,
  PRICES,
  PRODUCTS,
  SEED_INBOXES,
  WEBHOOK_EVENTS,
  assertStagingAccount,
  assertStagingAppUrl,
  assertStagingMailbox,
  assertStagingSupabase,
  assertTestKey,
  couponDrift,
  eurOptionFor,
  formEncode,
  imapConnectBody,
  internalAccountEmail,
  mailboxContentEnv,
  missingWebhookEvents,
  parseEnv,
  planPriceReconcile,
  priceCreateParams,
  resolveSwitches,
  seedAllowlist,
  seedEmail,
  supabaseSessionCookie,
  upsertEnvText,
  writeEnvFile,
} from './staging-lib.mjs';

const hasPython = spawnSync('python3', ['--version']).status === 0;

test('refuses live and malformed Stripe keys', () => {
  assert.doesNotThrow(() => assertTestKey('sk_test_abc123'));
  assert.doesNotThrow(() => assertTestKey('rk_test_abc123'));
  for (const bad of ['sk_live_abc', 'rk_live_abc', 'pk_test_abc', '', undefined, 'sk_test_']) {
    assert.throws(() => assertTestKey(bad), /test-mode key/);
  }
});

test('refuses any Stripe account but the sandbox', () => {
  assert.doesNotThrow(() => assertStagingAccount('acct_1UUs5wPI08gnOkR5'));
  assert.throws(() => assertStagingAccount('acct_1TXNSxSOMETHING'), /not the staging sandbox/);
  assert.throws(() => assertStagingAccount(undefined), /not the staging sandbox/);
});

test('refuses any Supabase project but staging, including look-alike hosts', () => {
  assert.doesNotThrow(() => assertStagingSupabase('https://wwsstwvvkjfqmuuasecu.supabase.co'));
  for (const bad of [
    'https://swvaxorwumispmjaaszb.supabase.co',
    'https://wwsstwvvkjfqmuuasecu.supabase.co.evil.example',
    'https://evil.example/?wwsstwvvkjfqmuuasecu',
    'not a url',
    undefined,
  ]) {
    assert.throws(() => assertStagingSupabase(bad), /not the staging project/);
  }
});

test('webhook subscribes to the 14 handled events, including the ones prod lacks', () => {
  assert.equal(WEBHOOK_EVENTS.length, 14);
  assert.equal(new Set(WEBHOOK_EVENTS).size, 14);
  for (const event of ['checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'invoice.paid', 'charge.dispute.created']) {
    assert.ok(WEBHOOK_EVENTS.includes(event), event);
  }
  assert.deepEqual(missingWebhookEvents(['*']), []);
  assert.deepEqual(missingWebhookEvents(WEBHOOK_EVENTS.filter((e) => e !== 'invoice.paid')), ['invoice.paid']);
});

test('the route handles exactly the events the endpoint subscribes to', () => {
  const route = readFileSync(new URL('../apps/web/app/api/stripe/webhook/route.ts', import.meta.url), 'utf8');
  const handled = [...route.matchAll(/case '([a-z_.]+)':/g)].map((m) => m[1]).filter((e) => e.includes('.'));
  assert.deepEqual([...new Set(handled)].sort(), [...WEBHOOK_EVENTS].sort());
});

test('catalog covers every STRIPE_PRICE_* env the web app reads, once each', () => {
  const envs = PRICES.map((p) => p.env);
  assert.equal(new Set(envs).size, envs.length);
  assert.equal(envs.length, 18);
  for (const price of PRICES) assert.ok(PRODUCTS.some((p) => p.key === price.product), price.env);
  const sources = ['plans.ts', 'eur-launch-plan.ts'].map((file) =>
    readFileSync(new URL(`../apps/web/src/lib/stripe/${file}`, import.meta.url), 'utf8'),
  );
  const read = new Set(sources.flatMap((src) => [...src.matchAll(/STRIPE_PRICE_[A-Z0-9_]*[A-Z0-9]\b/g)].map((m) => m[0])));
  read.delete('STRIPE_PRICE_TWINS'); // a JSON map, stays unset in staging
  for (const name of read) assert.ok(envs.includes(name), `${name} is read by the app but not in the catalog`);
});

test('BW coupons match the yearly prices the offer checks', () => {
  const yearly = (env) => PRICES.find((p) => p.env === env).amount;
  const coupon = (id) => COUPONS.find((c) => c.id === id);
  assert.equal(yearly('STRIPE_PRICE_PERSONAL_YEARLY_V2') - coupon('BW2026_PERSONAL_Y1').amount_off, 5900);
  assert.equal(yearly('STRIPE_PRICE_SOLO_YEARLY') - coupon('BW2026_PRO_Y1').amount_off, 9900);
  assert.equal(coupon('BW2026_PRO_Y1').redeem_by, 1796191200);
});

test('EUR options: prod today without --with-eur, launch rule with it', () => {
  const byEnv = (env) => PRICES.find((p) => p.env === env);
  assert.equal(eurOptionFor(byEnv('STRIPE_PRICE_SOLO_MONTHLY'), false), null);
  assert.deepEqual(eurOptionFor(byEnv('STRIPE_PRICE_SOLO_MONTHLY'), true), { unit_amount: 1500, tax_behavior: 'inclusive' });
  assert.deepEqual(eurOptionFor(byEnv('STRIPE_PRICE_JAPAN_ROUTE_YEARLY'), true), { unit_amount: 10800, tax_behavior: 'inclusive' });
  assert.equal(eurOptionFor(byEnv('STRIPE_PRICE_PERSONAL_PASS_3M'), true), null);
  assert.equal(eurOptionFor(byEnv('STRIPE_PRICE_PRO_MONTHLY'), true), null);
  // Founder prices carry an exclusive EUR option in prod already.
  assert.deepEqual(eurOptionFor(byEnv('STRIPE_PRICE_BUSINESS_FOUNDER_MONTHLY'), false), { unit_amount: 2900, tax_behavior: 'exclusive' });
});

test('price create params mirror the spec', () => {
  const spec = PRICES.find((p) => p.env === 'STRIPE_PRICE_BUSINESS_YEARLY');
  const today = priceCreateParams(spec, 'prod_x', false);
  assert.equal(today.tax_behavior, 'unspecified');
  assert.equal(today.currency_options, undefined);
  assert.deepEqual(today.recurring, { interval: 'year', interval_count: 1, usage_type: 'licensed' });
  assert.equal(today.metadata.staging_key, 'STRIPE_PRICE_BUSINESS_YEARLY');
  const launched = priceCreateParams(spec, 'prod_x', true);
  assert.equal(launched.tax_behavior, 'exclusive');
  assert.deepEqual(launched.currency_options, { eur: { unit_amount: 37440, tax_behavior: 'inclusive' } });
  const pass = priceCreateParams(PRICES.find((p) => p.env === 'STRIPE_PRICE_PERSONAL_PASS_3M'), 'prod_p', false);
  assert.equal(pass.recurring, undefined);
});

test('reconcile: immutable drift fails, EUR and unspecified tax are updatable', () => {
  const spec = PRICES.find((p) => p.env === 'STRIPE_PRICE_BUSINESS_MAILBOX_MONTHLY');
  const base = { currency: 'usd', unit_amount: 300, recurring: { interval: 'month', interval_count: 1 }, tax_behavior: 'unspecified', active: true };
  assert.deepEqual(planPriceReconcile(base, spec, false), { drift: [], update: null });
  assert.deepEqual(planPriceReconcile(base, spec, true).update, {
    tax_behavior: 'exclusive',
    currency_options: { eur: { unit_amount: 300, tax_behavior: 'inclusive' } },
  });
  assert.equal(planPriceReconcile({ ...base, unit_amount: 400 }, spec, false).drift.length, 1);
  const wrongEur = { ...base, tax_behavior: 'exclusive', currency_options: { eur: { unit_amount: 299, tax_behavior: 'inclusive' } } };
  assert.equal(planPriceReconcile(wrongEur, spec, true).drift.length, 1);
  assert.deepEqual(planPriceReconcile({ ...base, active: false }, spec, false).update, { active: true });
});

test('coupon drift', () => {
  const spec = COUPONS[0];
  assert.deepEqual(couponDrift({ ...spec, valid: true }, spec), []);
  assert.deepEqual(couponDrift({ ...spec, amount_off: 1 }, spec), ['amount_off']);
});

test('form encoding uses Stripe bracket syntax', () => {
  const body = formEncode({ a: 1, items: [{ price: 'p' }], meta: { k: 'v' }, list: ['x', 'y'], skip: undefined, empty: null });
  assert.equal(
    decodeURIComponent(body.toString()),
    'a=1&items[0][price]=p&meta[k]=v&list[0]=x&list[1]=y&empty=',
  );
});

test('env upsert replaces in place, appends new, keeps comments', () => {
  const before = '# secrets\nA=1\nB="two"\n';
  assert.equal(upsertEnvText(before, { B: '3', C: '4' }), '# secrets\nA=1\nB=3\nC=4\n');
  assert.equal(upsertEnvText('', { A: '1' }), 'A=1\n');
  assert.deepEqual(parseEnv(before), { A: '1', B: 'two' });
});

test('env file stays chmod 600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'staging-lib-'));
  const path = join(dir, 'staging.env');
  writeFileSync(path, 'A=1\n', { mode: 0o644 });
  writeEnvFile(path, { B: '2' });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, 'utf8'), 'A=1\nB=2\n');
});

test('seed personas are plus-addresses of a staging test mailbox only', () => {
  assert.equal(seedEmail('pro'), 'staging-a+pro@mcpemails.com');
  assert.equal(internalAccountEmail(), 'staging-a@mcpemails.com');
  assert.equal(seedEmail('pro', 'staging-b+<tier>@mcpemails.com'), 'staging-b+pro@mcpemails.com');
  assert.equal(seedEmail('pro', 'owner+<tier>@staging.mcpemails.com'), 'owner+pro@staging.mcpemails.com');
  assert.equal(internalAccountEmail('owner+<tier>@staging.mcpemails.com'), 'owner@staging.mcpemails.com');
  for (const bad of [
    'demo+<tier>@mcpemails.com',
    'hello+<tier>@mcpemails.com',
    'staging-a+<tier>@gmail.com',
    'staging-a+<tier>@mcpemails.com.evil.com',
    'staging-a@mcpemails.com',
    'staging-a+<tier>+x@mcpemails.com',
    '',
    null,
  ]) {
    assert.throws(() => seedEmail('pro', bad), /Refusing/, String(bad));
  }
  assert.throws(() => seedEmail('Pro x'), /bad persona tier/);
  const tiers = PERSONAS.map((p) => p.tier);
  for (const tier of ['free', 'personal', 'pro', 'business', 'pass', 'grace', 'admin']) assert.ok(tiers.includes(tier), tier);
  assert.equal(PERSONAS.filter((p) => p.admin).length, 1);
  for (const persona of PERSONAS.filter((p) => p.priceEnv)) {
    assert.ok(PRICES.some((price) => price.env === persona.priceEnv), persona.priceEnv);
  }
});

test('seed allowlist lists every persona exactly, plus both test mailboxes', () => {
  const list = seedAllowlist();
  assert.equal(list.length, PERSONAS.length + 2);
  for (const persona of PERSONAS) assert.ok(list.includes(`staging-a+${persona.tier}@mcpemails.com`), persona.tier);
  assert.ok(list.includes('staging-a@mcpemails.com'));
  assert.ok(list.includes('staging-b@mcpemails.com'));
  assert.ok(list.every((address) => !address.startsWith('@')), 'no domain entries');
});

test('inbox step only targets the staging Migadu mailboxes', () => {
  assert.deepEqual(SEED_INBOXES.map((i) => i.email), ['staging-a@mcpemails.com', 'staging-b@mcpemails.com']);
  const body = imapConnectBody('Staging-B@mcpemails.com', 'pw');
  assert.equal(body.email, 'staging-b@mcpemails.com');
  assert.equal(body.imapHost, 'imap.migadu.com');
  assert.equal(body.imapPort, 993);
  assert.equal(body.smtpHost, 'smtp.migadu.com');
  assert.equal(body.smtpPort, 465);
  assert.equal(body.mode, 'both');
  for (const bad of ['demo@mcpemails.com', 'hello@harborknowledge.com', 'staging-a+pro@mcpemails.com', '']) {
    assert.throws(() => imapConnectBody(bad, 'pw'), /Refusing/, bad);
  }
  assert.throws(() => imapConnectBody('staging-a@mcpemails.com', ''), /No password/);
  assert.throws(() => assertStagingMailbox('staging-b@mcpemails.com', 'imap.gmail.com'), /Refusing/);
  assert.equal(CONTENT_MAILBOX, 'staging-b@mcpemails.com');
  const childEnv = mailboxContentEnv({ PATH: '/bin', REVIEWER_IMAP_PASSWORD: 'x' }, CONTENT_MAILBOX, 'pw');
  assert.equal(childEnv.MAILBOX_SEED_USER, 'staging-b@mcpemails.com');
  assert.equal(childEnv.MAILBOX_SEED_HOST, 'imap.migadu.com');
  assert.equal(childEnv.MAILBOX_SEED_PASSWORD, 'pw');
  assert.equal(childEnv.REVIEWER_IMAP_PASSWORD, undefined);
  assert.throws(() => mailboxContentEnv({}, 'demo@mcpemails.com', 'pw'), /Refusing/);
});

test('inbox step posts to the staging app only', () => {
  assert.doesNotThrow(() => assertStagingAppUrl('https://staging.mcpemails.com'));
  assert.doesNotThrow(() => assertStagingAppUrl('https://staging.mcpemails.com/'));
  for (const bad of ['https://mcpemails.com', 'https://staging.mcpemails.com.evil.com', 'http://staging.mcpemails.com', '', undefined]) {
    assert.throws(() => assertStagingAppUrl(bad), /Refusing/, String(bad));
  }
});

test('session cookie matches the @supabase/ssr shape and chunks long values', () => {
  const url = 'https://wwsstwvvkjfqmuuasecu.supabase.co';
  const short = supabaseSessionCookie(url, { a: 1 });
  assert.match(short, /^sb-wwsstwvvkjfqmuuasecu-auth-token=base64-/);
  const value = short.split('=').slice(1).join('=');
  assert.deepEqual(JSON.parse(Buffer.from(value.slice(7), 'base64url').toString()), { a: 1 });
  const long = supabaseSessionCookie(url, { t: 'x'.repeat(5000) });
  assert.match(long, /^sb-wwsstwvvkjfqmuuasecu-auth-token\.0=base64-.*; sb-wwsstwvvkjfqmuuasecu-auth-token\.1=/);
});

test('seed-reviewer-mailbox.py refuses every mailbox but the staging ones before connecting', { skip: !hasPython }, () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'seed-reviewer-mailbox.py');
  const run = (extra) =>
    spawnSync('python3', [script, '--check'], {
      env: { PATH: process.env.PATH, ...extra },
      encoding: 'utf8',
    });
  for (const user of ['demo@mcpemails.com', 'DEMO@mcpemails.com', 'hello@mcpemails.com', 'someone@gmail.com', 'staging-a+pro@mcpemails.com']) {
    const result = run({ MAILBOX_SEED_USER: user });
    assert.notEqual(result.status, 0, user);
    assert.match(result.stderr, /Refusing/, user);
  }
  const wrongHost = run({ MAILBOX_SEED_USER: 'staging-b@mcpemails.com', MAILBOX_SEED_HOST: 'imap.gmail.com' });
  assert.notEqual(wrongHost.status, 0);
  assert.match(wrongHost.stderr, /Refusing/);
  const ok = run({ MAILBOX_SEED_USER: 'staging-b@mcpemails.com', MAILBOX_SEED_HOST: 'imap.migadu.com' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /target ok: staging-b@mcpemails\.com on imap\.migadu\.com/);
});

test('switch overrides', () => {
  const out = resolveSwitches(['--apply', '--switch', 'pro_inbox_cap=false', '--switch', 'eur_launch_live=on']);
  assert.equal(out.pro_inbox_cap, false);
  assert.equal(out.eur_launch_live, true);
  assert.equal(out.pro_features_public, true);
  assert.throws(() => resolveSwitches(['--switch', 'nope']), /Bad --switch/);
});
