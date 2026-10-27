/**
 * The draft card band: is the in-chat draft editor used, and is it worth
 * keeping? Rates and checks are src/lib/analytics/draft-card.ts.
 *
 * Aggregates only. No account, address or draft content is on this page.
 */

import type { GrowthDraftCardReachRow, GrowthDraftCardStatsRow } from '@/lib/analytics/growth-types';
import {
  BARS,
  FAMILY_NAMES,
  rates,
  totals,
  type Check,
  type Family,
  type ReleaseVerdict,
} from '@/lib/analytics/draft-card';
import { formatCount, formatPercent } from '../../charts';
import { Tile } from '../../kiosk/primitives';
import { Verdict } from './panels';

const STATE_WORDS = { pass: 'Pass', fail: 'Fail', wait: 'Waiting' } as const;
const FAMILIES: Family[] = ['claude', 'chatgpt', 'claude_code', 'other'];

const pct = (value: number | null) => (value === null ? '' : formatPercent(value, 1));

export function DraftCardVerdictTile({ verdict, checks }: { verdict: ReleaseVerdict; checks: Check[] }) {
  return (
    <Tile
      label="Keep the card?"
      aside="customers only"
      tone={verdict.level === 'ok' ? 'good' : verdict.level === 'down' ? 'bad' : verdict.level === 'degraded' ? 'warn' : 'default'}
    >
      <Verdict level={verdict.level} headline={verdict.headline} reason={verdict.reason} />
      <table className="bd-table">
        <tbody>
          {checks.map((check) => (
            <tr key={check.key} className={check.key === 'retention' ? 'is-quiet' : undefined}>
              <th scope="row" className="bd-cell-text" title={check.bar}>
                {check.question}
              </th>
              <td className="bd-cell-text" title={check.detail}>
                {STATE_WORDS[check.state]}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="bd-note">
        {checks
          .filter((c) => c.key !== 'retention')
          .map((c) => `${c.question} ${c.detail}.`)
          .join(' ')}
      </p>
    </Tile>
  );
}

/**
 * Every client family side by side, so the card clients can be read against
 * the ones that draw no card. After the release when there is one, else the
 * baseline window.
 */
export function DraftCardFamilyTable({
  rows,
  released,
  days,
}: {
  rows: GrowthDraftCardStatsRow[];
  released: boolean;
  days: number;
}) {
  const period = released ? 'after' : 'before';
  return (
    <Tile label="By client" aside={released ? 'since release, vs the window before' : `last ${days}d, before release`}>
      <div className="bd-scroll">
        <table className="bd-table">
          <thead>
            <tr>
              <th scope="col">Client</th>
              <th scope="col">Workspaces</th>
              <th scope="col">Drafts</th>
              <th scope="col">With card</th>
              <th scope="col">Touched in card</th>
              <th scope="col">Sent per draft</th>
              {released && <th scope="col">Before</th>}
              <th scope="col">Sent from card</th>
              <th scope="col">Discarded</th>
              <th scope="col">Tool failures</th>
              <th scope="col">Turned off</th>
            </tr>
          </thead>
          <tbody>
            {FAMILIES.map((family) => {
              const t = totals(rows, period, [family]);
              const r = rates(t);
              const before = rates(totals(rows, 'before', [family]));
              return (
                <tr key={family} className={t.drafted === 0 ? 'is-quiet' : undefined}>
                  <th scope="row" className="bd-cell-text">{FAMILY_NAMES[family]}</th>
                  <td>{formatCount(t.workspaces)}</td>
                  <td>{formatCount(t.drafted)}</td>
                  <td>{formatCount(t.drafted_card)}</td>
                  <td>{pct(r.touched)}</td>
                  <td>{pct(r.sent)}</td>
                  {released && <td>{pct(before.sent)}</td>}
                  <td>{pct(r.sentFromCard)}</td>
                  <td>{pct(r.discarded)}</td>
                  <td>{pct(r.errors)}</td>
                  <td>{formatCount(t.hidden)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="bd-note">
        Touched means saved, sent or discarded in the card. Sent per draft counts every send against new drafts,
        so it can pass 100% when older drafts are sent. A card send is one that carried the card&apos;s
        base_revision, which a model could also pass. Other clients (Cursor, Codex and the like) draw no card and
        are the comparison. The before window has no card sends: until the release only our own workspaces had it,
        and they are excluded. Bars: {formatPercent(BARS.touched, 0)} touched, send rate down at most{' '}
        {formatPercent(BARS.sendDrop, 0)} net of other clients, under {formatPercent(BARS.optOut, 0)} turned off,
        failures up at most {Math.round(BARS.errorRise * 100)} point.
      </p>
    </Tile>
  );
}

export function DraftCardReachTile({ reach }: { reach: GrowthDraftCardReachRow }) {
  const enabled = Number(reach.enabled);
  const hidden = Number(reach.hidden_workspaces);
  return (
    <Tile label="Who has it" aside="now">
      <table className="bd-table">
        <tbody>
          <tr>
            <th scope="row" className="bd-cell-text">Workspaces with the card on</th>
            <td>
              {formatCount(enabled)} of {formatCount(Number(reach.workspaces))}
            </td>
          </tr>
          <tr>
            <th scope="row" className="bd-cell-text">Turned off for the workspace</th>
            <td>
              {formatCount(hidden)}
              {enabled > 0 ? ` (${formatPercent(hidden / enabled, 1)})` : ''}
            </td>
          </tr>
          <tr>
            <th scope="row" className="bd-cell-text">Turned off for one inbox</th>
            <td>
              {formatCount(Number(reach.hidden_inboxes))} of {formatCount(Number(reach.enabled_inboxes))}
            </td>
          </tr>
        </tbody>
      </table>
    </Tile>
  );
}
