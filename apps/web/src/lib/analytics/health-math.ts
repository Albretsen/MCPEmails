/**
 * Deciding whether the product is up, from two independent witnesses.
 *
 * This module is pure so the decision can be unit tested, and separate from
 * kiosk-health.ts so the fetching can change without the judgement changing.
 *
 * WHY TWO WITNESSES AND NOT ONE.
 *
 * The synthetic monitor (`synthetic_monitor_runs`, every five minutes, four
 * steps against the real public MCP endpoint) is the only thing that can tell
 * an outage from an empty room. Customer traffic cannot: zero calls at 03:00
 * looks exactly like zero calls during a total outage, and at our volume a
 * quiet hour is normal. The monitor answers "does the product respond".
 *
 * Customer traffic (`activity_log` over the last hour) is the only thing that
 * can see failures the monitor's four steps do not touch: a provider that
 * started rejecting one auth type, a tool that regressed, a mailbox size that
 * now blows a timeout. The monitor answers for four code paths; the error rate
 * answers for all of them. So the monitor decides UP or DOWN and the error
 * rate decides HEALTHY or DEGRADED, and either can escalate on its own.
 *
 * THE THRESHOLDS ARE CALIBRATED, NOT PICKED. Measured 2026-08-30 over live
 * production: about 250 calls an hour, a 1 to 2 percent error rate over a day
 * and 4 percent over a week (the week includes a since-fixed connect bug), and
 * zero rate-limited calls ever. So 10 percent errors is a five to ten times
 * deterioration and is worth an amber; half the calls failing is not a bad
 * afternoon, it is a broken deploy. Both are gated on a minimum call count,
 * because "1 of 2 calls failed" is a coin toss and painting a wall display red
 * for it is how a board gets ignored.
 *
 * WHY THE MONITOR'S OWN URGENCY RULE IS COPIED HERE. The pager escalates on
 * the first failure for `authentication`, `mcp_protocol` and `internal`, and
 * waits for two consecutive failures for everything else, because those three
 * classes cannot be caused by someone else's flaky network. This board must
 * not disagree with the pager: a screen that says DOWN while nobody was paged,
 * or stays green through an incident that woke someone at 04:00, teaches the
 * room to trust neither. See project_synthetic_monitor_alerting.
 */

/** The four states the board can be in. Ordered by how loud they are. */
export type HealthLevel = 'ok' | 'degraded' | 'down' | 'unknown';

/**
 * Failure classes the monitor pages on immediately rather than after two
 * consecutive runs. Copied from `record_synthetic_monitor_failure`; the
 * comment above says why it must stay copied rather than relaxed.
 */
export const IMMEDIATE_FAILURE_CLASSES = ['authentication', 'mcp_protocol', 'internal'] as const;

/**
 * Below this many calls in the live window no percentage is computed at all.
 * Twenty is roughly five minutes of normal traffic, and the point where one
 * unlucky mailbox stops being able to move the headline by ten points.
 */
export const MIN_LIVE_CALLS = 20;

/** Success rate under this, with enough calls, is an outage rather than a bad patch. */
export const DOWN_SUCCESS_RATE = 0.5;

/** Success rate under this, with enough calls, is worth walking over for. */
export const DEGRADED_SUCCESS_RATE = 0.9;

/**
 * Minutes without a monitor run before the board says so.
 *
 * The cron fires every five, so twelve is two missed runs plus slack for a run
 * that took its full 30 second budget. A silent monitor is NOT reported as an
 * outage: it means pg_cron, pg_net or the Edge Function is broken, which is a
 * real problem and a completely different one. Reporting blindness as an
 * outage would send someone to look at the wrong system.
 */
export const MONITOR_STALE_MINUTES = 12;

/** Call outcomes over a window, straight out of `activity_log`. */
export type CallWindow = {
  /** How many minutes the window covers, for the label. */
  minutes: number;
  calls: number;
  successes: number;
  errors: number;
  rateLimited: number;
};

/** What the synthetic monitor knows about itself. */
export type MonitorFacts = {
  lastRunAt: string | null;
  lastStatus: 'running' | 'succeeded' | 'failed' | 'internal_error' | null;
  lastSuccessAt: string | null;
  /** Consecutive non-successful runs at the head of the history, newest first. */
  consecutiveFailures: number;
  failedStep: string | null;
  failureClass: string | null;
  /** Median duration of the recent successful runs, for the slow-but-up case. */
  medianDurationMs: number | null;
  /** Incidents the monitor has opened and not yet resolved. */
  openIncidents: number;
};

/** Everything the classifier is allowed to look at. */
export type HealthFacts = {
  monitor: MonitorFacts;
  live: CallWindow;
  day: CallWindow;
  /** Newest `activity_log` row, or null when the table is empty. */
  lastCallAt: string | null;
};

/** The classifier's verdict, plus the words the board puts on the wall. */
export type HealthVerdict = {
  level: HealthLevel;
  /** Two or three words, upper case, readable from across the room. */
  headline: string;
  /** One sentence naming what is wrong, or confirming what is right. */
  reason: string;
  /** When the trouble started, ISO, for "since 11:20". Null when nothing is wrong. */
  since: string | null;
};

/** The whole payload the API hands the board. */
export type SystemHealth = HealthFacts & HealthVerdict & {
  /** When this snapshot was taken, ISO. The board ages it on screen. */
  checkedAt: string;
};

/** Success rate over a window, or null when there is not enough to divide. */
export function successRate(window: CallWindow): number | null {
  if (window.calls < MIN_LIVE_CALLS) return null;
  return window.successes / window.calls;
}

/** Whole minutes between an ISO timestamp and now. Null for a missing or unparseable one. */
export function minutesSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((now - then) / 60_000));
}

/**
 * The verdict.
 *
 * Ordered by loudness, and every branch returns the LOUDEST thing that is
 * true, because the board has one banner and a wall display that reports the
 * second most urgent fact is worse than one that reports nothing. The reason
 * string always names the witness, so whoever walks over knows which system to
 * open first.
 */
export function classifyHealth(facts: HealthFacts, now: number = Date.now()): HealthVerdict {
  const { monitor, live } = facts;
  const monitorFailing = monitor.lastStatus === 'failed' || monitor.lastStatus === 'internal_error';
  const immediate =
    monitor.failureClass !== null &&
    (IMMEDIATE_FAILURE_CLASSES as readonly string[]).includes(monitor.failureClass);
  const rate = successRate(live);
  const staleMinutes = minutesSince(monitor.lastRunAt, now);

  // Nothing to judge on. Only reachable before the monitor's first ever run or
  // when the query that feeds it failed, and it must not be painted green: an
  // unattended board that cannot tell up from down has to say so.
  if (!monitor.lastRunAt && facts.live.calls === 0) {
    return {
      level: 'unknown',
      headline: 'NO SIGNAL',
      reason: 'Neither the synthetic monitor nor customer traffic reported anything.',
      since: null,
    };
  }

  // DOWN, witness one: the monitor, using the pager's own urgency rule.
  if (monitorFailing && (monitor.consecutiveFailures >= 2 || immediate)) {
    return {
      level: 'down',
      headline: 'SYSTEM DOWN',
      reason: monitorReason(monitor),
      since: monitor.lastSuccessAt,
    };
  }

  // DOWN, witness two: real calls failing at a rate no deploy survives.
  if (rate !== null && rate < DOWN_SUCCESS_RATE) {
    return {
      level: 'down',
      headline: 'CALLS FAILING',
      reason: `${live.errors} of ${live.calls} customer calls failed in the last ${live.minutes} minutes.`,
      since: null,
    };
  }

  // DEGRADED: one monitor failure of a class that can be someone else's
  // network. The pager waits for a second run before waking anyone and so does
  // the wording here, but the board still shows it, because the whole point of
  // a wall display is to see the first strike as well as the second.
  if (monitorFailing) {
    return {
      level: 'degraded',
      headline: 'CHECK FAILED',
      reason: `${monitorReason(monitor)} One run only; the monitor pages on the second.`,
      since: monitor.lastSuccessAt,
    };
  }

  // DEGRADED: the monitor stopped reporting. Blind, not down. Named as the
  // monitor's problem so nobody goes looking at the product first.
  if (staleMinutes !== null && staleMinutes >= MONITOR_STALE_MINUTES) {
    return {
      level: 'degraded',
      headline: 'FLYING BLIND',
      reason: `The synthetic monitor has not run for ${staleMinutes} minutes. It is scheduled every 5.`,
      since: monitor.lastRunAt,
    };
  }

  // DEGRADED: error rate several times its baseline, monitor still passing.
  // This is the case the monitor structurally cannot see, since its four steps
  // exercise four code paths and customers exercise all of them.
  if (rate !== null && rate < DEGRADED_SUCCESS_RATE) {
    return {
      level: 'degraded',
      headline: 'ERRORS UP',
      reason: `${live.errors} of ${live.calls} customer calls failed in the last ${live.minutes} minutes. The monitor still passes.`,
      since: null,
    };
  }

  // DEGRADED: an incident is open with no failing run behind it any more. The
  // monitor resolves its own incidents on the next good run, so this is the
  // narrow window between recovery and bookkeeping, or a stuck incident.
  if (monitor.openIncidents > 0) {
    return {
      level: 'degraded',
      headline: 'INCIDENT OPEN',
      reason: `${monitor.openIncidents} monitor incident${monitor.openIncidents === 1 ? '' : 's'} still open, latest run passed.`,
      since: null,
    };
  }

  return {
    level: 'ok',
    headline: 'ALL GREEN',
    reason: rate === null
      ? 'Every synthetic check is passing.'
      : `Every synthetic check is passing and ${live.successes} of ${live.calls} customer calls succeeded.`,
    since: null,
  };
}

/** The failing step and class, said the way a person would say it. */
function monitorReason(monitor: MonitorFacts): string {
  const step = monitor.failedStep ? STEP_LABELS[monitor.failedStep] ?? monitor.failedStep : 'a check';
  const cause = monitor.failureClass ? CLASS_LABELS[monitor.failureClass] ?? monitor.failureClass : 'unknown cause';
  const runs = monitor.consecutiveFailures > 1 ? ` for ${monitor.consecutiveFailures} runs` : '';
  return `The public MCP endpoint is failing at ${step}${runs} (${cause}).`;
}

/** Monitor step ids as a sentence fragment. */
const STEP_LABELS: Record<string, string> = {
  initialize: 'the handshake',
  tools_list: 'the tool list',
  inbox_list: 'listing inboxes',
  email_read: 'reading mail',
  incident_alert: 'sending the alert',
  recovery_alert: 'sending the all-clear',
  internal: 'the monitor itself',
};

/** Failure classes as a cause a person can act on. */
const CLASS_LABELS: Record<string, string> = {
  public_endpoint: 'the site did not answer',
  authentication: 'the API key was rejected',
  mcp_protocol: 'a malformed MCP response',
  database: 'the database',
  provider_read: 'the mail provider',
  alert_delivery: 'alert email',
  internal: 'an error inside the monitor',
};
