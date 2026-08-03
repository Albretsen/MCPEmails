-- Retry-safe outbound requests. This table deliberately stores only keyed
-- digests and outcome state, never email bodies, recipients, or attachments.
CREATE TABLE IF NOT EXISTS public.outbound_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id uuid NOT NULL REFERENCES public.api_keys(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (operation IN (
    'email_send', 'email_reply', 'email_forward', 'draft_send', 'schedule_create'
  )),
  key_digest text NOT NULL,
  request_digest text NOT NULL,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN (
    'processing', 'succeeded', 'failed', 'unknown'
  )),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (api_key_id, operation, key_digest)
);

CREATE INDEX IF NOT EXISTS outbound_idempotency_expires_at_idx
  ON public.outbound_idempotency (expires_at);

COMMENT ON TABLE public.outbound_idempotency IS
  '24-hour idempotency records for outbound MCP operations. Stores only HMAC digests and state, never message content.';

ALTER TABLE public.outbound_idempotency ENABLE ROW LEVEL SECURITY;
-- The MCP edge function uses service_role. No direct client access is needed.
