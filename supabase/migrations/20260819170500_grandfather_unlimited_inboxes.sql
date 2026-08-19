-- ============================================================================
-- 2026-08-19 repricing: grandfather every existing user's inboxes, forever.
--
-- The value metric moved from actions to CONNECTED INBOXES. Free is now one
-- inbox. Applying that retroactively would break people who connected three
-- mailboxes under the old rules and never agreed to anything else, so the
-- owner's decision is that every account that exists at this moment keeps
-- unlimited inboxes at no cost, permanently.
--
-- The grant is USER-level, not workspace-level, for the same reason the August
-- 3rd comped entitlement is: a user who creates a second workspace next year is
-- still the same person we made the promise to. `effective_workspace_plan`
-- joins the entitlement on `workspaces.owner_id`, so no per-workspace state and
-- no trigger is needed for a future workspace to inherit the protection.
--
-- The subject table is `public.users`, not `auth.users`: the entitlement's
-- primary key is a FK to `public.users(id)`, so backfilling from `auth.users`
-- would fail on any auth row that has no mirrored profile row.
-- ============================================================================

ALTER TABLE public.user_usage_entitlements
  ADD COLUMN IF NOT EXISTS unlimited_inboxes boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.user_usage_entitlements.unlimited_inboxes IS
  'Permanent inbox grandfather from the 2026-08-19 inbox-based repricing. True = the inbox cap never applies to this user, in any workspace they own.';

-- The audit trigger serialises with to_jsonb(NEW) and enumerates no columns, so
-- the new field lands in `record` with no change. Nothing to adjust here; this
-- comment exists so the next person does not have to re-derive that.

-- Backfill: EVERY user that exists right now.
--
-- `do update` rather than `do nothing`: the 7 pre-existing rows are comped_scale
-- grants, and they must keep their kind, reason and source while also gaining
-- the inbox grandfather. Only the new column is touched for them.
INSERT INTO public.user_usage_entitlements (user_id, kind, granted_at, reason, source, expires_at, unlimited_inboxes)
SELECT u.id,
       'standard',
       now(),
       'Pre-repricing account: unlimited inboxes grandfathered permanently (2026-08-19 inbox-based pricing)',
       'migration',
       NULL::timestamptz,
       true
FROM public.users u
ON CONFLICT (user_id) DO UPDATE SET unlimited_inboxes = true;

-- Fail the migration rather than silently under-covering the cohort. A missed
-- user is an existing customer who wakes up capped at one inbox.
DO $$
DECLARE
  v_users bigint;
  v_grandfathered bigint;
BEGIN
  SELECT count(*) INTO v_users FROM public.users;
  SELECT count(*) INTO v_grandfathered
    FROM public.user_usage_entitlements WHERE unlimited_inboxes = true;
  RAISE NOTICE 'inbox grandfather backfill: % users, % entitlements with unlimited_inboxes', v_users, v_grandfathered;
  IF v_grandfathered < v_users THEN
    RAISE EXCEPTION 'inbox grandfather backfill incomplete: % of % users covered', v_grandfathered, v_users;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- effective_workspace_plan gains a third column.
--
-- CREATE OR REPLACE cannot widen a RETURNS TABLE, so the function is dropped
-- and recreated inside this migration's transaction. Body, volatility, security
-- and the RLS gate (`my_workspace_ids()`) are unchanged: a member of someone
-- else's workspace still reads the owner's effective capabilities without being
-- able to read the entitlement row itself.
--
-- Adding a column is safe for existing callers: every caller reads named fields
-- off the first row (check-inbox-limit, check-member-limit, check-api-key-limit,
-- the dashboard loader), none destructures positionally or asserts a shape.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.effective_workspace_plan(uuid);

CREATE FUNCTION public.effective_workspace_plan(p_workspace_id uuid)
RETURNS TABLE(plan text, comped_scale boolean, unlimited_inboxes boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    CASE WHEN e.kind = 'comped_scale'
      AND (e.expires_at IS NULL OR e.expires_at > now()) THEN 'pro'
      ELSE w.plan
    END AS plan,
    (e.kind = 'comped_scale' AND (e.expires_at IS NULL OR e.expires_at > now())) AS comped_scale,
    -- The inbox grandfather is deliberately NOT expiry-gated the way the comped
    -- grant is. It was promised permanently, and every backfilled row has a
    -- NULL expires_at; gating it would let a support-set expiry on some future
    -- unrelated grant quietly revoke the promise.
    COALESCE(e.unlimited_inboxes, false) AS unlimited_inboxes
  FROM public.workspaces w
  LEFT JOIN public.user_usage_entitlements e ON e.user_id = w.owner_id
  WHERE w.id = p_workspace_id
    AND w.id = ANY(public.my_workspace_ids());
$$;

REVOKE ALL ON FUNCTION public.effective_workspace_plan(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.effective_workspace_plan(uuid) TO authenticated;
