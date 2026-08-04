-- ============================================================
-- Production synthetic monitoring: durable run and incident state
--
-- These records exist solely for the server-side synthetic monitor. They
-- deliberately exclude credentials, HTTP headers, mailbox contents, message
-- bodies, recipient addresses, and raw provider responses.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.synthetic_monitor_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Routine health checks are non-mutating public API checks.
  mode text NOT NULL CHECK (mode = 'read'),
  status text NOT NULL DEFAULT 'running' CHECK (status IN (
    'running', 'succeeded', 'failed', 'internal_error'
  )),

  -- Set only for non-successful runs. These are safe, controlled identifiers,
  -- never raw exception messages or provider responses.
  failure_class text CHECK (failure_class IN (
    'public_endpoint', 'authentication', 'mcp_protocol', 'database',
    'provider_read', 'alert_delivery', 'internal'
  )),
  failed_step text CHECK (failed_step IN (
    'initialize', 'tools_list', 'inbox_list', 'email_read',
    'incident_alert', 'recovery_alert', 'internal'
  )),
  failure_fingerprint text,

  -- A bounded, schema-controlled step summary written by the Edge Function.
  -- It may contain only step names, status, duration, safe error codes and
  -- correlation IDs; no request/response payloads or secrets.
  steps jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(steps) = 'array'),
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(diagnostics) = 'object'),

  deployment_id text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),

  CONSTRAINT synthetic_monitor_runs_completion_check CHECK (
    (status = 'running' AND completed_at IS NULL AND duration_ms IS NULL)
    OR
    (status <> 'running' AND completed_at IS NOT NULL AND duration_ms IS NOT NULL)
  ),
  CONSTRAINT synthetic_monitor_runs_failure_check CHECK (
    (status = 'succeeded' AND failure_class IS NULL AND failed_step IS NULL)
    OR
    (status IN ('failed', 'internal_error') AND failure_class IS NOT NULL AND failed_step IS NOT NULL)
    OR
    status = 'running'
  )
);

CREATE INDEX IF NOT EXISTS synthetic_monitor_runs_started_at_idx
  ON public.synthetic_monitor_runs (started_at DESC);

CREATE INDEX IF NOT EXISTS synthetic_monitor_runs_failed_idx
  ON public.synthetic_monitor_runs (started_at DESC)
  WHERE status IN ('failed', 'internal_error');

COMMENT ON TABLE public.synthetic_monitor_runs IS
  'Sanitized execution history for the production MCP synthetic monitor. Never stores credentials or email content.';
COMMENT ON COLUMN public.synthetic_monitor_runs.steps IS
  'Bounded, sanitized per-step outcomes. Never store request/response payloads, headers, credentials, recipients, or email content.';
COMMENT ON COLUMN public.synthetic_monitor_runs.diagnostics IS
  'Safe operational metadata only: controlled codes, durations, and correlation IDs.';

CREATE TABLE IF NOT EXISTS public.synthetic_monitor_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Deterministic key derived from the failed test path and its safe error
  -- classification. One row represents the current lifecycle of that failure.
  fingerprint text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  failure_class text NOT NULL CHECK (failure_class IN (
    'public_endpoint', 'authentication', 'mcp_protocol', 'database',
    'provider_read', 'alert_delivery', 'internal'
  )),
  failed_step text NOT NULL CHECK (failed_step IN (
    'initialize', 'tools_list', 'inbox_list', 'email_read',
    'incident_alert', 'recovery_alert', 'internal'
  )),

  first_failure_at timestamptz NOT NULL DEFAULT now(),
  last_failure_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 1 CHECK (consecutive_failures > 0),

  -- Notification bookkeeping lets the later monitor function deduplicate
  -- incident and recovery emails without recording email content.
  incident_alerted_at timestamptz,
  recovery_alerted_at timestamptz,
  last_run_id uuid REFERENCES public.synthetic_monitor_runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT synthetic_monitor_incidents_resolution_check CHECK (
    (status = 'open' AND resolved_at IS NULL)
    OR
    (status = 'resolved' AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS synthetic_monitor_incidents_open_idx
  ON public.synthetic_monitor_incidents (last_failure_at DESC)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS synthetic_monitor_incidents_last_run_idx
  ON public.synthetic_monitor_incidents (last_run_id);

COMMENT ON TABLE public.synthetic_monitor_incidents IS
  'Deduplicated incident lifecycle state for the production MCP synthetic monitor. No secrets or email data.';

-- The monitor runs as an Edge Function using the service role. No browser,
-- customer, or authenticated-user access is required or allowed.
ALTER TABLE public.synthetic_monitor_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.synthetic_monitor_incidents ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.synthetic_monitor_runs FROM anon, authenticated;
REVOKE ALL ON TABLE public.synthetic_monitor_incidents FROM anon, authenticated;
