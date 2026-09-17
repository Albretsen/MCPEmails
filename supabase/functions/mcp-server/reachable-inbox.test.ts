// ---------------------------------------------------------------------------
// "Which inboxes can this key actually act on?" — the two MCP Apps rollups.
//
// Both bugs these cover were live in production on 2026-09-16 and both are the
// SAME missing filter, in opposite directions:
//
//   * `allInboxesHideDraftEditor` is an `.every()`. A soft-deleted inbox keeps
//     `draft_editor_hidden = false` forever, so one of them made the rollup
//     unable to reach true and the user's opt-out could never suppress
//     `_meta.ui`. Confirmed in the owner's own workspace
//     f8c497ac-dafe-4635-a1be-4b1aace224c9: a revoked, soft-deleted
//     `hello@mcpemails.com` row beside one active inbox. Across production: 49
//     soft-deleted inboxes in 43 workspaces, 2 of them gated into the editor.
//
//   * `reviewCardOptInsFromRows` is a `.some()`. The same soft-deleted row with
//     `send_approval_required` turned the OUTBOUND card gate ON for a key that
//     cannot reach it. Pre-existing, unrelated to the draft editor.
//
// The queries in `index.ts` filter in SQL as well; these functions are the
// second layer, and the layer a test can hold onto. The one exception is
// `status` on the `.every()` rollup, which is decided HERE and deliberately not
// in SQL — see `allInboxesHideDraftEditor` and the query-shape test below.
//
// A THIRD bug, fixed 2026-09-17, is not a missing filter but a missing
// fallback: when a key reached NOTHING, `allInboxesHideDraftEditor` returned a
// flat false and handed a user back a card they had switched off, the moment
// their only inbox's token expired. A preference does not lapse because a
// mailbox went unreachable.
//
// Run: cd supabase/functions/mcp-server &&
//      DENO_NO_PACKAGE_JSON=1 deno test --allow-env --allow-read reachable-inbox.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  allInboxesHideDraftEditor,
  type DraftEditorHiddenRow,
  inboxIsReachable,
  REACHABLE_INBOX_COLUMNS,
  REACHABLE_INBOX_SQL,
  reachableInboxSelect,
  reviewCardOptInsFromRows,
  type ReviewCardOptInRow,
  SOFT_DELETE_SQL,
} from "./reachable-inbox.ts";

/** The live row shape, as production actually stores it. */
const ACTIVE = { status: "active", deleted_at: null };
/**
 * A soft-deleted row exactly as `DELETE /api/workspaces/[id]` leaves it: the
 * teardown writes `deleted_at` AND `status: 'revoked'` in one update and
 * touches no preference column, so `draft_editor_hidden` stays at its
 * NOT NULL DEFAULT false forever.
 */
const SOFT_DELETED = { status: "revoked", deleted_at: "2026-09-01T00:00:00Z" };
/** Live, but broken. Never resolvable: `resolveInbox` requires status 'active'. */
const ERRORED = { status: "error", deleted_at: null };

// ═══════════════════════════════════════════════════════════════════════════
// The predicate
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("reachable means BOTH not soft-deleted and status active", () => {
  assert(inboxIsReachable(ACTIVE));
  assert(!inboxIsReachable(SOFT_DELETED), "a soft-deleted inbox reaches nothing");
  // Neither condition implies the other. In production on 2026-09-16 all 49
  // soft-deleted rows happened to be 'revoked', but 4 rows were 'error' and
  // NOT deleted — so checking one and not the other would miss real rows.
  assert(!inboxIsReachable(ERRORED), "a non-active inbox reaches nothing either");
  assert(!inboxIsReachable({ status: "pending", deleted_at: null }));
  // A `deleted_at` that is present is decisive: only `null` is "not deleted",
  // anything else is a timestamp.
  assert(!inboxIsReachable({ status: "active", deleted_at: "" }));
});

// ═══════════════════════════════════════════════════════════════════════════
// A MISSING column is not a "no" — the projection-drift hole
//
// "The two layers cannot disagree" was false, and it failed UNSAFE. Dropping
// the SQL filter is caught (that is the case the second layer was designed
// for). Dropping `, status, deleted_at` from either caller's `.select()` — the
// plausible "why am I selecting columns I do not use?" tidy-up — was not:
// `row.status` came back `undefined`, `undefined === "active"` is false, so
// EVERY row was unreachable and the whole suite still passed while
//
//   * `allInboxesHideDraftEditor` became a constant false: the per-inbox
//     opt-out could never suppress `_meta.ui` again, which is the exact bug
//     this module exists to stop, silently reopened;
//   * `reviewCardOptInsFromRows` became a constant {outbound:false,bulk:false}:
//     the outbound review card permanently off for every key.
//
// So absence is now logged as the code defect it is and is NOT decisive, and
// `reachableInboxSelect` is what stops the projection drifting in the first
// place.
// ═══════════════════════════════════════════════════════════════════════════

/** Run `body` with console.error captured rather than printed. */
function capturingErrors<T>(body: () => T): { value: T; errors: string[] } {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => JSON.stringify(a)).join(" "));
  };
  try {
    return { value: body(), errors };
  } finally {
    console.error = original;
  }
}

Deno.test("a row missing the deciding columns is NOT silently unreachable", () => {
  const { value, errors } = capturingErrors(() => ({
    // The exact shape `.select("draft_editor_hidden")` returns.
    bothMissing: inboxIsReachable({} as Record<string, never>),
    // Half-drift: whichever column survives still decides.
    statusOnly: inboxIsReachable({ status: "active" }),
    revokedStatusOnly: inboxIsReachable({ status: "revoked" }),
    deletedAtOnly: inboxIsReachable({ deleted_at: null }),
    softDeletedOnly: inboxIsReachable({ deleted_at: "2026-09-01T00:00:00Z" }),
    // A key present with an explicit `undefined` is the same as absent:
    // PostgREST never sends that, so it can only be a constructed row.
    explicitUndefined: inboxIsReachable({ status: undefined, deleted_at: undefined }),
  }));

  assert(value.bothMissing, "missing is not 'no' — it is a projection defect");
  assert(value.statusOnly, "a surviving column is still decisive");
  assert(!value.revokedStatusOnly);
  assert(value.deletedAtOnly);
  assert(!value.softDeletedOnly);
  assert(value.explicitUndefined);

  // Loud, not silent. This is the only signal a reviewer gets that the two
  // layers have come apart, and it names the fix.
  assertEquals(errors.length, 6, "every drifted row is reported");
  assert(errors[0].includes("reachable_inbox_projection_drift"), errors[0]);
  assert(errors[0].includes("status"), "names which columns are gone");
  assert(errors[0].includes("deleted_at"));
  assert(errors[0].includes("reachableInboxSelect"), "names the fix");
  // A fully-present row says nothing at all.
  assertEquals(capturingErrors(() => inboxIsReachable(ACTIVE)).errors, []);
});

Deno.test("a drifted projection degrades to the SQL filter, not to a constant", () => {
  // The realistic shape of the drift: the `.select()` loses the two columns and
  // the SQL `WHERE` stays, so the rows that arrive are ALREADY filtered. Both
  // rollups must then be exactly right, not inverted.
  const hiddenOnly = [{ draft_editor_hidden: true }, { draft_editor_hidden: true }];
  const mixed = [{ draft_editor_hidden: true }, { draft_editor_hidden: false }];
  capturingErrors(() => {
    assert(
      allInboxesHideDraftEditor(hiddenOnly),
      "the per-inbox opt-out must still be able to suppress _meta.ui",
    );
    assert(!allInboxesHideDraftEditor(mixed), "and must not over-suppress");
    assertEquals(
      reviewCardOptInsFromRows([{ send_approval_required: true, bulk_review_mode: "plan" }]),
      { outbound: true, bulk: true },
      "the outbound and bulk cards must not be switched off for every key",
    );
  });
});

Deno.test("a PRESENT column is still decisive, so a dropped SQL filter is still caught", () => {
  // The defence-in-depth layer is untouched. This is the case the module was
  // written for: the projection is right, the `WHERE` is gone.
  assert(
    allInboxesHideDraftEditor([
      { ...ACTIVE, draft_editor_hidden: true },
      { ...SOFT_DELETED, draft_editor_hidden: false },
    ]),
    "a soft-deleted row must not defeat the rollup",
  );
  assertEquals(
    reviewCardOptInsFromRows([{ ...SOFT_DELETED, send_approval_required: true }]),
    { outbound: false, bulk: false },
    "and must not turn the outbound gate on",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// The projection and the predicate are ONE list
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("reachableInboxSelect appends exactly the columns the predicate reads", () => {
  assertEquals(
    reachableInboxSelect("draft_editor_hidden"),
    "draft_editor_hidden, status, deleted_at",
  );
  assertEquals(
    reachableInboxSelect("bulk_review_mode", "send_approval_required"),
    "bulk_review_mode, send_approval_required, status, deleted_at",
  );
  // A caller that names one itself does not get it twice: PostgREST would take
  // it, but a duplicated column is the beginning of a hand-maintained list.
  assertEquals(reachableInboxSelect("status", "id"), "status, id, deleted_at");
  assertEquals(reachableInboxSelect(), "status, deleted_at");
  for (const column of REACHABLE_INBOX_COLUMNS) {
    assert(reachableInboxSelect("x").includes(column), column);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// THE QUERIES THE ROLLUPS ACTUALLY ISSUE — behaviour, not source text
//
// ── Why this replaced a source pin ─────────────────────────────────────────
// Until 2026-09-17 the guarantee that `index.ts` applies the SQL half of this
// filter was a pin on the TEXT of `index.ts`: read the file, strip its
// comments, find the two rollup functions, match the shape of every `.select(`
// inside them. Three adversarial rounds broke that pin without ever changing
// the behaviour it claimed to protect:
//
//   1. `source.match(/\.select\(reachableInboxSelect\(/g).length === 2` was
//      satisfied by putting the real call in a COMMENT:
//          .select("draft_editor_hidden") // was .select(reachableInboxSelect(
//      Two of those, both projections hand-written, both rollups constants,
//      green at 1187/1187.
//   2. the literal ban beside it banned two EXACT strings, so the same
//      projection in a different column order walked straight through.
//   3. the hand-rolled comment stripper written to close (1) does NOT consume
//      `${…}` inside a template literal — it closes the outer template at the
//      first inner backtick. `const label = `inbox${ "list`for" }summary`;`
//      desynchronises it, and everything after is misread. With that one line
//      in place, a THIRD rollup helper with a hand-written projection and NO
//      `.is("deleted_at", null)` / `.eq("status", "active")` at all sat in
//      `index.ts` with this file at 17/17 and the suite at 1204/1204.
//
// The pattern is not bad luck. A scanner over source text can be confused, and
// a pin on the text of two named functions says nothing about a third. So the
// pin is gone — `stripComments` and `functionBody` with it, because a broken
// scanner nothing depends on is worse than no scanner — and what is asserted
// instead is what the rollups ASK THE DATABASE FOR.
//
// `keyReviewCardGates` takes its Supabase client as a parameter (defaulting to
// the module-level one, so production is unchanged), and these tests hand it a
// recorder. Every `inboxes` query that call issues is captured, whoever built
// it and whichever helper it came from, and EVERY one of them must carry both
// filters and both deciding columns. A third helper is not a way around that:
// the moment `keyReviewCardGates` uses it, its query is in the recording.
// ═══════════════════════════════════════════════════════════════════════════

Deno.env.set("MCP_INTROSPECTION_ONLY", "1");
Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
const { keyReviewCardGates } = await import("./index.ts");

const WORKSPACE = "44444444-4444-4444-8444-444444444444";
const ROLLED_OUT = { draft_editor_enabled: true, draft_editor_hidden: false };

/** One PostgREST query, as the rollup built it. */
interface RecordedQuery {
  table: string;
  /** The `select()` projection string, or null when the query never selected. */
  projection: string | null;
  eq: Array<[string, unknown]>;
  is: Array<[string, unknown]>;
  in: Array<[string, readonly unknown[]]>;
  or: string[];
}

/** A row as production stores it, with every column these rollups can ask for. */
interface FakeInboxRow {
  id: string;
  workspace_id: string;
  status: string;
  deleted_at: string | null;
  draft_editor_hidden?: boolean;
  bulk_review_mode?: string;
  send_approval_required?: boolean;
}

/**
 * `col.eq.value` / `col.is.true` — the only two shapes `keyReviewCardGates`
 * builds, and they are NOT interchangeable. See `builder.eq` below.
 */
function matchesOrTerm(row: Record<string, unknown>, term: string): boolean {
  const [column, operator, ...rest] = term.split(".");
  const raw = rest.join(".");
  const value = raw === "true" ? true : raw === "false" ? false : raw === "null" ? null : raw;
  if (operator === "is") return row[column] === value;
  if (operator === "eq") {
    // `eq.null` and `eq.true` are SQL `=` against a keyword. `col = NULL` is
    // never true, and `col = 'true'` is a text comparison. PostgREST has `is`
    // for exactly this reason; an `eq` term with a keyword value is a defect.
    if (value === null || typeof value === "boolean") {
      throw new Error(
        `.or() term "${term}" uses eq against a SQL keyword — PostgREST needs is.${raw}`,
      );
    }
    return row[column] === value;
  }
  throw new Error(`the recorder does not model the '${operator}' operator: ${term}`);
}

/**
 * A Supabase client that records what it is asked and answers like PostgREST.
 *
 * It really applies `eq` / `is` / `in` / `or` and really projects to the
 * selected columns, so a query that DROPS a filter gets the unfiltered rows
 * back exactly as production would, and a query that drops a column from its
 * projection gets rows without it. Both halves of the defence are therefore
 * exercised for real rather than simulated.
 *
 * ── `eq` AND `is` ARE MODELLED DISTINCTLY, AND THAT IS THE POINT ───────────
 * They used to be one line — `[...q.eq, ...q.is]`, both `row[c] === v` — which
 * made `.eq("deleted_at", null)` and `.is("deleted_at", null)` indistinguishable
 * here while being completely different queries in production. Swapping the
 * rollup's `.is` for `.eq` failed ONLY the structural assertion below; all five
 * "production bugs, end to end" tests stayed green, i.e. the behavioural half of
 * this file could not see the exact class of bug the whole module exists to
 * stop. Now `eq` refuses a SQL keyword, so the swap breaks the behaviour too.
 *
 * ── TWO GAPS THAT REMAIN, NAMED ───────────────────────────────────────────
 *   * PostgREST truncates any row-returning select at 1000 rows with no error.
 *     This recorder returns everything it is given, so a query that needs a
 *     narrowing filter to stay under that ceiling looks fine here. See the note
 *     on `allReachableInboxesHideDraftEditor` in index.ts, which has no
 *     narrowing `.or()` and is documented rather than guarded.
 *   * `resolve()` answers `{ error: null }`. `failingClient` below is what
 *     exercises the two fail directions instead.
 */
function recordingClient(
  inboxes: readonly FakeInboxRow[],
  workspace: { draft_editor_enabled: boolean; draft_editor_hidden: boolean },
) {
  const queries: RecordedQuery[] = [];
  const rowsFor = (table: string): Array<Record<string, unknown>> =>
    table === "inboxes"
      ? inboxes.map((row) => ({ ...row }) as Record<string, unknown>)
      : [{ id: WORKSPACE, ...workspace }];

  const from = (table: string) => {
    const q: RecordedQuery = { table, projection: null, eq: [], is: [], in: [], or: [] };
    queries.push(q);

    const resolve = () => {
      let rows = rowsFor(table);
      // `is` is a SQL `IS` test: `IS NULL`, `IS TRUE`, `IS FALSE`.
      for (const [column, value] of q.is) {
        rows = rows.filter((row) => row[column] === value);
      }
      // `eq` is a SQL `=`. Against a non-keyword value it is an ordinary
      // comparison; a keyword value never reaches here (see `builder.eq`).
      for (const [column, value] of q.eq) {
        rows = rows.filter((row) => row[column] === value);
      }
      for (const [column, values] of q.in) {
        rows = rows.filter((row) => values.includes(row[column]));
      }
      for (const filter of q.or) {
        const terms = filter.split(",");
        rows = rows.filter((row) => terms.some((term) => matchesOrTerm(row, term)));
      }
      if (q.projection === null) return rows;
      // PostgREST returns ONLY the selected columns. A column the projection
      // forgot is absent from the row, which is the drift `inboxIsReachable`
      // reports and degrades on — so the recorder must reproduce it.
      const columns = q.projection.split(",").map((c) => c.trim()).filter((c) => c.length > 0);
      return rows.map((row) => {
        const projected: Record<string, unknown> = {};
        for (const column of columns) {
          if (column in row) projected[column] = row[column];
        }
        return projected;
      });
    };

    const builder = {
      select(projection: string) {
        q.projection = projection;
        return builder;
      },
      eq(column: string, value: unknown) {
        // THE ONE THING THIS DOUBLE MUST NOT LET THROUGH.
        // supabase-js builds `?col=eq.null` from `.eq(col, null)`, which is SQL
        // `col = NULL` — never true for any row, and specifically NOT the
        // soft-delete test the caller meant. `.eq(col, true)` is the same
        // mistake against a boolean. PostgREST has `is` for both. Modelling
        // these as `row[c] === v` is what let `.is` -> `.eq` pass every
        // behavioural test in this file while breaking production.
        //
        // Thrown rather than modelled as "matches nothing": the exact PostgREST
        // semantics of `eq.null` are version-dependent and cannot be checked
        // from this test run, and every reading of them is wrong. A query this
        // codebase may not issue should stop the call, not quietly pick one of
        // two wrong answers. The rollups' own try/catch turns this into their
        // documented failure direction, which is what the behavioural tests
        // then see.
        if (value === null || typeof value === "boolean") {
          throw new Error(
            `.eq("${column}", ${String(value)}) is a SQL '=' against a keyword and ` +
              `matches nothing. Use .is("${column}", ${String(value)}).`,
          );
        }
        q.eq.push([column, value]);
        return builder;
      },
      is(column: string, value: unknown) {
        q.is.push([column, value]);
        return builder;
      },
      in(column: string, values: readonly unknown[]) {
        q.in.push([column, values]);
        return builder;
      },
      or(filter: string) {
        q.or.push(filter);
        return builder;
      },
      maybeSingle() {
        const rows = resolve();
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      // The builder is thenable, exactly as PostgREST's is, so `await query`
      // and `Promise.all([query, ...])` in index.ts work unchanged.
      then<R1, R2>(
        onfulfilled?: ((value: { data: unknown; error: null }) => R1 | PromiseLike<R1>) | null,
        onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
      ): Promise<R1 | R2> {
        return Promise.resolve({ data: resolve(), error: null }).then(onfulfilled, onrejected);
      },
    };
    return builder;
  };

  return { client: { from }, queries };
}

/** An `api_keys` row shaped the way the server's own loaders build one. */
function gateKey(overrides: { inbox_ids?: string[] | null } = {}) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    workspace_id: WORKSPACE,
    name: "OAuth: Claude",
    key_prefix: "mcpe_abc",
    key_hash: "",
    scopes: ["read:email", "send:email", "manage:drafts", "manage:mailbox"],
    inbox_ids: overrides.inbox_ids ?? null,
    expires_at: null,
    last_used_at: null,
    deleted_at: null,
    created_at: new Date(0).toISOString(),
    // The row type lives in index.ts and is not exported, which is why callers
    // of `keyReviewCardGates` below cast rather than annotate.
  };
}

/** Drive the REAL gate resolution against a recording client. */
async function driveGates(
  inboxes: readonly FakeInboxRow[],
  options: {
    inboxIds?: string[] | null;
    workspace?: { draft_editor_enabled: boolean; draft_editor_hidden: boolean };
  } = {},
) {
  const { client, queries } = recordingClient(inboxes, options.workspace ?? ROLLED_OUT);
  const gates = await keyReviewCardGates(
    // deno-lint-ignore no-explicit-any
    gateKey({ inbox_ids: options.inboxIds ?? null }) as any,
    client,
  );
  return { gates, queries, inboxQueries: queries.filter((q) => q.table === "inboxes") };
}

function activeRow(id: string, extra: Partial<FakeInboxRow> = {}): FakeInboxRow {
  return { id, workspace_id: WORKSPACE, status: "active", deleted_at: null, ...extra };
}

function revokedRow(id: string, extra: Partial<FakeInboxRow> = {}): FakeInboxRow {
  // Exactly what `DELETE /api/workspaces/[id]` leaves behind.
  return {
    id,
    workspace_id: WORKSPACE,
    status: "revoked",
    deleted_at: "2026-09-01T00:00:00Z",
    ...extra,
  };
}

Deno.test("EVERY inboxes query the gate resolution issues excludes soft-deleted rows", async () => {
  // THE DURABLE ASSERTION. Not "the two named functions look right in the
  // source" — every query that reaches the database on this path, from any
  // helper, existing or not yet written. The third-helper sabotage that the
  // source pin could not see fails here the moment the helper is used.
  const { inboxQueries } = await driveGates([
    activeRow("a", { draft_editor_hidden: false, bulk_review_mode: "off" }),
    revokedRow("b", { draft_editor_hidden: false, send_approval_required: true }),
  ]);

  assert(inboxQueries.length >= 2, `expected both rollups to query, got ${inboxQueries.length}`);
  for (const query of inboxQueries) {
    assert(
      query.is.some(([column, value]) => column === "deleted_at" && value === null),
      `an inboxes query dropped .is("deleted_at", null): ${JSON.stringify(query)}`,
    );
    assert(
      query.eq.some(([column, value]) => column === "workspace_id" && value === WORKSPACE),
      `an inboxes query is not scoped to the key's workspace: ${JSON.stringify(query)}`,
    );
    // And the projection must carry the columns the predicate decides on, so
    // the SECOND layer can still see a row it was handed. Any spelling, any
    // order, built by hand or by `reachableInboxSelect` — what matters is that
    // the columns arrive.
    assert(query.projection !== null, "an inboxes query selected nothing at all");
    const columns = query.projection!.split(",").map((c) => c.trim());
    for (const column of REACHABLE_INBOX_COLUMNS) {
      assert(
        columns.includes(column),
        `an inboxes query dropped ${column} from its projection: ${query.projection}`,
      );
    }
  }
});

Deno.test("the status filter is in SQL for the .some() rollup and NOT for the .every() one", async () => {
  // The two rollups want opposite things from `status`, so "every query carries
  // both filters" would have been the wrong assertion — it was, until
  // 2026-09-17, and it is what kept the preference bug below alive.
  //
  //   * the `.some()` rollup must never let an unreachable inbox turn a review
  //     card ON, so it filters `status = 'active'` in SQL as well as in the
  //     predicate;
  //   * the `.every()` rollup has to SEE an unreachable inbox, because the
  //     preference stored on it still counts when the key reaches nothing else.
  //     Filtering status in SQL there deletes the evidence.
  //
  // Identified by what each query ASKS FOR, not by the name of the function
  // that built it, so a rename or a new helper changes nothing here.
  const { inboxQueries } = await driveGates([activeRow("a", { draft_editor_hidden: true })]);
  const filtersStatus = (q: RecordedQuery) =>
    q.eq.some(([column, value]) => column === "status" && value === "active");

  const cardOptIns = inboxQueries.filter((q) =>
    (q.projection ?? "").includes("send_approval_required")
  );
  assert(cardOptIns.length >= 1, "the card opt-in rollup still queries");
  for (const query of cardOptIns) {
    assert(
      filtersStatus(query),
      `the card opt-in query dropped .eq("status", "active"): ${JSON.stringify(query)}`,
    );
  }

  const draftHidden = inboxQueries.filter((q) =>
    (q.projection ?? "").includes("draft_editor_hidden")
  );
  assert(draftHidden.length >= 1, "the draft-editor rollup still queries");
  for (const query of draftHidden) {
    assert(
      !filtersStatus(query),
      "the draft-editor rollup must NOT filter status in SQL — it has to see an " +
        `unreachable inbox to honour the preference on it: ${JSON.stringify(query)}`,
    );
  }
});

Deno.test("both rollups ask for the preference columns they roll up", async () => {
  // The other direction, so neither query can quietly stop reading the thing
  // it exists to read while still passing the filter assertions above.
  const { inboxQueries } = await driveGates([activeRow("a")]);
  const projections = inboxQueries.map((q) => q.projection ?? "");
  assert(
    projections.some((p) => p.includes("draft_editor_hidden")),
    `no query reads draft_editor_hidden: ${JSON.stringify(projections)}`,
  );
  assert(
    projections.some((p) => p.includes("bulk_review_mode") && p.includes("send_approval_required")),
    `no query reads the two card opt-ins: ${JSON.stringify(projections)}`,
  );
});

Deno.test("the key's inbox allowlist restricts every inboxes query", async () => {
  const { inboxQueries } = await driveGates(
    [activeRow("a", { draft_editor_hidden: true }), activeRow("b")],
    { inboxIds: ["a"] },
  );
  assert(inboxQueries.length >= 2, "both rollups still query");
  for (const query of inboxQueries) {
    const allowlist = query.in.find(([column]) => column === "id");
    assert(allowlist !== undefined, `an inboxes query ignores inbox_ids: ${JSON.stringify(query)}`);
    assertEquals([...allowlist![1]], ["a"], "and restricts to exactly the allowed ids");
  }
});

Deno.test("a key scoped to zero inboxes queries no inbox at all", async () => {
  const { gates, inboxQueries } = await driveGates([activeRow("a", { send_approval_required: true })], {
    inboxIds: [],
  });
  assertEquals(inboxQueries.length, 0, "an empty allowlist reaches nothing, so it asks nothing");
  assertEquals(gates.outbound, false, "and opens no gate");
  assertEquals(gates.bulk, false, "neither one");
  // The drafts gate is the deliberate asymmetry: it is a `.every()`, and a key
  // that reaches no live inbox has no "every inbox" to be hidden. Withholding
  // the card from it would be a decision its owner never made, so vacuous
  // truth is NOT returned and the workspace switch alone decides.
  assertEquals(gates.drafts, true, "no reachable inbox is not 'all of them hidden'");
});

// ── The production bugs, end to end through the real gate resolution ───────

Deno.test("a soft-deleted inbox no longer defeats the draft-editor opt-out", async () => {
  // THE BUG, in its production shape and driven through the real code path:
  // one active inbox the user hid, one revoked row they deleted months ago
  // whose `draft_editor_hidden` is stuck at its NOT NULL DEFAULT false. Before
  // the filter the rollup could never reach true and `_meta.ui` stayed on.
  const { gates } = await driveGates([
    activeRow("a", { draft_editor_hidden: true }),
    revokedRow("b", { draft_editor_hidden: false }),
  ]);
  assertEquals(gates.drafts, false, "every reachable inbox is hidden, so no card");
});

Deno.test("a reachable inbox that is not hidden still keeps the draft editor", async () => {
  const { gates } = await driveGates([
    activeRow("a", { draft_editor_hidden: true }),
    activeRow("b", { draft_editor_hidden: false }),
    revokedRow("c", { draft_editor_hidden: true }),
  ]);
  assertEquals(gates.drafts, true, "the rollup must stay honest in both directions");
});

Deno.test("the workspace switch still overrides the per-inbox rollup", async () => {
  const { gates } = await driveGates([activeRow("a", { draft_editor_hidden: false })], {
    workspace: { draft_editor_enabled: true, draft_editor_hidden: true },
  });
  assertEquals(gates.drafts, false, "a workspace-level opt-out withholds the card");
  const notRolledOut = await driveGates([activeRow("a", { draft_editor_hidden: false })], {
    workspace: { draft_editor_enabled: false, draft_editor_hidden: false },
  });
  assertEquals(notRolledOut.gates.drafts, false, "and so does the rollout flag");
});

Deno.test("a soft-deleted inbox no longer turns on the outbound or bulk card", async () => {
  // The mirror-image bug: a `.some()` over the same unfiltered rows mounted a
  // review card under every send for a key that cannot reach the opted-in row.
  const { gates } = await driveGates([
    activeRow("a", { send_approval_required: false, bulk_review_mode: "off" }),
    revokedRow("b", { send_approval_required: true, bulk_review_mode: "plan" }),
  ]);
  assertEquals(gates.outbound, false, "a revoked inbox opens no outbound gate");
  assertEquals(gates.bulk, false, "nor the bulk one");
});

Deno.test("a reachable opted-in inbox still opens exactly its own gate", async () => {
  const outbound = await driveGates([
    activeRow("a", { send_approval_required: true, bulk_review_mode: "off" }),
    revokedRow("b", { send_approval_required: false, bulk_review_mode: "plan" }),
  ]);
  assertEquals(outbound.gates.outbound, true, "the live opt-in still counts");
  assertEquals(outbound.gates.bulk, false, "and does not open the other gate");

  const bulk = await driveGates([
    activeRow("a", { send_approval_required: false, bulk_review_mode: "plan" }),
  ]);
  assertEquals(bulk.gates.outbound, false, "read independently");
  assertEquals(bulk.gates.bulk, true, "read independently");
});

function erroredRow(id: string, extra: Partial<FakeInboxRow> = {}): FakeInboxRow {
  // Live but broken: an expired OAuth token, a rejected app password. NOT
  // deleted — in production on 2026-09-16, 4 rows were exactly this.
  return { id, workspace_id: WORKSPACE, status: "error", deleted_at: null, ...extra };
}

Deno.test("a status='error' inbox opens nothing either", async () => {
  // Neither condition implies the other: `resolveInbox` requires
  // `status === 'active'`, so an errored inbox is reachable by nothing.
  const { gates } = await driveGates([
    erroredRow("a", {
      send_approval_required: true,
      bulk_review_mode: "plan",
      draft_editor_hidden: false,
    }),
  ]);
  assertEquals(gates.outbound, false, "an errored inbox is not reachable");
  assertEquals(gates.bulk, false, "an errored inbox is not reachable");
  // The case where nothing is at stake, kept for the other direction: the user
  // never hid anything, so there is no preference to honour and the card stays.
  assertEquals(gates.drafts, true, "an unreachable inbox nobody hid keeps the card");
});

Deno.test("an expired token does NOT hand back a card the user switched off", async () => {
  // ── THE PRODUCT BUG (fixed 2026-09-17), asserted where it costs something ──
  // The previous version of this file asserted the `status='error'` case with
  // `draft_editor_hidden: false`, which is the arrangement where the empty-set
  // rule changes nothing. With `true` the same rule silently reverted a stated
  // preference:
  //
  //     active + draft_editor_hidden:true  -> drafts === false  (no card)
  //     error  + draft_editor_hidden:true  -> drafts === true   (CARD BACK)
  //
  // A one-inbox workspace that hid the draft editor got it advertised again the
  // moment that inbox's OAuth token expired. Nothing told the user, and nothing
  // in the product asked for it.
  const { gates } = await driveGates([erroredRow("a", { draft_editor_hidden: true })]);
  assertEquals(gates.drafts, false, "the preference survives the mailbox going unreachable");

  // The same inbox while it still worked, so the assertion above is not passing
  // for some unrelated reason.
  const healthy = await driveGates([activeRow("a", { draft_editor_hidden: true })]);
  assertEquals(healthy.gates.drafts, false, "and it was hidden before the token expired");

  // And the fallback is a LAST resort, not a widening: one live inbox that is
  // not hidden still keeps the card, however many broken ones sit beside it.
  const mixed = await driveGates([
    activeRow("a", { draft_editor_hidden: false }),
    erroredRow("b", { draft_editor_hidden: true }),
  ]);
  assertEquals(mixed.gates.drafts, true, "a reachable, un-hidden inbox still decides");
});

// ── The two fail directions, which the recording client cannot reach ───────
//
// `recordingClient` always answers `{ error: null }`, so neither rollup's error
// branch was ever exercised. They fail in OPPOSITE directions on purpose and
// that is worth holding: the card opt-ins are permissions and close, the
// draft-editor rollup is a preference and stays open.

/** A client whose every query comes back as a PostgREST error. */
function failingClient(message: string) {
  const from = (_table: string) => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      is: () => builder,
      in: () => builder,
      or: () => builder,
      maybeSingle: () => Promise.resolve({ data: null, error: { message } }),
      then<R1, R2>(
        onfulfilled?: ((value: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null,
        onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
      ): Promise<R1 | R2> {
        return Promise.resolve({ data: null, error: { message } }).then(onfulfilled, onrejected);
      },
    };
    return builder;
  };
  return { from };
}

Deno.test("an unreadable database closes the card gates and leaves the draft gate alone", async () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => JSON.stringify(a)).join(" "));
  };
  let gates;
  try {
    gates = await keyReviewCardGates(
      // deno-lint-ignore no-explicit-any
      gateKey() as any,
      failingClient("column inboxes.bulk_review_mode does not exist"),
    );
  } finally {
    console.warn = original;
  }

  // Permissions: unknown is closed. This is the pre-MCP-Apps tool surface.
  assertEquals(gates.outbound, false, "an unreadable opt-in must not mount a review card");
  assertEquals(gates.bulk, false, "nor a bulk plan card");
  // The workspace ROLLOUT flag also fails closed, and it is ANDed in, so the
  // drafts gate closes with it. That is the rollout gate deciding, not the
  // preference rollup — which independently fails OPEN, as its own note says.
  assertEquals(gates.drafts, false, "an unreadable rollout flag is 'not rolled out'");
  assert(
    warnings.some((w) => w.includes("review_card_gate_query_failed")),
    `the failure is reported, not swallowed: ${warnings.join(" | ")}`,
  );
});

Deno.test("the SQL the callers must also apply is stated, not implied", () => {
  // These strings exist so the filter can be quoted in one place. The tests
  // above are what hold `index.ts` to them.
  assert(REACHABLE_INBOX_SQL.includes("deleted_at is null"));
  assert(REACHABLE_INBOX_SQL.includes("status = 'active'"));
  // The half every inboxes query applies, split out because the two rollups
  // want opposite things from `status`. See the query-shape test above.
  assertEquals(SOFT_DELETE_SQL, "deleted_at is null");
  assert(REACHABLE_INBOX_SQL.startsWith(SOFT_DELETE_SQL), "one is a prefix of the other");
});

// ═══════════════════════════════════════════════════════════════════════════
// The draft-editor rollup — the `.every()`
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("a soft-deleted inbox no longer defeats the all-hidden rollup", () => {
  // THE BUG, in its production shape: one active inbox the user has hidden,
  // one revoked row they deleted months ago. Before the filter this returned
  // false and `draft` kept its `_meta.ui`, so the opt-out did nothing.
  const rows: DraftEditorHiddenRow[] = [
    { ...ACTIVE, draft_editor_hidden: true },
    { ...SOFT_DELETED, draft_editor_hidden: false },
  ];
  assertEquals(allInboxesHideDraftEditor(rows), true);
});

Deno.test("a non-active inbox does not defeat it either", () => {
  assertEquals(
    allInboxesHideDraftEditor([
      { ...ACTIVE, draft_editor_hidden: true },
      { ...ERRORED, draft_editor_hidden: false },
    ]),
    true,
  );
});

Deno.test("one reachable inbox that is NOT hidden still keeps the card", () => {
  // The rollup must stay honest in the direction that matters: a key that can
  // reach a mailbox the user has not switched off keeps its metadata.
  assertEquals(
    allInboxesHideDraftEditor([
      { ...ACTIVE, draft_editor_hidden: true },
      { ...ACTIVE, draft_editor_hidden: false },
      { ...SOFT_DELETED, draft_editor_hidden: true },
    ]),
    false,
  );
});

Deno.test("NO rows at all is not vacuously 'all hidden'", () => {
  // A key with no inbox rows expressed no preference, and withholding the card
  // from it would be a decision nobody made.
  assertEquals(allInboxesHideDraftEditor([]), false);
});

Deno.test("an unreachable inbox still carries the preference stored on it", () => {
  // ── THE PRODUCT BUG, at the unit level (fixed 2026-09-17) ────────────────
  // This returned a flat `false` whenever nothing was reachable, which meant a
  // user who hid the draft editor got it back the moment their only inbox went
  // to `status='error'` — an expired OAuth token, a rejected app password.
  // "Unreachable" is a fact about the mailbox; "hidden" is a decision about the
  // card, and the second does not lapse because of the first.
  assertEquals(
    allInboxesHideDraftEditor([{ ...ERRORED, draft_editor_hidden: true }]),
    true,
    "an expired token must not hand back a card the user switched off",
  );
  assertEquals(
    allInboxesHideDraftEditor([{ ...SOFT_DELETED, draft_editor_hidden: true }]),
    true,
    "the same for a deleted one: the preference is still the last thing they said",
  );
  // The other direction is unchanged, and it is the case the old rule was
  // written for: a transient error on an inbox nobody hid must not silently
  // withdraw the card.
  assertEquals(
    allInboxesHideDraftEditor([{ ...ERRORED, draft_editor_hidden: false }]),
    false,
  );
  assertEquals(
    allInboxesHideDraftEditor([{ ...SOFT_DELETED, draft_editor_hidden: false }]),
    false,
  );
  // And the fallback never OVERRIDES a reachable row: one live inbox that is
  // not hidden keeps the card whatever the dead ones say. This is the original
  // bug's direction, still closed.
  assertEquals(
    allInboxesHideDraftEditor([
      { ...ACTIVE, draft_editor_hidden: false },
      { ...ERRORED, draft_editor_hidden: true },
      { ...SOFT_DELETED, draft_editor_hidden: true },
    ]),
    false,
    "reachable rows decide whenever there are any",
  );
});

Deno.test("only the literal boolean true counts as hidden", () => {
  // The column is NOT NULL DEFAULT false, but a row from a database without
  // the migration would arrive without the key at all. Absent is not hidden.
  for (const value of [undefined, null, false, 0, "true"]) {
    assertEquals(
      allInboxesHideDraftEditor([{ ...ACTIVE, draft_editor_hidden: value }]),
      false,
      `${String(value)} must not read as hidden`,
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// The review-card rollup — the `.some()`
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("a soft-deleted inbox no longer turns on the outbound gate", () => {
  // Same missing filter, opposite direction: this one mounted a review card
  // under every send for a key whose calls can never reach the opted-in row.
  const rows: ReviewCardOptInRow[] = [
    { ...ACTIVE, send_approval_required: false, bulk_review_mode: "off" },
    { ...SOFT_DELETED, send_approval_required: true, bulk_review_mode: "plan" },
  ];
  assertEquals(reviewCardOptInsFromRows(rows), { outbound: false, bulk: false });
});

Deno.test("a non-active inbox does not turn either gate on", () => {
  assertEquals(
    reviewCardOptInsFromRows([
      { ...ERRORED, send_approval_required: true, bulk_review_mode: "plan" },
    ]),
    { outbound: false, bulk: false },
  );
});

Deno.test("a reachable opted-in inbox still turns its own gate on", () => {
  assertEquals(
    reviewCardOptInsFromRows([
      { ...ACTIVE, send_approval_required: true, bulk_review_mode: "off" },
      { ...SOFT_DELETED, send_approval_required: false, bulk_review_mode: "plan" },
    ]),
    { outbound: true, bulk: false },
  );
  assertEquals(
    reviewCardOptInsFromRows([
      { ...ACTIVE, send_approval_required: false, bulk_review_mode: "plan" },
    ]),
    { outbound: false, bulk: true },
  );
});

Deno.test("the two opt-ins are read independently", () => {
  // One inbox holding sends and a different one previewing bulk ops must open
  // exactly their own gate, never each other's.
  assertEquals(
    reviewCardOptInsFromRows([
      { ...ACTIVE, send_approval_required: true },
      { ...ACTIVE, bulk_review_mode: "plan" },
    ]),
    { outbound: true, bulk: true },
  );
  assertEquals(reviewCardOptInsFromRows([]), { outbound: false, bulk: false });
});
