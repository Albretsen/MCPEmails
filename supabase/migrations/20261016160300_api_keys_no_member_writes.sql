-- ============================================================
-- api_keys: no direct writes from a browser session
-- ============================================================
-- WHY. The MCP server authenticates a request purely by key_hash equality and
-- then trusts the row's scopes and inbox_ids (supabase/functions/mcp-server,
-- the api_keys lookup in the request pipeline). Any row a caller can WRITE is
-- therefore a credential they can mint. The member policies from
-- 20261004100100 (api_keys_insert_members, api_keys_update_members) checked
-- only workspace membership, never role, so with their own session JWT and the
-- public anon key, through PostgREST:
--   - a viewer could INSERT a key with send/delete scopes and a key_hash of
--     their choosing, skipping the viewer allow-list and the plan key cap that
--     POST /api/api-keys enforces;
--   - any member could UPDATE another member's (or the owner's) key_hash to a
--     hash they know and take that key over, or widen its scopes/inbox_ids;
--   - a member could set created_by on their own key to the owner, so the key
--     survived their removal (revocation on removal filters on created_by).
--
-- FIX. Every legitimate write to api_keys already runs as service_role, after
-- the route has checked the caller's role:
--   apps/web  POST /api/api-keys (create; moved to service role in this change),
--             PATCH /api/api-keys/[id] (edit), PATCH /api/api-keys/[id]/revoke,
--             /api/oauth/token, /api/oauth/revoke, member removal / demotion,
--             workspace and account deletion, the card-listing stale marks;
--   edge fns  mcp-server (last_used_at, the card-listing mark), client-api
--             (the hidden web_client key);
--   SQL       revoke_dormant_oauth_grants() (SECURITY DEFINER).
-- So the browser roles lose every write privilege on the table. RLS still
-- governs SELECT, which is left exactly as it was: the dashboard lists keys
-- through the user client, and key_hash is a SHA-256 of a 256-bit random
-- secret.
--
-- TRUNCATE, REFERENCES and TRIGGER go too: Supabase grants them by default,
-- nothing here uses them from a browser session, and TRUNCATE is not subject
-- to RLS at all.
--
-- The two member write policies are left in place deliberately. Without the
-- grant they can never be reached, and keeping them means a later, narrower
-- grant (for example UPDATE on a single display column) would still be
-- confined to the caller's workspaces and to ordinary keys.
--
-- Idempotent: REVOKE of a privilege that is not held is a no-op.
-- ============================================================

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.api_keys
  FROM anon, authenticated;

-- PUBLIC holds nothing on this table by default; revoke anyway so a stray
-- GRANT ... TO PUBLIC cannot reopen the hole for both roles at once.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.api_keys
  FROM PUBLIC;

COMMENT ON TABLE public.api_keys IS
  'MCP API keys and OAuth access tokens (only key_hash is stored). Browser sessions (anon, authenticated) may SELECT ordinary keys in their workspaces under RLS and may not write at all: every write goes through a service-role route that checks the caller''s role first (migration 20261016160300).';
