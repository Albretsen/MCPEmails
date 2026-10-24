/**
 * The EUR launch, run by itself: preflight, launch, then the legacy EU swap.
 * Called by POST /api/internal/eur-launch/dispatch (pg_cron, hourly from
 * 2026-12-07 00:00 Oslo for 14 days) and by
 * scripts/stripe-eur/eur-launch-preflight.mjs (read-only, by hand).
 *
 * WHY IT RUNS ITSELF. The owner is away more than he is at the keyboard, and
 * the launch had four manual steps on one morning (runbook, "Order on launch
 * day"). Each of them is now a step here, in the same order, and the launch
 * flag that turns EUR and Stripe Tax on for checkout (eur-launch.ts) is
 * written only at the end, after every step succeeded.
 *
 * ONE RUN, IN ORDER:
 *
 *   0. Before EUR_LAUNCH_AT: `outside_window`, nothing read.
 *   1. Flag already true: `already_live`, then only the swap (step 4), until
 *      a run finishes it and sets `eur_launch_swap_done`.
 *   2. PREFLIGHT, read-only, every check runs even after one fails so the
 *      alert lists all of them at once:
 *        tax_registrations  active `oss_non_union` AND an active Norway one
 *        webhook_events     one enabled endpoint carries the three SEPA events
 *                           (or '*'); the live endpoint may sit behind an
 *                           ingress proxy, so every enabled endpoint counts
 *        payment_methods    the configuration Checkout uses offers sepa_debit
 *        prices             every sold price, Pro V2 included, is the USD
 *                           price the catalogue says and either carries the
 *                           right EUR option already or none yet
 *      Any failure: nothing is written, ONE alert per Oslo day lists the
 *      failures and what to do, and the run returns `preflight_failed`. The
 *      next hourly run tries again, so a registration that lands on 12-10
 *      launches within the hour.
 *   3. LAUNCH, each step idempotent: add the EUR options and the missing USD
 *      tax_behavior, set product tax codes, THEN write the flag, THEN alert
 *      "EUR launch live". A failed Stripe write stops before the flag, alerts
 *      once a day and returns `launch_failed`; the next run redoes only what
 *      is still missing (an EUR option that went in is now "already right").
 *   4. LEGACY EU SWAP, only with the flag true: EU subscribers move to a USD
 *      inclusive twin of their price (created here when missing) with
 *      automatic tax on, at most `swapCap` per run and inside a time budget.
 *      A failure alerts once a day and never touches the flag: the swap keeps
 *      an amount the subscriber already pays, so a half-done swap is the old
 *      state for the rest, never a wrong charge.
 *
 * A currency option can never be removed or changed once added (runbook,
 * "Facts checked in test mode"), which is why step 2 refuses a price whose
 * existing option is wrong instead of "fixing" it, and why the rollback is
 * STRIPE_FORCE_USD in code, not anything here.
 *
 * No customer data leaves this module: alerts and reports carry counts,
 * check codes and price ids (account configuration), never a customer,
 * subscription or email. Plain Node TypeScript, relative imports only, so the
 * preflight script can load it with `node`.
 */

import {
  BILLING_STATUSES,
  EU_COUNTRIES,
  SOLD_PRICE_ENV,
  coveredCountries,
  customerCountry,
  isTwinOf,
  listAll,
  planPriceUpdate,
  planProductUpdate,
  planSwap,
  productIdOf,
  twinCreateParams,
  type StripeChargeLike,
  type StripeCustomerLike,
  type StripePriceLike,
  type StripeSubscriptionLike,
  type StripeTransport,
  type TaxRegistrationLike,
} from './eur-launch-plan.ts';
import { EUR_LAUNCH_AT, EUR_LAUNCH_FLAG_KEY, eurLaunchDatePassed } from './eur-launch-date.ts';
import { PRO_PRICE_CHANGE } from './pro-price-change.ts';
import { PLANS, founderPriceIdFor, mailboxAddonPriceId, priceTwinMap } from './plans.ts';

type Env = Record<string, string | undefined>;

export const EUR_LAUNCH_FLAG = EUR_LAUNCH_FLAG_KEY;
export const EUR_SWAP_DONE_FLAG = 'eur_launch_swap_done';
const ALERT_KEY_PREFIX = 'eur_launch_alert';

/** The three events a SEPA subscription needs the webhook to receive (plan 4.3). */
export const REQUIRED_WEBHOOK_EVENTS = [
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'charge.dispute.created',
] as const;

/** Where the launch keeps its state: rows in public.pricing_switches. */
export interface LaunchStore {
  /** The flag's value, false when the row is missing, null when unreadable. */
  readFlag(key: string): Promise<boolean | null>;
  writeFlag(key: string, enabled: boolean, note: string): Promise<void>;
  /** Claim one alert for (day, reason). True only for the first claim. */
  claimAlert(day: string, reason: string, note: string): Promise<boolean>;
}

export type AlertKind = 'preflight_failed' | 'launch_failed' | 'live' | 'swap_failed';
export interface LaunchAlert {
  kind: AlertKind;
  subject: string;
  lines: string[];
}
export type Notify = (alert: LaunchAlert) => Promise<void>;

export interface PreflightCheck {
  code: 'tax_registrations' | 'webhook_events' | 'payment_methods' | 'prices';
  ok: boolean;
  detail: string;
  fix: string;
}

export interface PricePlan {
  env: string;
  id: string;
  productId: string;
  params: Record<string, string> | null;
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
  /** Per sold price, the update step 3 would send (null: nothing to do). */
  pricePlans: PricePlan[];
  registrations: TaxRegistrationLike[];
}

export interface SwapReport {
  scanned: number;
  eu: number;
  swapped: number;
  twinsCreated: number;
  failed: number;
  skipped: Record<string, number>;
  /** True when the whole list was walked with nothing left to do. */
  complete: boolean;
  stoppedBy: 'cap' | 'time' | null;
}

export type DispatchMode =
  | 'outside_window'
  | 'already_live'
  | 'preflight_failed'
  | 'launch_failed'
  | 'launched'
  | 'dry_run'
  | 'error';

export interface DispatchReport {
  mode: DispatchMode;
  launchAt: string;
  failed?: string[];
  checks?: PreflightCheck[];
  changes?: { pricesUpdated: number; productsTagged: number };
  swap?: SwapReport | null;
  alerted?: AlertKind | null;
  error?: string;
}

/** YYYY-MM-DD in Oslo, the day an alert is deduplicated on. */
export function osloDay(now: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now));
}

/** The pricing_switches key an alert claim is stored under. */
export function alertKey(day: string, reason: string): string {
  return `${ALERT_KEY_PREFIX}:${day}:${reason}`;
}

/** Every MCPEmails price id, sold and legacy, plus every id in `ids`. */
export function catalogueIds(ids: Record<string, string>): Set<string> {
  const set = new Set<string>();
  for (const plan of Object.values(PLANS)) {
    for (const id of [plan.stripePriceIdMonthly, plan.stripePriceIdYearly, ...plan.legacyStripePriceIds]) {
      if (id) set.add(id);
    }
  }
  for (const id of [mailboxAddonPriceId('month'), mailboxAddonPriceId('year'), founderPriceIdFor('month'), founderPriceIdFor('year')]) {
    if (id) set.add(id);
  }
  for (const id of Object.values(ids)) set.add(id);
  return set;
}

/**
 * Whether the Pro V2 ($19) prices must exist for the launch. They are sold
 * from the day after (pro-price-change.ts), so yes, unless the Pro change was
 * called off with its kill switch (`announce` off and never live).
 */
export function proV2RequiredAtLaunch(change: { priceLive: boolean; announce: boolean } = PRO_PRICE_CHANGE): boolean {
  return change.priceLive || change.announce;
}

// ---------------------------------------------------------------------------
// Preflight (read-only)
// ---------------------------------------------------------------------------

interface WebhookEndpointLike {
  id: string;
  status?: string;
  enabled_events?: string[];
}

interface PaymentMethodConfigurationLike {
  id: string;
  active?: boolean;
  is_default?: boolean;
  parent?: string | null;
  sepa_debit?: { available?: boolean } | null;
}

function checkRegistrations(registrations: TaxRegistrationLike[]): PreflightCheck {
  const active = registrations.filter((r) => !r.status || r.status === 'active');
  const oss = active.some((r) => Object.values(r.country_options ?? {}).some((o) => o?.type === 'oss_non_union'));
  const norway = active.some((r) => (r.country ?? '').toUpperCase() === 'NO');
  const missing = [oss ? null : 'EU non-Union OSS (oss_non_union)', norway ? null : 'Norway'].filter(Boolean);
  return {
    code: 'tax_registrations',
    ok: oss && norway,
    detail: missing.length
      ? `missing active Stripe Tax registration: ${missing.join(' and ')} (${active.length} active in total)`
      : `oss_non_union and Norway active (${active.length} active in total)`,
    fix: 'Stripe Dashboard > Tax > Registrations: add the missing one with its real start date (OSS must be applied for by 2026-12-10). The next hourly run launches once it is active.',
  };
}

function checkWebhooks(endpoints: WebhookEndpointLike[]): PreflightCheck {
  const enabled = endpoints.filter((e) => e.status === 'enabled');
  let best: string[] = [...REQUIRED_WEBHOOK_EVENTS];
  for (const e of enabled) {
    const events = new Set(e.enabled_events ?? []);
    const missing = events.has('*') ? [] : REQUIRED_WEBHOOK_EVENTS.filter((name) => !events.has(name));
    if (missing.length < best.length) best = missing;
    if (!missing.length) break;
  }
  return {
    code: 'webhook_events',
    ok: best.length === 0,
    detail: best.length
      ? `no enabled webhook endpoint receives ${best.join(', ')} (${enabled.length} enabled endpoints checked)`
      : `an enabled endpoint receives all three SEPA events (${enabled.length} enabled endpoints checked)`,
    fix: `Stripe Dashboard > Developers > Webhooks: add ${REQUIRED_WEBHOOK_EVENTS.join(', ')} to the endpoint that delivers to mcpemails.com (the ingress endpoint if one forwards to us).`,
  };
}

function checkPaymentMethods(config: PaymentMethodConfigurationLike | null, pinned: string | null): PreflightCheck {
  const sepa = config?.sepa_debit?.available === true;
  const which = pinned ? `STRIPE_PMC_ID ${pinned}` : 'the default payment method configuration';
  return {
    code: 'payment_methods',
    ok: sepa,
    detail: !config
      ? `could not find ${which}`
      : sepa
        ? `${which} offers sepa_debit`
        : `${which} does not offer sepa_debit`,
    fix: 'Stripe Dashboard > Settings > Payment methods: turn SEPA Direct Debit on in the configuration Checkout uses (STRIPE_PMC_ID when set, else the default).',
  };
}

async function readPaymentMethodConfig(
  stripe: StripeTransport,
  pinned: string | null,
): Promise<PaymentMethodConfigurationLike | null> {
  if (pinned) {
    return stripe.request<PaymentMethodConfigurationLike>('GET', `/v1/payment_method_configurations/${pinned}`);
  }
  const all = await listAll<PaymentMethodConfigurationLike>(stripe, '/v1/payment_method_configurations');
  return all.find((c) => c.is_default === true && c.active !== false && !c.parent) ??
    all.find((c) => c.is_default === true) ??
    null;
}

export async function runPreflight({
  stripe,
  env,
}: {
  stripe: StripeTransport;
  env: Env;
}): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  let registrations: TaxRegistrationLike[] = [];

  // Each check is wrapped on its own: one unreadable endpoint is one failed
  // check, never a run that reports nothing about the other three.
  const guard = async (code: PreflightCheck['code'], fix: string, fn: () => Promise<PreflightCheck>) => {
    try {
      checks.push(await fn());
    } catch (err) {
      checks.push({ code, ok: false, detail: `could not be read: ${scrub(err)}`, fix });
    }
  };

  await guard('tax_registrations', 'Check STRIPE_SECRET_KEY can read Tax registrations.', async () => {
    registrations = await listAll<TaxRegistrationLike & { id: string }>(stripe, '/v1/tax/registrations', { status: 'active' });
    return checkRegistrations(registrations);
  });
  await guard('webhook_events', 'Check STRIPE_SECRET_KEY can read webhook endpoints.', async () =>
    checkWebhooks(await listAll<WebhookEndpointLike>(stripe, '/v1/webhook_endpoints')),
  );
  const pinned = env.STRIPE_PMC_ID?.trim() || null;
  await guard('payment_methods', 'Check STRIPE_PMC_ID and that the key can read payment method configurations.', async () =>
    checkPaymentMethods(await readPaymentMethodConfig(stripe, pinned), pinned),
  );

  const pricePlans: PricePlan[] = [];
  const priceProblems: string[] = [];
  const v2Required = proV2RequiredAtLaunch();
  for (const spec of SOLD_PRICE_ENV) {
    const id = env[spec.env]?.trim();
    if (!id) {
      if (!spec.optional || (spec.requiredAtLaunch && v2Required)) priceProblems.push(`${spec.env} is not set`);
      continue;
    }
    try {
      const price = await stripe.request<StripePriceLike>('GET', `/v1/prices/${id}`, { expand: ['currency_options'] });
      const { problems, params } = planPriceUpdate(price, spec);
      for (const p of problems) priceProblems.push(`${spec.env} ${id}: ${p}`);
      if (!problems.length) pricePlans.push({ env: spec.env, id, productId: productIdOf(price), params });
    } catch (err) {
      priceProblems.push(`${spec.env} ${id}: not retrievable (${scrub(err)})`);
    }
  }
  const toAdd = pricePlans.filter((p) => p.params).length;
  checks.push({
    code: 'prices',
    ok: priceProblems.length === 0,
    detail: priceProblems.length
      ? priceProblems.join('; ')
      : `${pricePlans.length} sold prices ready (${toAdd} get their EUR option at launch, ${pricePlans.length - toAdd} already have it)`,
    fix: 'Set the missing price env var in Vercel (Production), or point it at the price the catalogue sells. A wrong EUR option cannot be edited: create a new price with the right one and point the env var at it.',
  });

  return { ok: checks.every((c) => c.ok), checks, pricePlans, registrations };
}

// ---------------------------------------------------------------------------
// Launch (writes)
// ---------------------------------------------------------------------------

export async function applyCatalogue({
  stripe,
  plans,
  env,
}: {
  stripe: StripeTransport;
  plans: PricePlan[];
  env: Env;
}): Promise<{ pricesUpdated: number; productsTagged: number; failures: string[] }> {
  const failures: string[] = [];
  let pricesUpdated = 0;
  let productsTagged = 0;
  for (const plan of plans) {
    if (!plan.params) continue;
    try {
      await stripe.request('POST', `/v1/prices/${plan.id}`, plan.params, {
        idempotencyKey: `eur-opt-${plan.id}-${Object.keys(plan.params).join('-')}`,
      });
      pricesUpdated++;
    } catch (err) {
      failures.push(`price ${plan.env} ${plan.id}: ${scrub(err)}`);
    }
  }

  // Products: every product behind a sold or legacy MCPEmails price, because
  // legacy subscriptions get automatic tax too after the swap.
  const productIds = new Set(plans.map((p) => p.productId).filter(Boolean));
  const sold = new Set(plans.map((p) => p.id));
  for (const id of catalogueIds(priceIdsOf(env))) {
    if (sold.has(id)) continue;
    try {
      const price = await stripe.request<StripePriceLike>('GET', `/v1/prices/${id}`);
      const productId = productIdOf(price);
      if (productId) productIds.add(productId);
    } catch {
      // A legacy id hardcoded in plans.ts that this account cannot read (the
      // other mode's id): nothing bills on it here, so nothing to tag.
    }
  }
  for (const productId of productIds) {
    try {
      const product = await stripe.request<{ tax_code?: string | { id: string } | null }>('GET', `/v1/products/${productId}`);
      const params = planProductUpdate(product);
      if (!params) continue;
      await stripe.request('POST', `/v1/products/${productId}`, params);
      productsTagged++;
    } catch (err) {
      failures.push(`product ${productId}: ${scrub(err)}`);
    }
  }
  return { pricesUpdated, productsTagged, failures };
}

function priceIdsOf(env: Env): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const spec of SOLD_PRICE_ENV) {
    const v = env[spec.env]?.trim();
    if (v) ids[spec.env] = v;
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Legacy EU swap (writes, paged)
// ---------------------------------------------------------------------------

/** Run `fn` over `items`, `width` at a time. */
async function pool<T>(items: T[], width: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function runLegacySwap({
  stripe,
  env,
  registrations,
  swapCap,
  deadline,
  clock = Date.now,
}: {
  stripe: StripeTransport;
  env: Env;
  registrations: TaxRegistrationLike[];
  swapCap: number;
  /** Epoch ms after which no new swap starts. */
  deadline: number;
  clock?: () => number;
}): Promise<SwapReport> {
  const report: SwapReport = { scanned: 0, eu: 0, swapped: 0, twinsCreated: 0, failed: 0, skipped: {}, complete: false, stoppedBy: null };
  const bump = (reason: string) => {
    report.skipped[reason] = (report.skipped[reason] ?? 0) + 1;
  };
  const covered = coveredCountries(registrations);
  if (!registrations.length) {
    // The flag is only ever set after the registrations check passed, so this
    // means they were removed since. Swap nothing: automatic tax on a
    // subscription in a country with no registration would fail.
    bump('no_registrations');
    return report;
  }

  const catalogue = catalogueIds(priceIdsOf(env));
  const originalByTwin = new Map<string, string>(priceTwinMap());
  const twinByOriginal = new Map<string, string>();
  for (const [twin, original] of originalByTwin) twinByOriginal.set(original, twin);

  const subs: StripeSubscriptionLike[] = [];
  for (const status of BILLING_STATUSES) {
    subs.push(...(await listAll<StripeSubscriptionLike>(stripe, '/v1/subscriptions', {
      status,
      expand: ['data.customer', 'data.customer.tax'],
    })));
  }

  // Learn twins already on subscriptions (metadata.twin_of), so a twin made
  // by an earlier run is reused even with no STRIPE_PRICE_TWINS set.
  for (const sub of subs) {
    for (const it of sub.items?.data ?? []) {
      const original = it.price?.metadata?.twin_of;
      if (it.price?.id && original && catalogue.has(original)) {
        originalByTwin.set(it.price.id, original);
        twinByOriginal.set(original, it.price.id);
      }
    }
  }

  const mine = subs.filter((s) =>
    (s.items?.data ?? []).some((it) => catalogue.has(it.price?.id ?? '') || originalByTwin.has(it.price?.id ?? '')),
  );
  report.scanned = mine.length;

  // Cheap first pass: a subscription already on twins with tax on needs no
  // charge lookup at all, which keeps every later hourly run short.
  const pending = mine.filter((sub) => planSwap(sub, { twinByOriginal, originalByTwin, catalogue }).reason !== 'already_done');
  report.skipped.already_done = mine.length - pending.length;
  if (report.skipped.already_done === 0) delete report.skipped.already_done;

  // Country per pending subscription: the latest succeeded charge first, as
  // the scripts do (lib.mjs loadBillingSubscriptions). Eight at a time.
  const countryOf = new Map<string, string | null>();
  const chargeByCustomer = new Map<string, StripeChargeLike | null>();
  const customerIds = [...new Set(pending.map((s) => customerIdOf(s)).filter((id): id is string => !!id))];
  await pool(customerIds, 8, async (customerId) => {
    if (clock() > deadline) return;
    try {
      const charges = await stripe.request<{ data: StripeChargeLike[] }>('GET', '/v1/charges', { customer: customerId, limit: 10 });
      chargeByCustomer.set(customerId, charges.data.find((c) => c.status === 'succeeded') ?? null);
    } catch {
      chargeByCustomer.set(customerId, null);
    }
  });
  for (const sub of pending) {
    const customer = typeof sub.customer === 'object' ? sub.customer : null;
    const charge = chargeByCustomer.get(customerIdOf(sub) ?? '') ?? null;
    countryOf.set(sub.id, customerCountry({ charge, customer }).country);
  }

  const twinFor = async (priceId: string): Promise<string | null> => {
    const known = twinByOriginal.get(priceId);
    if (known) return known;
    const price = await stripe.request<StripePriceLike>('GET', `/v1/prices/${priceId}`);
    if (price.tax_behavior === 'inclusive') return null;
    const siblings = await listAll<StripePriceLike>(stripe, '/v1/prices', { product: productIdOf(price), active: 'true' });
    const existing = siblings.find((p) => isTwinOf(p, price));
    let twinId = existing?.id ?? null;
    if (!twinId) {
      const created = await stripe.request<StripePriceLike>('POST', '/v1/prices', twinCreateParams(price), {
        idempotencyKey: `eu-twin-${priceId}`,
      });
      twinId = created.id;
      report.twinsCreated++;
    }
    twinByOriginal.set(priceId, twinId);
    originalByTwin.set(twinId, priceId);
    return twinId;
  };

  let cut: SwapReport['stoppedBy'] = null;
  for (const sub of pending) {
    if (report.swapped >= swapCap) {
      cut = 'cap';
      break;
    }
    if (clock() > deadline) {
      cut = 'time';
      break;
    }
    if (!chargeByCustomer.has(customerIdOf(sub) ?? '') && customerIdOf(sub)) {
      // The charge lookup ran out of time before this customer.
      cut = 'time';
      break;
    }
    const country = countryOf.get(sub.id) ?? null;
    if (!country || !EU_COUNTRIES.has(country)) {
      bump(country ? 'not_eu' : 'country_unknown');
      continue;
    }
    report.eu++;
    if (!covered.has(country)) {
      bump('country_not_registered');
      continue;
    }
    const customer = typeof sub.customer === 'object' ? sub.customer : null;
    const automaticTax = customer?.tax?.automatic_tax ?? 'unknown';
    if (automaticTax !== 'supported') {
      bump(`tax_location_${automaticTax}`);
      continue;
    }
    if (sub.schedule) {
      bump('has_schedule');
      continue;
    }
    try {
      for (const it of sub.items?.data ?? []) {
        const id = it.price?.id;
        if (id && !originalByTwin.has(id) && !twinByOriginal.has(id)) await twinFor(id);
      }
    } catch (err) {
      report.failed++;
      console.error('[eur-launch] twin creation failed', scrub(err));
      continue;
    }
    const plan = planSwap(sub, { twinByOriginal, originalByTwin, catalogue });
    if (plan.action === 'skip') {
      bump(plan.reason ?? 'skipped');
      continue;
    }
    const params: Record<string, string> = { proration_behavior: 'none', 'automatic_tax[enabled]': 'true' };
    (plan.items ?? []).forEach((it, i) => {
      params[`items[${i}][id]`] = it.id;
      params[`items[${i}][price]`] = it.price;
    });
    try {
      await stripe.request('POST', `/v1/subscriptions/${sub.id}`, params, {
        idempotencyKey: `eu-swap-${sub.id}-${(plan.items ?? []).map((it) => it.price).join('-')}`,
      });
      report.swapped++;
    } catch (err) {
      report.failed++;
      console.error('[eur-launch] a swap failed', scrub(err));
    }
  }
  report.stoppedBy = cut;
  report.complete = cut === null && report.failed === 0;
  return report;
}

function customerIdOf(sub: StripeSubscriptionLike): string | null {
  if (typeof sub.customer === 'string') return sub.customer;
  return (sub.customer as StripeCustomerLike | null | undefined)?.id ?? null;
}

/** An error message with any customer or subscription id taken out. */
export function scrub(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/(sub|cus|ch|pi|in|si)_[A-Za-z0-9]+/g, '<id>').slice(0, 300);
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export function preflightAlert(checks: PreflightCheck[], day: string): LaunchAlert {
  const failed = checks.filter((c) => !c.ok);
  return {
    kind: 'preflight_failed',
    subject: `EUR launch is waiting: ${failed.length} check${failed.length === 1 ? '' : 's'} failed`,
    lines: [
      `The EUR launch did not turn on today (${day}). Nothing was changed in Stripe or in the app; checkout still sells USD without Stripe Tax.`,
      'It retries every hour until 14 days after 2026-12-07 and launches by itself once every check passes. This email is sent at most once a day.',
      '',
      ...failed.flatMap((c) => [`FAILED ${c.code}: ${c.detail}`, `  What to do: ${c.fix}`]),
      '',
      ...checks.filter((c) => c.ok).map((c) => `ok ${c.code}: ${c.detail}`),
      '',
      'Runbook: docs/RUNBOOK-eur-launch.md',
    ],
  };
}

export function launchFailedAlert(failures: string[], day: string): LaunchAlert {
  return {
    kind: 'launch_failed',
    subject: 'EUR launch stopped part way: a Stripe write failed',
    lines: [
      `Every preflight check passed today (${day}), but a Stripe write failed, so the launch flag was NOT set: checkout still sells USD without Stripe Tax.`,
      'Euro-area buyers may already see EUR on any price whose EUR option went in. The next hourly run retries only what is missing. If it keeps failing, set STRIPE_FORCE_USD=true in Vercel and redeploy.',
      '',
      ...failures.map((f) => `FAILED ${f}`),
      '',
      'Runbook: docs/RUNBOOK-eur-launch.md',
    ],
  };
}

export function liveAlert({
  checks,
  changes,
  swap,
}: {
  checks: PreflightCheck[];
  changes: { pricesUpdated: number; productsTagged: number };
  swap: SwapReport | null;
}): LaunchAlert {
  return {
    kind: 'live',
    subject: 'EUR launch live: EUR prices, Stripe Tax and SEPA are on',
    lines: [
      'Every preflight check passed and every Stripe step succeeded. EU visitors now see and pay EUR with VAT included, Checkout runs Stripe Tax, and SEPA Direct Debit is offered.',
      `Prices given an EUR option now: ${changes.pricesUpdated}. Products given a tax code: ${changes.productsTagged}.`,
      ...(swap ? [`Legacy EU swap, first run: ${swapLine(swap)}`] : []),
      '',
      ...checks.map((c) => `ok ${c.code}: ${c.detail}`),
      '',
      'Next: one live EUR checkout on a test workspace, then refund it (runbook, launch day step 3).',
      'Rollback: STRIPE_FORCE_USD=true in Vercel (Production) and redeploy. Currency options cannot be removed.',
    ],
  };
}

export function swapFailedAlert(swap: SwapReport, day: string): LaunchAlert {
  return {
    kind: 'swap_failed',
    subject: `EUR launch: ${swap.failed} legacy EU swap${swap.failed === 1 ? '' : 's'} failed`,
    lines: [
      `The EUR launch is live. Moving existing EU subscribers onto VAT-inclusive twin prices had failures today (${day}).`,
      'A subscription that was not moved keeps billing exactly as before. The launch stays on; the next hourly run retries.',
      '',
      swapLine(swap),
      '',
      'Details are in the Vercel logs for /api/internal/eur-launch/dispatch (ids redacted).',
    ],
  };
}

function swapLine(swap: SwapReport): string {
  return `scanned ${swap.scanned}, EU ${swap.eu}, swapped ${swap.swapped}, twins created ${swap.twinsCreated}, failed ${swap.failed}, skipped ${JSON.stringify(swap.skipped)}${swap.stoppedBy ? `, stopped by ${swap.stoppedBy} (continues next run)` : ''}`;
}

// ---------------------------------------------------------------------------
// The dispatcher run
// ---------------------------------------------------------------------------

export async function runEurLaunchDispatch({
  stripe,
  store,
  notify,
  env,
  now = Date.now(),
  dryRun = false,
  swapCap = 25,
  timeBudgetMs = 40_000,
  clock = Date.now,
}: {
  stripe: StripeTransport;
  store: LaunchStore;
  notify: Notify;
  env: Env;
  now?: number;
  dryRun?: boolean;
  swapCap?: number;
  timeBudgetMs?: number;
  clock?: () => number;
}): Promise<DispatchReport> {
  const base = { launchAt: EUR_LAUNCH_AT };
  const day = osloDay(now);
  const deadline = clock() + timeBudgetMs;

  // A dry run is allowed before the date: it is how the preflight is checked
  // against live Stripe ahead of time. It writes nothing and alerts nobody.
  if (dryRun) {
    const pre = await runPreflight({ stripe, env });
    return { ...base, mode: 'dry_run', failed: pre.checks.filter((c) => !c.ok).map((c) => c.code), checks: pre.checks };
  }
  if (!eurLaunchDatePassed(now)) return { ...base, mode: 'outside_window' };

  const flag = await store.readFlag(EUR_LAUNCH_FLAG);
  if (flag === null) return { ...base, mode: 'error', error: 'flag_unreadable' };

  const alertOnce = async (alert: LaunchAlert): Promise<AlertKind | null> => {
    const claimed = await store.claimAlert(day, alert.kind, alert.subject);
    if (!claimed) return null;
    await notify(alert);
    return alert.kind;
  };

  const swapPhase = async (registrations: TaxRegistrationLike[]): Promise<{ swap: SwapReport | null; alerted: AlertKind | null }> => {
    const done = await store.readFlag(EUR_SWAP_DONE_FLAG);
    if (done === true) return { swap: null, alerted: null };
    const swap = await runLegacySwap({ stripe, env, registrations, swapCap, deadline, clock });
    let alerted: AlertKind | null = null;
    if (swap.failed > 0) alerted = await alertOnce(swapFailedAlert(swap, day));
    if (swap.complete) {
      await store.writeFlag(EUR_SWAP_DONE_FLAG, true, `Legacy EU swap finished ${new Date(now).toISOString()}.`);
    }
    return { swap, alerted };
  };

  if (flag === true) {
    const registrations = await listAll<TaxRegistrationLike & { id: string }>(stripe, '/v1/tax/registrations', { status: 'active' });
    const { swap, alerted } = await swapPhase(registrations);
    return { ...base, mode: 'already_live', swap, alerted };
  }

  const pre = await runPreflight({ stripe, env });
  if (!pre.ok) {
    const alerted = await alertOnce(preflightAlert(pre.checks, day));
    return { ...base, mode: 'preflight_failed', failed: pre.checks.filter((c) => !c.ok).map((c) => c.code), checks: pre.checks, alerted };
  }

  const applied = await applyCatalogue({ stripe, plans: pre.pricePlans, env });
  const changes = { pricesUpdated: applied.pricesUpdated, productsTagged: applied.productsTagged };
  if (applied.failures.length) {
    const alerted = await alertOnce(launchFailedAlert(applied.failures, day));
    return { ...base, mode: 'launch_failed', failed: applied.failures, checks: pre.checks, changes, alerted };
  }

  await store.writeFlag(EUR_LAUNCH_FLAG, true, `Set by the EUR launch dispatcher ${new Date(now).toISOString()} after a passing preflight.`);
  const { swap, alerted: swapAlert } = await swapPhase(pre.registrations);
  const alerted = await alertOnce(liveAlert({ checks: pre.checks, changes, swap }));
  return { ...base, mode: 'launched', checks: pre.checks, changes, swap, alerted: alerted ?? swapAlert };
}
