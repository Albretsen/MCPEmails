/* POST /assistant/run: the HTTP face of the assistant.
 *
 * client-api's router calls `handleAssistantRun` after auth, the workspace
 * gate and its rate limiter. This module parses the body, starts the loop and
 * serialises its events as server-sent events: one `data: <json>` line per
 * AssistantEvent, plus `: ping` comment lines every few seconds so proxies
 * keep an idle stream open (SSE clients ignore comment lines).
 *
 * The response starts streaming before any model or mailbox work: the first
 * two events (`run_started`, `status`) are queued synchronously.
 */

import type { AssistantDeps } from "./deps.ts";
import type { AssistantEvent } from "./events.ts";
import { runAssistant, type RunOptions } from "./loop.ts";
import { MAX_BODY_BYTES, parseRunRequest } from "./request.ts";

export type { AssistantDeps } from "./deps.ts";
export type { AssistantEvent } from "./events.ts";
export { runAssistant } from "./loop.ts";

const PING_MS = 10_000;

const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
};

/** Test seam: everything `RunOptions` accepts except the wiring this module owns. */
export type HandlerOverrides = Omit<RunOptions, "signal" | "emit">;

export async function handleAssistantRun(
  req: Request,
  deps: AssistantDeps,
  overrides: HandlerOverrides = {},
): Promise<Response> {
  const body = await readJson(req);
  const inboxIds = new Set(deps.inboxes.map((i) => i.inbox_id));
  const parsed = body.ok ? parseRunRequest(body.value, inboxIds) : { ok: false as const, reason: body.reason };
  if (!parsed.ok) {
    safeLog(deps, "assistant_bad_request", { reason: parsed.reason });
    return new Response(
      JSON.stringify({ error: { code: "invalid_request", message: "The assistant request was not valid.", retryable: false } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  const input = parsed.input;

  const abort = new AbortController();
  const onRequestAbort = () => abort.abort();
  if (req.signal.aborted) abort.abort();
  else req.signal.addEventListener("abort", onRequestAbort, { once: true });

  const encoder = new TextEncoder();
  let closed = false;
  let ping: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // The consumer went away between our check and the write.
          closed = true;
          abort.abort();
        }
      };
      const emit = (event: AssistantEvent) => write(`data: ${JSON.stringify(event)}\n\n`);
      ping = setInterval(() => write(": ping\n\n"), PING_MS);

      runAssistant(input, deps, { ...overrides, signal: abort.signal, emit })
        .catch(() => {
          // runAssistant reports its own failures; this guards a bug in it.
          emit({ type: "error", message: "The assistant could not finish. Try again.", code: "provider_error", retryable: true });
        })
        .finally(() => {
          clearInterval(ping);
          req.signal.removeEventListener("abort", onRequestAbort);
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              // Already closed by a cancel.
            }
          }
        });
    },
    cancel() {
      // The client disconnected or stopped reading: stop working at once.
      closed = true;
      clearInterval(ping);
      abort.abort();
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

async function readJson(req: Request): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { ok: false, reason: "body_too_large" };
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false, reason: "body_unreadable" };
  }
  if (text.length > MAX_BODY_BYTES) return { ok: false, reason: "body_too_large" };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "body_not_json" };
  }
}

function safeLog(deps: AssistantDeps, event: string, fields: Record<string, unknown>): void {
  try {
    deps.log(event, fields);
  } catch {
    // Logging must never affect a request.
  }
}
