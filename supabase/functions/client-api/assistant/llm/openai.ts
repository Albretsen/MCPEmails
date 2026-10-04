/* OpenAI adapter: Responses API, streaming, via fetch. No SDK.
 *
 * VERIFIED AGAINST THE LIVE API (2026-10-03, model `gpt-5.4-mini`, which the
 * API resolves to `gpt-5.4-mini-2026-03-17`):
 *  - Endpoint POST /v1/responses with `stream: true`. Chosen over Chat
 *    Completions because tool-call arguments stream as clean per-item events
 *    (`response.function_call_arguments.delta`, keyed by `output_index`).
 *  - Output cap is `max_output_tokens`. `max_completion_tokens` is REJECTED
 *    (HTTP 400, code `unsupported_parameter`).
 *  - `temperature` is accepted. The model's default reasoning effort is
 *    "none" (reported back as `reasoning.effort: "none"`, 0 reasoning tokens),
 *    so no `reasoning` field is sent.
 *  - `store: false` works statelessly: earlier tool calls are replayed as
 *    `function_call` + `function_call_output` input items. Items we fabricate
 *    ourselves (our own `call_id`, no item `id`, no reasoning item) are accepted.
 *  - Parallel tool calls arrive one after another, each as
 *    output_item.added -> function_call_arguments.delta* -> output_item.done,
 *    with increasing `output_index`.
 *  - Usage is on `response.completed` (`usage.input_tokens`,
 *    `usage.output_tokens`, `usage.input_tokens_details.cached_tokens`).
 *    `input_tokens` INCLUDES the cached tokens.
 *  - A response cut off by the cap ends with `response.incomplete`
 *    (`incomplete_details.reason: "max_output_tokens"`), not `completed`.
 */

import { type Sleep, streamWithRetry } from "./retry.ts";
import { readSse } from "./sse.ts";
import {
  type FetchLike,
  LlmError,
  type LlmEvent,
  type LlmFinishReason,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
} from "./types.ts";

export interface OpenAiOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  sleep?: Sleep;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export function createOpenAiProvider(opts: OpenAiOptions): LlmProvider {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const url = `${(opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}/responses`;
  return {
    name: "openai",
    stream(request: LlmRequest): AsyncIterable<LlmEvent> {
      return streamWithRetry(() => attempt(doFetch, url, opts.apiKey, request), {
        signal: request.signal,
        sleep: opts.sleep,
      });
    },
  };
}

/** The request body. Exported for tests. */
export function buildOpenAiBody(request: LlmRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    instructions: request.system,
    input: toInputItems(request.messages),
    stream: true,
    store: false,
    max_output_tokens: request.maxOutputTokens,
  };
  if (request.tools.length) {
    body.tools = request.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: false,
    }));
    body.parallel_tool_calls = true;
  }
  if (request.temperature !== undefined) body.temperature = request.temperature;
  return body;
}

function toInputItems(messages: LlmMessage[]): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      items.push({ role: "user", content: m.text });
    } else if (m.role === "assistant") {
      if (m.text) items.push({ role: "assistant", content: m.text });
      for (const c of m.toolCalls) {
        items.push({ type: "function_call", call_id: c.id, name: c.name, arguments: c.argumentsJson || "{}" });
      }
    } else {
      for (const r of m.results) items.push({ type: "function_call_output", call_id: r.callId, output: r.content });
    }
  }
  return items;
}

async function* attempt(
  doFetch: FetchLike,
  url: string,
  apiKey: string,
  request: LlmRequest,
): AsyncGenerator<LlmEvent, void, undefined> {
  if (!apiKey) throw new LlmError("not_configured");
  if (request.signal.aborted) throw new LlmError("aborted");
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildOpenAiBody(request)),
      signal: request.signal,
    });
  } catch {
    throw request.signal.aborted ? new LlmError("aborted") : new LlmError("network");
  }
  if (!res.ok) throw await httpError(res);
  if (!res.body) throw new LlmError("network");

  const calls = new Map<number, { id: string; name: string; args: string; ended: boolean }>();
  let nextIndex = 0;
  const indexOf = new Map<number, number>();
  let finished = false;

  try {
    for await (const msg of readSse(res.body, request.signal)) {
      if (msg.data === "[DONE]") break;
      const ev = parseJson(msg.data);
      if (!ev) continue;
      const type = str(ev.type) || msg.event;
      switch (type) {
        case "response.output_text.delta":
        case "response.refusal.delta": {
          const delta = str(ev.delta);
          if (delta) yield { type: "text_delta", text: delta };
          break;
        }
        case "response.output_item.added": {
          const item = obj(ev.item);
          if (!item || item.type !== "function_call") break;
          const outputIndex = num(ev.output_index);
          const index = nextIndex++;
          indexOf.set(outputIndex, index);
          const call = { id: str(item.call_id), name: str(item.name), args: "", ended: false };
          calls.set(index, call);
          yield { type: "tool_call_start", index, id: call.id, name: call.name };
          break;
        }
        case "response.function_call_arguments.delta": {
          const index = indexOf.get(num(ev.output_index));
          const call = index === undefined ? undefined : calls.get(index);
          const delta = str(ev.delta);
          if (index === undefined || !call || call.ended || !delta) break;
          call.args += delta;
          yield { type: "tool_call_delta", index, argumentsDelta: delta };
          break;
        }
        case "response.output_item.done": {
          const item = obj(ev.item);
          if (!item || item.type !== "function_call") break;
          const index = indexOf.get(num(ev.output_index));
          const call = index === undefined ? undefined : calls.get(index);
          if (index === undefined || !call || call.ended) break;
          call.ended = true;
          const finalArgs = typeof item.arguments === "string" && item.arguments ? item.arguments : call.args;
          // Deltas are what the caller streamed from; if the final text holds
          // more than they did, deliver the remainder before closing the call.
          if (finalArgs.length > call.args.length && finalArgs.startsWith(call.args)) {
            yield { type: "tool_call_delta", index, argumentsDelta: finalArgs.slice(call.args.length) };
          }
          call.args = finalArgs;
          yield { type: "tool_call_end", index, id: call.id, name: call.name, argumentsJson: finalArgs };
          break;
        }
        case "response.completed":
        case "response.incomplete": {
          const response = obj(ev.response) ?? {};
          const usage = obj(response.usage);
          if (usage) {
            yield {
              type: "usage",
              inputTokens: num(usage.input_tokens),
              outputTokens: num(usage.output_tokens),
              cachedInputTokens: num(obj(usage.input_tokens_details)?.cached_tokens),
            };
          }
          let reason: LlmFinishReason = [...calls.values()].some((c) => c.ended) ? "tool_calls" : "stop";
          if (type === "response.incomplete") {
            const why = str(obj(response.incomplete_details)?.reason);
            reason = why === "max_output_tokens" ? "length" : why === "content_filter" ? "content_filter" : "other";
          }
          finished = true;
          yield { type: "finish", reason };
          break;
        }
        case "response.failed": {
          const error = obj(obj(ev.response)?.error);
          throw streamError(str(error?.code));
        }
        case "error": {
          const error = obj(ev.error) ?? ev;
          throw streamError(str(error.code) || str(error.type));
        }
        default:
          break;
      }
      if (finished) break;
    }
  } catch (err) {
    if (request.signal.aborted) throw new LlmError("aborted");
    if (err instanceof LlmError) throw err;
    throw new LlmError("network");
  }
  if (request.signal.aborted) throw new LlmError("aborted");
  // The connection closed without a terminal event: the answer is incomplete.
  if (!finished) throw new LlmError("network");
}

/** Maps a non-2xx response. Reads only the machine code, never the message. */
async function httpError(res: Response): Promise<LlmError> {
  let code = "";
  try {
    const body = parseJson(await res.text());
    const error = obj(body?.error);
    code = str(error?.code) || str(error?.type);
  } catch {
    // An unreadable error body changes nothing: the status decides.
  }
  const retryAfter = Number(res.headers.get("retry-after"));
  const base = {
    status: res.status,
    providerCode: code || undefined,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  };
  if (res.status === 401 || res.status === 403) return new LlmError("auth", base);
  if (res.status === 429) {
    // Out of credit is not a transient condition: retrying cannot help.
    return new LlmError("rate_limit", { ...base, retryable: code !== "insufficient_quota" });
  }
  if (code === "context_length_exceeded") return new LlmError("context_length", base);
  if (res.status === 400 || res.status === 404 || res.status === 422) return new LlmError("invalid_request", base);
  if (res.status === 408 || res.status === 409) return new LlmError("overloaded", base);
  if (res.status >= 500) return new LlmError("overloaded", base);
  return new LlmError("unknown", base);
}

function streamError(code: string): LlmError {
  const base = { providerCode: code || undefined };
  if (code === "rate_limit_exceeded") return new LlmError("rate_limit", base);
  if (code === "insufficient_quota") return new LlmError("rate_limit", { ...base, retryable: false });
  if (code === "context_length_exceeded") return new LlmError("context_length", base);
  if (code === "invalid_api_key") return new LlmError("auth", base);
  if (code === "server_error" || code === "overloaded" || code === "service_unavailable") {
    return new LlmError("overloaded", base);
  }
  if (code === "invalid_prompt" || code === "invalid_request_error") return new LlmError("invalid_request", base);
  return new LlmError("unknown", base);
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    return obj(JSON.parse(text)) ?? null;
  } catch {
    return null;
  }
}
function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
