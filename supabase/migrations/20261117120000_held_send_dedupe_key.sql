-- ============================================================
-- Fan-out brake: one held copy per send
--
-- On 2026-11-16 an agent retried one send the fan-out brake held, once an
-- hour. Every retry tripped the brake again and queued another approval, the
-- reviewer approved all of them at once, and 57 people got the same message
-- twice. mcp-server now stores a key for a brake-held send (SHA-256 of its
-- content hash and recipient set, outbound-brakes.ts#heldSendKey) and a repeat
-- of the same send returns the request already pending.
--
-- Additive and nullable: the edge function drops the column on a database
-- without it (writeTolerantly) and then queues a copy, as before.
-- ============================================================

ALTER TABLE public.send_approvals
  ADD COLUMN IF NOT EXISTS dedupe_key text
    CHECK (dedupe_key IS NULL OR dedupe_key ~ '^[0-9a-f]{64}$');

COMMENT ON COLUMN public.send_approvals.dedupe_key IS
  'SHA-256 of a fan-out-held send''s content and recipients. A repeat of the '
  'same send while this request is pending returns this request instead of '
  'queueing another. Null for every other approval.';

CREATE INDEX IF NOT EXISTS send_approvals_pending_dedupe_idx
  ON public.send_approvals (inbox_id, dedupe_key)
  WHERE status = 'pending' AND dedupe_key IS NOT NULL;
