/**
 * Tests for the first-30-days dry-run-to-live switch. No network, no database,
 * no mailbox: the stores are in memory and the senders record what they get.
 *
 * Run:
 *   node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
 *     src/lib/retention/first-30-days-go-live.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NEXT_PUBLIC_APP_URL = 'https://mcpemails.test';
delete process.env.RESEND_API_KEY;

const f30 = await import('@/lib/retention/first-30-days');
const gl = await import('@/lib/retention/first-30-days-go-live');
const glStore = await import('@/lib/retention/first-30-days-go-live-store');

type Ctx = import('@/lib/retention/first-30-days').CandidateContext;
type FirstPayment = import('@/lib/retention/first-30-days').FirstPayment;
type OutgoingEmail = import('@/lib/retention/first-30-days').OutgoingEmail;
type Evidence = import('@/lib/retention/first-30-days-go-live').Evidence;
type EvidenceAction = import('@/lib/retention/first-30-days-go-live').EvidenceAction;
type SwitchRow = import('@/lib/retention/first-30-days-go-live').SwitchRow;
type LogRow = import('@/lib/retention/first-30-days-go-live').LogRow;
type DecisionPatch = import('@/lib/retention/first-30-days-go-live').DecisionPatch;
type ProbeResult = import('@/lib/retention/first-30-days-go-live').ProbeResult;

const { HOUR, DAY, TEMPLATE_STUCK, TEMPLATE_WEEK1 } = f30;
const { evaluateGoLive, GO_LIVE_CRITERIA } = gl;

const START = new Date('2026-10-25T00:00:00.000Z');
const DECIDE_AT = new Date('2026-10-28T09:17:00.000Z');
const USER = '00000000-0000-4000-8000-0000000000aa';
const OWNER_EMAIL = 'owner@example.test';

// ---------------------------------------------------------------------------
// Evidence builders
// ---------------------------------------------------------------------------

function runs(n: number, opts: { failed?: number; error?: string | null } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    runId: `run-${i}`,
    runAt: new Date(START.getTime() + 17 * 60_000 + i * HOUR).toISOString(),
    failed: opts.failed ?? 0,
    error: opts.error ?? null,
  }));
}

function action(overrides: Partial<EvidenceAction> = {}): EvidenceAction {
  return {
    runId: 'run-30',
    workspaceId: 'aaaaaaaa-0000-4000-8000-000000000001',
    template: TEMPLATE_STUCK,
    decision: 'would_draft',
    recipientMatchesOwner: true,
    firstPaidAt: '2026-10-25T03:00:00.000Z',
    ownerInternal: false,
    subscriptionActive: true,
    ...overrides,
  };
}

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    now: DECIDE_AT.toISOString(),
    startAt: START.toISOString(),
    runs: runs(80),
    actions: [],
    probes: [{ runAt: '2026-10-28T00:17:00.000Z', ok: true }],
    ...overrides,
  };
}

function failedIds(e: Evidence): string[] {
  return evaluateGoLive(e).criteria.filter((c) => !c.pass).map((c) => c.id);
}

// ---------------------------------------------------------------------------
// evaluateGoLive
// ---------------------------------------------------------------------------

test('zero candidates passes when runs, volumes and the probe hold', () => {
  const r = evaluateGoLive(evidence());
  assert.equal(r.pass, true, JSON.stringify(r.criteria));
  assert.equal(r.criteria.length, 5);
});

/** Evidence evaluated just after a full first day of hourly runs. */
function dayOne(overrides: Partial<Evidence> = {}): Evidence {
  return evidence({
    now: '2026-10-26T00:30:00.000Z',
    probes: [{ runAt: '2026-10-25T12:00:00.000Z', ok: true }],
    ...overrides,
  });
}

test('a: needs 24 clean runs since START_AT', () => {
  assert.deepEqual(failedIds(dayOne({ runs: runs(24) })), []);
  assert.deepEqual(failedIds(dayOne({ runs: runs(23) })), ['steady_operation']);
  // Runs before START_AT do not count.
  const early = runs(30).map((r) => ({ ...r, runAt: new Date(START.getTime() - DAY + 1000).toISOString() }));
  assert.deepEqual(failedIds(evidence({ runs: early })), ['steady_operation']);
});

test('a: one run with failed > 0, an uncaught error or a truncated loop fails it', () => {
  const extra = (o: Record<string, unknown>) => ({ ...runs(1)[0], runId: 'extra', runAt: '2026-10-28T08:00:00.000Z', ...o });
  assert.deepEqual(failedIds(evidence({ runs: [...runs(80), extra({ failed: 1 })] })), ['steady_operation']);
  assert.deepEqual(failedIds(evidence({ runs: [...runs(80), extra({ error: 'boom' })] })), ['steady_operation']);
  assert.deepEqual(failedIds(evidence({ runs: [...runs(80), extra({ truncated: true })] })), ['steady_operation']);
  assert.deepEqual(failedIds(evidence({ runs: [...runs(80), extra({})] })), []);
});

test('a: lost runs are seen: clean runs must cover 90% of elapsed hours', () => {
  // 81 whole hours elapsed from the first run to evaluation: 73 needed.
  const all = runs(80);
  // Drop 8 runs early on (no gap over 2h in the last 24h): 72 left, fails.
  const lost = all.filter((_, i) => !(i >= 10 && i < 26 && i % 2 === 0));
  assert.equal(lost.length, 72);
  assert.deepEqual(failedIds(evidence({ runs: lost })), ['steady_operation']);
  assert.deepEqual(failedIds(evidence({ runs: all.filter((_, i) => !(i >= 10 && i < 24 && i % 2 === 0)) })), []);
  // A late first run moves the window start: 24 hourly runs ending now pass.
  const late = runs(24).map((r, i) => ({ ...r, runAt: new Date(DECIDE_AT.getTime() - (23 - i) * HOUR - 60_000).toISOString() }));
  assert.deepEqual(failedIds(evidence({ runs: late })), []);
});

test('a: a gap over 2 hours in the last 24 hours fails, including since the last run', () => {
  const all = runs(80);
  const holed = all.filter((_, i) => !(i >= 70 && i <= 72)); // a 4-hour hole yesterday evening
  assert.deepEqual(failedIds(evidence({ runs: holed })), ['steady_operation']);
  const stale = all.slice(0, 78); // last run 05:17, evaluated 09:17
  assert.deepEqual(failedIds(evidence({ runs: stale })), ['steady_operation']);
  assert.equal(gl.longestGap([2, 5], 0, 10), 5);
  assert.equal(gl.longestGap([], 0, 10), 10);
});

test('a: manual ?dry_run=1 runs never count toward it', () => {
  const forced = runs(80).map((r) => ({ ...r, forced: true }));
  assert.deepEqual(failedIds(evidence({ runs: forced })), ['steady_operation']);
  // ... nor against it.
  const forcedBad = { ...runs(1)[0], runId: 'manual', runAt: '2026-10-28T08:30:00.000Z', error: 'boom', forced: true };
  assert.deepEqual(failedIds(evidence({ runs: [...runs(80), forcedBad] })), []);
});

test('evidenceFromLog reads truncated and forced from the run summary', () => {
  const base = { runId: 'r', workspaceId: null, template: null, recipientMatchesOwner: null, ownerInternal: null, subscriptionActive: null, firstPaidAt: null, error: null };
  const ev = gl.evidenceFromLog(
    [
      { ...base, runAt: '2026-10-25T01:17:00Z', decision: 'run_summary', reason: 'truncated', detail: { failed: 0, truncated: true, forced: false } },
      { ...base, runAt: '2026-10-25T02:17:00Z', decision: 'run_summary', reason: null, detail: { failed: 0, truncated: false, forced: true } },
    ],
    DECIDE_AT,
    START,
  );
  assert.deepEqual(ev.runs.map((r) => [r.truncated, r.forced]), [[true, false], [false, true]]);
});

test('redactEmails strips addresses from error strings', () => {
  assert.equal(gl.redactEmails('LOGIN failed for someone@example.test (NO)'), 'LOGIN failed for [redacted] (NO)');
  assert.equal(gl.redactEmails('<a.b+c@x.co>, d@e.io'), '<[redacted]>, [redacted]');
  assert.equal(gl.redactEmails(null), null);
  const row = glStore.toInsert({
    runAt: DECIDE_AT.toISOString(), runId: 'r', workspaceId: null, template: null, decision: 'mailbox_probe',
    reason: 'x@y.z', recipientMatchesOwner: null, ownerInternal: null, subscriptionActive: null, firstPaidAt: null,
    error: 'auth failed for owner@example.test', detail: null,
  });
  assert.ok(!JSON.stringify(row).includes('@'));
});

test('b: every would-* entry must match the owner, be paid after go-live, external and subscribed', () => {
  assert.deepEqual(failedIds(evidence({ actions: [action()] })), []);
  assert.deepEqual(failedIds(evidence({ actions: [action({ recipientMatchesOwner: false })] })), ['right_recipients']);
  assert.deepEqual(failedIds(evidence({ actions: [action({ recipientMatchesOwner: null })] })), ['right_recipients']);
  assert.deepEqual(failedIds(evidence({ actions: [action({ firstPaidAt: '2026-10-24T23:00:00Z' })] })), ['right_recipients']);
  assert.deepEqual(failedIds(evidence({ actions: [action({ firstPaidAt: null })] })), ['right_recipients']);
  assert.deepEqual(failedIds(evidence({ actions: [action({ ownerInternal: true })] })), ['right_recipients']);
  assert.deepEqual(failedIds(evidence({ actions: [action({ subscriptionActive: false })] })), ['right_recipients']);
  const r = evaluateGoLive(evidence({ actions: [action({ ownerInternal: true, subscriptionActive: false })] }));
  const b = r.criteria.find((c) => c.id === 'right_recipients')!;
  assert.match(b.detail, /internal/);
  assert.match(b.detail, /subscription not active/);
});

test('c: a workspace twice for one template in one run fails; across runs it is expected', () => {
  assert.deepEqual(failedIds(evidence({ actions: [action(), action()] })), ['idempotent']);
  assert.deepEqual(failedIds(evidence({ actions: [action({ runId: 'r1' }), action({ runId: 'r2' })] })), []);
  // Same run, different template: fine for c (d catches an early M3).
  const later = evidence({ runs: runs(216), now: new Date(START.getTime() + 9 * DAY).toISOString(), probes: [{ runAt: new Date(START.getTime() + 9 * DAY - HOUR).toISOString(), ok: true }] });
  assert.deepEqual(failedIds({ ...later, actions: [action(), action({ template: TEMPLATE_WEEK1, decision: 'would_send' })] }), []);
});

test('d: at most 10 distinct M2 workspaces, counted across runs', () => {
  const ten = Array.from({ length: 10 }, (_, i) => action({ workspaceId: `ws-${i}`, runId: `r-${i}` }));
  const repeats = ten.map((a) => ({ ...a, runId: `${a.runId}-again` }));
  assert.deepEqual(failedIds(evidence({ actions: [...ten, ...repeats] })), []);
  assert.deepEqual(failedIds(evidence({ actions: [...ten, action({ workspaceId: 'ws-11', runId: 'r-11' })] })), ['volumes']);
});

test('d: M3 must be zero before START_AT + 8 days and at most 40 after', () => {
  const m3 = action({ template: TEMPLATE_WEEK1, decision: 'would_send' });
  assert.deepEqual(failedIds(evidence({ actions: [m3] })), ['volumes']);
  assert.deepEqual(failedIds(evidence({ actions: [action({ template: TEMPLATE_WEEK1, decision: 'would_holdout' })] })), ['volumes']);
  const nine = new Date(START.getTime() + 9 * DAY);
  const later = { runs: runs(216), now: nine.toISOString(), probes: [{ runAt: new Date(nine.getTime() - HOUR).toISOString(), ok: true }] };
  assert.deepEqual(failedIds(evidence({ ...later, actions: [m3] })), []);
  const many = Array.from({ length: 41 }, (_, i) =>
    action({ template: TEMPLATE_WEEK1, decision: 'would_send', workspaceId: `ws-${i}`, runId: `r-${i}` }),
  );
  assert.deepEqual(failedIds(evidence({ ...later, actions: many })), ['volumes']);
  assert.deepEqual(failedIds(evidence({ ...later, actions: many.slice(0, 40) })), []);
  assert.equal(GO_LIVE_CRITERIA.maxWeek1Workspaces, 40);
});

test('e: needs a successful probe within the last 24 hours', () => {
  assert.deepEqual(failedIds(evidence({ probes: [] })), ['mailbox_probe']);
  assert.deepEqual(failedIds(evidence({ probes: [{ runAt: '2026-10-28T00:17:00Z', ok: false }] })), ['mailbox_probe']);
  assert.deepEqual(failedIds(evidence({ probes: [{ runAt: '2026-10-27T09:00:00Z', ok: true }] })), ['mailbox_probe']);
  assert.deepEqual(failedIds(evidence({ probes: [{ runAt: '2026-10-27T09:30:00Z', ok: true }] })), []);
});

test('every failing criterion is listed, not just the first', () => {
  const ids = failedIds(evidence({ runs: runs(3), probes: [], actions: [action(), action({ recipientMatchesOwner: false })] }));
  assert.deepEqual(ids, ['steady_operation', 'right_recipients', 'idempotent', 'mailbox_probe']);
});

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

function sw(overrides: Partial<SwitchRow> = {}): SwitchRow {
  return {
    key: 'first30',
    mode: 'dry_run',
    autoGoLiveAt: '2026-10-28T09:00:00.000Z',
    decidedAt: null,
    decision: null,
    decisionDetail: null,
    ...overrides,
  };
}

test('mode precedence: enabled gate, env override, DB row, fail-safe dry run', async () => {
  const live = async () => sw({ mode: 'live' });
  const broken = async (): Promise<SwitchRow | null> => {
    throw new Error('db down');
  };
  let reads = 0;
  const counted = async () => {
    reads += 1;
    return sw({ mode: 'live' });
  };
  const on = { FIRST30_ENABLED: 'on' };

  assert.equal((await gl.resolveFirst30Mode({}, counted)).mode, 'off');
  assert.equal((await gl.resolveFirst30Mode({ FIRST30_DRY_RUN: 'false' }, counted)).mode, 'off');
  assert.equal(reads, 0, 'off never touches the database');

  assert.deepEqual(
    [(await gl.resolveFirst30Mode(on, live)).mode, (await gl.resolveFirst30Mode(on, live)).source],
    ['send', 'db'],
  );
  assert.equal((await gl.resolveFirst30Mode(on, async () => sw())).mode, 'dry_run');
  assert.deepEqual(
    [(await gl.resolveFirst30Mode({ ...on, FIRST30_DRY_RUN: 'true' }, live)).mode, (await gl.resolveFirst30Mode({ ...on, FIRST30_DRY_RUN: 'true' }, live)).source],
    ['dry_run', 'env_override'],
  );
  assert.equal((await gl.resolveFirst30Mode({ ...on, FIRST30_DRY_RUN: 'false' }, async () => sw())).mode, 'send');
  assert.equal((await gl.resolveFirst30Mode({ ...on, FIRST30_DRY_RUN: 'flase' }, live)).mode, 'dry_run', 'a typo forces dry run');
  assert.equal((await gl.resolveFirst30Mode({ ...on, FIRST30_DRY_RUN: '' }, live)).mode, 'send', 'empty is unset');

  const down = await gl.resolveFirst30Mode(on, broken);
  assert.deepEqual([down.mode, down.source], ['dry_run', 'db_unreadable']);
  const missing = await gl.resolveFirst30Mode(on, async () => null);
  assert.deepEqual([missing.mode, missing.source], ['dry_run', 'db_unreadable']);
  // The override still wins when the DB is down.
  assert.equal((await gl.resolveFirst30Mode({ ...on, FIRST30_DRY_RUN: 'false' }, broken)).mode, 'send');
});

test('probeDue: once per UTC day, whatever the outcome', () => {
  const now = new Date('2026-10-27T05:17:00Z');
  assert.equal(gl.probeDue(null, now), true);
  assert.equal(gl.probeDue('2026-10-26T23:17:00Z', now), true);
  assert.equal(gl.probeDue('2026-10-27T00:17:00Z', now), false);
  assert.equal(gl.probeDue('2026-10-27T00:00:00Z', now), false);
});

// ---------------------------------------------------------------------------
// The dispatch
// ---------------------------------------------------------------------------

function ctx(workspaceId: string, firstPaidAt: string, overrides: Partial<Ctx> = {}): Ctx {
  return {
    workspaceId,
    firstPaidAt,
    workspace: { ownerId: USER, deletedAt: null },
    owner: {
      id: USER,
      email: OWNER_EMAIL,
      displayName: 'Kari Nordmann',
      unsubscribedAt: null,
      unsubscribedCategories: [],
      unsubscribeToken: '11111111-2222-4333-8444-555555555555',
    },
    subscriptionStatus: 'active',
    internal: false,
    successSincePaid: 0,
    ledger: [],
    ...overrides,
  };
}

class CandidateStore {
  contexts: Ctx[];
  /** What the fresh re-read returns, keyed by workspace; defaults to the same context. */
  fresh = new Map<string, Ctx>();
  reads = 0;
  writes = 0;
  constructor(contexts: Ctx[]) {
    this.contexts = contexts;
  }
  async listFirstPayments(since: Date): Promise<FirstPayment[]> {
    return this.contexts
      .filter((c) => new Date(c.firstPaidAt).getTime() >= since.getTime())
      .map((c) => ({ workspaceId: c.workspaceId, firstPaidAt: c.firstPaidAt }));
  }
  async loadContexts(firsts: FirstPayment[]) {
    this.reads += 1;
    const isReRead = firsts.length === 1 && this.reads > 1;
    return firsts.map((f) => (isReRead && this.fresh.get(f.workspaceId)) || this.contexts.find((c) => c.workspaceId === f.workspaceId)!);
  }
  async loadStuckDetails() {
    return { totalCalls: 0, topErrorCodes: [], clientNames: [], inboxProviders: [] };
  }
  async loadWeek1Stats() {
    return {
      counts: { search: 1, opened: 1, drafts: 0, sent: 0, scheduled: 0 },
      totalSuccess: 2,
      activeDays: 1,
      automationsSorted: 0,
      hasAutomation: false,
      inboxAddresses: ['me@example.test'],
    };
  }
  async assignVariant() {
    this.writes += 1;
    return 'summary';
  }
  async claim() {
    this.writes += 1;
    return true;
  }
  async finish() {
    this.writes += 1;
  }
}

class MemoryGoLive {
  row: SwitchRow | null;
  log: LogRow[] = [];
  readFails = false;
  decideCalls = 0;
  pruned: Date[] = [];
  annotations: Record<string, unknown>[] = [];
  constructor(row: SwitchRow | null) {
    this.row = row;
  }
  async readSwitch() {
    if (this.readFails) throw new Error('db down');
    return this.row ? { ...this.row } : null;
  }
  async appendLog(rows: LogRow[]) {
    if (this.appendFails) throw new Error('insert failed');
    this.log.push(...rows);
  }
  lastProbeClaim: string | null = null;
  appendFails = false;
  async claimProbe(dayStart: Date, now: Date) {
    if (this.lastProbeClaim && new Date(this.lastProbeClaim).getTime() >= dayStart.getTime()) return false;
    this.lastProbeClaim = now.toISOString();
    return true;
  }
  async readEvidence(since: Date) {
    return this.log.filter((r) => new Date(r.runAt).getTime() >= since.getTime());
  }
  /** The conditional update: only when still undecided and in dry run. */
  async decide(patch: DecisionPatch) {
    this.decideCalls += 1;
    if (!this.row || this.row.decision !== null || this.row.mode !== 'dry_run') return false;
    this.row = { ...this.row, mode: patch.mode, decision: patch.decision, decidedAt: patch.decidedAt, decisionDetail: patch.detail };
    return true;
  }
  async annotateDecision(extra: Record<string, unknown>) {
    this.annotations.push(extra);
  }
  async pruneLog(before: Date) {
    this.pruned.push(before);
    this.log = this.log.filter((r) => new Date(r.runAt).getTime() >= before.getTime());
  }
}

function harness(opts: { contexts?: Ctx[]; row?: SwitchRow | null; env?: Record<string, string>; probe?: ProbeResult } = {}) {
  const store = new CandidateStore(opts.contexts ?? []);
  const goLive = new MemoryGoLive(opts.row === undefined ? sw() : opts.row);
  const notices: OutgoingEmail[] = [];
  const customerEmails: OutgoingEmail[] = [];
  let probes = 0;
  let liveBuilt = 0;
  let clock = new Date('2026-10-25T00:17:00Z');
  let n = 0;
  const deps = () => ({
    env: opts.env ?? { FIRST30_ENABLED: 'on' },
    store,
    goLive,
    liveSenders: () => {
      liveBuilt += 1;
      return {
        send: async (e: OutgoingEmail) => {
          customerEmails.push(e);
          return { ok: true as const, id: 'x' };
        },
        writeDraft: async () => ({ ok: true as const, via: 'imap_draft', id: 'd' }),
      };
    },
    notify: async (e: OutgoingEmail) => {
      notices.push(e);
      return { ok: true as const, id: 'n' };
    },
    notifyTo: 'asgeir@mcpemails.com',
    probe: async () => {
      probes += 1;
      return opts.probe ?? ({ ok: true, mailbox: 'Drafts' } as ProbeResult);
    },
    startAt: START,
    maxActions: 20,
    now: () => clock,
    newRunId: () => `run-${(n += 1)}`,
  });
  return {
    store,
    goLive,
    notices,
    customerEmails,
    get probes() {
      return probes;
    },
    get liveBuilt() {
      return liveBuilt;
    },
    setClock(d: Date) {
      clock = d;
    },
    run: (extra: Record<string, unknown> = {}) => gl.dispatchFirst30({ ...deps(), ...extra }),
  };
}

test('dry run logs every decision plus a run summary, and nothing in live mode', async () => {
  const due = ctx('aaaaaaaa-0000-4000-8000-000000000001', '2026-10-25T01:00:00Z');
  const fresh = ctx('aaaaaaaa-0000-4000-8000-000000000002', '2026-10-27T20:00:00Z');
  const h = harness({ contexts: [due, fresh] });
  h.setClock(new Date('2026-10-28T05:17:00Z'));
  const res = await h.run();
  assert.equal(res.mode, 'dry_run');
  assert.equal(res.source, 'db');
  const decisions = h.goLive.log.filter((r) => r.decision !== 'mailbox_probe');
  // two workspaces x two templates + one summary
  assert.equal(decisions.length, 5);
  const draft = decisions.find((r) => r.decision === 'would_draft')!;
  assert.equal(draft.workspaceId, due.workspaceId);
  assert.equal(draft.template, TEMPLATE_STUCK);
  assert.equal(draft.recipientMatchesOwner, true);
  assert.equal(draft.ownerInternal, false);
  assert.equal(draft.subscriptionActive, true);
  assert.equal(draft.firstPaidAt, due.firstPaidAt);
  assert.ok(decisions.some((r) => r.decision === 'wait' && r.workspaceId === fresh.workspaceId));
  const summary = decisions.find((r) => r.decision === 'run_summary')!;
  assert.equal((summary.detail as { failed: number }).failed, 0);
  assert.equal(summary.error, null);
  assert.equal(h.store.writes, 0, 'a dry run claims nothing');

  // Live: no log rows at all.
  const live = harness({ contexts: [due], row: sw({ mode: 'live' }) });
  live.setClock(new Date('2026-10-28T05:17:00Z'));
  const liveRes = await live.run();
  assert.equal(liveRes.mode, 'send');
  assert.equal(live.goLive.log.length, 0);
  assert.equal(live.probes, 0, 'no probe in live mode');
  assert.equal(live.liveBuilt, 1);
});

test('an empty dry run still logs a run summary', async () => {
  const h = harness();
  await h.run();
  assert.deepEqual(
    h.goLive.log.map((r) => r.decision),
    ['mailbox_probe', 'run_summary'],
  );
});

test('recipient_matches_owner is false when the owner changed address or the workspace changed hands', async () => {
  const due = ctx('aaaaaaaa-0000-4000-8000-000000000001', '2026-10-25T01:00:00Z');
  const h = harness({ contexts: [due] });
  h.store.fresh.set(due.workspaceId, ctx(due.workspaceId, due.firstPaidAt, { owner: { ...due.owner!, email: 'new@example.test' } }));
  h.setClock(new Date('2026-10-28T05:17:00Z'));
  await h.run();
  assert.equal(h.goLive.log.find((r) => r.decision === 'would_draft')!.recipientMatchesOwner, false);

  const h2 = harness({ contexts: [due] });
  h2.store.fresh.set(due.workspaceId, ctx(due.workspaceId, due.firstPaidAt, { workspace: { ownerId: 'someone-else', deletedAt: null } }));
  h2.setClock(new Date('2026-10-28T05:17:00Z'));
  await h2.run();
  assert.equal(h2.goLive.log.find((r) => r.decision === 'would_draft')!.recipientMatchesOwner, false);
});

test('the log never holds an email address', async () => {
  const due = ctx('aaaaaaaa-0000-4000-8000-000000000001', '2026-10-25T01:00:00Z');
  const h = harness({ contexts: [due], probe: { ok: false, reason: 'draft_inbox_not_found' } });
  h.setClock(new Date('2026-10-28T05:17:00Z'));
  await h.run();
  const json = JSON.stringify(h.goLive.log.map(glStore.toInsert));
  assert.ok(!json.includes('@'), json);
});

test('the probe runs once per UTC day and is logged either way', async () => {
  const h = harness({ probe: { ok: false, reason: 'draft_inbox_not_found' } });
  for (let hour = 0; hour < 30; hour += 1) {
    h.setClock(new Date(Date.UTC(2026, 9, 25, hour, 17)));
    await h.run();
  }
  assert.equal(h.probes, 2, 'day 1 and day 2');
  const probeRows = h.goLive.log.filter((r) => r.decision === 'mailbox_probe');
  assert.equal(probeRows.length, 2);
  assert.equal(probeRows[0].error, 'draft_inbox_not_found');
});

test('a forced dry run (?dry_run=1) on a live row stays dry and never decides', async () => {
  const h = harness({ row: sw({ mode: 'live', decision: 'went_live' }) });
  const res = await h.run({ forceDryRun: true });
  assert.equal(res.mode, 'dry_run');
  assert.equal(h.liveBuilt, 0);
  assert.equal(h.goLive.decideCalls, 0);
});

async function dayOfDryRuns(h: ReturnType<typeof harness>, hours: number) {
  for (let i = 0; i < hours; i += 1) {
    h.setClock(new Date(START.getTime() + 17 * 60_000 + i * HOUR));
    await h.run();
  }
}

test('no decision before auto_go_live_at; the first run after it decides once and goes live', async () => {
  const h = harness();
  await dayOfDryRuns(h, 80); // up to 2026-10-28 07:17
  assert.equal(h.goLive.decideCalls, 0);
  assert.equal(h.goLive.row!.decision, null);

  h.setClock(new Date('2026-10-28T09:17:00Z'));
  const res = await h.run();
  assert.equal(res.decision?.outcome, 'went_live');
  assert.equal(h.goLive.row!.mode, 'live');
  assert.equal(h.goLive.row!.decision, 'went_live');
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].to, 'asgeir@mcpemails.com');
  assert.match(h.notices[0].subject, /switched to live/);
  assert.match(h.notices[0].text, /PASS {2}a\./);
  assert.deepEqual(h.goLive.annotations, [{ notified: true, notifyError: null }]);

  // Next run is live and never decides again.
  h.setClock(new Date('2026-10-28T10:17:00Z'));
  const next = await h.run();
  assert.equal(next.mode, 'send');
  assert.equal(next.decision, null);
  assert.equal(h.notices.length, 1);
  assert.equal(h.customerEmails.length, 0);
});

test('failing criteria hold in dry run, list every failure, alert once, never re-decide', async () => {
  const h = harness({ probe: { ok: false, reason: 'draft_host_blocked' } });
  await dayOfDryRuns(h, 10); // too few runs, and the probe never succeeds
  h.setClock(new Date('2026-10-28T09:17:00Z'));
  const res = await h.run();
  assert.equal(res.decision?.outcome, 'held');
  assert.equal(h.goLive.row!.mode, 'dry_run');
  assert.equal(h.goLive.row!.decision, 'held');
  assert.deepEqual((h.goLive.row!.decisionDetail as { failed: string[] }).failed, ['steady_operation', 'mailbox_probe']);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0].subject, /held in dry run/);
  assert.match(h.notices[0].text, /FAIL {2}e\./);

  h.setClock(new Date('2026-10-28T10:17:00Z'));
  const again = await h.run();
  assert.equal(again.mode, 'dry_run');
  assert.equal(again.decision, null);
  assert.equal(h.notices.length, 1);
});

test('two overlapping runs: the conditional update lets only one decide and notify', async () => {
  const h = harness();
  await dayOfDryRuns(h, 30);
  h.setClock(new Date('2026-10-28T09:17:00Z'));
  // Both read the undecided row before either writes.
  const [a, b] = await Promise.all([h.run(), h.run()]);
  assert.equal(h.goLive.decideCalls, 2);
  assert.equal([a.decision, b.decision].filter(Boolean).length, 1);
  assert.equal(h.notices.length, 1);
});

test('an env override skips the automatic decision; an unreadable row runs dry and does not decide', async () => {
  const h = harness({ env: { FIRST30_ENABLED: 'on', FIRST30_DRY_RUN: 'true' } });
  await dayOfDryRuns(h, 30);
  h.setClock(new Date('2026-10-28T09:17:00Z'));
  const res = await h.run();
  assert.equal(res.source, 'env_override');
  assert.equal(h.goLive.decideCalls, 0);

  const d = harness();
  d.goLive.readFails = true;
  d.setClock(new Date('2026-10-28T09:17:00Z'));
  const down = await d.run();
  assert.deepEqual([down.mode, down.source], ['dry_run', 'db_unreadable']);
  assert.equal(d.goLive.decideCalls, 0);
});

test('a run that throws is logged as a failed run summary', async () => {
  const h = harness();
  h.store.listFirstPayments = async () => {
    throw new Error('checkout read failed');
  };
  const res = await h.run();
  assert.equal(res.error, 'checkout read failed');
  const summary = h.goLive.log.find((r) => r.decision === 'run_summary')!;
  assert.equal(summary.error, 'checkout read failed');
});

test('log rows older than 60 days are pruned each run', async () => {
  const h = harness();
  h.setClock(new Date('2026-12-30T00:17:00Z'));
  await h.run();
  assert.equal(h.goLive.pruned[0].toISOString(), new Date(new Date('2026-12-30T00:17:00Z').getTime() - 60 * DAY).toISOString());
});

test('retry SQL re-arms the decision in one statement', () => {
  const sql = gl.retrySql(new Date('2026-11-01T09:00:00Z'));
  assert.match(sql, /decision = NULL/);
  assert.match(sql, /auto_go_live_at = '2026-11-01T09:00:00.000Z'/);
  assert.match(sql, /WHERE key = 'first30';$/);
  assert.equal(sql.split(';').filter((s) => s.trim()).length, 1);
});

test('the migration seeds the switch in dry run at 2026-10-28 09:00 UTC with RLS on', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(path.resolve(here, '../../../../../supabase/migrations/20261025040000_first30_auto_go_live.sql'), 'utf8');
  assert.match(sql, /VALUES \('first30', 'dry_run', '2026-10-28T09:00:00Z'\)/);
  assert.match(sql, /ALTER TABLE public\.retention_switches ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE public\.first30_dry_run_log ENABLE ROW LEVEL SECURITY/);
  assert.ok(!sql.includes(String.fromCharCode(0x2014)), 'no em dashes');
});

test('the probe stays once per UTC day when the log insert keeps failing', async () => {
  const h = harness();
  h.goLive.appendFails = true;
  for (let hour = 0; hour < 30; hour += 1) {
    h.setClock(new Date(Date.UTC(2026, 9, 25, hour, 17)));
    await h.run();
  }
  assert.equal(h.probes, 2);
});

test('the probe error is logged without an email address', async () => {
  const h = harness({ probe: { ok: false, reason: 'LOGIN rejected for asgeir@mcpemails.com' } });
  await h.run();
  const row = h.goLive.log.find((r) => r.decision === 'mailbox_probe')!;
  assert.equal(row.error, 'LOGIN rejected for [redacted]');
});

test('no decision on a run whose log insert failed or whose loop threw', async () => {
  const h = harness();
  await dayOfDryRuns(h, 80);
  h.goLive.appendFails = true;
  h.setClock(new Date('2026-10-28T09:17:00Z'));
  const res = await h.run();
  assert.ok(res.logError);
  assert.equal(res.decision, null);
  assert.equal(h.goLive.decideCalls, 0);

  h.goLive.appendFails = false;
  const listFirstPayments = h.store.listFirstPayments;
  h.store.listFirstPayments = async () => {
    throw new Error('checkout read failed');
  };
  h.setClock(new Date('2026-10-28T10:17:00Z'));
  const errored = await h.run();
  assert.equal(errored.error, 'checkout read failed');
  assert.equal(h.goLive.decideCalls, 0);

  h.store.listFirstPayments = listFirstPayments;
  h.setClock(new Date('2026-10-28T11:17:00Z'));
  const ok = await h.run();
  assert.equal(ok.decision?.outcome, 'held', 'the errored run counts as a bad run');
  assert.ok((h.goLive.row!.decisionDetail as { failed: string[] }).failed.includes('steady_operation'));
});

test('a truncated dry run is logged as truncated and holds the decision', async () => {
  const h = harness({ contexts: [ctx('aaaaaaaa-0000-4000-8000-000000000001', '2026-10-25T01:00:00Z')] });
  await dayOfDryRuns(h, 80);
  h.setClock(new Date('2026-10-28T09:17:00Z'));
  const res = await h.run({ outOfTime: () => true });
  const summary = h.goLive.log.filter((r) => r.decision === 'run_summary').pop()!;
  assert.equal(summary.reason, 'truncated');
  assert.equal(res.decision?.outcome, 'held');
});
