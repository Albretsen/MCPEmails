// ---------------------------------------------------------------------------
// Neither unattended path may act on an inbox that went unreachable.
//
// ── THE BUG ────────────────────────────────────────────────────────────────
// Two code paths resolve a full inbox from a STORED id and then act on it, and
// until 2026-09-17 both filtered on `id` and nothing else, while `resolveInbox`
// and `resolveInboxArg` — the only two ways an ordinary tool call ever reaches
// a mailbox — require `deleted_at is null` AND `status = 'active'`:
//
//   * the scheduled-send dispatcher. Nothing upstream guards it: the pending
//     rows come out of `scheduled_sends` filtered by `status = 'pending'` and
//     `send_at <= now` only. So a send queued while a mailbox was healthy was
//     still attempted after that mailbox was revoked or soft-deleted.
//
//   * `loadInboxRowForTriage`, the single chokepoint every automation route to
//     a provider goes through (`store.loadInbox`, `search`, `resolveFolder`,
//     `openSession`, and the per-message fallback in `applyTriageAction`).
//
// ── WHY THE EXPOSURE IS WORSE THAN THE BULK-PLAN CASE ──────────────────────
// The same defect in `executeBulkPlanRequest` (992ff6e) was bounded by a
// 15-minute plan TTL. These are not. Production on 2026-09-17: scheduled sends
// carry leads up to 3d16h on `sent` rows and 180 days on a cancelled one, and
// all 107 currently-pending rows are due about 2.5 days out. Automations do not
// have a window at all — they recur on the rule's own cadence indefinitely.
//
// Latent, not an incident, confirmed before the fix and not assumed: on
// 2026-09-17 none of the 107 pending sends and none of the 336 enabled rules
// pointed at an unreachable inbox, and the single `sent` row against a
// now-soft-deleted inbox went out 2m26s BEFORE that deletion.
//
// ── WHY BOTH CONDITIONS ────────────────────────────────────────────────────
// They are independent. Production on 2026-09-17: 49 inboxes both soft-deleted
// and 'revoked' (workspace teardown writes the pair at once), and 4 rows
// `status = 'error'` that are NOT soft-deleted. The second group is the
// realistic case for a QUEUED send: an OAuth token expiring under a message
// that was scheduled days ago.
//
// ── WHAT THIS ASSERTS, AND WHY IT IS SHAPED THIS WAY ───────────────────────
// The dispatcher cases use an inbox whose `provider` no supported branch
// matches. That is deliberate: the unsupported-provider throw is the first
// thing after the inbox gate that needs no network, so seeing it is a witness
// that the gate LET THE CALL THROUGH — with no SMTP, no IMAP and no mocking of
// the provider layer. A test that had to stub the provider would be testing
// the stub. So "is not supported by the scheduled-send dispatcher" means the
// gate passed, and is the expected answer for a healthy inbox.
//
// Everything is asserted against the query the code ACTUALLY issues and the
// row it ACTUALLY writes back, never against the source text of index.ts.
//
// Run: cd supabase/functions/mcp-server &&
//      DENO_NO_PACKAGE_JSON=1 deno test --allow-env --allow-read \
//        scheduled-send-reachability.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { REACHABLE_INBOX_COLUMNS } from "./reachable-inbox.ts";
import { runTriageRule, type TriageDeps, type TriageRuleRow } from "./triage-engine.ts";

Deno.env.set("MCP_INTROSPECTION_ONLY", "1");
Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
const { handleScheduledDispatch, loadInboxRowForTriage } = await import("./index.ts");

const WORKSPACE = "55555555-5555-4555-8555-555555555555";
const INBOX = "77777777-7777-4777-8777-777777777777";
const SEND = "99999999-9999-4999-8999-999999999999";

/** One PostgREST query, as the code under test built it. */
interface RecordedQuery {
  table: string;
  op: "select" | "update";
  projection: string | null;
  patch: Record<string, unknown> | null;
  eq: Array<[string, unknown]>;
  is: Array<[string, unknown]>;
  lt: Array<[string, unknown]>;
  lte: Array<[string, unknown]>;
}

type Row = Record<string, unknown>;

/**
 * A Supabase client that records what it is asked and answers like PostgREST.
 *
 * It really applies the filters and really projects to the selected columns, so
 * a query that DROPS a filter gets the unfiltered row back exactly as
 * production would, and a query that drops a column from its projection gets a
 * row without it. Both layers of the defence are exercised for real.
 *
 * Updates mutate the backing rows, so a test can read back what the dispatcher
 * wrote on to the `scheduled_sends` row — which is the whole question for the
 * dispatcher: not only "did it refuse", but "did the user get told".
 *
 * `eq` and `is` are recorded separately and `eq` refuses a SQL keyword:
 * `.eq("deleted_at", null)` is `col = NULL`, which is never true, and is a
 * different query from `.is("deleted_at", null)`. Collapsing the two here would
 * make that defect invisible.
 */
function recordingClient(tables: Record<string, Row[]>) {
  const queries: RecordedQuery[] = [];

  const from = (table: string) => {
    const q: RecordedQuery = {
      table,
      op: "select",
      projection: null,
      patch: null,
      eq: [],
      is: [],
      lt: [],
      lte: [],
    };
    queries.push(q);

    const matched = (): Row[] =>
      (tables[table] ?? []).filter((row) =>
        q.eq.every(([c, v]) => row[c] === v) &&
        q.is.every(([c, v]) => row[c] === v) &&
        q.lt.every(([c, v]) => String(row[c]) < String(v)) &&
        q.lte.every(([c, v]) => String(row[c]) <= String(v))
      );

    /** Exactly the selected columns, so a forgetful projection really bites. */
    const project = (row: Row): Row => {
      if (!q.projection) return { ...row };
      const wanted = q.projection.split(",").map((c) => c.trim()).filter(Boolean);
      const out: Row = {};
      for (const column of wanted) if (column in row) out[column] = row[column];
      return out;
    };

    const settle = () => {
      const rows = matched();
      // An update with no `.select()` still applies; PostgREST answers with no
      // rows and no error, which is what both write-backs here rely on.
      if (q.op === "update" && q.patch) for (const row of rows) Object.assign(row, q.patch);
      return { data: rows.map(project), error: null };
    };

    const builder = {
      select(projection: string) {
        q.projection = projection;
        return builder;
      },
      update(patch: Record<string, unknown>) {
        q.op = "update";
        q.patch = patch;
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
      lt(column: string, value: unknown) {
        q.lt.push([column, value]);
        return builder;
      },
      lte(column: string, value: unknown) {
        q.lte.push([column, value]);
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      single() {
        const { data } = settle();
        // PostgREST's `.single()` is an ERROR on zero rows, not a null. The
        // dispatcher's `inboxErr || !inboxData` depends on that.
        if (data.length === 0) {
          return Promise.resolve({
            data: null,
            error: { message: "JSON object requested, multiple (or no) rows returned" },
          });
        }
        return Promise.resolve({ data: data[0], error: null });
      },
      maybeSingle() {
        const { data } = settle();
        return Promise.resolve({ data: data[0] ?? null, error: null });
      },
      // Awaiting the builder directly is how the list and the bare updates are
      // written, so the builder is thenable as well as terminal-callable.
      // deno-lint-ignore no-explicit-any
      then(resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) {
        return Promise.resolve(settle()).then(resolve, reject);
      },
    };
    return builder;
  };

  return { client: { from }, queries, tables };
}

/** A row as production stores it, projected down to what these paths read. */
function inboxRow(overrides: Row = {}): Row {
  return {
    id: INBOX,
    workspace_id: WORKSPACE,
    status: "active",
    deleted_at: null,
    // No supported branch matches this, so the dispatcher's own
    // unsupported-provider throw becomes the "the gate passed" witness and
    // nothing ever opens a socket. See the header.
    provider: "nonesuch",
    email_address: "someone@example.com",
    ...overrides,
  };
}

/** A pending row that is due, as `listDueRules`' equivalent would hand it over. */
function scheduledSendRow(overrides: Row = {}): Row {
  return {
    id: SEND,
    inbox_id: INBOX,
    status: "pending",
    // Plaintext legacy payload: `resolveScheduledPayload` passes it straight
    // through, so no encryption key is needed and nothing is mocked.
    payload: { to: ["someone-else@example.com"], subject: "hi", body: "there" },
    payload_encrypted: false,
    send_at: "2020-01-01T00:00:00.000Z",
    sent_at: null,
    error_detail: null,
    updated_at: "2020-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function dispatchAgainst(inboxes: Row[], sendOverrides: Row = {}) {
  const send = scheduledSendRow(sendOverrides);
  const { client, queries, tables } = recordingClient({
    scheduled_sends: [send],
    inboxes,
  });
  // deno-lint-ignore no-explicit-any
  const response = await handleScheduledDispatch(client as any);
  const summary = await response.json();
  return { summary, queries, send: tables.scheduled_sends[0], dispatched: summary.dispatched };
}

// ═══════════════════════════════════════════════════════════════════════════
// The scheduled-send dispatcher
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("a healthy inbox passes the dispatcher's gate", async () => {
  const { summary, send } = await dispatchAgainst([inboxRow()]);
  // Past the inbox gate and stopped by the unsupported provider, which is the
  // next thing that needs no network. Anything else means the gate rejected a
  // mailbox the user can actually reach.
  assertStringIncludes(
    String(send.error_detail),
    "is not supported by the scheduled-send dispatcher",
  );
  assertEquals(summary.dispatched, 0);
});

Deno.test("a soft-deleted inbox never reaches a provider", async () => {
  // Exactly what `DELETE /api/workspaces/[id]` leaves behind: `deleted_at` and
  // `status: 'revoked'` written together.
  const { summary, send } = await dispatchAgainst([
    inboxRow({ status: "revoked", deleted_at: "2026-09-01T00:00:00Z" }),
  ]);
  assertEquals(summary.errored, 1);
  assertEquals(summary.dispatched, 0);
  assertEquals(send.status, "error");
  // The SQL filter keeps the row from arriving at all, so this lands on the
  // pre-existing "not found" throw rather than the predicate below it.
  assertStringIncludes(String(send.error_detail), "not found");
});

Deno.test("a live but non-active inbox never reaches a provider", async () => {
  // The realistic queued-send case: the message was scheduled days ago, the
  // OAuth token expired in the meantime, `status` flipped to 'error' and the
  // row is NOT soft-deleted. 4 such rows in production on 2026-09-17.
  const { summary, send } = await dispatchAgainst([inboxRow({ status: "error" })]);
  assertEquals(summary.errored, 1);
  assertEquals(summary.dispatched, 0);
  assertEquals(send.status, "error");
  assertStringIncludes(String(send.error_detail), "no longer connected");
});

Deno.test("a pending inbox is refused too", async () => {
  // Not finished connecting. `resolveInbox` requires 'active' exactly, rather
  // than listing the statuses it refuses, and so does this.
  const { send } = await dispatchAgainst([inboxRow({ status: "pending" })]);
  assertEquals(send.status, "error");
  assertStringIncludes(String(send.error_detail), "no longer connected");
});

Deno.test("the refusal is terminal and legible, not a silent drop", async () => {
  // THE REPORTING DECISION, asserted rather than described. Nobody is watching
  // an unattended send the way a user watches a bulk plan's card, so the row
  // has to end somewhere the dashboard shows it. A silent skip would leave the
  // row 'sending' forever (swept up later as "dispatch interrupted", which is
  // a lie about what happened) and the user would never learn the message did
  // not go.
  const { send } = await dispatchAgainst([inboxRow({ status: "error" })]);
  assertEquals(send.status, "error");
  assertEquals(send.sent_at, null);
  // Actionable, and it names the remedy. `status` is included because 'error'
  // and 'revoked' mean different things to the person reading it.
  assertStringIncludes(String(send.error_detail), "Reconnect it");
  assertStringIncludes(String(send.error_detail), "status: error");
});

Deno.test("an unreachable inbox is failed, not deferred back on to the queue", async () => {
  // The defer path exists for a mail server that refused a message before
  // receiving any of it: nothing was consumed, so the next tick may as well
  // try again. A revoked mailbox is the opposite — it does not heal inside the
  // defer window, and putting the row back to 'pending' would spin it for two
  // hours and then fail it anyway, while telling the user nothing meanwhile.
  const { summary, send } = await dispatchAgainst([inboxRow({ status: "error" })]);
  assertEquals(summary.deferred, 0);
  assertEquals(send.status, "error");
});

Deno.test("the dispatcher's inbox query filters soft-deleted rows in SQL", async () => {
  const { queries } = await dispatchAgainst([inboxRow()]);
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
    q.eq.some(([column, value]) => column === "id" && value === INBOX),
    "the query must still resolve the id frozen on to the scheduled_sends row",
  );
});

Deno.test("the dispatcher's projection carries every column the predicate decides on", async () => {
  const { queries } = await dispatchAgainst([inboxRow()]);
  const [q] = queries.filter((query) => query.table === "inboxes");
  const projection = (q.projection ?? "").split(",").map((c) => c.trim());

  // Dropping these is the "I am selecting columns I do not use" tidy-up that
  // silently turns `inboxIsReachable` into a constant true, because an ABSENT
  // column is not decisive. Build the projection with `reachableInboxSelect()`
  // and it cannot happen.
  for (const column of REACHABLE_INBOX_COLUMNS) {
    assert(
      projection.includes(column),
      `the projection must include \`${column}\` — see reachableInboxSelect()`,
    );
  }
  // And it must still carry what the send itself needs, or the gate would be
  // bought by breaking the send.
  for (const column of ["provider", "email_address", "signature_html"]) {
    assert(projection.includes(column), `the projection must keep \`${column}\``);
  }
});

Deno.test("the gate runs before the payload is even decrypted", async () => {
  // Ordering, asserted through a row that would THROW if it were read: an
  // encrypted payload with no ciphertext. `resolveScheduledPayload` runs right
  // after the inbox gate, so if the gate let this through the failure would be
  // a decryption error rather than the mailbox one, and the user would be told
  // the wrong thing about their own message.
  const { send } = await dispatchAgainst(
    [inboxRow({ status: "revoked", deleted_at: "2026-09-01T00:00:00Z" })],
    { payload_encrypted: true, payload: {} },
  );
  assertStringIncludes(String(send.error_detail), "not found");
});

// ═══════════════════════════════════════════════════════════════════════════
// The automation runner
// ═══════════════════════════════════════════════════════════════════════════

async function loadForTriage(inboxes: Row[]) {
  const { client, queries } = recordingClient({ inboxes });
  // deno-lint-ignore no-explicit-any
  const row = await loadInboxRowForTriage(INBOX, client as any);
  return { row, queries };
}

Deno.test("the triage loader returns a healthy inbox", async () => {
  const { row } = await loadForTriage([inboxRow({ provider: "imap" })]);
  assert(row !== null, "a reachable mailbox must still load");
  assertEquals(row?.id, INBOX);
});

Deno.test("the triage loader refuses a soft-deleted inbox", async () => {
  const { row } = await loadForTriage([
    inboxRow({ status: "revoked", deleted_at: "2026-09-01T00:00:00Z" }),
  ]);
  assertEquals(row, null);
});

Deno.test("the triage loader refuses a live but non-active inbox", async () => {
  // Automations recur, so this is the one that ran on a cadence forever.
  const { row } = await loadForTriage([inboxRow({ status: "error" })]);
  assertEquals(row, null);
});

Deno.test("the triage loader refuses a pending inbox", async () => {
  const { row } = await loadForTriage([inboxRow({ status: "pending" })]);
  assertEquals(row, null);
});

Deno.test("the triage loader's query filters soft-deleted rows in SQL", async () => {
  const { queries } = await loadForTriage([inboxRow()]);
  const [q] = queries.filter((query) => query.table === "inboxes");
  assert(
    q.is.some(([column, value]) => column === "deleted_at" && value === null),
    "the query must filter `deleted_at is null` in SQL",
  );
});

Deno.test("the triage loader's projection carries every column the predicate decides on", async () => {
  const { queries } = await loadForTriage([inboxRow()]);
  const [q] = queries.filter((query) => query.table === "inboxes");
  const projection = (q.projection ?? "").split(",").map((c) => c.trim());
  for (const column of REACHABLE_INBOX_COLUMNS) {
    assert(
      projection.includes(column),
      `the projection must include \`${column}\` — see reachableInboxSelect()`,
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// …and what the runner does with that null.
//
// The loader returning null is only half the fix. The other half is that the
// engine turns it into something the OWNER can see, which is why these drive
// the real `runTriageRule` over the real loader rather than asserting on null.
// ═══════════════════════════════════════════════════════════════════════════

/** The rule as `listDueRules` hands it over. */
function triageRule(overrides: Partial<TriageRuleRow> = {}): TriageRuleRow {
  return {
    id: "rule-1",
    workspace_id: WORKSPACE,
    inbox_id: INBOX,
    api_key_id: "key-1",
    name: "Archive newsletters",
    enabled: true,
    filter: { from: "news@example.com" },
    action: { type: "move", folder: "Newsletters" },
    interval_minutes: 60,
    max_messages_per_run: 25,
    next_run_at: new Date(0).toISOString(),
    running_since: null,
    consecutive_failures: 0,
    ...overrides,
  } as TriageRuleRow;
}

/**
 * The engine, wired to the REAL loader over a recording client.
 *
 * `loadInbox` is a copy of `triageStore.loadInbox` in index.ts, which is the
 * one seam that cannot be imported (it closes over the module client). The
 * function it delegates to is the real one, and that is where the fix lives.
 */
function triageHarness(inboxes: Row[], overrides: Partial<TriageDeps> = {}) {
  const { client } = recordingClient({ inboxes });
  const runs: Record<string, unknown>[] = [];
  const released: Record<string, unknown>[] = [];
  let searched = 0;
  let sessionsOpened = 0;

  const deps = {
    store: {
      listStaleLeases: () => Promise.resolve([]),
      reclaimStaleLease: () => Promise.resolve(),
      listDueRules: () => Promise.resolve([]),
      claimRule: () => Promise.resolve(true),
      releaseRule: (_id: string, update: Record<string, unknown>) => {
        released.push(update);
        return Promise.resolve();
      },
      createRun: () => Promise.resolve("run-1"),
      finishRun: (_id: string | null, update: Record<string, unknown>) => {
        runs.push(update);
        return Promise.resolve();
      },
      claimMessage: () => Promise.resolve(true),
      writeRunItem: () => Promise.resolve(),
      loadApiKey: () =>
        Promise.resolve({
          id: "key-1",
          workspace_id: WORKSPACE,
          name: "Automations key",
          scopes: ["read:email", "manage:folders", "manage:drafts", "send:email"],
          inbox_ids: null,
          expires_at: null,
          deleted_at: null,
        }),
      loadKeyGrant: () => Promise.resolve(null),
      async loadInbox(inboxId: string) {
        // deno-lint-ignore no-explicit-any
        const row = await loadInboxRowForTriage(inboxId, client as any);
        if (!row) return null;
        return {
          id: row.id,
          workspace_id: row.workspace_id,
          email_address: row.email_address,
          provider: row.provider,
        };
      },
    },
    digest: (id: string) => Promise.resolve(`digest:${id}`),
    encrypt: (text: string) => Promise.resolve(text),
    search: () => {
      searched++;
      return Promise.resolve([]);
    },
    resolveFolder: () => Promise.resolve({ id: "dest", verified: true }),
    applyAction: () => Promise.resolve({ ok: true as const, undo: { op: "move" } }),
    openSession: () => {
      sessionsOpened++;
      return Promise.resolve(null);
    },
    closeSession: () => Promise.resolve(),
    meter: () => Promise.resolve(),
    ...overrides,
    // deno-lint-ignore no-explicit-any
  } as any as TriageDeps;

  return { deps, runs, released, counters: () => ({ searched, sessionsOpened }) };
}

Deno.test("a rule over a reachable inbox still runs", async () => {
  const h = triageHarness([inboxRow({ provider: "imap" })]);
  const summary = await runTriageRule(h.deps, triageRule());
  // 'skipped' rather than 'completed' only because this harness's search
  // returns no matches, which the engine reports as a run that found nothing.
  // What matters is that the run is not `failed` and the search ACTUALLY RAN:
  // that is the witness the gate let a healthy mailbox through.
  assertEquals(summary.status, "skipped");
  assertEquals(summary.error_code, null);
  assertEquals(h.counters().searched, 1);
});

Deno.test("a rule over an unreachable inbox fails the run instead of triaging it", async () => {
  // 'error', not soft-deleted: the mailbox is still the user's, its credentials
  // just stopped working. Before the fix this ran the search and every action
  // against it, on the rule's cadence, for as long as the rule stayed enabled.
  const h = triageHarness([inboxRow({ provider: "imap", status: "error" })]);
  const summary = await runTriageRule(h.deps, triageRule());
  assertEquals(summary.status, "failed");
  assertEquals(summary.error_code, "inbox_unavailable");
});

Deno.test("the unreachable rule never touches a provider", async () => {
  // The gate is upstream of BOTH the search and the shared connection, so a
  // revoked mailbox produces no provider traffic at all — not a failed search,
  // not a refused handshake. This is what makes the failure cheap enough to
  // repeat until the auto-disable ceiling.
  const h = triageHarness([
    inboxRow({ provider: "imap", status: "revoked", deleted_at: "2026-09-01T00:00:00Z" }),
  ]);
  await runTriageRule(h.deps, triageRule());
  assertEquals(h.counters(), { searched: 0, sessionsOpened: 0 });
});

Deno.test("the failed run says why, in words aimed at the person who can fix it", async () => {
  // THE REPORTING DECISION for this path, asserted rather than described. A
  // quiet skip was the alternative and is worse: it would leave the automation
  // enabled and apparently healthy while it did nothing, and the owner would
  // never learn their mailbox needs reconnecting. There is no card in front of
  // anyone here, so the failed run IS the only channel.
  const h = triageHarness([inboxRow({ provider: "imap", status: "error" })]);
  await runTriageRule(h.deps, triageRule());
  assertEquals(h.runs.length, 1);
  const [run] = h.runs;
  assertEquals(run.status, "failed");
  assertEquals(run.error_code, "inbox_unavailable");
  // NOT "no longer exists", which is what this said until 2026-09-17 and is
  // simply false for a mailbox the user still has and only needs to reconnect.
  assertStringIncludes(String(run.error_detail), "not reachable");
  assertStringIncludes(String(run.error_detail), "Reconnect it");
});

Deno.test("the failing rule counts toward auto-disable rather than retrying forever", async () => {
  // Why this is a FAILED run and not an invented "skipped" state. `failRun`
  // increments `consecutive_failures`, and at TRIAGE_MAX_CONSECUTIVE_FAILURES
  // the rule disables itself with a `disabled_reason` and notifies the owner.
  // So "erroring a recurring automation into a retry loop" is not what this
  // does: the existing shape already bounds it, which is why the fix reuses it
  // instead of adding a new one.
  const h = triageHarness([inboxRow({ provider: "imap", status: "error" })]);
  await runTriageRule(h.deps, triageRule({ consecutive_failures: 4 }));
  assertEquals(h.released.length, 1);
  const [release] = h.released;
  assertEquals(release.consecutive_failures, 5);
  assertEquals(release.enabled, false);
  assertStringIncludes(String(release.disabled_reason), "inbox_unavailable");
});
