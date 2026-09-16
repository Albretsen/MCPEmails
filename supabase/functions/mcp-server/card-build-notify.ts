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
 * * **Only on a real change.** A null `notifiedBuild` means the client has
 *   never read a `tools/list` from us, so it holds no cached listing to
 *   invalidate and gets nothing.
 */
export function decideBuildNotification(input: NotifyInput): NotifyDecision {
  if (input.method === "tools/list") {
    // Record only when it actually moved, so the caller can skip the write.
    return {
      notify: false,
      record: input.notifiedBuild === input.currentBuild ? null : input.currentBuild,
    };
  }

  if (input.method !== "tools/call") return { notify: false, record: null };
  if (!input.cardBearingTool) return { notify: false, record: null };
  if (!input.acceptsEventStream) return { notify: false, record: null };
  // Never notified/served a listing: nothing cached, nothing to invalidate.
  if (input.notifiedBuild === null) return { notify: false, record: null };
  if (input.notifiedBuild === input.currentBuild) return { notify: false, record: null };

  return { notify: true, record: input.currentBuild };
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
