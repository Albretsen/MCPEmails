-- ============================================================
-- MCPEmails - Pro feature "reminders": follow-ups and snoozes
-- 20261024235200_reminders
-- ============================================================
--
-- One table, one state machine, two kinds (see
-- supabase/functions/mcp-server/reminders-engine.ts for the transitions):
--
--   follow_up  "tell me if nobody replies to this within N days". The
--              dispatcher looks for a reply every ~20 minutes; a reply marks it
--              'replied', past due_at with none it becomes 'due' and stays
--              listed until the user marks it done or cancels it.
--   snooze     the message sits in a snooze folder and is moved back to INBOX
--              at due_at (condition 'no_reply': only when no reply arrived).
--
-- No model in the loop. Written only by service-role code (the reminder tools
-- in mcp-server and the /reminders-dispatch route); members may read.
--
-- PRIVACY POSTURE (same carve-out as scheduled_sends.payload and
-- triage_run_items.undo_state):
--   * message_ref holds the provider message id, thread id and RFC Message-ID,
--     encrypted: {"v":1,"data":"<AES-256-GCM, ENCRYPTION_KEY>"}.
--   * summary holds the subject, the recipients and the sender, encrypted the
--     same way, for reminder_list and the morning brief. Never a body, a
--     preview or an attachment.
--   * message_digest is HMAC-SHA256(ENCRYPTION_KEY, message id): it lets the
--     server refuse a duplicate without being able to name the message.
--   * folder is the user-facing name of the snooze folder (a label the user or
--     we chose, not message content).
--
-- DEPLOY ORDER: apply this migration before deploying the mcp-server version
-- that carries the reminder tools. The cron job below only posts when a row is
-- due, so it is inert until the first reminder exists, and the tools are hidden
-- behind the Pro gate (workspaces.pro_features_enabled / pro_features_public).
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE / unschedule-then-schedule.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.reminders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  inbox_id             uuid NOT NULL REFERENCES public.inboxes(id) ON DELETE CASCADE,

  -- The key that set it up, for the audit trail. SET NULL, not CASCADE: a
  -- revoked key must not strand a snoozed message in its folder. The runner
  -- still returns snoozes with no key, and cancels follow-ups that lost theirs.
  api_key_id           uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,

  kind                 text NOT NULL
                       CONSTRAINT reminders_kind_check CHECK (kind IN ('follow_up', 'snooze')),
  status               text NOT NULL DEFAULT 'pending'
                       CONSTRAINT reminders_status_check
                       CHECK (status IN ('pending', 'due', 'replied', 'returned', 'done', 'cancelled', 'failed')),
  -- follow_up is always 'no_reply' (that is what it waits for); a snooze is
  -- 'always' or 'no_reply'.
  condition            text NOT NULL DEFAULT 'always'
                       CONSTRAINT reminders_condition_check CHECK (condition IN ('always', 'no_reply')),

  -- When the follow-up falls due / the snooze comes back.
  due_at               timestamptz NOT NULL,
  -- When the dispatcher next looks at the row. NULL = never again.
  next_check_at        timestamptz,

  message_digest       text NOT NULL,
  message_ref          jsonb NOT NULL,
  summary              jsonb,
  folder               text
                       CONSTRAINT reminders_folder_length_check CHECK (folder IS NULL OR char_length(folder) <= 512),

  -- The lease. claimed_at non-null means a dispatcher run holds the row;
  -- lease_token says which one. Older than 10 minutes is stale and released
  -- (every action on a row is safe to repeat).
  claimed_at           timestamptz,
  lease_token          uuid,

  -- Back-off: 5 min, 15 min, 1 h, 4 h. A follow-up goes 'failed' at 5
  -- consecutive failures; a snooze never does (4 h, then daily, until it can
  -- bring the message back; reconnecting the inbox re-arms it).
  consecutive_failures integer NOT NULL DEFAULT 0,
  -- A short code (provider_error, imap_auth_failed, ...). Never provider text.
  last_error_code      text
                       CONSTRAINT reminders_error_code_length_check
                       CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 64),

  last_checked_at      timestamptz,
  replied_at           timestamptz,
  returned_at          timestamptz,
  completed_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT reminders_follow_up_condition_check
    CHECK (kind <> 'follow_up' OR condition = 'no_reply'),
  CONSTRAINT reminders_snooze_folder_check
    CHECK (kind <> 'snooze' OR folder IS NOT NULL),
  CONSTRAINT reminders_lease_pair_check
    CHECK ((claimed_at IS NULL) = (lease_token IS NULL))
);

-- The dispatcher's scan: open, unleased rows by next check.
CREATE INDEX IF NOT EXISTS reminders_due_idx
  ON public.reminders (next_check_at)
  WHERE status IN ('pending', 'due') AND claimed_at IS NULL AND next_check_at IS NOT NULL;

-- The per-inbox claim (one session per inbox per run).
CREATE INDEX IF NOT EXISTS reminders_inbox_open_idx
  ON public.reminders (inbox_id, next_check_at)
  WHERE status IN ('pending', 'due');

-- reminder_list and the morning brief: a workspace's reminders by status.
CREATE INDEX IF NOT EXISTS reminders_workspace_status_idx
  ON public.reminders (workspace_id, status, due_at);

-- One open reminder of a kind per message per inbox.
CREATE UNIQUE INDEX IF NOT EXISTS reminders_open_message_uniq
  ON public.reminders (inbox_id, kind, message_digest)
  WHERE status IN ('pending', 'due', 'failed');

-- Retention sweep.
CREATE INDEX IF NOT EXISTS reminders_completed_idx
  ON public.reminders (completed_at)
  WHERE completed_at IS NOT NULL;

DROP TRIGGER IF EXISTS reminders_updated_at ON public.reminders;
CREATE TRIGGER reminders_updated_at
  BEFORE UPDATE ON public.reminders
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime(updated_at);

-- ── Row integrity (every writer, service role included) ─────────────────────
CREATE OR REPLACE FUNCTION public.reminders_enforce_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.inboxes i
    WHERE  i.id = NEW.inbox_id AND i.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'reminders: inbox % does not belong to workspace %', NEW.inbox_id, NEW.workspace_id
      USING ERRCODE = '23514';
  END IF;

  IF NEW.api_key_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.api_keys k
    WHERE  k.id = NEW.api_key_id AND k.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'reminders: api key % does not belong to workspace %', NEW.api_key_id, NEW.workspace_id
      USING ERRCODE = '23514';
  END IF;

  -- Message identifiers and the summary are only ever stored encrypted.
  IF jsonb_typeof(NEW.message_ref) <> 'object'
     OR NEW.message_ref ->> 'v' IS DISTINCT FROM '1'
     OR coalesce(NEW.message_ref ->> 'data', '') = ''
     OR (SELECT count(*) FROM jsonb_object_keys(NEW.message_ref)) <> 2 THEN
    RAISE EXCEPTION 'reminders: message_ref must be an encrypted wrapper'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.summary IS NOT NULL THEN
    IF jsonb_typeof(NEW.summary) <> 'object'
       OR NEW.summary ->> 'v' IS DISTINCT FROM '1'
       OR coalesce(NEW.summary ->> 'data', '') = ''
       OR (SELECT count(*) FROM jsonb_object_keys(NEW.summary)) <> 2 THEN
      RAISE EXCEPTION 'reminders: summary must be an encrypted wrapper'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reminders_enforce_integrity() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS reminders_enforce_integrity ON public.reminders;
CREATE TRIGGER reminders_enforce_integrity
  BEFORE INSERT OR UPDATE OF workspace_id, inbox_id, api_key_id, message_ref, summary
  ON public.reminders
  FOR EACH ROW
  EXECUTE FUNCTION public.reminders_enforce_integrity();


-- ── Re-arm on reconnect ─────────────────────────────────────────────────────
-- A snooze never goes 'failed' on an auth, inbox or transport error: it backs
-- off (5 min, 15 min, 1 h, 4 h, then daily) and keeps trying, because giving up
-- would leave the message hidden. When the user reconnects or re-authorises the
-- inbox, every backed-off reminder of it is due again at once, so a snoozed
-- message comes back within a minute of the fix rather than at the next daily
-- retry. Snoozes only once their own time has come; open follow-ups always.
-- Fires on the inbox becoming active, or on a new password / refresh token
-- while active. Harmless when nothing has failed (no row matches).
CREATE OR REPLACE FUNCTION public.reminders_rearm_on_reconnect()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.reminders
     SET next_check_at = now()
   WHERE inbox_id = NEW.id
     AND status IN ('pending', 'due')
     AND consecutive_failures > 0
     AND claimed_at IS NULL
     AND next_check_at > now()
     AND (kind = 'follow_up' OR due_at <= now());
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reminders_rearm_on_reconnect() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS reminders_rearm_on_reconnect ON public.inboxes;
CREATE TRIGGER reminders_rearm_on_reconnect
  AFTER UPDATE OF status, imap_password, oauth_refresh_token ON public.inboxes
  FOR EACH ROW
  WHEN (
    NEW.status = 'active' AND (
      OLD.status IS DISTINCT FROM NEW.status
      OR OLD.imap_password IS DISTINCT FROM NEW.imap_password
      OR OLD.oauth_refresh_token IS DISTINCT FROM NEW.oauth_refresh_token
    )
  )
  EXECUTE FUNCTION public.reminders_rearm_on_reconnect();
-- ── Row-Level Security ──────────────────────────────────────────────────────
-- Members read their workspace's reminders. No user-client writes at all:
-- cancelling a snooze moves mail, which only the server can do, and a
-- browser that could write here could rewrite api_key_id or the lease.
ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reminders_select_members" ON public.reminders;
CREATE POLICY "reminders_select_members"
  ON public.reminders FOR SELECT TO authenticated
  USING (workspace_id = ANY(public.my_workspace_ids()));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.reminders FROM anon, authenticated;

COMMENT ON TABLE public.reminders IS
  'Pro reminders: follow-ups (reply tracking) and snoozes (move out, bring back). '
  'Written only by service-role code; driven by pg_cron -> dispatch_reminders() -> '
  'mcp-server /reminders-dispatch. No message content in clear: message_ref and '
  'summary are AES-256-GCM wrappers {v,data} under ENCRYPTION_KEY.';
COMMENT ON COLUMN public.reminders.message_ref IS
  'Encrypted {provider_message_id, thread_id, rfc_message_id, since, snoozed_message_id?, snooze_folder_id?}.';
COMMENT ON COLUMN public.reminders.summary IS
  'Encrypted {subject, to[], from}. Subject and addresses only, never a body.';
COMMENT ON COLUMN public.reminders.message_digest IS
  'HMAC-SHA256(ENCRYPTION_KEY, kind-tagged message id). Dedupe only; cannot be turned back into an id.';
COMMENT ON COLUMN public.reminders.next_check_at IS
  'When the dispatcher next acts: pending follow-ups every ~20 min (and exactly at due_at), due follow-ups every 6 h for 60 days, snoozes at due_at. NULL = never.';

-- ── The dispatcher ──────────────────────────────────────────────────────────
-- Same shape as dispatch_triage_rules(): count what the route would select,
-- return with no request when nothing is due, otherwise one POST with an empty
-- body (selection, leasing and budgeting live in the edge function). The due
-- predicate mirrors remindersStore.listDue in mcp-server, looking one minute
-- ahead for the same clock-skew reason as dispatch_scheduled_sends(); the stale
-- predicate mirrors REMINDER_STALE_LEASE_MS (10 minutes). Keep them in step.
CREATE OR REPLACE FUNCTION public.dispatch_reminders()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $$
DECLARE
  -- Public, non-secret base URL of the mcp-server Edge Function. The
  -- /reminders-dispatch route validates the X-Dispatch-Secret header.
  v_url    text := 'https://swvaxorwumispmjaaszb.supabase.co/functions/v1/mcp-server';
  v_secret text;
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.reminders
        WHERE status IN ('pending', 'due')
          AND claimed_at IS NULL
          AND next_check_at IS NOT NULL
          AND next_check_at <= now() + INTERVAL '1 minute'
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.reminders
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
    RAISE WARNING 'dispatch_reminders: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := v_url || '/reminders-dispatch',
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'X-Dispatch-Secret', v_secret
               ),
    body    := '{}'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dispatch_reminders() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_reminders() TO service_role;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-reminders') THEN
    PERFORM cron.unschedule('dispatch-reminders');
  END IF;
END;
$guard$;

-- Every minute: a snooze comes back within about a minute of due_at. Reply
-- checks are spaced by next_check_at (20 minutes), not by this cadence.
SELECT cron.schedule(
  'dispatch-reminders',
  '* * * * *',
  $$SELECT public.dispatch_reminders()$$
);

-- ── Retention ───────────────────────────────────────────────────────────────
-- Finished reminders (replied, returned, done, cancelled) go 90 days after
-- they finished. 'failed' rows stay longer (180 days after their last change):
-- a failed snooze names the folder its message is still in. Open rows are
-- never swept. Daily at 03:30 UTC, after the triage and activity-log sweeps.
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reminders-retention') THEN
    PERFORM cron.unschedule('reminders-retention');
  END IF;
END;
$guard$;

SELECT cron.schedule(
  'reminders-retention',
  '30 3 * * *',
  $$DELETE FROM public.reminders
     WHERE (status IN ('replied', 'returned', 'done', 'cancelled')
            AND completed_at < now() - INTERVAL '90 days')
        OR (status = 'failed' AND updated_at < now() - INTERVAL '180 days')$$
);
