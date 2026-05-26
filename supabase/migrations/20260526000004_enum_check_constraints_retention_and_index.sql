-- =============================================================================
-- 1. CHECK constraints on enum-like TEXT columns
-- =============================================================================

-- workspaces.plan
ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_plan_check
    CHECK (plan IN ('free', 'solo', 'pro', 'enterprise'));

-- inboxes.provider  ('imap' retained for future IMAP implementation)
ALTER TABLE public.inboxes
  ADD CONSTRAINT inboxes_provider_check
    CHECK (provider IN ('gmail', 'outlook', 'fastmail', 'imap'));

-- inboxes.status
ALTER TABLE public.inboxes
  ADD CONSTRAINT inboxes_status_check
    CHECK (status IN ('pending', 'active', 'error', 'revoked'));

-- activity_log.status  (partitioned table — constraint propagates to all child partitions)
ALTER TABLE public.activity_log
  ADD CONSTRAINT activity_log_status_check
    CHECK (status IN ('success', 'error', 'rate_limited'));

-- oauth_states.provider
ALTER TABLE public.oauth_states
  ADD CONSTRAINT oauth_states_provider_check
    CHECK (provider IN ('gmail', 'outlook', 'fastmail'));

-- oauth_auth_codes.code_challenge_method
ALTER TABLE public.oauth_auth_codes
  ADD CONSTRAINT oauth_auth_codes_ccm_check
    CHECK (code_challenge_method = 'S256');

-- NOTE: workspace_members_role_check already added by 20260526000003_workspace_invites_and_member_roles.sql

-- =============================================================================
-- 2. Activity log retention policy
-- =============================================================================
-- Retention window: 90 days (ACTIVITY_LOG_RETENTION_DAYS).
-- To change the window: unschedule 'activity-log-retention', update the
-- INTERVAL in the cron command below, and re-run cron.schedule.
-- Runs daily at 02:00 UTC.

SELECT cron.schedule(
  'activity-log-retention',
  '0 2 * * *',
  $$DELETE FROM public.activity_log WHERE created_at < now() - INTERVAL '90 days'$$
);

-- =============================================================================
-- 3. Index on oauth_refresh_tokens.expires_at
-- =============================================================================
-- Speeds up expired-token cleanup queries that filter by expiry date.

CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_expires_at_idx
  ON public.oauth_refresh_tokens (expires_at);
