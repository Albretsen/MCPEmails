-- ---------------------------------------------------------------------------
-- product_funnel_events.entry_point: which control opened the connect modal.
--
-- WHY. Nine workspaces opened the connect modal and met its paywall 2 to 5
-- seconds after their first connect, and nothing recorded which button they
-- had pressed: every opener in the dashboard called the same setter. The
-- second-work-mailbox invitation is being moved next to those buttons, and
-- whether that works is unanswerable without knowing which control a
-- `paywall_reached` or `provider_selected` row came from.
--
-- WHY A NEW COLUMN. None of the existing ones fits. `category` carries the
-- plan on `paywall_reached` and the provider on `provider_selected`. `phase`
-- is CHECK-constrained to protocol phases. `connection_type` separates the
-- inbox-cap paywall from the action-cap one and first connects from
-- reconnects. `auth_reason` and `error_category` describe failures.
--
-- WHAT IT HOLDS. One name from a closed list, or NULL. NULL on every row that
-- is not written by the connect modal, on every row older than this column,
-- and for any value the server did not recognise. Never free text: the list
-- is the same one the app validates against in
-- apps/web/src/lib/analytics/connect-entry-point.mjs. Keep the two in step.
--
-- RE-RUNNABLE. ADD COLUMN IF NOT EXISTS, and the constraint is dropped and
-- re-added, so a second run (or a later run with a longer list) is safe.
-- Nullable with no default: no table rewrite, no backfill.
--
-- RELEASE ORDER. Apply before, or after, the app deploy: the app retries the
-- insert without this column when Postgres or PostgREST says it does not
-- exist, so no funnel row is lost either way. Rows written before it is
-- applied simply have no entry point.
-- ---------------------------------------------------------------------------

ALTER TABLE public.product_funnel_events
  ADD COLUMN IF NOT EXISTS entry_point text;

ALTER TABLE public.product_funnel_events
  DROP CONSTRAINT IF EXISTS product_funnel_events_entry_point_check;
ALTER TABLE public.product_funnel_events
  ADD CONSTRAINT product_funnel_events_entry_point_check
  CHECK (entry_point IS NULL OR entry_point IN (
    -- Overview page header "Connect inbox".
    'header',
    -- Inboxes page: header "Connect inbox", and the empty-state button.
    'inboxes_page',
    -- Getting-started guide, step 1.
    'guide',
    -- The second-work-mailbox invitation, by the page it sat on.
    'multi_inbox_overview',
    'multi_inbox_inboxes',
    -- "Connect another inbox" on the purchase confirmation.
    'post_checkout',
    -- Opened for the user on a first run, or from the first-run banner.
    'first_run',
    -- Opened with a provider preselected, from a provider landing page.
    'provider_intent',
    -- "Reconnect" on an existing mailbox.
    'reconnect',
    -- The command palette.
    'command_palette',
    -- Every other known opener.
    'other'
  ));

COMMENT ON COLUMN public.product_funnel_events.entry_point IS
  'Which dashboard control opened the connect modal, on the rows that modal writes '
  '(paywall_reached with connection_type = first_connect, provider_selected). '
  'Closed list, see apps/web/src/lib/analytics/connect-entry-point.mjs; NULL = not recorded.';
