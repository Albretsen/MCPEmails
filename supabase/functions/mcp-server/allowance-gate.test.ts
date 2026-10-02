// ---------------------------------------------------------------------------
// The cap is one event, however it was reached.
//
// ── What went wrong ────────────────────────────────────────────────────────
// Measured 2026-10-02: a Free workspace whose 150 actions were used entirely
// by its automations got the 80% notice and a per-rule "automation paused"
// notice, and nothing else. No `usage_limit_events` row, no `paywall_reached`
// funnel row and no `usage_limit_reached` email, because the allowance ran out
// between two runs and the dispatcher's pre-run check, which is what then
// parked the rules, recorded nothing. See allowance-gate.ts.
//
// ── How ────────────────────────────────────────────────────────────────────
// The REAL triage engine (`handleTriageDispatch`, `runTriageRule`) wired to the
// REAL gate functions, exactly as index.ts wires them, against a ledger that
// keeps the three promises the database makes and that the idempotency here
// rests on:
//
//   * `billing_email_sends` is unique on (workspace_id, template, period_start);
//   * `record_usage_limit_event` always appends an event, appends the funnel
//     row once per workspace per period, and answers true on that call only;
//   * `reserve_action_usage` refuses at the cap and counts the reservation it
//     hands out.
//
// The interactive side is `reserveBillableAction` called directly: it is the
// function a tool call reserves through, and the same one the runner uses.
// What index.ts hands these functions is pinned in automation-cap-wiring.test.ts.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import type { ActionAllowanceRow } from "./action-allowance.ts";
import {
  type AllowanceGateIo,
  checkAutomationAllowance,
  planLimitOfRefusal,
  queueAutomationPausedNotice,
  reserveBillableAction,
  type UsageEmailInput,
} from "./allowance-gate.ts";
import {
  handleTriageDispatch,
  MAX_RULES_PER_INVOCATION,
  runTriageRule,
  type TriageDeps,
  type TriageMatch,
  type TriageRuleRow,
} from "./triage-engine.ts";

const WS = "ws-1";
const OCTOBER = "2026-10-01T00:00:00+00:00";
const NOVEMBER = "2026-11-01T00:00:00+00:00";
const DECEMBER = "2026-12-01T00:00:00+00:00";

// ---------------------------------------------------------------------------
// The ledger: the database, as far as the allowance is concerned
// ---------------------------------------------------------------------------

interface Ledger {
  /** One `workspace_action_allowance()` row per workspace. `used` moves. */
  allowances: Map<string, ActionAllowanceRow>;
  /** `usage_limit_events`. */
  limitEvents: Array<{ workspaceId: string; periodStart: string; usedActions: number; plan: string }>;
  /** `product_funnel_events` rows with stage `paywall_reached`. */
  paywallRows: Array<{ workspaceId: string; periodStart: string }>;
  /** `billing_email_sends`, after the unique index has had its say. */
  emails: UsageEmailInput[];
  /** Inserts the unique index refused (the 23505s). */
  duplicateEmailInserts: number;
  /** Make one round trip fail, the way the real one fails. */
  fail: { limitEventLookup?: boolean; limitEventWrite?: boolean; reserve?: boolean; noticeLookup?: boolean };
  /** Every `limitEventRecorded` read, to show which path asks. */
  limitEventLookups: number;
}

function allowanceRow(overrides: Partial<ActionAllowanceRow> = {}): ActionAllowanceRow {
  const used = overrides.used ?? 0;
  const cap = overrides.cap === undefined ? 150 : overrides.cap;
  return {
    plan: "free",
    owner_id: "owner-1",
    exempt: false,
    exempt_reason: null,
    cap,
    period_start: OCTOBER,
    period_end: NOVEMBER,
    grace_ends_at: "2026-09-20T00:00:00+00:00",
    in_grace: false,
    used,
    remaining: cap === null ? null : Math.max(cap - used, 0),
    ...overrides,
  };
}

function ledger(row: ActionAllowanceRow = allowanceRow()): Ledger {
  return {
    allowances: new Map([[WS, row]]),
    limitEvents: [],
    paywallRows: [],
    emails: [],
    duplicateEmailInserts: 0,
    fail: {},
    limitEventLookups: 0,
  };
}

/** The gate's database, faithful to the three promises in the header. */
function ledgerIo(db: Ledger): AllowanceGateIo {
  return {
    loadAllowance: (workspaceId) => {
      const row = db.allowances.get(workspaceId);
      // A fresh object each read, as PostgREST gives one: the gate must not be
      // able to pass by mutating the row it was handed.
      return Promise.resolve(row ? { ...row } : null);
    },
    reserve: (input) => {
      if (db.fail.reserve) return Promise.resolve({ ok: false });
      const row = db.allowances.get(input.workspaceId)!;
      if (row.used >= input.cap) {
        return Promise.resolve({ ok: true, row: { reservation_id: null, allowed: false, used_actions: row.used } });
      }
      // Reserved and, in these tests, always finalised: the action is taken.
      row.used += 1;
      row.remaining = Math.max(input.cap - row.used, 0);
      return Promise.resolve({
        ok: true,
        row: { reservation_id: `res-${row.used}`, allowed: true, used_actions: row.used },
      });
    },
    recordLimitEvent: (input) => {
      if (db.fail.limitEventWrite) return Promise.resolve(false);
      db.limitEvents.push({
        workspaceId: input.workspaceId, periodStart: input.periodStart, usedActions: input.usedActions, plan: input.plan,
      });
      const entered = db.paywallRows.some((row) =>
        row.workspaceId === input.workspaceId && row.periodStart >= input.periodStart
      );
      if (entered) return Promise.resolve(false);
      db.paywallRows.push({ workspaceId: input.workspaceId, periodStart: input.periodStart });
      return Promise.resolve(true);
    },
    limitEventRecorded: (workspaceId, periodStart) => {
      db.limitEventLookups++;
      if (db.fail.limitEventLookup) return Promise.resolve(false);
      return Promise.resolve(
        db.limitEvents.some((event) => event.workspaceId === workspaceId && event.periodStart >= periodStart),
      );
    },
    limitNoticeQueued: (workspaceId, periodStart) => {
      if (db.fail.noticeLookup) return Promise.resolve(false);
      return Promise.resolve(db.emails.some((email) =>
        email.workspaceId === workspaceId && email.template === "usage_limit_reached" &&
        email.periodStart === periodStart
      ));
    },
    queueEmail: (input) => {
      const taken = db.emails.some((email) =>
        email.workspaceId === input.workspaceId && email.template === input.template &&
        email.periodStart === input.periodStart
      );
      if (taken) db.duplicateEmailInserts++;
      else db.emails.push(input);
      return Promise.resolve();
    },
  };
}

const emailsOf = (db: Ledger, template: string) => db.emails.filter((email) => email.template === template);

// ---------------------------------------------------------------------------
// The runner: the real engine, with a store that really pauses rules
// ---------------------------------------------------------------------------

interface Runner {
  rules: Map<string, TriageRuleRow & { paused_until?: string | null }>;
  leases: Set<string>;
  released: Array<Record<string, unknown>>;
  seen: Set<string>;
  applied: string[];
  /** What a search returns for a rule, by rule id. */
  matches: Map<string, TriageMatch[]>;
}

function rule(id: string, overrides: Partial<TriageRuleRow> = {}): TriageRuleRow {
  return {
    id,
    workspace_id: WS,
    inbox_id: "inbox-1",
    api_key_id: "key-1",
    name: `Rule ${id}`,
    enabled: true,
    filter: { from: "news@example.com" },
    action: { type: "move", folder: "Newsletters" },
    interval_minutes: 15,
    max_messages_per_run: 200,
    next_run_at: new Date(0).toISOString(),
    running_since: null,
    consecutive_failures: 0,
    ...overrides,
  };
}

function messages(prefix: string, count: number): TriageMatch[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index + 1}`,
    subject: "Weekly digest",
    from_name: "News Desk",
    from_email: "news@example.com",
    date: "2026-10-02T09:00:00Z",
    folder: "INBOX",
  }));
}

function runner(rules: TriageRuleRow[], matches: Record<string, TriageMatch[]> = {}): Runner {
  return {
    rules: new Map(rules.map((row) => [row.id, { ...row }])),
    leases: new Set(),
    released: [],
    seen: new Set(),
    applied: [],
    matches: new Map(Object.entries(matches)),
  };
}

/**
 * `triageDeps()` as index.ts builds it, minus the provider: the three
 * allowance hooks are the gate functions bound to one io object.
 */
function deps(run: Runner, db: Ledger): TriageDeps {
  const io = ledgerIo(db);
  return {
    store: {
      listStaleLeases: () => Promise.resolve([]),
      reclaimStaleLease: () => Promise.resolve(),
      // Due means what it means in production: enabled, unleased, not paused.
      listDueRules: (_nowIso, limit) =>
        Promise.resolve(
          [...run.rules.values()]
            .filter((row) => row.enabled && !run.leases.has(row.id) && !row.paused_until)
            .slice(0, limit),
        ),
      claimRule: (ruleId) => {
        if (run.leases.has(ruleId)) return Promise.resolve(false);
        run.leases.add(ruleId);
        return Promise.resolve(true);
      },
      releaseRule: (ruleId, update) => {
        run.leases.delete(ruleId);
        run.released.push({ ruleId, ...update });
        const row = run.rules.get(ruleId);
        if (row && update.paused_until) row.paused_until = update.paused_until;
        return Promise.resolve();
      },
      createRun: () => Promise.resolve("run-1"),
      finishRun: () => Promise.resolve(),
      claimMessage: (ruleId, digest) => {
        const key = `${ruleId}:${digest}`;
        if (run.seen.has(key)) return Promise.resolve(false);
        run.seen.add(key);
        return Promise.resolve(true);
      },
      writeRunItem: () => Promise.resolve(),
      loadApiKey: () =>
        Promise.resolve({
          id: "key-1",
          workspace_id: WS,
          name: "Automations key",
          scopes: ["read:email", "manage:folders"],
          inbox_ids: null,
          expires_at: null,
          deleted_at: null,
        }),
      loadInbox: () =>
        Promise.resolve({ id: "inbox-1", workspace_id: WS, email_address: "someone@example.com", provider: "gmail" }),
    },
    digest: (id) => Promise.resolve(`digest-${id}`),
    encrypt: (text) => Promise.resolve(`enc(${text})`),
    search: (_inbox, _filter, _limit) => Promise.resolve([]),
    resolveFolder: (_inbox, name) => Promise.resolve({ id: `id-of-${name}`, verified: true }),
    applyAction: (input) => {
      run.applied.push(input.match.id);
      return Promise.resolve({ ok: true });
    },
    meter: () => Promise.resolve(),
    now: () => 1_000_000,
    // ── The wiring under test, as in index.ts ──────────────────────────────
    checkAllowance: (workspaceId) => checkAutomationAllowance(io, workspaceId),
    reserveAction: async (input) => {
      const reservation = await reserveBillableAction(io, input.workspaceId, input.operation);
      if (reservation.outcome === "refused") return { allowed: false, limit: planLimitOfRefusal(reservation) };
      return { allowed: true, reservation_id: reservation.outcome === "reserved" ? reservation.reservationId : null };
    },
    notifyRulePaused: (input) => queueAutomationPausedNotice(io, input),
  };
}

/** One rule, run directly, searching what the runner holds for it. */
function runRule(run: Runner, db: Ledger, ruleId: string) {
  const base = deps(run, db);
  return runTriageRule({ ...base, search: () => Promise.resolve(run.matches.get(ruleId) ?? []) }, run.rules.get(ruleId)!);
}

/** One dispatcher invocation, as pg_cron makes one a minute. */
async function dispatch(run: Runner, db: Ledger): Promise<{ ran: number; paused: number; due: number }> {
  const base = deps(run, db);
  let current = "";
  const wired: TriageDeps = {
    ...base,
    store: {
      ...base.store,
      // The search needs to know which rule is running; the claim says so.
      claimRule: async (ruleId, nowIso) => {
        const won = await base.store.claimRule(ruleId, nowIso);
        if (won) current = ruleId;
        return won;
      },
    },
    search: () => Promise.resolve(run.matches.get(current) ?? []),
  };
  return await (await handleTriageDispatch(wired)).json();
}

/** A tool call's reservation: the same function, with nothing in between. */
function toolCall(db: Ledger) {
  return reserveBillableAction(ledgerIo(db), WS, "email_read");
}

// ---------------------------------------------------------------------------
// 1. The 80% notice, when an automation's reservation is the one that crosses
// ---------------------------------------------------------------------------

Deno.test("an automation whose reservation crosses 80% queues the warning, once", async () => {
  const db = ledger(allowanceRow({ used: 118 }));
  const run = runner([rule("r1")], { r1: messages("m", 10) });

  const summary = await runRule(run, db, "r1");

  assertEquals(summary.succeeded, 10, "nothing is refused: 128 of 150");
  const warnings = emailsOf(db, "usage_warning_80");
  assertEquals(warnings.length, 1, "one warning for the period, not one per action in the band");
  assertEquals(warnings[0].payload.used, 120, "queued by the reservation that landed on the line");
  assertEquals(warnings[0].payload.cap, 150);
  assertEquals(warnings[0].payload.period_end, NOVEMBER, "the reset date the email prints");
  assertEquals(warnings[0].periodStart, OCTOBER, "keyed on the allowance period");
  assertEquals(warnings[0].ownerId, "owner-1");
  assertEquals(db.duplicateEmailInserts, 8, "every later action in the band is a refused insert");
  assertEquals(db.limitEvents.length, 0, "and nobody is capped at 128");
  assertEquals(emailsOf(db, "usage_limit_reached").length, 0);
});

// ---------------------------------------------------------------------------
// 2. The cap, when a reservation is refused mid-run
// ---------------------------------------------------------------------------

Deno.test("a reservation refused mid-run records the cap and queues the limit notice", async () => {
  const db = ledger(allowanceRow({ used: 149 }));
  const run = runner([rule("r1")], { r1: messages("m", 3) });

  const summary = await runRule(run, db, "r1");

  assertEquals(summary.succeeded, 1, "the 150th action is taken");
  assertEquals(summary.error_code, "plan_limit", "the 151st is refused and the rule pauses");
  assertEquals(db.limitEvents.length, 1, "one refused action, one event");
  assertEquals(db.limitEvents[0].usedActions, 150);
  assertEquals(db.paywallRows.length, 1, "the workspace enters the funnel");
  const limit = emailsOf(db, "usage_limit_reached");
  assertEquals(limit.length, 1, "the owner is told, with the price and the upgrade link");
  assertEquals(limit[0].payload, {
    used: 150, cap: 150, period_start: OCTOBER, period_end: NOVEMBER, plan: "free",
  }, "the same payload a refused tool call queues");
  assertEquals(
    emailsOf(db, "automation_paused_limit").length,
    0,
    "and not told again a moment later by the per-rule notice",
  );
});

// ---------------------------------------------------------------------------
// 3. The cap, when the pre-run check finds nothing left
// ---------------------------------------------------------------------------

Deno.test("a rule parked before it runs records the cap exactly as a refused call does", async () => {
  // The measured case: 150 of 150 used by earlier runs, nothing ever refused.
  const db = ledger(allowanceRow({ used: 150 }));
  const run = runner([rule("r1")], { r1: messages("m", 3) });

  const body = await dispatch(run, db);

  assertEquals(body.paused, 1, "the rule is parked");
  assertEquals(body.ran, 0);
  assertEquals(run.applied.length, 0, "before the mailbox is opened");
  assertEquals(run.released[0].paused_reason, "plan_limit");
  assertEquals(run.released[0].paused_until, NOVEMBER);

  assertEquals(db.limitEvents.length, 1, "the workspace is counted as capped");
  assertEquals(db.limitEvents[0], { workspaceId: WS, periodStart: OCTOBER, usedActions: 150, plan: "free" });
  assertEquals(db.paywallRows.length, 1, "and enters the funnel");
  const limit = emailsOf(db, "usage_limit_reached");
  assertEquals(limit.length, 1, "the limit notice goes out");
  assertEquals(limit[0].payload, {
    used: 150, cap: 150, period_start: OCTOBER, period_end: NOVEMBER, plan: "free",
  }, "the same payload a refused tool call queues");
  assertEquals(limit[0].scopeKey, OCTOBER);
  assertEquals(emailsOf(db, "automation_paused_limit").length, 0, "one email about one cause");
});

Deno.test("120 rules parked across six dispatcher cycles are one cap, not 120", async () => {
  const db = ledger(allowanceRow({ used: 150 }));
  const run = runner(Array.from({ length: 120 }, (_, index) => rule(`r${index + 1}`)));

  let paused = 0;
  let cycles = 0;
  for (; cycles < 10; cycles++) {
    const body = await dispatch(run, db);
    if (body.due === 0) break;
    assert(body.due <= MAX_RULES_PER_INVOCATION, "one invocation takes a bounded batch");
    paused += body.paused;
  }

  assertEquals(paused, 120, "every rule is parked");
  assertEquals(cycles, 6, "over six invocations of twenty");
  assertEquals(db.limitEvents.length, 1, "one usage_limit_events row: a parked rule is not a refused action");
  assertEquals(db.paywallRows.length, 1, "one funnel row");
  assertEquals(emailsOf(db, "usage_limit_reached").length, 1, "one limit notice");
  assertEquals(emailsOf(db, "automation_paused_limit").length, 0, "no per-rule notices on top of it");
  assertEquals(db.duplicateEmailInserts, 0, "and not even a refused insert: the later rules never try");
  assertEquals(db.limitEventLookups, 120, "each parked rule asks, and only the first one writes");
});

// ---------------------------------------------------------------------------
// 4. Either order, one of each
// ---------------------------------------------------------------------------

Deno.test("automations first, then a tool call: one notice, and the tool call's refusal is still logged", async () => {
  const db = ledger(allowanceRow({ used: 150 }));
  const run = runner([rule("r1"), rule("r2")]);
  await dispatch(run, db);
  assertEquals(emailsOf(db, "usage_limit_reached").length, 1, "queued by the automation path");

  const first = await toolCall(db);
  const second = await toolCall(db);

  assertEquals(first.outcome, "refused");
  assertEquals(second.outcome, "refused");
  assertEquals(emailsOf(db, "usage_limit_reached").length, 1, "the tool call does not queue a second one");
  assertEquals(db.duplicateEmailInserts, 0, "it never tries: the period's funnel row is taken");
  assertEquals(db.paywallRows.length, 1, "one paywall for the period");
  assertEquals(db.limitEvents.length, 3, "one for the pause, one per refused call, as refused calls always were");
});

Deno.test("a tool call first, then automations: the pause adds no event, no funnel row and no email", async () => {
  const db = ledger(allowanceRow({ used: 150 }));
  const refusal = await toolCall(db);
  assertEquals(refusal.outcome, "refused");
  assertEquals(db.limitEvents.length, 1);
  assertEquals(emailsOf(db, "usage_limit_reached").length, 1, "queued by the interactive path");

  const run = runner([rule("r1"), rule("r2"), rule("r3")]);
  const body = await dispatch(run, db);

  assertEquals(body.paused, 3, "the rules are parked all the same");
  assertEquals(db.limitEvents.length, 1, "the workspace was already counted for this period");
  assertEquals(db.paywallRows.length, 1);
  assertEquals(emailsOf(db, "usage_limit_reached").length, 1);
  assertEquals(
    emailsOf(db, "automation_paused_limit").length,
    0,
    "and the owner, told minutes ago, is not told again per rule",
  );
});

Deno.test("80% by a tool call, the cap by automations: one of each", async () => {
  const db = ledger(allowanceRow({ used: 119 }));
  const crossing = await toolCall(db);
  assertEquals(crossing.outcome, "reserved");
  assertEquals(emailsOf(db, "usage_warning_80").length, 1, "the tool call crossed the line");

  // The automation then walks the rest of the band and is refused at the cap.
  const run = runner([rule("r1")], { r1: messages("m", 40) });
  const summary = await runRule(run, db, "r1");

  assertEquals(summary.succeeded, 30, "120 to 150");
  assertEquals(summary.error_code, "plan_limit");
  assertEquals(emailsOf(db, "usage_warning_80").length, 1, "still one warning");
  assertEquals(emailsOf(db, "usage_limit_reached").length, 1, "and one limit notice");
  assertEquals(db.emails.length, 2, "nothing else was queued");
});

Deno.test("the whole month used by automations alone: warning, then limit, then silence", async () => {
  const db = ledger(allowanceRow({ used: 0 }));
  const run = runner(
    [rule("r1"), rule("r2"), rule("r3"), rule("r4"), rule("r5")],
    { r1: messages("a", 60), r2: messages("b", 60), r3: messages("c", 60), r4: messages("d", 5), r5: messages("e", 5) },
  );

  const body = await dispatch(run, db);

  assertEquals(run.applied.length, 150, "exactly the allowance is spent");
  assertEquals(body.ran, 3, "three rules ran, the third until it was refused");
  assertEquals(body.paused, 2, "and the two after it were parked before they started");
  assertEquals(emailsOf(db, "usage_warning_80").length, 1);
  assertEquals(emailsOf(db, "usage_limit_reached").length, 1);
  assertEquals(emailsOf(db, "automation_paused_limit").length, 0);
  assertEquals(db.limitEvents.length, 1, "one refused action; the parked rules found it already recorded");
  assertEquals(db.paywallRows.length, 1);
});

// ---------------------------------------------------------------------------
// 5. Retries
// ---------------------------------------------------------------------------

Deno.test("a rule that comes due again inside the same period changes nothing", async () => {
  const db = ledger(allowanceRow({ used: 150 }));
  const run = runner([rule("r1")]);
  await dispatch(run, db);

  // The pause is lifted by hand (or by a stale-lease reclaim) and the rule is
  // due again while the allowance is still used up.
  for (let retry = 0; retry < 3; retry++) {
    run.rules.get("r1")!.paused_until = null;
    const body = await dispatch(run, db);
    assertEquals(body.paused, 1, "parked again");
  }

  assertEquals(db.limitEvents.length, 1, "still one event");
  assertEquals(db.paywallRows.length, 1);
  assertEquals(emailsOf(db, "usage_limit_reached").length, 1);
  assertEquals(emailsOf(db, "automation_paused_limit").length, 0);
});

Deno.test("a run retried into the same refusal logs each refusal and sends nothing more", async () => {
  const db = ledger(allowanceRow({ used: 150 }));
  const run = runner([rule("r1")], { r1: messages("m", 2) });

  // runTriageRule directly: the manual path has no pre-run check, so each
  // attempt reaches the reservation and is refused there.
  await runRule(run, db, "r1");
  await runRule(run, db, "r1");

  assertEquals(run.applied.length, 0);
  assertEquals(db.limitEvents.length, 2, "two refused actions are two events, as for two refused tool calls");
  assertEquals(db.paywallRows.length, 1, "one paywall");
  assertEquals(emailsOf(db, "usage_limit_reached").length, 1, "one email");
  assertEquals(emailsOf(db, "automation_paused_limit").length, 0);
});

Deno.test("a new period is a new cap: one more event, one more notice", async () => {
  const db = ledger(allowanceRow({ used: 150 }));
  const run = runner([rule("r1")]);
  await dispatch(run, db);

  // November, used up again by the 3rd.
  db.allowances.set(WS, allowanceRow({ used: 150, period_start: NOVEMBER, period_end: DECEMBER }));
  run.rules.get("r1")!.paused_until = null;
  await dispatch(run, db);

  assertEquals(db.limitEvents.map((event) => event.periodStart), [OCTOBER, NOVEMBER]);
  assertEquals(emailsOf(db, "usage_limit_reached").map((email) => email.periodStart), [OCTOBER, NOVEMBER]);
});

// ---------------------------------------------------------------------------
// 6. The per-rule notice: only when the limit notice is not doing the job
// ---------------------------------------------------------------------------

Deno.test("with no limit notice for the period, the per-rule notice still goes, once", async () => {
  // The period's funnel row was already taken by something that is not an
  // action-cap refusal (the inbox paywall writes the same stage), so the RPC
  // answers false and no limit notice is due. The owner must still hear why
  // their automations stopped.
  const db = ledger(allowanceRow({ used: 150 }));
  db.paywallRows.push({ workspaceId: WS, periodStart: OCTOBER });
  const run = runner([rule("r1"), rule("r2"), rule("r3")]);

  await dispatch(run, db);

  assertEquals(db.limitEvents.length, 1, "the cap is still recorded");
  assertEquals(emailsOf(db, "usage_limit_reached").length, 0);
  const paused = emailsOf(db, "automation_paused_limit");
  assertEquals(paused.length, 1, "one per workspace per period, not one per rule");
  assertEquals(paused[0].payload, {
    rule_id: "r1", rule_name: "Rule r1", used: 150, cap: 150, period_end: NOVEMBER,
  });
  assertEquals(paused[0].scopeKey, "r1");
  assertEquals(db.duplicateEmailInserts, 2, "the other two rules are refused by the unique index");
});

Deno.test("a cap event that cannot be written sends no limit notice and falls back to the per-rule one", async () => {
  const db = ledger(allowanceRow({ used: 150 }));
  db.fail.limitEventWrite = true;
  const run = runner([rule("r1")]);

  const body = await dispatch(run, db);

  assertEquals(body.paused, 1, "the rule is parked regardless: the pause never depended on the record");
  assertEquals(emailsOf(db, "usage_limit_reached").length, 0, "no funnel row, no limit email");
  assertEquals(emailsOf(db, "automation_paused_limit").length, 1, "but the owner is not left with silence");
});

Deno.test("a failed lookup records the cap rather than skipping it", async () => {
  const db = ledger(allowanceRow({ used: 150 }));
  db.fail.limitEventLookup = true;
  const run = runner([rule("r1"), rule("r2")]);

  await dispatch(run, db);

  assertEquals(db.limitEvents.length, 2, "a spare row is the cheap direction to be wrong in");
  assertEquals(db.paywallRows.length, 1, "the funnel row is still written once");
  assertEquals(emailsOf(db, "usage_limit_reached").length, 1, "and the email still goes once");
});

// ---------------------------------------------------------------------------
// 7. Who gets nothing
// ---------------------------------------------------------------------------

const QUIET: Array<[string, ActionAllowanceRow]> = [
  ["a Free workspace under the cap and under 80%", allowanceRow({ used: 40 })],
  [
    "an early member",
    allowanceRow({ exempt: true, exempt_reason: "early_member", cap: null, remaining: null, grace_ends_at: null, used: 900 }),
  ],
  [
    "a comped workspace",
    allowanceRow({ exempt: true, exempt_reason: "comped", cap: null, remaining: null, grace_ends_at: null, used: 900 }),
  ],
  ["a Free workspace in its first seven days", allowanceRow({ in_grace: true, used: 0, remaining: 150 })],
  ["a paid workspace under its ceiling", allowanceRow({ plan: "personal", cap: 25_000, used: 24_000, grace_ends_at: null })],
];

for (const [name, row] of QUIET) {
  Deno.test(`${name}: automations run, and no event, funnel row or email is written`, async () => {
    const db = ledger(row);
    const run = runner([rule("r1"), rule("r2")], { r1: messages("a", 4), r2: messages("b", 4) });

    const body = await dispatch(run, db);

    assertEquals(body.paused, 0, "nothing is parked");
    assertEquals(body.ran, 2);
    assertEquals(run.applied.length, 8, "every action is taken");
    assertEquals(db.limitEvents.length, 0, "no cap event");
    assertEquals(db.paywallRows.length, 0, "no funnel row");
    assertEquals(db.emails.length, 0, "no email of any kind");
    assertEquals(db.limitEventLookups, 0, "and the cap ledger is never even read");
  });
}

Deno.test("an unknown workspace and a failed allowance read both fail open, silently", async () => {
  const db = ledger();
  db.allowances.clear();
  const run = runner([rule("r1")], { r1: messages("m", 2) });

  const body = await dispatch(run, db);

  assertEquals(body.ran, 1);
  assertEquals(run.applied.length, 2);
  assertEquals(db.limitEvents.length + db.emails.length, 0);
});

Deno.test("a reservation subsystem that is down lets the action through and records nothing", async () => {
  const db = ledger(allowanceRow({ used: 149 }));
  db.fail.reserve = true;
  const run = runner([rule("r1")], { r1: messages("m", 3) });

  const summary = await runRule(run, db, "r1");

  assertEquals(summary.succeeded, 3, "infrastructure trouble fails open");
  assertEquals(db.limitEvents.length + db.emails.length, 0, "and is not mistaken for a cap");
});

Deno.test("a paid workspace at its silent ceiling is recorded but never emailed, as for a tool call", async () => {
  // The ceiling is not public, so no notice names it. The event and the funnel
  // row are written, exactly as a refused tool call on a paid plan writes them.
  const paid = () => allowanceRow({ plan: "personal", cap: 25_000, used: 25_000, grace_ends_at: null });

  const viaAutomation = ledger(paid());
  const body = await dispatch(runner([rule("r1"), rule("r2")]), viaAutomation);
  assertEquals(body.paused, 2);

  const viaToolCall = ledger(paid());
  await toolCall(viaToolCall);

  for (const db of [viaAutomation, viaToolCall]) {
    assertEquals(db.limitEvents.length, 1);
    assertEquals(db.limitEvents[0].plan, "personal");
    assertEquals(db.paywallRows.length, 1);
    assertEquals(db.emails.length, 0, "no email names a paid ceiling");
  }
});

// ---------------------------------------------------------------------------
// 8. The interactive path is what it was
// ---------------------------------------------------------------------------

Deno.test("tool calls alone: the warning at the line, the notice at the first refusal, an event per refusal", async () => {
  const db = ledger(allowanceRow({ used: 118 }));

  for (let call = 0; call < 32; call++) assertEquals((await toolCall(db)).outcome, "reserved");
  assertEquals(emailsOf(db, "usage_warning_80").length, 1);
  assertEquals(emailsOf(db, "usage_warning_80")[0].payload.used, 120);
  assertEquals(db.limitEvents.length, 0);

  const refusals = [await toolCall(db), await toolCall(db), await toolCall(db)];
  for (const refusal of refusals) {
    assert(refusal.outcome === "refused", "the 151st call and every one after it is refused");
    if (refusal.outcome !== "refused") continue;
    assertEquals(refusal.usedActions, 150);
    assertEquals(refusal.periodEnd, NOVEMBER);
  }
  assertEquals(db.limitEvents.length, 3, "every refused call is an event");
  assertEquals(db.paywallRows.length, 1);
  assertEquals(emailsOf(db, "usage_limit_reached").length, 1);
  assertEquals(db.limitEventLookups, 0, "the once-per-period guard belongs to the pre-run check alone");
});
