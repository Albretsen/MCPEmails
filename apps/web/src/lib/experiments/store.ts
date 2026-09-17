/**
 * The database-backed ExperimentStore. Server only: it holds the service-role
 * client. Never import this from proxy.ts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceRoleClient } from '@/lib/supabase/service';
import type { Database } from '@/types/database.types';
import type { ExperimentRecord } from './constants.ts';
import type { ExperimentStore } from './resolve.ts';

/**
 * A read of the experiments table on every homepage render would be one round
 * trip per anonymous visitor to answer a question whose answer changes when an
 * admin clicks a button. Thirty seconds is short enough that starting or
 * pausing an experiment feels immediate, long enough that a burst of traffic
 * costs one query. Every admin write also calls clearExperimentCache.
 *
 * Module scope, so the lifetime is one server instance. That is the point:
 * nothing here needs to be coherent across instances.
 */
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { record: ExperimentRecord | null; fetchedAt: number }>();

/** Drop one key, or the whole memo. Called after every admin write. */
export function clearExperimentCache(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}

export function createExperimentStore(client?: SupabaseClient<Database>): ExperimentStore {
  const db = client ?? createServiceRoleClient();

  return {
    async getExperiment(key: string): Promise<ExperimentRecord | null> {
      const hit = cache.get(key);
      if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.record;

      const { data, error } = await db
        .from('experiments')
        .select('key, name, description, status, variants, winner_variant_id, retention_goal, retention_window_days, created_at, updated_at, started_at, concluded_at')
        .eq('key', key)
        .maybeSingle();

      if (error) {
        console.error('[experiments] experiment read failed', { key, error: error.message });
        // Do not memoize a failure: a transient error must not pin the page to
        // the fallback for the next half minute.
        return null;
      }

      // `variants` is jsonb, so the generated column type is `Json`; the shape
      // is asserted here, at the single point the row enters the app.
      const record = (data as unknown as ExperimentRecord | null) ?? null;
      cache.set(key, { record, fetchedAt: Date.now() });
      return record;
    },

    async assign(key: string, subjectId: string, variantId: string): Promise<string> {
      const { data, error } = await db.rpc('experiment_assign', {
        p_key: key,
        p_subject_id: subjectId,
        p_variant_id: variantId,
      });
      if (error) throw new Error(error.message);
      // The RPC returns the STORED variant, which is the pre-existing one when
      // this subject was already bucketed. Never the one we just proposed.
      return typeof data === 'string' && data ? data : variantId;
    },
  };
}
