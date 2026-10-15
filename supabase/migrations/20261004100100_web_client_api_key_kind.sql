-- ===========================================================================
-- api_keys.kind — marks the hidden per-workspace "web client" key
-- 20261004100100_web_client_api_key_kind
--
-- WHY A KEY ROW AT ALL. The tool layer the web client shares with the MCP
-- server takes an `api_keys` row as its caller identity, and five tables have
-- foreign keys to `api_keys(id)`, two of them NOT NULL (outbound_idempotency,
-- mcp_client_capabilities). A human using app.mcpemails.com has a Supabase
-- session, not an API key, so `client-api` acts through ONE system-owned row
-- per workspace, created lazily by the service role:
--
--   kind        'web_client'
--   name        '__web_client__'
--   key_prefix  'mcpe_webclient'
--   key_hash    '!web-client:' || 64 random hex   (not a SHA-256 hex digest,
--               so no presented key can ever hash to it: the row is unusable
--               as a credential on the MCP endpoint)
--   created_by  NULL  (member-removal sweeps filter on created_by and must
--               never match it)
--
-- WHAT THIS MIGRATION DOES, IN ORDER
-- ----------------------------------
--   1. api_keys.kind, nullable, CHECK (kind IS NULL OR kind = 'web_client').
--      NULL is every key that exists today and every key a person or an OAuth
--      client creates from now on. Nothing is backfilled.
--   2. A partial unique index: at most one LIVE web_client key per workspace.
--      It is what makes the lazy create race-safe across isolates.
--   3. RLS: the three member policies on api_keys gain `kind IS NULL`, so a
--      browser session can neither see, create, nor edit a system key through
--      PostgREST. Before this change the INSERT policy would have let a member
--      insert a row with any `kind`, and the UPDATE policy would have let any
--      member rewrite the hidden row's scopes.
--
-- WHAT THE RLS CHANGE HIDES IT FROM, with no application change, because each
-- of these reads through the user's own session:
--   - the dashboard key list, sidebar badge and overview card
--     (apps/web/app/dashboard/[[...section]]/page.js fetchApiKeys)
--   - the plan-limit key count (apps/web/src/lib/plans/check-api-key-limit.ts)
--   - the audit log's embedded api_keys(name, key_prefix)
--
-- WHAT IT DOES NOT COVER. Code that reads api_keys with the SERVICE ROLE
-- bypasses RLS. The SQL functions are handled in 20261004100200. The web app's
-- service-role routes (revoke by id, PATCH by id, automation key pinning) need
-- a `.is('kind', null)` filter in apps/web; they are listed in the PR notes.
--
-- Forward-only and re-runnable: ADD COLUMN IF NOT EXISTS, the constraint and
-- policies are dropped-if-present and re-created, CREATE INDEX IF NOT EXISTS.
-- NOT APPLIED BY THE AGENT THAT WROTE IT.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------
ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS kind text;

ALTER TABLE public.api_keys
  DROP CONSTRAINT IF EXISTS api_keys_kind_check;
ALTER TABLE public.api_keys
  ADD CONSTRAINT api_keys_kind_check
    CHECK (kind IS NULL OR kind IN ('web_client'));

COMMENT ON COLUMN public.api_keys.kind IS
  'NULL = an ordinary key (dashboard-created or OAuth-issued). ''web_client'' = the hidden, system-owned key the client-api edge function acts through for a workspace: unusable key_hash, created_by NULL, never shown to users, never counted, never swept. Any listing, count or sweep over api_keys that runs as the service role must filter kind IS NULL.';


-- ---------------------------------------------------------------------------
-- 2. One live web-client key per workspace
--
-- client-api creates the row on first use. Two isolates can race to do that;
-- the second INSERT fails on this index and re-reads the winner's row.
-- Partial on deleted_at so a workspace whose key was soft-deleted (workspace
-- deletion revokes every key) can get a fresh one if it is ever restored.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_one_web_client_per_workspace_idx
  ON public.api_keys (workspace_id)
  WHERE kind = 'web_client' AND deleted_at IS NULL;


-- ---------------------------------------------------------------------------
-- 3. RLS: members only ever see and touch ordinary keys
--
-- Same three policies as 20260524150000, each with `kind IS NULL` added.
-- There is still no DELETE policy: keys are revoked by soft delete.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "api_keys_select_members" ON public.api_keys;
CREATE POLICY "api_keys_select_members"
  ON public.api_keys FOR SELECT
  TO authenticated
  USING (
    workspace_id = ANY(public.my_workspace_ids())
    AND deleted_at IS NULL
    AND kind IS NULL
  );

DROP POLICY IF EXISTS "api_keys_insert_members" ON public.api_keys;
CREATE POLICY "api_keys_insert_members"
  ON public.api_keys FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id = ANY(public.my_workspace_ids())
    AND created_by = auth.uid()
    AND kind IS NULL
  );

DROP POLICY IF EXISTS "api_keys_update_members" ON public.api_keys;
CREATE POLICY "api_keys_update_members"
  ON public.api_keys FOR UPDATE
  TO authenticated
  USING (
    workspace_id = ANY(public.my_workspace_ids())
    AND deleted_at IS NULL
    AND kind IS NULL
  )
  WITH CHECK (
    workspace_id = ANY(public.my_workspace_ids())
    AND kind IS NULL
  );
