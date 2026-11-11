-- ============================================================
-- MCPEmails - inbox ownership and visibility (the Business privacy model)
-- 20261111120000_inbox_owner_visibility
-- ============================================================
--
-- WHAT THIS ADDS
-- --------------
--   inboxes.owner_user_id  the person who connected the mailbox
--   inboxes.visibility     'private' (default) or 'company'
--
-- The access rule, used everywhere a person or a credential reaches an inbox:
--
--   a user U may see and use inbox I  <=>  U is a member of I's (live)
--   workspace AND (I.visibility = 'company' OR I.owner_user_id = U)
--
-- A private inbox whose owner left (owner_user_id set null by the FK) is
-- visible to nobody until an owner/admin disconnects it.
--
-- Workspace owners and admins additionally see the METADATA of every inbox
-- (address, owner, status, visibility) through workspace_inbox_directory();
-- never the row itself, so never its signature, instructions or mail.
--
-- WHY THIS IS SAFE TO APPLY WITH business_seat_pricing OFF
-- --------------------------------------------------------
-- The backfill keeps every current access path open:
--   * owner_user_id := the workspace owner, for every existing inbox;
--   * visibility    := 'company' in a workspace that has any member other
--                      than its owner today, 'private' everywhere else.
-- In a single-member workspace the only member is the owner, who owns every
-- inbox, so nothing changes. In a shared workspace everything is company-wide,
-- which is exactly today's "every member sees every inbox".
--
-- Idempotent: columns, constraints, policies and functions are created with
-- IF NOT EXISTS / OR REPLACE / DROP IF EXISTS, and the backfill only touches
-- rows whose owner_user_id is still null.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Columns
-- ------------------------------------------------------------
ALTER TABLE public.inboxes
  ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL;

-- Added nullable first so the backfill below can tell "not yet decided" rows
-- apart; the default and NOT NULL are set after it.
ALTER TABLE public.inboxes
  ADD COLUMN IF NOT EXISTS visibility text;

-- ------------------------------------------------------------
-- 2. Backfill (only rows not yet backfilled)
-- ------------------------------------------------------------
UPDATE public.inboxes i
   SET visibility = CASE
         WHEN EXISTS (
           SELECT 1 FROM public.workspace_members wm
            WHERE wm.workspace_id = i.workspace_id
              AND wm.user_id IS DISTINCT FROM w.owner_id
         ) THEN 'company'
         ELSE 'private'
       END
  FROM public.workspaces w
 WHERE w.id = i.workspace_id
   AND i.visibility IS NULL;

UPDATE public.inboxes i
   SET owner_user_id = w.owner_id
  FROM public.workspaces w
 WHERE w.id = i.workspace_id
   AND i.owner_user_id IS NULL
   AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = w.owner_id);

-- Anything the join above could not place (no workspace row) stays private.
UPDATE public.inboxes SET visibility = 'private' WHERE visibility IS NULL;

ALTER TABLE public.inboxes ALTER COLUMN visibility SET DEFAULT 'private';
ALTER TABLE public.inboxes ALTER COLUMN visibility SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.inboxes'::regclass AND conname = 'inboxes_visibility_check'
  ) THEN
    ALTER TABLE public.inboxes
      ADD CONSTRAINT inboxes_visibility_check CHECK (visibility IN ('private', 'company'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS inboxes_workspace_visibility_owner_idx
  ON public.inboxes (workspace_id, visibility, owner_user_id);

COMMENT ON COLUMN public.inboxes.owner_user_id IS
  'The person who connected this mailbox. Private inboxes are visible only to this user. '
  'Set on insert (defaults to the workspace owner) and immutable while the inbox is live.';
COMMENT ON COLUMN public.inboxes.visibility IS
  '''private'' (only owner_user_id) or ''company'' (every workspace member). '
  'Only the owner changes it, through PATCH /api/inboxes/[id]/visibility.';

-- ------------------------------------------------------------
-- 3. Owner defaults and immutability
-- ------------------------------------------------------------
-- Every connect route runs as the service role (auth.uid() is null) and sets
-- owner_user_id itself. This trigger is the backstop:
--   * INSERT without an owner: the signed-in user, else the workspace owner,
--     so a forgotten column can never produce an inbox nobody can see.
--   * UPDATE on a live row: the owner never changes to another person (it may
--     only be cleared, by the owner's account being deleted). The connect routes
--     upsert on (workspace_id, email_address), and a reconnect by somebody
--     else must not take the mailbox over. A row that was soft-deleted and is
--     being revived is a new connection: the new owner is kept, and when it
--     is a different person the mailbox starts private again.
CREATE OR REPLACE FUNCTION public.inboxes_owner_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.owner_user_id IS NULL THEN
      NEW.owner_user_id := COALESCE(
        auth.uid(),
        (SELECT w.owner_id FROM public.workspaces w WHERE w.id = NEW.workspace_id)
      );
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
    -- Revival: a fresh connection.
    IF NEW.owner_user_id IS NULL THEN
      NEW.owner_user_id := COALESCE(OLD.owner_user_id,
        (SELECT w.owner_id FROM public.workspaces w WHERE w.id = NEW.workspace_id));
    END IF;
    IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN
      NEW.visibility := 'private';
    END IF;
    RETURN NEW;
  END IF;

  -- A live inbox keeps its owner. Clearing it is allowed: that is the
  -- ON DELETE SET NULL of the owner's account (blocking it would block
  -- account deletion).
  IF OLD.owner_user_id IS NOT NULL AND NEW.owner_user_id IS NOT NULL THEN
    NEW.owner_user_id := OLD.owner_user_id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.inboxes_owner_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS inboxes_owner_guard ON public.inboxes;
CREATE TRIGGER inboxes_owner_guard
  BEFORE INSERT OR UPDATE OF owner_user_id, deleted_at ON public.inboxes
  FOR EACH ROW EXECUTE FUNCTION public.inboxes_owner_guard();

-- ------------------------------------------------------------
-- 4. Helpers
-- ------------------------------------------------------------

-- Is inbox p_inbox_id visible to p_user_id? Ignores deleted_at and parked_at
-- on purpose: callers keep their own reachability filters.
CREATE OR REPLACE FUNCTION public.inbox_visible_to(p_inbox_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.inboxes i
      JOIN public.workspace_members wm ON wm.workspace_id = i.workspace_id AND wm.user_id = p_user_id
      JOIN public.workspaces w ON w.id = i.workspace_id AND w.deleted_at IS NULL
     WHERE i.id = p_inbox_id
       AND p_user_id IS NOT NULL
       AND (i.visibility = 'company' OR i.owner_user_id = p_user_id)
  );
$$;

-- Every inbox id in p_workspace_id that p_user_id may see (empty when not a member).
CREATE OR REPLACE FUNCTION public.visible_inbox_ids(p_workspace_id uuid, p_user_id uuid)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ARRAY(
    SELECT i.id
      FROM public.inboxes i
      JOIN public.workspace_members wm ON wm.workspace_id = i.workspace_id AND wm.user_id = p_user_id
      JOIN public.workspaces w ON w.id = i.workspace_id AND w.deleted_at IS NULL
     WHERE i.workspace_id = p_workspace_id
       AND p_user_id IS NOT NULL
       AND (i.visibility = 'company' OR i.owner_user_id = p_user_id)
  );
$$;

-- The signed-in user's visible inboxes across all workspaces, for RLS. Wrapped
-- as `(SELECT public.my_visible_inbox_ids())` in policies so it runs once per
-- statement, not once per row.
CREATE OR REPLACE FUNCTION public.my_visible_inbox_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ARRAY(
    SELECT i.id
      FROM public.inboxes i
      JOIN public.workspace_members wm ON wm.workspace_id = i.workspace_id AND wm.user_id = auth.uid()
      JOIN public.workspaces w ON w.id = i.workspace_id AND w.deleted_at IS NULL
     WHERE i.visibility = 'company' OR i.owner_user_id = auth.uid()
  );
$$;

-- What a credential (API key or OAuth grant) acting as p_user_id may reach in
-- p_workspace_id, given its own allow-list p_inbox_ids (null or empty = all).
--
--   {"restricted": false, "inbox_ids": <p_inbox_ids as given>}
--       nothing in the workspace is hidden from this user: use the key as is
--       (the common case, and every single-member workspace).
--   {"restricted": true,  "inbox_ids": [...]}
--       use exactly this list; an EMPTY list means the credential reaches
--       nothing (the user is no longer a member, or every allowed inbox is
--       someone else's private inbox).
--
-- p_user_id null (a key minted before created_by existed) acts as the
-- workspace owner, which is who could mint keys then.
CREATE OR REPLACE FUNCTION public.credential_inbox_scope(
  p_workspace_id uuid,
  p_user_id uuid,
  p_inbox_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user   uuid;
  v_hidden uuid[];
  v_ids    uuid[];
BEGIN
  SELECT COALESCE(p_user_id, w.owner_id) INTO v_user
    FROM public.workspaces w
   WHERE w.id = p_workspace_id AND w.deleted_at IS NULL;

  IF v_user IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.workspace_members wm
     WHERE wm.workspace_id = p_workspace_id AND wm.user_id = v_user
  ) THEN
    RETURN jsonb_build_object('restricted', true, 'inbox_ids', '[]'::jsonb);
  END IF;

  v_hidden := ARRAY(
    SELECT i.id FROM public.inboxes i
     WHERE i.workspace_id = p_workspace_id
       AND i.visibility = 'private'
       AND i.owner_user_id IS DISTINCT FROM v_user
  );

  IF cardinality(v_hidden) = 0 THEN
    RETURN jsonb_build_object('restricted', false, 'inbox_ids', to_jsonb(p_inbox_ids));
  END IF;

  IF p_inbox_ids IS NOT NULL AND cardinality(p_inbox_ids) > 0 THEN
    v_ids := ARRAY(SELECT x FROM unnest(p_inbox_ids) AS x WHERE NOT (x = ANY (v_hidden)));
  ELSE
    v_ids := ARRAY(
      SELECT i.id FROM public.inboxes i
       WHERE i.workspace_id = p_workspace_id
         AND NOT (i.id = ANY (v_hidden))
       ORDER BY i.id
    );
  END IF;

  RETURN jsonb_build_object('restricted', true, 'inbox_ids', to_jsonb(v_ids));
END;
$$;

-- The same scope, looked up by the bearer key's hash, so the MCP server can ask
-- it IN PARALLEL with mcp_tools_call_gate (same three key filters) and add no
-- serial round trip to a tool call. Returns null for an unknown, revoked or
-- expired key; otherwise the credential_inbox_scope answer plus `key_id`,
-- which the caller matches against the key the gate accepted.
CREATE OR REPLACE FUNCTION public.credential_inbox_scope_for_key(p_key_hash text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.credential_inbox_scope(k.workspace_id, k.created_by, k.inbox_ids)
         || jsonb_build_object('key_id', k.id)
    FROM public.api_keys k
   WHERE k.key_hash = p_key_hash
     AND k.deleted_at IS NULL
     AND (k.expires_at IS NULL OR k.expires_at > now())
   LIMIT 1;
$$;

-- Inbox metadata for the dashboard. Owners and admins get every live inbox in
-- the workspace (so they can manage seats and disconnect); everybody else gets
-- only the inboxes they can see. Metadata only: no signature, no instructions,
-- no connection secrets. `can_access` says whether the caller may open it.
CREATE OR REPLACE FUNCTION public.workspace_inbox_directory(p_workspace_id uuid)
RETURNS TABLE (
  id                 uuid,
  email_address      text,
  display_name       text,
  provider           text,
  service            text,
  status             text,
  visibility         text,
  owner_user_id      uuid,
  owner_email        text,
  owner_display_name text,
  parked_at          timestamptz,
  created_at         timestamptz,
  can_access         boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (
    SELECT wm.role
      FROM public.workspace_members wm
      JOIN public.workspaces w ON w.id = wm.workspace_id AND w.deleted_at IS NULL
     WHERE wm.workspace_id = p_workspace_id AND wm.user_id = auth.uid()
  )
  SELECT i.id, i.email_address, i.display_name, i.provider, i.service, i.status,
         i.visibility, i.owner_user_id, u.email, u.display_name, i.parked_at, i.created_at,
         (i.visibility = 'company' OR i.owner_user_id = auth.uid()) AS can_access
    FROM public.inboxes i
    JOIN me ON true
    LEFT JOIN public.users u ON u.id = i.owner_user_id
   WHERE i.workspace_id = p_workspace_id
     AND i.deleted_at IS NULL
     AND (
       me.role IN ('owner', 'admin')
       OR i.visibility = 'company'
       OR i.owner_user_id = auth.uid()
     )
   ORDER BY i.created_at;
$$;

REVOKE EXECUTE ON FUNCTION public.inbox_visible_to(uuid, uuid)               FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.visible_inbox_ids(uuid, uuid)              FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.credential_inbox_scope(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.credential_inbox_scope_for_key(text)       FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.my_visible_inbox_ids()                     FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.workspace_inbox_directory(uuid)            FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.inbox_visible_to(uuid, uuid)               TO service_role;
GRANT  EXECUTE ON FUNCTION public.visible_inbox_ids(uuid, uuid)              TO service_role;
GRANT  EXECUTE ON FUNCTION public.credential_inbox_scope(uuid, uuid, uuid[]) TO service_role;
GRANT  EXECUTE ON FUNCTION public.credential_inbox_scope_for_key(text)       TO service_role;
GRANT  EXECUTE ON FUNCTION public.my_visible_inbox_ids()                     TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.workspace_inbox_directory(uuid)            TO authenticated, service_role;

-- ------------------------------------------------------------
-- 5. Column grants: members read the two new columns (the catalog test in
--    supabase/tests/inboxes_user_access.sql fails on a column without one).
-- ------------------------------------------------------------
GRANT SELECT (owner_user_id, visibility) ON public.inboxes TO authenticated;

-- ------------------------------------------------------------
-- 6. RLS: inboxes
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "inboxes_select_members" ON public.inboxes;
CREATE POLICY "inboxes_select_members"
  ON public.inboxes FOR SELECT
  TO authenticated
  USING (
    workspace_id = ANY(public.my_workspace_ids())
    AND deleted_at IS NULL
    AND (visibility = 'company' OR owner_user_id = auth.uid())
  );

-- ------------------------------------------------------------
-- 7. RLS: every table that exposes an inbox's content or settings by
--    inbox_id. Same workspace rule as before, plus the inbox must be visible.
--    Rows with no inbox (inbox_id null) keep the workspace rule alone.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "send_approvals_select_members" ON public.send_approvals;
CREATE POLICY "send_approvals_select_members"
  ON public.send_approvals FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
       WHERE wm.workspace_id = send_approvals.workspace_id AND wm.user_id = auth.uid()
    )
    AND (inbox_id IS NULL OR inbox_id = ANY ((SELECT public.my_visible_inbox_ids())::uuid[]))
  );

DROP POLICY IF EXISTS "bulk_plans_select_members" ON public.bulk_plans;
CREATE POLICY "bulk_plans_select_members"
  ON public.bulk_plans FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
       WHERE wm.workspace_id = bulk_plans.workspace_id AND wm.user_id = auth.uid()
    )
    AND (inbox_id IS NULL OR inbox_id = ANY ((SELECT public.my_visible_inbox_ids())::uuid[]))
  );

DROP POLICY IF EXISTS "scheduled_sends_select_members" ON public.scheduled_sends;
CREATE POLICY "scheduled_sends_select_members"
  ON public.scheduled_sends FOR SELECT
  TO authenticated
  USING (
    workspace_id = ANY(public.my_workspace_ids())
    AND (inbox_id IS NULL OR inbox_id = ANY ((SELECT public.my_visible_inbox_ids())::uuid[]))
  );

DROP POLICY IF EXISTS "scheduled_sends_cancel_members" ON public.scheduled_sends;
CREATE POLICY "scheduled_sends_cancel_members"
  ON public.scheduled_sends FOR UPDATE
  TO authenticated
  USING (
    workspace_id = ANY(public.scheduled_sends_operator_workspace_ids())
    AND status = 'pending'
    AND (inbox_id IS NULL OR inbox_id = ANY ((SELECT public.my_visible_inbox_ids())::uuid[]))
  )
  WITH CHECK (
    workspace_id = ANY(public.scheduled_sends_operator_workspace_ids())
    AND status = 'cancelled'
  );

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'bulk_runs', 'inbox_sender_aliases', 'reminders', 'subscription_plans',
    'triage_rules', 'unsubscribe_requests', 'webhook_deliveries'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select_members', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ('
      'workspace_id = ANY(public.my_workspace_ids()) '
      'AND (inbox_id IS NULL OR inbox_id = ANY ((SELECT public.my_visible_inbox_ids())::uuid[])))',
      t || '_select_members', t
    );
  END LOOP;
END $$;

-- activity_log: the parent and every partition carry their own policy.
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
      'AND (inbox_id IS NULL OR inbox_id = ANY ((SELECT public.my_visible_inbox_ids())::uuid[])))',
      pname || '_select_members', pname
    );
  END LOOP;
END $$;

-- Future activity_log partitions get the same policy.
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
        'AND (inbox_id IS NULL OR inbox_id = ANY ((SELECT public.my_visible_inbox_ids())::uuid[])))',
        p_name || '_select_members', p_name
      );
    END IF;
  END LOOP;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.ensure_activity_log_partitions(int) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 8. scheduled_sends.created_by: who a scheduled send acts as. The dispatcher
--    refuses a row whose creator can no longer see its inbox. Null (rows from
--    before this migration, or a key with no creator) acts as the workspace
--    owner, the same rule as credential_inbox_scope.
-- ------------------------------------------------------------
ALTER TABLE public.scheduled_sends
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.users(id) ON DELETE SET NULL;

-- ------------------------------------------------------------
-- 9. The Business seat-pricing switch (off in production).
-- ------------------------------------------------------------
INSERT INTO public.pricing_switches (key, enabled, note)
VALUES ('business_seat_pricing', false,
        'Business as a per-person team plan: $19 per person, 2 minimum, seat sync, '
        'company-wide mailbox counting. Off = today''s flat Business. Staging turns it on.')
ON CONFLICT (key) DO NOTHING;
