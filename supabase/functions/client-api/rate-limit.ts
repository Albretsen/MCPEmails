// client-api's own rate limit. In-isolate, no database.
//
// WHY NOT THE MCP LIMITERS. `checkRateLimit` / `checkPlanQuota` count
// `activity_log` rows: one or two queries per request (the ~0.7 s of DB
// overhead the web client exists to avoid), and a human clicking through an
// inbox would spend the workspace's MCP budget. client-api writes no
// `activity_log` rows at all, so neither limiter can see it.
//
// WHAT THIS IS. A token bucket per user per class, plus one coarse ceiling for
// the whole isolate. It bounds a runaway tab or a stolen session; it is not a
// billing meter. An isolate holds its own buckets, so the effective limit is
// (limit x isolates): acceptable for abuse control, and stated here so nobody
// mistakes it for an exact quota.

export type LimitClass = "read" | "write" | "send" | "assistant";

export interface BucketSpec {
  /** Burst size. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSec: number;
}

export const DEFAULT_LIMITS: Record<LimitClass, BucketSpec> = {
  // A cold inbox open is a handful of batched reads; scrolling adds a page a
  // second at most. 240 burst, 20/s sustained is far above a human.
  read: { capacity: 240, refillPerSec: 20 },
  write: { capacity: 120, refillPerSec: 5 },
  // 30 sends in a burst, then one every 4 s (900/hour).
  send: { capacity: 30, refillPerSec: 0.25 },
  assistant: { capacity: 6, refillPerSec: 0.1 },
};

/** Whole-isolate ceiling: requests per window, across every user. */
export const DEFAULT_CEILING = { limit: 3000, windowMs: 10_000 };

export interface LimitDecision {
  ok: boolean;
  /** Seconds until the request would be admitted. 0 when ok. */
  retryAfter: number;
  scope?: "user" | "isolate";
}

interface Bucket {
  tokens: number;
  at: number;
}

export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  #windowStart = 0;
  #windowCount = 0;

  constructor(
    private readonly limits: Record<LimitClass, BucketSpec> = DEFAULT_LIMITS,
    private readonly ceiling: { limit: number; windowMs: number } = DEFAULT_CEILING,
    private readonly now: () => number = () => Date.now(),
    /** Buckets kept; the oldest are dropped past this. */
    private readonly maxBuckets = 5000,
  ) {}

  /** Take `cost` tokens for this user and class. */
  take(userId: string, cls: LimitClass, cost = 1): LimitDecision {
    const now = this.now();

    if (now - this.#windowStart >= this.ceiling.windowMs) {
      this.#windowStart = now;
      this.#windowCount = 0;
    }
    if (this.#windowCount + cost > this.ceiling.limit) {
      const wait = this.ceiling.windowMs - (now - this.#windowStart);
      return { ok: false, retryAfter: Math.max(1, Math.ceil(wait / 1000)), scope: "isolate" };
    }

    const spec = this.limits[cls];
    const key = `${userId}\u0000${cls}`;
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      bucket = { tokens: spec.capacity, at: now };
      if (this.#buckets.size >= this.maxBuckets) this.#evict();
    } else {
      // Re-insert so Map order is recency order (the eviction order).
      this.#buckets.delete(key);
      bucket.tokens = Math.min(spec.capacity, bucket.tokens + ((now - bucket.at) / 1000) * spec.refillPerSec);
      bucket.at = now;
    }
    this.#buckets.set(key, bucket);

    // A cost above the burst can never be admitted; treat it as the burst so
    // it is refused only while the bucket is not full.
    const need = Math.min(cost, spec.capacity);
    if (bucket.tokens < need) {
      const wait = (need - bucket.tokens) / spec.refillPerSec;
      return { ok: false, retryAfter: Math.max(1, Math.ceil(wait)), scope: "user" };
    }
    bucket.tokens -= need;
    this.#windowCount += cost;
    return { ok: true, retryAfter: 0 };
  }

  #evict(): void {
    const drop = Math.ceil(this.maxBuckets / 10);
    let i = 0;
    for (const key of this.#buckets.keys()) {
      if (i++ >= drop) break;
      this.#buckets.delete(key);
    }
  }

  get size(): number {
    return this.#buckets.size;
  }
}
