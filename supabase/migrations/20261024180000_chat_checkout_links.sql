-- ---------------------------------------------------------------------------
-- Chat checkout links (plan: Documents/plans/paywall-checkout-link-20261024.md)
--
-- When a Free workspace hits the monthly action cap inside a chat, the
-- refusal can carry a short-lived link to Stripe Checkout for Personal
-- monthly. The link opens checkout for the workspace OWNER and nothing else:
-- it never signs anyone in and never shows workspace data.
--
-- THE TOKEN. The edge function picks the row id, derives the token as
-- HMAC-SHA256(CHECKOUT_LINK_SECRET, id) and stores only sha256(token). The
-- secret lives in the edge function alone; the web route redeems by hashing
-- the presented token and looking the hash up, so it needs no secret. Because
-- the token is derived from the id, a repeat refusal inside the window can
-- hand back the SAME link without the plaintext ever being stored.
--
-- REUSE, NOT SINGLE USE. The first open creates the Checkout Session and
-- stores its id; later opens before expiry go to the same session. A link
-- unfurler or prefetch therefore cannot burn the link or create a second
-- session.
--
-- Only the blocked tool's NAME is kept (for the "continue worked" read-out),
-- never its arguments: email content is never stored.
--
-- RLS on, no policies, anon/authenticated revoked: service role only, the
-- same shape as product_funnel_events and the experiment tables.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.checkout_links (
  id uuid PRIMARY KEY,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_id text NOT NULL DEFAULT 'personal' CHECK (plan_id IN ('personal')),
  billing_interval text NOT NULL DEFAULT 'month' CHECK (billing_interval IN ('month')),
  -- Fixed label from client-label.ts / the initialize client family. Never a
  -- raw User-Agent.
  client_label text NOT NULL DEFAULT 'unknown' CHECK (client_label ~ '^[a-z0-9_.-]{1,40}$'),
  blocked_tool text CHECK (blocked_tool IS NULL OR blocked_tool ~ '^[a-z0-9_]{1,64}$'),
  -- Experiment arm the refusal was served under ('link' or 'on'/'internal').
  variant text NOT NULL DEFAULT 'link' CHECK (variant ~ '^[a-z0-9_]{1,32}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  first_opened_at timestamptz,
  open_count int NOT NULL DEFAULT 0,
  stripe_session_id text,
  stripe_session_expires_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS checkout_links_workspace_live_idx
  ON public.checkout_links (workspace_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS checkout_links_session_idx
  ON public.checkout_links (stripe_session_id) WHERE stripe_session_id IS NOT NULL;

ALTER TABLE public.checkout_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.checkout_links FROM anon, authenticated;

COMMENT ON TABLE public.checkout_links IS
  'Short-lived links from the in-chat Free-cap refusal to Stripe Checkout. Opaque token, only its sha256 stored. Service role only.';

-- ---------------------------------------------------------------------------
-- checkout_link_issue: return the workspace's live link, or create one.
--
-- The caller proposes an id and its token hash. If the workspace already has a
-- link with more than 2 minutes left, that row's id comes back instead (the
-- caller re-derives the token from it) and nothing is inserted, so a retry
-- loop cannot mint rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.checkout_link_issue(
  p_id uuid,
  p_token_hash bytea,
  p_workspace_id uuid,
  p_owner_user_id uuid,
  p_client_label text,
  p_blocked_tool text,
  p_variant text,
  p_ttl_minutes int DEFAULT 30
)
RETURNS TABLE (id uuid, expires_at timestamptz, reused boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_expires timestamptz;
BEGIN
  -- Serialise issuers for one workspace so two concurrent refusals agree on
  -- one link.
  PERFORM pg_advisory_xact_lock(hashtextextended('checkout_link:' || p_workspace_id::text, 0));

  SELECT l.id, l.expires_at INTO v_id, v_expires
  FROM public.checkout_links l
  WHERE l.workspace_id = p_workspace_id
    AND l.owner_user_id = p_owner_user_id
    AND l.completed_at IS NULL
    AND l.expires_at > now() + interval '2 minutes'
  ORDER BY l.expires_at DESC
  LIMIT 1;

  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, v_expires, true;
    RETURN;
  END IF;

  INSERT INTO public.checkout_links
    (id, token_hash, workspace_id, owner_user_id, client_label, blocked_tool, variant, expires_at)
  VALUES
    (p_id, p_token_hash, p_workspace_id, p_owner_user_id,
     coalesce(nullif(p_client_label, ''), 'unknown'), p_blocked_tool,
     coalesce(nullif(p_variant, ''), 'link'),
     now() + make_interval(mins => greatest(5, least(p_ttl_minutes, 60))))
  RETURNING checkout_links.expires_at INTO v_expires;

  RETURN QUERY SELECT p_id, v_expires, false;
END;
$$;

-- ---------------------------------------------------------------------------
-- checkout_link_open: redeem a presented token. Returns the row only while the
-- link is live; marks the first open and counts opens.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.checkout_link_open(p_token_hash bytea)
RETURNS TABLE (
  id uuid,
  workspace_id uuid,
  owner_user_id uuid,
  plan_id text,
  billing_interval text,
  client_label text,
  expires_at timestamptz,
  stripe_session_id text,
  stripe_session_expires_at timestamptz,
  completed_at timestamptz,
  first_open boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.checkout_links l
     SET open_count = l.open_count + 1,
         first_opened_at = coalesce(l.first_opened_at, now())
   WHERE l.token_hash = p_token_hash
     AND l.expires_at > now()
  RETURNING l.id, l.workspace_id, l.owner_user_id, l.plan_id, l.billing_interval,
            l.client_label, l.expires_at, l.stripe_session_id,
            l.stripe_session_expires_at, l.completed_at,
            (l.open_count = 1);
END;
$$;

-- ---------------------------------------------------------------------------
-- checkout_link_attach_session: store the Checkout Session created for a link.
-- First writer wins; the stored id is returned so a racing second request
-- redirects to the same session (the web route expires its own orphan).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.checkout_link_attach_session(
  p_id uuid,
  p_session_id text,
  p_session_expires_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session text;
BEGIN
  UPDATE public.checkout_links
     SET stripe_session_id = p_session_id,
         stripe_session_expires_at = p_session_expires_at
   WHERE id = p_id AND stripe_session_id IS NULL;

  SELECT stripe_session_id INTO v_session FROM public.checkout_links WHERE id = p_id;
  RETURN v_session;
END;
$$;

-- ---------------------------------------------------------------------------
-- checkout_link_complete: the webhook marks a link's checkout as paid.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.checkout_link_complete(p_id uuid)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.checkout_links SET completed_at = coalesce(completed_at, now()) WHERE id = p_id;
$$;

REVOKE ALL ON FUNCTION public.checkout_link_issue(uuid, bytea, uuid, uuid, text, text, text, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.checkout_link_open(bytea) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.checkout_link_attach_session(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.checkout_link_complete(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkout_link_issue(uuid, bytea, uuid, uuid, text, text, text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.checkout_link_open(bytea) TO service_role;
GRANT EXECUTE ON FUNCTION public.checkout_link_attach_session(uuid, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.checkout_link_complete(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- checkout_link_readout: per-arm numbers for the experiment, no runtime cost.
--
-- "resumed" = the blocked tool succeeded within 60 minutes after the link's
-- checkout completed. Computed here from activity_log rather than written at
-- call time, so a successful tool call pays nothing for this metric.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.checkout_link_readout(p_since timestamptz DEFAULT now() - interval '30 days')
RETURNS TABLE (
  variant text,
  client_label text,
  links bigint,
  opened bigint,
  checkout_sessions bigint,
  completed bigint,
  resumed bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT l.variant, l.client_label,
         count(*),
         count(*) FILTER (WHERE l.first_opened_at IS NOT NULL),
         count(*) FILTER (WHERE l.stripe_session_id IS NOT NULL),
         count(*) FILTER (WHERE l.completed_at IS NOT NULL),
         count(*) FILTER (WHERE l.completed_at IS NOT NULL AND EXISTS (
           SELECT 1 FROM public.activity_log a
           WHERE a.workspace_id = l.workspace_id
             AND a.tool_name = l.blocked_tool
             AND a.status = 'success'
             AND a.created_at BETWEEN l.completed_at AND l.completed_at + interval '60 minutes'))
  FROM public.checkout_links l
  WHERE l.created_at >= p_since
  GROUP BY 1, 2
  ORDER BY 1, 2;
$$;

REVOKE ALL ON FUNCTION public.checkout_link_readout(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkout_link_readout(timestamptz) TO service_role;

-- ---------------------------------------------------------------------------
-- Rollout gate for CHAT_CHECKOUT_LINK=internal (same pattern as
-- chat_send_confirm_enabled).
-- ---------------------------------------------------------------------------
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS chat_checkout_link_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.workspaces.chat_checkout_link_enabled IS
  'Internal rollout gate: under CHAT_CHECKOUT_LINK=internal only workspaces with this set get the checkout link in the Free-cap refusal.';

-- ---------------------------------------------------------------------------
-- Funnel: the link is a paywall entry point.
-- ---------------------------------------------------------------------------
ALTER TABLE public.product_funnel_events
  DROP CONSTRAINT IF EXISTS product_funnel_events_entry_point_check;
ALTER TABLE public.product_funnel_events
  ADD CONSTRAINT product_funnel_events_entry_point_check
  CHECK (entry_point IS NULL OR entry_point IN (
    'header', 'inboxes_page', 'guide', 'multi_inbox_overview', 'multi_inbox_inboxes',
    'post_checkout', 'first_run', 'provider_intent', 'reconnect', 'command_palette',
    'other',
    -- The checkout link in the in-chat Free-cap refusal (checkout_links).
    'chat_link'
  ));

-- ---------------------------------------------------------------------------
-- Experiment row, as a draft: draft serves variants[0] (control) to everyone,
-- so this row changes nothing until it is started from /admin/growth/experiments.
-- ---------------------------------------------------------------------------
INSERT INTO public.experiments (key, name, description, status, variants, retention_goal, retention_window_days)
VALUES (
  'chat_checkout_link',
  'Checkout link in the in-chat Free-cap refusal',
  'control: today''s refusal text with the pricing link. link: the refusal carries a 30-minute link straight to Stripe Checkout for Personal monthly. Subject = workspace id without dashes. Only consulted under CHAT_CHECKOUT_LINK=experiment.',
  'draft',
  '[{"id":"control","label":"Pricing link","weight":50},{"id":"link","label":"Checkout link","weight":50}]'::jsonb,
  'any_tool_call',
  7
)
ON CONFLICT (key) DO NOTHING;
