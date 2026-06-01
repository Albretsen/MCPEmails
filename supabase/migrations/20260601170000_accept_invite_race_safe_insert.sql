-- ============================================================
-- MCPEmails — Make accept_workspace_invite membership INSERT race-safe
-- 20260601170000_accept_invite_race_safe_insert
--
-- The already-a-member EXISTS check and the INSERT are not atomic against
-- each other, and FOR UPDATE locks only the *invite* row. Two different
-- invites for the same (user, workspace) accepted concurrently could both
-- pass EXISTS and then collide on the workspace_members PK (workspace_id,
-- user_id), raising SQLSTATE 23505. That message matches none of the invite_*
-- sentinels the route maps, so it fell through to a generic 500 instead of the
-- friendly "already a member" 409.
--
-- Fix: ON CONFLICT DO NOTHING on the membership INSERT; if no row was inserted
-- (someone won the race), raise the existing already_a_member (P0005) sentinel.
-- The early EXISTS check is kept for the common fast path.
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
  v_uid    uuid := auth.uid();
  v_email  text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_invite public.workspace_invites%ROWTYPE;
  v_slug   text;
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

  IF EXISTS (
    SELECT 1 FROM public.workspace_members wm
    WHERE  wm.workspace_id = v_invite.workspace_id
    AND    wm.user_id      = v_uid
  ) THEN
    RAISE EXCEPTION 'already_a_member' USING ERRCODE = 'P0005';
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

  SELECT w.slug INTO v_slug
  FROM   public.workspaces w
  WHERE  w.id = v_invite.workspace_id;

  RETURN QUERY SELECT v_invite.workspace_id, v_slug, v_invite.role;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.accept_workspace_invite(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.accept_workspace_invite(text) TO authenticated;
