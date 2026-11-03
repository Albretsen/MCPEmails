-- ============================================================
-- MCPEmails - 30-day purge of deleted accounts and disconnected inboxes
-- 20261030130000_account_and_inbox_purge
-- ============================================================
--
-- Deleting an account (DELETE /api/user/delete-account) or disconnecting an
-- inbox (DELETE /api/inboxes/[id]) has only ever been a soft delete: the rows
-- stayed forever. The privacy policy says the rest is erased within 30 days.
-- This makes that true.
--
-- SHIPS IN DRY RUN. retention_purge_settings.dry_run starts true: both jobs
-- only count what they would erase and log it to system_events
-- (event_type 'retention.account_purge' / 'retention.inbox_purge', audit rows
-- that nothing sends). Turn it off with
--   UPDATE public.retention_purge_settings SET dry_run = false;
-- after a week of dry runs on staging, then the same on production.
--
-- ── 1. public.users.deleted_at ────────────────────────────────────────────
-- The route stamps auth.users app_metadata.deleted_at in the same admin call
-- that bans the user. A trigger on auth.users copies that stamp onto
-- public.users.deleted_at (and clears it if the stamp is removed, which is how
-- a deletion is undone by hand: unban the user and remove
-- app_metadata.deleted_at, before day 30). Existing deleted accounts are
-- backfilled from app_metadata below, so the first real run purges them too.
-- A browser session can never set or clear the column (guard trigger).
--
-- ── 2. purge_deleted_accounts() ───────────────────────────────────────────
-- Daily, 05:10 UTC. For each user whose deleted_at is more than 29 days old
-- (so the purge lands by day 30, the date the confirmation email prints), who
-- owns no live workspace and belongs to none (a restored account never
-- qualifies), oldest first, at most accounts_per_run per run:
--   1. one row in deleted_account_tally: dates and flags only, nothing that
--      joins back to a person;
--   2. the activity_log rows of the workspaces they owned, 10,000 at a time
--      (the cascade over the partitioned table is the slow part);
--   3. their auth_logs rows (by user, and by the owned workspaces);
--   4. support_tickets they sent are scrubbed: address, subject, message,
--      context and IP hash replaced; the ticket ref, category and dates stay;
--   5. DELETE FROM auth.users, which cascades to public.users, the owned
--      workspaces and everything under them (inboxes, keys, scheduled sends,
--      approvals, reminders, rules, aliases, billing rows, passes, referrals,
--      consents, lifecycle email log). Rows that only point at the user with
--      SET NULL keep existing without the link.
-- Each account runs in its own subtransaction: one failure is counted and
-- logged (by user id) and the rest go ahead.
-- Stripe keeps its own customer, invoices and charges (bookkeeping). The
-- Stripe webhook already treats a missing user as a deleted account
-- (lib/billing/deleted-account.ts answers 'deleted' on a 404).
--
-- ── 3. purge_disconnected_inboxes() ───────────────────────────────────────
-- Same schedule. Inbox rows whose deleted_at is more than 29 days old, at most
-- inboxes_per_run per run, are deleted; the delete cascades their rules,
-- reminders, aliases, contacts, plans and queued-mail history. Reconnecting
-- within 30 days still finds the same row and its settings; after that it
-- starts fresh.
--
-- COST NOTE. activity_log.inbox_id is ON DELETE SET NULL with no index on
-- inbox_id, so every deleted inbox (directly, or through a purged account's
-- workspace) makes Postgres scan activity_log once for referencing rows. The
-- per-run limits keep that bounded; the dry-run counts size the backlog.
--
-- ── 4. signup_scoreboard() counts purged accounts ─────────────────────────
-- "Signed up" must not drop when a deleted account's row goes, so the tally
-- is added back in. Growth board counts of workspaces lose purged workspaces
-- (30 days after deletion); that is accepted.
-- ============================================================

-- ── 1. public.users.deleted_at ────────────────────────────────────────────

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

COMMENT ON COLUMN public.users.deleted_at IS
  'When the account was deleted (copied from auth.users app_metadata.deleted_at by trigger). purge_deleted_accounts() erases the account 30 days later.';

CREATE INDEX IF NOT EXISTS users_deleted_at_idx
  ON public.users (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- A timestamp from app_metadata, or NULL for anything that does not parse.
CREATE OR REPLACE FUNCTION public.try_timestamptz(p_value text)
RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  RETURN p_value::timestamptz;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.try_timestamptz(text) FROM PUBLIC, anon, authenticated;

-- SECURITY INVOKER on purpose, like users_marketing_consent_guard: current_user
-- is the caller's role through PostgREST. The service role, the database owner
-- and the auth.users sync trigger below pass.
CREATE OR REPLACE FUNCTION public.users_deleted_at_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon')
     AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'deleted_at is set by account deletion only'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_deleted_at_guard ON public.users;
CREATE TRIGGER users_deleted_at_guard
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.users_deleted_at_guard();

CREATE OR REPLACE FUNCTION public.sync_user_deleted_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.users
  SET    deleted_at = public.try_timestamptz(NEW.raw_app_meta_data ->> 'deleted_at')
  WHERE  id = NEW.id
    AND  deleted_at IS DISTINCT FROM public.try_timestamptz(NEW.raw_app_meta_data ->> 'deleted_at');
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_user_deleted_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_deleted_at_sync ON auth.users;
CREATE TRIGGER on_auth_user_deleted_at_sync
  AFTER UPDATE OF raw_app_meta_data ON auth.users
  FOR EACH ROW
  WHEN (OLD.raw_app_meta_data -> 'deleted_at' IS DISTINCT FROM NEW.raw_app_meta_data -> 'deleted_at')
  EXECUTE FUNCTION public.sync_user_deleted_at();

-- Backfill every account deleted before this migration.
UPDATE public.users u
SET    deleted_at = public.try_timestamptz(a.raw_app_meta_data ->> 'deleted_at')
FROM   auth.users a
WHERE  a.id = u.id
  AND  u.deleted_at IS NULL
  AND  public.try_timestamptz(a.raw_app_meta_data ->> 'deleted_at') IS NOT NULL;

-- ── 2. Tally, settings ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.deleted_account_tally (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  signed_up_at     timestamptz NOT NULL,
  deleted_at       timestamptz NOT NULL,
  purged_at        timestamptz NOT NULL DEFAULT now(),
  was_internal     boolean NOT NULL,
  ever_paid        boolean NOT NULL,
  plan_at_deletion text
);

COMMENT ON TABLE public.deleted_account_tally IS
  'One anonymous row per account erased by purge_deleted_accounts(), so signup and churn totals survive the erasure. No email, no ids that join to anything.';

ALTER TABLE public.deleted_account_tally ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.deleted_account_tally FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.retention_purge_settings (
  id               smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  dry_run          boolean NOT NULL DEFAULT true,
  accounts_per_run integer NOT NULL DEFAULT 25 CHECK (accounts_per_run BETWEEN 1 AND 1000),
  inboxes_per_run  integer NOT NULL DEFAULT 100 CHECK (inboxes_per_run BETWEEN 1 AND 5000),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.retention_purge_settings IS
  'One row. dry_run = true: the account and inbox purges only count and log. Flip with UPDATE public.retention_purge_settings SET dry_run = false.';

ALTER TABLE public.retention_purge_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.retention_purge_settings FROM anon, authenticated;

INSERT INTO public.retention_purge_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── 3. purge_deleted_accounts ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.purge_deleted_accounts()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c_batch      constant integer := 10000;
  v_dry        boolean;
  v_limit      integer;
  v_candidates integer;
  r            record;
  v_ws         uuid[];
  v_n          bigint;
  v_activity   bigint;
  v_processed  integer := 0;
  v_purged     integer := 0;
  v_failed     integer := 0;
  v_activity_total bigint := 0;
  v_workspaces_total integer := 0;
  v_inboxes_total integer := 0;
  v_failures   jsonb := '[]'::jsonb;
  v_ever_paid  boolean;
  v_plan       text;
  v_result     jsonb;
BEGIN
  SELECT dry_run, accounts_per_run INTO v_dry, v_limit
  FROM public.retention_purge_settings WHERE id = 1;
  v_dry := coalesce(v_dry, true);
  v_limit := coalesce(v_limit, 25);

  SELECT count(*)::int INTO v_candidates
  FROM   public.users u
  WHERE  u.deleted_at IS NOT NULL
    AND  u.deleted_at < now() - interval '29 days'
    AND  NOT EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.user_id = u.id)
    AND  NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.owner_id = u.id AND w.deleted_at IS NULL);

  FOR r IN
    SELECT u.id, u.email, u.created_at, u.deleted_at
    FROM   public.users u
    WHERE  u.deleted_at IS NOT NULL
      AND  u.deleted_at < now() - interval '29 days'
      AND  NOT EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.user_id = u.id)
      AND  NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.owner_id = u.id AND w.deleted_at IS NULL)
    ORDER  BY u.deleted_at, u.id
    LIMIT  v_limit
  LOOP
    v_processed := v_processed + 1;
    BEGIN
      SELECT coalesce(array_agg(w.id), '{}') INTO v_ws
      FROM public.workspaces w WHERE w.owner_id = r.id;
      v_workspaces_total := v_workspaces_total + cardinality(v_ws);
      v_inboxes_total := v_inboxes_total
        + (SELECT count(*)::int FROM public.inboxes i WHERE i.workspace_id = ANY (v_ws));

      IF v_dry THEN
        SELECT count(*) INTO v_n FROM public.activity_log a WHERE a.workspace_id = ANY (v_ws);
        v_activity_total := v_activity_total + v_n;
        CONTINUE;
      END IF;

      SELECT b.plan,
             (b.stripe_subscription_id IS NOT NULL OR coalesce(b.plan, 'free') <> 'free')
      INTO   v_plan, v_ever_paid
      FROM   public.user_billing b WHERE b.user_id = r.id;
      v_ever_paid := coalesce(v_ever_paid, false)
        OR EXISTS (SELECT 1 FROM public.workspaces w
                   WHERE w.id = ANY (v_ws) AND coalesce(w.plan, 'free') <> 'free')
        OR EXISTS (SELECT 1 FROM public.product_funnel_events e
                   WHERE e.workspace_id = ANY (v_ws) AND e.stage = 'checkout_completed');
      IF v_plan IS NULL THEN
        SELECT max(w.plan) INTO v_plan FROM public.workspaces w WHERE w.id = ANY (v_ws);
      END IF;

      INSERT INTO public.deleted_account_tally
        (signed_up_at, deleted_at, was_internal, ever_paid, plan_at_deletion)
      VALUES
        (r.created_at, r.deleted_at, public.growth_is_internal_email(r.email), v_ever_paid, v_plan);

      v_activity := 0;
      LOOP
        DELETE FROM public.activity_log
        WHERE (id, created_at) IN (
          SELECT a.id, a.created_at FROM public.activity_log a
          WHERE a.workspace_id = ANY (v_ws)
          LIMIT c_batch
        );
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_activity := v_activity + v_n;
        EXIT WHEN v_n < c_batch;
      END LOOP;
      v_activity_total := v_activity_total + v_activity;

      DELETE FROM public.auth_logs
      WHERE user_id = r.id OR workspace_id = ANY (v_ws);

      UPDATE public.support_tickets
      SET    email = 'deleted@invalid',
             subject = '[deleted]',
             message = '[deleted]',
             context = '{}'::jsonb,
             ip_hash = NULL
      WHERE  user_id = r.id OR email = lower(r.email);

      DELETE FROM auth.users WHERE id = r.id;
      v_purged := v_purged + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      IF jsonb_array_length(v_failures) < 20 THEN
        v_failures := v_failures || jsonb_build_object('user_id', r.id, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 200));
      END IF;
    END;
  END LOOP;

  v_result := jsonb_build_object(
    'dry_run', v_dry,
    'candidates', v_candidates,
    'processed', v_processed,
    'purged', v_purged,
    'failed', v_failed,
    'workspaces', v_workspaces_total,
    'inboxes', v_inboxes_total,
    'activity_log_rows', v_activity_total,
    'failures', v_failures
  );

  -- An audit row only: nothing sends this event type.
  INSERT INTO public.system_events (event_type, payload, status, processed_at)
  VALUES ('retention.account_purge', v_result, 'sent', now());

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_deleted_accounts() FROM PUBLIC, anon, authenticated;

-- ── 4. purge_disconnected_inboxes ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.purge_disconnected_inboxes()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dry        boolean;
  v_limit      integer;
  v_candidates integer;
  r            record;
  v_purged     integer := 0;
  v_failed     integer := 0;
  v_failures   jsonb := '[]'::jsonb;
  v_result     jsonb;
BEGIN
  SELECT dry_run, inboxes_per_run INTO v_dry, v_limit
  FROM public.retention_purge_settings WHERE id = 1;
  v_dry := coalesce(v_dry, true);
  v_limit := coalesce(v_limit, 100);

  SELECT count(*)::int INTO v_candidates
  FROM public.inboxes i
  WHERE i.deleted_at IS NOT NULL AND i.deleted_at < now() - interval '29 days';

  IF NOT v_dry THEN
    FOR r IN
      SELECT i.id FROM public.inboxes i
      WHERE i.deleted_at IS NOT NULL AND i.deleted_at < now() - interval '29 days'
      ORDER BY i.deleted_at, i.id
      LIMIT v_limit
    LOOP
      BEGIN
        -- Re-checked per row: a reconnect clears deleted_at.
        DELETE FROM public.inboxes
        WHERE id = r.id AND deleted_at IS NOT NULL AND deleted_at < now() - interval '29 days';
        v_purged := v_purged + 1;
      EXCEPTION WHEN OTHERS THEN
        v_failed := v_failed + 1;
        IF jsonb_array_length(v_failures) < 20 THEN
          v_failures := v_failures || jsonb_build_object('inbox_id', r.id, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 200));
        END IF;
      END;
    END LOOP;
  END IF;

  v_result := jsonb_build_object(
    'dry_run', v_dry,
    'candidates', v_candidates,
    'purged', v_purged,
    'failed', v_failed,
    'failures', v_failures
  );

  INSERT INTO public.system_events (event_type, payload, status, processed_at)
  VALUES ('retention.inbox_purge', v_result, 'sent', now());

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_disconnected_inboxes() FROM PUBLIC, anon, authenticated;

-- ── 5. signup_scoreboard counts purged accounts ───────────────────────────

CREATE OR REPLACE FUNCTION public.signup_scoreboard()
RETURNS TABLE (
  total int,
  last_24h int,
  last_7d int,
  internal_excluded int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH scoped AS (
    SELECT u.created_at, public.growth_is_internal_email(u.email) AS is_internal
    FROM public.users u
    UNION ALL
    -- Accounts erased 30 days after deletion (purge_deleted_accounts()).
    SELECT t.signed_up_at, t.was_internal
    FROM public.deleted_account_tally t
  )
  SELECT
    count(*) FILTER (WHERE NOT s.is_internal)::int,
    count(*) FILTER (WHERE NOT s.is_internal AND s.created_at >= now() - interval '24 hours')::int,
    count(*) FILTER (WHERE NOT s.is_internal AND s.created_at >= now() - interval '7 days')::int,
    count(*) FILTER (WHERE s.is_internal)::int
  FROM scoped s;
$$;

COMMENT ON FUNCTION public.signup_scoreboard() IS
  'THE signup count. One row: people who have signed up (internal accounts excluded), the last 24h and 7d, and how many were excluded. Includes accounts erased by purge_deleted_accounts() (deleted_account_tally). Every surface that prints "signed up" reads this.';

REVOKE ALL ON FUNCTION public.signup_scoreboard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.signup_scoreboard() TO service_role;

-- ── 6. Schedule ───────────────────────────────────────────────────────────

SELECT cron.schedule(
  'deleted-account-and-inbox-purge',
  '10 5 * * *',
  $$SELECT public.purge_deleted_accounts(); SELECT public.purge_disconnected_inboxes();$$
);
