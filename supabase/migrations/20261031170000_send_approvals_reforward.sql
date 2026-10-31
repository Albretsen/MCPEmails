-- ============================================================
-- MCPEmails - "Forward again" on an expired rule forward
-- 20261031170000_send_approvals_reforward
-- ============================================================
--
-- An expired rule forward can be asked for again, once, by a signed-in owner or
-- admin (apps/web/src/lib/approvals/forward-again.ts). That creates a new pending
-- approval with the same stored message and address, and a new deadline.
--
--   reforward_of  The expired approval this one was made from. The unique index
--                 is what makes a double click, or two admins, produce one new
--                 request rather than two requests that could each be approved.
--
-- The column grants nothing: a new row is pending like any other and passes
-- through the same decide paths. ON DELETE SET NULL because retention removes
-- old approvals, and the newer row must survive that. Changing it does not bump
-- `revision`: the trigger watches the content columns only.

ALTER TABLE public.send_approvals
  ADD COLUMN IF NOT EXISTS reforward_of uuid
    REFERENCES public.send_approvals(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS send_approvals_reforward_of_key
  ON public.send_approvals (reforward_of)
  WHERE reforward_of IS NOT NULL;

COMMENT ON COLUMN public.send_approvals.reforward_of IS
  'The expired approval a person asked to forward again. One new request per expired one.';
