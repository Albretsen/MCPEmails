-- ============================================================
-- MCPEmails - Business admin and audit (phase 2)
-- 20261111130000_business_admin_audit
-- ============================================================
--
-- WHAT THIS ADDS
-- --------------
--   activity_log.user_id                 the person a tool call acted as
--   workspace_audit_events               who changed the team: invites,
--                                        members, roles, inbox visibility,
--                                        the recipient rule
--   workspaces.allowed_recipient_domains the Business recipient rule
--   send_approvals.hold_reason           why a send was held, when it was
--                                        not the inbox's own review setting
--   send_approvals.requested_by          the person whose send it is
--
-- Apply after 20261111120000_inbox_owner_visibility.sql. Idempotent:
-- IF NOT EXISTS / OR REPLACE / DROP ... IF EXISTS throughout.
-- ============================================================

-- ------------------------------------------------------------
-- 1. activity_log.user_id
-- ------------------------------------------------------------
-- ADD COLUMN on the partitioned parent reaches every existing partition, and
-- every partition created later (ensure_activity_log_partitions creates them
-- as PARTITION OF, which copies the parent's columns).
--
-- No foreign key on purpose. activity_log is the largest table, and an FK to
-- users would make every account deletion scan every partition for the
-- ON DELETE action (there is no user_id index, and one is not worth its write
-- cost for a column nothing filters on). A dangling id after an account is
-- deleted names nobody: the audit view shows it as a former member.
-- activity_log is the hottest table: never queue behind a long lock (and
-- block every tool call behind us). Fail fast instead; re-run when quiet.
SET lock_timeout = '3s';

ALTER TABLE public.activity_log ADD COLUMN IF NOT EXISTS user_id uuid;

COMMENT ON COLUMN public.activity_log.user_id IS
  'The person the call acted as: the API key''s or OAuth grant''s created_by, or the '
  'workspace owner for a key with no creator. Filled by mcp-server, backstopped by '
  'the activity_log_fill_user_id trigger. No FK (see 20261111130000).';

-- The backstop. mcp-server passes the key's creator when it has one; this
-- fills what it could not know without a query (a key with no creator acts as
-- the workspace owner) and any row written by another path. A row-level
-- BEFORE trigger on the partitioned parent is cloned onto every partition,
-- present and future (PostgreSQL 13+).
CREATE OR REPLACE FUNCTION public.activity_log_fill_user_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS NULL THEN
    IF NEW.api_key_id IS NOT NULL THEN
      SELECT k.created_by INTO NEW.user_id
        FROM public.api_keys k
       WHERE k.id = NEW.api_key_id;
    END IF;
    IF NEW.user_id IS NULL THEN
      SELECT w.owner_id INTO NEW.user_id
        FROM public.workspaces w
       WHERE w.id = NEW.workspace_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.activity_log_fill_user_id() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS activity_log_fill_user_id ON public.activity_log;
CREATE TRIGGER activity_log_fill_user_id
  BEFORE INSERT ON public.activity_log
  FOR EACH ROW EXECUTE FUNCTION public.activity_log_fill_user_id();

-- Members read the new column through the per-partition SELECT policies from
-- 20261111120000 (rows of inboxes they can see). activity_log has table-level
-- SELECT, so nothing else is needed; stated for the catalog tests.
GRANT SELECT (user_id) ON public.activity_log TO authenticated;

-- A call that named no inbox (inbox_id null: a cross-inbox "all" call, a
-- listing) can still reveal what someone else's agent did. Members see such
-- a row only when they made it; owners and admins see every row (they already
-- see every call's metadata in the audit view). Rows with an inbox keep the
-- visibility rule from 20261111120000. Replaces the policy on the parent and
-- on every partition, and the one future partitions get.
DO $$
DECLARE
  pname text;
BEGIN
  FOR pname IN
    SELECT 'activity_log'
    UNION ALL
    SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c      ON c.oid = i.inhrelid
      JOIN pg_class parent ON parent.oid = i.inhparent
      JOIN pg_namespace n  ON n.oid = parent.relnamespace
     WHERE n.nspname = 'public' AND parent.relname = 'activity_log'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pname || '_select_members', pname);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ('
      'workspace_id = ANY(public.my_workspace_ids()) '
      'AND (inbox_id = ANY ((SELECT public.my_visible_inbox_ids())::uuid[]) '
      'OR (inbox_id IS NULL AND (user_id = (SELECT auth.uid()) '
      'OR workspace_id = ANY ((SELECT public.sso_admin_workspace_ids())::uuid[])))))',
      pname || '_select_members', pname
    );
  END LOOP;
END $$;

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
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ('
        'workspace_id = ANY(public.my_workspace_ids()) '
        'AND (inbox_id = ANY ((SELECT public.my_visible_inbox_ids())::uuid[]) '
        'OR (inbox_id IS NULL AND (user_id = (SELECT auth.uid()) '
        'OR workspace_id = ANY ((SELECT public.sso_admin_workspace_ids())::uuid[])))))',
        p_name || '_select_members', p_name
      );
    END IF;
  END LOOP;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.ensure_activity_log_partitions(int) FROM PUBLIC, anon, authenticated;

RESET lock_timeout;

-- ------------------------------------------------------------
-- 2. workspace_audit_events
-- ------------------------------------------------------------
-- Not activity_log: that table is the MCP tool-call log and feeds usage
-- counts, the growth board and the rate limiters; a team change written there
-- would count as usage. Same reasoning as sso_audit_events (20261019152000).
--
-- Written only by the server (service role) after it has authorised the
-- change: apps/web/src/lib/workspace/audit-events.ts. Owner and admin may read
-- their workspace's rows. Nobody updates or deletes through the API.
CREATE TABLE IF NOT EXISTS public.workspace_audit_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- Who made the change. NULL only once their account is deleted.
  actor_user_id  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  kind           text NOT NULL CHECK (kind IN (
                   'invite_sent',
                   'invite_cancelled',
                   'invite_accepted',
                   'member_removed',
                   'member_left',
                   'role_changed',
                   'inbox_visibility_changed',
                   'recipient_rule_changed'
                 )),
  -- What it was done to: an invited address, a member's user id, an inbox id.
  target         text CHECK (target IS NULL OR length(target) <= 320),
  -- Small, value-free context: a role, a visibility, a domain-list diff
  -- (recipientRuleAuditDetails: at most 15 domains per list plus counts).
  -- Never message content, never a token. 16 KB leaves the largest diff room.
  details        jsonb NOT NULL DEFAULT '{}'::jsonb
                   CHECK (jsonb_typeof(details) = 'object' AND pg_column_size(details) <= 16384),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workspace_audit_events_workspace_created_idx
  ON public.workspace_audit_events (workspace_id, created_at DESC, id DESC);

ALTER TABLE public.workspace_audit_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.workspace_audit_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.workspace_audit_events TO authenticated;
GRANT ALL ON TABLE public.workspace_audit_events TO service_role;

DROP POLICY IF EXISTS "workspace_audit_events_select_admins" ON public.workspace_audit_events;
CREATE POLICY "workspace_audit_events_select_admins"
  ON public.workspace_audit_events FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
        FROM public.workspace_members wm
        JOIN public.workspaces w ON w.id = wm.workspace_id AND w.deleted_at IS NULL
       WHERE wm.workspace_id = workspace_audit_events.workspace_id
         AND wm.user_id = (SELECT auth.uid())
         AND wm.role IN ('owner', 'admin')
    )
  );

COMMENT ON TABLE public.workspace_audit_events IS
  'Append-only record of team changes (invites, members, roles, inbox visibility, the '
  'recipient rule). Written only by the server; owner/admin may read. Kept as long as '
  'the plan keeps mailbox-changing activity_log rows (purge_workspace_audit_events).';

-- Retention: the activity_log rule for a mailbox-changing call, i.e. the
-- plan's window (activity_log_retention_window_days via
-- activity_log_retention_workspace_windows) with the 90-day audit floor.
-- A team change is never a read-only call, so it never goes sooner.
CREATE OR REPLACE FUNCTION public.purge_workspace_audit_events_batch(
  p_limit integer DEFAULT 10000,
  p_min_days integer DEFAULT 90
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_floor integer := GREATEST(COALESCE(p_min_days, 90), 90);
  v_deleted integer;
BEGIN
  WITH win AS (
    SELECT * FROM public.activity_log_retention_workspace_windows()
  ),
  victims AS (
    SELECT e.id
      FROM public.workspace_audit_events e
      LEFT JOIN win ON win.workspace_id = e.workspace_id
     WHERE e.created_at < now() - make_interval(days => v_floor)
       AND e.created_at < now() - make_interval(days => GREATEST(COALESCE(win.days, 730), v_floor))
     LIMIT GREATEST(COALESCE(p_limit, 10000), 1)
  )
  DELETE FROM public.workspace_audit_events e
  USING victims v
  WHERE e.id = v.id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_workspace_audit_events_batch(integer, integer) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3. The recipient rule (Business only)
-- ------------------------------------------------------------
-- null = any recipient. Otherwise every To/Cc/Bcc address must be at one of
-- these domains (exact match, lower case, no subdomains) or the send is held
-- for an owner or admin to approve (mcp-server recipient-domain-rule.ts).
-- Written only by PUT /api/workspaces/[id]/recipient-rule (service role;
-- workspaces has no user write privilege, 20261016160100).
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS allowed_recipient_domains text[];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.workspaces'::regclass
       AND conname = 'workspaces_allowed_recipient_domains_check'
  ) THEN
    ALTER TABLE public.workspaces
      ADD CONSTRAINT workspaces_allowed_recipient_domains_check CHECK (
        allowed_recipient_domains IS NULL
        OR (
          cardinality(allowed_recipient_domains) BETWEEN 1 AND 100
          AND array_position(allowed_recipient_domains, NULL) IS NULL
        )
      );
  END IF;
END $$;

COMMENT ON COLUMN public.workspaces.allowed_recipient_domains IS
  'Business recipient rule. NULL = any recipient. Otherwise a send to any address outside '
  'these exact domains is held for owner/admin approval by mcp-server. Lower case, no '
  'subdomain matching.';

-- ------------------------------------------------------------
-- 4. send_approvals: why it was held, and whose send it is
-- ------------------------------------------------------------
-- hold_reason 'recipient_rule': only an owner or admin may decide it (the
-- inbox owner's own right to decide a held send on their private inbox does
-- not apply: the rule is the company's, apps/web/src/lib/approvals/access.ts).
-- NULL for every other hold.
ALTER TABLE public.send_approvals
  ADD COLUMN IF NOT EXISTS hold_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.send_approvals'::regclass
       AND conname = 'send_approvals_hold_reason_check'
  ) THEN
    ALTER TABLE public.send_approvals
      ADD CONSTRAINT send_approvals_hold_reason_check
      CHECK (hold_reason IS NULL OR hold_reason IN ('recipient_rule'));
  END IF;
END $$;

-- The person the send acts as (the key's creator). A scheduled send the rule
-- held at dispatch time has no key, so the dispatcher checks this person can
-- still use the inbox before the approved message goes out.
ALTER TABLE public.send_approvals
  ADD COLUMN IF NOT EXISTS requested_by uuid REFERENCES public.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.send_approvals.hold_reason IS
  '''recipient_rule'' when the workspace recipient rule held it (owner/admin decide only); '
  'NULL otherwise.';
COMMENT ON COLUMN public.send_approvals.requested_by IS
  'The person whose send this is (the API key''s creator, or the scheduler).';

-- ------------------------------------------------------------
-- 5. Retention job for workspace_audit_events (daily, after activity_log's)
-- ------------------------------------------------------------
-- A plain function call per day: the table is small (a handful of rows per
-- team change), so one batch of up to 10k is ample.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    PERFORM cron.schedule(
      'workspace-audit-retention',
      '20 2 * * *',
      'SELECT public.purge_workspace_audit_events_batch()'
    );
  END IF;
END $$;
