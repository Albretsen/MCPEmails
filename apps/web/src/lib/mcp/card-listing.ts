/**
 * The web half of the MCP tool-listing invalidation sentinel.
 *
 * ── Why this value lives twice ─────────────────────────────────────────────
 * The authority is `supabase/functions/mcp-server/card-build-notify.ts`, which
 * runs in Deno on the Supabase edge runtime. That function is deployed on its
 * own with `supabase functions deploy` and bundles only what lives under
 * `supabase/functions/`; no edge function in this repo imports anything from
 * outside that tree, and this Next.js app cannot import into it either. So the
 * repo's existing answer to a value two runtimes must agree on applies (see
 * `supabase/functions/mcp-server/utf7-copies.test.ts` for the same argument
 * about the modified-UTF-7 codec): duplicate the value in one place per
 * runtime, and fail the build when the copies stop matching.
 *
 * The drift check is enforced from both sides on purpose, so that whichever
 * suite a change happens to run catches it:
 *   - Deno:  supabase/functions/mcp-server/card-build-notify.test.ts
 *   - Node:  apps/web/src/lib/mcp/card-listing.test.ts
 * Both read the OTHER codebase's source file and compare the literals.
 *
 * ── What it does ───────────────────────────────────────────────────────────
 * Writing it into `api_keys.card_build_notified` marks every live key in a
 * workspace as holding a stale `tools/list`. The MCP server sends
 * `notifications/tools/list_changed` on that key's next card-bearing tool call
 * and the client re-reads a listing that reflects the new card preference, with
 * no reconnect. It is deliberately a value no review-card build id can ever
 * equal (build ids are 12 lowercase hex), because a collision would make a
 * deploy land on the sentinel and silently stop notifying.
 *
 * ── The write guards on `deleted_at` ONLY, and that is load-bearing ────────
 * Every writer of this sentinel — `PATCH /api/inboxes/[id]`, `PATCH
 * /api/workspaces/[id]`, and `invalidateCardListings()` in
 * supabase/functions/mcp-server/index.ts, which has the identical predicate and
 * is easy to miss when someone says "both dashboard routes" — marks every key
 * in the workspace with `.eq('workspace_id', …).is('deleted_at', null)` and NO
 * expiry condition. That looks like an oversight next to the MCP server's own
 * authentication filter, which also requires `expires_at is null OR expires_at
 * > now()`, and it has been read as one. It is not: ADDING an expiry filter
 * here would introduce a bug.
 *
 * An expired OAuth access token is not a dead row. The `refresh_token` grant in
 * app/api/oauth/token/route.ts resurrects it IN PLACE — `.update({key_hash,
 * key_prefix, expires_at}).eq('id', rt.api_key_id).is('deleted_at', null)`,
 * guarding on `deleted_at` only, exactly as these writes do — so the row starts
 * authenticating again with whatever `card_build_notified` held while it was
 * expired. Marking it stale while it is expired is therefore the ONLY way to
 * reach the connection that comes back on it, and that connection is precisely
 * the one that needs reaching: it never disconnected, so it is still holding
 * the listing it cached before the preference changed.
 *
 * Measured on production 2026-09-16 22:54Z: 401 undeleted rows have an
 * `expires_at` in the past, and 3 of them are holding this sentinel right now.
 * All 3 have exactly one live refresh token (unrevoked, unexpired), so all 3
 * will be resurrected and will then deliver the invalidation they are carrying.
 * An expiry filter would have skipped all 3 and left three connections showing
 * a card their owner had switched off.
 */
export const CARD_LISTING_STALE = 'stale';
