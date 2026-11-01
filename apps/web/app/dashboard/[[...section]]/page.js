import { redirect, notFound } from 'next/navigation';
import { after } from 'next/server';
import { cookies, headers } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { decideProFeatureAccess, isProFeaturePlan, PRO_FEATURES_PUBLIC_SWITCH } from '@/lib/plans/pro-features';
import { decideGmailOAuthAccess, loadGmailOAuthCapState } from '@/lib/oauth/gmail-oauth-gate';
import { ACTIVE_WORKSPACE_COOKIE } from '@/lib/workspace/active';
import { linkExperimentSubjectForRequest } from '@/lib/experiments/link-request';
import { stampAcquisitionSegment } from '@/lib/segment/record-segment';
import { deviceClassFromHeaders } from '@/lib/acquisition-device.mjs';
import { shouldStampDeviceOnDashboard, stampAcquisitionDevice } from '@/lib/acquisition-device-stamp';
import { countryFromHeaders } from '@/lib/acquisition-country.mjs';
import { stampAcquisitionCountry } from '@/lib/acquisition-country-stamp';
import { stampArabicGuideBrowserLanguage } from '@/lib/acquisition-browser-language';
import { PENDING_INBOX_COLUMNS, selectTolerantly } from '@/lib/approvals/columns';
import { DashboardApp } from '../../../components/dashboard/App';
import { pathSegmentToSection } from '../../../components/dashboard/routes';
import { resolvePlanLimits } from '../../../src/lib/stripe/plans';
import { retentionDays } from '../../../src/lib/analytics/retention';
import { calendarMonthWindow } from '../../../src/lib/usage/billing-window';
import { fetchWorkspaceActionAllowance } from '../../../src/lib/usage/allowance';
import { fetchStripePrices } from '../../../src/lib/stripe/getPrices';
import { getActiveSeasonalOffers } from '../../../src/lib/stripe/seasonal-offer-server';
import { getSeasonalSwitchOffer, mayOfferSeasonalSwitch } from '../../../src/lib/stripe/seasonal-switch';
import { withSeasonalOffers } from '../../../src/lib/billing/seasonal-offer-view.mjs';
import {
  attachFounder,
  founderDisplayFor,
  ownerIsOnFounderPrice,
  withFounderSubscriberPrices,
} from '../../../src/lib/stripe/founder-display';
import { loadPassBillingState } from '@/lib/billing/pass-offer';
import { clientOnboardingVariant, getOnboardingVariant } from '@/lib/onboarding/variant';
import { inferOnboardingClient } from '@/lib/onboarding/clients.mjs';
import { isOnboardingStep } from '@/lib/onboarding/flow';
import { CLIENT_INTENT_PARAM, CONNECT_INTENT_PARAM, connectIntentSlugShape } from '@/lib/connect/intent-carry.mjs';
import { buildFlowBProp } from '@/lib/onboarding/flow-b-server';
import { onboardingEntryPath } from '@/lib/onboarding/entry';
import { verifyChatConnectLink, withChatLinkParams } from '@/lib/onboarding/chat-connect-link';
import '../../../styles/dashboard.css';
import '../../../styles/theme.css';
import '../../../styles/help.css';

/**
 * A Supabase client carrying the generated schema, i.e. what both
 * `createClient()` (src/lib/supabase/server.ts) and `createServiceRoleClient()`
 * (src/lib/supabase/service.ts) actually return.
 *
 * Every fetcher below is annotated with this rather than a bare
 * `SupabaseClient`, which would be `SupabaseClient<any, "public", any>` and
 * would describe these functions as accepting a client whose `.from()` and
 * `.rpc()` are unchecked. That is not what they are handed.
 *
 * Note this is DOCUMENTATION, not enforcement: this file is .js, and
 * apps/web/tsconfig.json sets no `checkJs` and its `include` covers only .ts
 * and .tsx, so it is outside the typechecked program. The
 * `no-restricted-syntax` rules in eslint.config.mjs cannot read JSDoc either.
 * Keep the annotation honest by hand; the enforcement lives at the wrappers
 * this file imports.
 *
 * @typedef {import('@supabase/supabase-js').SupabaseClient<import('@/types/database.types').Database>} SchemaTypedClient
 */

/**
 * Fallback activity window, in UTC days, for a caller that passes none.
 *
 * The real window is the workspace's `analyticsRetentionDays` (Free 30,
 * Personal 90, Pro and Business 730), resolved once in the page component and
 * threaded into every history fetcher below. This constant only keeps those
 * fetchers callable on their own; it is not the product's answer to "how much
 * history do I get". See src/lib/analytics/retention.ts.
 */
const USAGE_WINDOW_DAYS = 30;

/**
 * Meter version the usage-summary RPC counts billable actions under. The
 * customer-facing count (the Free allowance tile) does not come from that RPC
 * but from workspace_action_allowance(), which pins the version itself; this
 * one only has to agree with ACTION_METER_VERSION in the MCP edge function so
 * the summary never silently counts a different ledger.
 */
const ACTION_METER_VERSION = 1;

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Dashboard',
  description: 'Manage your MCPEmails inboxes and API keys',
};

/**
 * Derives 1–2 letter initials from a display name or email address.
 * - "Jordan Reyes"  → "JR"
 * - "Jordan"        → "JO"
 * - "jordan@..."    → "J"
 */
function computeInitials(displayName, email) {
  if (displayName && displayName.trim().length > 0) {
    const parts = displayName.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return displayName.slice(0, 2).toUpperCase();
  }
  if (email && email.length > 0) {
    return email[0].toUpperCase();
  }
  return '?';
}

/**
 * Formats a UTC ISO timestamp as a human-readable relative time string.
 * e.g. "just now", "5m ago", "2h ago", "3d ago"
 *
 * @param {string} isoTimestamp
 * @returns {string}
 */
function formatRelativeTime(isoTimestamp) {
  const diffMs = Date.now() - new Date(isoTimestamp).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return 'yesterday';
  return `${diffDay}d ago`;
}

/**
 * Fetches the last 10 MCP tool calls from activity_log for the given workspace,
 * joined with the inbox's display name / email address.
 * Returns an empty array on any query error so the page always renders.
 *
 * @param {SchemaTypedClient} supabase
 * @param {string} workspaceId
 * @returns {Promise<Array<{ id: string, tool: string, account: string, time: string, ok: boolean }>>}
 */
async function fetchActivityFeed(supabase, workspaceId) {
  const { data, error } = await supabase
    .from('activity_log')
    .select('id, tool_name, status, created_at, inboxes(email_address, display_name)')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error || !data) {
    console.error('[fetchActivityFeed]', error?.message);
    return [];
  }

  return data.map((row) => {
    const inbox = row.inboxes;
    // Prefer display_name (e.g. "work-gmail"), then the email address. Null for
    // a call not tied to one inbox (inbox_list); the page shows "all inboxes".
    const account = inbox?.display_name || inbox?.email_address || null;
    return {
      id: row.id,
      tool: row.tool_name,
      account,
      time: formatRelativeTime(row.created_at),
      ok: row.status === 'success',
    };
  });
}

/**
 * Fetches all non-deleted inboxes for a workspace and their 30-day call counts.
 * Returns a serialisable array safe to pass as props to Client Components.
 * Encrypted credential columns are never selected here.
 *
 * @param {SchemaTypedClient} supabase
 * @param {string} workspaceId
 * @returns {Promise<Array<{ id: string, label: string, address: string, provider: string, status: string, lastError: string|null, hasImap: boolean, calls: number, createdAt: string, lastCallAt: string|null }>>}
 */
async function fetchInboxes(supabase, workspaceId, historyDays = USAGE_WINDOW_DAYS) {
  const [{ data: rows, error }, { data: logRows }] = await Promise.all([
    // `send_review_mode` is added by a migration that may land after this
    // code; selectTolerantly re-runs without it rather than blanking the whole
    // inbox list. See src/lib/approvals/columns.ts.
    //
    // `draft_editor_hidden` (20260916170000) is tolerated HERE but deliberately
    // NOT added to PENDING_INBOX_COLUMNS, because that constant is also the
    // optional list for the WRITE in /api/inboxes/[id]: dropping the column
    // there would make the route answer 200 for a preference it never stored.
    // A read has the opposite trade. Dropping it yields `undefined`, which
    // `shownFromHidden` already reads as "not hidden" (the pre-feature default
    // and the column's own DEFAULT false), whereas failing the select makes
    // `fetchInboxes` return [] and the Inboxes page claim the workspace has no
    // mailboxes at all. Degrade the preference, never the mailbox list.
    selectTolerantly(
      ['id', 'display_name', 'email_address', 'provider', 'service', 'status', 'last_error',
        'imap_host', 'imap_port', 'imap_security', 'smtp_host', 'smtp_port', 'smtp_security',
        'imap_username', 'created_at', 'signature_text', 'signature_html', 'signature_enabled',
        'signature_reply_mode', 'signature_source', 'send_approval_required', 'send_review_mode',
        'draft_editor_hidden', 'signature_embed_images', 'parked_at'],
      // `parked_at` (20261024173000) degrades like the two preferences above:
      // without it every inbox reads as active, which is the pre-parking truth.
      [...PENDING_INBOX_COLUMNS, 'draft_editor_hidden', 'signature_embed_images', 'parked_at'],
      (columns) => supabase
        .from('inboxes')
        .select(columns)
        .eq('workspace_id', workspaceId)
        .is('deleted_at', null)
        .order('created_at', { ascending: true }),
    ),

    // Per-inbox call count and last successful call, aggregated in Postgres.
    // This used to fetch every activity_log row of the last 30 days and count
    // them here. PostgREST truncates a response at 1,000 rows without an error
    // and the read carried no ORDER BY, so on a busy workspace both numbers
    // came off an arbitrary slice: the count capped at 1,000, and
    // `lastCallByInbox` was the maximum of a random subset, which could show a
    // heavily used inbox as having had no successful call in 30 days.
    supabase.rpc('workspace_inbox_activity', {
      p_workspace_id: workspaceId,
      p_days: historyDays,
    }),
  ]);

  if (error || !rows) {
    console.error('[fetchInboxes]', error?.message);
    return [];
  }

  // Build a call-count map and a last-successful-call map keyed by inbox_id.
  // lastCallByInbox is scoped to the plan's analytics window, matching the
  // call count; older successes read as "no successful calls" for that window.
  const callsByInbox = {};
  const lastCallByInbox = {};
  for (const row of logRows ?? []) {
    if (!row.inbox_id) continue;
    callsByInbox[row.inbox_id] = row.calls ?? 0;
    if (row.last_success_at) lastCallByInbox[row.inbox_id] = row.last_success_at;
  }

  return rows.map((row) => ({
    id: row.id,
    // Use display_name when set; fall back to the local-part of the email address.
    label: row.display_name ?? row.email_address.split('@')[0],
    // Raw sender display name (null when unset). Edited from the inbox detail
    // modal; the MCP edge function puts it in the From header when set.
    displayName: row.display_name ?? null,
    address: row.email_address,
    // Branded IMAP inboxes (iCloud, Yahoo, Zoho, Yandex) are stored as
    // provider 'imap' with the brand in `service`. Surface the brand so the
    // list shows the real logo/name; generic IMAP stays 'imap'.
    provider:
      row.provider === 'imap' && row.service && row.service !== 'generic'
        ? row.service
        : row.provider,
    status: row.status,
    // Parked above a lower plan's inbox cap (src/lib/billing/parking.ts):
    // connected and kept, but no tool or automation can use it.
    parked: !!row.parked_at,
    // Human-readable error shown on errored inboxes; null when healthy.
    lastError: row.last_error ?? null,
    // True when this inbox uses an IMAP/SMTP app-password path (not OAuth).
    // A send-only inbox has no IMAP host but is still a password connection,
    // and must reopen the password form on reconnect, not an OAuth route.
    hasImap: !!row.imap_host || !!row.smtp_host,
    // 'both' | 'imap' (receive only) | 'smtp' (send only); null for OAuth.
    connectionMode: row.imap_host && row.smtp_host ? 'both' : row.imap_host ? 'imap' : row.smtp_host ? 'smtp' : null,
    // IMAP service brand ('generic' for the plain IMAP connector, or
    // 'fastmail'/'icloud'/'yahoo'/'zoho'/'yandex'). Used by the reconnect flow
    // to re-open the SAME connect form this inbox was created with.
    service: row.service ?? null,
    // Connection identity, surfaced so the reconnect form can pre-fill and LOCK
    // these fields — preventing the browser from autofilling another account's
    // saved login into a blank field (the wrong-mailbox bug). Not secret; the
    // password is never exposed. imap_username is the SASL login (may differ
    // from the address, e.g. domeneshop).
    imapHost: row.imap_host ?? null,
    imapPort: row.imap_port ?? null,
    smtpHost: row.smtp_host ?? null,
    smtpPort: row.smtp_port ?? null,
    imapSecurity: row.imap_security ?? (row.imap_port === 143 ? 'starttls' : 'tls'),
    smtpSecurity: row.smtp_security ?? (row.smtp_port === 587 ? 'starttls' : 'tls'),
    username: row.imap_username ?? null,
    calls: callsByInbox[row.id] ?? 0,
    // When the inbox connection was first created.
    createdAt: row.created_at,
    // Most recent successful MCP call (within the 30-day window), or null.
    lastCallAt: lastCallByInbox[row.id] ?? null,
    // Per-inbox signature (Phase 3). The dashboard editor edits the plain-text
    // form; signatureHtml is surfaced only to detect a Gmail-imported value to
    // seed the textarea from when no plain text exists. Source tells the UI
    // whether to show the "imported from Gmail" hint.
    signatureText: row.signature_text ?? null,
    signatureHtml: row.signature_html ?? null,
    signatureEnabled: row.signature_enabled ?? true,
    signatureReplyMode: row.signature_reply_mode ?? 'first_only',
    signatureEmbedImages: row.signature_embed_images ?? false,
    signatureSource: row.signature_source ?? null,
    sendApprovalRequired: row.send_approval_required ?? false,
    // Three-way review mode (off | inline | dashboard). Falls back to the
    // legacy boolean until every row carries the new column.
    sendReviewMode:
      row.send_review_mode ?? (row.send_approval_required ? 'dashboard' : 'off'),
    // Per-inbox draft editor opt-out. `true` means the card is OFF for drafts
    // in this mailbox; the dashboard control presents the opposite sense and
    // inverts on write (src/lib/drafts/editor-preference.ts).
    //
    // `undefined` here is not hypothetical and not a row shape: it is what the
    // tolerant retry above produces on a database without migration
    // 20260916170000, which is the whole reason that retry lists this column.
    // It is not `true`, so the card stays on, matching the column's own
    // NOT NULL DEFAULT false.
    draftEditorHidden: row.draft_editor_hidden === true,
  }));
}

/**
 * Fetches all active (non-deleted) API keys for a workspace.
 * Returns only the columns safe to display in the dashboard, never key_hash.
 * Ordered newest-first so recently created keys appear at the top of the list.
 *
 * @param {SchemaTypedClient} supabase
 * @param {string} workspaceId
 * @returns {Promise<Array<{
 *   id: string,
 *   name: string,
 *   keyPrefix: string,
 *   scopes: string[],
 *   createdBy: string | null,
 *   createdAt: string,
 *   lastUsedAt: string | null,
 *   expiresAt: string | null,
 * }>>}
 */
async function fetchApiKeys(supabase, workspaceId) {
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, name, key_prefix, scopes, inbox_ids, created_by, created_at, last_used_at, expires_at')
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error || !data) {
    console.error('[fetchApiKeys]', error?.message);
    return [];
  }

  return data.map((row) => ({
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    scopes: row.scopes ?? [],
    // null = all inboxes (including any connected later); array = explicit allowlist.
    inboxIds: row.inbox_ids ?? null,
    // Who holds the key. The Keys page offers Edit/Revoke only on keys the
    // viewer may change (their own, or any key for an owner/admin), matching
    // the authorization in /api/api-keys/[id] and /revoke.
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? null,
    expiresAt: row.expires_at ?? null,
  }));
}

/**
 * Fetches the Overview page's call totals for a workspace in parallel.
 * Returns zeros on any query error so the page always renders.
 *
 * Connected-inbox and API-key counts used to be fetched here too. They were a
 * second, independently written definition of numbers the page already had in
 * `fetchInboxes` and `fetchApiKeys`, and the two drifted: this one filtered
 * `status = 'active'` while the plan cap, the Inboxes page and the sidebar
 * badge count every non-deleted row. The Overview card now counts the same
 * arrays everything else counts, so these two queries have no reader left.
 *
 * @param {SchemaTypedClient} supabase
 * @param {string} workspaceId
 * @returns {Promise<{ callsToday: number, callsThisMonth: number }>}
 */
async function fetchOverviewStats(supabase, workspaceId) {
  const now = new Date();
  // Midnight of the current calendar day (UTC)
  const todayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  ).toISOString();
  // First instant of the current calendar month (UTC)
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  ).toISOString();

  const [
    callsTodayResult,
    callsMonthResult,
  ] = await Promise.all([
    // MCP tool calls made today (UTC day)
    supabase
      .from('activity_log')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .gte('created_at', todayStart),

    // MCP tool calls made this calendar month (UTC)
    supabase
      .from('activity_log')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .gte('created_at', monthStart),
  ]);

  return {
    callsToday: callsTodayResult.count ?? 0,
    callsThisMonth: callsMonthResult.count ?? 0,
  };
}

/** The tools whose success means a message left the mailbox. */
const SEND_TOOLS = ['email_send', 'email_reply', 'email_forward', 'draft_send'];

/**
 * What the Overview's referral tile is gated on, beyond what the page already
 * has (components/dashboard/InvitePanel.jsx, referralTileEligible):
 *   successfulSends  sends that succeeded, all time (a head count, no rows).
 *   paidSince        the workspace's first `checkout_completed` funnel row,
 *                    or null. That table is service-role only. A comped or
 *                    pre-funnel paying workspace has no such row, and then
 *                    the paid branch of the tile stays hidden.
 * Free workspaces need neither: their branch counts active days off the
 * usage series, so nothing is queried for them.
 *
 * @param {SchemaTypedClient} supabase
 * @param {string} workspaceId
 * @param {string} plan  the effective plan
 * @returns {Promise<{ successfulSends: number, paidSince: string | null }>}
 */
async function fetchReferralTileFacts(supabase, workspaceId, plan) {
  if (plan === 'free') return { successfulSends: 0, paidSince: null };
  try {
    const [sends, paid] = await Promise.all([
      supabase
        .from('activity_log')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .eq('status', 'success')
        .in('tool_name', SEND_TOOLS),
      createServiceRoleClient()
        .from('product_funnel_events')
        .select('occurred_at')
        .eq('workspace_id', workspaceId)
        .eq('stage', 'checkout_completed')
        .order('occurred_at', { ascending: true })
        .limit(1)
        .maybeSingle(),
    ]);
    return { successfulSends: sends.count ?? 0, paidSince: paid.data?.occurred_at ?? null };
  } catch (err) {
    console.error('[fetchReferralTileFacts]', err instanceof Error ? err.message : String(err));
    return { successfulSends: 0, paidSince: null };
  }
}

/**
 * Fetches 30 days of MCP call data for the Usage page.
 * Returns daily counts (oldest first), per-tool breakdown, and per-inbox breakdown.
 * All aggregation is done in JavaScript after a single query so no DB function is needed.
 *
 * @param {SchemaTypedClient} supabase
 * @param {string} workspaceId
 * @returns {Promise<{
 *   dailyCounts: Array<{ date: string, count: number }>,
 *   totalCalls: number,
 *   byTool: Array<{ tool: string, count: number, pct: number }>,
 *   byInbox: Array<{ inboxId: string, label: string, address: string, archived: boolean, count: number, pct: number }>,
 * }>}
 */
async function fetchUsageData(supabase, workspaceId, billingWindow, historyDays = USAGE_WINDOW_DAYS) {
  const [summaryResult, inboxesResult] = await Promise.all([
    // Every number on the Usage page, aggregated in Postgres and returned as
    // one jsonb row.
    //
    // This used to be two raw selects counted in Node, and every figure it
    // produced was capped: PostgREST truncates a response at 1,000 rows and
    // reports no error. Measured on production the day this was fixed, the
    // busiest workspace made 33,292 calls in 30 days and this page told its
    // owner 1,000. Neither read carried an ORDER BY either, so the daily chart
    // was drawn from an arbitrary slice rather than from a truncated tail.
    supabase.rpc('workspace_usage_summary', {
      p_workspace_id: workspaceId,
      p_period_start: billingWindow.start,
      p_period_end: billingWindow.end,
      p_days: historyDays,
      p_meter_version: ACTION_METER_VERSION,
    }),
    // Include soft-deleted inboxes here (no deleted_at filter): a call can be
    // attributed to an inbox that was since deleted/revoked, and we still want
    // to show its original label/address (greyed-out) instead of "Unknown
    // inbox" so the usage breakdown stays meaningful.
    supabase
      .from('inboxes')
      .select('id, display_name, email_address, deleted_at')
      .eq('workspace_id', workspaceId),
  ]);

  if (summaryResult.error) {
    console.error('[fetchUsageData]', summaryResult.error.message);
  }

  const summary = summaryResult.data ?? {};

  // Build inbox label lookup: id → { label, address, archived }
  const inboxMap = {};
  for (const ib of inboxesResult.data ?? []) {
    inboxMap[ib.id] = {
      label: ib.display_name ?? ib.email_address.split('@')[0],
      address: ib.email_address,
      // Deleted/revoked inboxes still resolve their original label, but are
      // flagged so the UI can render them as archived.
      archived: !!ib.deleted_at,
    };
  }

  // The RPC returns one entry per UTC day in the window, oldest first, with
  // quiet days already present as zeroes, so there is no date array to rebuild
  // here and no way for the series and the counts to cover different days.
  const dailyCounts = (summary.daily ?? []).map((entry) => ({
    date: entry.date,
    count: entry.count ?? 0,
  }));

  const totalCalls = summary.total_calls ?? 0;

  const byTool = (summary.by_tool ?? []).map((entry) => ({
    tool: entry.tool,
    count: entry.count ?? 0,
    pct: totalCalls > 0 ? Math.round(((entry.count ?? 0) / totalCalls) * 100) : 0,
  }));

  const byInbox = (summary.by_inbox ?? []).map((entry) => {
    const inboxId = entry.inbox_id;
    const inbox = inboxMap[inboxId];
    return {
      inboxId,
      // Resolve the original label even for deleted inboxes. Only a row that
      // was hard-deleted (no soft-delete record at all) falls back to the id.
      label: inbox?.label ?? `Inbox ${String(inboxId).slice(0, 8)}`,
      address: inbox?.address ?? '',
      // True when the inbox was deleted/revoked, or when no row exists at all.
      archived: inbox ? inbox.archived : true,
      count: entry.count ?? 0,
      pct: totalCalls > 0 ? Math.round(((entry.count ?? 0) / totalCalls) * 100) : 0,
    };
  });

  // Billable-action totals and the usage_limit_events rejection count are
  // deliberately not returned. They fed the monthly allowance meter, which was
  // removed when inboxes replaced action volume as the value metric; the
  // rejection count was a second DB round trip serving only that widget.
  return { dailyCounts, totalCalls, byTool, byInbox };
}

/**
 * Fetches the first page (25 rows) of audit log entries for the security page.
 * Returns tool calls from activity_log with joined inbox and api_key display fields.
 * Never fetches encrypted credential columns.
 *
 * @param {SchemaTypedClient} supabase
 * @param {string} workspaceId
 * @returns {Promise<{
 *   entries: Array<{
 *     id: string,
 *     tool: string,
 *     inbox: string | null,
 *     apiKeyName: string | null,
 *     apiKeyPrefix: string | null,
 *     status: string,
 *     errorCode: string | null,
 *     durationMs: number | null,
 *     createdAt: string,
 *   }>,
 *   total: number,
 *   page: number,
 *   pageSize: number,
 * }>}
 */
async function fetchAuditLog(supabase, workspaceId) {
  const pageSize = 25;
  // DELIBERATELY UNBOUNDED, unlike the usage analytics above.
  //
  // The analytics retention window was briefly applied here too and then taken
  // back out. An audit log is a SECURITY artifact, not a usage metric: cutting
  // it by price tier means the customers least equipped to detect a compromise
  // keep the least evidence of one, and this product holds mailbox
  // credentials. The industry does not do this either. Where an audit log is
  // offered at all it is gated as a whole feature and then kept generously
  // (Linear 90 days, Vercel 90, 1Password 365, GitHub retains indefinitely and
  // merely defaults the VIEW to three months); the one vendor that scales it
  // down hard by tier, Auth0 at 1-30 days, is publicly complained about for it.
  // Nobody ships a 7-day audit log. Do not re-add a window here without a
  // reason that is about storage, not packaging.
  //
  // What it can show is bounded by storage, not by this query: the per-plan
  // activity_log job (migration 20261020153742) never deletes a
  // mailbox-changing call before 90 days on any plan, and keeps read-only
  // calls at least as long as the plan's Usage window.

  const [countResult, rowsResult] = await Promise.all([
    supabase
      .from('activity_log')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId),
    supabase
      .from('activity_log')
      .select(
        'id, tool_name, status, error_code, duration_ms, created_at, inboxes(email_address, display_name), api_keys(name, key_prefix)',
      )
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .range(0, pageSize - 1),
  ]);

  if (rowsResult.error) {
    console.error('[fetchAuditLog]', rowsResult.error.message);
    return { entries: [], total: 0, page: 0, pageSize };
  }

  const entries = (rowsResult.data ?? []).map((row) => {
    const inbox = row.inboxes;
    const apiKey = row.api_keys;
    return {
      id: row.id,
      tool: row.tool_name,
      inbox: inbox?.display_name ?? inbox?.email_address ?? null,
      apiKeyName: apiKey?.name ?? null,
      apiKeyPrefix: apiKey?.key_prefix ?? null,
      status: row.status,
      errorCode: row.error_code ?? null,
      durationMs: row.duration_ms ?? null,
      createdAt: row.created_at,
    };
  });

  return {
    entries,
    total: countResult.count ?? 0,
    page: 0,
    pageSize,
  };
}

/**
 * Fetches all members of a workspace using the get_workspace_members() SECURITY DEFINER RPC.
 * The RPC bypasses the users_select_own RLS policy so member profiles are visible.
 *
 * @param {SchemaTypedClient} supabase
 * @param {string} workspaceId
 * @returns {Promise<Array<{ userId, role, joinedAt, email, displayName, avatarUrl }>>}
 */
async function fetchMembers(supabase, workspaceId) {
  const { data, error } = await supabase.rpc('get_workspace_members', {
    p_workspace_id: workspaceId,
  });
  if (error || !data) {
    console.error('[fetchMembers]', error?.message);
    return [];
  }
  return data.map((row) => ({
    userId:      row.user_id,
    role:        row.role,
    joinedAt:    row.joined_at,
    email:       row.email,
    displayName: row.display_name ?? null,
    avatarUrl:   row.avatar_url  ?? null,
  }));
}

/**
 * Fetches pending (un-accepted, non-expired) workspace invites.
 *
 * @param {SchemaTypedClient} supabase
 * @param {string} workspaceId
 * @returns {Promise<Array<{ id, email, role, expiresAt, createdAt }>>}
 */
async function fetchPendingInvites(supabase, workspaceId) {
  // @ts-expect-error: Database types need regenerating after workspace_invites migration
  const { data, error } = await supabase
    .from('workspace_invites')
    .select('id, email, role, expires_at, created_at')
    .eq('workspace_id', workspaceId)
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false });
  if (error || !data) {
    console.error('[fetchPendingInvites]', error?.message);
    return [];
  }
  return data.map((row) => ({
    id:        row.id,
    email:     row.email,
    role:      row.role,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }));
}

export default async function DashboardPage({ params, searchParams }) {
  // Optional catch-all: `/dashboard` → section undefined; `/dashboard/inboxes`
  // → section ['inboxes']. Resolve to a valid route id, or 404 on an unknown
  // segment / extra path depth so bad URLs don't silently render the overview.
  const { section } = await params;
  if (Array.isArray(section) && section.length > 1) notFound();
  const initialRoute = pathSegmentToSection(section?.[0]);
  if (initialRoute === null) notFound();

  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect('/login');
  }

  const cookieStore = await cookies();
  const preferredWorkspaceId = cookieStore.get(ACTIVE_WORKSPACE_COOKIE)?.value ?? null;

  const [{ data: userRecord }, { data: workspaceRows }, { data: usageEntitlement }, { data: ownBilling }] = await Promise.all([
    supabase
      .from('users')
      .select('display_name, email')
      .eq('id', user.id)
      .single(),
    // RLS-filtered: returns every workspace the user is a member of
    // (their own + any they were invited to). owner_id lets us tell which
    // ones they own (for the Pro "create workspace" gate).
    supabase
      .from('workspaces')
      .select('id, slug, display_name, plan, owner_id, created_at, onboarding_completed_at, grandfathered, draft_editor_enabled, draft_editor_hidden, chat_send_confirm_enabled, referral_enabled, analytics_first_tool_name, analytics_first_tool_provider, analytics_first_tool_client, analytics_first_tool_path, analytics_first_tool_reported_at, analytics_first_tool_used_at, plan_summary_dismissed_at, grace_end_note_seen_at, onboarding_client, acquisition_source, acquisition_referrer')
      .is('deleted_at', null)
      .order('created_at', { ascending: true }),
    supabase
      .from('user_usage_entitlements')
      .select('kind, expires_at')
      .eq('user_id', user.id)
      .maybeSingle(),
    // The viewer's OWN billing row (RLS: select own). Feeds the failed-payment
    // banner, which only the owner of the active workspace sees. A read error
    // leaves it null, and null shows no banner.
    supabase
      .from('user_billing')
      .select('subscription_status, last_decline_code')
      .eq('user_id', user.id)
      .maybeSingle(),
  ]);

  const allWorkspaces = workspaceRows ?? [];
  // Active workspace: the cookie-selected one if the user still belongs to it,
  // otherwise the earliest-created workspace.
  const workspace =
    allWorkspaces.find((w) => w.id === preferredWorkspaceId) ?? allWorkspaces[0] ?? null;
  // The referral program's rollout flag, at the workspace grain like the
  // confirm-in-chat one. While it is off /dashboard/invite does not exist.
  const referralEnabled = workspace?.referral_enabled === true;
  if (initialRoute === 'invite' && !referralEnabled) notFound();

  // Join the anonymous visitor id to the account, once, on the first
  // authenticated render after signup. Both signup paths (password, and OAuth
  // via /auth/callback) land here first. The call gates itself on
  // isNewAccountSignup, so a returning customer's dashboard load does nothing,
  // and it swallows its own errors: an analytics write must never be the thing
  // that breaks the dashboard.
  await linkExperimentSubjectForRequest({
    workspaceId: workspace?.id ?? null,
    userId: user.id,
    userCreatedAt: user.created_at,
  });

  // Onboarding arms (src/lib/onboarding/variant.ts). For a password signup this
  // render is the first server request, so it is also where the workspace is
  // assigned (idempotent; OAuth signups were assigned in /auth/callback). A
  // workspace in the new flow that lands on the first-run dashboard
  // (`?firstrun=1`) goes to /onboarding instead, hints kept.
  const onboarding = workspace
    ? await getOnboardingVariant(workspace.id, {
        ownerEmail: workspace.owner_id === user.id ? (user.email ?? null) : null,
        workspaceCreatedAt: workspace.created_at ?? null,
      })
    : null;
  // A connect link from a chat (the MCP server's no-inbox answer), signed for
  // THIS workspace: connect only, then "Go back to <client> and ask again".
  // A workspace in the new onboarding flow does that on /onboarding instead.
  // A link that does not verify is an ordinary visit (its ?provider= still
  // preselects the card). src/lib/onboarding/chat-connect-link.ts.
  const chatQuery = (await searchParams) ?? {};
  const chatReturn = workspace ? verifyChatConnectLink(chatQuery, workspace.id) : null;
  // `?setup=1` (where /onboarding redirects): the setup flow opens as a modal
  // over this dashboard (components/onboarding/SetupModal.jsx), so neither
  // redirect below applies.
  const setupRequested = chatQuery.setup === '1';
  if (chatReturn && onboarding?.flow === 'new' && !setupRequested) redirect(withChatLinkParams('/onboarding', chatQuery));

  if (onboarding?.flow === 'new' && !setupRequested) {
    const query = (await searchParams) ?? {};
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (typeof value === 'string') qs.set(key, value);
    const entry = onboardingEntryPath(`/dashboard?${qs.toString()}`);
    if (entry) redirect(entry);
  }

  // Record which segment the owner's signup email falls in (business, consumer,
  // academic), so the business-domain onboarding and paywall changes can be
  // measured by a GROUP BY rather than a second classifier in SQL. Same place
  // and same reasoning as the subject join above: every signup path lands
  // here. After the response, so it can never slow the first render, and only
  // for the owner's own workspace, since a member's address says nothing about
  // who pays. It gates itself on account age and never overwrites.
  if (workspace && workspace.owner_id === user.id) {
    const workspaceId = workspace.id;
    after(() => stampAcquisitionSegment(createServiceRoleClient(), {
      workspaceId,
      ownerEmail: user.email,
      userCreatedAt: user.created_at,
    }));
  }

  // Record whether a password signup came from a phone, a tablet or a desktop.
  // This render is the first request such a signup's browser makes to us:
  // signUp() goes from the page straight to Supabase, so nothing earlier sees
  // its User-Agent. Google and GitHub signups are stamped in /auth/callback
  // instead and are skipped here. The class is read before the response and
  // written after it; the User-Agent itself is never kept. Gated on an account
  // that is minutes old, owner's workspace only, never overwrites.
  // The signup country rides along on the same gate and the same request:
  // Vercel's x-vercel-ip-country, two letters, never the IP itself.
  if (shouldStampDeviceOnDashboard({ provider: user.app_metadata?.provider, userCreatedAt: user.created_at })) {
    const requestHeaders = await headers();
    const device = deviceClassFromHeaders(requestHeaders);
    const country = countryFromHeaders(requestHeaders);
    const acceptLanguage = requestHeaders.get('accept-language');
    after(() => stampAcquisitionDevice(createServiceRoleClient(), { ownerId: user.id, device }));
    after(() => stampAcquisitionCountry(createServiceRoleClient(), { ownerId: user.id, country }));
    after(() => stampArabicGuideBrowserLanguage(createServiceRoleClient(), { ownerId: user.id, acceptLanguage }));
  }

  // The calling user's role in the ACTIVE workspace (drives role-gated UI).
  let userRole = 'member';
  let effectiveWorkspacePlan = null;
  // The workspace's action allowance (plan, exemption, cap, window, used),
  // shaped exactly like GET /api/usage. Null when the call fails, in which
  // case the Overview shows a plain call count and no bar, as it did before
  // the allowance existed.
  let actionAllowance = null;
  // The Pro feature gate's two switches (lib/plans/pro-features.ts). Each in
  // its own query, never in the shared workspace select above: before the
  // gate's migration lands a missing column only closes the gate. Fails closed.
  let proGateSwitches = { rolloutEnabled: false, publicLaunch: false };
  if (workspace) {
    const [{ data: memberRow }, { data: effectivePlanRows }, allowance, proRollout, proLaunch] = await Promise.all([
      supabase
        .from('workspace_members')
        .select('role')
        .eq('user_id', user.id)
        .eq('workspace_id', workspace.id)
        .maybeSingle(),
      supabase.rpc('effective_workspace_plan', { p_workspace_id: workspace.id }),
      // workspace_action_allowance() is the ONE definition of the window and
      // the cap: the MCP edge function refuses off the same row, so what this
      // page shows is what blocks. It reads the OWNER's Stripe cycle and the
      // owner's entitlements itself, which is why it is service-role and why
      // the viewer's RLS-scoped client (which cannot see another member's
      // user_billing row) is not used for it. The viewer's membership is
      // established by the RLS-filtered workspace list above.
      fetchWorkspaceActionAllowance(createServiceRoleClient(), workspace.id),
      supabase.from('workspaces').select('pro_features_enabled').eq('id', workspace.id).maybeSingle(),
      // Server-owned switch (no grant to authenticated), so the service role.
      createServiceRoleClient().from('pricing_switches').select('enabled').eq('key', PRO_FEATURES_PUBLIC_SWITCH).maybeSingle(),
    ]);
    proGateSwitches = {
      rolloutEnabled: !proRollout.error && proRollout.data?.pro_features_enabled === true,
      publicLaunch: !proLaunch.error && proLaunch.data?.enabled === true,
    };
    userRole = memberRow?.role ?? 'member';
    effectiveWorkspacePlan = effectivePlanRows?.[0] ?? null;
    actionAllowance = allowance;
  }

  // Creating additional workspaces is a Pro feature: the user must OWN at least
  // one Pro/Enterprise workspace. Being an invited member of one does not count.
  const userCompedScale = usageEntitlement?.kind === 'comped_scale' &&
    (!usageEntitlement.expires_at || new Date(usageEntitlement.expires_at) > new Date());
  const canCreateWorkspace = userCompedScale || allWorkspaces.some(
    (w) => w.owner_id === user.id && (w.plan === 'pro' || w.plan === 'enterprise'),
  );

  // Fall back to Supabase Auth fields if the users table row is missing.
  const displayName = userRecord?.display_name ?? user.user_metadata?.full_name ?? '';
  const email = userRecord?.email ?? user.email ?? '';
  const initials = computeInitials(displayName || null, email);
  const workspaceSlug = workspace?.slug ?? 'workspace';
  const compedScale = effectiveWorkspacePlan?.comped_scale ?? false;
  // The 2026-08-19 repricing grandfather: every user who existed before inboxes
  // became a paid limit keeps unlimited connected inboxes, permanently. It has
  // to be read here, not just in the connect routes, or the dashboard would
  // show a grandfathered free account a 1-inbox cap and a scarcity bar for a
  // limit the server would never actually enforce against them.
  const unlimitedInboxes = effectiveWorkspacePlan?.unlimited_inboxes ?? false;
  // The 2026-10 Pro cap: a workspace on Pro at the cutover keeps unlimited
  // inboxes (or every Pro workspace does, while the cap's kill switch is off).
  // Read here for the same reason as the grandfather above.
  const proUnlimitedInboxes = effectiveWorkspacePlan?.pro_unlimited_inboxes ?? false;
  const plan = effectiveWorkspacePlan?.plan ?? workspace?.plan ?? 'free';
  // Pro features (lib/plans/pro-features.ts): visible = rollout flag OR launch
  // switch, allowed = visible AND Pro or Business. Only the effective plan the
  // RPC resolved counts; an unresolved plan stays closed.
  const proFeatureAccess = decideProFeatureAccess({
    plan: effectiveWorkspacePlan?.plan ?? null,
    ...proGateSwitches,
  });
  // Gmail via Google sign-in for NEW connections (src/lib/oauth/gmail-oauth-gate.ts):
  // Pro or Business only, and only while the unverified Google client has
  // slots left. The cap is read only for a plan that could pass, so Free and
  // Personal dashboards pay no extra query. Reconnects are not affected.
  const gmailOAuthPlan = effectiveWorkspacePlan?.plan ?? null;
  const gmailOAuthAccess = decideGmailOAuthAccess({
    plan: gmailOAuthPlan,
    capClosed: isProFeaturePlan(gmailOAuthPlan)
      ? (await loadGmailOAuthCapState(createServiceRoleClient())).closed
      : true,
  });
  // The period the usage-summary RPC scopes its (undisplayed) action meter to:
  // the allowance's own window, or the UTC month when that call failed.
  const billingWindow = actionAllowance
    ? { start: actionAllowance.monthly.period_start, end: actionAllowance.monthly.resets_at }
    : calendarMonthWindow();

  // Serialisable workspace list for the sidebar switcher.
  //
  // `plan` here is the EFFECTIVE plan, never the stored `workspaces.plan`
  // column. The stored column is not what the customer is entitled to: a comp
  // lives in `user_usage_entitlements`, keyed on the workspace OWNER, and only
  // `effective_workspace_plan()` joins the two. A comped workspace therefore
  // stores 'free' while its owner is entitled to Team, which is how the
  // switcher came to say "Free plan" directly above an account footer saying
  // "Team plan" on the same screen.
  //
  // That RPC is resolved above for the ACTIVE workspace only, and it is
  // deliberately not fanned out across the whole list: it is RLS-gated and
  // takes one workspace id, so covering the list would mean an extra round
  // trip per row on every dashboard render, for a label in a menu most people
  // never open. Every other row therefore carries `plan: null`, meaning "not
  // resolved" rather than "free", and the sidebar renders no plan label at all
  // for those rows. Showing the stored column there would be the same lie in a
  // quieter place.
  const workspaces = allWorkspaces.map((w) => ({
    id: w.id,
    slug: w.slug,
    displayName: w.display_name ?? w.slug,
    plan: w.id === workspace?.id ? plan : null,
    isOwner: w.owner_id === user.id,
  }));

  // Resolve plan limits BEFORE the data fetch, because how much analytics
  // history this workspace may see is one of them. Both protections are
  // user-level and must be passed together: `compedScale` grants Team
  // features, `unlimitedInboxes` is the repricing grandfather.
  const rawLimits = resolvePlanLimits(plan, { compedScale, unlimitedInboxes, proUnlimitedInboxes });
  // The window the Usage page, the per-inbox activity counts and the audit log
  // are all bounded by. Free and Personal buy 30 days, Pro 90, Team a year;
  // those numbers are published copy, so they are read from the plan rather
  // than hardcoded here. See src/lib/analytics/retention.ts.
  const historyDays = retentionDays(rawLimits);

  // Fetch all page data in parallel; skip if no workspace row exists yet.
  const [overviewStats, activityFeed, inboxes, apiKeys, usageData, auditLog, members, pendingInvites] = workspace
    ? await Promise.all([
        fetchOverviewStats(supabase, workspace.id),
        fetchActivityFeed(supabase, workspace.id),
        fetchInboxes(supabase, workspace.id, historyDays),
        fetchApiKeys(supabase, workspace.id),
        fetchUsageData(supabase, workspace.id, billingWindow, historyDays),
        fetchAuditLog(supabase, workspace.id),
        fetchMembers(supabase, workspace.id),
        fetchPendingInvites(supabase, workspace.id),
      ])
    : [
        { callsToday: 0, callsThisMonth: 0 },
        [],
        [],
        [],
        { dailyCounts: [], totalCalls: 0, byTool: [], byInbox: [] },
        { entries: [], total: 0, page: 0, pageSize: 25 },
        [],
        [],
      ];

  // The action allowance travels beside planLimits as `actionAllowance`, not
  // inside it: planLimits is the plan's static shape, the allowance is a live
  // reading with a window and a count. A paid plan's ceiling is still an
  // abuse guard, not a feature, and arrives in that object as cap: null.
  const planLimits = {
    // null = unlimited. A grandfathered free account lands here too, and the
    // inbox cap UI keys off exactly this null to render nothing at all.
    maxInboxes: rawLimits.maxInboxes === Infinity ? null : rawLimits.maxInboxes,
    maxApiKeys: rawLimits.maxApiKeys === Infinity ? null : rawLimits.maxApiKeys,
    maxMembers: rawLimits.maxMembers === Infinity ? null : rawLimits.maxMembers,
    // Team roles (Admin/Viewer) and additional members are both Team
    // capabilities: Free and Pro are single-seat. The Members UI uses
    // maxMembers for the seat count and this flag to gate role selection.
    teamRolesEnabled: rawLimits.teamRolesEnabled,
    // How many days of history this plan buys. The Usage and Inboxes pages
    // label their figures with it, so the number on screen always matches the
    // window the queries above actually used.
    historyDays,
    // A Pro workspace from before the 2026-10 inbox cap, told on the billing
    // panel that it keeps unlimited inboxes. Not for a grandfathered user,
    // whose unlimited inboxes come from the older promise.
    proInboxesKept: plan === 'solo' && proUnlimitedInboxes && !unlimitedInboxes && !compedScale,
  };

  // True only when the unlimited inboxes come from the grandfather rather than
  // from the plan the customer is paying for. A Pro subscriber already has
  // unlimited inboxes and does not need to be told they were spared anything.
  const inboxesGrandfathered = unlimitedInboxes && !compedScale && plan === 'free';

  // The two facts the Overview's referral tile needs that no client array
  // holds. Read only while the program is rolled out to this workspace.
  const referralTileFacts = referralEnabled && workspace
    ? await fetchReferralTileFacts(supabase, workspace.id, plan)
    : null;

  // The single Streamable HTTP MCP endpoint clients connect to.
  const mcpUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://mcpemails.com'}/api/mcp`;

  // Live plan prices from Stripe (ISR-cached 1h), so the billing UI never
  // displays hardcoded amounts. Falls back to static cents in plans.ts.
  //
  // The seasonal first-year offer (Black Week 2026) rides on the same map as
  // `seasonalOffer` on the Personal and Pro entries, so every upgrade surface
  // that already receives `stripePrices` can show it. Outside the window, or
  // with the coupon killed in Stripe, `offers` is {} and the map is unchanged.
  const [livePrices, seasonalOffers] = await Promise.all([
    fetchStripePrices(),
    getActiveSeasonalOffers(),
  ]);
  // The billing page's "switch to annual" card, for an owner on monthly
  // Personal or Pro. The interval is only written down on the Stripe
  // subscription, so this reads Stripe, but only when an offer exists and the
  // account could take it (no call at all for the rest of the year).
  const switchInput = {
    offers: seasonalOffers,
    plan,
    isOwner: workspace?.owner_id === user.id,
    compedScale,
  };
  let seasonalSwitch = null;
  if (mayOfferSeasonalSwitch(switchInput)) {
    const { data: billingRow } = await createServiceRoleClient()
      .from('user_billing')
      .select('stripe_customer_id, stripe_subscription_id')
      .eq('user_id', user.id)
      .maybeSingle();
    seasonalSwitch = await getSeasonalSwitchOffer({
      ...switchInput,
      stripeCustomerId: billingRow?.stripe_customer_id ?? null,
      stripeSubscriptionId: billingRow?.stripe_subscription_id ?? null,
    });
  }
  // Which accounts the upgrade surfaces may quote the first-year price to:
  // a Free workspace (a new subscription through Stripe Checkout), and a paid
  // one only when it qualifies for the switch, i.e. it is on the CURRENT
  // monthly Personal or Pro price and has never redeemed the offer. Anyone
  // else (annual, Business, legacy, comped) would be quoted a price that
  // checkout-core does not apply to their swap, so they are shown none.
  const surfaceOffers = plan === 'free' || seasonalSwitch ? seasonalOffers : {};
  //
  // The Business founder line rides on the Business entry, for an owner who is
  // not on Business already (src/lib/stripe/founder-offer.ts). The client
  // swaps the founder amounts in for its language (zh keeps the normal price).
  // The seasonal offer never touches Business, so the two do not meet.
  const founder =
    workspace?.owner_id === user.id && plan !== 'pro' && !compedScale
      ? await founderDisplayFor({ ownerId: user.id })
      : null;
  const offeredPrices = attachFounder(withSeasonalOffers(livePrices, surfaceOffers), founder);
  // An owner who already pays the founder price sees Business at that price
  // ($29 / $278.40), not the $39 list price, on every surface that prices it.
  const stripePrices =
    workspace?.owner_id === user.id && plan === 'pro' && !compedScale &&
    (await ownerIsOnFounderPrice(user.id))
      ? await withFounderSubscriberPrices(offeredPrices)
      : offeredPrices;

  // Onboarding Flow B (src/lib/onboarding/flow-b-server.ts): the plan
  // summary, grace-end note and usage meter on the Overview. Null, with no
  // query, outside the onb_convert arm, on any paid plan, and for a member
  // who does not own the workspace (the buy buttons are the owner's).
  const flowB = workspace && onboarding?.convert === 'on' && workspace.owner_id === user.id
    ? await buildFlowBProp({
        db: createServiceRoleClient(),
        convert: onboarding.convert,
        plan,
        workspace,
        allowance: actionAllowance,
        stripePrices,
      })
    : null;

  // The setup modal's facts, only for a workspace in the new onboarding flow
  // that asked for it. The modal reads its status itself, after it loads.
  const queryOne = (key) => (typeof chatQuery[key] === 'string' ? chatQuery[key] : null);
  const setup = setupRequested && workspace && onboarding?.flow === 'new'
    ? {
        variant: clientOnboardingVariant(onboarding),
        initialClient: inferOnboardingClient({
          param: queryOne(CLIENT_INTENT_PARAM),
          stored: workspace.onboarding_client,
          acquisitionSource: workspace.acquisition_source,
          acquisitionReferrer: workspace.acquisition_referrer,
        }).client,
        provider: connectIntentSlugShape(queryOne(CONNECT_INTENT_PARAM)),
        requestedStep: isOnboardingStep(queryOne('step')) ? queryOne('step') : null,
        chatReturn,
        userEmail: user.email ?? '',
      }
    : null;

  // The 3-month Personal pass the OWNER holds, if any: Billing shows "Personal
  // until {date}" and the ways to keep it. Null for everyone else, and for a
  // member viewing someone else's workspace. Tolerant: a failed read is null.
  const passState = await loadPassBillingState(
    createServiceRoleClient(),
    user.id,
    workspace?.owner_id === user.id,
  );

  return (
    <DashboardApp
      initialRoute={initialRoute}
      user={{ displayName, email, initials, id: user.id }}
      workspace={{
        id: workspace?.id ?? '',
        slug: workspaceSlug,
        plan,
        compedScale,
        displayName: workspace?.display_name ?? workspaceSlug,
        isOwner: workspace?.owner_id === user.id,
        // The /onboarding flow for this workspace (components/dashboard/
        // OnboardingEntry.jsx): `flow`/`convert` are the arms; `finishSetup`
        // shows the "Finish setup" link (new flow, not completed, no first
        // call yet, so an internal owner's long-active workspace stays quiet
        // until it is reset); `canReset`
        // shows Settings > Reset onboarding (internal owner only).
        onboarding: {
          flow: onboarding?.flow ?? 'control',
          convert: onboarding?.convert ?? 'off',
          finishSetup: onboarding?.flow === 'new' && !workspace?.onboarding_completed_at && !workspace?.analytics_first_tool_used_at,
          canReset: onboarding?.internal === true && workspace?.owner_id === user.id,
        },
        // Onboarding Flow B facts for the Overview (flow-b-server.ts), or null.
        flowB,
        // Whether this workspace has ever made a tool call. The Overview guide
        // shows its "waiting for your first call" step only while it has not.
        firstToolUsed: Boolean(workspace?.analytics_first_tool_used_at),
        // The draft editor card, at the workspace grain. Two separate columns
        // on purpose: `draftEditorEnabled` is OUR rollout gate (internal only
        // in v1, so most workspaces see no control at all) and
        // `draftEditorHidden` is the customer's own opt-out. Conflating them
        // would mean widening the rollout un-hides the card for someone who
        // deliberately turned it off. See src/lib/drafts/editor-preference.ts.
        draftEditorEnabled: workspace?.draft_editor_enabled === true,
        draftEditorHidden: workspace?.draft_editor_hidden === true,
        // "Confirm in chat" send review: OUR rollout gate, internal only for
        // now. Without it the option is not offered (the API refuses it too).
        chatConfirmEnabled: workspace?.chat_send_confirm_enabled === true,
        // The referral program: OUR rollout gate, internal only for now.
        // Without it there is no Invite entry, tile or code field.
        referralEnabled,
        // The Pro feature gate for this workspace: { visible, allowed }.
        proFeatures: { visible: proFeatureAccess.visible, allowed: proFeatureAccess.allowed },
        // Whether the connect modal offers "Prefer to sign in with Google?"
        // for a new Gmail inbox.
        gmailOAuthAllowed: gmailOAuthAccess.allowed,
        // Black Week 2026: the offer for the billing page's switch card, or
        // null (see src/lib/stripe/seasonal-switch.ts).
        seasonalSwitch,
        // Failed-payment banner (components/dashboard/PaymentIssueBanner.jsx).
        // The owner's own subscription only: a member never sees who pays.
        subscriptionStatus: workspace?.owner_id === user.id ? ownBilling?.subscription_status ?? null : null,
        lastDeclineCode: workspace?.owner_id === user.id ? ownBilling?.last_decline_code ?? null : null,
      }}
      workspaces={workspaces}
      activeWorkspaceId={workspace?.id ?? ''}
      canCreateWorkspace={canCreateWorkspace}
      mcpUrl={mcpUrl}
      userRole={userRole}
      planLimits={planLimits}
      actionAllowance={actionAllowance}
      inboxesGrandfathered={inboxesGrandfathered}
      stripePrices={stripePrices}
      passState={passState}
      overviewStats={overviewStats}
      activityFeed={activityFeed}
      inboxes={inboxes}
      apiKeys={apiKeys}
      usageData={usageData}
      auditLog={auditLog}
      members={members}
      pendingInvites={pendingInvites}
      referralTileFacts={referralTileFacts}
      chatReturn={setup ? null : chatReturn}
      setup={setup}
      firstToolEvent={workspace?.analytics_first_tool_name && !workspace?.analytics_first_tool_reported_at ? { tool_name: workspace.analytics_first_tool_name, provider: workspace.analytics_first_tool_provider ?? 'unknown', client: workspace.analytics_first_tool_client ?? 'unknown', activation_path: workspace.analytics_first_tool_path ?? 'api_key' } : null}
    />
  );
}
