-- ============================================================
-- MCPEmails — Workspace Invites & Member Role Expansion
-- 20260526000003_workspace_invites_and_member_roles
--
-- 1. Adds CHECK constraint + 'admin' role to workspace_members
-- 2. Creates workspace_invites table with indexes and RLS
-- 3. Creates get_workspace_members() SECURITY DEFINER helper
-- 4. Creates accept_workspace_invite() atomic RPC
-- 5. Creates expire_workspace_invites() + pg_cron job
-- ============================================================


-- ============================================================
-- 1. Role constraint on workspace_members
--
-- Existing values are 'owner' (all rows). Adding 'admin' between
-- owner and member. CHECK is safe to add with no existing violations.
-- ============================================================

ALTER TABLE public.workspace_members
  ADD CONSTRAINT workspace_members_role_check
  CHECK (role IN ('owner', 'admin', 'member', 'viewer'));


-- ============================================================
-- 2. workspace_invites table
-- ============================================================

CREATE TABLE public.workspace_invites (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid        NOT NULL REFERENCES public.workspaces(id)  ON DELETE CASCADE,
  invited_by    uuid        NOT NULL REFERENCES public.users(id)        ON DELETE CASCADE,
  email         text        NOT NULL,
  role          text        NOT NULL DEFAULT 'member',
  -- SHA-256 hex of the plaintext URL token. Never store the raw token.
  token_hash    text        NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT workspace_invites_role_check
    CHECK (role IN ('admin', 'member', 'viewer'))
);

-- Workspace-scoped lookups (list pending invites for a workspace)
CREATE INDEX idx_workspace_invites_workspace_id
  ON public.workspace_invites (workspace_id);

-- Email-scoped lookup (detect duplicate invite before inserting)
CREATE INDEX idx_workspace_invites_email
  ON public.workspace_invites (workspace_id, LOWER(email))
  WHERE accepted_at IS NULL;

-- Cleanup job index: fast scan of expired un-accepted rows
CREATE INDEX idx_workspace_invites_expires_pending
  ON public.workspace_invites (expires_at)
  WHERE accepted_at IS NULL;


-- ============================================================
-- 3. RLS on workspace_invites
--
-- Members can SELECT pending invites for their own workspace.
-- All writes (INSERT / UPDATE / DELETE) go through service_role
-- API routes — no authenticated write policies.
-- ============================================================

ALTER TABLE public.workspace_invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace_invites_select_members"
  ON public.workspace_invites FOR SELECT
  TO authenticated
  USING (workspace_id = ANY(public.my_workspace_ids()));


-- ============================================================
-- 4. get_workspace_members(p_workspace_id)
--
-- SECURITY DEFINER so it can join workspace_members → users even
-- though the "users_select_own" RLS policy hides other users' rows
-- from authenticated queries. Membership check is enforced inside
-- the function before any data is returned.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_workspace_members(p_workspace_id uuid)
RETURNS TABLE (
  user_id      uuid,
  role         text,
  joined_at    timestamptz,
  email        text,
  display_name text,
  avatar_url   text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Caller must be a member of the workspace; return empty set otherwise.
  IF NOT (p_workspace_id = ANY(public.my_workspace_ids())) THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT
      wm.user_id,
      wm.role,
      wm.joined_at,
      u.email,
      u.display_name,
      u.avatar_url
    FROM   public.workspace_members wm
    JOIN   public.users             u  ON u.id = wm.user_id
    WHERE  wm.workspace_id = p_workspace_id
    ORDER  BY wm.joined_at ASC;
END;
$$;


-- ============================================================
-- 5. accept_workspace_invite(p_token_hash, p_user_id, p_user_email)
--
-- Performs both writes atomically inside a single PL/pgSQL block:
--   a) INSERT INTO workspace_members
--   b) UPDATE workspace_invites SET accepted_at = now()
--
-- Called via supabase.rpc() from the Next.js route handler, which
-- passes the pre-computed SHA-256 hex of the raw URL token.
--
-- Error codes (SQLSTATE P0001–P0005) are caught in the route handler
-- and mapped to HTTP status codes:
--   P0001  invite_not_found       → 404
--   P0002  invite_already_accepted → 409
--   P0003  invite_expired         → 410
--   P0004  invite_email_mismatch  → 403
--   P0005  already_a_member       → 409
-- ============================================================

CREATE OR REPLACE FUNCTION public.accept_workspace_invite(
  p_token_hash  text,
  p_user_id     uuid,
  p_user_email  text
)
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
  v_invite  public.workspace_invites%ROWTYPE;
  v_slug    text;
BEGIN
  -- Lock the invite row to prevent concurrent accepts of the same token.
  SELECT * INTO v_invite
  FROM   public.workspace_invites
  WHERE  token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invite_not_found'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_invite.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'invite_already_accepted'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_invite.expires_at < now() THEN
    RAISE EXCEPTION 'invite_expired'
      USING ERRCODE = 'P0003';
  END IF;

  -- Email match is case-insensitive.
  IF LOWER(v_invite.email) <> LOWER(p_user_email) THEN
    RAISE EXCEPTION 'invite_email_mismatch'
      USING ERRCODE = 'P0004';
  END IF;

  -- Guard against double-membership.
  IF EXISTS (
    SELECT 1 FROM public.workspace_members
    WHERE  workspace_id = v_invite.workspace_id
    AND    user_id      = p_user_id
  ) THEN
    RAISE EXCEPTION 'already_a_member'
      USING ERRCODE = 'P0005';
  END IF;

  -- Atomic write 1: create membership.
  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_invite.workspace_id, p_user_id, v_invite.role);

  -- Atomic write 2: consume the invite.
  UPDATE public.workspace_invites
  SET    accepted_at = now()
  WHERE  id = v_invite.id;

  -- Return workspace context for the post-accept redirect.
  SELECT w.slug INTO v_slug
  FROM   public.workspaces w
  WHERE  w.id = v_invite.workspace_id;

  RETURN QUERY SELECT v_invite.workspace_id, v_slug, v_invite.role;
END;
$$;


-- ============================================================
-- 6. Expired-invite cleanup
--
-- Deletes un-accepted invites that expired more than 1 day ago
-- (1-day grace means very-recent expiries are retained for logging).
-- Runs at 3:15 AM UTC daily — offset from the partition job at 3:00.
-- ============================================================

CREATE OR REPLACE FUNCTION public.expire_workspace_invites()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.workspace_invites
  WHERE  accepted_at IS NULL
  AND    expires_at  < now() - interval '1 day';
END;
$$;

CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
  'expire-workspace-invites',
  '15 3 * * *',
  'SELECT public.expire_workspace_invites()'
);
