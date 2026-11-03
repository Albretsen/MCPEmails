-- ============================================================
-- 20261030220000_support_ticket_random_ref
-- ============================================================
-- New support ticket refs are random codes (MCPE-7KQ4XM) instead of the next
-- number from support_ticket_ref_seq. A reference only has to be unique and
-- easy to read out; it does not need to count anything.
--
-- Alphabet: 30 characters, no 0/O, 1/I/L or U, so a ref read over the phone
-- or retyped from an email is unambiguous. 6 characters give 30^6 (about
-- 729 million) codes. The function draws again on the rare clash with an
-- existing ref; the UNIQUE constraint on ref stays the backstop.
--
-- Existing refs (MCPE-1001 and up) keep working. Contract requests share the
-- column default, so they get random refs too. The sequence is left in place,
-- unused, so this migration needs no data change.
-- Idempotent: safe to apply more than once.
-- ============================================================

CREATE OR REPLACE FUNCTION public.next_support_ticket_ref()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $$
DECLARE
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  candidate text;
BEGIN
  LOOP
    candidate := 'MCPE-';
    FOR i IN 1..6 LOOP
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.support_tickets WHERE ref = candidate);
  END LOOP;
  RETURN candidate;
END;
$$;

-- The default runs as the inserting role (service_role). Nobody else may call it.
REVOKE ALL ON FUNCTION public.next_support_ticket_ref() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_support_ticket_ref() TO service_role;

ALTER TABLE public.support_tickets
  ALTER COLUMN ref SET DEFAULT public.next_support_ticket_ref();
