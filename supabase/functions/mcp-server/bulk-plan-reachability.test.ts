// ---------------------------------------------------------------------------
// A claimed bulk plan must not run against an inbox that went unreachable.
//
// ── THE BUG ────────────────────────────────────────────────────────────────
// `executeBulkPlanRequest` re-resolves the plan's inbox from the id frozen into
// the plan row. Until 2026-09-17 that query filtered on `id` and
// `workspace_id` and NOTHING else — no `deleted_at is null`, no
// `status = 'active'` — while `resolveInbox` and `resolveInboxArg`, the only
// two ways an ordinary tool call ever reaches a mailbox, require both.
//
// Nothing else in the claim-and-execute path closes that gap:
// `loadPendingPlan` re-verifies the plan (UUID, workspace, the key's
// `inbox_ids` allowlist, `pending`, not expired) and never reads `inboxes` at
// all. So a plan created while a mailbox was healthy could be executed against
// that mailbox after it was revoked or soft-deleted, and the operation those
// plans carry is a BULK DELETE or a bulk move.
//
// The window is the plan TTL: 15 minutes in production (confirmed
// 2026-09-16 against `bulk_plans`, min and max TTL both 00:14:59). Fifteen
// minutes is long enough for the two things that actually cause it — a
// workspace teardown, and an OAuth token expiring so `status` flips to
// 'error'.
//
// ── WHY BOTH CONDITIONS ────────────────────────────────────────────────────
// They are independent. In production on 2026-09-16: 49 soft-deleted inboxes
// across 43 workspaces (all of them also `revoked`, because the workspace
// teardown writes both in one update), plus 4 rows that are `status = 'error'`
// and NOT soft-deleted. Checking either one alone misses real rows.
//
// ── WHAT THIS ASSERTS, AND WHY IT IS SHAPED THIS WAY ───────────────────────
// Every case below uses a MOVE with no `destination_id`, or a delete. That is
// deliberate: `destination_missing` is the first thing the function checks
// AFTER the inbox gate and BEFORE it touches a provider, so it is a witness
// that the gate let the call through — with no network, no IMAP, and no
// mocking of the provider layer. A test that had to stub the provider to prove
// the gate would be testing the stub.
//
// So `destination_missing` means "the gate passed" and is the expected answer
// for a healthy inbox. Seeing it for a revoked one is the bug.
//
// Run: cd supabase/functions/mcp-server &&
//      DENO_NO_PACKAGE_JSON=1 deno test --allow-env --allow-read \
//        bulk-plan-reachability.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import { REACHABLE_INBOX_COLUMNS } from "./reachable-inbox.ts";

Deno.env.set("MCP_INTROSPECTION_ONLY", "1");
Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
const { executeBulkPlanRequest } = await import("./index.ts");

const WORKSPACE = "55555555-5555-4555-8555-555555555555";
const OTHER_WORKSPACE = "66666666-6666-4666-8666-666666666666";
const INBOX = "77777777-7777-4777-8777-777777777777";

/** The API key projection `executeBulkPlanRequest` reads. */
const KEY = {
  id: "88888888-8888-4888-8888-888888888888",
  workspace_id: WORKSPACE,
  name: "test key",
  inbox_ids: null,
  // deno-lint-ignore no-explicit-any
} as any;

/** One PostgREST query, as the function built it. */
interface RecordedQuery {
  table: string;
  projection: string | null;
  eq: Array<[string, unknown]>;
  is: Array<[string, unknown]>;
}

/** A row as production stores it. */
interface FakeInboxRow {
  id: string;
  workspace_id: string;
  status: string;
  deleted_at: string | null;
  provider: string;
  email_address: string;
}

function inboxRow(overrides: Partial<FakeInboxRow> = {}): FakeInboxRow {
  return {
    id: INBOX,
    workspace_id: WORKSPACE,
    status: "active",
    deleted_at: null,
    provider: "imap",
    email_address: "someone@example.com",
    ...overrides,
  };
}

/**
 * A Supabase client that records what it is asked and answers like PostgREST.
 *
 * It really applies `eq` and `is` and really projects to the selected columns,
 * so a query that DROPS a filter gets the unfiltered row back exactly as
 * production would, and a query that drops a column from its projection gets a
 * row without it. Both layers of the defence are exercised for real.
 *
 * `eq` and `is` are recorded separately and `eq` refuses a SQL keyword:
 * `.eq("deleted_at", null)` is `col = NULL`, which is never true, and is a
 * different query from `.is("deleted_at", null)`. Collapsing the two here
 * would make that defect invisible.
 */
function recordingClient(rows: readonly FakeInboxRow[]) {
  const queries: RecordedQuery[] = [];

  const from = (table: string) => {
    const q: RecordedQuery = { table, projection: null, eq: [], is: [] };
    queries.push(q);

    const builder = {
      select(projection: string) {
        q.projection = projection;
        return builder;
      },
      eq(column: string, value: unknown) {
        if (value === null || typeof value === "boolean") {
          throw new Error(
            `.eq("${column}", ${value}) compares against a SQL keyword — PostgREST needs .is()`,
          );
        }
        q.eq.push([column, value]);
        return builder;
      },
      is(column: string, value: unknown) {
        q.is.push([column, value]);
        return builder;
      },
      maybeSingle() {
        const matched = rows.filter((row) => {
          const record = row as unknown as Record<string, unknown>;
          return q.eq.every(([c, v]) => record[c] === v) &&
            q.is.every(([c, v]) => record[c] === v);
        });
        if (matched.length === 0) return Promise.resolve({ data: null, error: null });
        // Project exactly the selected columns, so a projection that forgets
        // `status` or `deleted_at` really hands the predicate a row without it.
        const selected = (q.projection ?? "").split(",").map((c) => c.trim()).filter(Boolean);
        const source = matched[0] as unknown as Record<string, unknown>;
        const projected: Record<string, unknown> = {};
        for (const column of selected) {
          if (column in source) projected[column] = source[column];
        }
        return Promise.resolve({ data: projected, error: null });
      },
    };
    return builder;
  };

  return { client: { from }, queries };
}

/** A move with no frozen destination: the no-network witness described above. */
const MOVE_NO_DESTINATION = {
  inbox_id: INBOX,
  action: "move_batch" as const,
  message_ids: ["1", "2", "3"],
  destination_id: null,
  permanent: false,
};

async function runAgainst(rows: readonly FakeInboxRow[]) {
  const { client, queries } = recordingClient(rows);
  const outcome = await executeBulkPlanRequest(
    MOVE_NO_DESTINATION,
    KEY,
    // deno-lint-ignore no-explicit-any
    client as any,
  );
  return { outcome, queries };
}

// ═══════════════════════════════════════════════════════════════════════════
// The gate
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("a healthy inbox passes the gate", async () => {
  const { outcome } = await runAgainst([inboxRow()]);
  // Past the inbox gate and stopped by the missing destination, which is the
  // next check and the one that needs no provider. Anything else means the
  // gate rejected a mailbox the user can actually reach.
  assertEquals(outcome.error_code, "destination_missing");
});

Deno.test("a soft-deleted inbox cannot be executed against", async () => {
  const { outcome } = await runAgainst([
    // Exactly what `DELETE /api/workspaces/[id]` leaves behind: `deleted_at`
    // and `status: 'revoked'` written together.
    inboxRow({ status: "revoked", deleted_at: "2026-09-01T00:00:00Z" }),
  ]);
  assertEquals(outcome.error_code, "inbox_not_found");
  assertEquals(outcome.succeeded, 0);
  assertEquals(outcome.failed, MOVE_NO_DESTINATION.message_ids.length);
});

Deno.test("a live but non-active inbox cannot be executed against", async () => {
  // The realistic live case: an OAuth token expired, `status` flipped to
  // 'error', the row is NOT soft-deleted. 4 such rows in production on
  // 2026-09-16. `resolveInbox` refuses these, so this path must too.
  const { outcome } = await runAgainst([inboxRow({ status: "error" })]);
  assertEquals(outcome.error_code, "inbox_unreachable");
  assertEquals(outcome.succeeded, 0);
  assertEquals(outcome.failed, MOVE_NO_DESTINATION.message_ids.length);
});

Deno.test("a pending inbox cannot be executed against either", async () => {
  // Not yet finished connecting. `resolveInbox` requires 'active' exactly,
  // rather than listing the statuses it refuses, and so does this.
  const { outcome } = await runAgainst([inboxRow({ status: "pending" })]);
  assertEquals(outcome.error_code, "inbox_unreachable");
});

Deno.test("the refusal is distinguishable from a plan pointing at nothing", async () => {
  // A row that is simply absent is a different situation from a mailbox the
  // user revoked, and the codes must not be merged: 'inbox_unreachable' tells
  // the user to reconnect a mailbox they still have, 'inbox_not_found' does
  // not. The inbox id comes from the plan row and never from the caller, so
  // unlike `resolveInbox` there is no enumeration surface to protect here.
  const { outcome } = await runAgainst([]);
  assertEquals(outcome.error_code, "inbox_not_found");
});

Deno.test("another workspace's inbox is still invisible", async () => {
  const { outcome } = await runAgainst([inboxRow({ workspace_id: OTHER_WORKSPACE })]);
  assertEquals(outcome.error_code, "inbox_not_found");
});

// ═══════════════════════════════════════════════════════════════════════════
// The query it actually issues — the anti-drift layer
//
// The predicate can only decide over columns the projection asked for, and the
// SQL filter is what keeps a soft-deleted row from arriving at all. Asserting
// the built query, rather than the text of index.ts, is what a later edit
// cannot walk around: whatever helper builds it, the query is in the recording.
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("the inbox query filters soft-deleted rows in SQL", async () => {
  const { queries } = await runAgainst([inboxRow()]);
  const inboxQueries = queries.filter((q) => q.table === "inboxes");
  assertEquals(inboxQueries.length, 1);
  const [q] = inboxQueries;

  // `.is()`, not `.eq()`. The recorder's `eq` throws on a keyword, so this is
  // belt and braces, but it names the requirement.
  assert(
    q.is.some(([column, value]) => column === "deleted_at" && value === null),
    "the query must filter `deleted_at is null` in SQL, like every other inboxes read",
  );
  assert(
    q.eq.some(([column, value]) => column === "workspace_id" && value === WORKSPACE),
    "the query must stay scoped to the calling key's workspace",
  );
});

Deno.test("the projection carries every column the predicate decides on", async () => {
  const { queries } = await runAgainst([inboxRow()]);
  const [q] = queries.filter((query) => query.table === "inboxes");
  const projection = (q.projection ?? "").split(",").map((c) => c.trim());

  // Dropping these is the "I am selecting columns I do not use" tidy-up that
  // silently turns `inboxIsReachable` into a constant true, because an ABSENT
  // column is not decisive. Build the projection with `reachableInboxSelect()`
  // and this cannot happen.
  for (const column of REACHABLE_INBOX_COLUMNS) {
    assert(
      projection.includes(column),
      `the projection must include \`${column}\` — see reachableInboxSelect()`,
    );
  }
});

Deno.test("the gate is checked before the destination, not after", async () => {
  // Ordering matters: `destination_missing` is a benign "this plan is
  // malformed" and `inbox_unreachable` is "this mailbox is gone". If the
  // destination check ran first, a revoked mailbox on a malformed plan would
  // report the benign one and the reachability failure would never surface.
  // This is also exactly what the bug looked like from the outside.
  const { outcome } = await runAgainst([inboxRow({ status: "error" })]);
  assertEquals(outcome.error_code, "inbox_unreachable");
});

Deno.test("a delete plan is gated too, not only a move", async () => {
  // The move cases above lean on `destination_missing` as their witness, which
  // a delete has no equivalent of: a delete with an unreachable inbox that got
  // past the gate would go straight to the provider and try to destroy mail.
  // There is nothing benign to fall through to, which is why this case is the
  // one that matters most.
  const { client } = recordingClient([
    inboxRow({ status: "revoked", deleted_at: "2026-09-01T00:00:00Z" }),
  ]);
  const outcome = await executeBulkPlanRequest(
    {
      inbox_id: INBOX,
      action: "delete_batch",
      message_ids: ["1", "2"],
      destination_id: null,
      permanent: true,
    },
    KEY,
    // deno-lint-ignore no-explicit-any
    client as any,
  );
  assertEquals(outcome.error_code, "inbox_not_found");
  assertEquals(outcome.succeeded, 0);
  assertEquals(outcome.failed, 2);
});
