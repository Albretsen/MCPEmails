-- ============================================================
-- Activity log: future partitions + auto-creation via pg_cron
--
-- Creates partitions for 2026-08 through 2027-12.
-- Installs a pg_cron job that runs on the 1st of each month
-- and ensures the next 3 months of partitions exist, so this
-- never needs to be done manually again.
-- ============================================================

-- Partitions for the rest of 2026
CREATE TABLE IF NOT EXISTS public.activity_log_2026_08
  PARTITION OF public.activity_log
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

CREATE TABLE IF NOT EXISTS public.activity_log_2026_09
  PARTITION OF public.activity_log
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');

CREATE TABLE IF NOT EXISTS public.activity_log_2026_10
  PARTITION OF public.activity_log
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

CREATE TABLE IF NOT EXISTS public.activity_log_2026_11
  PARTITION OF public.activity_log
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');

CREATE TABLE IF NOT EXISTS public.activity_log_2026_12
  PARTITION OF public.activity_log
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

-- Partitions for 2027
CREATE TABLE IF NOT EXISTS public.activity_log_2027_01
  PARTITION OF public.activity_log
  FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');

CREATE TABLE IF NOT EXISTS public.activity_log_2027_02
  PARTITION OF public.activity_log
  FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');

CREATE TABLE IF NOT EXISTS public.activity_log_2027_03
  PARTITION OF public.activity_log
  FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');

CREATE TABLE IF NOT EXISTS public.activity_log_2027_04
  PARTITION OF public.activity_log
  FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');

CREATE TABLE IF NOT EXISTS public.activity_log_2027_05
  PARTITION OF public.activity_log
  FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');

CREATE TABLE IF NOT EXISTS public.activity_log_2027_06
  PARTITION OF public.activity_log
  FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');

CREATE TABLE IF NOT EXISTS public.activity_log_2027_07
  PARTITION OF public.activity_log
  FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');

CREATE TABLE IF NOT EXISTS public.activity_log_2027_08
  PARTITION OF public.activity_log
  FOR VALUES FROM ('2027-08-01') TO ('2027-09-01');

CREATE TABLE IF NOT EXISTS public.activity_log_2027_09
  PARTITION OF public.activity_log
  FOR VALUES FROM ('2027-09-01') TO ('2027-10-01');

CREATE TABLE IF NOT EXISTS public.activity_log_2027_10
  PARTITION OF public.activity_log
  FOR VALUES FROM ('2027-10-01') TO ('2027-11-01');

CREATE TABLE IF NOT EXISTS public.activity_log_2027_11
  PARTITION OF public.activity_log
  FOR VALUES FROM ('2027-11-01') TO ('2027-12-01');

CREATE TABLE IF NOT EXISTS public.activity_log_2027_12
  PARTITION OF public.activity_log
  FOR VALUES FROM ('2027-12-01') TO ('2028-01-01');

-- ============================================================
-- Auto-partition function
--
-- Creates partitions for the current month plus `months_ahead`
-- future months. Safe to call repeatedly — skips any partition
-- that already exists.
-- ============================================================
CREATE OR REPLACE FUNCTION public.ensure_activity_log_partitions(months_ahead int DEFAULT 3)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_date  date;
  p_name       text;
  range_start  text;
  range_end    text;
  i            int;
BEGIN
  FOR i IN 0..months_ahead LOOP
    target_date := date_trunc('month', now())::date + (i || ' months')::interval;
    p_name      := 'activity_log_' || to_char(target_date, 'YYYY_MM');
    range_start := to_char(target_date, 'YYYY-MM-DD');
    range_end   := to_char(target_date + interval '1 month', 'YYYY-MM-DD');

    IF NOT EXISTS (
      SELECT 1
      FROM   pg_class     c
      JOIN   pg_namespace n ON n.oid = c.relnamespace
      WHERE  n.nspname = 'public'
      AND    c.relname  = p_name
    ) THEN
      EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF public.activity_log FOR VALUES FROM (%L) TO (%L)',
        p_name, range_start, range_end
      );
    END IF;
  END LOOP;
END;
$$;

-- ============================================================
-- pg_cron job: runs at midnight on the 1st of every month,
-- ensures the current month + 3 ahead are covered.
-- ============================================================
SELECT cron.schedule(
  'ensure-activity-log-partitions',   -- job name (idempotent)
  '0 0 1 * *',                        -- midnight, 1st of every month
  'SELECT public.ensure_activity_log_partitions(3)'
);
