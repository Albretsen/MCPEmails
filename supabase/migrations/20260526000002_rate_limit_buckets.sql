-- ============================================================
-- Distributed rate limiting: rate_limit_buckets + rate_limit_check
--
-- Replaces the in-process Map-based rate limiter in the OAuth
-- token and registration endpoints. A single DB row per key
-- stores the current sliding-window count. The rate_limit_check
-- function is a single atomic UPSERT so there are no race conditions
-- between concurrent Vercel function instances.
-- ============================================================

CREATE TABLE public.rate_limit_buckets (
  key          text        PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count        integer     NOT NULL DEFAULT 0
);

ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;

-- Only accessible via service-role; no user-facing access needed.
CREATE POLICY "rate_limit_deny_all"
  ON public.rate_limit_buckets FOR ALL
  USING (false);

-- ── rate_limit_check ─────────────────────────────────────────────────────────
-- Atomically increments the counter for `p_key` within the given window.
-- Returns TRUE if the request is within the limit (allowed).
-- Returns FALSE if the limit has been exceeded (reject the request).
--
-- When the current window has expired the counter is reset to 1 and a new
-- window starts — the caller gets a fresh allowance.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rate_limit_check(
  p_key        text,
  p_max_count  integer,
  p_window_ms  bigint      -- window size in milliseconds
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_now    timestamptz := now();
  v_cutoff timestamptz := v_now - (p_window_ms || ' milliseconds')::interval;
  v_count  integer;
BEGIN
  INSERT INTO public.rate_limit_buckets (key, window_start, count)
  VALUES (p_key, v_now, 1)
  ON CONFLICT (key) DO UPDATE
    SET window_start = CASE
          WHEN rate_limit_buckets.window_start <= v_cutoff
          THEN v_now                          -- window expired: open a new one
          ELSE rate_limit_buckets.window_start
        END,
        count = CASE
          WHEN rate_limit_buckets.window_start <= v_cutoff
          THEN 1                              -- window expired: reset counter
          ELSE rate_limit_buckets.count + 1   -- same window: increment
        END
  RETURNING count INTO v_count;

  RETURN v_count <= p_max_count;
END;
$$;
