/**
 * The panels of /admin/growth/users/[id].
 *
 * ONE PERSON, IN THE ORDER SOMEBODY ACTUALLY ASKS ABOUT THEM: who they are and
 * how far they got; how long each step took; what they own; what they use; what
 * is broken for them; and then, last, everything that ever happened to them in
 * one list.
 *
 * THE JOURNEY PANEL IS THE POINT OF THE PAGE. Six timestamps for one person
 * live across three tables under three naming conventions, and the only useful
 * reading of them is the GAPS: signup to first mailbox is the connect problem,
 * first mailbox to first call is the client-setup problem, first call to value
 * activation is the does-it-actually-work problem. Printing six dates and
 * leaving the subtraction to the reader is what the hand-written SQL did, and
 * it is why nobody did it twice.
 *
 * Every panel takes plain data and renders synchronously. Fetching happens in
 * the page, one Suspense boundary per band, so a slow read delays one panel.
 */

import Link from 'next/link';
import type {
  UserDirectoryRow,
  UserActivityRow,
  UserErrorRow,
  UserInboxRow,
  UserTimelineRow,
  UserToolRow,
  UserWorkspaceRow,
} from '@/lib/analytics/user-directory';
import { channel, stageLabel, stageRank, STAGE_LABELS } from '@/lib/analytics/user-table';
import { agoLabel, formatDayKey } from '@/lib/analytics/growth-records';
import { BarSeries, formatCount, formatPercent, NO_DATA } from '../charts';

/* ── Small shared parts ─────────────────────────────────────────────────── */

export function Panel({
  title,
  sub,
  wide,
  children,
}: {
  title: string;
  sub?: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={`us-panel${wide ? ' is-wide' : ''}`}>
      <header>
        <h2>{title}</h2>
        {sub && <p>{sub}</p>}
      </header>
      {children}
    </section>
  );
}

/** A definition list of facts. `null` prints the no-data glyph, never a blank. */
export function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="us-facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value === null || value === undefined || value === '' ? NO_DATA : value}</dd>
        </div>
      ))}
    </dl>
  );
}

function stamp(value: string | null): React.ReactNode {
  if (!value) return null;
  const day = formatDayKey(value.slice(0, 10));
  const ago = agoLabel(value);
  return (
    <span title={value}>
      {day}
      {ago && <em className="us-ago">{ago}</em>}
    </span>
  );
}

/* ── Header ─────────────────────────────────────────────────────────────── */

export function Identity({ row }: { row: UserDirectoryRow }) {
  return (
    <div className="us-identity">
      <div>
        <h1>{row.email}</h1>
        <p className="us-identity-sub">
          {row.display_name ?? 'no display name'}
          <span className="us-identity-id">{row.user_id}</span>
        </p>
      </div>
      <ul className="us-badges">
        <li className={`us-stage is-s${stageRank(row)}`}>{stageLabel(row)}</li>
        <li>{row.is_comped ? `${row.plan} · comped` : row.plan}</li>
        {row.grandfathered && <li>grandfathered</li>}
        {row.unlimited_inboxes && <li>unlimited inboxes</li>}
        {row.is_internal && <li className="is-quiet">one of ours</li>}
        {row.unsubscribed_at && <li className="is-quiet">unsubscribed</li>}
      </ul>
    </div>
  );
}

/**
 * The six headline figures, in the same arithmetic the list column uses --
 * they come from the same RPC, so the two cannot disagree.
 */
export function Headline({ row, windowDays }: { row: UserDirectoryRow; windowDays: number }) {
  const rate = row.calls >= 10 ? formatPercent(row.successes / row.calls) : NO_DATA;
  return (
    <div className="gb-strip us-strip">
      {[
        { label: 'Signed up', value: formatDayKey(row.signed_up_at.slice(0, 10)) ?? NO_DATA, note: agoLabel(row.signed_up_at) ?? '' },
        { label: 'Mailboxes', value: formatCount(row.inboxes), note: row.providers ?? 'none connected' },
        { label: `Calls · ${windowDays}d`, value: formatCount(row.calls), note: `${formatCount(row.active_days)} active days` },
        { label: 'Succeeded', value: rate, note: `${formatCount(row.successes)} of ${formatCount(row.calls)}` },
        { label: 'Last call', value: agoLabel(row.last_active_at) ?? NO_DATA, note: row.last_active_at?.slice(0, 10) ?? 'never' },
        { label: 'Cap hits', value: formatCount(row.paywall_hits), note: 'all-time' },
      ].map((stat) => (
        <div className="gb-stat" key={stat.label}>
          <p className="gb-stat-label">{stat.label}</p>
          <div className="gb-stat-row">
            <span className="gb-stat-value">{stat.value}</span>
          </div>
          <span className="gb-stat-note">{stat.note}</span>
        </div>
      ))}
    </div>
  );
}

/* ── Journey ────────────────────────────────────────────────────────────── */

type Step = { label: string; at: string | null; note: string | null };

/**
 * The funnel for one person, with the WAIT between each pair of rungs.
 *
 * A rung with no date is not drawn as reached-later; it is drawn as not
 * reached, and everything after it is too. That is the honest reading: the
 * timestamps are written independently by different code paths, and a missing
 * one means the step was never recorded, not that it happened silently.
 */
export function Journey({ row }: { row: UserDirectoryRow }) {
  const steps: Step[] = [
    { label: STAGE_LABELS[0], at: row.signed_up_at, note: channel(row) },
    { label: STAGE_LABELS[1], at: row.first_inbox_connected_at, note: row.first_inbox_provider },
    { label: STAGE_LABELS[2], at: row.first_credential_created_at, note: row.first_credential_method },
    { label: STAGE_LABELS[3], at: row.first_tool_used_at, note: [row.first_tool_name, row.first_tool_client].filter(Boolean).join(' · ') || null },
    { label: STAGE_LABELS[4], at: row.value_activated_at, note: 'real mailbox work, not just a connection' },
  ];
  let previous: number | null = null;
  return (
    <ol className="us-journey">
      {steps.map((step) => {
        const at = step.at ? Date.parse(step.at) : null;
        const gap = at !== null && previous !== null ? gapLabel(at - previous) : null;
        if (at !== null) previous = at;
        return (
          <li key={step.label} className={at === null ? 'is-unreached' : undefined}>
            <b>{step.label}</b>
            <span className="us-journey-when">{at === null ? 'not reached' : stamp(step.at)}</span>
            <span className="us-journey-note">{step.note ?? ''}</span>
            <span className="us-journey-gap">{gap ?? ''}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** A wait, in the coarsest unit that still says something. */
function gapLabel(ms: number): string {
  if (ms < 0) return 'out of order';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'same minute';
  if (minutes < 90) return `+${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `+${hours} h`;
  return `+${Math.round(hours / 24)} days`;
}

/* ── Acquisition ────────────────────────────────────────────────────────── */

export function Acquisition({ row }: { row: UserDirectoryRow }) {
  return (
    <Facts
      rows={[
        ['Channel', channel(row)],
        ['Source', row.acquisition_source],
        ['utm_source', row.acquisition_utm_source],
        ['utm_medium', row.acquisition_utm_medium],
        ['utm_campaign', row.acquisition_utm_campaign],
        ['Landing page', row.acquisition_landing_path],
        ['Referrer', row.acquisition_referrer],
        ['Locale', row.acquisition_locale],
        ['Client', row.onboarding_client],
      ]}
    />
  );
}

export function Billing({ row }: { row: UserDirectoryRow }) {
  return (
    <Facts
      rows={[
        ['Workspace plan', row.is_comped ? `${row.plan} · comped` : row.plan],
        ['Billing plan', row.billing_plan],
        ['Subscription', row.subscription_status],
        ['Renews', stamp(row.current_period_end)],
        ['Stripe customer', row.stripe_customer_id ? <code>{row.stripe_customer_id}</code> : null],
        ['Cap rejections', formatCount(row.paywall_hits)],
        ['Live API keys', formatCount(row.api_keys)],
        ['Key last used', stamp(row.key_last_used_at)],
        ['Email opt-out', row.unsubscribed_at ? stamp(row.unsubscribed_at) : 'subscribed'],
      ]}
    />
  );
}

/* ── Tables ─────────────────────────────────────────────────────────────── */

export function Workspaces({ rows }: { rows: UserWorkspaceRow[] }) {
  if (rows.length === 0) return <p className="bd-empty">No workspace, which should be impossible after signup</p>;
  return (
    <div className="us-scroll">
      <table className="us-table is-inner">
        <thead>
          <tr>
            <th scope="col">Workspace</th>
            <th scope="col">Role</th>
            <th scope="col">Plan</th>
            <th scope="col" className="is-num">Members</th>
            <th scope="col" className="is-num">Inboxes</th>
            <th scope="col" className="is-num">Keys</th>
            <th scope="col" className="is-num">Calls</th>
            <th scope="col" className="is-num">Created</th>
            <th scope="col" className="is-num">Last call</th>
            <th scope="col">Stage</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.workspace_id} className={row.deleted_at ? 'is-quiet' : undefined}>
              <th scope="row" className="us-text">
                {row.name}
                <span className="us-sub">{row.slug}{row.deleted_at ? ' · deleted' : ''}</span>
              </th>
              <td className="us-text">{row.role}</td>
              <td className="us-text">{row.plan}{row.grandfathered ? ' · grandfathered' : ''}</td>
              <td className="is-num">{formatCount(row.members)}</td>
              <td className="is-num">{formatCount(row.inboxes)}</td>
              <td className="is-num">{formatCount(row.api_keys)}</td>
              <td className="is-num">{row.calls === 0 ? NO_DATA : formatCount(row.calls)}</td>
              <td className="is-num">{formatDayKey(row.created_at.slice(0, 10))}</td>
              <td className="is-num">{agoLabel(row.last_active_at) ?? NO_DATA}</td>
              <td className="us-text">{row.onboarding_stage ?? NO_DATA}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Inboxes({ rows }: { rows: UserInboxRow[] }) {
  if (rows.length === 0) {
    return <p className="bd-empty">Never connected a mailbox. This is where 40% of signups stop</p>;
  }
  return (
    <div className="us-scroll">
      <table className="us-table is-inner">
        <thead>
          <tr>
            <th scope="col">Mailbox</th>
            <th scope="col">Provider</th>
            <th scope="col">Status</th>
            <th scope="col" className="is-num">Connected</th>
            <th scope="col" className="is-num">Calls</th>
            <th scope="col" className="is-num">Last used</th>
            <th scope="col" className="is-num">Last sync</th>
            <th scope="col">Last error</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.inbox_id} className={row.deleted_at ? 'is-quiet' : undefined}>
              <th scope="row" className="us-text">
                {row.email_address}
                <span className="us-sub">
                  {[row.workspace_name, row.display_name, row.deleted_at ? 'disconnected' : null]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </th>
              <td className="us-text">{row.provider}</td>
              <td className="us-text">
                <span className={`us-dot is-${row.status === 'active' ? 'good' : 'bad'}`} />
                {row.status}
              </td>
              <td className="is-num">{formatDayKey(row.created_at.slice(0, 10))}</td>
              <td className="is-num">{row.calls === 0 ? NO_DATA : formatCount(row.calls)}</td>
              <td className="is-num">{agoLabel(row.last_used_at) ?? NO_DATA}</td>
              <td className="is-num">{agoLabel(row.last_sync_at) ?? NO_DATA}</td>
              {/* The provider's own refusal, verbatim. It is the single most
                  useful field here for "why did this customer stop", and the
                  connectors strip echoed SASL tokens before storing it. */}
              <td className="us-text us-error">{row.last_error ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Tools({ rows, windowDays }: { rows: UserToolRow[]; windowDays: number }) {
  if (rows.length === 0) return <p className="bd-empty">No tool call in the last {windowDays} days</p>;
  const peak = Math.max(...rows.map((row) => row.calls));
  return (
    <ul className="us-bars">
      {rows.map((row) => (
        <li key={row.tool_name}>
          <span className="us-bar-name">{row.tool_name}</span>
          <span className="us-bar-track">
            <i style={{ width: `${Math.max(2, (row.successes / peak) * 100)}%` }} />
            {row.failures > 0 && <i className="is-bad" style={{ width: `${(row.failures / peak) * 100}%` }} />}
          </span>
          <span className="us-bar-count">
            {formatCount(row.calls)}
            {row.failures > 0 && <em className="us-bad">{formatCount(row.failures)} failed</em>}
          </span>
          <span className="us-bar-ms">{row.median_ms === null ? '' : `${formatCount(row.median_ms)} ms`}</span>
        </li>
      ))}
    </ul>
  );
}

export function Errors({ rows, windowDays }: { rows: UserErrorRow[]; windowDays: number }) {
  if (rows.length === 0) return <p className="bd-empty">Nothing failed in the last {windowDays} days</p>;
  return (
    <table className="us-table is-inner">
      <thead>
        <tr>
          <th scope="col">Error</th>
          <th scope="col">Tool</th>
          <th scope="col" className="is-num">Times</th>
          <th scope="col" className="is-num">Last</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.error_code}:${row.tool_name}`}>
            <th scope="row" className="us-text">{row.error_code}</th>
            <td className="us-text">{row.tool_name}</td>
            <td className="is-num">{formatCount(row.calls)}</td>
            <td className="is-num">{agoLabel(row.last_at) ?? NO_DATA}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Volume({ rows, windowDays }: { rows: UserActivityRow[]; windowDays: number }) {
  const any = rows.some((row) => row.calls > 0);
  if (!any) return <p className="bd-empty">No call in the last {windowDays} days</p>;
  return (
    <BarSeries
      title="Calls per day"
      subtitle={`Last ${windowDays} days. Successes and failures stacked, because a busy broken day is not a quiet one.`}
      labels={rows.map((row) => row.day.slice(5))}
      series={[
        { key: 'ok', name: 'Succeeded', values: rows.map((row) => row.successes) },
        { key: 'failed', name: 'Failed', values: rows.map((row) => row.failures) },
      ]}
      stacked
      height={150}
    />
  );
}

/* ── Timeline ───────────────────────────────────────────────────────────── */

/**
 * Everything durable that ever happened to this person, newest first.
 *
 * Grouped by UTC day rather than printed flat: a connection attempt normally
 * produces four rows inside one minute, and a flat list of four timestamps
 * makes a busy afternoon look like a busy month.
 */
export function Timeline({ rows }: { rows: UserTimelineRow[] }) {
  if (rows.length === 0) return <p className="bd-empty">Nothing recorded</p>;
  const days = new Map<string, UserTimelineRow[]>();
  for (const row of rows) {
    const day = row.occurred_at.slice(0, 10);
    const bucket = days.get(day);
    if (bucket) bucket.push(row);
    else days.set(day, [row]);
  }
  return (
    <ol className="us-timeline">
      {[...days.entries()].map(([day, entries]) => (
        <li key={day}>
          <p className="us-timeline-day">
            {formatDayKey(day)}
            <em>{agoLabel(`${day}T12:00:00Z`)}</em>
          </p>
          <ul>
            {entries.map((entry, index) => (
              <li key={`${entry.occurred_at}-${index}`} className={`is-${entry.tone}`}>
                <span className="us-timeline-time">{entry.occurred_at.slice(11, 16)}</span>
                <span className="us-timeline-title">{entry.title}</span>
                <span className="us-timeline-detail">{entry.detail ?? ''}</span>
                <span className="us-timeline-kind">{entry.kind}</span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

export function BackLink() {
  return (
    <Link className="us-crumb" href="/admin/growth/users">
      People
    </Link>
  );
}
