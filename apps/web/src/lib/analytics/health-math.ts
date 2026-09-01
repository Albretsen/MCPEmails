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
 * WHY THE ERROR RATE IS ALSO ASKED WHOSE ERRORS THEY WERE. A rate over the
 * whole estate answers "what fraction of calls failed", which is only the same
 * question as "is the product broken" when the failures are spread. They are
 * often not: one customer's mail host refusing that customer's connections
 * produces a burst that is entirely real, entirely theirs, and large enough at
 * our volume to move the headline several points (2026-09-01, see
 * CONCENTRATION_SHARE). So the live window carries who failed as well as how
 * many, and the amber branch refuses to fire when one workspace owns the
 * failures and everyone else is demonstrably fine. It can only ever hold back
 * an amber, never a red.
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

/**
 * How much of a window's failure volume one workspace has to own before the
 * board stops reading it as a product problem.
 *
 * MEASURED, like every other number in this file. On 2026-09-01 at 16:26 UTC
 * the live window held 237 calls and 20 failures, which is 91.6% and a hair
 * above the amber line. Eight of those twenty were one inbox on one workspace
 * inside a single eight minute burst, every one of them the same repeated
 * `provider_error` against that customer's own mail host at OVH. Excluding
 * that workspace the window was 94.9%, which is an ordinary hour. So the
 * headline the room would have read was, to within a rounding error, one
 * stranger's broken mail server. On a quieter hour the same burst crosses the
 * line and turns the wall amber, and a wall that goes amber for somebody
 * else's DNS is a wall the room learns to walk past. That is the one failure
 * mode a display like this cannot survive, and it is worse than missing an
 * incident, because it also loses every future incident.
 *
 * A third, not half. Half would need one workspace to out-fail everyone else
 * combined before we discount it, which the 8-of-20 burst does not do and
 * which would leave the defect unfixed. A third is the point where the errors
 * stop being spread: three or more workspaces failing at roughly equal weight
 * is a fact about us, one workspace owning a third or more of every failure in
 * the hour is a fact about that workspace. It is only ever half of the test.
 * The other half, and the load-bearing one, is that everyone else has to be
 * demonstrably fine (see `concentratedInOneWorkspace`).
 */
export const CONCENTRATION_SHARE = 1 / 3;

/**
 * Where a window's failures actually came from.
 *
 * Null on a `CallWindow` means NOT MEASURED, which is never the same as "not
 * concentrated": the guard below refuses to fire on a null, so a read that
 * failed or a window nobody bothered to profile escalates exactly as it did
 * before this existed. Blindness must never buy silence.
 */
export type ErrorConcentration = {
  /** Distinct workspaces with at least one failed call in the window. */
  workspaces: number;
  /** Failed calls belonging to the single worst of those workspaces. */
  worstWorkspaceErrors: number;
  /**
   * The same window with that one workspace's traffic removed entirely,
   * counted in Postgres rather than subtracted here.
   *
   * Subtraction cannot do this job. We know that workspace's failures but not
   * its successes, so anything derived from the totals alone silently assumes
   * the answer: forgive its failures and a heavy, half-broken workspace makes
   * the remainder look healthier than it is, which is the exact direction that
   * hides an outage. Counted separately it is the truth, and the classifier
   * can run its ordinary rate test on it with no special arithmetic.
   *
   * Null when the fetch did not measure it (nobody dominated the window, so
   * the counterfactual was not worth three more queries) or could not.
   */
  rest: RestWindow | null;
};

/** A window with one workspace taken out, counted the same way as the whole. */
export type RestWindow = {
  calls: number;
  successes: number;
  errors: number;
};

/** Call outcomes over a window, straight out of `activity_log`. */
export type CallWindow = {
  /** How many minutes the window covers, for the label. */
  minutes: number;
  calls: number;
  successes: number;
  errors: number;
  rateLimited: number;
  /** Where the failures came from, or null when nothing measured it. */
  concentration: ErrorConcentration | null;
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

/** Why a would-be amber was held back, and the numbers behind it. */
export type ConcentrationHold = {
  /** Failed calls owned by the single worst workspace. */
  worstWorkspaceErrors: number;
  /** Distinct workspaces that failed at all in the window. */
  workspaces: number;
  /** Success rate of every other workspace put together, as a fraction. */
  restRate: number;
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
  /**
   * Set ONLY when the error-rate witness would have escalated and was held
   * back because one workspace owned the failures.
   *
   * It exists because the alarm banner does not render on a green verdict, so
   * on this path the reason string never reaches the wall. The tile carries it
   * instead, which is also where it belongs: the tile is what shows 91.6% in
   * calm green, and a percentage that looks wrong needs its explanation
   * beside it rather than in a JSON payload nobody is reading. The tile takes
   * the numbers and not the judgement, so the decision stays in one place.
   */
  concentration?: ConcentrationHold;
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

/**
 * Is this window's failure volume one workspace's problem rather than ours?
 *
 * Two tests, and both have to pass, because either one alone gets it wrong.
 *
 * CONCENTRATION alone would suppress the wrong thing. A window at 89.6% with
 * twenty-six failures spread thin still has SOME worst workspace, and letting
 * "worst" mean "to blame" would hand every broad, shallow degradation an
 * excuse. Hence the share test: one workspace has to own at least a third of
 * the failures before it is even a candidate.
 *
 * THE COUNTERFACTUAL alone would suppress too eagerly in the other direction.
 * Remove any single workspace from a genuinely sick hour and the remainder is
 * usually still sick, so this is the test that does the real work: it asks
 * whether the product, with that account taken out, is a product anyone would
 * walk over for. It is answered from separately counted traffic, not from
 * subtraction, for the reason on `ErrorConcentration.rest`.
 *
 * WHAT IT REFUSES TO DO. It returns null for every case it cannot settle,
 * including a window it could not profile and a remainder too small to have a
 * rate at all (fewer than MIN_LIVE_CALLS calls once the workspace is out, so
 * one customer WAS most of the hour and the honest answer is that we cannot
 * tell). Null means the classifier escalates exactly as it did before this
 * function existed. "We cannot tell" must never render as "we are fine", which
 * is the same rule the whole health read is built on.
 *
 * IT IS NEVER CONSULTED ON THE WAY TO `down`, on purpose. See classifyHealth.
 */
export function concentratedInOneWorkspace(live: CallWindow): ConcentrationHold | null {
  const concentration = live.concentration;
  if (!concentration || !concentration.rest) return null;
  if (live.errors <= 0) return null;

  // Share test. One workspace has to own a third or more of the hour's
  // failures before its bad afternoon is allowed to explain the headline.
  if (concentration.worstWorkspaceErrors < live.errors * CONCENTRATION_SHARE) return null;

  // The counterfactual, run through the same rate test the board uses on
  // everything else so the two can never disagree about what healthy means.
  const rest: CallWindow = {
    minutes: live.minutes,
    calls: concentration.rest.calls,
    successes: concentration.rest.successes,
    errors: concentration.rest.errors,
    // Not measured for the remainder, and not needed: nothing below reads it.
    // Rate limited calls have never been recorded in production anyway.
    rateLimited: 0,
    concentration: null,
  };
  const restRate = successRate(rest);
  if (restRate === null) return null;
  if (restRate < DEGRADED_SUCCESS_RATE) return null;

  return {
    worstWorkspaceErrors: concentration.worstWorkspaceErrors,
    workspaces: concentration.workspaces,
    restRate,
  };
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
 *
 * WHY CONCENTRATION CANNOT SUPPRESS `down`, AND ONLY EVER AMBER. Both DOWN
 * branches sit above the guard and never read it. That is a deliberate
 * asymmetry rather than an oversight, for three reasons.
 *
 * The costs are not symmetric. A guard that can turn amber into green costs at
 * worst a slower walk to the wall, and the monitor is still watching from the
 * other side. A guard that can turn red into green costs an outage that nobody
 * looked at, which is the failure this whole module exists to prevent. When
 * one direction of a mistake is recoverable and the other is not, the
 * machinery only gets to operate in the recoverable direction.
 *
 * The arithmetic says the same thing. `down` needs more than half of every
 * call in the hour to fail. For one workspace to produce that it has to be
 * making more than half of the product's live traffic, and at that point its
 * experience IS the product's reliability, whoever is behind it. A window
 * where one account is the majority of usage and the majority of failures is
 * not a window this board should be quietly reassuring about.
 *
 * And the guard leans on data that DOWN is least able to trust. The
 * concentration read is a second query with its own ways of being wrong or
 * missing. Amber can afford to be decided by that. Red is the state a wall
 * display exists to reach, and it answers to the two witnesses alone.
 */
export function classifyHealth(facts: HealthFacts, now: number = Date.now()): HealthVerdict {
  const { monitor, live } = facts;
  const monitorFailing = monitor.lastStatus === 'failed' || monitor.lastStatus === 'internal_error';
  const immediate =
    monitor.failureClass !== null &&
    (IMMEDIATE_FAILURE_CLASSES as readonly string[]).includes(monitor.failureClass);
  const rate = successRate(live);
  const staleMinutes = minutesSince(monitor.lastRunAt, now);

  // Computed once, consulted twice: by the error-rate amber branch that it
  // holds back, and by the green verdict that then has to explain itself. It
  // is only computed for a window that would otherwise escalate, so a healthy
  // hour never carries a concentration note it does not need.
  const hold =
    rate !== null && rate < DEGRADED_SUCCESS_RATE ? concentratedInOneWorkspace(live) : null;

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
  //
  // Unless one workspace owns the failures and everyone else is fine, in which
  // case the number is real and the conclusion would not have been. The board
  // escalates on what is wrong with the PRODUCT; a customer's own mail host
  // refusing that customer's connections is a support ticket, and it is not
  // improved by being on a wall in a different building.
  if (rate !== null && rate < DEGRADED_SUCCESS_RATE && !hold) {
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

  // GREEN, but with a percentage on the tile that does not look green. Said in
  // full, and said as something to act on: whoever reads it should come away
  // knowing which account to open, not merely that they were told to relax.
  if (hold) {
    return {
      level: 'ok',
      headline: 'ALL GREEN',
      reason: `One workspace produced ${hold.worstWorkspaceErrors} of the ${live.errors} failed calls in the last ${live.minutes} minutes. Every other workspace together is at ${percent(hold.restRate)}, so this is that one account's mail provider and not the product. The synthetic checks pass.`,
      since: null,
      concentration: hold,
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

/** A fraction as a one decimal percentage, for a sentence rather than a tile. */
function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
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
