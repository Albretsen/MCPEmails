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
  type ErrorConcentration,
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
  return { minutes: 60, calls: 250, successes: 247, errors: 3, rateLimited: 0, concentration: null, ...overrides };
}

/**
 * An error profile for a window.
 *
 * `concentration: null` on a window means NOT MEASURED, and several tests
 * below turn on the difference between that and a measured "nobody dominated",
 * so it is spelled out here rather than defaulted into existence.
 */
function concentration(overrides: Partial<ErrorConcentration> = {}): ErrorConcentration {
  return { workspaces: 5, worstWorkspaceErrors: 8, rest: null, ...overrides };
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

/* ------------------------------------------------ one workspace, not the product */

/**
 * The window that started this, exactly as production held it.
 *
 * 2026-09-01 16:26 UTC: 237 calls, 20 failures, 91.6%, a hair the right side
 * of the amber line. Eight of the twenty were one inbox on one workspace in a
 * single eight minute burst, all of them the same repeated `provider_error`
 * against that customer's own mail host. Nothing was wrong with the product.
 *
 * This case never needed the guard: the arithmetic was already green. It is
 * pinned because it is the shape the guard was calibrated against, and because
 * the guard must not have made it LOUDER. The one that matters is the test
 * below it, which is the same burst on an hour with a quarter of the traffic.
 */
test('the 2026-09-01 16:26 window is green and needs no help to be', () => {
  const verdict = classifyHealth(
    facts({
      live: window({
        calls: 237,
        successes: 217,
        errors: 20,
        concentration: concentration({
          workspaces: 5,
          worstWorkspaceErrors: 8,
          rest: { calls: 229, successes: 217, errors: 12, rateLimited: 0 },
        }),
      }),
    }),
    NOW,
  );
  assert.equal(verdict.level, 'ok');
  // No note on the tile, because the number does not need defending: it is
  // above the line on its own and the caption would be noise.
  assert.equal(verdict.concentration, undefined);
});

test('one workspace hammering its own mail host does not paint the board amber', () => {
  // The same eight failure burst on a 03:00 hour: 60 calls, 83.3%, deep into
  // amber, and eight of the ten failures are one account. Everyone else is at
  // 96.2%, which is an ordinary night. This is the case the board got wrong
  // and the reason the guard exists: escalating here teaches the room that the
  // wall goes amber for other people's DNS, and a room that has learned that
  // will walk past the real one.
  const verdict = classifyHealth(
    facts({
      live: window({
        calls: 60,
        successes: 50,
        errors: 10,
        concentration: concentration({
          workspaces: 3,
          worstWorkspaceErrors: 8,
          rest: { calls: 52, successes: 50, errors: 2, rateLimited: 0 },
        }),
      }),
    }),
    NOW,
  );
  assert.equal(verdict.level, 'ok');
  // And it says so in words a person can act on, naming the account rather
  // than reassuring them in the abstract.
  assert.match(verdict.reason, /One workspace produced 8 of the 10 failed calls/);
  assert.match(verdict.reason, /96\.2%/);
  assert.equal(verdict.concentration?.worstWorkspaceErrors, 8);
});

test('the same failures spread across the estate are still amber', () => {
  // Identical hour, identical failure count, nobody dominating. This is the
  // half of the defect that must not have moved: ten failures out of sixty
  // calls, spread over nine workspaces, is the product.
  const verdict = classifyHealth(
    facts({
      live: window({
        calls: 60,
        successes: 50,
        errors: 10,
        concentration: concentration({ workspaces: 9, worstWorkspaceErrors: 2, rest: null }),
      }),
    }),
    NOW,
  );
  assert.equal(verdict.level, 'degraded');
  assert.equal(verdict.headline, 'ERRORS UP');
});

test('a dominant workspace cannot excuse an estate that is also failing', () => {
  // One workspace owns 15 of 39 failures, so it passes the share test. The
  // other 24 failures leave everyone else at 89.8%, which is amber on its own
  // merits. The counterfactual is the load-bearing half of the guard: without
  // it, any hour with a loud workspace in it would be excused.
  const verdict = classifyHealth(
    facts({
      live: window({
        calls: 250,
        successes: 211,
        errors: 39,
        concentration: concentration({
          workspaces: 11,
          worstWorkspaceErrors: 15,
          rest: { calls: 235, successes: 211, errors: 24, rateLimited: 0 },
        }),
      }),
    }),
    NOW,
  );
  assert.equal(verdict.level, 'degraded');
  assert.equal(verdict.headline, 'ERRORS UP');
});

test('concentration can never suppress an outage', () => {
  // Built so that every condition of the guard is satisfied: one workspace
  // owns 100 of the 105 failures and everyone else is at 94.4%. The window is
  // still 47.5%, which is DOWN, and DOWN is decided above the guard and never
  // consults it. A workspace big enough to fail half the product's traffic IS
  // the product's reliability that hour, and the direction of a mistake here
  // is not recoverable: an amber wrongly held costs a slower walk to the wall,
  // a red wrongly held costs the outage nobody looked at.
  const verdict = classifyHealth(
    facts({
      live: window({
        calls: 200,
        successes: 95,
        errors: 105,
        concentration: concentration({
          workspaces: 4,
          worstWorkspaceErrors: 100,
          rest: { calls: 90, successes: 85, errors: 5, rateLimited: 0 },
        }),
      }),
    }),
    NOW,
  );
  assert.equal(verdict.level, 'down');
  assert.equal(verdict.headline, 'CALLS FAILING');
});

test('a broad outage reaches down with the concentration read in hand', () => {
  // The thing a concentration guard is most at risk of masking, which is why
  // it is asserted rather than assumed: a real outage fails everyone at once,
  // so the errors are spread over the whole estate and no workspace is
  // anywhere near a third of them.
  const verdict = classifyHealth(
    facts({
      live: window({
        calls: 200,
        successes: 60,
        errors: 140,
        concentration: concentration({ workspaces: 31, worstWorkspaceErrors: 12, rest: null }),
      }),
    }),
    NOW,
  );
  assert.equal(verdict.level, 'down');
});

test('an unmeasured window escalates exactly as it did before', () => {
  // `concentration: null` is "nobody looked", never "nobody dominated": the
  // profiling query failed, or the window held more failures than we will pull
  // back. Blindness must not buy silence, which is the same rule the rest of
  // this board runs on.
  const verdict = classifyHealth(
    facts({ live: window({ calls: 60, successes: 50, errors: 10, concentration: null }) }),
    NOW,
  );
  assert.equal(verdict.level, 'degraded');
  assert.equal(verdict.headline, 'ERRORS UP');
});

test('a remainder too small to judge is not evidence of health', () => {
  // One workspace WAS the hour: 25 of the 40 calls. Fifteen calls left over
  // cannot carry a rate (the same MIN_LIVE_CALLS floor the headline obeys),
  // so there is no counterfactual and nothing to hold the amber back with.
  const verdict = classifyHealth(
    facts({
      live: window({
        calls: 40,
        successes: 28,
        errors: 12,
        concentration: concentration({
          workspaces: 2,
          worstWorkspaceErrors: 11,
          rest: { calls: 15, successes: 14, errors: 1, rateLimited: 0 },
        }),
      }),
    }),
    NOW,
  );
  assert.equal(verdict.level, 'degraded');
  assert.equal(verdict.headline, 'ERRORS UP');
});

test('a held amber still loses to a louder true thing', () => {
  // The guard removes one reason to escalate, not the ordering. An open
  // monitor incident is a different witness saying something else, and it
  // still gets the banner.
  const verdict = classifyHealth(
    facts({
      monitor: monitor({ openIncidents: 1 }),
      live: window({
        calls: 60,
        successes: 50,
        errors: 10,
        concentration: concentration({
          workspaces: 3,
          worstWorkspaceErrors: 8,
          rest: { calls: 52, successes: 50, errors: 2, rateLimited: 0 },
        }),
      }),
    }),
    NOW,
  );
  assert.equal(verdict.level, 'degraded');
  assert.equal(verdict.headline, 'INCIDENT OPEN');
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
  assert.equal(
    successRate({ minutes: 60, calls: 3, successes: 1, errors: 2, rateLimited: 0, concentration: null }),
    null,
  );
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

/* ------------------------------------------------- rate-limited is not failure */

/**
 * The 2026-09-03 kiosk bug: a workspace stuck retrying against its own usage
 * cap put 40% of an hour's calls in `rate_limited`, and the headline divided
 * by raw `calls` anyway, reading 56.7% while every call that was actually
 * attempted succeeded. Numbers are the production window from the report.
 */
test('rate-limited calls do not drag down the success rate', () => {
  assert.equal(
    successRate({ minutes: 60, calls: 654, successes: 371, errors: 23, rateLimited: 260, concentration: null }),
    371 / 394,
  );
  assert.ok(
    (successRate({ minutes: 60, calls: 654, successes: 371, errors: 23, rateLimited: 260, concentration: null }) ?? 0)
      > 0.9,
    'excluding the capped calls should read as a healthy hour, not a degraded one',
  );
});

test('a window that is almost entirely rate-limited still needs enough real attempts', () => {
  // 30 calls, but 25 of them never reached a tool. Fifteen real attempts is
  // below MIN_LIVE_CALLS, so this must read null exactly like too few raw
  // calls does, not fall back to a rate computed on five successes and zero
  // errors.
  assert.equal(
    successRate({ minutes: 60, calls: 30, successes: 5, errors: 0, rateLimited: 25, concentration: null }),
    null,
  );
});

test('a workspace looping on its own cap does not paint the board amber', () => {
  const verdict = classifyHealth(
    facts({
      live: window({ calls: 654, successes: 371, errors: 23, rateLimited: 260 }),
    }),
    NOW,
  );
  assert.equal(verdict.level, 'ok');
});

test('minutesSince tolerates a missing or unparseable timestamp', () => {
  assert.equal(minutesSince(null, NOW), null);
  assert.equal(minutesSince('not a date', NOW), null);
  assert.equal(minutesSince(minutesAgo(7), NOW), 7);
  // Clock skew between the database and the renderer must not print a
  // negative age on a wall.
  assert.equal(minutesSince(new Date(NOW + 60_000).toISOString(), NOW), 0);
});
