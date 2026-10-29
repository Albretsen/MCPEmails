-- ============================================================
-- MCPEmails - albretsen.no shows "emails handled", not MRR
-- 20261026100000_site_feed_emails_handled
-- ============================================================
--
-- albretsen.no now refuses any figure that looks like money (MRR, revenue,
-- prices, currencies, customers), so the hourly MRR post was rejected every
-- time. The public figure is now how many emails agents have handled through
-- MCPEmails. This migration:
--
--   1. adds site_feed_emails_handled(), the count, in SQL;
--   2. lets dispatch_site_feed() take job 'figure' instead of 'mrr';
--   3. replaces the 15 minute site-feed-mrr schedule with an hourly
--      site-feed-figure one.
--
-- The site-feed-events schedule is not touched.
--
-- Apply this BEFORE the app deploy that renames the route's job. Until the app
-- is deployed the route answers job=figure with 400 unknown_job, which is
-- harmless (the MRR post it replaces was being refused anyway).
-- ============================================================


-- ---------------------------------------------------------------------------
-- 1. The count.
--
-- "Emails handled" is the sum of two parts, external workspaces only:
--
--   a. one per action_usage row for a tool that acts on specific emails:
--      reading one, its original or an attachment, sending, replying,
--      forwarding, drafting, scheduling, moving, archiving, copying, deleting,
--      and the automation engine's per-email actions (triage_*). action_usage
--      is the permanent usage meter: rows are never deleted, and its history
--      starts 2026-08-03. Search, list and folder tools are left out (they find
--      emails rather than act on them), and so are the three tools that start
--      a bulk run (email_move_batch, email_flag, email_search_and_move): those
--      are counted per email in (b), and counting their call too would count
--      each run once more.
--
--   b. sum(bulk_runs.succeeded): every email a bulk move, flag or search-and-
--      move actually changed.
--
-- bulk_runs is described as short-lived operational metadata, so this sum may
-- one day drop if old runs are cleared. The job never posts a figure lower
-- than the one albretsen.no already shows (src/lib/site-feed/figure.ts), so a
-- drop here holds the public figure still rather than shrinking it.
--
-- External means the same as the site feed's events job and isInternalAccount:
-- the workspace owner's address is not on an internal domain and not in
-- public.internal_accounts or p_internal_emails (GROWTH_INTERNAL_EMAILS, from
-- the app's environment), plus-tag-insensitive. A workspace with no owner
-- address is treated as ours, because it cannot be checked. Soft-deleted
-- workspaces still count: the emails were handled.
--
-- Cost: one sequential pass over action_usage and bulk_runs, about 350 ms on
-- 2026-10-25. Run hourly by cron, never on a request path.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.site_feed_emails_handled(
  p_internal_emails text[] DEFAULT '{}'
)
RETURNS bigint
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH internal AS (
    SELECT
      public.internal_account_emails() || coalesce(
        (SELECT array_agg(lower(trim(e))) FROM unnest(p_internal_emails) AS e WHERE trim(e) <> ''),
        '{}'::text[]
      ) AS emails,
      public.internal_account_domains() AS domains
  ),
  external_workspaces AS (
    SELECT w.id
    FROM public.workspaces w
    JOIN public.users u ON u.id = w.owner_id
    CROSS JOIN internal i
    WHERE u.email IS NOT NULL
      AND NOT public.growth_is_internal_email(u.email, i.emails, i.domains)
  )
  SELECT
    (
      SELECT count(*)
      FROM public.action_usage a
      WHERE a.workspace_id IN (SELECT id FROM external_workspaces)
        AND a.tool_name = ANY (ARRAY[
          -- read
          'email_read', 'email_read_batch', 'email_original', 'email_attachment', 'email_extract',
          -- send, reply, forward, draft, schedule
          'email_send', 'email_reply', 'email_forward',
          'draft_create', 'draft_reply', 'draft_update', 'draft_send', 'schedule_create',
          -- organise and delete, one call at a time (no bulk run)
          'email_move', 'email_archive', 'email_copy', 'email_copy_batch',
          'email_delete', 'email_delete_batch', 'email_search_and_delete',
          -- the automation engine, one email per row
          'triage_move', 'triage_label', 'triage_mark_read', 'triage_draft_reply'
        ])
    )
    + (
      SELECT coalesce(sum(b.succeeded), 0)
      FROM public.bulk_runs b
      WHERE b.workspace_id IN (SELECT id FROM external_workspaces)
    );
$$;

COMMENT ON FUNCTION public.site_feed_emails_handled(text[]) IS
  'Emails agents have handled through MCPEmails, external workspaces only: per-email tool calls from action_usage plus bulk_runs.succeeded. The public figure on albretsen.no (job=figure of the site feed). p_internal_emails adds GROWTH_INTERNAL_EMAILS to public.internal_accounts.';

REVOKE ALL ON FUNCTION public.site_feed_emails_handled(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.site_feed_emails_handled(text[]) TO service_role;


-- ---------------------------------------------------------------------------
-- 2. The dispatcher takes 'figure' instead of 'mrr'.
--
-- Same body as 20261026090000_schedule_site_feed.sql apart from the job list.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_site_feed(p_job text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $fn$
DECLARE
  -- Public, non-secret. The apex domain is the canonical one.
  v_url    text := 'https://mcpemails.com/api/internal/site-feed/dispatch';
  v_secret text;
BEGIN
  -- The only two jobs. Anything else is a caller bug and must not reach the
  -- route as a query string.
  IF p_job NOT IN ('events', 'figure') THEN
    RAISE EXCEPTION 'dispatch_site_feed: unsupported job %', p_job;
  END IF;

  -- A missing or inaccessible Vault downgrades to a WARNING and a skip rather
  -- than an erroring cron run.
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
    RAISE WARNING 'dispatch_site_feed: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  -- Fire and forget: pg_net queues the request and returns immediately. The
  -- empty body is deliberate; the route chooses everything it posts.
  PERFORM net.http_post(
    url     := v_url || '?job=' || p_job,
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'X-Dispatch-Secret', v_secret
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
END;
$fn$;

COMMENT ON FUNCTION public.dispatch_site_feed(text) IS
  'Called by pg_cron. Posts to the Next.js site-feed dispatcher, which feeds '
  'albretsen.no an anonymous activity ticker (job=events, every minute) and '
  'the emails handled figure (job=figure, hourly). The secret is read from '
  'Vault (name=''dispatch_secret''), shared with the other dispatchers. Posts '
  'an empty body: all selection lives in the route.';

REVOKE EXECUTE ON FUNCTION public.dispatch_site_feed(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_site_feed(text) TO service_role;


-- ---------------------------------------------------------------------------
-- 3. The schedule: site-feed-mrr goes, site-feed-figure runs hourly.
--
-- Minute 7, off the top of the hour where other jobs bunch up. The figure
-- moves in steps of 10,000 emails, so hourly is plenty, and the job reposts an
-- unchanged figure about once a day so the site's `updated` stamp stays alive.
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
  j text;
BEGIN
  FOREACH j IN ARRAY ARRAY['site-feed-mrr', 'site-feed-figure']
  LOOP
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = j) THEN
      PERFORM cron.unschedule(j);
    END IF;
  END LOOP;
END;
$guard$;

SELECT cron.schedule(
  'site-feed-figure',
  '7 * * * *',
  $$SELECT public.dispatch_site_feed('figure')$$
);
