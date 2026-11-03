-- ===========================================================================
-- Help article feedback: the "Was this helpful?" yes/no under each article.
-- 20261029200000_help_article_feedback
--
-- Written by POST /api/support/article-feedback only (apps/web/src/lib/
-- support/article-feedback.ts), with the service-role client.
--
-- ONE VOTE PER VOTER PER ARTICLE. `voter_key` is `u:<user id>` when signed in
-- and `ip:<HMAC of the address>` when not, and (article_id, voter_key) is
-- unique: voting again changes the answer instead of adding a row, so repeat
-- clicks cannot inflate a count and no rate-limit table is needed.
--
-- WHAT IS STORED. The article id, the locale it was read in, yes or no, and
-- the voter key. No free text, no raw IP. Deleting the user deletes their
-- votes.
--
-- TENANCY. Service-role only: RLS on, no policies, and anon / authenticated
-- hold no privileges on the table.
--
-- Read it with:
--   SELECT article_id, count(*) FILTER (WHERE helpful) AS yes,
--          count(*) FILTER (WHERE NOT helpful) AS no
--   FROM public.help_article_feedback GROUP BY 1 ORDER BY no DESC;
--
-- Forward-only, re-runnable. Apply with the normal migration workflow (never
-- `db push` on production).
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.help_article_feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id  text NOT NULL
              CHECK (char_length(article_id) BETWEEN 1 AND 80 AND article_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  locale      text NOT NULL CHECK (locale ~ '^[a-z]{2}$'),
  helpful     boolean NOT NULL,
  voter_key   text NOT NULL CHECK (char_length(voter_key) BETWEEN 3 AND 100),
  user_id     uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT help_article_feedback_one_vote UNIQUE (article_id, voter_key)
);

CREATE INDEX IF NOT EXISTS help_article_feedback_user_idx
  ON public.help_article_feedback (user_id) WHERE user_id IS NOT NULL;

ALTER TABLE public.help_article_feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.help_article_feedback FROM anon, authenticated;
