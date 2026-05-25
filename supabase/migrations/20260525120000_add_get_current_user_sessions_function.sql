-- Returns all active Supabase Auth sessions for the currently-authenticated user.
-- SECURITY DEFINER so the function can read auth.sessions (not in the public schema).
-- GRANT restricted to the authenticated role so anonymous callers cannot invoke it.

CREATE OR REPLACE FUNCTION public.get_current_user_sessions()
RETURNS TABLE (
  id           uuid,
  created_at   timestamptz,
  updated_at   timestamptz,
  user_agent   text,
  ip           text,
  not_after    timestamptz,
  refreshed_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT
    s.id,
    s.created_at,
    s.updated_at,
    s.user_agent,
    s.ip::text,
    s.not_after,
    s.refreshed_at::timestamptz
  FROM auth.sessions s
  WHERE s.user_id = auth.uid()
    AND (s.not_after IS NULL OR s.not_after > now())
  ORDER BY COALESCE(s.refreshed_at, s.updated_at::timestamp) DESC
  LIMIT 50;
$$;

-- Restrict invocation to authenticated users only (no anonymous access)
REVOKE ALL ON FUNCTION public.get_current_user_sessions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_current_user_sessions() TO authenticated;
