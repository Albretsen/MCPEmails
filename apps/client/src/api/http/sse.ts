/* A small Server-Sent Events parser for `fetch` streaming.
 *
 * Handles what real streams do: a chunk may end anywhere (mid line, mid
 * UTF-8 sequence, between the CR and LF of a CRLF), an event may carry
 * several `data:` lines, and servers send `:` comment lines as keep-alives.
 */

export interface SseMessage {
  /** The `event:` field, or "message". */
  event: string;
  /** All `data:` lines of the event joined with "\n". */
  data: string;
  id?: string;
}

export interface SseParser {
  push(text: string): void;
  /** End of stream: dispatches an event that was not terminated by a blank line. */
  end(): void;
}

export function createSseParser(onMessage: (m: SseMessage) => void): SseParser {
  let buffer = "";
  let data: string[] = [];
  let event = "";
  let id: string | undefined;
  let first = true;

  const dispatch = () => {
    if (data.length) onMessage({ event: event || "message", data: data.join("\n"), ...(id !== undefined ? { id } : {}) });
    data = [];
    event = "";
  };

  const line = (raw: string) => {
    if (raw === "") return dispatch();
    if (raw.startsWith(":")) return; // comment / keep-alive
    const i = raw.indexOf(":");
    const field = i < 0 ? raw : raw.slice(0, i);
    let value = i < 0 ? "" : raw.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id" && !value.includes("\u0000")) id = value;
  };

  const drain = (final: boolean) => {
    for (;;) {
      let end = -1;
      for (let i = 0; i < buffer.length; i++) {
        const c = buffer.charCodeAt(i);
        if (c === 10 || c === 13) {
          end = i;
          break;
        }
      }
      if (end < 0) break;
      const cr = buffer.charCodeAt(end) === 13;
      // A CR at the very end may be the first half of a CRLF: wait for more.
      if (cr && end === buffer.length - 1 && !final) break;
      const next = cr && buffer.charCodeAt(end + 1) === 10 ? end + 2 : end + 1;
      line(buffer.slice(0, end));
      buffer = buffer.slice(next);
    }
  };

  return {
    push(text) {
      if (first) {
        first = false;
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      }
      buffer += text;
      drain(false);
    },
    end() {
      drain(true);
      if (buffer) {
        line(buffer);
        buffer = "";
      }
      dispatch();
    },
  };
}

/** Reads an SSE body. Ends quietly (no throw) when `signal` aborts, and
 *  cancels the underlying stream so the server sees the disconnect. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseMessage, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const out: SseMessage[] = [];
  const parser = createSseParser((m) => out.push(m));
  const onAbort = () => void reader.cancel().catch(() => {});
  if (signal?.aborted) {
    onAbort();
    return;
  }
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (signal?.aborted) return;
        throw err;
      }
      if (signal?.aborted) return;
      if (chunk.done) break;
      parser.push(decoder.decode(chunk.value, { stream: true }));
      while (out.length) {
        const m = out.shift();
        if (m) yield m;
        if (signal?.aborted) return;
      }
    }
    parser.push(decoder.decode());
    parser.end();
    while (out.length) {
      const m = out.shift();
      if (m) yield m;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
  }
}
