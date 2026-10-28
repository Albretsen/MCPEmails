/**
 * The draft card band: is the in-chat draft editor used, and is it worth
 * keeping? Rates and checks are src/lib/analytics/draft-card.ts.
 *
 * Aggregates only. No account, address or draft content is on this page.
 */

import type { GrowthDraftCardReachRow, GrowthDraftCardStatsRow } from '@/lib/analytics/growth-types';
import {
  BARS,
  CARD_FAMILIES,
  FAMILY_NAMES,
  rates,
  totals,
  type Check,
  type Family,
  type ReleaseVerdict,
} from '@/lib/analytics/draft-card';
import { formatCount, formatPercent } from '../../charts';
import { Tile } from '../../kiosk/primitives';
import { CheckList, HowCounted } from './checks';
import { Verdict } from './panels';

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
      <CheckList checks={checks.map((check) => ({ ...check, quiet: check.key === 'retention' }))} />
    </Tile>
  );
}

/**
 * Every client family side by side, so the card clients can be read against
 * the ones that draw no card. After the release when there is one, else the
 * baseline window. The core columns only; the rest sit in a drawer.
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
  const lines = FAMILIES.map((family) => {
    const t = totals(rows, period, [family]);
    // Other clients cannot draw the card, so card columns stay empty there: a
    // "card" send from them is a model passing base_revision.
    return { family, t, r: rates(t), before: rates(totals(rows, 'before', [family])), drawsCard: CARD_FAMILIES.includes(family) };
  });
  return (
    <Tile label="By client" aside={released ? 'since release' : `last ${days}d, before release`}>
      <div className="bd-scroll">
        <table className="bd-table">
          <thead>
            <tr>
              <th scope="col">Client</th>
              <th scope="col">Drafts</th>
              <th scope="col" title="Saved, sent or discarded in the card">Used the card</th>
              <th scope="col" title="Of the sends, how many came from the card's Send button">Sent from card</th>
              <th scope="col" title="Share of drafts sent within 24 hours, now and in the window before">
                Sent within a day{released ? ', now vs before' : ''}
              </th>
              <th scope="col" title="Draft tool calls that failed">Failures</th>
            </tr>
          </thead>
          <tbody>
            {lines.map(({ family, t, r, before, drawsCard }) => (
              <tr key={family} className={t.drafted === 0 ? 'is-quiet' : undefined}>
                <th scope="row" className="bd-cell-text">
                  {FAMILY_NAMES[family]}
                  {!drawsCard && <span className="gb-arm-n"> no card</span>}
                </th>
                <td title={`${formatCount(t.workspaces)} workspaces`}>{formatCount(t.drafted)}</td>
                <td>{drawsCard ? pct(r.touched) : ''}</td>
                <td>{drawsCard ? pct(r.sentFromCard) : ''}</td>
                <td title={`${formatCount(t.mature_lines)} drafts a day old`}>
                  {pct(r.sent) || 'n/a'}
                  {released && <span className="gb-arm-n"> vs {pct(before.sent) || 'n/a'}</span>}
                </td>
                <td>{pct(r.errors)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="gb-drawer">
        <summary>More columns</summary>
        <div className="bd-scroll">
          <table className="bd-table">
            <thead>
              <tr>
                <th scope="col">Client</th>
                <th scope="col">Workspaces</th>
                <th scope="col">Card offered</th>
                <th scope="col">Discarded</th>
                <th scope="col">Drafts a day old</th>
                <th scope="col">Turned off</th>
              </tr>
            </thead>
            <tbody>
              {lines.map(({ family, t, r, drawsCard }) => (
                <tr key={family}>
                  <th scope="row" className="bd-cell-text">{FAMILY_NAMES[family]}</th>
                  <td>{formatCount(t.workspaces)}</td>
                  <td>{drawsCard ? formatCount(t.drafted_card) : ''}</td>
                  <td>{pct(r.discarded)}</td>
                  <td>{formatCount(t.mature_lines)}</td>
                  <td>{formatCount(t.hidden)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <HowCounted>
        Rates follow each new draft. Used the card means saved, sent or discarded in it. Sent within a day counts
        only drafts at least 24 hours old, so it is thin for the first days after the release. Each workspace
        weighs at most 20 drafts, so one busy account cannot set a client&apos;s rate; Drafts is the raw count.
        Card offered means the result carried the card, not that the client drew it. A card send is one that
        carried the card&apos;s base_revision, which a model could also pass. Other clients (Cursor, Codex and the
        like) draw no card and are the comparison. Failures leave out draft_read answering draft_not_found: a card
        re-reads its draft when the chat is reopened, and a sent or discarded one answers that. Bars:{' '}
        {formatPercent(BARS.touched, 0)} used the card, share sent within a day down at most{' '}
        {formatPercent(BARS.sendDrop, 0)} net of other clients, under {formatPercent(BARS.optOut, 0)} turned off,
        failures up at most {Math.round(BARS.errorRise * 100)} point.
      </HowCounted>
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
