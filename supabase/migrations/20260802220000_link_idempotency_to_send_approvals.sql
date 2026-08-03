-- Approval-gated calls have a third lifecycle between request acceptance and
-- provider delivery. Persist that link so an idempotent replay can return the
-- original approval state and safely reopen only requests that were never sent.
ALTER TABLE public.outbound_idempotency
  ADD COLUMN IF NOT EXISTS approval_id uuid REFERENCES public.send_approvals(id) ON DELETE SET NULL;

ALTER TABLE public.outbound_idempotency
  DROP CONSTRAINT IF EXISTS outbound_idempotency_status_check;

ALTER TABLE public.outbound_idempotency
  ADD CONSTRAINT outbound_idempotency_status_check
  CHECK (status IN (
    'processing',
    'pending_approval',
    'succeeded',
    'failed',
    'unknown'
  ));

CREATE INDEX IF NOT EXISTS outbound_idempotency_approval_id_idx
  ON public.outbound_idempotency (approval_id)
  WHERE approval_id IS NOT NULL;

COMMENT ON COLUMN public.outbound_idempotency.approval_id IS
  'The dashboard approval snapshot for a pending approval-gated outbound request.';
