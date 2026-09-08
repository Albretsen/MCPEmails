-- ===========================================================================
-- RFC 8707 RESOURCE INDICATORS ON THE OAUTH AUTHORIZATION SERVER.
--
-- The MCP authorization spec (2025-06-18+) has clients send
-- `resource=https://mcpemails.com/api/mcp` on the authorization and token
-- requests. The AS must bind the issued grant to that audience and refuse a
-- token request that names a different one. Until now the parameter was
-- ignored entirely and the audience was only implicit (this domain is both
-- the AS and the only resource server).
--
-- One nullable column on each grant-carrying table:
--
--   NULL  the client did not send `resource` (older MCP clients; still valid)
--   text  the validated resource the grant was issued for
--
-- Access tokens themselves are api_keys rows and carry no audience column;
-- they can only ever be minted for the single resource this AS serves, so the
-- refresh-token chain is where the binding has to survive rotation.
--
-- Re-runnable. Forward-only. No previously applied migration file is edited.
-- ===========================================================================

ALTER TABLE public.oauth_auth_codes
  ADD COLUMN IF NOT EXISTS resource text;

ALTER TABLE public.oauth_refresh_tokens
  ADD COLUMN IF NOT EXISTS resource text;

COMMENT ON COLUMN public.oauth_auth_codes.resource IS
  'RFC 8707 resource indicator the code was issued for; NULL when the client sent none.';

COMMENT ON COLUMN public.oauth_refresh_tokens.resource IS
  'RFC 8707 resource indicator the grant is bound to; NULL when the client sent none.';
