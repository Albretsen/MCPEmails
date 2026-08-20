-- ============================================================
-- MCPEmails - idempotency for mailbox mutations, not just sends
-- 20260819180000_widen_outbound_idempotency_operations
-- ============================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- outbound_idempotency was built for the outbound delivery routes, where the
-- damage from a retry is obvious: a duplicate send is a duplicate email in
-- somebody else's inbox. Its `operation` CHECK therefore only admits
-- email_send, email_reply, email_forward, draft_send and schedule_create.
--
-- The mailbox MUTATION tools were left out, on the implicit assumption that
-- they are naturally idempotent. Several are not:
--
--   * email_copy / email_copy_batch are not idempotent on ANY provider. An
--     IMAP UID COPY and a Graph /copy each create a NEW message per call, so a
--     retried copy leaves two.
--   * email_move / email_move_batch / email_search_and_move are idempotent only
--     if the destination is reached. A call that times out after the provider
--     applied it, then retries, can move mail that a rule matched in the
--     meantime out of a folder the user had just refiled it into.
--   * email_delete / email_delete_batch / email_search_and_delete are the least
--     forgiving of all: a retry after a partial application has no way to tell
--     "already trashed" from "trash it again", and there is no undo.
--   * email_flag and email_archive are the mild cases, included so that the
--     mutation surface is uniformly protected rather than protected in patches.
--
-- Unattended triage ("Automations", 20260819170000) is what forces the issue.
-- A cron-driven runner retries by design, so it turns an occasional interactive
-- double-click into a routine event. The feature's first line of defence is its
-- own per-rule seen ledger (triage_seen_messages), which stops a rule acting on
-- the same message twice. This table is the second, more general layer: it
-- protects any caller, interactive or unattended, that supplies an idempotency
-- key, and it is the layer that covers a retry which happens BEFORE the ledger
-- claim is even reached.
--
-- Nothing about the table's storage changes. It still holds only HMAC digests,
-- state and timing, and still never holds message content, recipients or ids.
--
-- Related: supabase/migrations/20260802190000_add_outbound_idempotency.sql (the
-- original table), 20260802210000_expand_send_approval_operations.sql (the
-- house pattern for re-asserting a widened CHECK against an already-provisioned
-- database), supabase/functions/mcp-server/index.ts
-- (IDEMPOTENT_MUTATION_OPERATIONS, the code-side counterpart of this list).
-- ============================================================

-- Kept separate from the original table migration, and written as DROP then ADD
-- rather than as an edit to the CREATE TABLE, so that production, which already
-- has the narrow constraint, actually receives the widened one. A
-- CREATE TABLE IF NOT EXISTS would silently no-op there.
ALTER TABLE public.outbound_idempotency
  DROP CONSTRAINT IF EXISTS outbound_idempotency_operation_check;

ALTER TABLE public.outbound_idempotency
  ADD CONSTRAINT outbound_idempotency_operation_check
  CHECK (operation IN (
    -- Outbound delivery (unchanged, the original five).
    'email_send',
    'email_reply',
    'email_forward',
    'draft_send',
    'schedule_create',
    -- Mailbox mutations (new).
    'email_move',
    'email_copy',
    'email_move_batch',
    'email_copy_batch',
    'email_delete',
    'email_delete_batch',
    'email_flag',
    'email_archive',
    'email_search_and_move',
    'email_search_and_delete'
  ));

-- The table name still says "outbound", which is now narrower than what it
-- does. Renaming it would break every reference in the edge function and in
-- database.types.ts for no functional gain, so the name stays and the comments
-- carry the correction.
COMMENT ON TABLE public.outbound_idempotency IS
  '24-hour idempotency records for retryable MCP operations: outbound deliveries (send, reply, forward, draft send, schedule) and mailbox mutations (move, copy, delete, flag, archive, and their batch and search-and-act forms). Despite the name, the table is no longer outbound-only; it was widened when unattended triage made retries routine rather than exceptional. Stores only HMAC digests and state, never message content, recipients or provider ids.';

COMMENT ON COLUMN public.outbound_idempotency.operation IS
  'The MCP operation the key applies to. Idempotency is scoped per (api_key_id, operation, key_digest), so the same key reused for a different operation is a different record and does not collide. Mutation operations were added alongside Automations: several of them (copy in particular, which creates a new message on every provider) are not naturally idempotent, so a retry without this record duplicates real mailbox work.';
