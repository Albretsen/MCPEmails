'use client';

/**
 * The interactive part of the Active accounts roster.
 *
 * Fifty-odd rows of which most are single-visit accounts is not a useful
 * default view: the interesting population is the handful that came back. So
 * the table opens filtered to accounts with more than one active day, and
 * everything else is one click away.
 *
 * Collapsed it shows exactly one page of ten and paginates in place, because
 * paging through a list is a cheaper way to look around than growing the page
 * by two thousand pixels. Expanding drops the page size and renders the whole
 * filtered set for scanning or copying.
 *
 * All of it is client-side over an array the server already fetched. There is
 * no query per keystroke and no request per page: at this scale the whole
 * roster is a few kilobytes, and round-tripping would be slower than the sort.
 */

import { useMemo, useState } from 'react';
import { formatCount, ratio } from '../charts';
import { InfoDot } from '../InfoDot';
import { STICKY_MIN_ACTIVE_DAYS, countReturned, type RosterRow } from './roster';

const PAGE_SIZE = 10;

type SortKey =
  | 'account' | 'plan' | 'last_active' | 'active_days'
  | 'sessions' | 'calls' | 'success' | 'inboxes' | 'created';

type Column = {
  key: SortKey;
  label: string;
  /** Numbers and dates read best largest-first on the first click. */
  defaultDescending: boolean;
  numeric: boolean;
  help?: React.ReactNode;
};

const COLUMNS: Column[] = [
  { key: 'account', label: 'Account', defaultDescending: false, numeric: false },
  { key: 'plan', label: 'Plan', defaultDescending: false, numeric: true },
  { key: 'last_active', label: 'Last active', defaultDescending: true, numeric: true },
  {
    key: 'active_days',
    label: 'Active days',
    defaultDescending: true,
    numeric: true,
    help: 'Distinct UTC days with a successful call, inside the selected window.',
  },
  {
    key: 'sessions',
    label: 'Sessions',
    defaultDescending: true,
    numeric: true,
    help: 'Runs of activity separated by a gap of 30 minutes or more. A long-running agent can log thousands of calls in a single session.',
  },
  { key: 'calls', label: 'Calls', defaultDescending: true, numeric: true },
  {
    key: 'success',
    label: 'Success',
    defaultDescending: true,
    numeric: true,
    help: 'Share of this account’s calls that succeeded. A low rate with high volume usually means a broken provider or a client sending bad arguments.',
  },
  { key: 'inboxes', label: 'Inboxes', defaultDescending: true, numeric: true },
  { key: 'created', label: 'Signed up', defaultDescending: true, numeric: true },
];

const DATE = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function shortDate(value: string | null) {
  return value ? DATE.format(new Date(value)) : '—';
}

function daysAgo(value: string) {
  return Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
}

/** Sort value for a row and column. Strings compare as strings, everything else as numbers. */
function sortValue(row: RosterRow, key: SortKey): string | number {
  switch (key) {
    case 'account': return (row.owner_email ?? row.workspace_name).toLowerCase();
    // Ordered by commercial interest rather than alphabetically, so a sort by
    // plan surfaces revenue: paying first and by descending price (Team, then
    // Pro, then Personal), then comped, then free. The numbers only encode
    // relative order, nothing reads them as a value.
    case 'plan': return row.is_comped ? 1 : row.plan === 'pro' ? 4 : row.plan === 'solo' ? 3 : row.plan === 'personal' ? 2 : 0;
    case 'last_active': return new Date(row.last_active_at).getTime();
    case 'active_days': return row.active_days;
    case 'sessions': return row.sessions;
    case 'calls': return row.calls;
    case 'success': return row.calls > 0 ? row.successes / row.calls : -1;
    case 'inboxes': return row.inboxes;
    case 'created': return new Date(row.created_at).getTime();
  }
}

export function ActiveAccountsTable({ rows }: { rows: RosterRow[] }) {
  const [stickyOnly, setStickyOnly] = useState(true);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: 'last_active', descending: true });
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState(false);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      if (stickyOnly && row.active_days < STICKY_MIN_ACTIVE_DAYS) return false;
      if (!needle) return true;
      return [row.owner_email, row.workspace_name, row.providers, row.plan]
        .some((field) => field?.toLowerCase().includes(needle));
    });
    const column = COLUMNS.find((entry) => entry.key === sort.key);
    return [...filtered].sort((left, right) => {
      const a = sortValue(left, sort.key);
      const b = sortValue(right, sort.key);
      const comparison = typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b) : Number(a) - Number(b);
      // A stable tiebreak keeps rows from shuffling between renders when the
      // sorted column has ties, which it often does at these small numbers.
      if (comparison !== 0) return sort.descending ? -comparison : comparison;
      return left.workspace_id.localeCompare(right.workspace_id);
    }).map((row) => ({ row, numeric: column?.numeric ?? true }));
  }, [rows, stickyOnly, query, sort]);

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const shown = expanded ? visible : visible.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);

  /** Any control that changes the result set sends you back to the first page. */
  function reset<T>(setter: (value: T) => void) {
    return (value: T) => { setter(value); setPage(0); };
  }

  function toggleSort(column: Column) {
    setSort((current) => current.key === column.key
      ? { key: column.key, descending: !current.descending }
      : { key: column.key, descending: column.defaultDescending });
    setPage(0);
  }

  return (
    <>
      <div className="growth-controls">
        <div className="growth-segment" role="group" aria-label="Account filter">
          <button
            type="button"
            aria-pressed={stickyOnly}
            onClick={() => reset(setStickyOnly)(true)}
          >
            Returned ({countReturned(rows)})
          </button>
          <button
            type="button"
            aria-pressed={!stickyOnly}
            onClick={() => reset(setStickyOnly)(false)}
          >
            All ({rows.length})
          </button>
        </div>

        <InfoDot label="Returned filter">
          <strong>Returned</strong> means active on more than one day in the window. It is the default
          because a roster dominated by accounts that tried the product once and left says very little.
          Switch to <strong>All</strong> to see everyone, including single-visit accounts.
        </InfoDot>

        <input
          type="search"
          className="growth-search"
          placeholder="Search email, workspace or provider"
          value={query}
          onChange={(event) => reset(setQuery)(event.target.value)}
          aria-label="Search accounts"
        />

        <span className="growth-controls-count">
          {visible.length === 0
            ? 'No matching accounts'
            : expanded
              ? `${visible.length} account${visible.length === 1 ? '' : 's'}`
              : `${currentPage * PAGE_SIZE + 1}–${Math.min(visible.length, (currentPage + 1) * PAGE_SIZE)} of ${visible.length}`}
        </span>
      </div>

      <div className={`growth-table-wrap${expanded ? '' : ' is-paged'}`}>
        <table className="growth-table growth-table-roster">
          <thead>
            <tr>
              {COLUMNS.map((column) => {
                const active = sort.key === column.key;
                return (
                  <th
                    key={column.key}
                    aria-sort={active ? (sort.descending ? 'descending' : 'ascending') : 'none'}
                  >
                    <span className={`growth-th${column.numeric ? ' is-numeric' : ''}`}>
                      <button
                        type="button"
                        className={`growth-sort${active ? ' is-active' : ''}`}
                        onClick={() => toggleSort(column)}
                      >
                        {column.label}
                        <span aria-hidden="true" className="growth-sort-arrow">
                          {active ? (sort.descending ? '▾' : '▴') : '↕'}
                        </span>
                      </button>
                      {column.help && <InfoDot label={column.label} align="end">{column.help}</InfoDot>}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr><td className="growth-empty" colSpan={COLUMNS.length}>
                {rows.length === 0 ? 'No successful calls in this window.' : 'No accounts match this filter.'}
              </td></tr>
            )}
            {shown.map(({ row }) => (
              // Only internal accounts recede. A comped account is a real user
              // on a free plan, and greying it out hid the people most worth
              // watching.
              <tr key={row.workspace_id} className={row.is_internal ? 'is-muted' : undefined}>
                <td>
                  <span className="growth-account">{row.owner_email ?? 'unknown owner'}</span>
                  <span className="growth-account-sub">
                    {row.workspace_name}
                    {row.providers && ` · ${row.providers}`}
                  </span>
                </td>
                <td style={{ textAlign: 'right' }}>
                  {row.is_internal && <span className="growth-tag is-internal">internal</span>}
                  {row.is_comped
                    ? <span className="growth-tag is-comped">comped</span>
                    : <span className="growth-tag">{row.plan === 'pro' ? 'Team' : row.plan === 'solo' ? 'Pro' : row.plan === 'personal' ? 'Personal' : 'Free'}</span>}
                </td>
                <td>{daysAgo(row.last_active_at) === 0 ? 'today' : `${daysAgo(row.last_active_at)}d ago`}</td>
                <td>{row.active_days}</td>
                <td>{formatCount(row.sessions)}</td>
                <td>{formatCount(row.calls)}</td>
                <td>{ratio(row.successes, row.calls)}</td>
                <td>{row.inboxes}</td>
                <td>{shortDate(row.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="growth-pager">
        {!expanded && (
          <>
            <button type="button" className="growth-page-btn" onClick={() => setPage((value) => Math.max(0, value - 1))} disabled={currentPage === 0}>
              Previous
            </button>
            <span className="growth-page-status">Page {currentPage + 1} of {pageCount}</span>
            <button type="button" className="growth-page-btn" onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))} disabled={currentPage >= pageCount - 1}>
              Next
            </button>
          </>
        )}
        <button type="button" className="growth-link" onClick={() => { setExpanded((value) => !value); setPage(0); }}>
          {expanded ? 'Collapse to one page' : `Expand all ${visible.length} row${visible.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </>
  );
}
