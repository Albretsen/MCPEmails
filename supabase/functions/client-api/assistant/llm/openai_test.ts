/* OpenAI adapter against recorded SSE. The event shapes below were captured
 * from the live Responses API (gpt-5.4-mini, 2026-10-03) and trimmed: ids
 * shortened, the large `response` snapshots reduced to the fields we read. */

import { assert, assertEquals } from "../testing/fakes.ts";
import { buildOpenAiBody, createOpenAiProvider } from "./openai.ts";
import { costMicroUsd, priceFor } from "./pricing.ts";
import { resolveProvider } from "./registry.ts";
import { SseParser } from "./sse.ts";
import { LlmError, type LlmEvent, type LlmRequest } from "./types.ts";

function sse(events: Record<string, unknown>[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

const TEXT_STREAM = sse([
  { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
  { type: "response.in_progress", response: { id: "resp_1" } },
  { type: "response.output_item.added", item: { id: "msg_1", type: "message", role: "assistant", content: [] }, output_index: 0 },
  { type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
  { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hei på ", obfuscation: "a1" },
  { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "deg 😀", obfuscation: "b2" },
  { type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text: "Hei på deg 😀" },
  { type: "response.output_item.done", item: { id: "msg_1", type: "message", status: "completed" }, output_index: 0 },
  {
    type: "response.completed",
    response: {
      id: "resp_1",
      status: "completed",
      model: "gpt-5.4-mini-2026-03-17",
      usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 1024 }, output_tokens: 9, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1209 },
    },
  },
]);

const TOOL_STREAM = sse([
  { type: "response.created", response: { id: "resp_2", status: "in_progress" } },
  { type: "response.output_item.added", item: { id: "fc_1", type: "function_call", status: "in_progress", arguments: "", call_id: "call_A", name: "email_read" }, output_index: 0 },
  { type: "response.function_call_arguments.delta", delta: '{"action":"re', item_id: "fc_1", output_index: 0 },
  { type: "response.function_call_arguments.delta", delta: 'ad","message_id":"m1"}', item_id: "fc_1", output_index: 0 },
  { type: "response.function_call_arguments.done", arguments: '{"action":"read","message_id":"m1"}', item_id: "fc_1", output_index: 0 },
  { type: "response.output_item.done", item: { id: "fc_1", type: "function_call", status: "completed", arguments: '{"action":"read","message_id":"m1"}', call_id: "call_A", name: "email_read" }, output_index: 0 },
  { type: "response.output_item.added", item: { id: "fc_2", type: "function_call", status: "in_progress", arguments: "", call_id: "call_B", name: "folder_list" }, output_index: 1 },
  { type: "response.function_call_arguments.delta", delta: "{}", item_id: "fc_2", output_index: 1 },
  { type: "response.output_item.done", item: { id: "fc_2", type: "function_call", status: "completed", arguments: "{}", call_id: "call_B", name: "folder_list" }, output_index: 1 },
  { type: "response.completed", response: { id: "resp_2", status: "completed", usage: { input_tokens: 80, output_tokens: 31 } } },
]);

/** A Response whose body arrives in chunks of `size` BYTES (splitting UTF-8 sequences and lines). */
function chunked(text: string, size: number, status = 200, headers: Record<string, string> = {}): Response {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
      c.close();
    },
  });
  return new Response(body, { status, headers });
}

function request(signal = new AbortController().signal): LlmRequest {
  return {
    model: "gpt-5.4-mini",
    system: "sys",
    messages: [
      { role: "user", text: "hi" },
      { role: "assistant", text: "one moment", toolCalls: [{ id: "call_0", name: "folder_list", argumentsJson: "{}" }] },
      { role: "tool", results: [{ callId: "call_0", name: "folder_list", content: "[]", isError: false }] },
    ],
    tools: [{ name: "folder_list", description: "d", parameters: { type: "object", properties: {} } }],
    maxOutputTokens: 500,
    temperature: 0.3,
    signal,
  };
}

async function collect(stream: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const out: LlmEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

async function failure(stream: AsyncIterable<LlmEvent>): Promise<LlmError> {
  try {
    await collect(stream);
  } catch (err) {
    assert(err instanceof LlmError, `expected LlmError, got ${String(err)}`);
    return err;
  }
  throw new Error("expected the stream to fail");
}

Deno.test("openai: request body is the Responses shape, built from the neutral format", () => {
  const body = buildOpenAiBody(request());
  assertEquals(body, {
    model: "gpt-5.4-mini",
    instructions: "sys",
    input: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "one moment" },
      { type: "function_call", call_id: "call_0", name: "folder_list", arguments: "{}" },
      { type: "function_call_output", call_id: "call_0", output: "[]" },
    ],
    stream: true,
    store: false,
    max_output_tokens: 500,
    tools: [{ type: "function", name: "folder_list", description: "d", parameters: { type: "object", properties: {} }, strict: false }],
    parallel_tool_calls: true,
    temperature: 0.3,
  });
  assert(!("max_completion_tokens" in body) && !("max_tokens" in body));
});

Deno.test("openai: text deltas, usage and finish, at every chunk size", async () => {
  for (const size of [1, 2, 3, 5, 17, 4096]) {
    let seen: { url: string; auth: string | null } | null = null;
    const provider = createOpenAiProvider({
      apiKey: "sk-test",
      fetch: (url, init) => {
        seen = { url, auth: new Headers(init.headers).get("authorization") };
        return Promise.resolve(chunked(TEXT_STREAM, size));
      },
    });
    const events = await collect(provider.stream(request()));
    assertEquals(events, [
      { type: "text_delta", text: "Hei på " },
      { type: "text_delta", text: "deg 😀" },
      { type: "usage", inputTokens: 1200, outputTokens: 9, cachedInputTokens: 1024 },
      { type: "finish", reason: "stop" },
    ], `chunk size ${size}`);
    assertEquals(seen, { url: "https://api.openai.com/v1/responses", auth: "Bearer sk-test" });
  }
});

Deno.test("openai: parallel tool calls with split argument deltas", async () => {
  for (const size of [1, 7, 64]) {
    const provider = createOpenAiProvider({ apiKey: "k", fetch: () => Promise.resolve(chunked(TOOL_STREAM.replaceAll("\n", "\r\n"), size)) });
    const events = await collect(provider.stream(request()));
    assertEquals(events, [
      { type: "tool_call_start", index: 0, id: "call_A", name: "email_read" },
      { type: "tool_call_delta", index: 0, argumentsDelta: '{"action":"re' },
      { type: "tool_call_delta", index: 0, argumentsDelta: 'ad","message_id":"m1"}' },
      { type: "tool_call_end", index: 0, id: "call_A", name: "email_read", argumentsJson: '{"action":"read","message_id":"m1"}' },
      { type: "tool_call_start", index: 1, id: "call_B", name: "folder_list" },
      { type: "tool_call_delta", index: 1, argumentsDelta: "{}" },
      { type: "tool_call_end", index: 1, id: "call_B", name: "folder_list", argumentsJson: "{}" },
      { type: "usage", inputTokens: 80, outputTokens: 31, cachedInputTokens: 0 },
      { type: "finish", reason: "tool_calls" },
    ], `chunk size ${size}`);
  }
});

Deno.test("openai: a response cut off by the output cap finishes with reason length", async () => {
  const stream = sse([
    { type: "response.output_text.delta", delta: "At the edge of town" },
    { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 15, output_tokens: 16 } } },
  ]);
  const provider = createOpenAiProvider({ apiKey: "k", fetch: () => Promise.resolve(chunked(stream, 9)) });
  const events = await collect(provider.stream(request()));
  assertEquals(events.at(-1), { type: "finish", reason: "length" });
});

Deno.test("openai: HTTP error bodies map to typed errors and never leak the body", async () => {
  const cases: [number, Record<string, unknown>, string, boolean][] = [
    [401, { error: { message: "Incorrect API key provided: sk-abc", type: "invalid_request_error", code: "invalid_api_key" } }, "auth", false],
    [429, { error: { message: "Rate limit reached", type: "requests", code: "rate_limit_exceeded" } }, "rate_limit", true],
    [429, { error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" } }, "rate_limit", false],
    [400, { error: { message: "Your input exceeds the context window", type: "invalid_request_error", code: "context_length_exceeded" } }, "context_length", false],
    [400, { error: { message: "Unsupported parameter: 'max_completion_tokens'.", type: "invalid_request_error", code: "unsupported_parameter" } }, "invalid_request", false],
    [404, { error: { message: "The model does not exist", code: "model_not_found" } }, "invalid_request", false],
    [503, { error: { message: "overloaded" } }, "overloaded", true],
  ];
  for (const [status, body, kind, retryable] of cases) {
    let calls = 0;
    const provider = createOpenAiProvider({
      apiKey: "k",
      sleep: () => Promise.resolve(),
      fetch: () => {
        calls++;
        return Promise.resolve(new Response(JSON.stringify(body), { status }));
      },
    });
    const err = await failure(provider.stream(request()));
    assertEquals([err.kind, err.retryable, err.status], [kind, retryable, status]);
    assertEquals(calls, retryable ? 2 : 1, `${status} ${kind}: exactly one retry, only when retryable`);
    assert(!err.message.includes("sk-abc") && !err.message.includes("quota"), "the provider's message is not carried");
  }
});

Deno.test("openai: one retry on a retryable error before any output, honouring retry-after", async () => {
  const slept: number[] = [];
  let calls = 0;
  const provider = createOpenAiProvider({
    apiKey: "k",
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
    fetch: () => {
      calls++;
      return Promise.resolve(calls === 1 ? new Response("{}", { status: 500, headers: { "retry-after": "1" } }) : chunked(TEXT_STREAM, 50));
    },
  });
  const events = await collect(provider.stream(request()));
  assertEquals([calls, slept], [2, [1000]]);
  assertEquals(events.filter((e) => e.type === "text_delta").length, 2);
});

Deno.test("openai: no retry once output was emitted; in-stream error events are typed", async () => {
  const broken = sse([
    { type: "response.output_text.delta", delta: "partial" },
    { type: "error", code: "server_error", message: "The server had an error" },
  ]);
  let calls = 0;
  const provider = createOpenAiProvider({
    apiKey: "k",
    sleep: () => Promise.resolve(),
    fetch: () => {
      calls++;
      return Promise.resolve(chunked(broken, 20));
    },
  });
  const seen: LlmEvent[] = [];
  let err: unknown;
  try {
    for await (const e of provider.stream(request())) seen.push(e);
  } catch (e) {
    err = e;
  }
  assertEquals(seen, [{ type: "text_delta", text: "partial" }]);
  assert(err instanceof LlmError);
  assertEquals([err.kind, calls], ["overloaded", 1]);

  const failed = sse([{ type: "response.failed", response: { status: "failed", error: { code: "rate_limit_exceeded", message: "slow down" } } }]);
  const p2 = createOpenAiProvider({ apiKey: "k", sleep: () => Promise.resolve(), fetch: () => Promise.resolve(chunked(failed, 20)) });
  assertEquals((await failure(p2.stream(request()))).kind, "rate_limit");
});

Deno.test("openai: a stream that ends without a terminal event is a network error; fetch failure too", async () => {
  const truncated = sse([{ type: "response.output_text.delta", delta: "par" }]);
  const p1 = createOpenAiProvider({ apiKey: "k", sleep: () => Promise.resolve(), fetch: () => Promise.resolve(chunked(truncated, 20)) });
  assertEquals((await failure(p1.stream(request()))).kind, "network");
  let calls = 0;
  const p2 = createOpenAiProvider({
    apiKey: "k",
    sleep: () => Promise.resolve(),
    fetch: () => {
      calls++;
      return Promise.reject(new TypeError("connection refused"));
    },
  });
  assertEquals([(await failure(p2.stream(request()))).kind, calls], ["network", 2]);
});

Deno.test("openai: abort stops the stream, is not retried, and reaches fetch", async () => {
  const ctl = new AbortController();
  let fetchSignal: AbortSignal | null | undefined;
  let calls = 0;
  const provider = createOpenAiProvider({
    apiKey: "k",
    sleep: () => Promise.resolve(),
    fetch: (_url, init) => {
      calls++;
      fetchSignal = init.signal;
      const first = new TextEncoder().encode(sse([{ type: "response.output_text.delta", delta: "one" }]));
      // A body that never ends: only the abort can finish this stream.
      const body = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(first) });
      return Promise.resolve(new Response(body, { status: 200 }));
    },
  });
  const seen: LlmEvent[] = [];
  let err: unknown;
  try {
    for await (const e of provider.stream(request(ctl.signal))) {
      seen.push(e);
      ctl.abort();
    }
  } catch (e) {
    err = e;
  }
  assertEquals(seen, [{ type: "text_delta", text: "one" }]);
  assert(err instanceof LlmError && err.kind === "aborted");
  assertEquals([calls, fetchSignal === ctl.signal], [1, true]);
});

Deno.test("openai: no key means not_configured, without a request", async () => {
  let calls = 0;
  const provider = createOpenAiProvider({ apiKey: "", fetch: () => (calls++, Promise.resolve(new Response("{}"))) });
  assertEquals([(await failure(provider.stream(request()))).kind, calls], ["not_configured", 0]);
});

Deno.test("sse parser: CRLF, comments, multi-line data, a trailing block without a blank line", () => {
  const p = new SseParser();
  const out = [
    ...p.push(": ping\r\n\r\nevent: a\r"),
    ...p.push("\ndata: 1\r\ndata: 2\r\n\r\ndata:3\n\nevent: z\ndata: tail"),
    ...p.flush(),
  ];
  assertEquals(out, [{ event: "a", data: "1\n2" }, { event: "message", data: "3" }, { event: "z", data: "tail" }]);
});

Deno.test("registry: provider and model from env, defaults, fail closed", async () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name];
  const a = resolveProvider(env({ OPENAI_API_KEY: "k" }));
  assertEquals([a.provider.name, a.model], ["openai", "gpt-5.4-mini"]);
  const b = resolveProvider(env({ OPENAI_API_KEY: "k", ASSISTANT_MODEL: "gpt-5.4" }));
  assertEquals(b.model, "gpt-5.4");
  for (const vars of [{}, { ASSISTANT_PROVIDER: "nope", OPENAI_API_KEY: "k" }, { ASSISTANT_PROVIDER: "anthropic" }, { OPENAI_API_KEY: "k", ASSISTANT_MODEL: "bad model\n" }]) {
    let kind = "";
    try {
      resolveProvider(env(vars as Record<string, string>));
    } catch (e) {
      kind = e instanceof LlmError ? e.kind : "other";
    }
    assertEquals(kind, "not_configured");
  }
  // The Anthropic adapter is a documented stub: configured, it still refuses to run.
  const c = resolveProvider(env({ ASSISTANT_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", ASSISTANT_MODEL: "claude-haiku-4-5" }));
  assertEquals((await failure(c.provider.stream(request()))).kind, "not_configured");
});

Deno.test("pricing: known models, dated snapshots, cached input, conservative default", () => {
  assertEquals(costMicroUsd("gpt-5.4-mini", { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0 }), 750_000);
  assertEquals(costMicroUsd("gpt-5.4-mini-2026-03-17", { inputTokens: 1000, outputTokens: 50, cachedInputTokens: 0 }), 975);
  assertEquals(costMicroUsd("gpt-5.4-mini", { inputTokens: 1200, outputTokens: 9, cachedInputTokens: 1024 }), Math.ceil(176 * 0.75 + 1024 * 0.075 + 9 * 4.5));
  assertEquals(priceFor("some-new-model").known, false);
  assert(costMicroUsd("some-new-model", { inputTokens: 1000, outputTokens: 1000, cachedInputTokens: 0 }) >= 60_000);
});
