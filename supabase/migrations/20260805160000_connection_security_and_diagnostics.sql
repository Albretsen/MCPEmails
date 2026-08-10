-- Explicit transport modes keep generic connections correct on non-standard
-- ports. Defaults preserve all existing implicit-TLS IMAP behavior and SMTP's
-- historical port-587 STARTTLS inference.
ALTER TABLE public.inboxes
  ADD COLUMN imap_security text NOT NULL DEFAULT 'tls'
    CHECK (imap_security IN ('tls', 'starttls')),
  ADD COLUMN smtp_security text;

UPDATE public.inboxes
SET smtp_security = CASE WHEN smtp_port = 587 THEN 'starttls' ELSE 'tls' END
WHERE smtp_security IS NULL;

ALTER TABLE public.inboxes
  ALTER COLUMN smtp_security SET DEFAULT 'tls',
  ALTER COLUMN smtp_security SET NOT NULL,
  ADD CONSTRAINT inboxes_smtp_security_check CHECK (smtp_security IN ('tls', 'starttls'));

-- Privacy-safe connection diagnostics: only lifecycle kind and coarse phase.
-- No mailbox address, host, response text, user agent, IP, or credential data.
ALTER TABLE public.product_funnel_events
  ADD COLUMN phase text,
  ADD COLUMN connection_type text
    CHECK (connection_type IS NULL OR connection_type IN ('first_connect', 'reconnect'));

ALTER TABLE public.product_funnel_events
  ADD CONSTRAINT product_funnel_events_phase_check CHECK (
    phase IS NULL OR phase IN (
      'tcp', 'tls', 'greeting', 'authentication',
      'smtp_tcp', 'smtp_tls', 'smtp_greeting', 'smtp_authentication',
      'authorization', 'token_exchange', 'persistence', 'complete'
    )
  );

ALTER TABLE public.product_funnel_events
  DROP CONSTRAINT IF EXISTS product_funnel_events_outcome_check;
ALTER TABLE public.product_funnel_events
  ADD CONSTRAINT product_funnel_events_outcome_check
    CHECK (outcome IN ('started', 'success', 'failure'));

ALTER TABLE public.product_funnel_events
  DROP CONSTRAINT IF EXISTS product_funnel_events_check;
ALTER TABLE public.product_funnel_events
  ADD CONSTRAINT product_funnel_events_terminal_error_check CHECK (
    (outcome IN ('started', 'success') AND error_category IS NULL) OR outcome = 'failure'
  );
