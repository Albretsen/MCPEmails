-- ============================================================
-- How many past 'direct' signups were really MCP connector installs?
--
-- READ ONLY. No INSERT, UPDATE or DELETE: past rows keep the source they were
-- given. Run with:
--   npx supabase db query --linked -f scripts/report-direct-connector-signups.sql
--
-- A logged-out user who connects an MCP client (Claude, ChatGPT, Cursor,
-- VS Code, ...) is sent from /authorize to /login?redirect=/authorize?... by
-- the system browser, with no referrer, so the workspace was recorded as
-- acquisition_source = 'direct' with landing path '/other'. This counts those
-- workspaces whose owner granted an OAuth client (consent, auth code or
-- refresh token) within 15 minutes of the workspace being created, grouped by
-- the same client buckets apps/web/src/lib/acquisition-context.mjs now records
-- (connectorSourceFromAuthorize). Only aggregate counts come out.
-- ============================================================

WITH direct_other AS (
  SELECT w.id, w.owner_id, w.created_at, w.plan
  FROM public.workspaces w
  WHERE w.acquisition_source = 'direct'
    AND w.acquisition_landing_path = '/other'
),
grants AS (
  SELECT user_id, client_id, NULL::text AS redirect_uri, granted_at AS at FROM public.oauth_consents
  UNION ALL
  SELECT user_id, client_id, redirect_uri, created_at FROM public.oauth_auth_codes
  UNION ALL
  SELECT user_id, client_id, NULL::text, created_at FROM public.oauth_refresh_tokens
),
first_grant AS (
  SELECT DISTINCT ON (d.id)
    d.id, d.plan, g.client_id,
    COALESCE(g.redirect_uri, c.redirect_uris[1]) AS redirect_uri
  FROM direct_other d
  JOIN grants g
    ON g.user_id = d.owner_id
   AND g.at >= d.created_at
   AND g.at < d.created_at + interval '15 minutes'
  LEFT JOIN public.oauth_clients c ON c.client_id = g.client_id
  ORDER BY d.id, g.at
),
bucketed AS (
  SELECT
    id, plan,
    CASE
      -- Same order as connectorSourceFromAuthorize: seeded id, CIMD client_id
      -- host, then the redirect_uri scheme or host. Hosts are exact.
      WHEN client_id IN ('claude-desktop', 'claude-ai-web', 'claude-code') THEN 'connector_claude'
      WHEN client_id = 'cursor-v1' THEN 'connector_cursor'
      WHEN cimd_host IN ('claude.ai', 'www.claude.ai', 'claude.com', 'www.claude.com', 'anthropic.com', 'www.anthropic.com', 'console.anthropic.com', 'platform.claude.com') THEN 'connector_claude'
      WHEN cimd_host IN ('chatgpt.com', 'chat.openai.com', 'openai.com', 'www.openai.com', 'platform.openai.com') THEN 'connector_chatgpt'
      WHEN cimd_host IN ('cursor.com', 'www.cursor.com', 'cursor.sh') THEN 'connector_cursor'
      WHEN cimd_host IN ('vscode.dev', 'insiders.vscode.dev') THEN 'connector_vscode'
      WHEN redirect_uri ~* '^claude:' THEN 'connector_claude'
      WHEN redirect_uri ~* '^cursor:' THEN 'connector_cursor'
      WHEN redirect_uri ~* '^vscode(-insiders)?:' THEN 'connector_vscode'
      WHEN redirect_host IN ('claude.ai', 'www.claude.ai', 'claude.com', 'www.claude.com', 'anthropic.com', 'www.anthropic.com', 'console.anthropic.com', 'platform.claude.com') THEN 'connector_claude'
      WHEN redirect_host IN ('chatgpt.com', 'chat.openai.com', 'openai.com', 'www.openai.com', 'platform.openai.com') THEN 'connector_chatgpt'
      WHEN redirect_host IN ('cursor.com', 'www.cursor.com', 'cursor.sh') THEN 'connector_cursor'
      WHEN redirect_host IN ('vscode.dev', 'insiders.vscode.dev') THEN 'connector_vscode'
      ELSE 'connector_other'
    END AS bucket
  FROM (
    SELECT *,
      lower(substring(client_id from '^https://([^/:?#]+)')) AS cimd_host,
      lower(substring(redirect_uri from '^https://([^/:?#]+)')) AS redirect_host
    FROM first_grant
  ) f
)
SELECT bucket, count(*) AS workspaces, count(*) FILTER (WHERE plan <> 'free') AS on_paid_plan_now
FROM bucketed
GROUP BY bucket
UNION ALL
SELECT 'ALL connector installs', count(*), count(*) FILTER (WHERE plan <> 'free') FROM bucketed
UNION ALL
SELECT 'ALL direct + /other', count(*), count(*) FILTER (WHERE plan <> 'free') FROM direct_other
UNION ALL
SELECT 'ALL direct', count(*), count(*) FILTER (WHERE plan <> 'free')
FROM public.workspaces WHERE acquisition_source = 'direct'
ORDER BY 2 DESC;
