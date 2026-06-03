-- H3 fix: per-session "revoke this device" was hitting auth.sessions via PostgREST
-- (service.schema('auth').from('sessions')). PostgREST only exposes public/graphql_public,
-- so every per-session lookup/delete returned PGRST106 "Invalid schema: auth" -> 500.
--
-- This function mirrors the existing get_current_user_sessions() pattern: a SECURITY DEFINER
-- function in the public schema that can read/write auth.sessions, but is scoped to the
-- calling user via auth.uid(). The route calls it through the RLS (user) client.
--
-- Ownership is enforced INSIDE the function (user_id = auth.uid()), so a caller can only
-- ever delete their own sessions regardless of the session id supplied.

CREATE OR REPLACE FUNCTION public.revoke_user_session(p_session_id uuid)
RETURNS TABLE (
  revoked_session_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  -- Unauthenticated callers (auth.uid() is null) can never match a row.
  IF v_uid IS NULL THEN
    RETURN;
  END IF;

  -- Delete only if the session exists AND belongs to the caller. The RETURNING
  -- clause yields one row on success and zero rows when the session does not
  -- exist or is owned by someone else (the route maps zero rows -> 404).
  RETURN QUERY
  DELETE FROM auth.sessions s
  WHERE s.id = p_session_id
    AND s.user_id = v_uid
  RETURNING s.id;
END;
$$;

-- Restrict invocation to authenticated users only (no anonymous access).
REVOKE ALL ON FUNCTION public.revoke_user_session(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_user_session(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.revoke_user_session(uuid) TO authenticated;
