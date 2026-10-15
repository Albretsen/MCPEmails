import { describe, expect, it, vi } from "vitest";
import type { AssistantEvent } from "../assistant-api";
import type { FolderRef, MessageFlags, MessageKey } from "../types";
import { ApiClient } from "./client";
import { FakeBackend, fakeMessage } from "./fake-backend";
import { HttpAssistantTransport, normalizeAssistantEvent } from "./http-assistant";
import { HttpMailApi } from "./http-mail-api";

function setup() {
  const backend = new FakeBackend();
  const client = new ApiClient({
    baseUrl: "https://api.test/client-api",
    getToken: async () => "tok-1",
    refreshToken: async () => null,
    fetch: backend.fetch,
    sleep: async () => {},
  });
  const mail = new HttpMailApi({ client });
  const sent: unknown[] = [];
  const remapped: { key: MessageKey; new_key: MessageKey }[][] = [];
  const flagged: { keys: MessageKey[]; flags: MessageFlags }[] = [];
  const moves: { keys: MessageKey[]; to: FolderRef }[] = [];
  const sendApproved = vi.fn((draft: unknown) => {
    sent.push(draft);
  });
  const transport = new HttpAssistantTransport({
    client,
    sendApproved,
    moveMessages: (keys, to) => {
      moves.push({ keys, to });
      return mail.moveMessages(keys, to);
    },
    setFlags: async (keys, flags) => {
      flagged.push({ keys, flags });
      await mail.setFlags(keys, flags);
    },
    onMoved: (pairs) => remapped.push(pairs),
  });
  return { backend, transport, mail, sent, sendApproved, remapped, flagged, moves };
}

async function collect(stream: AsyncIterable<AssistantEvent>): Promise<AssistantEvent[]> {
  const out: AssistantEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

const request = (text: string, extra: Record<string, unknown> = {}) => ({ text, context: { keys: [] as MessageKey[] }, conversation_id: "c1", ...extra });
const live = () => new AbortController().signal;
const lastBody = (backend: FakeBackend) => backend.requests.filter((r) => r.path === "/assistant/run").at(-1)?.body as { context: Record<string, unknown> };

describe("HttpAssistantTransport: stream", () => {
  it("posts the request and maps the event stream", async () => {
    const { backend, transport } = setup();
    backend.assistantEvents = [
      { type: "run_started", run_id: "r1" },
      { type: "status", text: "Reading" },
      { type: "tool_call", message_id: "m", call: { id: "c1", tool: "email_read", human: "Reading", state: "running", keys: [{ inbox_id: "a", message_id: "m1" }] } },
      { type: "text_delta", message_id: "m", delta: "Hello", done: true },
      { type: "done", conversation: { turns: 1 }, summary: { text: "Read 1 email", undoable: false } },
    ];
    const events = await collect(transport.run(request("hi", { context: { keys: ["a:m1"] }, conversation: { turns: 0 } }), { signal: live() }));
    expect(events.map((e) => e.type)).toEqual(["run_started", "status", "tool_call", "text_delta", "done"]);
    const call = events[2];
    expect(call?.type === "tool_call" && call.call.keys).toEqual(["a:m1"]);
    expect(events[4]).toMatchObject({ type: "done", conversation: { turns: 1 } });
    const req = backend.requests.at(-1);
    expect(req?.headers.accept).toBe("text/event-stream");
    expect(req?.body).toMatchObject({ text: "hi", context: { keys: [{ inbox_id: "a", message_id: "m1" }] }, conversation: { turns: 0 } });
  });

  it("parses a stream cut at awkward places, with keep-alives", async () => {
    const { backend, transport } = setup();
    backend.assistantChunks = [
      ": connected\n\n",
      'data: {"type":"run_',
      'started","run_id":"r1"}\n',
      "\n: ping\n\ndata: {\"type\":\"text_delta\",\"message_id\":\"m\",",
      '"delta":"Hi"}\r\n\r\ndata: not json\n\ndata: {"type":"mystery"}\n\ndata: {"type":"done"}\n\n',
    ];
    const events = await collect(transport.run(request("hi"), { signal: live() }));
    expect(events.map((e) => e.type)).toEqual(["run_started", "text_delta", "done"]);
  });

  it("stops promptly when aborted mid-stream", async () => {
    const { backend, transport } = setup();
    backend.assistantEvents = [{ type: "run_started", run_id: "r1" }, { type: "text_delta", message_id: "m", delta: "a" }, { type: "done" }];
    const abort = new AbortController();
    const seen: string[] = [];
    for await (const e of transport.run(request("hi"), { signal: abort.signal })) {
      seen.push(e.type);
      abort.abort();
    }
    expect(seen).toEqual(["run_started"]);
  });

  it("reports a stream that ends without done as an error, once", async () => {
    const { backend, transport } = setup();
    backend.assistantEvents = [{ type: "run_started", run_id: "r1" }];
    const events = await collect(transport.run(request("hi"), { signal: live() }));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "interrupted" });
  });

  it("allowance exhausted is one typed error and nothing is retried", async () => {
    const { backend, transport } = setup();
    backend.assistantError = { status: 402, error: { code: "allowance_exhausted", message: "cap reached", retryable: false } };
    const events = await collect(transport.run(request("hi"), { signal: live() }));
    expect(events).toEqual([{ type: "error", code: "allowance_exhausted", message: "You have used this month's assistant allowance." }]);
    expect(backend.count("/assistant/run")).toBe(1);
  });

  it("never retries a failed run, even when the error is retryable", async () => {
    const { backend, transport } = setup();
    backend.assistantError = { status: 429, error: { code: "rate_limited", message: "slow down", retryable: true } };
    const events = await collect(transport.run(request("hi"), { signal: live() }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", code: "rate_limited" });
    expect(backend.count("/assistant/run")).toBe(1);
  });
});

describe("HttpAssistantTransport: approval", () => {
  const approval = {
    type: "approval_required",
    approval_id: "ap1",
    call_id: "c9",
    external: true,
    draft: { inbox_id: "a", to: "maya@example.com", subject: "Re: Hi", body: "Sounds good.", reply_to: { inbox_id: "a", message_id: "m1" } },
  };

  it("approve sends as the human, and the next run is told", async () => {
    const { backend, transport, sendApproved } = setup();
    backend.assistantEvents = [{ type: "run_started", run_id: "r1" }, approval, { type: "done", conversation: 1 }];
    const events = await collect(transport.run(request("reply"), { signal: live() }));
    const ev = events.find((e) => e.type === "approval_required");
    expect(ev?.type === "approval_required" && ev.draft.reply_to).toBe("a:m1");
    // The server sent nothing and was asked nothing else.
    expect(backend.delivered).toHaveLength(0);
    expect(sendApproved).not.toHaveBeenCalled();

    await transport.resolveApproval("ap1", "approve");
    expect(sendApproved).toHaveBeenCalledTimes(1);
    expect(sendApproved.mock.calls[0]?.[0]).toMatchObject({ to: "maya@example.com", body: "Sounds good.", reply_to: "a:m1" });
    // Only /assistant/run was ever called: approval is not a server round trip.
    expect(backend.requests.every((r) => r.path === "/assistant/run")).toBe(true);

    backend.assistantEvents = [{ type: "run_started", run_id: "r2" }, { type: "done" }];
    await collect(transport.run(request("thanks"), { signal: live() }));
    expect(lastBody(backend).context).toMatchObject({ keys: [], notes: [{ type: "approval", approval_id: "ap1", decision: "approved" }] });
    // The person's time zone rides along, so "tomorrow morning" is theirs.
    expect(typeof lastBody(backend).context.timezone).toBe("string");
    // Told once.
    await collect(transport.run(request("again"), { signal: live() }));
    expect(lastBody(backend).context.notes).toBeUndefined();
  });

  it("reject and edit are local and never send", async () => {
    const { backend, transport, sendApproved } = setup();
    for (const [decision, note] of [
      ["reject", "rejected"],
      ["edit", "edited"],
    ] as const) {
      backend.assistantEvents = [{ type: "run_started", run_id: "r" }, { ...approval, approval_id: `ap-${decision}` }, { type: "done" }];
      await collect(transport.run(request("reply"), { signal: live() }));
      await transport.resolveApproval(`ap-${decision}`, decision);
      backend.assistantEvents = [{ type: "run_started", run_id: "r" }, { type: "done" }];
      await collect(transport.run(request("ok"), { signal: live() }));
      expect(lastBody(backend).context).toMatchObject({ notes: [{ type: "approval", approval_id: `ap-${decision}`, decision: note }] });
    }
    expect(sendApproved).not.toHaveBeenCalled();
    expect(backend.delivered).toHaveLength(0);
  });

  it("fails closed: an unknown approval is not sent, an unanswered one counts as rejected", async () => {
    const { backend, transport, sendApproved } = setup();
    await expect(transport.resolveApproval("nope", "approve")).rejects.toThrow();
    expect(sendApproved).not.toHaveBeenCalled();

    backend.assistantEvents = [{ type: "run_started", run_id: "r1" }, approval, { type: "done" }];
    await collect(transport.run(request("reply"), { signal: live() }));
    backend.assistantEvents = [{ type: "run_started", run_id: "r2" }, { type: "done" }];
    await collect(transport.run(request("something else"), { signal: live() }));
    expect(lastBody(backend).context).toMatchObject({ notes: [{ approval_id: "ap1", decision: "rejected" }] });
    await expect(transport.resolveApproval("ap1", "approve")).rejects.toThrow();
    expect(sendApproved).not.toHaveBeenCalled();
  });

  it("a send that cannot be queued is reported as not approved", async () => {
    const { backend, transport, sendApproved } = setup();
    sendApproved.mockImplementationOnce(() => {
      throw new Error("no recipient");
    });
    backend.assistantEvents = [{ type: "run_started", run_id: "r1" }, approval, { type: "done" }];
    await collect(transport.run(request("reply"), { signal: live() }));
    await expect(transport.resolveApproval("ap1", "approve")).rejects.toThrow("no recipient");
    backend.assistantEvents = [{ type: "run_started", run_id: "r2" }, { type: "done" }];
    await collect(transport.run(request("ok"), { signal: live() }));
    expect(lastBody(backend).context).toMatchObject({ notes: [{ approval_id: "ap1", decision: "rejected" }] });
  });
});

describe("HttpAssistantTransport: undo", () => {
  it("moves messages back under the ids they have now and flips flags back", async () => {
    const { backend, transport, moves, flagged, remapped } = setup();
    backend.renumberOnMove = true;
    backend.add("a", fakeMessage("m1", "2026-10-02T10:00:00Z"), fakeMessage("m2", "2026-10-01T10:00:00Z"));
    // What the server's tool layer did during the run.
    const archived = backend.call({ op: "archive", inbox_id: "a", args: { message_ids: ["m1"] } }) as { results: { new_message_id: string }[] };
    const newId = archived.results[0]?.new_message_id ?? "";
    backend.call({ op: "flag", inbox_id: "a", args: { message_ids: ["m2"], read: true } });
    backend.assistantEvents = [
      { type: "run_started", run_id: "r1" },
      { type: "mail_effect", effect: { kind: "moved", keys: ["a:m1"], new_keys: [`a:${newId}`], from: { role: "inbox" }, to: { role: "archive" }, call_id: "c1" } },
      { type: "mail_effect", effect: { kind: "flagged", keys: [{ inbox_id: "a", message_id: "m2" }], flags: { read: true }, call_id: "c2" } },
      { type: "mail_effect", effect: { kind: "read", keys: ["a:m2"], call_id: "c3" } },
      { type: "done", summary: { text: "Archived 1", undoable: true } },
    ];
    await collect(transport.run(request("tidy"), { signal: live() }));
    // The move's new id was announced so the client can follow it.
    expect(remapped[0]).toEqual([{ key: "a:m1", new_key: `a:${newId}` }]);

    await transport.undo("r1");
    expect(flagged).toEqual([{ keys: ["a:m2"], flags: { read: false } }]);
    expect(moves).toEqual([{ keys: [`a:${newId}`], to: { role: "inbox" } }]);
    const inbox = (backend.messages.get("a") ?? []).filter((m) => m.folder === "INBOX");
    expect(inbox).toHaveLength(2);
    expect(inbox.find((m) => m.id.startsWith("m2"))?.is_read).toBe(false);
    // Back in the inbox under a third id: announced as well.
    expect(remapped[1]?.[0]?.key).toBe(`a:${newId}`);
    // A run is undone once.
    await transport.undo("r1");
    expect(moves).toHaveLength(1);
  });

  it("says so when a move cannot be reversed", async () => {
    const { backend, transport } = setup();
    backend.assistantEvents = [
      { type: "run_started", run_id: "r1" },
      { type: "mail_effect", effect: { kind: "moved", keys: ["a:m1"], to: { role: "trash" }, call_id: "c1" } },
      { type: "done" },
    ];
    await collect(transport.run(request("delete"), { signal: live() }));
    await expect(transport.undo("r1")).rejects.toThrow();
  });
});

describe("normalizeAssistantEvent", () => {
  it("drops what it does not know", () => {
    expect(normalizeAssistantEvent(null)).toBeNull();
    expect(normalizeAssistantEvent({ type: "telemetry" })).toBeNull();
    expect(normalizeAssistantEvent({ type: "tool_call" })).toBeNull();
  });

  it("ignores new_keys that do not line up with keys", () => {
    const ev = normalizeAssistantEvent({ type: "mail_effect", effect: { kind: "moved", keys: ["a:1", "a:2"], new_keys: ["a:9"], call_id: "c" } });
    expect(ev?.type === "mail_effect" && ev.effect.new_keys).toBeUndefined();
  });
});
