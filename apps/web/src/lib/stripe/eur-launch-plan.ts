/**
 * The Stripe-side planning for the EUR launch, shared by the launch scripts
 * (scripts/stripe-eur/, run by hand with plain `node`) and the launch
 * dispatcher (app/api/internal/eur-launch/dispatch, run by pg_cron).
 *
 * WHY ONE MODULE FOR BOTH. The scripts were written first (PR #269) and were
 * the only way to add the EUR currency options. The launch now runs by itself
 * on its date, and a currency option can never be removed or changed once it
 * is added (docs/RUNBOOK-eur-launch.md). Two copies of "what does this price
 * need" would be two chances to add a wrong, permanent EUR amount. So the rule
 * lives here once and both callers import it.
 *
 * WHY NO STRIPE SDK. The scripts run under plain `node` and must not depend on
 * the SDK's pinned API version, so everything here speaks a three-argument
 * transport, `request(method, path, params)`, against the REST API. The
 * dispatcher builds the same fetch transport from STRIPE_SECRET_KEY; tests
 * hand in a fake one.
 *
 * Plain Node TypeScript (erasable syntax only, relative imports with their
 * extension, no `@/` alias) so `node` can load it without a bundler.
 */

/** Loose shapes of the Stripe objects read here. Only the fields we use. */
export interface StripePriceLike {
  object?: string;
  id: string;
  active?: boolean;
  currency?: string;
  unit_amount?: number | null;
  tax_behavior?: string | null;
  product?: string | { id: string };
  nickname?: string | null;
  recurring?: { interval?: string; interval_count?: number; usage_type?: string } | null;
  metadata?: Record<string, string> | null;
  currency_options?: Record<string, { unit_amount?: number | null; tax_behavior?: string | null }> | null;
}

export interface StripeSubscriptionLike {
  id: string;
  schedule?: string | null | { id: string };
  automatic_tax?: { enabled?: boolean } | null;
  items?: { data?: Array<{ id: string; price?: StripePriceLike | null }> };
  customer?: string | StripeCustomerLike | null;
}

export interface StripeCustomerLike {
  id: string;
  address?: { country?: string | null } | null;
  tax?: { automatic_tax?: string; location?: { country?: string | null } | null } | null;
}

export interface StripeChargeLike {
  status?: string;
  payment_method_details?: { card?: { country?: string | null } | null } | null;
  billing_details?: { address?: { country?: string | null } | null } | null;
}

export type Params = Record<string, string | number | boolean | string[] | undefined | null>;

export interface StripeTransport {
  transport: string;
  request<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    params?: Params,
    opts?: { idempotencyKey?: string },
  ): Promise<T>;
}

export interface SoldPriceSpec {
  env: string;
  usdCents: number;
  eurCents?: number;
  interval: 'month' | 'year';
  optional?: boolean;
  /** Required by the automatic launch even though the scripts treat it as optional. */
  requiredAtLaunch?: boolean;
}

// ---------------------------------------------------------------------------
// The sold prices, by the environment variable that holds each id.
// `eurCents` unset means "the same digits as the USD unit_amount" (owner
// decision 2026-10-24). `usdCents` is what the catalogue says the USD price
// must be; a price that differs is reported and never touched.
// ---------------------------------------------------------------------------
export const SOLD_PRICE_ENV: readonly SoldPriceSpec[] = [
  { env: 'STRIPE_PRICE_PERSONAL_MONTHLY_V2', usdCents: 900, interval: 'month' },
  { env: 'STRIPE_PRICE_PERSONAL_YEARLY_V2', usdCents: 8640, interval: 'year' },
  { env: 'STRIPE_PRICE_SOLO_MONTHLY', usdCents: 1500, interval: 'month' },
  { env: 'STRIPE_PRICE_SOLO_YEARLY', usdCents: 14400, interval: 'year' },
  // Pro $19 / $182.40 (PR #241). Optional for the scripts until the V2 prices
  // exist, but REQUIRED by the automatic launch: Pro sells them from
  // 2026-12-08 (pro-price-change.ts), the day after EUR goes live, so a
  // launch without their EUR options would show euro-area buyers a converted
  // USD price for the new Pro the next morning.
  { env: 'STRIPE_PRICE_SOLO_MONTHLY_V2', usdCents: 1900, interval: 'month', optional: true, requiredAtLaunch: true },
  { env: 'STRIPE_PRICE_SOLO_YEARLY_V2', usdCents: 18240, interval: 'year', optional: true, requiredAtLaunch: true },
  { env: 'STRIPE_PRICE_BUSINESS_MONTHLY', usdCents: 3900, interval: 'month' },
  { env: 'STRIPE_PRICE_BUSINESS_YEARLY', usdCents: 37440, interval: 'year' },
  { env: 'STRIPE_PRICE_BUSINESS_MAILBOX_MONTHLY', usdCents: 300, interval: 'month' },
  { env: 'STRIPE_PRICE_BUSINESS_MAILBOX_YEARLY', usdCents: 2880, interval: 'year' },
  // The Japan sending route is sold from the Dashboard, not from code, so this
  // variable exists only for these scripts. EUR 108, not 120 (owner decision).
  { env: 'STRIPE_PRICE_JAPAN_ROUTE_YEARLY', usdCents: 12000, eurCents: 10800, interval: 'year', optional: true },
];

/** The legacy env names, read only to recognise MCPEmails subscriptions. */
export const LEGACY_PRICE_ENV: readonly string[] = [
  'STRIPE_PRICE_PERSONAL_MONTHLY',
  'STRIPE_PRICE_PERSONAL_YEARLY',
  'STRIPE_PRICE_PRO_MONTHLY',
  'STRIPE_PRICE_PRO_YEARLY',
];

export const DEFAULT_TAX_CODE = 'txcd_10000000';

// EU member states (ISO 3166-1 alpha-2). Greece is GR here, as Stripe reports it.
export const EU_COUNTRIES: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

/** Statuses that still bill and therefore need the right price. */
export const BILLING_STATUSES: readonly string[] = ['active', 'trialing', 'past_due', 'unpaid'];

/** Price ids by env var name, from an env-shaped object. Blank values are dropped. */
export function priceIdsFromEnv(source: Record<string, string | undefined>): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const name of [...SOLD_PRICE_ENV.map((p) => p.env), ...LEGACY_PRICE_ENV]) {
    const v = (source[name] ?? '').trim();
    if (v) ids[name] = v;
  }
  return ids;
}

export function productIdOf(price: StripePriceLike): string {
  return typeof price.product === 'string' ? price.product : price.product?.id ?? '';
}

// ---------------------------------------------------------------------------
// Pure planning
// ---------------------------------------------------------------------------

/**
 * What one sold price needs. Returns { problems, params } where params is the
 * form body for POST /v1/prices/:id, or null when nothing needs to change.
 * The price must be retrieved with expand[]=currency_options, or Stripe leaves
 * the field out and every price would look like it needs an EUR option.
 */
export function planPriceUpdate(
  price: StripePriceLike | null | undefined,
  spec: Pick<SoldPriceSpec, 'usdCents' | 'eurCents' | 'interval'>,
): { problems: string[]; params: Record<string, string> | null } {
  const problems: string[] = [];
  if (!price || price.object !== 'price') return { problems: ['not a Stripe price'], params: null };
  if (price.currency !== 'usd') problems.push(`currency ${price.currency}, expected usd`);
  if (price.unit_amount !== spec.usdCents) problems.push(`unit_amount ${price.unit_amount}, expected ${spec.usdCents}`);
  if (price.recurring?.interval !== spec.interval) problems.push(`interval ${price.recurring?.interval}, expected ${spec.interval}`);
  if (!price.active) problems.push('price is archived');
  if (problems.length) return { problems, params: null };

  const eurCents = spec.eurCents ?? (price.unit_amount as number);
  const params: Record<string, string> = {};
  if (price.tax_behavior === 'unspecified') params.tax_behavior = 'exclusive';
  else if (price.tax_behavior !== 'exclusive') problems.push(`USD tax_behavior is ${price.tax_behavior}; left as is`);

  const eur = price.currency_options?.eur;
  if (!eur) {
    params['currency_options[eur][unit_amount]'] = String(eurCents);
    params['currency_options[eur][tax_behavior]'] = 'inclusive';
  } else if (eur.unit_amount !== eurCents || eur.tax_behavior !== 'inclusive') {
    // An existing currency option is immutable (Stripe: "attempting to update
    // an immutable field for an existing currency"). Report, never retry.
    problems.push(`EUR option exists as ${eur.unit_amount} ${eur.tax_behavior}, wanted ${eurCents} inclusive; immutable, fix by hand`);
  }
  return { problems, params: Object.keys(params).length ? params : null };
}

/** POST /v1/products/:id params, or null when the product already has a code. */
export function planProductUpdate(
  product: { tax_code?: string | { id: string } | null },
  taxCode: string = DEFAULT_TAX_CODE,
): { tax_code: string } | null {
  const current = typeof product.tax_code === 'string' ? product.tax_code : product.tax_code?.id;
  return current ? null : { tax_code: taxCode };
}

/** Body for creating the inclusive USD twin of `price`. */
export function twinCreateParams(price: StripePriceLike): Record<string, string> {
  const label = price.nickname || `${price.unit_amount} ${price.currency} per ${price.recurring?.interval}`;
  return {
    currency: String(price.currency),
    unit_amount: String(price.unit_amount),
    product: productIdOf(price),
    'recurring[interval]': String(price.recurring?.interval),
    'recurring[interval_count]': String(price.recurring?.interval_count ?? 1),
    'recurring[usage_type]': price.recurring?.usage_type ?? 'licensed',
    tax_behavior: 'inclusive',
    nickname: `${label} (incl. VAT)`,
    'metadata[twin_of]': price.id,
  };
}

/** Is `candidate` a usable twin of `original`? */
export function isTwinOf(candidate: StripePriceLike, original: StripePriceLike): boolean {
  return (
    candidate.active === true &&
    candidate.metadata?.twin_of === original.id &&
    candidate.tax_behavior === 'inclusive' &&
    candidate.currency === original.currency &&
    candidate.unit_amount === original.unit_amount &&
    candidate.recurring?.interval === original.recurring?.interval &&
    (candidate.recurring?.interval_count ?? 1) === (original.recurring?.interval_count ?? 1)
  );
}

/**
 * The buyer's country, in the order plan section 0 used: card country of the
 * latest succeeded charge, then that charge's billing address, then the
 * customer's address, then Stripe Tax's own location. Returns { country, source }.
 */
export function customerCountry({
  charge,
  customer,
}: {
  charge?: StripeChargeLike | null;
  customer?: StripeCustomerLike | null;
}): { country: string | null; source: string } {
  const candidates: Array<[string, unknown]> = [
    ['card', charge?.payment_method_details?.card?.country],
    ['charge_billing', charge?.billing_details?.address?.country],
    ['customer_address', customer?.address?.country],
    ['tax_location', customer?.tax?.location?.country],
  ];
  for (const [source, value] of candidates) {
    if (typeof value === 'string' && value.length === 2) return { country: value.toUpperCase(), source };
  }
  return { country: null, source: 'unknown' };
}

export interface TaxRegistrationLike {
  status?: string;
  country?: string | null;
  country_options?: Record<string, { type?: string } | null> | null;
}

/**
 * Countries Stripe Tax collects in, from active registrations. A non-Union or
 * Union OSS registration covers every member state.
 */
export function coveredCountries(registrations: readonly TaxRegistrationLike[] | null | undefined): Set<string> {
  const set = new Set<string>();
  for (const reg of registrations ?? []) {
    if (reg.status && reg.status !== 'active') continue;
    const options = Object.values(reg.country_options ?? {});
    if (options.some((o) => typeof o?.type === 'string' && o.type.startsWith('oss'))) {
      for (const c of EU_COUNTRIES) set.add(c);
    }
    if (reg.country) set.add(reg.country.toUpperCase());
  }
  return set;
}

/**
 * The swap for one subscription, given twin lookups. Returns
 * { action: 'swap'|'skip', reason?, items? } where items are
 * [{ id, price }] for POST /v1/subscriptions/:id.
 */
export function planSwap(
  sub: StripeSubscriptionLike,
  {
    twinByOriginal,
    originalByTwin,
    catalogue,
  }: {
    twinByOriginal: ReadonlyMap<string, string>;
    originalByTwin: ReadonlyMap<string, string>;
    catalogue: ReadonlySet<string>;
  },
): { action: 'swap' | 'skip'; reason?: string; items?: Array<{ id: string; price: string }> } {
  if (sub.schedule) return { action: 'skip', reason: 'has_schedule' };
  const items = sub.items?.data ?? [];
  const mine = items.filter((it) => catalogue.has(it.price?.id ?? '') || originalByTwin.has(it.price?.id ?? ''));
  if (!mine.length) return { action: 'skip', reason: 'not_mcpemails' };
  const changes: Array<{ id: string; price: string }> = [];
  for (const it of items) {
    const id = it.price?.id ?? '';
    if (originalByTwin.has(id)) continue;
    const twin = twinByOriginal.get(id);
    if (!twin) return { action: 'skip', reason: 'missing_twin' };
    changes.push({ id: it.id, price: twin });
  }
  const taxOn = sub.automatic_tax?.enabled === true;
  if (!changes.length && taxOn) return { action: 'skip', reason: 'already_done' };
  return { action: 'swap', items: changes };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** `{ a: [x, y] }` -> [['a[]', x], ['a[]', y]]; plain entries pass through. */
export function flattenParams(params: Params): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const x of v) out.push([`${k}[]`, String(x)]);
    else out.push([k, String(v)]);
  }
  return out;
}

/**
 * Plain fetch to api.stripe.com with a secret key. `live` must match the key's
 * mode, or this throws before any request: a test key aimed at live (or the
 * reverse) would otherwise read the wrong account and plan against it.
 */
export function makeFetchTransport({
  key,
  live,
  fetchImpl = fetch,
}: {
  key: string;
  live: boolean;
  fetchImpl?: typeof fetch;
}): StripeTransport {
  const keyLive = key.includes('_live_');
  if (keyLive !== live) {
    throw new Error(keyLive
      ? 'STRIPE_SECRET_KEY is a live key: pass --live to target live mode.'
      : 'STRIPE_SECRET_KEY is a test key but --live was passed.');
  }
  return {
    transport: 'fetch',
    async request<T>(method: 'GET' | 'POST', path: string, params: Params = {}, opts: { idempotencyKey?: string } = {}): Promise<T> {
      const body = new URLSearchParams(flattenParams(params));
      const url = method === 'GET' ? `https://api.stripe.com${path}?${body}` : `https://api.stripe.com${path}`;
      const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
      if (method !== 'GET') headers['Content-Type'] = 'application/x-www-form-urlencoded';
      if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
      const res = await fetchImpl(url, { method, headers, body: method === 'GET' ? undefined : body });
      const json = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) throw new Error(`${method} ${path}: ${json?.error?.message ?? res.status}`);
      return json as T;
    },
  };
}

/** Every object of a list endpoint, following `starting_after`. */
export async function listAll<T extends { id: string }>(
  stripe: StripeTransport,
  path: string,
  params: Params = {},
): Promise<T[]> {
  const all: T[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.request<{ data: T[]; has_more: boolean }>('GET', path, {
      limit: 100,
      ...params,
      starting_after: startingAfter,
    });
    all.push(...page.data);
    if (!page.has_more || !page.data.length) return all;
    startingAfter = page.data[page.data.length - 1].id;
  }
}
