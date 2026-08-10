-- Support-controlled, workspace-scoped action-cap exemptions. These are
-- intentionally distinct from user-level comped Scale entitlements: an
-- exemption is temporary operational relief and does not alter Stripe or
-- product capabilities.

CREATE TABLE public.workspace_usage_exemptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  reason         text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  ticket_id      text NOT NULL CHECK (char_length(ticket_id) BETWEEN 1 AND 200),
  granted_by     uuid REFERENCES public.users(id) ON DELETE SET NULL,
  granted_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz,
  revoked_at     timestamptz,
  revoked_by     uuid REFERENCES public.users(id) ON DELETE SET NULL,
  revoke_reason  text CHECK (revoke_reason IS NULL OR char_length(revoke_reason) BETWEEN 1 AND 500),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_usage_exemptions_expiry_after_grant
    CHECK (expires_at IS NULL OR expires_at > granted_at)
);

CREATE INDEX workspace_usage_exemptions_active_idx
  ON public.workspace_usage_exemptions (workspace_id, expires_at)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE public.workspace_usage_exemptions IS
  'Auditable support exemption from action-cap enforcement. Does not change Stripe, plan, or other product capabilities.';

ALTER TABLE public.workspace_usage_exemptions ENABLE ROW LEVEL SECURITY;
-- Service-role/admin writes only. Customer dashboard renders effective usage
-- through a server-side read path and never exposes the support ticket/reason.
