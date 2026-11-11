-- ============================================================================
-- 2026-11-11: broken-inbox alert for paying customers, with a 50% holdout.
-- 20261111140000_inbox_broken_alert
--
-- WHY. Four of five paid customers who churned after month 1 had an inbox
-- whose sign-in broke (the provider refused the password, or the OAuth token
-- was revoked or expired), and nothing told them except the next failed AI
-- call. Rules: apps/web/src/lib/retention/inbox-alert.ts.
--
-- WHAT THIS CREATES (all re-runnable):
--
--   1. public.inbox_alert_sends: the ledger. One row per (inbox, break start,
--      phase), UNIQUE, so the same break is never mailed twice. Holdout
--      workspaces get a row too (status 'holdout', nothing sent), written at
--      the moment a treatment workspace would have been mailed, so both arms
--      share one baseline. `closed_at` / `close_reason` record when the break
--      ended: 'reconnected' (the inbox works again) or 'removed' (deleted or
--      parked). Service-role only.
--
--   2. public.inbox_alert_candidates(): broken inboxes on paid, external
--      workspaces, with when the break started. Broad filter only; the exact
--      "is this the provider refusing, not us" rule is in TypeScript
--      (isProviderSideBreak) so it is unit tested.
--
--   3. The holdout experiment row, key inbox_broken_alert, 50/50, running.
--      variants[0] (holdout) is the control. Assignments are written per
--      workspace (subject_id = workspace uuid without dashes) only when a
--      first alert is actually due in live mode.
--
--   4. product_funnel_events: stages inbox_alert_sent, inbox_alert_holdout,
--      inbox_reconnected; categories alert_1, alert_2 (phase) and alert,
--      holdout (arm, on inbox_reconnected). Append-only blocks that read the
--      live lists.
--
--   5. public.inbox_alert_readout(): the /admin/growth/inbox-alerts numbers.
--
--   6. public.dispatch_inbox_alert() and an hourly pg_cron job (minute 41).
--      Safe to schedule before the feature is on: the route returns before
--      touching the database unless INBOX_ALERT_ENABLED is dry_run or on.
--
-- mcp-server reads none of this, so self-host/db/00-schema.sql is unchanged.
-- Forward-only. Apply with `npx supabase db query --linked -f <file>` and
-- `npx supabase migration repair --status applied 20261111140000 --linked`.
-- NOT APPLIED BY THE AGENT THAT WROTE IT.
-- ============================================================================

BEGIN;

-- 1. Ledger -----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.inbox_alert_sends (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inbox_id            uuid NOT NULL REFERENCES public.inboxes(id) ON DELETE CASCADE,
  workspace_id        uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id             uuid REFERENCES public.users(id) ON DELETE SET NULL,
  -- When the sign-in broke: the first auth_failed call on this inbox after its
  -- last successful one (or the row's own error time when no call logged it).
  -- Together with inbox_id and phase it is the idempotency key.
  break_started_at    timestamptz NOT NULL,
  phase               smallint NOT NULL CHECK (phase IN (1, 2)),
  arm                 text NOT NULL CHECK (arm IN ('alert', 'holdout')),
  status              text NOT NULL CHECK (status IN ('claimed', 'sent', 'failed', 'holdout')),
  provider            text NOT NULL,
  attempts            smallint NOT NULL DEFAULT 0,
  detail              text,
  provider_message_id text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  closed_at           timestamptz,
  close_reason        text CHECK (close_reason IS NULL OR close_reason IN ('reconnected', 'removed')),
  CONSTRAINT inbox_alert_sends_identity UNIQUE (inbox_id, break_started_at, phase)
);

CREATE INDEX IF NOT EXISTS inbox_alert_sends_open
  ON public.inbox_alert_sends (inbox_id)
  WHERE closed_at IS NULL;

CREATE INDEX IF NOT EXISTS inbox_alert_sends_workspace
  ON public.inbox_alert_sends (workspace_id, created_at);

COMMENT ON TABLE public.inbox_alert_sends IS
  'Broken-inbox alert ledger (apps/web/src/lib/retention/inbox-alert.ts). One row per (inbox, break start, phase); '
  'holdout rows record when an alert would have gone out. closed_at/close_reason record when the break ended. '
  'Service-role only. 20261111140000_inbox_broken_alert.sql.';

ALTER TABLE public.inbox_alert_sends ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inbox_alert_sends FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.inbox_alert_sends TO service_role;


-- 2. Candidates -------------------------------------------------------------
--
-- A broken inbox, broadly: not deleted, not parked, and either
--   * status 'error' (Gmail/Outlook refresh refused, or "Check connection"
--     got a definitive auth failure), or
--   * status 'active' with the login-refused marker the mcp-server and
--     client-api write when an IMAP server says NO to the password
--     (supabase/functions/mcp-server/inbox-health.ts).
-- on a workspace on Personal, Pro (solo) or Team (pro) whose owner's
-- subscription is active, and whose owner is not internal (inlined:
-- internal_accounts, plus-tag aliases of them, @mcpemails.com/.dev, and our
-- bjellanda* test accounts).
--
-- break_started_at: first activity_log row with error_code 'auth_failed' on
-- this inbox after its last successful call (and after the last break the
-- ledger saw end, last_closed_at), inside the lookback. When no
-- call logged one (a cron refresh or a dashboard check found it), the error
-- row's own time: updated_at for 'error' rows, the marker's timestamp for
-- marker rows. The dispatcher keeps the break start of an open ledger row, so
-- a later updated_at cannot open a second break.

CREATE OR REPLACE FUNCTION public.inbox_alert_candidates(p_lookback_days integer DEFAULT 90)
RETURNS TABLE (
  inbox_id            uuid,
  workspace_id        uuid,
  owner_id            uuid,
  owner_email         text,
  plan                text,
  acquisition_locale  text,
  email_address       text,
  provider            text,
  service             text,
  imap_host           text,
  inbox_status        text,
  last_error          text,
  error_row_at        timestamptz,
  first_auth_failed_at timestamptz,
  last_auth_failed_at timestamptz,
  last_success_at     timestamptz,
  last_closed_at      timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH broken AS (
    SELECT i.id, i.workspace_id, w.owner_id, u.email AS owner_email, w.plan, w.acquisition_locale,
           i.email_address, i.provider, i.service, i.imap_host, i.status, i.last_error,
           CASE
             WHEN i.status = 'active'
               THEN nullif(substring(i.last_error FROM '\(Checked ([0-9T:.Z-]{20,30})\)$'), '')::timestamptz
             ELSE i.updated_at
           END AS error_row_at
      FROM public.inboxes i
      JOIN public.workspaces w ON w.id = i.workspace_id AND w.deleted_at IS NULL
      JOIN public.users u ON u.id = w.owner_id
      JOIN public.user_billing b ON b.user_id = w.owner_id
     WHERE i.deleted_at IS NULL
       AND i.parked_at IS NULL
       AND w.plan IN ('personal', 'solo', 'pro')
       AND b.subscription_status = 'active'
       AND u.email IS NOT NULL
       AND lower(u.email) NOT LIKE '%@mcpemails.com'
       AND lower(u.email) NOT LIKE '%@mcpemails.dev'
       AND lower(u.email) NOT LIKE 'bjellanda%'
       AND NOT EXISTS (
             SELECT 1 FROM public.internal_accounts ia
              WHERE lower(ia.email) = lower(u.email)
                 OR lower(ia.email) = regexp_replace(lower(u.email), '\+[^@]*@', '@')
           )
       AND (
             i.status = 'error'
             OR (i.status = 'active'
                 AND i.last_error LIKE 'The mail server refused this mailbox''s password. Reconnect this inbox to restore access. (Checked %')
           )
  )
  SELECT b.id, b.workspace_id, b.owner_id, b.owner_email, b.plan, b.acquisition_locale,
         b.email_address, b.provider, b.service, b.imap_host, b.status, b.last_error,
         b.error_row_at, af.first_at, af.last_at, ok.last_at, cl.last_closed_at
    FROM broken b
    LEFT JOIN LATERAL (
      SELECT max(a.created_at) AS last_at
        FROM public.activity_log a
       WHERE a.workspace_id = b.workspace_id
         AND a.inbox_id = b.id
         AND a.status = 'success'
         AND a.created_at >= now() - make_interval(days => p_lookback_days)
    ) ok ON true
    LEFT JOIN LATERAL (
      SELECT max(s.closed_at) AS last_closed_at
        FROM public.inbox_alert_sends s
       WHERE s.inbox_id = b.id
         AND s.closed_at IS NOT NULL
    ) cl ON true
    LEFT JOIN LATERAL (
      SELECT min(a.created_at) AS first_at, max(a.created_at) AS last_at
        FROM public.activity_log a
       WHERE a.workspace_id = b.workspace_id
         AND a.inbox_id = b.id
         AND a.error_code = 'auth_failed'
         AND a.created_at >= now() - make_interval(days => p_lookback_days)
         -- After the last success and after the last break we saw end:
         -- GREATEST ignores NULLs, so either alone is enough.
         AND (greatest(ok.last_at, cl.last_closed_at) IS NULL
              OR a.created_at > greatest(ok.last_at, cl.last_closed_at))
    ) af ON true;
$$;

COMMENT ON FUNCTION public.inbox_alert_candidates(integer) IS
  'Broken inboxes (status error, or the login-refused marker) on paid external workspaces with an active subscription, '
  'with the auth_failed / success times the broken-inbox alert decides on. Rules: apps/web/src/lib/retention/inbox-alert.ts.';

REVOKE ALL ON FUNCTION public.inbox_alert_candidates(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_alert_candidates(integer) TO service_role;


-- 3. Holdout experiment ----------------------------------------------------

INSERT INTO public.experiments (key, name, description, status, variants, retention_goal, retention_window_days, started_at)
VALUES (
  'inbox_broken_alert',
  'Broken-inbox alert',
  'Per workspace, when a paid workspace has had an inbox whose sign-in the provider refused for 24 h with no success since. '
  'holdout gets nothing new; alert gets a service email (and a second one 5 days later if still broken) plus a dashboard banner. '
  'Read out with inbox_alert_sends / inbox_alert_readout(): reconnected within 7 days per arm.',
  'running',
  '[{"id":"holdout","label":"No broken-inbox alert","weight":50},{"id":"alert","label":"Broken-inbox email and banner","weight":50}]'::jsonb,
  'any_tool_call',
  30,
  now()
)
ON CONFLICT (key) DO NOTHING;


-- 4. Funnel vocabulary (append-only, reads the live lists) ------------------

DO $funnel$
DECLARE
  target   record;
  v_def    text;
  v_values text[];
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('product_funnel_events_stage_check', 'stage',
         ARRAY['inbox_alert_sent', 'inbox_alert_holdout', 'inbox_reconnected']),
      ('product_funnel_events_category_check', 'category',
         ARRAY['alert_1', 'alert_2', 'alert', 'holdout'])
    ) AS t(conname, col, additions)
  LOOP
    SELECT pg_get_constraintdef(c.oid)
      INTO v_def
      FROM pg_constraint c
     WHERE c.conrelid = 'public.product_funnel_events'::regclass
       AND c.conname = target.conname
       AND c.contype = 'c';

    IF v_def IS NULL THEN
      RAISE NOTICE '% does not exist, inbox alert values not added.', target.conname;
      CONTINUE;
    END IF;

    IF v_def !~ ('^CHECK \(\(' || target.col || ' = ANY \(') THEN
      RAISE EXCEPTION '% is not a plain list, not rewritten: %', target.conname, v_def;
    END IF;

    SELECT array_agg(u.v ORDER BY t.n, u.k)
      INTO v_values
      FROM regexp_matches(v_def, '''((?:[^'']|'''')*)''(::text\[\])?', 'g') WITH ORDINALITY AS t(m, n)
      CROSS JOIN LATERAL unnest(
             CASE WHEN t.m[2] IS NULL
                  THEN ARRAY[replace(t.m[1], '''''', '''')]
                  ELSE replace(t.m[1], '''''', '''')::text[]
             END
           ) WITH ORDINALITY AS u(v, k);

    IF v_values IS NULL OR cardinality(v_values) = 0 THEN
      RAISE EXCEPTION '% has no readable values: %', target.conname, v_def;
    END IF;

    IF target.additions <@ v_values THEN
      CONTINUE;
    END IF;

    SELECT v_values || coalesce(array_agg(a.v ORDER BY a.n), ARRAY[]::text[])
      INTO v_values
      FROM unnest(target.additions) WITH ORDINALITY AS a(v, n)
     WHERE a.v <> ALL (v_values);

    EXECUTE format('ALTER TABLE public.product_funnel_events DROP CONSTRAINT %I', target.conname);
    EXECUTE format(
      'ALTER TABLE public.product_funnel_events ADD CONSTRAINT %I CHECK (%I = ANY (ARRAY[%s]))',
      target.conname,
      target.col,
      (SELECT string_agg(quote_literal(x.v) || '::text', ', ' ORDER BY x.n)
         FROM unnest(v_values) WITH ORDINALITY AS x(v, n))
    );
  END LOOP;
END;
$funnel$;


-- 5. Read-out ---------------------------------------------------------------
--
-- Per arm, over phase-1 rows (the moment the alert went out, or would have):
-- breaks, workspaces, second alerts, and breaks that ended 'reconnected'
-- within 7 days of that moment. `mature` counts only breaks at least 7 days
-- old, the fair denominator for the 7-day rate.

CREATE OR REPLACE FUNCTION public.inbox_alert_readout()
RETURNS TABLE (
  arm                    text,
  breaks                 bigint,
  workspaces             bigint,
  first_sent             bigint,
  first_failed           bigint,
  second_rows            bigint,
  mature                 bigint,
  reconnected_7d         bigint,
  reconnected_7d_mature  bigint,
  reconnected_any        bigint,
  still_open             bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH p1 AS (
    SELECT s.*,
           (s.close_reason = 'reconnected' AND s.closed_at <= s.created_at + interval '7 days') AS rec7,
           (s.created_at <= now() - interval '7 days') AS is_mature
      FROM public.inbox_alert_sends s
     WHERE s.phase = 1
  )
  SELECT p1.arm,
         count(*),
         count(DISTINCT p1.workspace_id),
         count(*) FILTER (WHERE p1.status = 'sent'),
         count(*) FILTER (WHERE p1.status IN ('failed', 'claimed')),
         (SELECT count(*) FROM public.inbox_alert_sends s2 WHERE s2.phase = 2 AND s2.arm = p1.arm),
         count(*) FILTER (WHERE p1.is_mature),
         count(*) FILTER (WHERE p1.rec7),
         count(*) FILTER (WHERE p1.rec7 AND p1.is_mature),
         count(*) FILTER (WHERE p1.close_reason = 'reconnected'),
         count(*) FILTER (WHERE p1.closed_at IS NULL)
    FROM p1
   GROUP BY p1.arm
   ORDER BY p1.arm;
$$;

REVOKE ALL ON FUNCTION public.inbox_alert_readout() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_alert_readout() TO service_role;


-- 6. Dispatcher and schedule -----------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS supabase_vault;

CREATE OR REPLACE FUNCTION public.dispatch_inbox_alert()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $fn$
DECLARE
  v_url    text := public._app_base_url() || '/api/internal/inbox-alert/dispatch';
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
    RAISE WARNING 'dispatch_inbox_alert: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  IF v_url IS NULL THEN
    RAISE WARNING 'dispatch_inbox_alert: Vault secret "app_base_url" is not set, skipping.';
    RETURN;
  END IF;

  -- Fire and forget. The empty body is deliberate: the route selects its own
  -- work, so a caller holding the secret cannot steer who is emailed.
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

COMMENT ON FUNCTION public.dispatch_inbox_alert() IS
  'Posts to the Next.js broken-inbox alert dispatcher. Scheduled hourly. The route is off unless INBOX_ALERT_ENABLED is dry_run or on.';

REVOKE EXECUTE ON FUNCTION public.dispatch_inbox_alert() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_inbox_alert() TO service_role;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-inbox-alert') THEN
    PERFORM cron.unschedule('dispatch-inbox-alert');
  END IF;
END;
$guard$;

-- Minute 41, clear of the jobs on the hour and of first-30-days at :17.
SELECT cron.schedule(
  'dispatch-inbox-alert',
  '41 * * * *',
  $$SELECT public.dispatch_inbox_alert()$$
);

COMMIT;
