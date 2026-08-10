-- DB hardening (database-rls.md LOW-1 + LOW-2). Defense-in-depth: these objects are
-- currently protected by RLS / a Vault secret, but the role GRANTs are the Supabase
-- default and over-broad. Tighten them so the posture does not rely solely on RLS.
-- service_role (which bypasses RLS and runs the app's writers) keeps full access.
-- Idempotent: REVOKE on an absent grant is a no-op.

-- LOW-1: dispatch_scheduled_sends() is SECURITY DEFINER and only needs to be invoked
-- by pg_cron (runs as the function owner / postgres). anon and authenticated must not
-- be able to trigger dispatch HTTP requests via /rest/v1/rpc.
REVOKE EXECUTE ON FUNCTION public.dispatch_scheduled_sends() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.dispatch_scheduled_sends() FROM anon;
REVOKE EXECUTE ON FUNCTION public.dispatch_scheduled_sends() FROM authenticated;

-- LOW-2: these tables grant INSERT/SELECT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER to
-- both anon and authenticated by default. They are written/read only by service_role
-- (webhook handler, error logger, rate limiter, auth-log writer). app_errors and
-- stripe_webhook_events have RLS + zero policies (default-deny); auth_logs and
-- rate_limit_buckets have RLS policies but the table grants are still broader than
-- needed. Revoke all anon/authenticated table privileges; service_role is untouched.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'app_errors', 'stripe_webhook_events', 'auth_logs', 'rate_limit_buckets'
  ] LOOP
    IF to_regclass('public.' || table_name) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', table_name);
    END IF;
  END LOOP;
END
$$;
