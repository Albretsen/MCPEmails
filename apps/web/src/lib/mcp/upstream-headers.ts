/**
 * The headers `/api/mcp` forwards to the Edge Function.
 *
 * WHY THIS IS A MODULE AND NOT FOUR LINES IN THE ROUTE. The proxy does not pass
 * the client's request through; it builds a fresh header object, so a header
 * that is not named here is not merely dropped, it is REPLACED by undici's
 * default on the outgoing fetch. That failure is invisible from both ends: the
 * client sees a normal response and the upstream sees a plausible header it has
 * no reason to doubt.
 *
 * It has now happened twice.
 *
 *   1. `MCP-Protocol-Version` was dropped until 2026-09-08, so the upstream had
 *      never seen a real client's negotiated version.
 *   2. `Accept` was dropped until 2026-09-17, so every request arrived with
 *      undici's wildcard Accept (measured: 2681 of 2681, byte-identical, which
 *      is the signature of a proxy default and not of real clients). The exact
 *      value is asserted in the test, which uses line comments and can spell
 *      it. The upstream gate
 *      for server-initiated notifications is
 *      `accept.includes("text/event-stream")`, so it was false on every
 *      request and `notifications/tools/list_changed` had never fired for
 *      anyone: 2329 `[mcp-server]` log lines in the two hours after a card
 *      deploy, zero notifications, while one key with 328 card-bearing calls
 *      waited for one. The only symptom was "clients must reconnect after a
 *      card deploy", which read as a property of the MCP Apps spec rather than
 *      as a bug in this proxy.
 *
 * Both times the mistake survived review because the forwarding lived inline in
 * a route handler where nothing could assert on it. Here it is a pure function
 * over a header bag, so `upstream-headers.test.ts` can state the contract
 * directly.
 */

export interface ClientHeaders {
  /** Resolved bearer token. The route decides header-vs-query precedence. */
  authorization: string;
  /** The client's Content-Type, or the route's default. */
  contentType: string;
  /** `MCP-Protocol-Version`, or null when the client sent none. */
  protocolVersion?: string | null;
  /** `Accept`, or null when the client sent none. */
  accept?: string | null;
}

/**
 * Build the outgoing header record.
 *
 * Absent stays absent. An omitted optional header lets undici apply its own
 * default, which is the honest representation of "the client did not ask";
 * inventing a value would be the same class of bug as dropping one. In
 * particular, never synthesise an SSE-capable `Accept`: a client that asked for
 * `application/json` alone must not be handed a stream it cannot parse.
 */
export function upstreamHeaders(client: ClientHeaders): Record<string, string> {
  return {
    'Content-Type': client.contentType,
    Authorization: client.authorization,
    ...(client.protocolVersion
      ? { 'MCP-Protocol-Version': client.protocolVersion }
      : {}),
    ...(client.accept ? { Accept: client.accept } : {}),
  };
}

// NO local copy of the upstream's Accept predicate lives here, deliberately.
// An earlier draft exported a `permitsEventStream` that restated
// `acceptsEventStream` from supabase/functions/mcp-server/card-build-notify.ts,
// and the test then agreed with the restatement: replacing the real gate's body
// with `return true` left all twelve checks green. The test now imports the
// real function instead, so the contract is pinned against production
// behaviour and cannot drift into agreeing with itself.
