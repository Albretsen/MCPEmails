/**
 * Sorting, segmenting and paging for the user directory: pure functions, no
 * Supabase import, unit tested in user-table.test.ts.
 *
 * WHY THIS IS NOT SQL. At four hundred people the whole table is smaller than
 * one chart on the growth board and it is cached for ten minutes, so a sort is
 * a millisecond either way. What SQL costs is a dynamic ORDER BY, which is a
 * twelve-branch CASE or a concatenated string, and neither can be tested
 * without a database. The day this table is thousands long the RPC grows a
 * sort key and this module keeps its shape; `total_rows` on every row is the
 * tripwire that says the day has come.
 *
 * ONE DEFINITION OF A COLUMN. `COLUMNS` carries the label, the alignment, the
 * sort value and the default direction together, and the page's header row is
 * generated from it. A column whose header sorts by a different field than the
 * cell shows is the classic table bug, and it is unrepresentable here.
 */

import type { UserDirectoryRow } from '@/lib/analytics/user-directory';

/** What a cell sorts by. Strings compare case-insensitively; nulls sink. */
type SortValue = number | string | null;

export type UserColumn = {
  key: string;
  /** Header text. Kept short: this table is wide and every column is scanned. */
  label: string;
  /** Longer form for the header's title attribute, where the label is terse. */
  hint: string;
  numeric: boolean;
  /**
   * True when the FIRST click should sort descending. Counts and dates are
   * interesting at their largest; names are interesting alphabetically.
   */
  descFirst: boolean;
  value: (row: UserDirectoryRow) => SortValue;
};

/**
 * Rate columns need a floor before a percentage means anything: 1 of 1 is not a
 * better success rate than 900 of 1000, and sorting on it puts every one-call
 * account above every real one. Below the floor the row sorts as unknown.
 */
const MIN_CALLS_FOR_RATE = 10;

export const COLUMNS: UserColumn[] = [
  { key: 'email', label: 'Person', hint: 'Email address, and display name where they set one', numeric: false, descFirst: false, value: (r) => r.email },
  { key: 'signed_up', label: 'Signed up', hint: 'users.created_at, all-time', numeric: true, descFirst: true, value: (r) => Date.parse(r.signed_up_at) },
  { key: 'plan', label: 'Plan', hint: 'Best plan across the workspaces they own', numeric: false, descFirst: true, value: (r) => planRank(r) },
  { key: 'status', label: 'Stage', hint: 'How far they got: signed up, connected, activated, paying', numeric: false, descFirst: true, value: (r) => stageRank(r) },
  { key: 'workspaces', label: 'Wksp', hint: 'Live workspaces they own, plus seats on other people’s', numeric: true, descFirst: true, value: (r) => r.workspaces * 100 + r.memberships },
  { key: 'inboxes', label: 'Inbox', hint: 'Connected mailboxes that are currently active', numeric: true, descFirst: true, value: (r) => r.inboxes },
  { key: 'provider', label: 'Provider', hint: 'Which mail providers those mailboxes are on', numeric: false, descFirst: false, value: (r) => r.providers },
  { key: 'keys', label: 'Keys', hint: 'Live API keys across their workspaces', numeric: true, descFirst: true, value: (r) => r.api_keys },
  { key: 'calls', label: 'Calls', hint: 'Tool calls in the window. activity_log is purged at 90 days', numeric: true, descFirst: true, value: (r) => r.calls },
  { key: 'success', label: 'OK', hint: `Share of those calls that succeeded, blank under ${MIN_CALLS_FOR_RATE} calls`, numeric: true, descFirst: true, value: (r) => (r.calls >= MIN_CALLS_FOR_RATE ? r.successes / r.calls : null) },
  { key: 'days', label: 'Days', hint: 'Distinct UTC days with a successful call, in the window', numeric: true, descFirst: true, value: (r) => r.active_days },
  { key: 'last_active', label: 'Last call', hint: 'Most recent tool call in the window', numeric: true, descFirst: true, value: (r) => parse(r.last_active_at) },
  { key: 'paywall', label: 'Cap', hint: 'Times the action cap rejected a call, all-time', numeric: true, descFirst: true, value: (r) => r.paywall_hits },
  { key: 'source', label: 'Source', hint: 'Acquisition channel recorded at signup', numeric: false, descFirst: false, value: (r) => channel(r) },
];

const COLUMN_BY_KEY = new Map(COLUMNS.map((column) => [column.key, column]));

/** The column a bare `/admin/growth/users` sorts on. */
export const DEFAULT_SORT = 'signed_up';

export function resolveColumn(key: string | undefined): UserColumn {
  return COLUMN_BY_KEY.get(key ?? '') ?? COLUMN_BY_KEY.get(DEFAULT_SORT)!;
}

/**
 * The plan ladder. `personal` is the only id whose display name matches it:
 * `solo` is sold as Pro and `pro` is sold as Team, which is a naming trap the
 * whole codebase carries. Comped sorts BELOW free on purpose -- it is the one
 * state an operator wants pushed out of the way when reading the plan column,
 * because it is a paid plan id that earns nothing.
 */
const PLAN_RANK: Record<string, number> = { free: 1, personal: 2, solo: 3, pro: 4, enterprise: 5 };

function planRank(row: UserDirectoryRow): number {
  if (row.is_comped) return 0;
  return PLAN_RANK[row.plan] ?? 1;
}

/**
 * How far down the funnel they got, as one ordinal, so the column sorts into
 * the funnel's own order rather than alphabetically.
 */
export function stageRank(row: UserDirectoryRow): number {
  if (row.plan !== 'free' && !row.is_comped) return 5;
  if (row.value_activated_at) return 4;
  if (row.first_tool_used_at) return 3;
  if (row.api_keys > 0 || row.first_credential_created_at) return 2;
  if (row.inboxes > 0 || row.first_inbox_connected_at) return 1;
  return 0;
}

/**
 * The rungs, in the order `growth_activation_funnel` puts them: a mailbox is
 * connected BEFORE a credential is issued. The connect flow is mailbox-first
 * and has been since launch, and a ladder that put the key first drew an
 * out-of-order arrow on nearly every account that had both.
 */
export const STAGE_LABELS = [
  'signed up',
  'connected',
  'has a key',
  'called a tool',
  'activated',
  'paying',
] as const;

export function stageLabel(row: UserDirectoryRow): string {
  return STAGE_LABELS[stageRank(row)];
}

/**
 * The acquisition channel, in one string.
 *
 * Roughly 55% of these are NULL and no amount of coalescing changes that (the
 * 2026-08-31 fix shipped and did not move the number), so an unknown source
 * says so rather than being folded into 'direct' -- which would make the
 * largest bucket on the page a guess.
 */
export function channel(row: UserDirectoryRow): string | null {
  return row.acquisition_utm_source ?? row.acquisition_source ?? host(row.acquisition_referrer);
}

function host(referrer: string | null): string | null {
  if (!referrer) return null;
  try {
    return new URL(referrer).hostname.replace(/^www\./, '');
  } catch {
    return referrer;
  }
}

function parse(value: string | null): number | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

/**
 * A named slice of the directory.
 *
 * `all` excludes our own accounts, matching the one agreed definition of "how
 * many people have signed up" (see 20260907170000): a page whose default view
 * counts the synthetic monitor as a customer is a page that has to be
 * re-explained every time somebody reads it.
 */
export type Segment = {
  key: string;
  label: string;
  hint: string;
  match: (row: UserDirectoryRow) => boolean;
};

export const SEGMENTS: Segment[] = [
  { key: 'all', label: 'Everyone', hint: 'Every person who has signed up, our own accounts excluded', match: (r) => !r.is_internal },
  { key: 'paying', label: 'Paying', hint: 'On a paid plan and not on a 100% off coupon', match: (r) => !r.is_internal && r.plan !== 'free' && !r.is_comped },
  { key: 'activated', label: 'Activated', hint: 'Reached value activation: real mailbox work, not just a connection', match: (r) => !r.is_internal && r.value_activated_at !== null },
  { key: 'connected', label: 'Connected', hint: 'At least one mailbox connected and active right now', match: (r) => !r.is_internal && r.inboxes > 0 },
  { key: 'active', label: 'Active', hint: 'Made at least one tool call inside the window', match: (r) => !r.is_internal && r.calls > 0 },
  { key: 'dormant', label: 'Gone quiet', hint: 'Connected a mailbox once and has made no call in the window', match: (r) => !r.is_internal && r.first_inbox_connected_at !== null && r.calls === 0 },
  { key: 'cold', label: 'Never started', hint: 'Signed up and never connected a mailbox', match: (r) => !r.is_internal && r.inboxes === 0 && r.first_inbox_connected_at === null },
  { key: 'broken', label: 'Broken', hint: 'Holds a mailbox that is no longer in an active state', match: (r) => !r.is_internal && r.inboxes_broken > 0 },
  { key: 'capped', label: 'Hit the cap', hint: 'The action cap has rejected at least one of their calls', match: (r) => !r.is_internal && r.paywall_hits > 0 },
  { key: 'comped', label: 'Comped', hint: 'A real person on a 100% off coupon. Contributes nothing to MRR', match: (r) => r.is_comped },
  { key: 'internal', label: 'Ours', hint: 'Accounts we operate ourselves, excluded from every other view', match: (r) => r.is_internal },
];

const SEGMENT_BY_KEY = new Map(SEGMENTS.map((segment) => [segment.key, segment]));

export function resolveSegment(key: string | undefined): Segment {
  return SEGMENT_BY_KEY.get(key ?? '') ?? SEGMENTS[0];
}

/**
 * Free-text match across the fields somebody would actually paste in: the
 * address, the name, the workspace, the provider, the channel and the Stripe
 * customer id. Case-insensitive substring, because the realistic query is half
 * a domain remembered from an email.
 */
export function matchesQuery(row: UserDirectoryRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    row.email,
    row.display_name,
    row.primary_workspace_name,
    row.primary_workspace_slug,
    row.providers,
    channel(row),
    row.acquisition_landing_path,
    row.stripe_customer_id,
    row.plan,
  ];
  return haystack.some((field) => field !== null && field !== undefined && field.toLowerCase().includes(needle));
}

/**
 * Sort by one column, then by signup date as the tiebreak.
 *
 * NULLS ALWAYS SINK, in both directions. A person with no last call has no
 * position on a "last call" axis, and floating them to the top of a descending
 * sort would bury the answer the sort was asked for under three hundred blanks.
 */
export function sortRows(rows: UserDirectoryRow[], column: UserColumn, desc: boolean): UserDirectoryRow[] {
  const direction = desc ? -1 : 1;
  return [...rows].sort((a, b) => {
    const left = column.value(a);
    const right = column.value(b);
    if (left === null && right === null) return tiebreak(a, b);
    if (left === null) return 1;
    if (right === null) return -1;
    const compared =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right), 'en', { sensitivity: 'base' });
    if (compared !== 0) return compared * direction;
    return tiebreak(a, b);
  });
}

/** Newest signup first, so equal rows keep one stable, meaningful order. */
function tiebreak(a: UserDirectoryRow, b: UserDirectoryRow): number {
  return Date.parse(b.signed_up_at) - Date.parse(a.signed_up_at);
}

export type Page<T> = { rows: T[]; page: number; pages: number; total: number; from: number; to: number };

/**
 * One page of rows, clamped so a stale `?page=` from a bookmark lands on the
 * last real page rather than on an empty table.
 */
export function paginate<T>(rows: T[], page: number, size: number): Page<T> {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pages);
  const from = (current - 1) * size;
  const slice = rows.slice(from, from + size);
  return {
    rows: slice,
    page: current,
    pages,
    total: rows.length,
    from: rows.length === 0 ? 0 : from + 1,
    to: from + slice.length,
  };
}

/** Headline counts for the strip above the table, computed from what is shown. */
export function summarise(rows: UserDirectoryRow[]) {
  const paying = rows.filter((row) => row.plan !== 'free' && !row.is_comped).length;
  const connected = rows.filter((row) => row.inboxes > 0).length;
  const activated = rows.filter((row) => row.value_activated_at !== null).length;
  const active = rows.filter((row) => row.calls > 0).length;
  return {
    people: rows.length,
    connected,
    activated,
    active,
    paying,
    inboxes: rows.reduce((total, row) => total + row.inboxes, 0),
    calls: rows.reduce((total, row) => total + row.calls, 0),
  };
}
