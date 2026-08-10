-- Privacy-safe, server-authored onboarding state. This intentionally stores
-- only coarse product choices and timestamps; never mailbox addresses,
-- credentials, OAuth tokens, request bodies, IPs, or user agents.
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS onboarding_stage text NOT NULL DEFAULT 'started'
    CHECK (onboarding_stage IN ('started', 'client_selected', 'inbox_connected', 'credential_issued', 'technical_activation', 'value_activation')),
  ADD COLUMN IF NOT EXISTS onboarding_client text,
  ADD COLUMN IF NOT EXISTS onboarding_provider text,
  ADD COLUMN IF NOT EXISTS onboarding_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS onboarding_client_selected_at timestamptz,
  ADD COLUMN IF NOT EXISTS onboarding_inbox_connected_at timestamptz,
  ADD COLUMN IF NOT EXISTS onboarding_connection_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS onboarding_credential_issued_at timestamptz,
  ADD COLUMN IF NOT EXISTS onboarding_technical_activated_at timestamptz,
  ADD COLUMN IF NOT EXISTS onboarding_value_activated_at timestamptz,
  ADD CONSTRAINT workspaces_onboarding_client_check CHECK (
    onboarding_client IS NULL OR onboarding_client IN (
      'claude', 'chatgpt', 'cursor', 'vscode', 'cline', 'windsurf', 'gemini',
      'zed', 'jetbrains', 'raycast', 'warp', 'curl', 'unknown'
    )
  ),
  ADD CONSTRAINT workspaces_onboarding_provider_check CHECK (
    onboarding_provider IS NULL OR onboarding_provider IN (
      'gmail', 'outlook', 'fastmail', 'icloud', 'yahoo', 'zoho', 'yandex',
      'generic_imap', 'unknown'
    )
  );

-- Existing server facts are safe to use as a conservative backfill.
UPDATE public.workspaces
SET
  onboarding_started_at = COALESCE(onboarding_started_at, created_at),
  onboarding_inbox_connected_at = COALESCE(onboarding_inbox_connected_at, analytics_first_inbox_connected_at),
  onboarding_provider = COALESCE(onboarding_provider, analytics_first_inbox_provider),
  onboarding_credential_issued_at = COALESCE(onboarding_credential_issued_at, analytics_first_credential_created_at),
  onboarding_technical_activated_at = COALESCE(onboarding_technical_activated_at, analytics_first_tool_used_at),
  onboarding_client = COALESCE(onboarding_client, analytics_first_tool_client)
WHERE onboarding_started_at IS NULL;

-- Backfill first delivered value from durable server facts. inbox_list is
-- intentionally excluded: discovery can succeed without accessing mail.
UPDATE public.workspaces AS w
SET onboarding_value_activated_at = first_value.occurred_at
FROM (
  SELECT workspace_id, min(created_at) AS occurred_at
  FROM public.activity_log
  WHERE status = 'success'
    AND inbox_id IS NOT NULL
    AND tool_name <> 'inbox_list'
  GROUP BY workspace_id
) AS first_value
WHERE w.id = first_value.workspace_id
  AND w.onboarding_value_activated_at IS NULL;

UPDATE public.workspaces
SET onboarding_stage = CASE
  WHEN onboarding_value_activated_at IS NOT NULL THEN 'value_activation'
  WHEN onboarding_technical_activated_at IS NOT NULL THEN 'technical_activation'
  WHEN onboarding_credential_issued_at IS NOT NULL THEN 'credential_issued'
  WHEN onboarding_inbox_connected_at IS NOT NULL THEN 'inbox_connected'
  WHEN onboarding_client_selected_at IS NOT NULL THEN 'client_selected'
  ELSE 'started'
END;

-- The append-only event table remains the analysis source. Extend its small,
-- coarse vocabulary without weakening its no-sensitive-data contract.
ALTER TABLE public.product_funnel_events DROP CONSTRAINT product_funnel_events_stage_check;
ALTER TABLE public.product_funnel_events ADD CONSTRAINT product_funnel_events_stage_check
  CHECK (stage IN (
    'onboarding_started', 'client_selected', 'provider_selected', 'inbox_connection',
    'connection_verified', 'credential_created', 'technical_activation',
    'value_activation', 'first_tool_call'
  ));

ALTER TABLE public.product_funnel_events DROP CONSTRAINT product_funnel_events_category_check;
ALTER TABLE public.product_funnel_events ADD CONSTRAINT product_funnel_events_category_check
  CHECK (category IN (
    'gmail', 'outlook', 'fastmail', 'icloud', 'yahoo', 'zoho', 'yandex',
    'generic_imap', 'api_key', 'oauth', 'claude', 'chatgpt', 'cursor',
    'vscode', 'cline', 'windsurf', 'gemini', 'zed', 'jetbrains', 'raycast',
    'warp', 'curl', 'unknown'
  ));

CREATE INDEX IF NOT EXISTS workspaces_onboarding_value_activation_idx
  ON public.workspaces (onboarding_value_activated_at)
  WHERE onboarding_value_activated_at IS NOT NULL;
