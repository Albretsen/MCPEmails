-- Accept idempotency keys on the four draft writes.
--
-- Models sent `idempotency_key` on draft create and reply 31 times across 12
-- workspaces in the ten days to 2026-09-22 and were refused, because only
-- draft_send carried one. A retried draft_create or draft_reply leaves a second
-- draft behind, so the key does real work there. update and delete join them so
-- that every draft write takes the key.
--
-- Keep in step with IDEMPOTENT_MUTATION_OPERATIONS in
-- supabase/functions/mcp-server/index.ts: an operation listed there but not
-- here fails its INSERT and degrades to `idempotency_unavailable`.

ALTER TABLE public.outbound_idempotency
  DROP CONSTRAINT IF EXISTS outbound_idempotency_operation_check;

ALTER TABLE public.outbound_idempotency
  ADD CONSTRAINT outbound_idempotency_operation_check
  CHECK (operation IN (
    -- Outbound delivery.
    'email_send',
    'email_reply',
    'email_forward',
    'draft_send',
    'schedule_create',
    -- Mailbox mutations.
    'email_move',
    'email_copy',
    'email_move_batch',
    'email_copy_batch',
    'email_delete',
    'email_delete_batch',
    'email_flag',
    'email_archive',
    'email_search_and_move',
    'email_search_and_delete',
    -- Draft writes (new).
    'draft_create',
    'draft_reply',
    'draft_update',
    'draft_delete'
  ));
