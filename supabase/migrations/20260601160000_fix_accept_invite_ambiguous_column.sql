-- ============================================================
-- MCPEmails — Fix ambiguous column reference in accept_workspace_invite
-- 20260601160000_fix_accept_invite_ambiguous_column
--
-- accept_workspace_invite(text) declares OUT parameters via
-- RETURNS TABLE(workspace_id uuid, workspace_slug text, role text).
-- The membership-existence check did `WHERE workspace_id = v_invite.workspace_id`
-- against public.workspace_members, whose own `workspace_id` column collides
-- with the like-named OUT parameter. Under plpgsql's default
-- variable_conflict = error, the bare reference raises:
--     ERROR: column reference "workspace_id" is ambiguous
--
-- That error message matches none of the invite_* sentinels the route maps,
-- so EVERY accept fell through to a generic 500. Fix: qualify the column
-- reference with the table name. OUT parameter names are unchanged so the
-- PostgREST JSON keys (workspace_id / workspace_slug / role) the route reads
-- stay stable.
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
  -- Identity comes from the verified JWT, never from the caller's arguments.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'invite_not_found' USING ERRCODE = 'P0001';
  END IF;

  -- Lock the invite row to prevent concurrent accepts of the same token.
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

  -- The signed-in user's email must match the invite's (case-insensitive).
  IF lower(v_invite.email) <> v_email THEN
    RAISE EXCEPTION 'invite_email_mismatch' USING ERRCODE = 'P0004';
  END IF;

  -- Qualify workspace_members.workspace_id: a bare `workspace_id` collides
  -- with the like-named OUT parameter and raises "ambiguous" otherwise.
  IF EXISTS (
    SELECT 1 FROM public.workspace_members wm
    WHERE  wm.workspace_id = v_invite.workspace_id
    AND    wm.user_id      = v_uid
  ) THEN
    RAISE EXCEPTION 'already_a_member' USING ERRCODE = 'P0005';
  END IF;

  -- Atomic write 1: create membership for the authenticated user.
  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_invite.workspace_id, v_uid, v_invite.role);

  -- Atomic write 2: consume the invite.
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
