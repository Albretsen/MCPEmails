/**
 * Which control opened the connect modal. A CLOSED list, shared by the browser
 * (which names the opener) and the server (which stores nothing outside it).
 *
 * WHY. Nine workspaces opened the modal and met its paywall 2 to 5 seconds
 * after their first connect, and `product_funnel_events` could not say which
 * button they had pressed: every opener called the same `setShowConnect(true)`.
 * The value rides on the rows the modal already writes (`paywall_reached`,
 * `provider_selected`) in the nullable `entry_point` column, so no new stage
 * and no new row exists because of it.
 *
 * It is a name from this list and nothing else: no address, no provider, no
 * free text. Anything not on the list is stored as NULL, never as 'other';
 * 'other' is an opener the dashboard knows about and chose not to name.
 *
 * Keep in step with the CHECK in
 * supabase/migrations/20261005120000_funnel_entry_point.sql.
 */
export const CONNECT_ENTRY_POINTS = Object.freeze([
  // Overview page header "Connect inbox".
  'header',
  // Inboxes page: header "Connect inbox", and the empty-state button.
  'inboxes_page',
  // Getting-started guide, step 1 "Connect inbox".
  'guide',
  // The second-work-mailbox invitation, by the page it sat on.
  'multi_inbox_overview',
  'multi_inbox_inboxes',
  // "Connect another inbox" on the purchase confirmation.
  'post_checkout',
  // Opened for the user on a first run (the welcome timer), or from the
  // first-run banner.
  'first_run',
  // Opened with a provider preselected, from a provider landing page.
  'provider_intent',
  // "Reconnect" on an existing mailbox. Never reaches the paywall.
  'reconnect',
  // The command palette's "Connect inbox".
  'command_palette',
  // Every other known opener: the Usage page's empty state, the re-open after
  // an OAuth callback refused at the cap, the admin-consent toast.
  'other',
]);

/**
 * @param {unknown} value
 * @returns {string|null} The value when it is on the list, otherwise null.
 */
export function parseConnectEntryPoint(value) {
  return typeof value === 'string' && CONNECT_ENTRY_POINTS.includes(value) ? value : null;
}
