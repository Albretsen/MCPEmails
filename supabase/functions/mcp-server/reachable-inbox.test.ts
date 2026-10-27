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
// THE CARD GATES ARE SCOPE FACTS (2026-10-28)
//
// `keyReviewCardGates` used to roll the inbox rows above up at tools/list
// time: approvals for the outbound card, `bulk_review_mode = 'plan'` for the
// bulk card, the draft editor's rollout and opt-outs for the draft card.
// Hosts keep the tool list a chat started with (claude.ai even across new
// chats), so a setting switched on later never got its card. The gates now
// follow the key's scopes alone, and the settings are read per call. What is
// asserted here is that the gate asks the database NOTHING, so no setting can
// move it, and that each gate follows its scopes.
// ═══════════════════════════════════════════════════════════════════════════

Deno.env.set("MCP_INTROSPECTION_ONLY", "1");
Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
const { keyReviewCardGates } = await import("./index.ts");

/** A client that records every table it is asked for and answers nothing. */
function recordingClient() {
  const tables: string[] = [];
  return {
    tables,
    // deno-lint-ignore no-explicit-any
    client: { from: (table: string) => (tables.push(table), { select: () => { throw new Error(table); } }) } as any,
  };
}

function gateKey(scopes: string[], inbox_ids: string[] | null = null) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    workspace_id: "44444444-4444-4444-8444-444444444444",
    name: "OAuth: Claude",
    key_prefix: "mcpe_abc",
    key_hash: "",
    scopes,
    inbox_ids,
    expires_at: null,
    last_used_at: null,
    deleted_at: null,
    created_at: new Date(0).toISOString(),
  };
}

async function gatesFor(scopes: string[], inboxIds: string[] | null = null) {
  const { client, tables } = recordingClient();
  // deno-lint-ignore no-explicit-any
  const gates = await keyReviewCardGates(gateKey(scopes, inboxIds) as any, client);
  return { gates, tables };
}

Deno.test("the card gates read no setting, so no setting can close them", async () => {
  const { gates, tables } = await gatesFor([
    "read:email",
    "send:email",
    "manage:drafts",
    "manage:folders",
    "delete:email",
  ]);
  assertEquals(gates, { outbound: true, bulk: true, drafts: true });
  assertEquals(tables, [], "no inboxes or workspaces read at tools/list");
});

Deno.test("the outbound gate follows the send and schedule scopes", async () => {
  assertEquals((await gatesFor(["read:email", "manage:drafts"])).gates.outbound, false, "no send scope, no card");
  assertEquals((await gatesFor(["read:email", "schedule:email"])).gates.outbound, true, "schedule alone counts");
  assertEquals((await gatesFor(["send:email"])).gates.outbound, true, "send alone counts");
});

Deno.test("the bulk gate follows the folder and delete scopes", async () => {
  assertEquals((await gatesFor(["read:email"])).gates.bulk, false);
  assertEquals((await gatesFor(["manage:folders"])).gates.bulk, true);
  assertEquals((await gatesFor(["delete:email"])).gates.bulk, true);
});

Deno.test("the draft gate follows manage:drafts", async () => {
  assertEquals((await gatesFor(["read:email", "send:email"])).gates.drafts, false);
  assertEquals((await gatesFor(["manage:drafts"])).gates.drafts, true);
});

Deno.test("a key allowed no inbox gets no card at all", async () => {
  const { gates } = await gatesFor(["send:email", "manage:drafts", "manage:folders"], []);
  assertEquals(gates, { outbound: false, bulk: false, drafts: false });
  const scoped = await gatesFor(["send:email", "manage:drafts", "manage:folders"], ["a"]);
  assertEquals(scoped.gates, { outbound: true, bulk: true, drafts: true }, "an allowlist with an inbox is fine");
});


Deno.test("the SQL the callers must also apply is stated, not implied", () => {
  // These strings exist so the filter can be quoted in one place.
  assert(REACHABLE_INBOX_SQL.includes("deleted_at is null"));
  assert(REACHABLE_INBOX_SQL.includes("status = 'active'"));
  // The half every inboxes query applies, split out because the two rollups
  // want opposite things from `status`.
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
