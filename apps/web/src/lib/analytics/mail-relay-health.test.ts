import test from 'node:test';
import assert from 'node:assert/strict';
import { relayHealth, relayStatus } from './mail-relay-health.ts';
import type { GrowthMailRelayDayRow, GrowthMailRelayHostRow } from './growth-types.ts';

const day = (ok: number, relay_down = 0, host_refused = 0): GrowthMailRelayDayRow => ({
  day: '2026-10-15',
  ok,
  relay_down,
  host_refused,
});

const host = (name: string, learned: boolean): GrowthMailRelayHostRow => ({
  host: name,
  protocol: 'smtp',
  learned,
  learned_source: learned ? 'auto' : null,
  first_learned_at: null,
  learned_expires_at: null,
  candidate_rescues: null,
  candidate_refused: null,
  candidate_direct_successes: null,
  routes: 'listed',
  connections: 1,
  ok: 1,
  relay_down: 0,
  host_refused: 0,
  avg_ms: 100,
  last_at: null,
  last_failure_at: null,
  last_failure: null,
});

test('no traffic at all is idle, not down', () => {
  const health = relayHealth([day(0), day(0)], []);
  assert.equal(health.state, 'idle');
  assert.equal(health.carriedRate, null);
  assert.equal(health.workingRate, null);
});

test('a wrong password through a working relay does not make the relay look down', () => {
  const health = relayHealth([day(10, 0, 0), day(3, 0, 4)], []);
  assert.equal(health.state, 'up');
  assert.equal(health.carriedRate, 1);
  assert.equal(health.workingRate, 13 / 17);
});

test('relay failures in the last two days beside working traffic read as flaky', () => {
  assert.equal(relayHealth([day(5), day(0), day(8, 1)], []).state, 'degraded');
});

test('the latest day with traffic carried nothing: down', () => {
  assert.equal(relayHealth([day(5), day(0, 3)], []).state, 'down');
  // A quiet last day does not hide a down day before it.
  assert.equal(relayHealth([day(0, 3), day(0)], []).state, 'down');
});

test('an old outage does not haunt today', () => {
  assert.equal(relayHealth([day(0, 9), day(4), day(6)], []).state, 'up');
});

test('bigints arriving as strings are counted, and hosts are counted once across protocols', () => {
  const health = relayHealth(
    [{ day: '2026-10-15', ok: '7' as unknown as number, relay_down: '1' as unknown as number, host_refused: 0 }],
    [host('smtp.telstra.com', true), { ...host('smtp.telstra.com', true), protocol: 'imap' }, host('smtp.domeneshop.no', false)]
  );
  assert.equal(health.connections, 8);
  assert.equal(health.hosts, 2);
  assert.equal(health.learnedHosts, 1);
});

test('one status per host, in a fixed order', () => {
  const base = host('x.example', false);
  assert.equal(relayStatus({ ...base, routes: 'listed' }), 'Hand-listed in code');
  assert.equal(
    relayStatus({
      ...base,
      routes: 'fallback,learned',
      learned: true,
      learned_source: 'auto',
      first_learned_at: '2026-10-15T11:47:09Z',
      learned_expires_at: '2026-11-14T11:47:09Z',
    }),
    'Learned since 15 Oct, tried directly again 14 Nov'
  );
  assert.equal(relayStatus({ ...base, routes: null, learned: true, learned_source: 'manual' }), 'Added to the registry by hand');
  // The IONOS case: rescued once, refused because it works directly.
  assert.equal(
    relayStatus({ ...base, routes: 'fallback', candidate_rescues: 1, candidate_refused: true, candidate_direct_successes: 82 }),
    'Not learned: works directly (82 direct successes in 7 days)'
  );
  assert.equal(relayStatus({ ...base, routes: 'fallback', candidate_rescues: 1, candidate_refused: false }), 'Candidate: rescued 1 of 2 times needed');
  assert.equal(relayStatus({ ...base, routes: 'fallback' }), 'Single calls retried through the relay');
});

test('the hosts tile counts each kind once', () => {
  const health = relayHealth([day(1)], [
    host('smtp.domeneshop.no', false),
    { ...host('smtp.telstra.com', true), routes: 'learned' },
    { ...host('exchange.ionos.eu', false), routes: 'fallback', protocol: 'imap' },
  ]);
  assert.deepEqual([health.hosts, health.listedHosts, health.learnedHosts, health.retriedOnlyHosts], [3, 1, 1, 1]);
});
