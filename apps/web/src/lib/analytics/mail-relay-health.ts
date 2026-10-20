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
  /** Hosts on the hand-kept list in code (route "listed"). */
  listedHosts: number;
  /** Hosts neither listed nor learned: only individual calls were retried. */
  retriedOnlyHosts: number;
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
    listedHosts: new Set(hosts.filter((row) => hasRoute(row, 'listed')).map((row) => row.host)).size,
    retriedOnlyHosts: new Set(
      hosts.filter((row) => !row.learned && !hasRoute(row, 'listed')).map((row) => row.host)
    ).size,
  };
}

/** Postgres bigint arrives as a string through PostgREST; treat both alike. */
function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function hasRoute(row: Pick<GrowthMailRelayHostRow, 'routes'>, route: string): boolean {
  return (row.routes ?? '').split(',').some((value) => value.trim() === route);
}

/**
 * One line saying why a host goes through the relay, for the hosts table.
 *
 * Exactly one state per host, in this order: hand-listed in code, learned
 * (with when it is next tried directly), refused learning because it works
 * directly, a candidate one rescue short, or only individual calls retried.
 */
export function relayStatus(row: GrowthMailRelayHostRow): string {
  if (hasRoute(row, 'listed')) return 'Hand-listed in code';
  if (row.learned) {
    if (row.learned_source === 'manual') return 'Added to the registry by hand';
    const since = row.first_learned_at ? `since ${shortDate(row.first_learned_at)}` : '';
    const until = row.learned_expires_at ? `, tried directly again ${shortDate(row.learned_expires_at)}` : '';
    return `Learned ${since}${until}`.replace(/\s+,/, ',').trim();
  }
  if (row.candidate_refused) {
    const n = row.candidate_direct_successes;
    return `Not learned: works directly${n === null ? '' : ` (${n} direct successes in 7 days)`}`;
  }
  if (row.candidate_rescues) return `Candidate: rescued ${row.candidate_rescues} of 2 times needed`;
  return 'Single calls retried through the relay';
}

/** 2026-11-14 -> 14 Nov. */
function shortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  return `${date.getUTCDate()} ${date.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
}
