/* Anthropic adapter: NOT IMPLEMENTED. A stub that fails closed.
 *
 * It is a stub on purpose. Current Claude models differ from the request
 * shape this module's interface assumes in ways that must be verified against
 * the live API before real mailboxes depend on them, and no Anthropic key was
 * available to do that:
 *  - sampling parameters (`temperature`) are rejected with a 400 on the
 *    current Opus/Fable models, so `LlmRequest.temperature` must be dropped;
 *  - thinking is on by default on several models and returns `thinking`
 *    blocks that must be replayed unchanged with the tool results of the same
 *    turn, which needs a provider-state field on the assistant message that
 *    the neutral format does not carry yet;
 *  - streamed tool input arrives as `input_json_delta` fragments that are
 *    only streamed eagerly when the tool sets `eager_input_streaming: true`.
 *
 * CHECKLIST to finish it (see also the provider checklist in types.ts):
 *  1. POST {base}/v1/messages with headers `x-api-key`, `anthropic-version:
 *     2023-06-01`, `content-type: application/json`; body `{ model, system,
 *     messages, tools: [{ name, description, input_schema,
 *     eager_input_streaming: true }], max_tokens, stream: true }`.
 *  2. Map messages: user -> `{role:"user", content:[{type:"text"}]}`;
 *     assistant -> text block + one `tool_use` block per call (`input` is the
 *     PARSED arguments object); tool -> ONE user message holding every
 *     `tool_result` block (`tool_use_id`, `content`, `is_error`).
 *  3. Map the stream: `content_block_start` (tool_use) -> tool_call_start;
 *     `content_block_delta` text_delta -> text_delta, input_json_delta ->
 *     tool_call_delta; `content_block_stop` -> tool_call_end;
 *     `message_start` + `message_delta` usage -> one usage event
 *     (input = input_tokens + cache_read + cache_creation);
 *     `message_delta.stop_reason` -> finish (end_turn=stop, tool_use=tool_calls,
 *     max_tokens=length, refusal=content_filter); `error` event -> LlmError
 *     (overloaded_error=overloaded, rate_limit_error=rate_limit).
 *  4. Decide how thinking blocks are carried between rounds, then verify with
 *     a live check like `live-check.ts` before enabling in production.
 */

import { LlmError, type LlmEvent, type LlmProvider, type LlmRequest } from "./types.ts";

export function createAnthropicProvider(_opts: { apiKey: string }): LlmProvider {
  return {
    name: "anthropic",
    // deno-lint-ignore require-yield
    async *stream(_request: LlmRequest): AsyncGenerator<LlmEvent, void, undefined> {
      throw new LlmError("not_configured");
    },
  };
}
