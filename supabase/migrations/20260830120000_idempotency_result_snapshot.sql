-- ---------------------------------------------------------------------------
-- MCPEmails — make an idempotent replay as useful as the original response
-- 20260830120000_idempotency_result_snapshot
--
-- An agent supplies an `idempotency_key` for exactly one reason: it may lose
-- the response. The connection drops, the client times out, and the retry is
-- how it finds out what happened. Until now the retry was collapsed correctly
-- and then answered:
--
--   {"idempotency_key":"...","idempotent_replay":true,"status":"succeeded",
--    "message":"This logical request was already processed. No new email was sent."}
--
-- Which is true and useless. The `message_id` the caller was retrying to
-- obtain was never persisted, so it could not be returned, and the caller was
-- left exactly as stranded as the dropped connection had left it — except now
-- unable to retry, because a second attempt collapses the same way and forcing
-- a fresh send would duplicate the email.
--
-- This column holds the small snapshot the replay hands back.
--
-- ── What goes in it, and what deliberately does not ────────────────────────
-- The table was built to hold digests and outcome state, never message
-- content, and that property is preserved rather than abandoned. The edge
-- function writes an ALLOW-LIST of identity and outcome fields — message_id,
-- thread_id, draft_id, scheduled_send_id, sent_at, status, the bulk counts,
-- inbox_id, destination_folder_id, and the per-message results array when it
-- fits — and drops everything else. In particular `to`, `cc`, `bcc` and
-- `subject`, which the send result carries, never reach this column: the
-- retrying caller already holds them in the arguments it is retrying with, so
-- storing them would buy nothing and would turn a digest ledger into a
-- 24-hour record of who the user emails about what. The allow-list lives in
-- supabase/functions/mcp-server/idempotency-replay.ts.
--
-- Provider message ids DO now land here, which the previous table comment
-- ruled out. That is the deliberate change: an id the caller cannot otherwise
-- recover is the entire payload of a useful replay. The row still expires with
-- the record it belongs to, 24 hours after the operation.
--
-- Related: 20260802190000_add_outbound_idempotency.sql (the original table),
-- 20260819180000_widen_outbound_idempotency_operations.sql (mutations).
-- ---------------------------------------------------------------------------

ALTER TABLE public.outbound_idempotency
  ADD COLUMN IF NOT EXISTS result_snapshot jsonb;

COMMENT ON COLUMN public.outbound_idempotency.result_snapshot IS
  'Identity and outcome fields of the original operation''s result, returned verbatim by a later idempotent replay so a caller that lost the first response can recover its message_id without re-sending. Written from an allow-list in the MCP edge function: ids, timestamps, status and counts only. Never bodies, recipients or subjects. Null for records written before this column existed, and for results that carried no identity worth repeating.';

COMMENT ON TABLE public.outbound_idempotency IS
  '24-hour idempotency records for retryable MCP operations: outbound deliveries (send, reply, forward, draft send, schedule) and mailbox mutations (move, copy, delete, flag, archive, and their batch and search-and-act forms). Despite the name, the table is no longer outbound-only; it was widened when unattended triage made retries routine rather than exceptional. Stores HMAC digests, state, and a small allow-listed snapshot of the original result (ids, timestamps, status, counts) so a replay can return what the first call returned. Never message content, recipients or subjects.';
