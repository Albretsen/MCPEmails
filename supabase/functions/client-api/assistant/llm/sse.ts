/* Server-sent events reader for provider streams.
 *
 * Network chunks split anywhere: in the middle of a line, of a UTF-8 sequence,
 * or between the "\r" and "\n" of a line ending. Bytes go through a streaming
 * TextDecoder and lines are only consumed once their terminator has arrived.
 */

export interface SseMessage {
  /** The `event:` field, or "message" when absent. */
  event: string;
  data: string;
}

export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseMessage, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parser = new SseParser();
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      if (value) yield* parser.push(decoder.decode(value, { stream: true }));
    }
    yield* parser.push(decoder.decode());
    yield* parser.flush();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.cancel().catch(() => {});
  }
}

/** Incremental parser over decoded text. Exported for tests. */
export class SseParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];

  *push(text: string): Generator<SseMessage, void, undefined> {
    this.buffer += text;
    while (true) {
      const line = this.takeLine();
      if (line === null) return;
      const msg = this.line(line);
      if (msg) yield msg;
    }
  }

  /** End of stream: a final unterminated line and block still count. */
  *flush(): Generator<SseMessage, void, undefined> {
    if (this.buffer.length) {
      const rest = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = "";
      const msg = this.line(rest);
      if (msg) yield msg;
    }
    const msg = this.dispatch();
    if (msg) yield msg;
  }

  /** Next complete line without its terminator, or null if none is complete. */
  private takeLine(): string | null {
    const b = this.buffer;
    for (let i = 0; i < b.length; i++) {
      const c = b.charCodeAt(i);
      if (c === 10) {
        this.buffer = b.slice(i + 1);
        return b.slice(0, i);
      }
      if (c === 13) {
        // A lone "\r" at the very end may be half of "\r\n": wait for more.
        if (i === b.length - 1) return null;
        this.buffer = b.slice(b.charCodeAt(i + 1) === 10 ? i + 2 : i + 1);
        return b.slice(0, i);
      }
    }
    return null;
  }

  private line(line: string): SseMessage | null {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    return null;
  }

  private dispatch(): SseMessage | null {
    if (!this.data.length) {
      this.event = "";
      return null;
    }
    const msg = { event: this.event || "message", data: this.data.join("\n") };
    this.event = "";
    this.data = [];
    return msg;
  }
}
