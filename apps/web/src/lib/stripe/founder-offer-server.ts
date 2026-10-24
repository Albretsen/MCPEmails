/**
 * The server half of the Business founder price: reads the runtime flag, the
 * place count and the owner's own row, then asks the pure `founderOfferFor`.
 *
 * Server only (service-role client). Every read fails CLOSED: a flag, count
 * or owner lookup that errors means no offer, so checkout sells the normal
 * price and no surface prints a number it could not check.
 *
 *   flag   cached at most FLAG_TTL_MS (60 s) per server instance
 *   count  cached at most COUNT_TTL_MS (60 s) for pages; read uncached
 *          (`fresh: true`) when a checkout or an upgrade is priced
 *   owner  read on every call (one indexed row)
 *
 * Nothing is read at all outside the window or when the founder prices are
 * not configured, so this costs nothing on the normal path.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { founderPriceIdFor } from '@/lib/stripe/plans';
import {
  FOUNDER_FLAG_KEY,
  founderOfferFor,
  founderTermsVisibleFor,
  inFounderWindow,
  type FounderOffer,
} from '@/lib/stripe/founder-offer';

const FLAG_TTL_MS = 60_000;
const COUNT_TTL_MS = 60_000;

type Db = SupabaseClient<Database>;

let flagCache: { value: boolean; at: number } | null = null;
let countCache: { value: number; at: number } | null = null;

/** Test seam: forget the cached flag and count. */
export function resetFounderOfferCaches(): void {
  flagCache = null;
  countCache = null;
}

async function readFlag(db: Db, nowMs: number): Promise<boolean | null> {
  if (flagCache && nowMs - flagCache.at < FLAG_TTL_MS) return flagCache.value;
  const { data, error } = await db
    .from('pricing_switches')
    .select('enabled')
    .eq('key', FOUNDER_FLAG_KEY)
    .maybeSingle();
  if (error) {
    console.error('[founder-offer] flag read failed', { error: error.message });
    return null;
  }
  const value = data?.enabled === true;
  flagCache = { value, at: nowMs };
  return value;
}

async function readPlacesTaken(db: Db, nowMs: number, fresh = false): Promise<number | null> {
  if (!fresh && countCache && nowMs - countCache.at < COUNT_TTL_MS) return countCache.value;
  const { count, error } = await db
    .from('business_founder_places')
    .select('stripe_subscription_id', { count: 'exact', head: true });
  if (error || count == null) {
    console.error('[founder-offer] place count failed', { error: error?.message ?? 'no count' });
    return null;
  }
  countCache = { value: count, at: nowMs };
  return count;
}

async function readOwnerHasFounderSub(db: Db, ownerId: string): Promise<boolean | null> {
  const { data, error } = await db
    .from('business_founder_places')
    .select('stripe_subscription_id')
    .eq('owner_id', ownerId)
    .limit(1);
  if (error) {
    console.error('[founder-offer] owner lookup failed', { error: error.message });
    return null;
  }
  return (data ?? []).length > 0;
}

/**
 * The founder offer open right now, or null.
 *
 * `ownerId` is the buyer, when there is one. Public pages pass none: they show
 * the offer as it stands for a new company, and checkout re-checks the buyer.
 *
 * `fresh: true` reads the place count past the cache. Checkout and the
 * in-place upgrade pass it, so a price is never decided on a stale count.
 */
export async function currentFounderOffer(opts?: {
  ownerId?: string | null;
  now?: Date;
  db?: Db;
  fresh?: boolean;
}): Promise<FounderOffer | null> {
  const now = opts?.now ?? new Date();
  if (!inFounderWindow(now)) return null;
  if (!founderPriceIdFor('month') || !founderPriceIdFor('year')) return null;

  try {
    const db = opts?.db ?? createServiceRoleClient();
    const nowMs = now.getTime();
    const [flagOn, placesTaken, ownerHas] = await Promise.all([
      readFlag(db, nowMs),
      readPlacesTaken(db, nowMs, opts?.fresh === true),
      opts?.ownerId ? readOwnerHasFounderSub(db, opts.ownerId) : Promise.resolve(false),
    ]);
    if (flagOn !== true || ownerHas == null) return null;
    return founderOfferFor({
      now,
      flagOn,
      placesTaken,
      ownerHasFounderSub: ownerHas,
    });
  } catch (err) {
    console.error(
      '[founder-offer] offer lookup failed',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Whether the terms page may print the founder clause (5.8). See
 * `founderTermsVisibleFor`: never in zh, and otherwise only once the offer has
 * started or a founder subscription exists. Any read that fails hides it.
 */
export async function founderTermsVisible(opts: {
  locale?: string | null;
  now?: Date;
  db?: Db;
}): Promise<boolean> {
  if (opts.locale === 'zh') return false;
  const now = opts.now ?? new Date();
  try {
    const db = opts.db ?? createServiceRoleClient();
    const nowMs = now.getTime();
    const [flagOn, placesTaken] = await Promise.all([readFlag(db, nowMs), readPlacesTaken(db, nowMs)]);
    return founderTermsVisibleFor({ locale: opts.locale, now, flagOn, placesTaken });
  } catch (err) {
    console.error(
      '[founder-offer] terms visibility failed',
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}
