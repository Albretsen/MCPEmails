/**
 * /admin/growth/users: every person who has signed up, one row each.
 *
 * WHY THIS PAGE EXISTS. The growth board answers "how is the business doing"
 * and answers it, deliberately, almost entirely in aggregates. Its one roster
 * lists WORKSPACES that made a call in the last N days, so the 40% of signups
 * who never make a call appear nowhere on it at all -- and they are the
 * majority of the funnel and the whole of the growth problem. Every question of
 * the form "who is this address", "did that Gmail connection ever succeed",
 * "what did the customer who bought on Tuesday do first" has been answered by
 * hand-written SQL since launch. This is that SQL with a header row.
 *
 * IT IS A TABLE AND IT LOOKS LIKE ONE. No cards, no sparklines per row, no
 * avatars. A directory is read one row at a time with an eye running down a
 * column, and every decoration added to a row costs vertical space that could
 * have been another person. The one piece of chart on the page is the summary
 * strip, because the counts it carries are the denominators for everything
 * below it.
 *
 * EVERY CONTROL IS A LINK OR A GET FORM, so every state of this table has a
 * URL: a sort, a segment, a search and a page can all be bookmarked or pasted
 * into a message. See chrome.tsx for the second reason.
 *
 * PRIVACY. This is the widest identity surface in the product: it names every
 * customer, their mail provider and where they came from. It sits behind the
 * ADMIN_EMAILS session, it returns no credential, token, message content,
 * subject, recipient, IP address or user agent, and the kiosk -- which hangs on
 * a wall behind a shared token -- must never gain a link to it.
 */

import { Suspense } from 'react';
import Link from 'next/link';
import { requireAdmin } from '@/lib/admin/require-admin';
import { fetchUserDirectory, USER_WINDOW_DAYS, type UserDirectoryRow } from '@/lib/analytics/user-directory';
import {
  COLUMNS,
  channel,
  matchesQuery,
  paginate,
  resolveColumn,
  resolveSegment,
  SEGMENTS,
  sortRows,
  stageLabel,
  stageRank,
  summarise,
  type UserColumn,
} from '@/lib/analytics/user-table';
import { agoLabel, formatDayKey } from '@/lib/analytics/growth-records';
import { formatCount, formatPercent, NO_DATA } from '../../../../components/admin/charts/format';
import { Dead } from '../../../../components/admin/growth/Dead';
import { Chrome, PAGE_SIZES, readQuery, usersHref, type UsersQuery } from '../../../../components/admin/users/chrome';
import '../../../../styles/admin-board.css';
import '../../../../styles/admin-kiosk.css';
import '../../../../styles/admin-growth.css';
import '../../../../styles/admin-users.css';

export const metadata = { title: 'People · MCP Emails', robots: { index: false, follow: false } };

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  const query = readQuery(await searchParams);

  return (
    <div className="gb us">
      <main className="gb-inner">
        <Chrome trail={<span className="us-crumb">People</span>} />
        <Suspense fallback={<p className="us-loading">Reading the directory…</p>}>
          <Directory query={query} />
        </Suspense>
      </main>
    </div>
  );
}

async function Directory({ query }: { query: UsersQuery }) {
  const result = await fetchUserDirectory(USER_WINDOW_DAYS);
  if (!result.ok) return <Dead what="The people directory" error={result.error} />;

  const everyone = result.data;
  const segment = resolveSegment(query.segment);
  const column = resolveColumn(query.sort);

  const inSegment = everyone.filter(segment.match);
  const found = query.q.trim() ? inSegment.filter((row) => matchesQuery(row, query.q)) : inSegment;
  const sorted = sortRows(found, column, query.dir === 'desc');
  const page = paginate(sorted, query.page, query.size);
  const summary = summarise(found);

  // The RPC caps its own read, so a directory longer than the cap would arrive
  // silently short. `total_rows` is computed before that LIMIT, which is the
  // only way this page can tell the difference between "412 people" and "the
  // first 412 of some larger number".
  const claimed = everyone[0]?.total_rows ?? everyone.length;
  const truncated = claimed > everyone.length;

  return (
    <>
      <div className="gb-grid">
        <section className="gb-cell gb-w12 us-summary">
          <div className="gb-strip us-strip">
            <Stat label="People" value={formatCount(summary.people)} note={segment.label.toLowerCase()} />
            <Stat label="Connected" value={formatCount(summary.connected)} note={share(summary.connected, summary.people)} />
            <Stat label="Activated" value={formatCount(summary.activated)} note={share(summary.activated, summary.people)} />
            <Stat label="Paying" value={formatCount(summary.paying)} note={share(summary.paying, summary.people)} />
            <Stat label="Mailboxes" value={formatCount(summary.inboxes)} note="connected and active" />
            <Stat label="Calls" value={formatCount(summary.calls)} note={`last ${USER_WINDOW_DAYS} days`} />
          </div>
        </section>
      </div>

      <nav className="us-segments" aria-label="Segment">
        {SEGMENTS.map((option) => {
          const count = everyone.filter(option.match).length;
          return (
            <a
              key={option.key}
              href={usersHref(query, { segment: option.key, page: 1 })}
              aria-current={option.key === segment.key ? 'true' : undefined}
              title={option.hint}
            >
              {option.label}
              <b>{formatCount(count)}</b>
            </a>
          );
        })}
      </nav>

      <form className="us-search" method="GET" action="/admin/growth/users">
        {/* The other query state travels as hidden fields, or searching would
            silently reset the segment and the sort the reader had chosen. */}
        <input type="hidden" name="segment" value={segment.key} />
        <input type="hidden" name="sort" value={column.key} />
        <input type="hidden" name="dir" value={query.dir} />
        <input type="hidden" name="size" value={String(query.size)} />
        <input
          type="search"
          name="q"
          defaultValue={query.q}
          placeholder="Address, name, workspace, provider, channel, Stripe id"
          aria-label="Search people"
        />
        <button type="submit">Search</button>
        {query.q.trim() && (
          <a className="us-clear" href={usersHref(query, { q: '', page: 1 })}>
            Clear
          </a>
        )}
        <span className="us-count">
          {page.total === 0
            ? 'nobody matches'
            : `${formatCount(page.from)}–${formatCount(page.to)} of ${formatCount(page.total)}`}
        </span>
      </form>

      {page.total === 0 ? (
        <p className="us-empty">
          Nobody in <b>{segment.label}</b>
          {query.q.trim() ? ` matches “${query.q.trim()}”` : ''}.
        </p>
      ) : (
        <div className="us-scroll">
          <table className="us-table">
            <thead>
              <tr>
                {COLUMNS.map((option) => (
                  <Header key={option.key} column={option} query={query} active={option.key === column.key} />
                ))}
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row) => (
                <Row key={row.user_id} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager query={query} page={page.page} pages={page.pages} />

      <p className="gb-foot">
        One row per person in <code>public.users</code>, which is the one agreed definition of &ldquo;signed
        up&rdquo;: a workspace deleted is still a person, and two workspaces are not two people. Calls, days
        and the success rate are counted over the last {USER_WINDOW_DAYS} days because <code>activity_log</code>{' '}
        is purged there; every other date is durable and all-time. Usage is attributed to the workspace OWNER,
        so a member of somebody else&rsquo;s workspace reads zero calls even when they made them &mdash; the
        log records the workspace a key belonged to and not the person holding it. UTC throughout, cached ten
        minutes.
        {truncated && (
          <>
            {' '}
            <b>
              This read returned {formatCount(everyone.length)} of {formatCount(claimed)} people and is
              truncated.
            </b>
          </>
        )}
      </p>
    </>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="gb-stat">
      <p className="gb-stat-label">{label}</p>
      <div className="gb-stat-row">
        <span className="gb-stat-value">{value}</span>
      </div>
      <span className="gb-stat-note">{note}</span>
    </div>
  );
}

/** A share, withheld when the denominator is too small to carry a percentage. */
function share(part: number, whole: number): string {
  if (whole < 10) return `of ${formatCount(whole)}`;
  return `${formatPercent(part / whole)} of ${formatCount(whole)}`;
}

/**
 * A sortable header.
 *
 * Clicking the column already sorted flips it; clicking any other starts at
 * that column's own natural direction, which for a count or a date is largest
 * first. A table that always starts ascending makes every count column need two
 * clicks to say anything.
 */
function Header({ column, query, active }: { column: UserColumn; query: UsersQuery; active: boolean }) {
  const dir = active ? (query.dir === 'desc' ? 'asc' : 'desc') : column.descFirst ? 'desc' : 'asc';
  return (
    <th
      scope="col"
      className={`${column.numeric ? 'is-num' : ''}${active ? ' is-sorted' : ''}`}
      aria-sort={active ? (query.dir === 'desc' ? 'descending' : 'ascending') : 'none'}
    >
      <a href={usersHref(query, { sort: column.key, dir, page: 1 })} title={column.hint}>
        {column.label}
        <i aria-hidden="true">{active ? (query.dir === 'desc' ? '▾' : '▴') : ''}</i>
      </a>
    </th>
  );
}

function Row({ row }: { row: UserDirectoryRow }) {
  const rate = row.calls >= 10 ? formatPercent(row.successes / row.calls) : NO_DATA;
  const source = channel(row);
  return (
    <tr className={row.is_internal ? 'is-quiet' : undefined}>
      <th scope="row" className="us-person">
        <Link href={`/admin/growth/users/${row.user_id}`}>{row.email}</Link>
        <span>
          {/* Signup derives a display name from the address, so for most people
              it is the local part again. Printing it twice is four hundred rows
              of noise; printing it when they have actually set one is useful. */}
          {row.display_name && row.display_name !== row.email.split('@')[0] ? row.display_name : null}
          {row.is_internal && <em className="us-tag is-quiet">ours</em>}
          {row.is_comped && <em className="us-tag is-warn">comped</em>}
          {row.grandfathered && <em className="us-tag">grandfathered</em>}
          {row.unsubscribed_at && <em className="us-tag is-quiet">unsubscribed</em>}
        </span>
      </th>
      <td className="is-num" title={row.signed_up_at}>
        {formatDayKey(row.signed_up_at.slice(0, 10))}
      </td>
      <td className="us-text">{row.is_comped ? `${row.plan} (comped)` : row.plan}</td>
      <td className="us-text">
        <span className={`us-stage is-s${stageRank(row)}`}>{stageLabel(row)}</span>
      </td>
      <td className="is-num">
        {formatCount(row.workspaces)}
        {row.memberships > 0 && <span className="us-plus">+{formatCount(row.memberships)}</span>}
      </td>
      <td className="is-num">
        {formatCount(row.inboxes)}
        {row.inboxes_broken > 0 && <span className="us-bad">+{formatCount(row.inboxes_broken)}</span>}
      </td>
      <td className="us-text us-clip" title={row.providers ?? undefined}>{row.providers ?? NO_DATA}</td>
      <td className="is-num">{row.api_keys === 0 ? NO_DATA : formatCount(row.api_keys)}</td>
      <td className="is-num">{row.calls === 0 ? NO_DATA : formatCount(row.calls)}</td>
      <td className="is-num">{rate}</td>
      <td className="is-num">{row.active_days === 0 ? NO_DATA : formatCount(row.active_days)}</td>
      <td className="is-num" title={row.last_active_at ?? undefined}>{agoLabel(row.last_active_at) ?? NO_DATA}</td>
      <td className="is-num">{row.paywall_hits === 0 ? NO_DATA : formatCount(row.paywall_hits)}</td>
      <td className="us-text us-clip" title={row.acquisition_referrer ?? undefined}>{source ?? NO_DATA}</td>
    </tr>
  );
}

function Pager({ query, page, pages }: { query: UsersQuery; page: number; pages: number }) {
  return (
    <div className="us-pager">
      <div className="us-pager-pages">
        {page > 1 && <a href={usersHref(query, { page: page - 1 })}>← Previous</a>}
        <span>
          Page {formatCount(page)} of {formatCount(pages)}
        </span>
        {page < pages && <a href={usersHref(query, { page: page + 1 })}>Next →</a>}
      </div>
      <div className="us-pager-size">
        Rows
        {PAGE_SIZES.map((size) => (
          <a
            key={size}
            href={usersHref(query, { size, page: 1 })}
            aria-current={size === query.size ? 'true' : undefined}
          >
            {size}
          </a>
        ))}
      </div>
    </div>
  );
}
