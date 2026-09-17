// ---------------------------------------------------------------------------
// "Which inboxes can this key actually act on?" — one definition, two rollups.
//
// ── THE BUG THIS MODULE EXISTS TO STOP ─────────────────────────────────────
// The MCP Apps gates roll a per-inbox opt-in up to a per-KEY boolean, and both
// rollups used to query `inboxes` filtered only by `workspace_id` (plus the
// key's `inbox_ids` allowlist). Every other inbox read in the server also
// filters `deleted_at is null` and `status = 'active'` — see `resolveInbox` and
// `resolveInboxArg`, which are the only ways a tool call ever reaches a mailbox
// — so the rollups were counting rows no tool could ever touch:
//
//   * `allInboxesHideDraftEditor` is an `.every()`. A soft-deleted row keeps
//     `draft_editor_hidden = false` forever (the teardown in
//     `DELETE /api/workspaces/[id]`, route.ts:316-323, sets `deleted_at` +
//     `status='revoked'` and nulls the three credential columns —
//     `oauth_access_token`, `oauth_refresh_token`, `imap_password` — but
//     touches no preference column), so one of them made the rollup unable to
//     reach true and the user's opt-out could never suppress `_meta.ui`.
//     Nulling the credentials is also why a revoked row is inert in practice
//     and not only by policy: anything that reached one anyway could not
//     authenticate to the provider. Confirmed
//     live 2026-09-16: 49 soft-deleted inboxes across 43 production
//     workspaces, 2 of them in workspaces gated into the draft editor.
//
//   * the review-card opt-ins are a `.some()`. Same missing filter, opposite
//     direction: a soft-deleted inbox that still carries
//     `send_approval_required` turned the OUTBOUND card gate ON for a key that
//     cannot reach it.
//
// So the filter lives here, once, as a predicate — and the callers apply it in
// SQL *and* run the rows back through it. The SQL filter is the cheap primary;
// this predicate is what a test can actually hold onto, and what keeps a future
// query that forgets the filter from silently re-opening either hole.
//
// ── The soft-delete convention, confirmed against the live schema ──────────
// `public.inboxes` has NO `soft_deleted` column. Soft deletion is
// `deleted_at is not null`, and `status` is a separate lifecycle field
// ('pending' | 'active' | 'error' | 'revoked'). In production on 2026-09-16
// the two happen to coincide exactly (49 rows are both `revoked` and
// soft-deleted) because workspace teardown writes them together, but 4 rows
// are `status='error'` and NOT deleted — reachable by neither, since
// `resolveInbox` requires `status === 'active'`. Both conditions are checked
// for that reason; neither implies the other.
// ---------------------------------------------------------------------------

/**
 * The slice of a Supabase client the two rollups in `index.ts` use.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Until 2026-09-17 the guarantee that those rollups filter out unreachable
 * inboxes was a SOURCE pin: a test read `index.ts`, stripped its comments and
 * matched the text of the two queries. Three adversarial rounds each broke the
 * pin rather than the behaviour — the last one by desynchronising the hand
 * rolled comment stripper with a nested template literal, which let a third,
 * completely unfiltered rollup helper sit in the file with the suite green.
 *
 * A text pin can always be evaded one layer out. A query the caller actually
 * issues cannot, so the rollups now take their client as a parameter and the
 * test injects a recorder: whatever those functions ask the database for is
 * what the test asserts on, in whatever order and with whatever helper it was
 * built by. `reachable-inbox.test.ts` holds the assertions.
 *
 * Typed as `any` past `from()` on purpose. The real PostgREST builder is a
 * deeply generic, thenable chain; naming its shape here would either not
 * accept the real client or not accept a fake, and the point of the parameter
 * is that both go down the same path.
 */
// deno-lint-ignore no-explicit-any
export type InboxQueryClient = { from(table: string): any };

/**
 * The columns every reachability decision needs.
 *
 * Widened with `unknown` rather than typed exactly, because these rows come
 * straight off PostgREST and a column the migration has not added yet arrives
 * as `undefined` rather than as its default.
 */
export interface InboxReachabilityRow {
  status?: unknown;
  deleted_at?: unknown;
}

/**
 * The columns `inboxIsReachable` reads, named once.
 *
 * This constant is the anti-drift device. Every caller builds its PostgREST
 * projection with `reachableInboxSelect()` below, so the columns the predicate
 * reads and the columns the query asks for are one list by construction — there
 * is no second place to forget one.
 */
export const REACHABLE_INBOX_COLUMNS = ["status", "deleted_at"] as const;

/**
 * Reachability as SQL, stated once so it is quotable.
 *
 * `REACHABLE_INBOX_SQL` is the whole predicate. `SOFT_DELETE_SQL` is the half
 * that EVERY inboxes query in the server must apply, because a soft-deleted row
 * is gone from the product and its stale `draft_editor_hidden = false` is the
 * poison both rollups exist to keep out.
 *
 * The status half is applied in SQL by the `.some()` rollup and NOT by the
 * `.every()` one — see `allInboxesHideDraftEditor`, which has to see an
 * unreachable inbox to honour the preference stored on it.
 */
export const SOFT_DELETE_SQL = "deleted_at is null";
export const REACHABLE_INBOX_SQL = `${SOFT_DELETE_SQL} AND status = 'active'`;

/**
 * A PostgREST `select` string: the caller's own columns, plus the two this
 * module has to read.
 *
 * Use this for EVERY query whose rows are handed to `inboxIsReachable` or to
 * either rollup below. Hand-writing the projection is the drift the predicate
 * cannot fully defend against: "why am I selecting columns I do not use?" is a
 * reasonable-looking edit, and before 2026-09-16 it would have passed the whole
 * suite while turning both rollups into constants. See `inboxIsReachable`.
 */
export function reachableInboxSelect(...columns: readonly string[]): string {
  const seen = new Set<string>();
  const projection: string[] = [];
  for (const column of [...columns, ...REACHABLE_INBOX_COLUMNS]) {
    const name = column.trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    projection.push(name);
  }
  return projection.join(", ");
}

/** True when `row` actually carries a value for `column`. */
function hasColumn(row: InboxReachabilityRow, column: string): boolean {
  return column in row && (row as Record<string, unknown>)[column] !== undefined;
}

/**
 * Record — in the function logs, and nowhere else — that a row arrived without
 * the columns this module decides on.
 *
 * ── DO NOT CALL THIS "LOUD" ───────────────────────────────────────────────
 * `reachable_inbox_projection_drift` is consumed by NOTHING as of 2026-09-17:
 * no log drain, no Logflare rule, no alert, no synthetic monitor, no dashboard
 * query. It is voluminous under real drift (six lines per `tools/list` over
 * three inboxes), so it is obvious to anyone who opens the function logs — but
 * nobody is watching, and an unwatched line is not an alarm. The real defence
 * against this drift is the injected-client test in `reachable-inbox.test.ts`,
 * which drives the real rollups against a recording client and asserts the
 * projection they actually ask for, and it fails the build. If this log is
 * ever meant to be the backstop, wire it to something that is actually read
 * first.
 *
 * Deliberately NOT a throw. A throw here is swallowed by
 * `allReachableInboxesHideDraftEditor`'s own try/catch, which then fails open,
 * i.e. the opt-out stops working: the very bug. And it is uncaught in
 * `keyReviewCardGates`, where it would take `tools/list` — the connect path —
 * down for every key on the server. Neither beats a log plus the fallback
 * below, limited as that fallback is (see `inboxIsReachable`).
 */
function reportMissingColumns(missing: readonly string[]): void {
  console.error("[mcp-server] reachable_inbox_projection_drift", {
    missing: missing.join(","),
    fix: "build the select with reachableInboxSelect() — see reachable-inbox.ts",
  });
}

/**
 * True when a tool call could actually resolve this inbox.
 *
 * Mirrors `resolveInbox` / `resolveInboxArg` exactly: not soft-deleted, and
 * `status === 'active'`.
 *
 * ── MISSING IS NOT THE SAME AS "NO" ────────────────────────────────────────
 * A column the projection did not ask for is absent from the row, and the first
 * version of this function read that absence as a value: `row.status` was
 * `undefined`, `undefined === "active"` is false, so EVERY row came back
 * unreachable. Not hypothetical. Dropping `, status, deleted_at` from either
 * caller's `.select()` — the obvious "I am selecting columns I do not use"
 * tidy-up — passed the entire suite while silently making
 * `allInboxesHideDraftEditor` a constant `false` (the per-inbox opt-out can
 * never suppress `_meta.ui` again: the exact bug this module exists to stop)
 * and `reviewCardOptInsFromRows` a constant `{outbound:false, bulk:false}` (the
 * outbound review card permanently off for every key).
 *
 * So an ABSENT column is not decisive. It is logged as the code defect it is,
 * and the remaining columns decide. A column that is PRESENT is decisive
 * exactly as before; that is the layer that catches a dropped SQL filter, and
 * it is untouched.
 *
 * ── THE LIMIT OF THAT FALLBACK, STATED HONESTLY ───────────────────────────
 * It is correct only under the drift we can foresee: the plausible edit drops
 * the PROJECTION and keeps the SQL `WHERE`, so the rows that arrive are already
 * filtered and treating them as reachable is exactly right.
 *
 * It is WRONG, and silent, when BOTH layers go at once. With the projection
 * and the `WHERE` both gone, a soft-deleted row arrives with neither column and
 * is counted as reachable: `allInboxesHideDraftEditor` returns false where the
 * truth is true (the opt-out stops working), and `reviewCardOptInsFromRows`
 * returns `{outbound:true, bulk:true}` off a REVOKED inbox where the truth is
 * false (a mailbox nobody can reach mounts the outbound card). The earlier
 * behaviour — absence read as "not active", so everything unreachable — failed
 * CLOSED on that second one, which is strictly better there.
 *
 * The trade is deliberate: the one-layer drift is the edit a person actually
 * makes, and the two-layer drift removes the `.is("deleted_at", null)` line
 * that is right there in the query. What makes that survivable is the
 * injected-client test in `reachable-inbox.test.ts` — it asserts that
 * `.is("deleted_at", null)` reaches the client on EVERY `inboxes` query the
 * rollups issue, and that `.eq("status", "active")` reaches it on the `.some()`
 * one and deliberately does not on the `.every()` one — not this fallback. Do
 * not describe the fallback as correct in general.
 *
 * `deleted_at` present with any value other than `null` is a timestamp and
 * means deleted.
 */
export function inboxIsReachable(row: InboxReachabilityRow): boolean {
  const missing = REACHABLE_INBOX_COLUMNS.filter((column) => !hasColumn(row, column));
  if (missing.length > 0) reportMissingColumns(missing);

  if (hasColumn(row, "deleted_at") && row.deleted_at !== null) return false;
  if (hasColumn(row, "status") && row.status !== "active") return false;
  return true;
}

/** A row as the draft-editor rollup reads it. */
export interface DraftEditorHiddenRow extends InboxReachabilityRow {
  draft_editor_hidden?: unknown;
}

/**
 * True when every inbox this key has, preferring the ones it can reach, has the
 * draft editor hidden.
 *
 * ── TWO RULES, AND THE ORDER MATTERS ───────────────────────────────────────
 * 1. When the key reaches at least one live inbox, ONLY those decide. This is
 *    the original bug: a soft-deleted row keeps `draft_editor_hidden` at its
 *    NOT NULL DEFAULT false forever, so letting it into an `.every()` made the
 *    rollup unable to reach true and the user's opt-out could never suppress
 *    `_meta.ui`.
 *
 * 2. When the key reaches NOTHING, the rows it has still carry a stated
 *    preference, and a preference does not evaporate because a token expired.
 *    Fixed 2026-09-17; until then this returned a flat `false` and reverted the
 *    user's own decision:
 *
 *      active + draft_editor_hidden:true  -> no card, as the user asked
 *      error  + draft_editor_hidden:true  -> THE CARD CAME BACK
 *
 *    A one-inbox workspace that hid the draft editor got it advertised again
 *    the moment that inbox's OAuth token expired — `status` flips to 'error',
 *    the inbox stops being reachable, and the rollup forgot what the user had
 *    said. Nothing in the product asked for that and nothing would have told
 *    them it happened.
 *
 * Vacuous truth is still NOT returned for a key with no rows at all: there is
 * no "every inbox" to be hidden, and withholding the card from a key whose
 * owner never expressed a preference would be a decision nobody made. Same rule
 * the caller already applies to a zero-length `inbox_ids` allowlist, and the
 * same rule that keeps a transient `error` on a NOT-hidden inbox from silently
 * withdrawing the card.
 *
 * ── WHY THE CALLER'S SQL MUST NOT FILTER `status` FOR THIS ROLLUP ──────────
 * Rule 2 can only fire if the unreachable rows actually arrive. So
 * `allReachableInboxesHideDraftEditor` in index.ts deliberately filters
 * `deleted_at is null` in SQL and does NOT filter `status = 'active'`: status
 * is decided here, by `inboxIsReachable`, over rows the query was careful to
 * hand over. `deleted_at` stays in SQL because a soft-deleted row is gone from
 * the product entirely and its stale default is exactly the poison rule 1
 * exists to keep out — and because it is what bounds the result set.
 *
 * The `.some()` rollup below is the opposite and keeps BOTH filters: an inbox
 * nobody can reach must never turn a review card ON.
 */
export function allInboxesHideDraftEditor(rows: readonly DraftEditorHiddenRow[]): boolean {
  const reachable = rows.filter(inboxIsReachable);
  // Reachable rows win when there are any; otherwise the key's own rows are all
  // the evidence of a preference there is.
  const deciding = reachable.length > 0 ? reachable : rows;
  if (deciding.length === 0) return false;
  return deciding.every((row) => row.draft_editor_hidden === true);
}

/** A row as the review-card opt-in rollup reads it. */
export interface ReviewCardOptInRow extends InboxReachabilityRow {
  send_approval_required?: unknown;
  bulk_review_mode?: unknown;
}

/**
 * The two per-inbox card opt-ins, rolled up over the inboxes a key can reach.
 *
 * `.some()` over REACHABLE rows only. A revoked mailbox that still carries
 * `send_approval_required` must not mount a review card under every send for a
 * key whose calls can never land on it.
 */
export function reviewCardOptInsFromRows(
  rows: readonly ReviewCardOptInRow[],
): { outbound: boolean; bulk: boolean } {
  const reachable = rows.filter(inboxIsReachable);
  return {
    outbound: reachable.some((row) => row.send_approval_required === true),
    bulk: reachable.some((row) => row.bulk_review_mode === "plan"),
  };
}
