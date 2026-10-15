/* Provider-neutral LLM interface.
 *
 * Nothing here is shaped after one vendor's wire format: a conversation is a
 * list of user / assistant / tool turns, a tool is a name + JSON Schema, and a
 * stream is a sequence of small events. An adapter (openai.ts, anthropic.ts)
 * translates both directions and nothing outside `llm/` knows which is in use.
 *
 * ADDING A PROVIDER (checklist)
 *  1. Create `llm/<name>.ts` exporting `create<Name>Provider(opts): LlmProvider`.
 *  2. Translate `LlmRequest` to the vendor request: `system` is the system
 *     prompt, `messages` are in order, an assistant turn may carry text AND
 *     tool calls, a tool turn carries one result per call id.
 *  3. Translate the vendor stream to `LlmEvent`s. Tool calls get a stable
 *     `index` (0, 1, ...) per response; emit start, argument deltas, end.
 *     Emit exactly one `usage` (when the vendor reports it) and one `finish`.
 *  4. Throw `LlmError` for every failure, with `kind` and `retryable` set.
 *     Never put response bodies or prompt text in the message.
 *  5. Wrap the request in `streamWithRetry` (retry.ts) so one retry happens
 *     only before any event was emitted, and pass `signal` to `fetch`.
 *  6. Register it in `registry.ts` and add its models to `pricing.ts`.
 *  7. Add an SSE fixture test like `openai_test.ts`.
 */

export interface LlmToolDef {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  /** Provider call id; echoed back in the matching tool result. */
  id: string;
  name: string;
  /** The arguments exactly as generated: a JSON object as text. */
  argumentsJson: string;
}

export interface LlmToolResult {
  callId: string;
  name: string;
  content: string;
  isError: boolean;
}

export type LlmMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: LlmToolCall[] }
  | { role: "tool"; results: LlmToolResult[] };

export interface LlmRequest {
  model: string;
  system: string;
  messages: LlmMessage[];
  tools: LlmToolDef[];
  maxOutputTokens: number;
  temperature?: number;
  signal: AbortSignal;
}

export type LlmFinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "other";

export type LlmEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_delta"; index: number; argumentsDelta: string }
  | { type: "tool_call_end"; index: number; id: string; name: string; argumentsJson: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cachedInputTokens: number }
  | { type: "finish"; reason: LlmFinishReason };

export type LlmErrorKind =
  | "rate_limit"
  | "auth"
  | "context_length"
  | "overloaded"
  | "network"
  | "invalid_request"
  | "not_configured"
  | "aborted"
  | "unknown";

/** Every provider failure. `message` is a fixed, content-free description. */
export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly retryable: boolean;
  readonly status: number | undefined;
  /** Provider's machine code when it has one ("rate_limit_exceeded"). */
  readonly providerCode: string | undefined;
  /** Seconds the provider asked us to wait, when it said. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    kind: LlmErrorKind,
    opts: { retryable?: boolean; status?: number; providerCode?: string; retryAfterSeconds?: number } = {},
  ) {
    super(`llm_${kind}`);
    this.name = "LlmError";
    this.kind = kind;
    this.retryable = opts.retryable ?? DEFAULT_RETRYABLE[kind];
    this.status = opts.status;
    this.providerCode = opts.providerCode;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

const DEFAULT_RETRYABLE: Record<LlmErrorKind, boolean> = {
  rate_limit: true,
  overloaded: true,
  network: true,
  unknown: false,
  auth: false,
  context_length: false,
  invalid_request: false,
  not_configured: false,
  aborted: false,
};

export interface LlmProvider {
  readonly name: string;
  stream(request: LlmRequest): AsyncIterable<LlmEvent>;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function isAbortError(err: unknown): boolean {
  return (err instanceof LlmError && err.kind === "aborted") ||
    (err instanceof DOMException && err.name === "AbortError");
}
