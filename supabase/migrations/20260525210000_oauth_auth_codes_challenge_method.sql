-- 2.1: Add code_challenge_method to oauth_auth_codes so the token endpoint
-- can re-enforce S256 by reading the stored method rather than trusting the request.
ALTER TABLE public.oauth_auth_codes
  ADD COLUMN IF NOT EXISTS code_challenge_method text NOT NULL DEFAULT 'S256';
