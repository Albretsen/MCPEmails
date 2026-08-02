-- Server-authored product funnel facts. These rows deliberately contain only
-- coarse categories: no email address, credential, OAuth token, request body,
-- IP address, user agent, or client-provided identifier is retained here.
CREATE TABLE public.product_funnel_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN ('inbox_connection', 'credential_created', 'first_tool_call')),
  outcome text NOT NULL CHECK (outcome IN ('success', 'failure')),
  category text NOT NULL CHECK (category IN (
    'gmail', 'outlook', 'fastmail', 'icloud', 'yahoo', 'zoho', 'yandex', 'generic_imap',
    'api_key', 'oauth', 'unknown'
  )),
  error_category text CHECK (error_category IS NULL OR error_category IN (
    'auth_failed', 'validation_failed', 'provider_denied', 'token_exchange_failed',
    'plan_limit', 'conflict', 'persistence_failed', 'unknown'
  )),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((outcome = 'success' AND error_category IS NULL) OR outcome = 'failure')
);

CREATE INDEX product_funnel_events_workspace_stage_occurred_idx
  ON public.product_funnel_events (workspace_id, stage, occurred_at DESC);
CREATE INDEX product_funnel_events_stage_outcome_occurred_idx
  ON public.product_funnel_events (stage, outcome, occurred_at DESC);

ALTER TABLE public.product_funnel_events ENABLE ROW LEVEL SECURITY;
-- No browser-facing policy: only trusted server code records or reads funnel facts.

ALTER TABLE public.workspaces
  ADD COLUMN analytics_first_inbox_connected_at timestamptz,
  ADD COLUMN analytics_first_inbox_provider text,
  ADD COLUMN analytics_first_credential_created_at timestamptz,
  ADD COLUMN analytics_first_credential_method text,
  ADD COLUMN analytics_first_tool_used_at timestamptz;

-- Preserve the existing server-observed first-use marker when upgrading.
UPDATE public.workspaces
SET analytics_first_tool_used_at = COALESCE(analytics_first_tool_reported_at, updated_at, created_at)
WHERE analytics_first_tool_name IS NOT NULL
  AND analytics_first_tool_used_at IS NULL;
