-- ===========================================================================
-- Support tickets: what the /help contact form files.
-- 20261016090000_support_tickets
--
-- Written by POST /api/support/tickets only (apps/web/src/lib/support/
-- tickets.ts), with the service-role client.
--
-- REF. Customers and the support inbox see `MCPE-1001`, `MCPE-1002`, ... in
-- place of a uuid. A column DEFAULT, not a generated column: a generated
-- column may not call nextval(). Sequences are not gapless (a rolled-back
-- insert burns a number), which is fine for a reference.
--
-- ROW FIRST, THEN SEND. The API inserts the row, then emails support@ and the
-- customer. `notified_at` / `confirmation_sent_at` stay NULL when a send
-- failed, so `WHERE notified_at IS NULL` finds tickets nobody was told about.
--
-- RATE LIMITS are counted from this table (no bucket table): per ip_hash, per
-- email, and per source, each over the last hour or day. Hence the three
-- indexes below. `email` is stored lowercased (CHECK) so the limit query is a
-- plain equality the (email, created_at) index serves.
--
-- WHAT IS STORED. The customer's own email, category, subject and message,
-- and `context`: workspace id, plan, and per connected mailbox its provider,
-- service, host, status and last error. Never passwords, tokens or mail
-- content (the API builds `context` from an allow-list of columns). `ip_hash`
-- is HMAC(CSRF_SECRET), never a raw address. Length caps mirror
-- apps/web/src/lib/support/validation.ts.
--
-- DEFERRED FOREIGN KEYS. Deleting a user who owns a workspace cascades into
-- both keys of the same row in one statement: the user_id SET NULL rewrites
-- the row while its workspace is already gone but not yet nulled, and an
-- immediate check fails the whole delete (found by the pgTAP test). Checking
-- at commit lets both SET NULL actions land first. A ticket outlives its
-- account on purpose: it is the record of what the customer asked.
--
-- TENANCY. Service-role only: RLS on, no policies, and anon / authenticated
-- hold no privileges on the table or its sequence.
--
-- Forward-only, re-runnable. NOT APPLIED BY THE AGENT THAT WROTE IT. Apply with
-- the normal migration workflow (never `db push`).
-- ===========================================================================

CREATE SEQUENCE IF NOT EXISTS public.support_ticket_ref_seq START WITH 1001;

CREATE TABLE IF NOT EXISTS public.support_tickets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref                   text NOT NULL UNIQUE
                        DEFAULT ('MCPE-' || nextval('public.support_ticket_ref_seq')::text),
  user_id               uuid REFERENCES auth.users(id) ON DELETE SET NULL
                        DEFERRABLE INITIALLY DEFERRED,
  workspace_id          uuid REFERENCES public.workspaces(id) ON DELETE SET NULL
                        DEFERRABLE INITIALLY DEFERRED,
  email                 text NOT NULL
                        CHECK (char_length(email) BETWEEN 3 AND 254 AND email = lower(email)),
  category              text NOT NULL
                        CHECK (category IN ('connect', 'client', 'billing', 'bug', 'feature', 'other')),
  subject               text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 150),
  message               text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 5000),
  context               jsonb NOT NULL DEFAULT '{}'::jsonb,
  source                text NOT NULL CHECK (source IN ('form_signed_in', 'form_signed_out')),
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  ip_hash               text CHECK (ip_hash IS NULL OR char_length(ip_hash) <= 128),
  notified_at           timestamptz,
  confirmation_sent_at  timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Dropping the table drops the sequence with it.
ALTER SEQUENCE public.support_ticket_ref_seq OWNED BY public.support_tickets.ref;

-- Rate limit: "tickets from this IP in the last hour / day".
CREATE INDEX IF NOT EXISTS support_tickets_ip_hash_created_idx
  ON public.support_tickets (ip_hash, created_at)
  WHERE ip_hash IS NOT NULL;

-- Rate limit: "tickets to this address in the last hour / day".
CREATE INDEX IF NOT EXISTS support_tickets_email_created_idx
  ON public.support_tickets (email, created_at);

-- Rate limit: "signed-out tickets from anyone in the last hour".
CREATE INDEX IF NOT EXISTS support_tickets_source_created_idx
  ON public.support_tickets (source, created_at);

-- ON DELETE SET NULL on both foreign keys scans by these columns.
CREATE INDEX IF NOT EXISTS support_tickets_user_idx
  ON public.support_tickets (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS support_tickets_workspace_idx
  ON public.support_tickets (workspace_id) WHERE workspace_id IS NOT NULL;

COMMENT ON TABLE public.support_tickets IS
  'Tickets filed through the /help contact form. Customer email, category, subject, message and an allow-listed diagnostic context (no credentials, no mail content). Service-role only; no policies on purpose.';

ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.support_tickets FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.support_ticket_ref_seq FROM anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.support_ticket_ref_seq TO service_role;
