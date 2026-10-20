-- ============================================================================
-- public.inboxes: no direct user writes, no credential ciphertext for users.
-- ============================================================================
--
-- WHY. Until this file, `inboxes_insert_members` and `inboxes_update_members`
-- (20260524150000_row_level_security_policies.sql) let ANY workspace member,
-- viewers included, INSERT or UPDATE any column of public.inboxes straight
-- through PostgREST with the public anon key and their own session JWT. The
-- policies checked only `workspace_id = ANY(my_workspace_ids())`, never the
-- role and never the column. Proven paths:
--
--   * repoint imap_host / smtp_host at an attacker server: the next connection
--     check or MCP call decrypts imap_password and logs in THERE (credential
--     theft);
--   * set send_review_mode = 'off' / send_approval_required = false, the
--     owner/admin-only outbound review gate (lib/workspace/roles.ts);
--   * change workspace_id to another workspace the caller belongs to (WITH
--     CHECK only looked at the NEW value), taking the mailbox and its
--     credentials with it;
--   * INSERT rows directly, bypassing the role check, guardMailHost, the plan
--     inbox cap and the provider-conflict checks, reusing ciphertext read from
--     another row (the SELECT policy returned every column).
--
-- WHAT LEGITIMATELY WRITES THIS TABLE. Every write is a server route or an
-- edge function on the SERVICE-ROLE client, after its own authentication and
-- role check:
--   connect:     apps/web/app/api/inboxes/{imap,app-password,fastmail-app-password}
--                and the Gmail / Outlook OAuth callbacks (upsert)
--   settings:    PATCH /api/inboxes/[id] (canManageInboxes, review gate
--                canManageWorkspace), signature image route
--   disconnect:  DELETE /api/inboxes/[id], workspace and account deletion
--   health:      POST /api/inboxes/[id]/check (moved to service role in the
--                same change as this migration), token refreshers, mcp-server,
--                client-api
-- No user-scoped client writes inboxes, so there is no column worth keeping a
-- user UPDATE grant for: the whole write surface is revoked, and the two
-- write policies are dropped so nothing suggests otherwise.
--
-- WHAT USERS STILL READ. Workspace members keep SELECT (RLS still scopes it to
-- their workspaces and to non-deleted rows) on every column EXCEPT the three
-- encrypted credentials: imap_password, oauth_access_token,
-- oauth_refresh_token. The dashboard, /authorize and the route authorization
-- reads never select those; the two routes that need them (disconnect, check)
-- read them with the service-role client after the role check.
--
-- MAINTENANCE TRAP, read before adding a column to public.inboxes. Column
-- grants do not extend to columns added later. A new non-secret column that
-- the dashboard reads through the user client needs its own
--   GRANT SELECT (<column>) ON public.inboxes TO authenticated;
-- in the migration that adds it, or that select fails with 42501. The pgTAP
-- test supabase/tests/inboxes_user_access.sql fails on any column that is
-- neither granted nor on the secret list, so the omission cannot ship quietly.
--
-- Idempotent: REVOKE/GRANT are re-runnable, policies are dropped IF EXISTS,
-- and the column grant is computed from the live catalog.
-- ============================================================================

-- 1. Writes: none for anon/authenticated. REVOKE ALL also removes TRUNCATE,
--    REFERENCES and TRIGGER, which Supabase's default grants hand out and RLS
--    does not govern.
REVOKE ALL ON TABLE public.inboxes FROM anon, authenticated;

DROP POLICY IF EXISTS "inboxes_insert_members" ON public.inboxes;
DROP POLICY IF EXISTS "inboxes_update_members" ON public.inboxes;

-- 2. Reads: every column except the encrypted credentials, to authenticated
--    only. anon has no SELECT policy on inboxes, so it gets nothing.
DO $$
DECLARE
  cols text;
BEGIN
  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum)
    INTO cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.inboxes'::regclass
     AND a.attnum > 0
     AND NOT a.attisdropped
     AND a.attname NOT IN ('imap_password', 'oauth_access_token', 'oauth_refresh_token');

  -- REVOKE ALL ON TABLE above also revoked every column-level grant (Postgres
  -- revokes the matching column privileges with a table privilege), so after
  -- this GRANT the secrets are the only columns authenticated cannot read.
  EXECUTE format('GRANT SELECT (%s) ON public.inboxes TO authenticated', cols);
END $$;

-- 3. service_role keeps full access (it already has it; restated so a
--    hand-applied run on a database that drifted cannot lock the server out).
GRANT ALL ON TABLE public.inboxes TO service_role;

COMMENT ON TABLE public.inboxes IS
  'Connected mailboxes. Written ONLY by service-role server code; authenticated '
  'may SELECT every column except imap_password / oauth_access_token / '
  'oauth_refresh_token (20261016160200). A new column read through the user '
  'client needs its own GRANT SELECT (col) TO authenticated.';
