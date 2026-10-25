/**
 * The first-30-days dispatcher's own switch from dry run to live.
 *
 * Owner decision 2026-10-24: keep the dry run, and switch live automatically
 * on 2026-10-28 if the dry run meets the written criteria below; otherwise
 * stay in dry run and alert. Migration: 20261025040000_first30_auto_go_live.sql.
 *
 * MODE, READ AT CALL TIME (resolveFirst30Mode):
 *   FIRST30_ENABLED   unless `on`, off. Gates everything, as before.
 *   FIRST30_DRY_RUN   `false` (or `off`) forces live, any other non-empty
 *                     value forces dry run. Emergency overrides only.
 *   unset             retention_switches('first30').mode decides.
 *   DB unreadable     dry run. Never live by accident.
 *
 * EVERY DRY RUN LOGS (first30_dry_run_log): one row per candidate decision,
 * one 'run_summary' row per run (empty runs too, and runs that threw), and
 * once per UTC day a 'mailbox_probe' row from an IMAP login to the internal
 * draft mailbox (LIST + SELECT Drafts + LOGOUT, never APPEND). No email
 * addresses: recipient_matches_owner is a boolean worked out at decision time.
 * Live runs log nothing. Rows older than 60 days are deleted each run.
 *
 * THE DECISION. On the first run at or after auto_go_live_at, while the row is
 * in dry run with no decision and no env override is set, the log since
 * FIRST30_START_AT is evaluated by evaluateGoLive(). The result is written
 * with a conditional update (`WHERE decision IS NULL AND mode = 'dry_run'`),
 * so of two overlapping runs only one decides, and only that one sends the
 * single internal email (to the draft mailbox, never a customer). Pass: mode
 * 'live', decision 'went_live'. Fail: mode stays 'dry_run', decision 'held',
 * detail lists every failed criterion. A decided row is never decided again
 * automatically; the admin page shows the one SQL statement that re-arms it.
 */

import { randomUUID } from 'node:crypto';

import {
  DAY,
  TEMPLATE_STUCK,
  TEMPLATE_WEEK1,
  first30Mode,
  ms,
  runFirst30,
  type DecisionRecord,
  type DraftWriter,
  type First30Mode,
  type First30Store,
  type RunMode,
  type RunReport,
  type Sender,
} from '@/lib/retention/first-30-days';

// ---------------------------------------------------------------------------
// The criteria
// ---------------------------------------------------------------------------

/**
 * All must hold for the automatic switch to live. Zero candidates is fine
 * (expected early): b and c pass trivially, a, d and e still have to hold.
 *
 *   a. steady_operation  at least 24 clean dry runs logged since
 *                        FIRST30_START_AT, AND clean runs >= 90% of the whole
 *                        hours between START_AT (or the first logged run, if
 *                        later) and evaluation, AND no gap over 2 hours
 *                        between clean runs in the last 24 hours (so lost
 *                        runs, which leave no row, are seen), AND zero runs
 *                        with failed > 0, an uncaught error or a truncated
 *                        (out of time) loop. Manual ?dry_run=1 runs do not
 *                        count either way.
 *   b. right_recipients  every would-draft / would-send / would-holdout entry
 *                        has recipient_matches_owner = true, a first_paid_at
 *                        at or after FIRST30_START_AT, a non-internal owner and
 *                        an active subscription at decision time.
 *   c. idempotent        no workspace appears twice for the same template as a
 *                        would-* entry within one run. Across runs the dry run
 *                        repeats a due workspace every hour (nothing is
 *                        claimed in a dry run, so the ledger never stops it);
 *                        volumes in d therefore count DISTINCT workspaces,
 *                        which is what the ledger would let through live.
 *   d. volumes           distinct would-draft (M2) workspaces <= 10; distinct
 *                        M3 workspaces (would-send plus would-holdout) == 0
 *                        when evaluated before FIRST30_START_AT + 8 days
 *                        (M3 cannot be due yet), else <= 40.
 *   e. mailbox_probe     at least one successful probe of the internal draft
 *                        mailbox in the 24 hours before evaluation.
 */
export const GO_LIVE_CRITERIA = {
  minCompletedRuns: 24,
  minHourlyCoverage: 0.9,
  maxGapMs: 2 * 3_600_000,
  gapWindowMs: DAY,
  maxStuckDraftWorkspaces: 10,
  week1EarliestAfterStartMs: 8 * DAY,
  maxWeek1Workspaces: 40,
  probeWindowMs: DAY,
} as const;

export const CRITERIA_TEXT: Record<CriterionId, string> = {
  steady_operation:
    'a. At least 24 clean dry runs since FIRST30_START_AT, clean runs >= 90% of whole hours elapsed since START_AT (or the first logged run, if later), no gap over 2 hours in the last 24 hours, and zero runs with failed > 0, an uncaught error or a truncated loop. Manual runs do not count.',
  right_recipients:
    'b. Every would-draft / would-send entry has recipient_matches_owner = true, first_paid_at >= FIRST30_START_AT, a non-internal owner and an active subscription at decision time.',
  idempotent: 'c. No workspace counted twice for the same template within one run (at most one distinct workspace per template).',
  volumes:
    'd. Distinct would-draft (M2) workspaces <= 10; M3 workspaces == 0 before FIRST30_START_AT + 8 days, else <= 40.',
  mailbox_probe: 'e. At least one successful probe of the internal draft mailbox in the last 24 hours.',
};

export type CriterionId = 'steady_operation' | 'right_recipients' | 'idempotent' | 'volumes' | 'mailbox_probe';

export interface EvidenceRun {
  runId: string;
  runAt: string;
  failed: number;
  error: string | null;
  /** The loop ran out of time before every candidate was decided. */
  truncated?: boolean;
  /** A manual ?dry_run=1 call: ignored by criterion a. */
  forced?: boolean;
}

export interface EvidenceAction {
  runId: string;
  workspaceId: string;
  template: string;
  decision: 'would_draft' | 'would_send' | 'would_holdout';
  recipientMatchesOwner: boolean | null;
  firstPaidAt: string | null;
  ownerInternal: boolean | null;
  subscriptionActive: boolean | null;
}

export interface EvidenceProbe {
  runAt: string;
  ok: boolean;
}

export interface Evidence {
  now: string;
  startAt: string;
  runs: EvidenceRun[];
  actions: EvidenceAction[];
  probes: EvidenceProbe[];
}

export interface CriterionResult {
  id: CriterionId;
  pass: boolean;
  detail: string;
}

export interface GoLiveResult {
  pass: boolean;
  criteria: CriterionResult[];
  counts: {
    completedRuns: number;
    badRuns: number;
    expectedHours: number;
    maxGapHours: number;
    stuckDraftWorkspaces: number;
    week1Workspaces: number;
    actionRows: number;
    lastProbeOkAt: string | null;
  };
}

/** Pure. Every criterion is evaluated, so a 'held' detail lists every failure. */
export function evaluateGoLive(evidence: Evidence): GoLiveResult {
  const C = GO_LIVE_CRITERIA;
  const nowMs = ms(evidence.now);
  const startMs = ms(evidence.startAt);
  const runs = evidence.runs.filter((r) => !r.forced && ms(r.runAt) >= startMs && ms(r.runAt) <= nowMs);
  const actions = evidence.actions;

  // a.
  const isBad = (r: EvidenceRun) => !!r.error || r.failed > 0 || !!r.truncated;
  const clean = runs.filter((r) => !isBad(r)).sort((x, y) => ms(x.runAt) - ms(y.runAt));
  const completed = clean.length;
  const bad = runs.filter(isBad).length;
  const firstRunMs = runs.length ? Math.min(...runs.map((r) => ms(r.runAt))) : nowMs;
  const windowStart = Math.max(startMs, firstRunMs);
  const expectedHours = Math.max(0, Math.floor((nowMs - windowStart) / HOUR_MS));
  const coverageNeed = Math.ceil(expectedHours * C.minHourlyCoverage);
  const maxGapMs = longestGap(clean.map((r) => ms(r.runAt)), nowMs - C.gapWindowMs, nowMs);
  const maxGapHours = Math.round((maxGapMs / HOUR_MS) * 10) / 10;
  const a: CriterionResult = {
    id: 'steady_operation',
    pass: completed >= C.minCompletedRuns && completed >= coverageNeed && maxGapMs <= C.maxGapMs && bad === 0,
    detail: `${completed} clean runs (need ${Math.max(C.minCompletedRuns, coverageNeed)}: 24 and 90% of ${expectedHours} hours), longest gap in the last 24h ${maxGapHours}h (max 2h), ${bad} failed, errored or truncated (need 0)`,
  };

  // b.
  const wrong = actions.filter(
    (x) =>
      x.recipientMatchesOwner !== true ||
      !(ms(x.firstPaidAt) >= startMs) ||
      x.ownerInternal !== false ||
      x.subscriptionActive !== true,
  );
  const b: CriterionResult = {
    id: 'right_recipients',
    pass: wrong.length === 0,
    detail:
      wrong.length === 0
        ? `${actions.length} would-* entries, all to the current owner, paid after go-live, external, subscribed`
        : `${wrong.length} of ${actions.length} would-* entries fail: ${summariseWrong(wrong, startMs)}`,
  };

  // c.
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const x of actions) {
    const key = `${x.runId}|${x.template}|${x.workspaceId}`;
    if (seen.has(key)) dupes.add(`${x.template}:${x.workspaceId.slice(0, 8)}`);
    seen.add(key);
  }
  const c: CriterionResult = {
    id: 'idempotent',
    pass: dupes.size === 0,
    detail: dupes.size === 0 ? 'no workspace twice per template within a run' : `duplicates within a run: ${[...dupes].join(', ')}`,
  };

  // d.
  const stuckWs = new Set(actions.filter((x) => x.template === TEMPLATE_STUCK && x.decision === 'would_draft').map((x) => x.workspaceId));
  const week1Ws = new Set(actions.filter((x) => x.template === TEMPLATE_WEEK1).map((x) => x.workspaceId));
  const week1Possible = nowMs >= startMs + C.week1EarliestAfterStartMs;
  const week1Max = week1Possible ? C.maxWeek1Workspaces : 0;
  const d: CriterionResult = {
    id: 'volumes',
    pass: stuckWs.size <= C.maxStuckDraftWorkspaces && week1Ws.size <= week1Max,
    detail: `${stuckWs.size} M2 workspaces (max ${C.maxStuckDraftWorkspaces}), ${week1Ws.size} M3 workspaces (max ${week1Max}${week1Possible ? '' : ', M3 cannot be due yet'})`,
  };

  // e.
  const okProbes = evidence.probes
    .filter((p) => p.ok && ms(p.runAt) <= nowMs && ms(p.runAt) > nowMs - C.probeWindowMs)
    .sort((x, y) => ms(y.runAt) - ms(x.runAt));
  const lastOkEver = evidence.probes.filter((p) => p.ok).sort((x, y) => ms(y.runAt) - ms(x.runAt))[0]?.runAt ?? null;
  const e: CriterionResult = {
    id: 'mailbox_probe',
    pass: okProbes.length > 0,
    detail: okProbes.length > 0 ? `last successful probe ${okProbes[0].runAt}` : `no successful probe in the last 24 hours (last ever: ${lastOkEver ?? 'none'})`,
  };

  const criteria = [a, b, c, d, e];
  return {
    pass: criteria.every((x) => x.pass),
    criteria,
    counts: {
      completedRuns: completed,
      badRuns: bad,
      expectedHours,
      maxGapHours,
      stuckDraftWorkspaces: stuckWs.size,
      week1Workspaces: week1Ws.size,
      actionRows: actions.length,
      lastProbeOkAt: lastOkEver,
    },
  };
}

const HOUR_MS = 3_600_000;

/**
 * Longest stretch inside [from, to] with no run, counting the edges: from the
 * window start to the first run and from the last run to `to`. Pure.
 */
export function longestGap(runMs: number[], from: number, to: number): number {
  const inside = runMs.filter((t) => t >= from && t <= to).sort((a, b) => a - b);
  let prev = from;
  let gap = 0;
  for (const t of inside) {
    gap = Math.max(gap, t - prev);
    prev = t;
  }
  return Math.max(gap, to - prev);
}

/** Replace anything shaped like an email address. Applied to every logged error string. */
export function redactEmails(text: string | null): string | null {
  if (text === null) return null;
  return text.replace(/[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+/g, '[redacted]');
}

function summariseWrong(wrong: EvidenceAction[], startMs: number): string {
  const n = (f: (x: EvidenceAction) => boolean) => wrong.filter(f).length;
  const parts = [
    [n((x) => x.recipientMatchesOwner !== true), 'recipient not the current owner'],
    [n((x) => !(ms(x.firstPaidAt) >= startMs)), 'paid before go-live'],
    [n((x) => x.ownerInternal !== false), 'internal or unknown owner'],
    [n((x) => x.subscriptionActive !== true), 'subscription not active'],
  ] as const;
  return parts
    .filter(([count]) => count > 0)
    .map(([count, what]) => `${count} ${what}`)
    .join('; ');
}

/** Plain-text body of the internal decision email: the criteria and their results. */
export function decisionEmailText(result: GoLiveResult, outcome: 'went_live' | 'held', evidence: Evidence): string {
  const lines = [
    outcome === 'went_live'
      ? 'The first-30-days dispatcher met every go-live criterion and switched itself to live. The next hourly run saves real stuck-note drafts and sends day-8 summaries.'
      : 'The first-30-days dispatcher did NOT meet the go-live criteria and stays in dry run. Nothing goes to customers.',
    '',
    `Evaluated at ${evidence.now}, evidence since ${evidence.startAt}.`,
    '',
  ];
  for (const c of result.criteria) {
    lines.push(`${c.pass ? 'PASS' : 'FAIL'}  ${CRITERIA_TEXT[c.id]}`);
    lines.push(`      ${c.detail}`);
  }
  lines.push('', 'Details and how to retry: https://mcpemails.com/admin/growth/first-30-days');
  if (outcome === 'went_live') {
    lines.push("To go back to dry run at once: set FIRST30_DRY_RUN=true in Vercel, or UPDATE public.retention_switches SET mode = 'dry_run' WHERE key = 'first30';");
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

export interface SwitchRow {
  key: string;
  mode: 'dry_run' | 'live';
  autoGoLiveAt: string | null;
  decidedAt: string | null;
  decision: 'went_live' | 'held' | null;
  decisionDetail: unknown;
}

export type ModeSource = 'off' | 'env_override' | 'db' | 'db_unreadable';

export interface ResolvedMode {
  mode: First30Mode;
  source: ModeSource;
  switchRow: SwitchRow | null;
}

/** FIRST30_DRY_RUN as an explicit override, or null when unset. A typo forces dry run. */
export function first30EnvOverride(env: Record<string, string | undefined> = process.env): RunMode | null {
  const raw = (env.FIRST30_DRY_RUN ?? '').trim().toLowerCase();
  if (!raw) return null;
  return raw === 'false' || raw === 'off' ? 'send' : 'dry_run';
}

/**
 * Precedence: FIRST30_ENABLED off > env override > DB row > dry run.
 * The DB is read only when enabled and no override is set.
 */
export async function resolveFirst30Mode(
  env: Record<string, string | undefined>,
  readSwitch: () => Promise<SwitchRow | null>,
): Promise<ResolvedMode> {
  if (first30Mode(env) === 'off') return { mode: 'off', source: 'off', switchRow: null };
  const override = first30EnvOverride(env);
  let row: SwitchRow | null = null;
  let readOk = true;
  try {
    row = await readSwitch();
  } catch (err) {
    readOk = false;
    console.error('[first-30-days] switch read failed, running dry:', err instanceof Error ? err.message : String(err));
  }
  if (override) return { mode: override, source: 'env_override', switchRow: row };
  if (!readOk || !row) return { mode: 'dry_run', source: 'db_unreadable', switchRow: row };
  return { mode: row.mode === 'live' ? 'send' : 'dry_run', source: 'db', switchRow: row };
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

/** 00:00 UTC of `now`'s day. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Once per UTC day: due when the last attempt (any outcome) was before today's 00:00 UTC. */
export function probeDue(lastAttemptAt: string | null, now: Date): boolean {
  if (!lastAttemptAt) return true;
  return !(ms(lastAttemptAt) >= utcDayStart(now).getTime());
}

export type ProbeResult = { ok: true; mailbox: string } | { ok: false; reason: string };
export type MailboxProbe = () => Promise<ProbeResult>;

// ---------------------------------------------------------------------------
// The log and switch store
// ---------------------------------------------------------------------------

export type LogDecision = DecisionRecord['decision'] | 'run_summary' | 'mailbox_probe';

/** One first30_dry_run_log row. Never an email address. */
export interface LogRow {
  runAt: string;
  runId: string;
  workspaceId: string | null;
  template: string | null;
  decision: LogDecision;
  reason: string | null;
  recipientMatchesOwner: boolean | null;
  ownerInternal: boolean | null;
  subscriptionActive: boolean | null;
  firstPaidAt: string | null;
  error: string | null;
  detail: Record<string, unknown> | null;
}

export interface DecisionPatch {
  mode: 'dry_run' | 'live';
  decision: 'went_live' | 'held';
  decidedAt: string;
  detail: Record<string, unknown>;
}

export interface GoLiveStore {
  /** Throws when the row cannot be read; null when it does not exist. */
  readSwitch(): Promise<SwitchRow | null>;
  appendLog(rows: LogRow[]): Promise<void>;
  /**
   * Claim today's probe BEFORE probing: UPDATE retention_switches SET
   * last_probe_at = now WHERE key = 'first30' AND (last_probe_at IS NULL OR
   * last_probe_at < dayStart). True only for the caller whose update changed
   * the row, so the probe runs at most once per UTC day even when the log
   * insert fails or two runs overlap. Throws on a database error (no probe).
   */
  claimProbe(dayStart: Date, now: Date): Promise<boolean>;
  /** run_summary, mailbox_probe and would_* rows with run_at >= since. */
  readEvidence(since: Date): Promise<LogRow[]>;
  /**
   * UPDATE ... WHERE key = 'first30' AND decision IS NULL AND mode = 'dry_run'.
   * True only for the caller whose update changed the row.
   */
  decide(patch: DecisionPatch): Promise<boolean>;
  /** Merge into decision_detail after the decision (the notification outcome). */
  annotateDecision(extra: Record<string, unknown>): Promise<void>;
  pruneLog(before: Date): Promise<void>;
}

export const LOG_RETENTION_MS = 60 * DAY;

/** Evidence from log rows. Pure. */
export function evidenceFromLog(rows: LogRow[], now: Date, startAt: Date): Evidence {
  const runs: EvidenceRun[] = [];
  const actions: EvidenceAction[] = [];
  const probes: EvidenceProbe[] = [];
  for (const r of rows) {
    if (r.decision === 'run_summary') {
      const failed = Number((r.detail as { failed?: unknown } | null)?.failed ?? 0);
      const detail = (r.detail ?? {}) as { truncated?: unknown; forced?: unknown };
      runs.push({
        runId: r.runId,
        runAt: r.runAt,
        failed: Number.isFinite(failed) ? failed : 1,
        error: r.error,
        truncated: detail.truncated === true || r.reason === 'truncated',
        forced: detail.forced === true,
      });
    } else if (r.decision === 'mailbox_probe') {
      probes.push({ runAt: r.runAt, ok: !r.error });
    } else if (r.decision === 'would_draft' || r.decision === 'would_send' || r.decision === 'would_holdout') {
      actions.push({
        runId: r.runId,
        workspaceId: r.workspaceId ?? '',
        template: r.template ?? '',
        decision: r.decision,
        recipientMatchesOwner: r.recipientMatchesOwner,
        firstPaidAt: r.firstPaidAt,
        ownerInternal: r.ownerInternal,
        subscriptionActive: r.subscriptionActive,
      });
    }
  }
  return { now: now.toISOString(), startAt: startAt.toISOString(), runs, actions, probes };
}

// ---------------------------------------------------------------------------
// The dispatch: mode, probe, run, log, decide
// ---------------------------------------------------------------------------

export interface DispatchDeps {
  env: Record<string, string | undefined>;
  store: First30Store;
  goLive: GoLiveStore;
  /** Builds the live senders; only called when the resolved mode is live. */
  liveSenders: () => { send: Sender; writeDraft: DraftWriter };
  /** Internal email (draft mailbox only) for the decision. */
  notify: Sender;
  notifyTo: string;
  probe: MailboxProbe;
  startAt: Date;
  maxActions: number;
  now?: () => Date;
  outOfTime?: () => boolean;
  /** ?dry_run=1: quieter only. */
  forceDryRun?: boolean;
  newRunId?: () => string;
}

export interface DispatchResult {
  mode: First30Mode;
  source: ModeSource;
  runId: string | null;
  report: RunReport | null;
  probe: ProbeResult | null;
  decision: { outcome: 'went_live' | 'held'; result: GoLiveResult; notified: boolean } | null;
  logError: string | null;
  error: string | null;
}

export async function dispatchFirst30(deps: DispatchDeps): Promise<DispatchResult> {
  const clock = deps.now ?? (() => new Date());
  const resolved = await resolveFirst30Mode(deps.env, () => deps.goLive.readSwitch());
  const out: DispatchResult = {
    mode: resolved.mode,
    source: resolved.source,
    runId: null,
    report: null,
    probe: null,
    decision: null,
    logError: null,
    error: null,
  };
  if (resolved.mode === 'off') return out;
  const mode: RunMode = deps.forceDryRun ? 'dry_run' : resolved.mode;
  out.mode = mode;

  const runId = (deps.newRunId ?? randomUUID)();
  out.runId = runId;
  const runAt = clock().toISOString();
  const rows: LogRow[] = [];
  const base = {
    runAt,
    runId,
    recipientMatchesOwner: null,
    ownerInternal: null,
    subscriptionActive: null,
    firstPaidAt: null,
    error: null,
    detail: null,
  };

  // 1. The daily mailbox probe (dry run only).
  if (mode === 'dry_run') {
    try {
      const probeNow = clock();
      if (await deps.goLive.claimProbe(utcDayStart(probeNow), probeNow)) {
        let result: ProbeResult;
        try {
          result = await deps.probe();
        } catch (err) {
          result = { ok: false, reason: err instanceof Error ? err.message.slice(0, 200) : 'unexpected_error' };
        }
        out.probe = result;
        rows.push({
          ...base,
          workspaceId: null,
          template: null,
          decision: 'mailbox_probe',
          reason: result.ok ? 'selected' : null,
          error: result.ok ? null : redactEmails(result.reason),
        });
      }
    } catch (err) {
      out.logError = err instanceof Error ? err.message : String(err);
    }
  }

  // 2. The run itself.
  const decisions: DecisionRecord[] = [];
  try {
    const senders = mode === 'send' ? deps.liveSenders() : null;
    out.report = await runFirst30({
      store: deps.store,
      mode,
      send: senders?.send,
      writeDraft: senders?.writeDraft,
      startAt: deps.startAt,
      maxActions: deps.maxActions,
      now: clock(),
      outOfTime: deps.outOfTime,
      onDecision: mode === 'dry_run' ? (d) => decisions.push(d) : undefined,
    });
  } catch (err) {
    out.error = err instanceof Error ? err.message.slice(0, 300) : String(err);
  }

  // 3. The log (dry run only), then retention.
  if (mode === 'dry_run') {
    for (const d of decisions) {
      rows.push({
        ...base,
        workspaceId: d.workspaceId,
        template: d.template,
        decision: d.decision,
        reason: d.reason,
        recipientMatchesOwner: d.recipientMatchesOwner,
        ownerInternal: d.ownerInternal,
        subscriptionActive: d.subscriptionActive,
        firstPaidAt: d.firstPaidAt,
      });
    }
    const r = out.report;
    rows.push({
      ...base,
      workspaceId: null,
      template: null,
      decision: 'run_summary',
      reason: r?.truncated ? 'truncated' : null,
      error: redactEmails(out.error),
      detail: r
        ? {
            candidates: r.candidates,
            failed: r.failed,
            wouldDraft: r.wouldDraft,
            wouldSend: r.wouldSend,
            wouldHoldout: r.wouldHoldout,
            waiting: r.waiting,
            done: r.done,
            truncated: r.truncated,
            forced: !!deps.forceDryRun,
          }
        : { failed: 0, forced: !!deps.forceDryRun },
    });
    try {
      await deps.goLive.appendLog(rows);
    } catch (err) {
      out.logError = err instanceof Error ? err.message : String(err);
    }
  }
  try {
    await deps.goLive.pruneLog(new Date(clock().getTime() - LOG_RETENTION_MS));
  } catch (err) {
    console.error('[first-30-days] log prune failed:', err instanceof Error ? err.message : String(err));
  }

  // 4. The automatic decision.
  const row = resolved.switchRow;
  const now = clock();
  // No decision on a run whose own evidence is incomplete.
  if (
    !out.error &&
    !out.logError &&
    resolved.source === 'db' &&
    !deps.forceDryRun &&
    row &&
    row.mode === 'dry_run' &&
    row.decision === null &&
    row.autoGoLiveAt &&
    now.getTime() >= ms(row.autoGoLiveAt)
  ) {
    try {
      out.decision = await decide(deps, now);
    } catch (err) {
      out.error = out.error ?? `decision failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return out;
}

async function decide(
  deps: DispatchDeps,
  now: Date,
): Promise<{ outcome: 'went_live' | 'held'; result: GoLiveResult; notified: boolean } | null> {
  const evidence = evidenceFromLog(await deps.goLive.readEvidence(deps.startAt), now, deps.startAt);
  const result = evaluateGoLive(evidence);
  const outcome = result.pass ? 'went_live' : 'held';
  const won = await deps.goLive.decide({
    mode: result.pass ? 'live' : 'dry_run',
    decision: outcome,
    decidedAt: now.toISOString(),
    detail: {
      evaluatedAt: evidence.now,
      startAt: evidence.startAt,
      criteria: result.criteria.map((c) => ({ ...c, text: CRITERIA_TEXT[c.id] })),
      failed: result.criteria.filter((c) => !c.pass).map((c) => c.id),
      counts: result.counts,
    },
  });
  if (!won) return null;

  const text = decisionEmailText(result, outcome, evidence);
  let notified = false;
  try {
    const sent = await deps.notify({
      to: deps.notifyTo,
      subject: result.pass ? 'First 30 days switched to live' : 'First 30 days held in dry run: go-live criteria not met',
      text,
      html: `<pre style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;white-space:pre-wrap;">${text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')}</pre>`,
      headers: {},
      idempotencyKey: `first30-go-live-decision-${now.toISOString()}`,
    });
    notified = sent.ok;
    await deps.goLive.annotateDecision({ notified: sent.ok, notifyError: sent.ok ? null : sent.reason });
  } catch (err) {
    console.error('[first-30-days] decision email failed:', err instanceof Error ? err.message : String(err));
  }
  return { outcome, result, notified };
}

/** The SQL that re-arms the automatic decision, shown on the admin page. */
export function retrySql(at: Date): string {
  return `UPDATE public.retention_switches SET mode = 'dry_run', decision = NULL, decided_at = NULL, decision_detail = NULL, auto_go_live_at = '${at.toISOString()}', updated_at = now() WHERE key = 'first30';`;
}

/** A sensible default retry time for that SQL: tomorrow 09:00 UTC. */
export function defaultRetryAt(now: Date): Date {
  const d = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9) + DAY;
  return new Date(d);
}

