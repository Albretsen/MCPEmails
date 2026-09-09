-- ---------------------------------------------------------------------------
-- Keep the auth-failure sub-case on the funnel row.
--
-- `auth_failed` is the largest failure bucket on every connector, and by itself
-- it cannot answer the one question worth asking about it: did the user send
-- the wrong KIND of secret, or the right kind mistyped?
--
-- lib/email/auth-failure.ts has classified exactly that on every one of these
-- failures for weeks. The answer was sent to the browser and written to
-- app_errors, and then dropped here. That gap is not theoretical: the connect
-- regression of 2026-09-08 (per-workspace connect rate 90.4% -> 68.8%) had to
-- be diagnosed from the shape of the code, because the rows that would have
-- separated "could not produce the credential at all" from "sent the account
-- password" carried only the word `auth_failed`.
--
-- Nullable and additive. Every existing row keeps NULL, which is honest: the
-- reason was never recorded for them, and backfilling a guess would be worse
-- than the gap.
--
-- Deliberately NOT a check constraint against the enum. The vocabulary lives in
-- one TypeScript union and a new member there must not start failing inserts
-- here before the migration that widens the constraint lands; a funnel row is
-- analytics, and losing one to a constraint costs more than an unrecognised
-- string does. `error_category` and `phase` are stored on the same terms.
-- ---------------------------------------------------------------------------

ALTER TABLE public.product_funnel_events
  ADD COLUMN IF NOT EXISTS auth_reason text;

COMMENT ON COLUMN public.product_funnel_events.auth_reason IS
  'Which sub-case an auth_failed was classified as (AuthFailureReason in apps/web/src/lib/email/auth-failure.ts): account_password_used, app_password_length, app_password_required, imap_disabled, login_username_required, and so on. NULL on every row written before 2026-09-09 and on every non-auth failure. An enum member only: never a host, address or credential.';

-- The only query this column exists to serve is "how did auth failures break
-- down over the last N days", which is always filtered to failures first. A
-- partial index keeps it off the write path of the success rows, which are the
-- majority.
CREATE INDEX IF NOT EXISTS product_funnel_events_auth_reason_idx
  ON public.product_funnel_events (auth_reason, occurred_at DESC)
  WHERE auth_reason IS NOT NULL;
