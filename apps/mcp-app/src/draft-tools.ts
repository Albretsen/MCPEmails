// ---------------------------------------------------------------------------
// Which tool name the draft editor sends and deletes with.
//
// A host may only let the card call tools from its own listing. Claude lists the
// consolidated `draft`. ChatGPT lists one tool per operation (`draft_send`,
// `draft_delete`; PER_OPERATION_LISTING in mcp-server/index.ts) and answers a
// call to `draft` from its own backend, without ever calling the server:
// HTTP 404 `{"detail":"MCP Resource not found"}` from /ecosystem/call_mcp, which
// reaches the card as `-32000: {"detail":"MCP Resource not found"}` (seen live,
// 2026-11-02). The card read that as a lost answer: "The connection dropped
// while sending".
//
// Both names run the same handler, with the same scopes, ledger and logging.
//
// The signal: the server stamps `per_operation_tools` on a draft result the
// model got by calling a per-operation tool (mcp-server/card-tool-surface.ts),
// which proves the host lists those. An answer to the card's own `draft_read`
// or `draft_editor_save` cannot carry it, since both surfaces share those names,
// so it is remembered here for the life of this frame.
//
// Without a signal (a result from before the stamp, a restored card) the card
// tries `draft`, and may then try the other name, ONLY when the failure proves
// the first call never reached the server. Everything else, a timeout or a
// dropped connection included, stays a lost answer: the send may have gone, and
// a second call could send it twice.
// ---------------------------------------------------------------------------

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

const SINGLE = { send: "draft_send", delete: "draft_delete" } as const;

/** The names whose bare `isError` sentence is a refusal (draft-failure.ts#textRefusalCode). */
export const isDraftActionTool = (tool: string): boolean =>
  tool === "draft" || tool === SINGLE.send || tool === SINGLE.delete;

let perOperation = false;

/** Remember what an envelope says. Only ever turns on: see the header. */
export function noteToolSurface(env: { per_operation_tools?: unknown }): void {
  if (env.per_operation_tools === true) perOperation = true;
}

/** The call to try first and the one allowed if that proves it never arrived. */
export function draftActionCalls(
  action: keyof typeof SINGLE,
  target: Record<string, unknown>,
): [ToolCall, ToolCall] {
  const named: ToolCall = { tool: SINGLE[action], args: target };
  const selected: ToolCall = { tool: "draft", args: { action, ...target } };
  return perOperation ? [named, selected] : [selected, named];
}

/**
 * The whole message and nothing else, because a false yes here is a second send.
 * A host that rewords it loses this fallback, and the answer stays a lost one.
 */
export function neverReachedServer(e: unknown): boolean {
  return e instanceof Error &&
    /^-?\d+: \{"detail":"MCP Resource not found"\}$/.test(e.message);
}
