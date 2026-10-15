import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAssistantTransport, setMailApi } from "../index";
import type { ApprovalDraft } from "../assistant-api";
import type { AssistantAllowance, MessageKey } from "../types";
import { resetRouterForTests } from "../../app/router";
import { keys } from "../../data/keys";
import { queryClient } from "../../data/query-client";
import { clearUndo } from "../../data/undo";
import { LEAVING_MS, useAssistantStore } from "../../state/assistant-store";
import { useComposeStore } from "../../state/compose-store";
import { useSelectionStore } from "../../state/selection-store";
import { useToastStore } from "../../state/toast-store";
import { useUiStore } from "../../state/ui-store";
import { ApiClient } from "./client";
import { FakeBackend, fakeInbox, fakeMessage } from "./fake-backend";
import { HttpAssistantTransport } from "./http-assistant";
import { HttpMailApi } from "./http-mail-api";

/* The REAL engine's output, through the real transport, into the real store.
 *
 * `fixtures/*.sse` are the response bytes of the server's assistant handler
 * (supabase/functions/client-api/assistant/testing/fixtures.ts runs the real
 * loop and records them; a deno test there fails when they go stale). These
 * tests replay those bytes and assert what the person ends up seeing. */

// Vitest runs from apps/client.
const at = (file: string) => resolve(process.cwd(), "src/api/http/fixtures", file);
const fixture = (name: string) => readFileSync(at(`${name}.sse`), "utf8");
const request = (name: string) =>
  JSON.parse(readFileSync(at(`${name}.request.json`), "utf8")) as {
    text: string;
    context: { keys: { inbox_id: string; message_id: string; folder?: string }[] };
  };

const INBOX = "inbox-a";
const k = (id: string) => `${INBOX}:${id}` as MessageKey;
const A = () => useAssistantStore.getState();
const compose = () => useComposeStore.getState().compose;

let backend: FakeBackend;
let transport: HttpAssistantTransport;
let sent: ApprovalDraft[];
let remaps: { key: MessageKey; new_key: MessageKey }[][];

function lastRunBody(): { context: { keys: unknown[]; notes?: unknown[]; timezone?: string } } {
  return backend.requests.filter((r) => r.path === "/assistant/run").at(-1)?.body as never;
}

/** Replays one recorded run with the request it was recorded for. */
async function replay(name: string): Promise<void> {
  backend.assistantChunks = [fixture(name)];
  const req = request(name);
  await A().run(req.text, { keys: req.context.keys.map((x) => k(x.message_id)) });
}

beforeEach(() => {
  backend = new FakeBackend([fakeInbox(INBOX, "ada@northwind.example", "imap")]);
  backend.renumberOnMove = true;
  backend.customFolders.set(INBOX, [{ id: "Receipts", name: "Receipts", type: "folder", total_messages: 0, unread_messages: 0 }]);
  for (const id of ["m1", "m5", "m6"]) backend.add(INBOX, fakeMessage(id, "2026-10-02T09:00:00Z"));
  const client = new ApiClient({
    baseUrl: "https://api.test/client-api",
    getToken: async () => "tok-1",
    refreshToken: async () => null,
    fetch: backend.fetch,
    sleep: async () => {},
  });
  const mail = new HttpMailApi({ client });
  sent = [];
  remaps = [];
  transport = new HttpAssistantTransport({
    client,
    sendApproved: (d) => void sent.push(d),
    moveMessages: (keys, to) => mail.moveMessages(keys, to),
    setFlags: (keys, flags) => mail.setFlags(keys, flags),
    onMoved: (pairs) => remaps.push(pairs),
    folderOf: () => "INBOX",
  });
  setMailApi(mail);
  setAssistantTransport(transport);
  queryClient.clear();
  clearUndo();
  window.history.replaceState({}, "", "/");
  resetRouterForTests();
  useUiStore.setState({ viewport: "desktop", screen: "list", menu: null, listHover: false, panelOpen: true, chatFull: false });
  useSelectionStore.setState({ scope: "all", folder: { role: "inbox" }, query: "", selectedKey: null, multiSel: [], ctxOff: false });
  useComposeStore.setState({ compose: null });
  useToastStore.getState().dismiss();
  A().reset();
  useAssistantStore.setState({ busy: false, runId: null, turn: 0 });
});

afterEach(() => {
  setMailApi(null);
  setAssistantTransport(null);
  vi.useRealTimers();
});

/** Nothing is left spinning, streaming or "running" once a run is over. */
function expectSettled(): void {
  const s = A();
  expect(s.busy).toBe(false);
  expect(s.status).toBe("");
  expect(s.progress).toBeNull();
  expect(s.messages.filter((m) => m.streaming)).toEqual([]);
  expect(s.messages.flatMap((m) => m.calls).filter((c) => c.state === "running" || c.state === "held")).toEqual([]);
}

describe("recorded engine runs", () => {
  it("read-and-answer: the attached email is pre-read, the answer lands, each context key carries its folder", async () => {
    await replay("read-and-answer");
    expectSettled();
    const s = A();
    expect(s.runId).toBe("run_t");
    const calls = s.messages.flatMap((m) => m.calls);
    expect(calls.map((c) => [c.tool, c.state, c.keys])).toEqual([["email_read", "done", [k("m1")]]]);
    expect(s.messages.at(-1)?.text).toContain("keep 40 seats or drop to 30");
    expect(s.aiTouch).toEqual({});
    expect(s.conversations[s.conversationId]).toMatchObject({ v: 1 });
    expect(s.lastSummary).toBeNull();
    // The wire request is the one the capture was made with: keys as objects, with the folder.
    expect(lastRunBody().context.keys).toEqual(request("read-and-answer").context.keys);
    expect(typeof lastRunBody().context.timezone).toBe("string");
  });

  it("move-receipts: rows follow the new ids, and Undo moves them back under those ids", async () => {
    // Where the engine's mailbox left them: in Receipts, under new ids.
    backend.add(INBOX, fakeMessage("m2-in-receipts", "2026-10-01T16:40:00Z", { folder: "Receipts" }), fakeMessage("m3-in-receipts", "2026-10-01T08:05:00Z", { folder: "Receipts" }));
    vi.useFakeTimers();
    const run = replay("move-receipts");
    await vi.runAllTimersAsync();
    await run;
    vi.advanceTimersByTime(LEAVING_MS + 10);
    expectSettled();
    const s = A();
    expect(remaps).toEqual([[{ key: k("m2"), new_key: k("m2-in-receipts") }, { key: k("m3"), new_key: k("m3-in-receipts") }]]);
    expect(Object.keys(s.ghosts).sort()).toEqual([k("m2"), k("m3")]);
    expect(s.ghosts[k("m2")]).toMatchObject({ from: { inbox_id: INBOX, folder_id: "INBOX" }, to: { inbox_id: INBOX, folder_id: "Receipts" }, run_id: "run_t" });
    expect(s.lastSummary).toEqual({ text: "Moved 2 emails to Receipts", undoable: true, run_id: "run_t" });
    expect(s.messages.at(-1)?.chips).toEqual([{ kind: "folder", folder: { inbox_id: INBOX, folder_id: "Receipts" }, label: "Receipts", sub: "2 moved" }]);

    vi.useRealTimers();
    await A().undoRun();
    const moves = backend.calls("move");
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ inbox_id: INBOX, args: { message_ids: ["m2-in-receipts", "m3-in-receipts"], destination_folder_id: "INBOX" } });
    expect((backend.messages.get(INBOX) ?? []).filter((m) => m.folder === "INBOX" && /^m[23]-in-receipts~/.test(m.id))).toHaveLength(2);
    expect(A().ghosts).toEqual({});
    expect(A().lastSummary).toBeNull();
    // Back in the inbox under yet another id: the client was told.
    expect(remaps.at(-1)?.map((p) => p.key)).toEqual([k("m2-in-receipts"), k("m3-in-receipts")]);
  });

  it("archive-attached: the move of an attached email is undoable because its folder went with the request", async () => {
    backend.add(INBOX, fakeMessage("m6-in-archive", "2026-09-29T10:02:00Z", { folder: "Archive" }));
    await replay("archive-attached");
    expectSettled();
    expect(request("archive-attached").context.keys[0]?.folder).toBe("INBOX");
    expect(A().lastSummary).toEqual({ text: "Archived 1 email", undoable: true, run_id: "run_t" });
    await A().undoRun();
    expect(backend.calls("move")[0]).toMatchObject({ args: { message_ids: ["m6-in-archive"], destination_folder_id: "INBOX" } });
  });

  it("draft-and-request-send: the run ends with the send held; approving sends that draft and tells the next run", async () => {
    await replay("draft-and-request-send");
    const s = A();
    // The run is over, the request for approval is not.
    expect(s.busy).toBe(false);
    expect(s.status).toBe("");
    expect(s.messages.filter((m) => m.streaming)).toEqual([]);
    const c = compose();
    expect(c).toMatchObject({
      mode: "reply",
      inbox_id: INBOX,
      replyTo: k("m1"),
      to: "maya@lumenworks.example",
      cc: "tomas@northwind.example",
      subject: "Re: Q4 renewal terms",
      body: "Hi Maya,\n\nWe will keep the 40 seats.\n\nBest,\nAda",
      streaming: null,
      held: { approval_id: "run_t_ap1", external: true },
    });
    const calls = s.messages.flatMap((m) => m.calls);
    expect(calls.map((x) => [x.tool, x.state])).toEqual([["email_read", "done"], ["draft", "done"], ["email_compose", "waiting"]]);
    expect(s.aiTouch[k("m1")]).toMatchObject({ tool: "email_compose", state: "waiting" });
    expect(s.messages.at(-1)?.text).toContain("Nothing is sent until you approve it");

    await A().resolveApproval("approve");
    expect(sent).toEqual([
      { inbox_id: INBOX, to: "maya@lumenworks.example", subject: "Re: Q4 renewal terms", body: "Hi Maya,\n\nWe will keep the 40 seats.\n\nBest,\nAda", kind: "reply", cc: "tomas@northwind.example", reply_to: k("m1") },
    ]);
    expect(compose()?.held).toBeUndefined();
    expect(A().messages.flatMap((m) => m.calls).find((x) => x.tool === "email_compose")).toMatchObject({ state: "done", meta: "approved" });
    expect(A().aiTouch).toEqual({});

    await replay("read-and-answer");
    expect(lastRunBody().context.notes).toEqual([{ type: "approval", approval_id: "run_t_ap1", decision: "approved" }]);
  });

  it("draft-and-request-send: asking something else instead is a denial, and the waiting call is closed", async () => {
    await replay("draft-and-request-send");
    await replay("read-and-answer");
    expect(sent).toEqual([]);
    expect(lastRunBody().context.notes).toEqual([{ type: "approval", approval_id: "run_t_ap1", decision: "rejected" }]);
    expect(compose()?.held).toBeUndefined();
    const call = A().messages.flatMap((m) => m.calls).find((x) => x.tool === "email_compose");
    expect(call).toMatchObject({ state: "cancelled", meta: "not sent" });
    expect(A().aiTouch).toEqual({});
    expectSettled();
  });

  it("edit-draft: the diff is shown and then replaced by the final body, with nothing left streaming", async () => {
    useComposeStore.getState().open({
      mode: "reply",
      inbox_id: INBOX,
      replyTo: k("m1"),
      to: "maya@lumenworks.example",
      subject: "Re: Q4 renewal terms",
      body: "Hi Maya,\n\nWe will keep the 40 seats.\n\nBest,\nAda",
    });
    const seen: (string | null | undefined)[] = [];
    const off = useComposeStore.subscribe((st) => seen.push(st.compose?.streaming));
    await replay("edit-draft");
    off();
    expectSettled();
    expect(seen).toContain("editing");
    expect(compose()).toMatchObject({ body: "Hi Maya,\n\nWe keep 40 seats.\n\nAda", streaming: null, ai: true });
    expect(compose()?.segments).toBeUndefined();
    expect(A().messages.flatMap((m) => m.calls).map((x) => [x.tool, x.action, x.state])).toEqual([["draft", "edit", "done"]]);
  });

  it("error-after-change: one error bubble that can be retried, and the `done` that follows keeps the undo and the conversation", async () => {
    backend.add(INBOX, fakeMessage("m4-in-archive", "2026-09-30T06:00:00Z", { folder: "Archive" }));
    await replay("error-after-change");
    expectSettled();
    const s = A();
    const errors = s.messages.filter((m) => m.text === "The assistant could not finish. Try again.");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.retryable).toBe(true);
    expect(s.messages.filter((m) => m.text.includes("Stopped"))).toEqual([]);
    expect(s.allowanceBlocked).toBe(false);
    // What had already changed can still be undone.
    expect(s.lastSummary).toEqual({ text: "Archived 1 email", undoable: true, run_id: "run_t" });
    expect(s.conversations[s.conversationId]).toMatchObject({ v: 1 });
    expect(s.messages.flatMap((m) => m.calls).map((x) => x.state)).toEqual(["done", "done"]);
    await A().undoRun();
    expect(backend.calls("move")[0]).toMatchObject({ args: { message_ids: ["m4-in-archive"], destination_folder_id: "INBOX" } });

    // "Try again" asks the same thing again, without a second user bubble.
    backend.assistantChunks = [fixture("read-and-answer")];
    const before = A().messages.filter((m) => m.role === "user").length;
    await A().retry();
    expect(A().messages.filter((m) => m.role === "user")).toHaveLength(before);
    expect(backend.requests.filter((r) => r.path === "/assistant/run")).toHaveLength(2);
    expect(A().messages.some((m) => m.retryable)).toBe(false);
  });

  it("allowance-exhausted: an inline state with the reset date, not a chat bubble, and nothing to retry", async () => {
    queryClient.setQueryData<AssistantAllowance>(keys.allowance, {
      plan: "free",
      used: 19,
      cap: 20,
      remaining: 1,
      period_start: "2026-10-01T00:00:00Z",
      resets_at: "2026-10-31T00:00:00Z",
    });
    await replay("allowance-exhausted");
    expectSettled();
    const s = A();
    expect(s.allowanceBlocked).toBe(true);
    expect(s.messages.filter((m) => m.role === "assistant")).toEqual([]);
    expect(queryClient.getQueryData<AssistantAllowance>(keys.allowance)).toMatchObject({ used: 20, remaining: 0, resets_at: "2026-11-01T00:00:00Z" });
    expect(backend.requests.filter((r) => r.path === "/assistant/run")).toHaveLength(1);
  });

  it("stopped-max-rounds: the engine's own sentence is shown and the reason is kept", async () => {
    await replay("stopped-max-rounds");
    expectSettled();
    expect(A().lastStopped).toBe("max_rounds");
    expect(A().messages.at(-1)?.text).toContain("too many steps");
    expect(A().messages.some((m) => m.retryable)).toBe(false);
  });
});
