-- ============================================================
-- Secure activity_log partitions + harden functions
--
-- The future activity_log partitions (2026_08 .. 2027_12) were created
-- without RLS, exposing them via PostgREST direct partition access — any
-- signed-in (or anon) caller could read every workspace's activity. This
-- migration enables RLS + the member-scoped SELECT policy on every existing
-- partition, and bakes the same protection into the auto-partition function
-- so future months are covered automatically. It also pins rate_limit_check's
-- search_path and removes internal trigger/cron functions from the RPC surface.
-- ============================================================

-- 1. Enable RLS + SELECT policy on every activity_log partition.
DO $$
DECLARE
  part      regclass;
  pname     text;
  v_polname text;
BEGIN
  FOR part, pname IN
    SELECT c.oid::regclass, c.relname
    FROM   pg_inherits i
    JOIN   pg_class c       ON c.oid = i.inhrelid
    JOIN   pg_class parent  ON parent.oid = i.inhparent
    JOIN   pg_namespace n   ON n.oid = parent.relnamespace
    WHERE  n.nspname = 'public'
    AND    parent.relname = 'activity_log'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', pname);

    v_polname := pname || '_select_members';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p WHERE p.polrelid = part AND p.polname = v_polname
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (workspace_id = ANY(public.my_workspace_ids()))',
        v_polname, pname
      );
    END IF;
  END LOOP;
END $$;

-- 2. Bake RLS + policy creation into the auto-partition function.
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
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', p_name);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (workspace_id = ANY(public.my_workspace_ids()))',
        p_name || '_select_members', p_name
      );
    END IF;
  END LOOP;
END;
$$;

-- 3. Pin a stable search_path on rate_limit_check (was role-mutable).
ALTER FUNCTION public.rate_limit_check(text, integer, bigint) SET search_path = public;

-- 4. Internal trigger/cron functions: remove from the PostgREST RPC surface.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ensure_activity_log_partitions(int) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.expire_workspace_invites() FROM anon, authenticated;
