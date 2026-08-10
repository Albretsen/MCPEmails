-- ---------------------------------------------------------------------------
-- MCP client capability observation
--
-- Records what each connecting MCP client declares at `initialize`: its name,
-- version, the protocol version it asked for, and its raw capability object.
--
-- Purely observational. Nothing in the server branches on these rows, and in
-- particular UI (`_meta.ui`) metadata is emitted UNCONDITIONALLY regardless of
-- what is recorded here. The Phase 0 spike found that the official MCP Apps
-- reference host sends `capabilities: {}` with no `extensions` key at all and
-- yet renders apps correctly, so gating behaviour on the declared extension
-- would degrade a conforming host to a text-only tool surface. The declaration
-- is a reliable positive signal when present and carries no information when
-- absent; this table exists so we can find out what real hosts actually send.
--
-- `initialize` is called once per host page load, so write volume is roughly
-- one upsert per client session, not per tool call.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.mcp_client_capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  api_key_id uuid NOT NULL REFERENCES public.api_keys(id) ON DELETE CASCADE,

  -- Client identity from `initialize` params `clientInfo`. NOT NULL with an
  -- 'unknown' fallback rather than nullable: these columns form the upsert
  -- conflict target, and NULLs are never equal in a unique index, so a client
  -- that omits `clientInfo` would insert an unbounded number of duplicate rows.
  client_name text NOT NULL DEFAULT 'unknown',
  client_version text NOT NULL DEFAULT 'unknown',

  -- The version the CLIENT requested, not the version we echo back. The server
  -- always answers with its own SUPPORTED_PROTOCOL_VERSION; this column is how
  -- we learn the real distribution of client-side protocol versions.
  protocol_version text NOT NULL DEFAULT 'unknown',

  -- The verbatim `capabilities` object from the handshake. Handshake metadata
  -- only: it contains no mailbox content, no credentials, and no message data.
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Convenience projection of capabilities.extensions['io.modelcontextprotocol/ui'].
  -- Denormalised so "how many clients declare MCP Apps?" is an index-free
  -- boolean aggregate rather than a jsonb path scan.
  supports_ui boolean NOT NULL DEFAULT false,

  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now()
);

-- Upsert conflict target. Identity is (key, client, client version, requested
-- protocol version): a client that upgrades itself, or renegotiates at a
-- different protocol version, gets its own row so the transition is visible
-- rather than overwritten.
CREATE UNIQUE INDEX IF NOT EXISTS mcp_client_capabilities_identity_key
  ON public.mcp_client_capabilities
  (api_key_id, client_name, client_version, protocol_version);

-- Supports the "which clients has this workspace connected recently?" query.
CREATE INDEX IF NOT EXISTS mcp_client_capabilities_workspace_last_seen_idx
  ON public.mcp_client_capabilities (workspace_id, last_seen DESC);

ALTER TABLE public.mcp_client_capabilities ENABLE ROW LEVEL SECURITY;

-- Read-only to workspace members; writes come exclusively from the edge
-- function's service-role client, which bypasses RLS.
DROP POLICY IF EXISTS "mcp_client_capabilities_select_members"
  ON public.mcp_client_capabilities;
CREATE POLICY "mcp_client_capabilities_select_members"
  ON public.mcp_client_capabilities FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.workspace_members wm
    WHERE wm.workspace_id = mcp_client_capabilities.workspace_id
      AND wm.user_id = auth.uid()
  ));

COMMENT ON TABLE public.mcp_client_capabilities IS
  'Observational record of MCP client handshakes (clientInfo + capabilities). No server behaviour branches on it.';
COMMENT ON COLUMN public.mcp_client_capabilities.protocol_version IS
  'Protocol version requested by the client, not the version the server echoes back.';
COMMENT ON COLUMN public.mcp_client_capabilities.supports_ui IS
  'True when capabilities.extensions contains io.modelcontextprotocol/ui. Diagnostic only, never a behaviour gate.';
