-- ============================================================
-- MCPEmails - Pro feature "morning_brief": a daily rules-based brief
-- 20261024235400_morning_briefs
-- ============================================================
--
-- One row per workspace. The dashboard route (/api/workspaces/[id]/morning-brief)
-- writes the settings through the service role after checking the role and the
-- Pro gate; the mcp-server /morning-brief-dispatch route writes the schedule,
-- the outcome and the lease. Members may read.
--
-- The brief is NOT sent: the dispatcher inserts it into the target inbox
-- (IMAP APPEND to INBOX unseen, Gmail messages.insert, Graph create in the
-- inbox folder). It is never metered. See
-- supabase/functions/mcp-server/morning-brief-engine.ts.
--
-- PRIVACY: settings only. No message content is stored here; vip_senders is
-- the owner's own list of addresses and domains.
--
-- DEPLOY ORDER: apply this migration before deploying the mcp-server version
-- with /morning-brief-dispatch. The cron job only posts when an enabled row is
-- due, so it is inert until someone turns a brief on, and the settings are
-- hidden behind the Pro gate (workspaces.pro_features_enabled /
-- pro_features_public).
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE / unschedule-then-schedule.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.morning_briefs (
  workspace_id         uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  enabled              boolean NOT NULL DEFAULT false,
  -- Local hour (0-23) in `timezone` the brief is due at.
  hour                 smallint NOT NULL DEFAULT 7
                       CONSTRAINT morning_briefs_hour_check CHECK (hour BETWEEN 0 AND 23),
  -- IANA zone name, validated by the route (Intl) and again by the dispatcher.
  timezone             text NOT NULL DEFAULT 'UTC'
                       CONSTRAINT morning_briefs_timezone_check CHECK (char_length(timezone) BETWEEN 1 AND 64),
  locale               text NOT NULL DEFAULT 'en'
                       CONSTRAINT morning_briefs_locale_check CHECK (locale IN ('en', 'nb', 'fr', 'es', 'de')),
  -- The inbox the brief is put into. SET NULL on delete: the brief is then
  -- skipped with last_error_code 'target_inbox_missing' until a new one is picked.
  inbox_id             uuid REFERENCES public.inboxes(id) ON DELETE SET NULL,
  vip_senders          text[] NOT NULL DEFAULT '{}'
                       CONSTRAINT morning_briefs_vip_count_check CHECK (cardinality(vip_senders) <= 50),

  -- Schedule. NULL next_due_at = the dispatcher works it out on its next run
  -- (the route clears it on every save).
  next_due_at          timestamptz,
  -- The local date of the last brief handled (sent, empty, refused or skipped).
  last_local_date      date,
  last_sent_at         timestamptz,
  last_run_at          timestamptz,
  last_outcome         text
                       CONSTRAINT morning_briefs_outcome_check
                       CHECK (last_outcome IS NULL OR last_outcome IN ('sent', 'empty', 'not_allowed', 'skipped', 'failed')),
  last_error_code      text
                       CONSTRAINT morning_briefs_error_code_length_check
                       CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 64),
  -- Back-off: 5 min, 15 min, 1 h, 2 h; paused at 5 consecutive failures.
  consecutive_failures integer NOT NULL DEFAULT 0,
  paused_at            timestamptz,

  -- Dispatcher lease; older than 10 minutes is stale and released.
  claimed_at           timestamptz,
  lease_token          uuid,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT morning_briefs_lease_pair_check CHECK ((claimed_at IS NULL) = (lease_token IS NULL))
);

-- The dispatcher's scan.
CREATE INDEX IF NOT EXISTS morning_briefs_due_idx
  ON public.morning_briefs (next_due_at NULLS FIRST)
  WHERE enabled AND paused_at IS NULL AND claimed_at IS NULL;

DROP TRIGGER IF EXISTS morning_briefs_updated_at ON public.morning_briefs;
CREATE TRIGGER morning_briefs_updated_at
  BEFORE UPDATE ON public.morning_briefs
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime(updated_at);

-- The target inbox must belong to the workspace (every writer, service role included).
CREATE OR REPLACE FUNCTION public.morning_briefs_enforce_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.inbox_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.inboxes i
    WHERE  i.id = NEW.inbox_id AND i.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'morning_briefs: inbox % does not belong to workspace %', NEW.inbox_id, NEW.workspace_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.morning_briefs_enforce_integrity() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS morning_briefs_enforce_integrity ON public.morning_briefs;
CREATE TRIGGER morning_briefs_enforce_integrity
  BEFORE INSERT OR UPDATE OF workspace_id, inbox_id
  ON public.morning_briefs
  FOR EACH ROW
  EXECUTE FUNCTION public.morning_briefs_enforce_integrity();

-- ── Row-Level Security ──────────────────────────────────────────────────────
-- Members read their workspace's row. No user-client writes: the route checks
-- the role and the Pro gate, then writes with the service role.
ALTER TABLE public.morning_briefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "morning_briefs_select_members" ON public.morning_briefs;
CREATE POLICY "morning_briefs_select_members"
  ON public.morning_briefs FOR SELECT TO authenticated
  USING (workspace_id = ANY(public.my_workspace_ids()));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.morning_briefs FROM anon, authenticated;

COMMENT ON TABLE public.morning_briefs IS
  'Pro morning brief settings and schedule, one row per workspace. Driven by pg_cron -> '
  'dispatch_morning_briefs() -> mcp-server /morning-brief-dispatch. The brief is inserted '
  'into the target inbox, never sent and never metered.';

-- ── The dispatcher ──────────────────────────────────────────────────────────
-- Same shape as dispatch_reminders(): return with no request when nothing is
-- due, otherwise one POST with an empty body. The due predicate mirrors
-- morningBriefStore.listDue in mcp-server; the stale predicate mirrors
-- BRIEF_STALE_LEASE_MS (10 minutes). Keep them in step.
CREATE OR REPLACE FUNCTION public.dispatch_morning_briefs()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $$
DECLARE
  v_url    text := 'https://swvaxorwumispmjaaszb.supabase.co/functions/v1/mcp-server';
  v_secret text;
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.morning_briefs
        WHERE enabled
          AND paused_at IS NULL
          AND claimed_at IS NULL
          AND (next_due_at IS NULL OR next_due_at <= now() + INTERVAL '1 minute')
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.morning_briefs
        WHERE claimed_at IS NOT NULL
          AND claimed_at < now() - INTERVAL '10 minutes'
     )
  THEN
    RETURN;
  END IF;

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
    RAISE WARNING 'dispatch_morning_briefs: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := v_url || '/morning-brief-dispatch',
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'X-Dispatch-Secret', v_secret
               ),
    body    := '{}'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dispatch_morning_briefs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_morning_briefs() TO service_role;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-morning-briefs') THEN
    PERFORM cron.unschedule('dispatch-morning-briefs');
  END IF;
END;
$guard$;

-- Every 5 minutes: a brief lands within about 5 minutes of its hour.
SELECT cron.schedule(
  'dispatch-morning-briefs',
  '*/5 * * * *',
  $$SELECT public.dispatch_morning_briefs()$$
);
