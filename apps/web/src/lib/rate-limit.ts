import { createServiceRoleClient } from '@/lib/supabase/service';

/**
 * Distributed rate limiter backed by Supabase (rate_limit_buckets table).
 *
 * Consistent across all Vercel function instances, unlike the previous
 * in-process Map which gave each instance its own independent counter.
 *
 * Returns true  → request is rate limited (caller should reject it).
 * Returns false → request is within the limit (caller should allow it).
 *
 * Fails open on database errors: legitimate requests are never blocked
 * because of infrastructure failures.
 *
 * @param key      Unique string identifying the rate-limit bucket, e.g. `"oauth:token:1.2.3.4"`
 * @param maxCount Maximum number of requests allowed within the window
 * @param windowMs Window duration in milliseconds
 */
export async function checkRateLimit(
  key: string,
  maxCount: number,
  windowMs: number,
): Promise<boolean> {
  try {
    const service = createServiceRoleClient();

    const { data, error } = await service.rpc('rate_limit_check', {
      p_key:        key,
      p_max_count:  maxCount,
      p_window_ms:  windowMs,
    });

    if (error) {
      console.error('[rate_limit] DB error, failing open:', error.message);
      return false;
    }

    // rate_limit_check returns true when within limit, false when over limit.
    return data === false;
  } catch (err) {
    console.error('[rate_limit] unexpected error, failing open:', err);
    return false;
  }
}
