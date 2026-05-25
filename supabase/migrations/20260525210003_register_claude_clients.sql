-- 2.4: Register first-party Claude clients.
--
-- claude-ai-web: claude.ai "Add custom connector" OAuth flow.
-- Redirect URI is a best guess; verify by observing ?redirect_uri= in the
-- browser address bar when claude.ai first hits /authorize, then update if needed.
--
-- claude-code: Claude Code CLI OAuth flow.
-- Redirect URI confirmed from observed auth requests: platform.claude.com/oauth/code/callback

INSERT INTO public.oauth_clients
  (client_id, client_name, client_byline, redirect_uris, scopes_allowed, is_first_party)
VALUES
  (
    'claude-ai-web',
    'Claude',
    'by Anthropic',
    ARRAY['https://claude.ai/api/mcp/oauth/callback'],
    ARRAY['read:email', 'search:email', 'send:email', 'manage:drafts', 'manage:folders'],
    true
  ),
  (
    'claude-code',
    'Claude Code',
    'by Anthropic',
    ARRAY['https://platform.claude.com/oauth/code/callback'],
    ARRAY['read:email', 'search:email', 'send:email', 'manage:drafts', 'manage:folders'],
    true
  )
ON CONFLICT (client_id) DO NOTHING;
