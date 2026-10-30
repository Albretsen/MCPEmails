-- ============================================================
-- 20261030220000_support_ticket_ref_start
-- ============================================================
-- Support ticket refs (MCPE-1001, MCPE-1002, ...) read like a counter of
-- every ticket we have ever had. Two changes:
--
-- 1. The sequence jumps to 4826, so the next ref is MCPE-4827 or later.
--    GREATEST keeps it monotonic: running this on a database that is already
--    past 4826 changes nothing, and refs are never reused.
-- 2. Each new ref skips 1 to 6 numbers after it, so two refs a customer
--    sees a week apart do not show how many tickets came in between. The
--    skipped numbers are burned with nextval(), never setval(), so concurrent
--    inserts still get distinct refs.
--
-- Contract requests share this sequence through the same column default.
-- Idempotent: safe to apply more than once.
-- ============================================================

SELECT setval(
  'public.support_ticket_ref_seq',
  GREATEST((SELECT last_value FROM public.support_ticket_ref_seq), 4826),
  true
);

CREATE OR REPLACE FUNCTION public.next_support_ticket_ref()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $$
DECLARE
  n bigint := nextval('public.support_ticket_ref_seq');
BEGIN
  PERFORM nextval('public.support_ticket_ref_seq')
  FROM generate_series(1, 1 + floor(random() * 6)::int);
  RETURN 'MCPE-' || n::text;
END;
$$;

-- The default runs as the inserting role (service_role); it already holds
-- USAGE on the sequence. Nobody else may call the function.
REVOKE ALL ON FUNCTION public.next_support_ticket_ref() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_support_ticket_ref() TO service_role;

ALTER TABLE public.support_tickets
  ALTER COLUMN ref SET DEFAULT public.next_support_ticket_ref();
