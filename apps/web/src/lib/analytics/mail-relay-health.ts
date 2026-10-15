/**
 * The verdict the relay band on /admin/growth prints: is the mail relay up,
 * and are the connections it carries working.
 *
 * Pure, so it can be tested without a database. The rows come from
 * growth_mail_relay_daily and growth_mail_relay_hosts.
 *
 * TWO DIFFERENT FAILURES, kept apart on purpose. `relay_down` is the relay
 * itself not carrying a connection (the Hetzner box down, a wrong proxy
 * password, a port its filter does not allow), which is ours to fix.
 * `host_refused` is the tunnel working and the mail host still saying no, which
 * is almost always the customer's password and says nothing about the relay.
 * "Is it operational" is therefore judged on relay_down alone.
 */

import type { GrowthMailRelayDayRow, GrowthMailRelayHostRow } from './growth-types.ts';

export type RelayState = 'up' | 'degraded' | 'down' | 'idle';

export interface RelayHealth {
  state: RelayState;
  tone: 'good' | 'warn' | 'bad' | 'default';
  /** Every relayed connection in the window. */
  connections: number;
  ok: number;
  relayDown: number;
  hostRefused: number;
  /** Share of connections the relay itself carried (everything but relay_down). Null with none. */
  carriedRate: number | null;
  /** Share of connections that ended in a working session. Null with none. */
  workingRate: number | null;
  /** Totals per day, for a sparkline. */
  perDay: number[];
  hosts: number;
  learnedHosts: number;
}

/**
 * The state is read off the most recent two days, not the window: a relay
 * that was down for an hour three weeks ago is up now, and the band should
 * say so. Down = the latest day with traffic had relay failures and nothing
 * the relay carried; degraded = any relay failure in the last two days.
 */
export function relayHealth(days: GrowthMailRelayDayRow[], hosts: GrowthMailRelayHostRow[]): RelayHealth {
  const total = (row: GrowthMailRelayDayRow) => num(row.ok) + num(row.relay_down) + num(row.host_refused);
  const ok = days.reduce((acc, row) => acc + num(row.ok), 0);
  const relayDown = days.reduce((acc, row) => acc + num(row.relay_down), 0);
  const hostRefused = days.reduce((acc, row) => acc + num(row.host_refused), 0);
  const connections = ok + relayDown + hostRefused;

  const recent = days.slice(-2);
  const latestWithTraffic = [...recent].reverse().find((row) => total(row) > 0);
  let state: RelayState;
  if (!latestWithTraffic) state = connections > 0 ? 'up' : 'idle';
  else if (num(latestWithTraffic.relay_down) > 0 && num(latestWithTraffic.ok) + num(latestWithTraffic.host_refused) === 0) {
    state = 'down';
  } else if (recent.some((row) => num(row.relay_down) > 0)) state = 'degraded';
  else state = 'up';

  return {
    state,
    tone: state === 'up' ? 'good' : state === 'degraded' ? 'warn' : state === 'down' ? 'bad' : 'default',
    connections,
    ok,
    relayDown,
    hostRefused,
    carriedRate: connections > 0 ? (connections - relayDown) / connections : null,
    workingRate: connections > 0 ? ok / connections : null,
    perDay: days.map(total),
    hosts: new Set(hosts.map((row) => row.host)).size,
    learnedHosts: new Set(hosts.filter((row) => row.learned).map((row) => row.host)).size,
  };
}

/** Postgres bigint arrives as a string through PostgREST; treat both alike. */
function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** "listed, learned" for the routes column, in plain words. */
export function describeRoutes(routes: string | null | undefined): string {
  if (!routes) return '';
  const words: Record<string, string> = {
    listed: 'hand-listed',
    learned: 'learned',
    fallback: 'retry after direct failed',
  };
  return routes
    .split(',')
    .map((route) => words[route.trim()] ?? route.trim())
    .join(', ');
}
