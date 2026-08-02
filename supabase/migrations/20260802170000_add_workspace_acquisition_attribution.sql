-- Coarse first-touch attribution for growth analysis. These are allowlisted
-- categories only; no raw UTM values, referrers, URLs, or user identifiers.
ALTER TABLE public.workspaces
  ADD COLUMN acquisition_source text,
  ADD COLUMN acquisition_landing text;

ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_acquisition_source_check
    CHECK (acquisition_source IS NULL OR acquisition_source IN ('direct', 'organic_google', 'reddit', 'github', 'smithery', 'glama', 'cursor', 'other')),
  ADD CONSTRAINT workspaces_acquisition_landing_check
    CHECK (acquisition_landing IS NULL OR acquisition_landing IN ('home', 'blog', 'provider', 'docs', 'pricing', 'other'));

CREATE INDEX idx_workspaces_acquisition_source
  ON public.workspaces (acquisition_source, created_at DESC)
  WHERE acquisition_source IS NOT NULL;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace_id uuid;
  v_slug         text;
  v_base_slug    text;
  v_suffix       integer := 0;
  v_source       text;
  v_landing      text;
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

  v_source := NEW.raw_user_meta_data->>'acquisition_source';
  v_landing := NEW.raw_user_meta_data->>'acquisition_landing';
  IF v_source NOT IN ('direct', 'organic_google', 'reddit', 'github', 'smithery', 'glama', 'cursor', 'other') THEN v_source := NULL; END IF;
  IF v_landing NOT IN ('home', 'blog', 'provider', 'docs', 'pricing', 'other') THEN v_landing := NULL; END IF;

  INSERT INTO public.workspaces (owner_id, slug, display_name, plan, acquisition_source, acquisition_landing)
  VALUES (NEW.id, v_slug, COALESCE(NEW.raw_user_meta_data->>'display_name', SPLIT_PART(NEW.email, '@', 1)), 'free', v_source, v_landing)
  RETURNING id INTO v_workspace_id;

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_workspace_id, NEW.id, 'owner');
  RETURN NEW;
END;
$$;
