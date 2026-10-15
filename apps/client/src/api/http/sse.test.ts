import { describe, expect, it } from "vitest";
import { type SseMessage, createSseParser, readSse } from "./sse";

function parseAll(chunks: string[]): SseMessage[] {
  const out: SseMessage[] = [];
  const p = createSseParser((m) => out.push(m));
  for (const c of chunks) p.push(c);
  p.end();
  return out;
}

function streamOf(chunks: (string | Uint8Array)[], opts: { keepOpen?: boolean } = {}): { body: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  const enc = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
      if (!opts.keepOpen) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, cancelled: () => cancelled };
}

describe("SSE parser", () => {
  it("parses one event per blank line", () => {
    expect(parseAll(['data: {"a":1}\n\n', 'data: {"b":2}\n\n'])).toEqual([
      { event: "message", data: '{"a":1}' },
      { event: "message", data: '{"b":2}' },
    ]);
  });

  it("survives a split at every possible position", () => {
    const text = 'event: note\ndata: {"type":"text_delta","delta":"héllo wörld"}\n\n: keep-alive\n\ndata: line one\ndata: line two\r\n\r\ndata: last\n\n';
    const whole = parseAll([text]);
    expect(whole).toEqual([
      { event: "note", data: '{"type":"text_delta","delta":"héllo wörld"}' },
      { event: "message", data: "line one\nline two" },
      { event: "message", data: "last" },
    ]);
    for (let i = 1; i < text.length; i++) expect(parseAll([text.slice(0, i), text.slice(i)])).toEqual(whole);
    // And one character at a time.
    expect(parseAll([...text])).toEqual(whole);
  });

  it("joins multi-line data with newlines and keeps empty data lines", () => {
    expect(parseAll(["data: a\ndata:\ndata: b\n\n"])).toEqual([{ event: "message", data: "a\n\nb" }]);
  });

  it("ignores comments, unknown fields and events without data", () => {
    expect(parseAll([": ping\n\n", "retry: 1000\n\n", "event: empty\n\n", "data: x\n\n"])).toEqual([{ event: "message", data: "x" }]);
  });

  it("handles CRLF, lone CR and a BOM", () => {
    expect(parseAll(["﻿data: a\r\n\r\ndata: b\r\rdata: c\n\n"])).toEqual([
      { event: "message", data: "a" },
      { event: "message", data: "b" },
      { event: "message", data: "c" },
    ]);
  });

  it("strips only one leading space of a value", () => {
    expect(parseAll(["data:  two spaces\n\n", "data:none\n\n"])).toEqual([
      { event: "message", data: " two spaces" },
      { event: "message", data: "none" },
    ]);
  });

  it("dispatches a final event that was not terminated", () => {
    expect(parseAll(["data: tail"])).toEqual([{ event: "message", data: "tail" }]);
  });
});

describe("readSse", () => {
  it("decodes a multi-byte character split across chunks", async () => {
    const bytes = new TextEncoder().encode("data: žluťoučký €\n\n");
    const cut = bytes.indexOf(0xe2); // inside the euro sign
    const { body } = streamOf([bytes.slice(0, cut + 1), bytes.slice(cut + 1)]);
    const out: SseMessage[] = [];
    for await (const m of readSse(body)) out.push(m);
    expect(out).toEqual([{ event: "message", data: "žluťoučký €" }]);
  });

  it("ends promptly on abort and cancels the stream", async () => {
    const { body, cancelled } = streamOf(["data: 1\n\n", "data: 2\n\n"], { keepOpen: true });
    const abort = new AbortController();
    const out: string[] = [];
    const done = (async () => {
      for await (const m of readSse(body, abort.signal)) {
        out.push(m.data);
        if (out.length === 2) abort.abort();
      }
    })();
    await done;
    expect(out).toEqual(["1", "2"]);
    expect(cancelled()).toBe(true);
  });

  it("yields nothing when already aborted", async () => {
    const { body } = streamOf(["data: 1\n\n"]);
    const abort = new AbortController();
    abort.abort();
    const out: SseMessage[] = [];
    for await (const m of readSse(body, abort.signal)) out.push(m);
    expect(out).toEqual([]);
  });

  it("an abort while waiting for the next chunk ends the iterator", async () => {
    const { body } = streamOf(["data: 1\n\n"], { keepOpen: true });
    const abort = new AbortController();
    const out: string[] = [];
    const done = (async () => {
      for await (const m of readSse(body, abort.signal)) out.push(m.data);
    })();
    await new Promise((r) => setTimeout(r, 10));
    abort.abort();
    await done;
    expect(out).toEqual(["1"]);
  });
});
