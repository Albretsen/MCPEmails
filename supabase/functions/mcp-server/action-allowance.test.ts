// ---------------------------------------------------------------------------
// The allowance arithmetic. Three things are worth pinning here: which rows
// meter and which do not (an exempt early member must never be reserved
// against, a workspace in its first week must never be reserved against), that
// the 80% warning fires on exactly one call, and that the pre-run exhaustion
// check reads `remaining` only for rows that meter.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import {
  type ActionAllowanceRow,
  allowanceDecision,
  isAllowanceExhausted,
  isWarningCrossing,
  warningThreshold,
} from "./action-allowance.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** A metered Free workspace on day 10, mid-month. */
function freeRow(overrides: Partial<ActionAllowanceRow> = {}): ActionAllowanceRow {
  return {
    plan: "free",
    owner_id: "owner-1",
    exempt: false,
    exempt_reason: null,
    cap: 150,
    period_start: "2026-09-08T00:00:00+00:00",
    period_end: "2026-10-01T00:00:00+00:00",
    grace_ends_at: "2026-09-08T00:00:00+00:00",
    in_grace: false,
    used: 12,
    remaining: 138,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// allowanceDecision
// ---------------------------------------------------------------------------

Deno.test("a metered Free row hands the function's cap and window to the reservation", () => {
  const decision = allowanceDecision(freeRow());
  assert(decision.kind === "meter", "Free after grace meters");
  if (decision.kind !== "meter") return;
  assertEquals(decision.cap, 150, "cap comes from the row, never from a local constant");
  assertEquals(decision.periodStart, "2026-09-08T00:00:00+00:00", "counting window starts after grace");
  assertEquals(decision.periodEnd, "2026-10-01T00:00:00+00:00", "window ends with the month");
});

Deno.test("an early member is never metered, even though its cap is also null", () => {
  const decision = allowanceDecision(
    freeRow({ exempt: true, exempt_reason: "early_member", cap: null, remaining: null, grace_ends_at: null }),
  );
  assertEquals(decision.kind, "allow_unmetered", "exempt rows make no reservation");
  assert(decision.kind === "allow_unmetered" && decision.reason === "exempt", "reported as exempt, not as no_cap");
});

Deno.test("the first seven days are not counted", () => {
  const decision = allowanceDecision(freeRow({ in_grace: true, used: 0, remaining: 150 }));
  assert(decision.kind === "allow_unmetered" && decision.reason === "in_grace", "grace allows without a reservation");
});

Deno.test("grace running past month end leaves an empty window, which never meters", () => {
  // Created on the 28th: this month's counting window is [month_end, month_end).
  // in_grace already covers it; the width check is the belt to that brace, so
  // reserve_action_usage is never handed a window it raises 22007 on.
  const decision = allowanceDecision(freeRow({
    in_grace: false,
    period_start: "2026-10-01T00:00:00+00:00",
    period_end: "2026-10-01T00:00:00+00:00",
  }));
  assert(decision.kind === "allow_unmetered" && decision.reason === "empty_window", "zero-width window is unmetered");
});

Deno.test("a paid plan meters against its silent ceiling", () => {
  const decision = allowanceDecision(freeRow({ plan: "personal", cap: 25_000, remaining: 24_988, grace_ends_at: null }));
  assert(decision.kind === "meter" && decision.cap === 25_000, "paid plans still carry their abuse ceiling");
});

Deno.test("no row means no reservation", () => {
  assertEquals(allowanceDecision(null).kind, "allow_unmetered", "unknown workspace fails open");
  assertEquals(allowanceDecision(undefined).kind, "allow_unmetered", "undefined too");
});

// ---------------------------------------------------------------------------
// isAllowanceExhausted (the pre-run automation check)
// ---------------------------------------------------------------------------

Deno.test("exhaustion is read only off rows that meter", () => {
  assert(isAllowanceExhausted(freeRow({ used: 150, remaining: 0 })), "150 of 150 is exhausted");
  assert(!isAllowanceExhausted(freeRow({ used: 149, remaining: 1 })), "one left is not exhausted");
  assert(
    !isAllowanceExhausted(freeRow({ exempt: true, exempt_reason: "early_member", cap: null, remaining: null })),
    "an exempt row cannot be exhausted",
  );
  assert(!isAllowanceExhausted(freeRow({ in_grace: true, remaining: 0 })), "a row in grace is not exhausted whatever remaining says");
  assert(!isAllowanceExhausted(null), "no row is not exhausted");
});

// ---------------------------------------------------------------------------
// The 80% crossing
// ---------------------------------------------------------------------------

Deno.test("the warning threshold for the Free allowance is 120", () => {
  assertEquals(warningThreshold(150), 120, "ceil(0.8 * 150)");
});

Deno.test("the warning fires on the crossing call and on no other", () => {
  assert(!isWarningCrossing(119, 150), "119 is below the line");
  assert(isWarningCrossing(120, 150), "120 is the crossing call");
  assert(isWarningCrossing(121, 150), "121 is inside the band; the queue index dedupes");
  assert(isWarningCrossing(149, 150), "149 is the last call in the band");
  assert(!isWarningCrossing(150, 150), "the refusal edge is the other email's job");
});

Deno.test("the threshold rounds UP for caps that do not divide evenly", () => {
  // 0.8 * 7 = 5.6. Firing at 5 would warn at 71%; ceil gives 6 (86%), which is
  // the first count that is at least 80%.
  assertEquals(warningThreshold(7), 6, "ceil, not round or floor");
  assert(isWarningCrossing(6, 7), "fires at 6 of 7");
  assert(!isWarningCrossing(5, 7), "not at 5 of 7");
});

Deno.test("the crossing is never true for a nonsensical cap", () => {
  assert(!isWarningCrossing(0, 0), "cap 0");
  assert(!isWarningCrossing(1, -5), "negative cap");
  assert(!isWarningCrossing(Number.NaN, 150), "NaN used");
});
