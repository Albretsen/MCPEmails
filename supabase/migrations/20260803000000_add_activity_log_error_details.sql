-- Privacy-safe classification for request-validation failures. This must never
-- contain raw tool arguments, error-message text, or email content.
ALTER TABLE public.activity_log
  ADD COLUMN IF NOT EXISTS error_details jsonb;

COMMENT ON COLUMN public.activity_log.error_details IS
  'Value-free operational metadata for errors (currently schema-validation phase, tool/action, paths and keywords only). Never store request arguments or message text.';
