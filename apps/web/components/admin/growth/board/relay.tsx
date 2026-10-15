/**
 * The mail relay band: which hosts go through the relay, and whether it works.
 *
 * The relay is the non-AWS egress for mail hosts that refuse our own servers
 * (docs/smtp-relay.md). Hosts reach it three ways: the hand-kept list in code,
 * the relay registry (a host where a direct attempt failed and a relayed one
 * worked), and the one relayed retry after a direct failure. This band is
 * low priority by design and sits at the foot of the board.
 *
 * Host names only. No account, address or credential is on this page.
 */

import type { GrowthMailRelayHostRow } from '@/lib/analytics/growth-types';
import { describeRoutes, type RelayHealth } from '@/lib/analytics/mail-relay-health';
import { agoLabel } from '@/lib/analytics/growth-records';
import { formatCount, formatPercent } from '../../charts';
import { BigNumber, Tile } from '../../kiosk/primitives';

const STATE_WORDS = { up: 'Up', degraded: 'Flaky', down: 'Down', idle: 'Idle' } as const;

export function RelayStatusTile({ health, days }: { health: RelayHealth; days: number }) {
  return (
    <Tile label="Relay" aside="last two days" tone={health.tone}>
      <BigNumber
        value={STATE_WORDS[health.state]}
        caption={
          health.state === 'idle' ? (
            <>Nothing went through the relay in {days} days</>
          ) : (
            <>
              <strong>{formatCount(health.relayDown)}</strong> connections the relay itself could not carry in {days}d
            </>
          )
        }
        spark={health.perDay}
      />
    </Tile>
  );
}

export function RelayWorkingTile({ health, days }: { health: RelayHealth; days: number }) {
  const rate = health.workingRate;
  return (
    <Tile
      label="Requests working"
      aside={`${days}d`}
      tone={rate === null ? 'default' : rate >= 0.95 ? 'good' : rate >= 0.8 ? 'warn' : 'bad'}
    >
      <BigNumber
        value={rate === null ? '—' : formatPercent(rate, 1)}
        caption={
          <>
            <strong>{formatCount(health.ok)}</strong> of {formatCount(health.connections)} relayed connections worked;{' '}
            {formatCount(health.hostRefused)} refused by the mail host
          </>
        }
      />
    </Tile>
  );
}

export function RelayHostsTile({ health }: { health: RelayHealth }) {
  return (
    <Tile label="Hosts" aside="relayed or learned">
      <BigNumber
        value={health.hosts}
        caption={
          <>
            <strong>{formatCount(health.learnedHosts)}</strong> learned automatically, the rest hand-listed
          </>
        }
      />
    </Tile>
  );
}

export function RelayHostTable({ rows }: { rows: GrowthMailRelayHostRow[] }) {
  return (
    <Tile label="Relayed hosts" aside={`${formatCount(rows.length)} host and protocol pairs`}>
      {rows.length === 0 ? (
        <p className="bd-empty">No host has used the relay in this window</p>
      ) : (
        <div className="bd-scroll">
          <table className="bd-table">
            <thead>
              <tr>
                <th scope="col">Host</th>
                <th scope="col">Protocol</th>
                <th scope="col">Why relayed</th>
                <th scope="col">Connections</th>
                <th scope="col">Worked</th>
                <th scope="col">Relay down</th>
                <th scope="col">Host refused</th>
                <th scope="col">Avg ms</th>
                <th scope="col">Last used</th>
                <th scope="col">Last failure</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.host}:${row.protocol}`}>
                  <th scope="row" className="bd-cell-text">{row.host}</th>
                  <td className="bd-cell-text">{row.protocol.toUpperCase()}</td>
                  <td className="bd-cell-text">
                    {[
                      describeRoutes(row.routes),
                      row.learned
                        ? row.learned_source === 'manual'
                          ? 'in registry (manual)'
                          : `learned${row.learned_expires_at ? `, rechecked ${row.learned_expires_at.slice(0, 10)}` : ''}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join('; ')}
                  </td>
                  <td>{formatCount(Number(row.connections))}</td>
                  <td>{formatCount(Number(row.ok))}</td>
                  <td>{formatCount(Number(row.relay_down))}</td>
                  <td>{formatCount(Number(row.host_refused))}</td>
                  <td>{row.avg_ms === null ? '' : formatCount(Number(row.avg_ms))}</td>
                  <td className="bd-cell-text">{agoLabel(row.last_at) ?? ''}</td>
                  <td className="bd-cell-text" title={row.last_failure ?? undefined}>
                    {row.last_failure_at ? `${agoLabel(row.last_failure_at)}: ${truncate(row.last_failure, 80)}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="bd-note">
        Relay down is the relay failing to carry a connection, which is ours to fix. Host refused is the mail host
        saying no through a working tunnel, usually a wrong password. A learned host goes through the relay for 30
        days, then is tried directly again and re-learned if it still needs it.
      </p>
    </Tile>
  );
}

function truncate(text: string | null, max: number): string {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
