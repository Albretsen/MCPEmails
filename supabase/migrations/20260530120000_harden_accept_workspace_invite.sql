-- ============================================================
-- MCPEmails — Harden accept_workspace_invite
-- 20260530120000_harden_accept_workspace_invite
--
-- The original accept_workspace_invite(p_token_hash, p_user_id, p_user_email)
-- TRUSTED caller-supplied identity parameters and was EXECUTE-able by PUBLIC.
-- An attacker who possessed an invite token (it travels in the invite email
-- link) or who could read a pending invite's token_hash (workspace members can
-- via RLS) could call the RPC directly through PostgREST, supply an arbitrary
-- p_user_id, and forge p_user_email to satisfy the email-match check — adding
-- an arbitrary account to the workspace with the invite's role.
--
-- Fix: derive the accepting identity from the verified session inside the
-- function (auth.uid() + auth.jwt() email claim), drop the trusted params, and
-- restrict EXECUTE to the authenticated role only. Must be called with the
-- USER's client (so auth.uid() is populated), NOT the service role.
-- ============================================================

-- Drop the insecure 3-argument version.
DROP FUNCTION IF EXISTS public.accept_workspace_invite(text, uuid, text);

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

  IF EXISTS (
    SELECT 1 FROM public.workspace_members
    WHERE  workspace_id = v_invite.workspace_id
    AND    user_id      = v_uid
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

-- Only signed-in users may accept invites; remove the default PUBLIC grant.
REVOKE EXECUTE ON FUNCTION public.accept_workspace_invite(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.accept_workspace_invite(text) TO authenticated;
