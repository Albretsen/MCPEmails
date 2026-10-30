-- ============================================================
-- 20261030220000_support_ticket_ref_start
-- ============================================================
-- Support ticket refs (MCPE-1001, MCPE-1002, ...) read like a counter of
-- every ticket we have ever had. The sequence jumps to 4826, so the next ref
-- is MCPE-4827 and refs count up by one from there.
--
-- GREATEST keeps it monotonic: running this on a database that is already
-- past 4826 changes nothing, and refs are never reused. Contract requests
-- share this sequence through the same column default.
-- Idempotent: safe to apply more than once.
-- ============================================================

SELECT setval(
  'public.support_ticket_ref_seq',
  GREATEST((SELECT last_value FROM public.support_ticket_ref_seq), 4826),
  true
);
