-- Privacy-safe first-touch acquisition dimensions. Values are deliberately
-- bounded categories/public route paths: no query strings, search terms,
-- full referrer URLs, or raw campaign labels are persisted.
ALTER TABLE public.workspaces
  ADD COLUMN acquisition_landing_path text,
  ADD COLUMN acquisition_locale text,
  ADD COLUMN acquisition_referrer text,
  ADD COLUMN acquisition_utm_source text,
  ADD COLUMN acquisition_utm_medium text,
  ADD COLUMN acquisition_utm_campaign text;

ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_acquisition_landing_path_check CHECK (
    acquisition_landing_path IS NULL OR (
      length(acquisition_landing_path) <= 160
      AND acquisition_landing_path ~ '^/(|other|blog(/[a-z0-9-]+)?|connect/[a-z0-9-]+|docs(/[a-z0-9-]+)*|pricing|security|self-hosting|native-connectors-vs-mcp)$'
    )
  ),
  ADD CONSTRAINT workspaces_acquisition_locale_check
    CHECK (acquisition_locale IS NULL OR acquisition_locale IN ('en', 'nb', 'es', 'fr', 'zh')),
  ADD CONSTRAINT workspaces_acquisition_referrer_check
    CHECK (acquisition_referrer IS NULL OR acquisition_referrer IN ('direct', 'organic_google', 'reddit', 'github', 'smithery', 'glama', 'cursor', 'other')),
  ADD CONSTRAINT workspaces_acquisition_utm_source_check
    CHECK (acquisition_utm_source IS NULL OR acquisition_utm_source IN ('direct', 'organic_google', 'reddit', 'github', 'smithery', 'glama', 'cursor', 'other')),
  ADD CONSTRAINT workspaces_acquisition_utm_medium_check
    CHECK (acquisition_utm_medium IS NULL OR acquisition_utm_medium IN ('organic', 'paid_search', 'social', 'email', 'referral', 'affiliate', 'display', 'other')),
  ADD CONSTRAINT workspaces_acquisition_utm_campaign_check
    CHECK (acquisition_utm_campaign IS NULL OR acquisition_utm_campaign IN ('launch', 'newsletter', 'content', 'product', 'partner', 'community', 'other'));

CREATE INDEX idx_workspaces_acquisition_landing_path
  ON public.workspaces (acquisition_landing_path, created_at DESC)
  WHERE acquisition_landing_path IS NOT NULL;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace_id uuid;
  v_slug text;
  v_base_slug text;
  v_suffix integer := 0;
  v_source text := NEW.raw_user_meta_data->>'acquisition_source';
  v_landing text := NEW.raw_user_meta_data->>'acquisition_landing';
  v_landing_path text := NEW.raw_user_meta_data->>'acquisition_landing_path';
  v_locale text := NEW.raw_user_meta_data->>'acquisition_locale';
  v_referrer text := NEW.raw_user_meta_data->>'acquisition_referrer';
  v_utm_source text := NEW.raw_user_meta_data->>'acquisition_utm_source';
  v_utm_medium text := NEW.raw_user_meta_data->>'acquisition_utm_medium';
  v_utm_campaign text := NEW.raw_user_meta_data->>'acquisition_utm_campaign';
BEGIN
  INSERT INTO public.users (id, email, display_name, avatar_url)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'display_name', SPLIT_PART(NEW.email, '@', 1)), NEW.raw_user_meta_data->>'avatar_url')
  ON CONFLICT (id) DO NOTHING;

  v_base_slug := LOWER(REGEXP_REPLACE(REGEXP_REPLACE(SPLIT_PART(NEW.email, '@', 1), '[^a-zA-Z0-9]+', '-', 'g'), '^-+|-+$', '', 'g'));
  v_slug := v_base_slug;
  WHILE EXISTS (SELECT 1 FROM public.workspaces WHERE slug = v_slug) LOOP
    v_suffix := v_suffix + 1;
    v_slug := v_base_slug || '-' || v_suffix;
  END LOOP;

  IF v_source NOT IN ('direct', 'organic_google', 'reddit', 'github', 'smithery', 'glama', 'cursor', 'other') THEN v_source := NULL; END IF;
  IF v_landing NOT IN ('home', 'blog', 'provider', 'docs', 'pricing', 'other') THEN v_landing := NULL; END IF;
  IF v_landing_path !~ '^/(|other|blog(/[a-z0-9-]+)?|connect/[a-z0-9-]+|docs(/[a-z0-9-]+)*|pricing|security|self-hosting|native-connectors-vs-mcp)$' THEN v_landing_path := NULL; END IF;
  IF v_locale NOT IN ('en', 'nb', 'es', 'fr', 'zh') THEN v_locale := NULL; END IF;
  IF v_referrer NOT IN ('direct', 'organic_google', 'reddit', 'github', 'smithery', 'glama', 'cursor', 'other') THEN v_referrer := NULL; END IF;
  IF v_utm_source NOT IN ('direct', 'organic_google', 'reddit', 'github', 'smithery', 'glama', 'cursor', 'other') THEN v_utm_source := NULL; END IF;
  IF v_utm_medium NOT IN ('organic', 'paid_search', 'social', 'email', 'referral', 'affiliate', 'display', 'other') THEN v_utm_medium := NULL; END IF;
  IF v_utm_campaign NOT IN ('launch', 'newsletter', 'content', 'product', 'partner', 'community', 'other') THEN v_utm_campaign := NULL; END IF;

  INSERT INTO public.workspaces (
    owner_id, slug, display_name, plan, acquisition_source, acquisition_landing,
    acquisition_landing_path, acquisition_locale, acquisition_referrer,
    acquisition_utm_source, acquisition_utm_medium, acquisition_utm_campaign
  ) VALUES (
    NEW.id, v_slug, COALESCE(NEW.raw_user_meta_data->>'display_name', SPLIT_PART(NEW.email, '@', 1)), 'free', v_source, v_landing,
    v_landing_path, v_locale, v_referrer, v_utm_source, v_utm_medium, v_utm_campaign
  ) RETURNING id INTO v_workspace_id;

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_workspace_id, NEW.id, 'owner');
  RETURN NEW;
END;
$$;

-- Aggregate-only reporting primitive. It suppresses buckets smaller than
-- three workspaces and is intentionally unavailable to browser roles.
CREATE OR REPLACE FUNCTION public.get_workspace_acquisition_summary(
  p_since timestamptz DEFAULT now() - interval '90 days',
  p_dimension text DEFAULT 'source',
  p_min_bucket integer DEFAULT 3
)
RETURNS TABLE(bucket text, workspace_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_dimension NOT IN ('source', 'landing', 'landing_path', 'locale', 'referrer', 'utm_source', 'utm_medium', 'utm_campaign') THEN
    RAISE EXCEPTION 'Unsupported acquisition dimension';
  END IF;
  IF p_min_bucket < 3 THEN
    RAISE EXCEPTION 'Minimum bucket size is 3';
  END IF;

  RETURN QUERY
  SELECT
    CASE p_dimension
      WHEN 'source' THEN w.acquisition_source
      WHEN 'landing' THEN w.acquisition_landing
      WHEN 'landing_path' THEN w.acquisition_landing_path
      WHEN 'locale' THEN w.acquisition_locale
      WHEN 'referrer' THEN w.acquisition_referrer
      WHEN 'utm_source' THEN w.acquisition_utm_source
      WHEN 'utm_medium' THEN w.acquisition_utm_medium
      WHEN 'utm_campaign' THEN w.acquisition_utm_campaign
    END AS bucket,
    count(*) AS workspace_count
  FROM public.workspaces w
  WHERE w.created_at >= p_since
  GROUP BY 1
  HAVING count(*) >= p_min_bucket
  ORDER BY workspace_count DESC, bucket ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_workspace_acquisition_summary(timestamptz, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_workspace_acquisition_summary(timestamptz, text, integer) TO service_role;
