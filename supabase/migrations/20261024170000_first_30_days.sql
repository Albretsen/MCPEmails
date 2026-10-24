-- ============================================================================
-- 2026-10-24: the first-30-days retention loop (M2 stuck-note draft, M3 day-8
-- week-1 summary). Rules: apps/web/src/lib/retention/first-30-days.ts.
--
-- Three things, all re-runnable:
--
--   1. 'activity_summary' becomes a known opt-out category, so the M3 email's
--      one-click unsubscribe can be stored. Mirrors LIFECYCLE_CATEGORIES in
--      apps/web/src/lib/email/lifecycle.ts; the two lists move together.
--
--   2. The holdout experiment row, key first30_week1_summary, 50/50, running.
--      variants[0] (holdout) is the control. Assignments are written per
--      workspace (subject_id = workspace uuid without dashes) by the
--      dispatcher, only when a day-8 summary is actually due. Kill switch:
--      conclude with a winner in /admin/growth/experiments, or turn the route
--      off with FIRST30_ENABLED.
--
--   3. public.dispatch_first_30_days() and an hourly pg_cron job that calls
--      it, the same shape as dispatch_paywall_followup() (same Vault secret,
--      fire-and-forget pg_net post, empty body). Safe to schedule before the
--      feature is on: the route returns before touching the database unless
--      FIRST30_ENABLED=on, and only dry-runs unless FIRST30_DRY_RUN=false.
--      Like the paywall dispatcher it has no SQL early return: its selection
--      lives in TypeScript and a drifting SQL copy would silently stop it.
--
-- The ledger is the existing lifecycle_email_sends (templates
-- retention_stuck_note and retention_week1_summary, trigger_key = workspace
-- id). No new table, no new column.
--
-- NOT APPLIED BY THE AGENT THAT WROTE IT.
-- ============================================================================

-- 1. Opt-out category -------------------------------------------------------

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_unsubscribed_categories_known;
ALTER TABLE public.users
  ADD CONSTRAINT users_unsubscribed_categories_known
  CHECK (unsubscribed_categories <@ ARRAY['lifecycle', 'product_update', 'research', 'activity_summary']::text[]);

COMMENT ON COLUMN public.users.unsubscribed_categories IS
  'Per-category opt-out. Currently understood: lifecycle (founder and product-usage mail), product_update, research, activity_summary (the day-8 week-1 report). A category listed here is suppressed even when unsubscribed_at is NULL.';


-- 2. Holdout experiment -----------------------------------------------------

INSERT INTO public.experiments (key, name, description, status, variants, retention_goal, retention_window_days, started_at)
VALUES (
  'first30_week1_summary',
  'First 30 days: week-1 summary email',
  'Per workspace, at day 8 after the first payment, among payers with at least one successful call in week 1. holdout gets no email; summary gets "Your first week with MCPEmails". Read out with lifecycle_email_sends (template retention_week1_summary, detail holdout) and activity_log days 8 to 30.',
  'running',
  '[{"id":"holdout","label":"No week-1 summary email","weight":50},{"id":"summary","label":"Week-1 summary email","weight":50}]'::jsonb,
  'any_tool_call',
  30,
  now()
)
ON CONFLICT (key) DO NOTHING;


-- 3. Dispatcher and schedule -----------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS supabase_vault;

CREATE OR REPLACE FUNCTION public.dispatch_first_30_days()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $fn$
DECLARE
  v_url    text := 'https://mcpemails.com/api/internal/first-30-days/dispatch';
  v_secret text;
BEGIN
  BEGIN
    SELECT decrypted_secret
      INTO v_secret
      FROM vault.decrypted_secrets
     WHERE name = 'dispatch_secret'
     LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_secret := NULL;
  END;

  IF v_secret IS NULL OR v_secret = '' THEN
    RAISE WARNING 'dispatch_first_30_days: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'X-Dispatch-Secret', v_secret
               ),
    body    := '{}'::jsonb
  );
END;
$fn$;

COMMENT ON FUNCTION public.dispatch_first_30_days() IS
  'Posts to the Next.js first-30-days dispatcher (M2 stuck-note draft, M3 week-1 summary). Scheduled hourly. The route is off unless FIRST30_ENABLED=on and dry-runs unless FIRST30_DRY_RUN=false.';

REVOKE EXECUTE ON FUNCTION public.dispatch_first_30_days() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_first_30_days() TO service_role;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-first-30-days') THEN
    PERFORM cron.unschedule('dispatch-first-30-days');
  END IF;
END;
$guard$;

-- Minute 17, clear of the jobs that run on the hour.
SELECT cron.schedule(
  'dispatch-first-30-days',
  '17 * * * *',
  $$SELECT public.dispatch_first_30_days()$$
);
