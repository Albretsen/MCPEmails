/**
 * Tests for the kiosk's up/down decision.
 *
 * This is the only number on the board with an operational consequence: it is
 * what decides whether someone walks over to a wall and starts debugging. The
 * two things worth protecting are therefore the two ways it can be wrong in
 * public. A FALSE GREEN is the worse one, because the display is believed and
 * an outage that the board sat through in calm grey is an outage nobody looked
 * at. A FALSE RED is the one that kills the board slowly: a screen that cries
 * wolf at a single retried request is a screen the room stops reading, and a
 * screen the room stops reading cannot report the real outage either.
 *
 * Run: npm run test:health
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyHealth,
  minutesSince,
  successRate,
  type CallWindow,
  type HealthFacts,
  type MonitorFacts,
} from './health-math.ts';

const NOW = Date.parse('2026-08-30T12:00:00Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function monitor(overrides: Partial<MonitorFacts> = {}): MonitorFacts {
  return {
    lastRunAt: minutesAgo(2),
    lastStatus: 'succeeded',
    lastSuccessAt: minutesAgo(2),
    consecutiveFailures: 0,
    failedStep: null,
    failureClass: null,
    medianDurationMs: 9_800,
    openIncidents: 0,
    ...overrides,
  };
}

/** A healthy hour at the production rate measured on 2026-08-30. */
function window(overrides: Partial<CallWindow> = {}): CallWindow {
  return { minutes: 60, calls: 250, successes: 247, errors: 3, rateLimited: 0, ...overrides };
}

function facts(overrides: Partial<HealthFacts> = {}): HealthFacts {
  return {
    monitor: monitor(),
    live: window(),
    day: window({ minutes: 1440, calls: 5800, successes: 5719, errors: 81 }),
    lastCallAt: minutesAgo(1),
    ...overrides,
  };
}

test('a normal production hour is green', () => {
  const verdict = classifyHealth(facts(), NOW);
  assert.equal(verdict.level, 'ok');
  assert.equal(verdict.since, null);
});

test('two consecutive monitor failures are an outage', () => {
  const verdict = classifyHealth(
    facts({
      monitor: monitor({
        lastStatus: 'failed',
        consecutiveFailures: 2,
        failedStep: 'inbox_list',
        failureClass: 'public_endpoint',
        lastSuccessAt: minutesAgo(15),
      }),
    }),
    NOW,
  );
  assert.equal(verdict.level, 'down');
  // The banner says when it started, so nobody has to guess whether this is
  // new or has been up on the wall since yesterday.
  assert.equal(verdict.since, minutesAgo(15));
  assert.match(verdict.reason, /listing inboxes/);
});

test('one failure of a class the pager escalates on is an outage immediately', () => {
  for (const failureClass of ['authentication', 'mcp_protocol', 'internal']) {
    const verdict = classifyHealth(
      facts({
        monitor: monitor({
          lastStatus: 'failed',
          consecutiveFailures: 1,
          failedStep: 'initialize',
          failureClass,
        }),
      }),
      NOW,
    );
    assert.equal(verdict.level, 'down', `${failureClass} should page on the first failure`);
  }
});

test('one failure of a retryable class is amber, not red', () => {
  // Matches the monitor's own two-strike rule for these classes. The board
  // must not be redder than the pager: a wall that says DOWN while nobody was
  // woken teaches the room to trust neither.
  const verdict = classifyHealth(
    facts({
      monitor: monitor({
        lastStatus: 'failed',
        consecutiveFailures: 1,
        failedStep: 'email_read',
        failureClass: 'provider_read',
      }),
    }),
    NOW,
  );
  assert.equal(verdict.level, 'degraded');
  assert.match(verdict.reason, /pages on the second/);
});

test('customer calls failing wholesale is an outage even with a passing monitor', () => {
  // The monitor exercises four code paths and customers exercise all of them,
  // so this branch is the one that catches a regression the four steps miss.
  const verdict = classifyHealth(
    facts({ live: window({ calls: 200, successes: 60, errors: 140 }) }),
    NOW,
  );
  assert.equal(verdict.level, 'down');
  assert.match(verdict.reason, /140 of 200/);
});

test('an error rate several times baseline is amber', () => {
  const verdict = classifyHealth(
    facts({ live: window({ calls: 200, successes: 170, errors: 30 }) }),
    NOW,
  );
  assert.equal(verdict.level, 'degraded');
  assert.equal(verdict.headline, 'ERRORS UP');
});

test('a handful of calls can never move the verdict', () => {
  // Two of three failing is a coin toss, not an outage. Painting a wall red
  // for it is how a board gets ignored, so no rate is computed at all below
  // the minimum and the monitor is left to decide alone.
  const verdict = classifyHealth(
    facts({ live: window({ calls: 3, successes: 1, errors: 2 }) }),
    NOW,
  );
  assert.equal(verdict.level, 'ok');
  assert.equal(successRate({ minutes: 60, calls: 3, successes: 1, errors: 2, rateLimited: 0 }), null);
});

test('a silent monitor is reported as blindness, not as an outage', () => {
  // pg_cron, pg_net or the Edge Function being broken is a real problem and a
  // completely different one. Calling it DOWN would send someone to look at
  // the product, which is fine.
  const verdict = classifyHealth(
    facts({ monitor: monitor({ lastRunAt: minutesAgo(40), lastSuccessAt: minutesAgo(40) }) }),
    NOW,
  );
  assert.equal(verdict.level, 'degraded');
  assert.equal(verdict.headline, 'FLYING BLIND');
  assert.match(verdict.reason, /40 minutes/);
});

test('a run in flight does not count as staleness', () => {
  // `lastRunAt` comes from the newest row including a running one, because a
  // running row proves the scheduler fired even though it has no verdict yet.
  const verdict = classifyHealth(facts({ monitor: monitor({ lastRunAt: minutesAgo(1) }) }), NOW);
  assert.equal(verdict.level, 'ok');
});

test('an incident left open after recovery is amber', () => {
  const verdict = classifyHealth(facts({ monitor: monitor({ openIncidents: 1 }) }), NOW);
  assert.equal(verdict.level, 'degraded');
  assert.equal(verdict.headline, 'INCIDENT OPEN');
});

test('no witness at all is never painted green', () => {
  const verdict = classifyHealth(
    {
      monitor: monitor({ lastRunAt: null, lastStatus: null, lastSuccessAt: null, medianDurationMs: null }),
      live: window({ calls: 0, successes: 0, errors: 0 }),
      day: window({ minutes: 1440, calls: 0, successes: 0, errors: 0 }),
      lastCallAt: null,
    },
    NOW,
  );
  assert.equal(verdict.level, 'unknown');
});

test('an outage outranks every softer signal at once', () => {
  // All four amber conditions plus the red one. The board has one banner, so
  // the classifier has to return the loudest true thing rather than the first.
  const verdict = classifyHealth(
    facts({
      monitor: monitor({
        lastStatus: 'failed',
        consecutiveFailures: 3,
        failedStep: 'initialize',
        failureClass: 'mcp_protocol',
        lastRunAt: minutesAgo(30),
        openIncidents: 2,
      }),
      live: window({ calls: 200, successes: 20, errors: 180 }),
    }),
    NOW,
  );
  assert.equal(verdict.level, 'down');
  assert.equal(verdict.headline, 'SYSTEM DOWN');
});

test('minutesSince tolerates a missing or unparseable timestamp', () => {
  assert.equal(minutesSince(null, NOW), null);
  assert.equal(minutesSince('not a date', NOW), null);
  assert.equal(minutesSince(minutesAgo(7), NOW), 7);
  // Clock skew between the database and the renderer must not print a
  // negative age on a wall.
  assert.equal(minutesSince(new Date(NOW + 60_000).toISOString(), NOW), 0);
});
