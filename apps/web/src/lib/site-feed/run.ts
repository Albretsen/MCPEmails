/**
 * The two albretsen.no feed jobs, run by /api/internal/site-feed/dispatch.
 *
 * Both are pg_cron driven (20261026090000_schedule_site_feed.sql, and
 * 20261026100000_site_feed_emails_handled.sql for the figure) and read what
 * already happened; nothing on the product's request path knows the feed
 * exists, so it can never slow or break a tool call. Both return a small
 * summary with no figures, ids or text in it, and never throw.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';
import { internalAccountMatchers, isInternalAccount } from '@/lib/analytics/internal-accounts';
import { siteRequest, type SiteClientOptions } from './client.ts';
import { FIGURE_LABEL, SITE_FEED_PRODUCT, decideFigure, displayEmailsHandled, readSiteFigure } from './figure.ts';
import {
  FEED_TOOL_NAMES,
  OUTBOUND_TOOL_NAMES,
  feedKind,
  feedWindow,
  selectFeedEvents,
  toFeedEvent,
  type FeedSourceRow,
} from './events.ts';

type Db = SupabaseClient<Database>;

export type JobSummary = Record<string, string | number | boolean>;

// ---------------------------------------------------------------------------
// Emails handled
// ---------------------------------------------------------------------------

export async function runFigureJob(deps: {
  key: string;
  /** site_feed_emails_handled(): emails handled, external workspaces only. */
  loadEmailsHandled: () => Promise<number>;
  nowMs: number;
  client?: SiteClientOptions;
}): Promise<JobSummary> {
  let count: number;
  try {
    count = await deps.loadEmailsHandled();
  } catch (err) {
    console.error('[site-feed] emails handled read failed', { error: err instanceof Error ? err.message : String(err) });
    return { job: 'figure', posted: false, reason: 'read_failed' };
  }
  const value = displayEmailsHandled(count);
  if (value === null) return { job: 'figure', posted: false, reason: 'refused_too_small' };

  // Without the site's current figure the never-decrease rule cannot be kept,
  // so a failed GET skips this run; the next one tries again.
  const current = await siteRequest('/api/figures', { method: 'GET' }, deps.client);
  if (!current.ok) return { job: 'figure', posted: false, reason: 'site_read_failed', status: current.status };
  const decision = decideFigure(readSiteFigure(current.body), value, deps.nowMs);
  if (decision !== 'post') return { job: 'figure', posted: false, reason: decision };

  const posted = await siteRequest(
    '/api/figures',
    { method: 'POST', key: deps.key, json: { product: SITE_FEED_PRODUCT, label: FIGURE_LABEL, value } },
    deps.client,
  );
  return posted.ok
    ? { job: 'figure', posted: true }
    : { job: 'figure', posted: false, reason: 'site_rejected', status: posted.status };
}

/**
 * The count, in SQL (one pass over action_usage and bulk_runs, so the 1000
 * row cap does not apply). GROWTH_INTERNAL_EMAILS is passed in because the
 * database only knows `public.internal_accounts`. Throws on an error or a
 * non-numeric answer; runFigureJob turns that into a summary.
 */
export async function loadEmailsHandled(db: Db): Promise<number> {
  const { data, error } = await db.rpc('site_feed_emails_handled', {
    p_internal_emails: internalAccountMatchers().emails,
  });
  if (error) throw new Error(error.message);
  const count = Number(data);
  if (data === null || !Number.isFinite(count)) throw new Error('site_feed_emails_handled returned no number');
  return count;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Row caps per query. The outbound query is separate so reads cannot crowd it out. */
const ACTIVITY_LIMIT = 200;
const OUTBOUND_LIMIT = 50;
const INBOX_LIMIT = 50;
/** Workspace ids per `in` filter, to keep the request URL short. */
const ID_CHUNK = 100;

type Candidate = { kind: string; at: string; workspaceId: string; row: FeedSourceRow };

export async function runEventsJob(deps: {
  key: string;
  db: Db;
  nowMs: number;
  random?: () => number;
  client?: SiteClientOptions;
}): Promise<JobSummary> {
  const { db } = deps;
  const { start, end } = feedWindow(deps.nowMs);

  let candidates: Candidate[];
  try {
    candidates = await loadCandidates(db, start, end);
  } catch (err) {
    console.error('[site-feed] events read failed', { error: err instanceof Error ? err.message : String(err) });
    return { job: 'events', posted: 0, reason: 'read_failed' };
  }
  if (candidates.length === 0) return { job: 'events', candidates: 0, posted: 0 };

  let external: Candidate[];
  let countryOf: Map<string, string | null>;
  try {
    const owners = await loadWorkspaceFacts(db, [...new Set(candidates.map((c) => c.workspaceId))]);
    countryOf = new Map([...owners].map(([id, facts]) => [id, facts.country]));
    // A workspace the lookup did not return is dropped too: unknown is not external.
    external = candidates.filter((c) => owners.get(c.workspaceId)?.internal === false);
  } catch (err) {
    console.error('[site-feed] workspace read failed', { error: err instanceof Error ? err.message : String(err) });
    return { job: 'events', posted: 0, reason: 'read_failed' };
  }

  external.sort((a, b) => a.at.localeCompare(b.at));
  const selected = selectFeedEvents(external, { random: deps.random });
  const shared = await countryCounts(db, selected.map((c) => countryOf.get(c.workspaceId) ?? null));

  let posted = 0;
  let failed = 0;
  for (const candidate of selected) {
    const country = countryOf.get(candidate.workspaceId) ?? null;
    const event = toFeedEvent(candidate.row, {
      country,
      countryWorkspaces: country ? shared.get(country) ?? 0 : 0,
    });
    if (!event) continue;
    const response = await siteRequest('/api/events', { method: 'POST', key: deps.key, json: event }, deps.client);
    if (response.ok) {
      posted += 1;
      continue;
    }
    failed += 1;
    if (response.status === 401 || response.status === 403) {
      // A wrong or revoked key will not get better within this run.
      return { job: 'events', candidates: external.length, posted, failed, reason: 'unauthorised' };
    }
  }
  return { job: 'events', candidates: external.length, posted, failed };
}

async function loadCandidates(db: Db, start: string, end: string): Promise<Candidate[]> {
  const others = FEED_TOOL_NAMES.filter((name) => !OUTBOUND_TOOL_NAMES.includes(name));
  const activity = (tools: readonly string[], limit: number) =>
    db
      .from('activity_log')
      .select('tool_name, duration_ms, workspace_id, created_at')
      .eq('status', 'success')
      .in('tool_name', [...tools])
      .gte('created_at', start)
      .lt('created_at', end)
      .order('created_at', { ascending: true })
      .limit(limit);
  const [outbound, rest, inboxes] = await Promise.all([
    activity(OUTBOUND_TOOL_NAMES, OUTBOUND_LIMIT),
    activity(others, ACTIVITY_LIMIT),
    db
      .from('inboxes')
      .select('workspace_id, created_at')
      .gte('created_at', start)
      .lt('created_at', end)
      .order('created_at', { ascending: true })
      .limit(INBOX_LIMIT),
  ]);
  for (const result of [outbound, rest, inboxes]) {
    if (result.error) throw new Error(result.error.message);
  }

  const candidates: Candidate[] = [];
  for (const r of [...(outbound.data ?? []), ...(rest.data ?? [])]) {
    const row: FeedSourceRow = { source: 'activity_log', tool_name: r.tool_name, duration_ms: r.duration_ms };
    const kind = feedKind(row);
    if (kind) candidates.push({ kind, at: r.created_at, workspaceId: r.workspace_id, row });
  }
  for (const r of inboxes.data ?? []) {
    const row: FeedSourceRow = { source: 'inboxes' };
    const kind = feedKind(row);
    if (kind) candidates.push({ kind, at: r.created_at, workspaceId: r.workspace_id, row });
  }
  return candidates;
}

type WorkspaceFacts = { internal: boolean; country: string | null };

/**
 * Whether each workspace is ours, and its acquisition country.
 *
 * Internal means the owner's address is one of ours: an internal domain,
 * GROWTH_INTERNAL_EMAILS, or a row of `public.internal_accounts`, each
 * plus-tag-insensitive (internal-accounts.ts). The synthetic monitor's
 * workspace is owned by such an address, which is how it is excluded.
 */
async function loadWorkspaceFacts(db: Db, ids: string[]): Promise<Map<string, WorkspaceFacts>> {
  const listed = await db.from('internal_accounts').select('email');
  if (listed.error) throw new Error(listed.error.message);
  const extra = new Set((listed.data ?? []).map((row) => row.email.trim().toLowerCase()));

  const facts = new Map<string, WorkspaceFacts>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await db
      .from('workspaces')
      .select('id, acquisition_country, users!workspaces_owner_id_fkey(email)')
      .in('id', ids.slice(i, i + ID_CHUNK));
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      const owner = row.users as { email: string | null } | { email: string | null }[] | null;
      const email = Array.isArray(owner) ? owner[0]?.email ?? null : owner?.email ?? null;
      facts.set(row.id, {
        // No owner address at all is treated as ours: it cannot be checked.
        internal: email === null || isInternalAccount(email, extra),
        country: row.acquisition_country,
      });
    }
  }
  return facts;
}

/**
 * How many workspaces share each country, counted in SQL (`count: exact`,
 * head only, so no rows are fetched and the 1000 row cap does not apply). At
 * most MAX_EVENTS_PER_RUN countries per run. A failed count reads as 0, which
 * omits the country rather than risking it.
 */
async function countryCounts(db: Db, countries: (string | null)[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const country of new Set(countries)) {
    if (!country || !/^[A-Z]{2}$/.test(country)) continue;
    const { count, error } = await db
      .from('workspaces')
      .select('id', { count: 'exact', head: true })
      .eq('acquisition_country', country);
    counts.set(country, error ? 0 : count ?? 0);
  }
  return counts;
}
