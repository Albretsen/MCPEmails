-- ============================================================
-- MCPEmails — accept_workspace_invite must respect the seat cap and refuse a
-- dead workspace
-- 20260830140000_accept_invite_seat_cap_and_live_workspace
--
-- Two gaps, both of which let a pending invite outlive the conditions that
-- made it legitimate. An invite is valid for 7 days, and neither of these is
-- re-checked at the moment it is redeemed.
--
--   1. NO SEAT CAP. Seats are a Team (`pro`) capability: Free, Personal and
--      Pro (`solo`) are all single-user (PlanLimits.maxMembers === 1 in
--      apps/web/src/lib/stripe/plans.ts). POST /api/workspaces/invite enforces
--      that when the invite is CREATED, and nothing enforced it when the
--      invite is ACCEPTED. So a workspace that downgrades off Team between the
--      two, or one whose card simply fails, still gains members through
--      invites already in flight. The paywall is enforced on the wrong side of
--      a 7-day window.
--
--   2. NO LIVENESS CHECK. `workspaces.deleted_at` is the soft-delete marker,
--      and DELETE /api/workspaces/[id] drops every membership row and every
--      pending invite for a deleted workspace. But an invite issued for a
--      workspace deleted a moment later by a different path, or any row that
--      outlives that teardown, is still redeemable: the function joins nothing
--      against `workspaces` at all. A person could accept their way into a
--      workspace that no longer exists, ending up with a membership row
--      pointing at a tombstone.
--
-- WHY THE PLAN IS COMPUTED INLINE rather than by calling
-- public.effective_workspace_plan(). That function is RLS-gated: its WHERE
-- clause ends `AND w.id = ANY(public.my_workspace_ids())`, which is built from
-- auth.uid(). The person accepting an invite is BY DEFINITION not yet a member
-- of the workspace, so calling it here would return zero rows for every
-- legitimate accept and refuse everybody. This function is SECURITY DEFINER
-- and can read `workspaces` and `user_usage_entitlements` directly, so the
-- same expression is inlined. The `comped_scale` branch is kept identical to
-- the one in 20260819170500_grandfather_unlimited_inboxes: a comped workspace
-- resolves to 'pro' and therefore has seats.
--
-- The seat rule is expressed as "only a Team workspace may gain a second
-- member", not as a numeric cap read from a table, because the plan limits
-- live in TypeScript and there is no SQL mirror of them to drift against. Free
-- / Personal / Pro all have maxMembers = 1 and a workspace always has an
-- owner, so "member count >= 1 on a non-Team plan" is the whole of the cap.
--
-- GRANDFATHERING: none is needed. Verified at the time of the 2026-08-19
-- repricing that no workspace on any plan had more than one member, so this
-- cannot retroactively strand an existing multi-member workspace. If one is
-- ever found, it keeps its members: this gate only refuses NEW accepts.
--
-- Two new sentinels are raised, matching the existing P000n convention so the
-- accept route can map them to real status codes instead of a generic 500:
--   P0006  workspace_seat_limit   → 403 (the workspace must upgrade)
--   P0007  workspace_unavailable  → 410 (the workspace is gone)
-- ============================================================

CREATE OR REPLACE FUNCTION public.accept_workspace_invite(p_token_hash text)
RETURNS TABLE (
  workspace_id   uuid,
  workspace_slug text,
  role           text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          uuid := auth.uid();
  v_email        text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_invite       public.workspace_invites%ROWTYPE;
  v_slug         text;
  v_deleted_at   timestamptz;
  v_plan         text;
  v_member_count bigint;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'invite_not_found' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_invite
  FROM   public.workspace_invites
  WHERE  token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invite_not_found' USING ERRCODE = 'P0001';
  END IF;

  IF v_invite.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'invite_already_accepted' USING ERRCODE = 'P0002';
  END IF;

  IF v_invite.expires_at < now() THEN
    RAISE EXCEPTION 'invite_expired' USING ERRCODE = 'P0003';
  END IF;

  IF lower(v_invite.email) <> v_email THEN
    RAISE EXCEPTION 'invite_email_mismatch' USING ERRCODE = 'P0004';
  END IF;

  -- The workspace must still be alive. Read the slug in the same statement so
  -- the row is fetched once; it is returned at the bottom either way.
  SELECT w.slug, w.deleted_at,
         CASE WHEN e.kind = 'comped_scale'
                AND (e.expires_at IS NULL OR e.expires_at > now()) THEN 'pro'
              ELSE w.plan
         END
    INTO v_slug, v_deleted_at, v_plan
  FROM   public.workspaces w
  LEFT JOIN public.user_usage_entitlements e ON e.user_id = w.owner_id
  WHERE  w.id = v_invite.workspace_id;

  IF NOT FOUND OR v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'workspace_unavailable' USING ERRCODE = 'P0007';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.workspace_members wm
    WHERE  wm.workspace_id = v_invite.workspace_id
    AND    wm.user_id      = v_uid
  ) THEN
    RAISE EXCEPTION 'already_a_member' USING ERRCODE = 'P0005';
  END IF;

  -- Seat cap, re-checked at redemption. Counted under the same FOR UPDATE lock
  -- on the invite row that the race-safe INSERT below relies on; two DIFFERENT
  -- invites accepted at the same instant hold different locks, so the
  -- ON CONFLICT below stays the real guarantee and this is the plan gate, not
  -- a concurrency one.
  IF v_plan IS DISTINCT FROM 'pro' THEN
    SELECT count(*) INTO v_member_count
    FROM   public.workspace_members wm
    WHERE  wm.workspace_id = v_invite.workspace_id;

    IF v_member_count >= 1 THEN
      RAISE EXCEPTION 'workspace_seat_limit' USING ERRCODE = 'P0006';
    END IF;
  END IF;

  -- Race-safe: a concurrent accept of a different invite for the same
  -- (user, workspace) collides on the PK; treat that as already_a_member
  -- rather than letting a raw 23505 surface as a generic 500.
  -- Target the PK by constraint name: a bare `ON CONFLICT (workspace_id, ...)`
  -- column list would collide with the like-named RETURNS TABLE OUT parameter.
  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_invite.workspace_id, v_uid, v_invite.role)
  ON CONFLICT ON CONSTRAINT workspace_members_pkey DO NOTHING;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'already_a_member' USING ERRCODE = 'P0005';
  END IF;

  UPDATE public.workspace_invites
  SET    accepted_at = now()
  WHERE  id = v_invite.id;

  RETURN QUERY SELECT v_invite.workspace_id, v_slug, v_invite.role;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.accept_workspace_invite(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.accept_workspace_invite(text) TO authenticated;
