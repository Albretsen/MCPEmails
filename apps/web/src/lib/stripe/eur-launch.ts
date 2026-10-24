/**
 * The EUR launch as a STATE, not as three environment variables somebody has
 * to flip on the right morning.
 *
 * WHAT IT DECIDES. Whether EUR prices (currency.ts, eur-prices.ts) and Stripe
 * Tax (tax-switch.ts) are on for a request. Each of those still has its env
 * switch, and the env switch still works on its own as a manual override:
 *
 *   effective STRIPE_EUR_PRICES    = env says on  OR  eurLaunchState() is 'live'
 *   effective STRIPE_AUTOMATIC_TAX = env says on  OR  eurLaunchState() is 'live'
 *   STRIPE_FORCE_USD               beats both, always (the rollback)
 *
 * WHEN THE STATE IS 'live'. Only once BOTH hold: the clock has passed
 * EUR_LAUNCH_AT (2026-12-07 00:00 Oslo), and the `eur_launch_live` row in
 * public.pricing_switches is true. That row is written by one thing only, the
 * dispatcher (app/api/internal/eur-launch/dispatch), and only after every
 * preflight check passed and every Stripe step succeeded (eur-launch-run.ts).
 * So a missing OSS registration, a webhook without the SEPA events, or a
 * price with a wrong EUR option keeps the launch off by itself; nobody has to
 * remember not to flip a switch.
 *
 * WHY THE DATE IS CHECKED HERE TOO. Before the date nothing is read at all,
 * so checkout and /api/geo cost exactly what they cost before this file, and a
 * row set by hand in a rehearsal can never turn production on early. To go
 * early on purpose, set the env switches (docs/RUNBOOK-eur-launch.md).
 *
 * READS FAIL CLOSED. The flag is cached for FLAG_TTL_MS (60 s) per server
 * instance, so the hot paths stay one in-memory compare. A read that errors
 * means 'off' and is not cached, so the next request tries again: off is what
 * every customer saw before the launch, never a broken checkout.
 *
 * Server only (service-role client). The browser half is eur-launch-date.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { forceUsdEnabled, eurPricesEnabled as envEurPrices } from '@/lib/stripe/currency';
import { automaticTaxEnabled as envAutomaticTax } from '@/lib/stripe/tax-switch';
import { EUR_LAUNCH_AT, EUR_LAUNCH_FLAG_KEY, eurLaunchDatePassed } from '@/lib/stripe/eur-launch-date';

export { EUR_LAUNCH_AT, EUR_LAUNCH_FLAG_KEY, eurLaunchDatePassed };

type Env = Record<string, string | undefined>;
type Db = SupabaseClient<Database>;

const FLAG_TTL_MS = 60_000;

export type EurLaunchState = 'off' | 'live';

let flagCache: { value: boolean; at: number } | null = null;

/** Test seam, and what the dispatcher calls right after it writes the flag. */
export function resetEurLaunchCache(value?: boolean, nowMs: number = Date.now()): void {
  flagCache = typeof value === 'boolean' ? { value, at: nowMs } : null;
}

/** The pure rule: live only past the date and with the flag set. */
export function eurLaunchStateFor({ now, flag }: { now: number; flag: boolean | null }): EurLaunchState {
  return eurLaunchDatePassed(now) && flag === true ? 'live' : 'off';
}

/**
 * The persisted flag, or null when it could not be read. Cached on success
 * only. `fresh` skips the cache (the dispatcher's own check).
 */
export async function readEurLaunchFlag(opts?: { db?: Db; now?: number; fresh?: boolean }): Promise<boolean | null> {
  const nowMs = opts?.now ?? Date.now();
  if (!opts?.fresh && flagCache && nowMs - flagCache.at < FLAG_TTL_MS) return flagCache.value;
  try {
    const db = opts?.db ?? createServiceRoleClient();
    const { data, error } = await db
      .from('pricing_switches')
      .select('enabled')
      .eq('key', EUR_LAUNCH_FLAG_KEY)
      .maybeSingle();
    if (error) {
      console.error('[eur-launch] flag read failed', { error: error.message });
      return null;
    }
    const value = data?.enabled === true;
    flagCache = { value, at: nowMs };
    return value;
  } catch (err) {
    console.error('[eur-launch] flag read failed', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** 'live' or 'off' right now. Reads nothing before the launch date. */
export async function eurLaunchState(opts?: { db?: Db; now?: number }): Promise<EurLaunchState> {
  const now = opts?.now ?? Date.now();
  if (!eurLaunchDatePassed(now)) return 'off';
  const flag = await readEurLaunchFlag({ db: opts?.db, now });
  return eurLaunchStateFor({ now, flag });
}

/**
 * The environment the checkout helpers should read for this request: the real
 * one, with STRIPE_EUR_PRICES and STRIPE_AUTOMATIC_TAX turned on when the
 * launch is live. Handing the existing helpers an env (they all take one)
 * keeps one parser and one precedence order, instead of a second copy of the
 * rules here. STRIPE_FORCE_USD is left as it is and still wins inside each
 * helper; under it nothing is read.
 */
export async function effectiveStripeEnv(opts?: { db?: Db; now?: number; env?: Env }): Promise<Env> {
  const env = opts?.env ?? (process.env as Env);
  if (forceUsdEnabled(env)) return env;
  if (envEurPrices(env) && envAutomaticTax(env)) return env;
  const state = await eurLaunchState({ db: opts?.db, now: opts?.now });
  if (state !== 'live') return env;
  return { ...env, STRIPE_EUR_PRICES: 'true', STRIPE_AUTOMATIC_TAX: 'true' };
}

/**
 * Whether marketing pages may show EUR at all (the visitor's country is the
 * other half, see eur-prices.ts). Never under STRIPE_FORCE_USD: checkout
 * sells USD then, so the page must say USD too.
 */
export async function eurDisplayEnabled(opts?: { db?: Db; now?: number; env?: Env }): Promise<boolean> {
  const env = opts?.env ?? (process.env as Env);
  if (forceUsdEnabled(env)) return false;
  return envEurPrices(await effectiveStripeEnv({ ...opts, env }));
}
