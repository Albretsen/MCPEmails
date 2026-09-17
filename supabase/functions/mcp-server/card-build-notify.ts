// ---------------------------------------------------------------------------
// notifications/tools/list_changed — telling a connected client its cached
// tool list (and therefore its cached card) is stale.
//
// ── The problem ────────────────────────────────────────────────────────────
// The MCP Apps host caches the UI resource by URI ("Host MAY prefetch and cache
// UI resource content", SEP-1865), and since 2026-09-16 our URI carries a build
// fingerprint, so a new card is a new URI. But the URI lives in `_meta.ui` on
// the `tools/list` entry, and a client reads `tools/list` once at connect and
// caches it. So a card deploy reached nobody until the connector was
// reconnected by hand.
//
// ── The mechanism the spec already has ─────────────────────────────────────
// MCP 2025-06-18, Tools § "List Changed Notification":
//
//   "When the list of available tools changes, servers that declared the
//    `listChanged` capability SHOULD send a notification:
//    { "jsonrpc": "2.0", "method": "notifications/tools/list_changed" }"
//
// and its message-flow diagram is exactly this case:
//   Server --) Client: tools/list_changed
//   Client ->> Server: tools/list
//   Server -->> Client: Updated tools
//
// ── Why a stateless server can still send one ──────────────────────────────
// We are POST-only: no session id, no GET stream, nothing held open. That
// looks like it rules out server-initiated messages, and for an UNSOLICITED
// notification it does. But Streamable HTTP allows a notification to ride on
// the response to a request the client is already making:
//
//   "If the server initiates an SSE stream: ... The server MAY send JSON-RPC
//    requests and notifications before sending the JSON-RPC response. These
//    messages SHOULD relate to the originating client request."
//
// So the notification goes out ahead of a `tools/call` result — and it does
// relate to that request, because the card that result is about to mount is the
// stale thing. The client is calling us constantly, so there is no wait.
//
// ── What this does NOT fix ─────────────────────────────────────────────────
// A re-mounted cell from an old conversation replays the URI recorded when its
// tool call happened. That is a stored record, not a live listing, and no
// notification can reach it. Old conversations keep their old card.
// ---------------------------------------------------------------------------

/**
 * Sentinel written into `api_keys.card_build_notified` to mark a client's
 * cached tool listing stale for a reason other than a card deploy.
 *
 * The build id answers "has the CARD changed". It cannot answer "has this
 * workspace's card PREFERENCE changed", because hiding the card changes no
 * bytes of the bundle — but it does change `tools/list`, which is exactly what
 * the client is caching. Without this, a user who hid the card kept seeing it
 * until they reconnected, which is the very problem the notification exists to
 * remove.
 *
 * Writing a value that cannot equal any build id makes the next card-bearing
 * `tools/call` notify and then re-record the real id. The alternative was
 * recomputing the gate on every tool call, which is the per-call database read
 * this whole design avoids. Any non-hex string works; this one is readable in
 * the table.
 */
export const CARD_LISTING_STALE = "stale";

/**
 * The moment `api_keys.card_build_notified` started being written, as epoch ms.
 *
 * ── Why a date constant, of all things ─────────────────────────────────────
 * NULL in that column was read as "this client has never been served a
 * `tools/list`, so it holds no cached listing and there is nothing to
 * invalidate". That is true of a key created since the tracking deploy. It is
 * FALSE of every key that connected before it, because the column did not exist
 * then: those clients hold a cached listing AND read NULL, so neither a card
 * deploy nor a preference change could ever reach them. It also killed the
 * legacy-URI mitigation, since a host that cached the bare
 * `ui://mcpemails/review-card.html` URI only ever re-reads it after a
 * re-listing, and the notification that triggers one could not fire.
 *
 * ── How big that cohort is, and the FILTER every number here is under ──────
 * State the filter with the number or the number is meaningless. The only
 * filter that can matter is the AUTHENTICATION one — `deleted_at is null AND
 * (expires_at is null OR expires_at > now())`, the predicate on the `api_keys`
 * lookup in index.ts. A key that cannot authenticate can never be notified, so
 * counting merely-undeleted rows overstates the reachable population by ~4x.
 *
 * Measured on production 2026-09-16 22:54Z (database clock), read-only:
 *
 *   `deleted_at is null` alone:
 *     547  undeleted rows
 *      95  of them never expire (static keys)
 *     452  carry an `expires_at`; 401 of those have already passed it
 *
 *   under the authentication filter:
 *     145  keys can authenticate at all
 *      93  of those read NULL, across 75 distinct workspaces
 *      52  of those have a build recorded
 *      59  read NULL and have been used at least once
 *      58  of those 59 were also created BEFORE the watershed below — i.e.
 *          the rows this branch will actually fire for, across 48 workspaces,
 *          one notification each
 *      51  of those 58, across 41 workspaces, never expire
 *
 * Two warnings about quoting any of these. First, only the long-lived subset
 * (51 keys / 41 workspaces) is stable: two reads eight minutes apart agreed on
 * it and disagreed on every count that includes expiring rows. Second, a
 * workspace count is not a key count and the two get confused — "75
 * workspaces" is `count(distinct workspace_id)` over auth-filtered NULL keys
 * with NO used-or-watershed condition, which is a different population from
 * the 48 workspaces this branch fires for. An earlier version of this comment
 * claimed 412 / 361 / 306 for the first three auth-filtered figures; those came
 * from `deleted_at is null` alone and were wrong by roughly 4x.
 *
 * ── What `api_keys` actually is, since the shape drove the design ───────────
 * A previous version of this comment described the table as mostly hourly OAuth
 * access tokens, each rotation a new row, on the strength of `min(expires_at -
 * created_at) = 00:59:58`. A minimum is not a distribution, and the real one
 * says the opposite. Over the 452 undeleted rows that carry an `expires_at`
 * (re-measured 2026-09-16 23:21:26Z): min TTL 00:59:58.72, MEDIAN 7 days
 * 09:39:32 by `percentile_cont(0.5)`, max 104 days 08:56:13. An earlier version
 * of this comment said the median was 7 days 07:03:58. That is a real datum
 * wrongly labelled: it is `percentile_disc(0.5)`, rank 226 of 452, the lower of
 * the two middle values. The point it was making — a week, not an hour — is
 * unaffected. Bucketed over all 547
 * undeleted rows, 95 never expire, 85 have a TTL of at most 1h01m, 36 sit
 * between an hour and a day, and 331 are longer than a day. Row creation across
 * the whole table is 146 rows in 7 days, 0.87 per hour, and those are new
 * authorizations rather than rotations.
 *
 * Rotation does not create rows at all: the `refresh_token` grant in
 * apps/web/app/api/oauth/token/route.ts does
 * `.update({key_hash, key_prefix, expires_at}).eq('id', rt.api_key_id)
 * .is('deleted_at', null)` — the SAME row, in place. `created_at` is untouched
 * and so is `card_build_notified`. Production agrees: of the 50 auth-capable
 * rows that have an OAuth refresh chain, all 50 have been rotated at least
 * once, 42 carry a recorded build id, 46 were created before the watershed and
 * still authenticate, and the longest single chain is 2021 refresh tokens
 * pointing at ONE `api_keys` row. If a refresh minted a fresh NULL row, none of
 * those numbers could be non-zero.
 *
 * So NULL has to be split in two, and the split needs a signal that says
 * whether this key COULD have cached a listing we did not record. Two already
 * on the row, ANDed:
 *
 *   1. `created_at` older than this constant — the key existed while listings
 *      were being served unrecorded, so a NULL tells us nothing about it.
 *   2. `last_used_at` not null — it has served at least one earlier request.
 *      A key that has never been used cannot have a cached anything.
 *
 * Rejected alternatives: a one-off backfill of every NULL row to the sentinel
 * (needs a production write to be correct, and marks keys that genuinely have
 * nothing cached); a sentinel written at connect time (a new column plus a
 * write on the hottest path); a per-connection signal (there is none — the
 * transport is POST-only with no session id, which is the whole reason this
 * state lives on the key).
 *
 * ── A date constant is an unsound classifier, and this one gets away with it ─
 * Deriving a watershed from a commit or deploy timestamp is not sound in
 * general. The thing being classified is "was this row's client being served
 * unrecorded listings", and a wall-clock instant only stands in for that if the
 * deploy is instantaneous, its time is known exactly, and no row is created
 * during the changeover. None of those is guaranteed; there is no deploy log
 * reachable from this machine, so the instant itself has to be inferred from
 * the data it is meant to classify. Anyone reusing this pattern should assume
 * it is wrong and go looking for the rows it would misplace. Here, that search
 * comes back empty, which is the only reason the constant stands.
 *
 * Every timestamp below is UTC, and every one is worth reading as UTC: the
 * database clock and this laptop agree to well under a minute (2026-09-16
 * 23:28:05Z from `now()` against 23:29:28Z from `date -u` a minute later), and
 * the two-hour gap anyone will notice between a `git log` line and a row is the
 * Oslo display offset in git's output, +02:00, not clock skew. An earlier round
 * of this comment was confused by exactly that.
 *
 * Bounding the deploy, upper bound from key data, lower bound from the commit
 * (all timestamps 2026-09-16, UTC; key rows read 23:21:01Z under no filter, so
 * deleted rows are included):
 *   * UPPER, from data. `ed24fc8e` was created 14:18:26.93 and used 14:19:06.5,
 *     and its column holds the real build id `07359906cb80` — so tracking WAS
 *     live at 14:19:06.5.
 *   * LOWER, from the commit. `e9704f3`, which adds the migration and this file
 *     in one commit, was committed 2026-09-16T16:04:44+02:00 = 14:04:44Z.
 *     Nothing could have deployed the tracking code before the code existed.
 *   * (`e00722a4`, created 14:02:59.21, carries `oldbuild9999`, which is not 12
 *     lowercase hex and so is not a build id this server ever wrote. It is
 *     fixture data and is not used as evidence either way.)
 *
 * A NULL is NOT evidence that tracking was off. An earlier version of this
 * comment argued the lower bound from `54f1a785` — created 13:24:54, used
 * 13:27:59, column NULL, therefore "tracking was not yet live at 13:27:59" —
 * and that inference is invalid. A NULL means only that the key made no
 * `tools/list` and no card-bearing `tools/call`; it says nothing about the
 * deploy. The star witness named further down refutes the method directly:
 * `cd74d874` was created 18:09:32.72, four hours AFTER the deploy, has been
 * used repeatedly since (last 23:18:56.37 at the 23:21:01Z read), and is still
 * NULL. Read that row the way the old argument read `54f1a785` and it proves
 * tracking was off at 23:18, which is false.
 *
 * So the deploy lies in [14:04:44Z, 14:19:06.5Z]. Placing the constant at
 * 14:05:00Z is inside that interval, which is exactly the unsound part — and
 * what makes it harmless is that the interval is EMPTY of rows that could be
 * misclassified, in BOTH directions:
 *   * Too LATE, [14:05:00Z, 14:19:06.5Z): exactly one row, `ed24fc8e`, and it
 *     has a build recorded, so `predatesBuildTracking` is never consulted for
 *     it.
 *   * Too EARLY, [14:04:44Z, 14:05:00Z): ZERO rows, over all 659 rows in the
 *     table including deleted ones (counted 23:21:19Z). This is the direction
 *     that would reintroduce the bug this file exists to fix, and it is empty
 *     wherever in the bounded interval the deploy actually landed.
 *
 * ── The commit bound is APPROXIMATE, because deploys here run ahead of git ──
 * A commit timestamp is a lower bound on a deploy only if nothing is deployed
 * from an uncommitted working tree, and in this repo things are. Measured:
 * `REVIEW_CARD_BUILD_ID = "07359906cb80"` was introduced by `ec14bdb`,
 * committed 2026-09-16T16:19:41+02:00 = 14:19:41Z. But `ed24fc8e` had already
 * RECORDED that exact build id at `last_used_at` 14:19:06.5Z — 35 seconds
 * before the commit that created it. The edge function was deployed from the
 * working tree ahead of its commit.
 *
 * That does not move the bracket above, because the upper bound comes from key
 * data and not from a commit. It does mean 14:04:44Z is an approximate lower
 * bound rather than a proof: the true deploy could precede it by however long
 * the working tree ran ahead of the commit, on the order of the 35 seconds
 * measured here. The slack is absorbed by the empty interval — the nearest row
 * on the early side is `e00722a4` at 14:02:59.21Z, 105 seconds before the
 * constant — but anyone reusing this pattern should take the commit as a hint
 * and the row timestamps as the evidence.
 *
 * The line also happens to fall in a 15-minute hole with no rows in it at all:
 * the last row before it is `e00722a4` at 14:02:59.21Z and the next is
 * `ed24fc8e` at 14:18:26.93Z. An earlier version of this comment claimed the
 * hole ran from 14:05:00Z to 18:09:32Z. That was false, and self-contradicting
 * — the same paragraph named a 14:18:26Z row. Six rows exist in that span
 * (14:18:26.93, 14:36:09.10, 15:20:09.15, 16:45:51.43, 16:52:46.61,
 * 17:30:07.17).
 *
 * One of those six, `c91a0a13` at 16:52:46.61Z, was described here as NULL and
 * used and therefore a row that "WOULD flip classification if the line moved
 * past it". Its classification would flip; nothing would follow from it. The
 * row has `deleted_at` 17:11:02.66Z AND `expires_at` 17:52:46.61Z, so it fails
 * the authentication filter twice over and can never present a request to be
 * notified on. Its classification is inert. The ONE row whose classification
 * has a consequence is `cd74d874`, named below, which is undeleted and was
 * still authenticating at the read.
 *
 * ── Why not the end of that UTC day, and what that is worth ────────────────
 * The first version of this constant was 2026-09-17T00:00:00Z. Against it:
 * every row created in [14:05:00Z, 00:00:00Z) that reads NULL and has been used
 * is classified as pre-column and notified for a build that never moved. At
 * 2026-09-16 22:54Z that is exactly ONE row — `cd74d874`, created 18:09:32.72Z,
 * column NULL, undeleted, still authenticating — against 58 rows that fire
 * under either constant. So the measured benefit of moving the watershed is one
 * avoided spurious notification, i.e. one wasted client `tools/list`. Still
 * exactly that one row, and still `cd74d874`, on a re-read 34 minutes later
 * (23:28:05Z) — by which point it had been used again, `last_used_at`
 * 23:18:56.37Z as of 23:21:01Z.
 *
 * It is worth being blunt about the size of that, and about two claims the
 * earlier version made for it that do not survive measurement. It does NOT
 * grow at "one to four rows an hour": the whole table gains 0.87 rows an hour
 * and a rotation gains none, so the misclassified set accumulates at roughly
 * one row per four hours and only while the constant is in the future. And it
 * does not REGENERATE: the end-of-day constant lapses at 2026-09-17T00:00:00Z
 * (about 66 minutes after the measurement above), after which it misclassifies
 * nothing new and the difference between the two values is a fixed, shrinking
 * set of rows created during that one afternoon.
 *
 * What still justifies the constant, independent of its exact value: the defect
 * is real — a key that connected before the column existed can never be
 * notified at all, which is the launch cohort — and the `predatesBuildTracking
 * && keyUsedBefore` pair is the mechanism that fixes it. Where the line sits
 * inside the empty afternoon interval changes nothing; that it sits before
 * 2026-09-17T00:00:00Z is worth one row today and cannot cost anything, since
 * the silencing-direction count is 0. Keep it at the deploy.
 *
 * ── Which way it is still allowed to be wrong ──────────────────────────────
 * Too EARLY silences a genuinely pre-column key forever, which is the bug this
 * exists to fix. Too LATE spuriously notifies a post-deploy key that has never
 * read a listing, once per key, for as long as the constant is in the future.
 * The first is unbounded in consequence and the second costs one round trip,
 * which is why the constant sits at the bottom of the bracket rather than
 * padded forward: 14:05:00Z is 16 seconds after the `e9704f3` commit bound and
 * 14 minutes before the last instant the key data allows. Both misclassification
 * counts at that placement are 0.
 *
 * This decays on its own. Once every pre-deploy key has recorded a build (one
 * per key, on that key's own next card-bearing call), the branch this gates is
 * dead and can be deleted along with the constant.
 */
export const CARD_BUILD_TRACKING_SINCE = Date.parse("2026-09-16T14:05:00Z");

/**
 * True when this key existed before `card_build_notified` was ever written, so
 * a NULL in that column is an absence of evidence rather than evidence of an
 * absence.
 *
 * Unparseable or missing input returns false, which is the quiet side: the
 * runner's synthesised key rows carry `created_at: ""`, and an internal caller
 * that never talks Streamable HTTP must not be treated as a stale client.
 */
export function predatesBuildTracking(createdAt: string | null | undefined): boolean {
  if (!createdAt) return false;
  const at = Date.parse(createdAt);
  return Number.isFinite(at) && at < CARD_BUILD_TRACKING_SINCE;
}

/** The notification body. No params, no id: it is a bare notification. */
export const TOOLS_LIST_CHANGED_NOTIFICATION = {
  jsonrpc: "2.0",
  method: "notifications/tools/list_changed",
} as const;

export interface NotifyDecision {
  /** Emit `notifications/tools/list_changed` ahead of this response. */
  notify: boolean;
  /**
   * Write this build id to `api_keys.card_build_notified`, or null to leave the
   * column alone. Kept separate from `notify` because `tools/list` records
   * without notifying: that client has just been handed the current URI.
   */
  record: string | null;
}

export interface NotifyInput {
  /** The JSON-RPC method being served. */
  method: string;
  /** True when this `tools/call` names a tool that carries `_meta.ui`. */
  cardBearingTool: boolean;
  /** The client's Accept header permits an SSE response. */
  acceptsEventStream: boolean;
  /** `api_keys.card_build_notified`, or null when never set. */
  notifiedBuild: string | null;
  /** `REVIEW_CARD_BUILD_ID` of the running deploy. */
  currentBuild: string;
  /**
   * `api_keys.created_at` is older than CARD_BUILD_TRACKING_SINCE — the key
   * could have been served tool listings before we started recording them, so
   * a NULL `notifiedBuild` does not prove an empty cache. See that constant.
   */
  keyPredatesBuildTracking: boolean;
  /**
   * `api_keys.last_used_at` was non-null BEFORE this request. The row is read
   * at authentication time and the `last_used_at` write is fire-and-forget
   * afterwards, so this is genuinely "has this key served an earlier request",
   * not "is it serving one now".
   */
  keyUsedBefore: boolean;
}

/**
 * Decide whether this request should carry a tool-list invalidation.
 *
 * Pure, so `card-build-notify.test.ts` can pin every branch without a server.
 *
 * The rules, and why each one is a rule rather than a nicety:
 *
 * * **`tools/list` records, never notifies.** The client is being handed the
 *   current listing in this very response; telling it the listing changed would
 *   be both false and an infinite loop (it would re-read, and we would tell it
 *   again).
 * * **Only `tools/call` notifies.** The spec asks that a message on a POST's
 *   stream "relate to the originating client request". A card-bearing tool call
 *   is about to mount the stale card; a `ping` is not.
 * * **Only card-bearing tools.** A stale listing only matters because of the
 *   card URI inside it. Invalidating on `inbox_list` would make every client
 *   re-read the whole tool list for nothing.
 * * **NOT gated on the client being UI-capable,** which is the one obvious rule
 *   missing here. Only an MCP Apps client can observe a stale card URI, so in
 *   principle nobody else needs the notification. But client capabilities are
 *   declared at `initialize` and this server is stateless, so knowing them at
 *   `tools/call` time means a database read on every call. The trade is
 *   lopsided: that read is per-call and forever, while a needless notification
 *   costs one `tools/list` per key per deploy. So every client is told.
 * * **Only when the client accepts an event stream.** Without it we have no
 *   channel, and a client that asked for `application/json` must get JSON.
 * * **Only on a real change.** A `notifiedBuild` equal to the running build
 *   means this key's client has already been handed, or told about, this
 *   listing.
 * * **A null `notifiedBuild` is ambiguous, and is resolved by the key's own
 *   age.** It means either "never read a `tools/list`, nothing cached" or
 *   "connected before the column existed, and every bit of it is cached". Only
 *   the second gets notified — see CARD_BUILD_TRACKING_SINCE for how they are
 *   told apart and which way the split is allowed to be wrong.
 * * **`tools/list` must not swallow a pending invalidation.** The state is per
 *   KEY; one key routinely serves several live connections (desktop and web, a
 *   reconnect while another session stays up). Overwriting the sentinel with
 *   the real build on the FIRST connection's `tools/list` left every other
 *   connection holding a listing nobody would ever invalidate — still showing a
 *   card the user had just hidden. So a `tools/list` that finds the sentinel
 *   leaves it, and only a notification clears it.
 *
 * What this still cannot do, because there is no per-connection state to do it
 * with: when two connections share a key, the sentinel is consumed by whichever
 * makes the first card-bearing call, so the other one is only reached if a
 * later change sets the sentinel again. Fixing that needs either a notification
 * on every call within a time window (N re-listings per client per change) or
 * per-connection identity the transport does not give us. One guaranteed
 * delivery per change beats zero, and costs one `tools/list`.
 *
 * That residual is narrower than "one key, several connections" makes it sound,
 * and the narrowing is worth knowing before anyone spends a schema change on
 * it: an OAuth connection holds its OWN `api_keys` row, minted once per
 * authorization and thereafter rotated IN PLACE, so two OAuth connections to
 * one workspace do not share a row and neither can consume the other's
 * sentinel. The residual bites only a STATIC API key pasted into more than one
 * client.
 *
 * A token rotation is not a second residual, and an earlier version of this
 * paragraph said it was. The `refresh_token` grant updates the existing row's
 * `key_hash`/`key_prefix`/`expires_at` by id; it writes neither `created_at`
 * nor `card_build_notified`, so a sentinel written before a refresh is still
 * sitting on the same row afterwards and is delivered on the next card-bearing
 * call as if nothing had happened. See CARD_BUILD_TRACKING_SINCE for the code
 * path and the production counts that establish it.
 */
export function decideBuildNotification(input: NotifyInput): NotifyDecision {
  if (input.method === "tools/list") {
    // A pending invalidation outlives this listing: it may have been raised for
    // a DIFFERENT connection on the same key, and this response cannot reach
    // that one. Leave the sentinel for the card-bearing call that will.
    if (input.notifiedBuild === CARD_LISTING_STALE) return { notify: false, record: null };
    // Record only when it actually moved, so the caller can skip the write.
    return {
      notify: false,
      record: input.notifiedBuild === input.currentBuild ? null : input.currentBuild,
    };
  }

  if (input.method !== "tools/call") return { notify: false, record: null };
  if (!input.cardBearingTool) return { notify: false, record: null };
  if (!input.acceptsEventStream) return { notify: false, record: null };

  if (input.notifiedBuild === null) {
    // Nothing recorded. Either the key has never been served a listing (no
    // cache, say nothing), or it was being served listings before this column
    // existed (a cache we are blind to, and the whole cohort the notification
    // was written for). Both conditions must hold to call it the second.
    if (!input.keyPredatesBuildTracking || !input.keyUsedBefore) {
      return { notify: false, record: null };
    }
    return { notify: true, record: input.currentBuild };
  }

  if (input.notifiedBuild === input.currentBuild) return { notify: false, record: null };

  return { notify: true, record: input.currentBuild };
}

// ---------------------------------------------------------------------------
// Claiming the notification
// ---------------------------------------------------------------------------

/**
 * The single-table, single-statement slice of the Supabase client this module
 * needs, written structurally so the compare-and-swap below can be tested
 * against a fake that actually swaps, with no database and no server.
 *
 * ── Two things about the real client that the fake cannot show ─────────────
 * 1. The claim reads "did I win" off `Array.isArray(data) && data.length > 0`,
 *    which relies on `Prefer: return=representation` giving `200 []` for a
 *    zero-match PATCH. `processResponse` in postgrest-js has a branch —
 *    `if (body === "") {}` — that leaves `data` as `null` rather than `[]`. If
 *    PostgREST ever answered a successful representation PATCH with an empty
 *    body, `Array.isArray(null)` is false and a WON claim would read as lost:
 *    the notification would be sent by a caller that did move the row, and the
 *    next call would send it again. Unexercised today, and in the fail-open
 *    direction, so it is recorded rather than defended against.
 * 2. index.ts builds its client from a FLOATING `@supabase/supabase-js@2` on
 *    esm.sh, so the deployed postgrest-js is whatever that resolved to at
 *    `supabase functions deploy` time — NOT the `node_modules` copy anyone
 *    reads locally. Behaviour asserted by reading the local dependency is
 *    evidence about the deploy, not proof of it.
 */
export interface CardBuildUpdateBuilder {
  eq(column: string, value: unknown): CardBuildUpdateBuilder;
  is(column: string, value: null): CardBuildUpdateBuilder;
  select(
    columns: string,
  ): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
}

export interface CardBuildClient {
  from(table: string): {
    update(values: Record<string, unknown>): CardBuildUpdateBuilder;
  };
}

/**
 * How long the compare-and-swap may hold a response that has already done its
 * work, in ms.
 *
 * The swap is a single UPDATE on `api_keys` by primary key against PostgREST in
 * the same region: single-digit milliseconds in ordinary operation. 1500 ms is
 * therefore about two orders of magnitude of headroom, so a slow-but-alive
 * database never trips it and the "exactly one notification per change"
 * guarantee keeps holding under real latency — while capping at 1.5 s the delay
 * a stalled PostgREST can add to a `tools/call` that has ALREADY sent an email.
 *
 * Tripping it is cheap and in the same direction as every other failure here:
 * fail open, notify, cost one redundant `tools/list`. Waiting is not cheap, so
 * the deadline is short rather than generous. Note the in-flight PATCH is not
 * cancelled, only stopped being waited on: if it lands late the row still moves,
 * which is precisely what the winner would have done, and we notified too.
 */
export const CARD_CLAIM_DEADLINE_MS = 1500;

/** Distinguishes "the deadline fired" from any value PostgREST could return. */
const CLAIM_TIMED_OUT = Symbol("card-build-claim-timeout");

type ClaimResult = { data: unknown[] | null; error: { message: string } | null };

/**
 * Race a claim against a deadline.
 *
 * The PostgREST promise is folded into a never-rejecting one first, and the
 * reason is smaller than it looks. It is NOT "otherwise a late rejection would
 * be unhandled": `Promise.race` subscribes to every entrant, so the losing
 * promise has a reaction attached whether or not anyone is still awaiting the
 * race, and deleting the fold (`const settled = Promise.resolve(work);`)
 * produces no unhandled rejection and no crashed isolate. That claim was made
 * here and it was wrong.
 *
 * What the fold actually buys is classification. With it, a rejection that
 * arrives BEFORE the deadline becomes an ordinary `{data: null, error}` result
 * and is logged as `card_build_claim_failed` with the PostgREST message in
 * hand; without it the rejection propagates out of the `await` in
 * `claimListingNotification` into the outer catch and is logged as
 * `card_build_claim_threw` instead. Both return true and both fail open, so
 * this is a log-legibility win and nothing more — a rejected claim is a
 * database failure, not a programming error, and should not be filed with the
 * programming errors.
 *
 * The timer is cleared in `finally` so a won race cannot hold the isolate open;
 * that one is load-bearing, and deleting it turns 7 of this module's tests red
 * under Deno's op sanitizer (measured on this commit, 2026-09-16: `39 passed`
 * becomes `32 passed | 7 failed`). It was 6 when that was first written and a
 * seventh timer-using test has since been added, so re-count rather than
 * trusting the number if you touch this.
 */
function withClaimDeadline(
  work: PromiseLike<ClaimResult>,
  ms: number,
): Promise<ClaimResult | typeof CLAIM_TIMED_OUT> {
  const settled: Promise<ClaimResult> = Promise.resolve(work).then(
    (result) => result,
    (err): ClaimResult => ({
      data: null,
      error: { message: err instanceof Error ? err.message : String(err) },
    }),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof CLAIM_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(CLAIM_TIMED_OUT), ms);
  });

  return Promise.race([settled, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Move `card_build_notified` from the value this request read to `next`, and
 * report whether THIS request is the one that moved it.
 *
 * ── Why a compare-and-swap ─────────────────────────────────────────────────
 * The write used to be unconditional and fire-and-forget, so the decision and
 * the write were not one operation. Three concurrent card-bearing calls on one
 * stale key each read the sentinel, each decided to notify, and each wrote:
 * three notifications, three client re-listings, for one change. The `.eq` /
 * `.is` predicate on the old value makes the UPDATE itself the arbiter — one
 * statement moves the row, the others match nothing — and returning the
 * affected rows turns "did I win" into a fact rather than an assumption.
 *
 * It also closes a smaller race in the other direction: a `tools/list` that
 * read a real build id could previously clobber a sentinel written by a
 * preference change a millisecond later, silently dropping the invalidation.
 * Predicating on the value that was read makes that write a no-op instead.
 *
 * Callers that are about to notify MUST await this and honour the answer; that
 * is the one place a database round trip is spent, and only on the rare request
 * that has something to say. Callers that are merely recording (`tools/list`)
 * can drop the promise: a lost record costs one repeated notification, never a
 * failed request.
 *
 * ── On failure it returns true ─────────────────────────────────────────────
 * An error means we do not know whether the swap happened. Claiming it did
 * would risk swallowing the invalidation entirely — the failure mode this whole
 * file exists to remove — while claiming it did not costs at most a repeated
 * notification, and the client answers each one with a `tools/list` it would
 * have made at the next reconnect anyway.
 *
 * Every one of those failures is LOGGED, because fail-open is a bound on the
 * cost per request and not a bound over time: a PATCH that keeps failing makes
 * every card-bearing call on that key notify, forever, at exactly twice the
 * client traffic, and silently. `invalidateCardListings` on the web side warns
 * for the same reason.
 *
 * ── And it is bounded in time ──────────────────────────────────────────────
 * The one awaited call sits AFTER `routeMethod` has run, so by this line the
 * tool's own work is done. The edge function's Supabase client sets no custom
 * `fetch` and no `AbortSignal`, so without a deadline a stalled PostgREST would
 * hold the response until the function's wall clock kills it, and the client
 * would see a failure for a call that had already sent the mail or deleted the
 * messages. A bookkeeping write must never be able to do that. That is the
 * argument for the deadline, and it does not depend on which tools are
 * card-bearing.
 *
 * What the awaited wait costs depends on WHICH tool, and an earlier version of
 * this comment answered that with an exhaustive list — `email_compose`,
 * `schedule`, `draft`, `email_delete`, `email_organize`,
 * `email_search_and_move` — and the claim that every one of them has already
 * committed a side effect, so the only risk is a late response for work that
 * succeeded. The list is `isCardBearingToolName` in mcp-app-resources.ts, it is
 * not frozen, and it is already growing: a sibling branch adds `draft_read`,
 * `draft_editor_save` and `draft_editor_hide`, because those are the tools the
 * draft-editor card itself calls. `draft_read` has NO side effect. It is a pure
 * read whose latency the user watches, and a restoring card calls it before it
 * calls anything else.
 *
 * So state the real bound instead of the list. The wait is at most
 * CARD_CLAIM_DEADLINE_MS, it happens only on a request that has an invalidation
 * to deliver, and that is at most once per key per change. The worst case is
 * therefore the FIRST card remount after a card deploy or a preference change
 * waiting up to 1.5 s before the editor paints — visible, bounded, once. That
 * is a latency cost, not a correctness one, and it is the price of the
 * compare-and-swap being the arbiter. If it ever needs to be zero, the answer
 * is to skip the await for tools with no side effect and accept duplicate
 * notifications on those, not to drop the deadline.
 *
 * See CARD_CLAIM_DEADLINE_MS for the number and why it is that number.
 */
export async function claimListingNotification(
  client: CardBuildClient,
  keyId: string,
  expected: string | null,
  next: string,
  deadlineMs: number = CARD_CLAIM_DEADLINE_MS,
): Promise<boolean> {
  try {
    const update = client
      .from("api_keys")
      .update({ card_build_notified: next })
      .eq("id", keyId);
    const guarded = expected === null
      ? update.is("card_build_notified", null)
      : update.eq("card_build_notified", expected);

    const outcome = await withClaimDeadline(guarded.select("id"), deadlineMs);
    if (outcome === CLAIM_TIMED_OUT) {
      console.warn("[mcp-server] card_build_claim_timeout", {
        key_id: keyId,
        expected,
        next,
        deadline_ms: deadlineMs,
      });
      return true;
    }
    const { data, error } = outcome;
    if (error) {
      console.warn("[mcp-server] card_build_claim_failed", {
        key_id: keyId,
        expected,
        next,
        error: error.message,
      });
      return true;
    }
    return Array.isArray(data) && data.length > 0;
  } catch (err) {
    console.warn("[mcp-server] card_build_claim_threw", {
      key_id: keyId,
      expected,
      next,
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

/**
 * True when the client's `Accept` header permits an SSE response.
 *
 * Streamable HTTP requires clients to send both `application/json` and
 * `text/event-stream`, but a non-conforming client that omits the latter must
 * still get a plain JSON response rather than a stream it cannot parse.
 */
export function acceptsEventStream(accept: string | null): boolean {
  if (!accept) return false;
  return accept.toLowerCase().includes("text/event-stream");
}

/**
 * One SSE response carrying zero or more notifications and then the JSON-RPC
 * response for the request in the POST body.
 *
 * Event framing is the plain SSE `data:` form. No `id:` fields: those exist for
 * resumption via `Last-Event-ID`, and this stream is opened, written and closed
 * inside a single request, so there is nothing to resume. The stream closes
 * immediately after the response, which is what the spec asks for
 * ("After the JSON-RPC response has been sent, the server SHOULD close the SSE
 * stream").
 */
export function sseResponse(
  notifications: ReadonlyArray<Record<string, unknown>>,
  response: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  const encoder = new TextEncoder();
  const frame = (message: unknown) =>
    encoder.encode(`data: ${JSON.stringify(message)}\n\n`);

  const stream = new ReadableStream({
    start(controller) {
      for (const n of notifications) controller.enqueue(frame(n));
      controller.enqueue(frame(response));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      ...extraHeaders,
    },
  });
}
