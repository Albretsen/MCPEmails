import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAssistantTransport, setMailApi } from "../api";
import type { AssistantEvent, AssistantTransport } from "../api/assistant-api";
import { MockMailApi } from "../api/mock/mock-mail-api";
import { abortError, setLatency } from "../api/mock/latency";
import type { AssistantAllowance, MessagePage } from "../api/types";
import { resetRouterForTests } from "../app/router";
import { type ListData, findRow } from "../data/cache";
import { keys, listMeta } from "../data/keys";
import { archive, markRead, send, undoLast } from "../data/mail-actions";
import { queryClient } from "../data/query-client";
import { clearUndo } from "../data/undo";
import { FOLDER_BUMP_MS, useAssistantStore } from "./assistant-store";
import { useComposeStore } from "./compose-store";
import { neighbourAfterRemoval, setVisibleKeys, useSelectionStore } from "./selection-store";
import { useToastStore } from "./toast-store";
import { LAYOUT_STORAGE_KEY, useUiStore } from "./ui-store";

let api: MockMailApi;
const INBOX = keys.messages(listMeta("all", { role: "inbox" }));

async function primeInbox(): Promise<MessagePage> {
  const page = await api.listMessages({ scope: "all", folder: { role: "inbox" }, limit: 30 });
  queryClient.setQueryData<ListData>(INBOX, { pages: [page], pageParams: [null] });
  setVisibleKeys(page.rows.map((r) => r.key));
  return page;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeTransport(events: AssistantEvent[], opts: { hang?: boolean } = {}): AssistantTransport & { approvals: string[]; undone: string[] } {
  const t = {
    approvals: [] as string[],
    undone: [] as string[],
    async *run(_req: unknown, o: { signal: AbortSignal }) {
      for (const e of events) yield e;
      if (opts.hang) {
        await new Promise((_res, rej) => o.signal.addEventListener("abort", () => rej(abortError()), { once: true }));
      }
    },
    async resolveApproval(id: string, decision: string) {
      t.approvals.push(`${id}:${decision}`);
    },
    async undo(run_id: string) {
      t.undone.push(run_id);
    },
  };
  return t;
}

beforeEach(async () => {
  setLatency({ read: [0, 0], write: [0, 0], failWrites: false });
  api = new MockMailApi("pro");
  setMailApi(api);
  queryClient.clear();
  clearUndo();
  window.history.replaceState({}, "", "/");
  resetRouterForTests();
  useUiStore.setState({ viewport: "desktop", screen: "list", menu: null, listHover: false, panelOpen: true, chatFull: false });
  useSelectionStore.setState({ scope: "all", folder: { role: "inbox" }, query: "", selectedKey: null, multiSel: [], ctxOff: false });
  useComposeStore.setState({ compose: null });
  useToastStore.getState().dismiss();
  useAssistantStore.setState({
    messages: [], busy: false, status: "", progress: null, runId: null, aiTouch: {}, ghosts: {}, leaving: {}, fresh: {},
    labels: {}, lastTrace: {}, folderBump: {}, linkCall: null, linkEmail: null, hoverKeys: [], pendingNew: [], push: null,
    newBelow: false, lastSummary: null, holdNote: false,
  });
  await primeInbox();
});

afterEach(() => {
  setMailApi(null);
  setAssistantTransport(null);
  vi.useRealTimers();
});

describe("ui store", () => {
  it("persists pane widths under mc-layout-v1 and resets them", () => {
    useUiStore.getState().setPaneWidth("list", 412.6);
    expect(useUiStore.getState().listW).toBe(413);
    expect(JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? "{}")).toMatchObject({ listW: 413 });
    useUiStore.getState().resetLayout(["list"]);
    expect(useUiStore.getState().listW).toBeNull();
    expect(JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? "{}").listW).toBeNull();
  });

  it("toggles the panel on desktop and the full-screen dock on phone", () => {
    useUiStore.getState().togglePanel();
    expect(useUiStore.getState().panelOpen).toBe(false);
    useUiStore.setState({ viewport: "phone" });
    useUiStore.getState().togglePanel();
    expect(useUiStore.getState()).toMatchObject({ chatFull: true, panelOpen: false });
  });
});

describe("selection store", () => {
  it("selects synchronously and writes the URL (replace on desktop)", () => {
    const before = window.history.length;
    useSelectionStore.getState().select("outlook:maya");
    expect(useSelectionStore.getState().selectedKey).toBe("outlook:maya");
    expect(window.location.pathname).toBe("/all/inbox/outlook%3Amaya");
    expect(window.history.length).toBe(before);
  });

  it("pushes a history entry when a phone opens a message", () => {
    useUiStore.setState({ viewport: "phone" });
    const before = window.history.length;
    useSelectionStore.getState().select("outlook:maya");
    expect(window.history.length).toBe(before + 1);
    expect(useUiStore.getState().screen).toBe("reader");
  });

  it("steps through the visible list and clamps at the ends", () => {
    const s = useSelectionStore.getState();
    s.step(1);
    expect(useSelectionStore.getState().selectedKey).toBe("outlook:maya");
    s.step(1);
    expect(useSelectionStore.getState().selectedKey).toBe("gmail:stripe");
    s.step(-1);
    s.step(-1);
    expect(useSelectionStore.getState().selectedKey).toBe("outlook:maya");
  });

  it("builds a multi-selection from the open row and collapses it below two", () => {
    const s = useSelectionStore.getState();
    s.select("outlook:maya");
    s.toggleMulti("gmail:stripe");
    expect(useSelectionStore.getState().multiSel).toEqual(["outlook:maya", "gmail:stripe"]);
    s.toggleMulti("gmail:stripe");
    expect(useSelectionStore.getState().multiSel).toEqual([]);
  });

  it("opens folders and scopes, clearing search and selection", () => {
    const s = useSelectionStore.getState();
    s.select("outlook:maya");
    s.setQuery("renewal");
    expect(window.location.search).toBe("?q=renewal");
    s.openFolder({ name: "Receipts" });
    expect(useSelectionStore.getState()).toMatchObject({ query: "", selectedKey: null, folder: { name: "Receipts" } });
    expect(window.location.pathname + window.location.search).toBe("/all/name%3AReceipts");
    s.setScope("gmail");
    expect(useSelectionStore.getState()).toMatchObject({ scope: "gmail", folder: { role: "inbox" } });
  });

  it("picks the next row, else the previous, after a removal", () => {
    expect(neighbourAfterRemoval(["outlook:maya"], "outlook:maya")).toBe("gmail:stripe");
    expect(neighbourAfterRemoval(["gmail:stripe"], "outlook:maya")).toBe("outlook:maya");
    setVisibleKeys(["a:1", "a:2"]);
    expect(neighbourAfterRemoval(["a:2"], "a:2")).toBe("a:1");
    expect(neighbourAfterRemoval(["a:1", "a:2"], "a:2")).toBeNull();
  });
});

describe("toast store", () => {
  it("shows one toast at a time, dismisses after 5 s, pauses on hover", () => {
    vi.useFakeTimers();
    const t = useToastStore.getState();
    t.show("one");
    t.show({ text: "two" });
    expect(useToastStore.getState().toast?.text).toBe("two");
    vi.advanceTimersByTime(4000);
    t.pause();
    vi.advanceTimersByTime(10_000);
    expect(useToastStore.getState().toast?.text).toBe("two");
    t.resume();
    vi.advanceTimersByTime(1100);
    expect(useToastStore.getState().toast).toBeNull();
  });

  it("runs undo once and dismisses", () => {
    const undo = vi.fn();
    useToastStore.getState().show({ text: "Archived", undo });
    useToastStore.getState().runUndo();
    useToastStore.getState().runUndo();
    expect(undo).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().toast).toBeNull();
  });
});

describe("mail actions", () => {
  it("archives in the same tick, moves the selection on, and offers undo", async () => {
    useSelectionStore.getState().select("outlook:maya");
    const pending = archive(["outlook:maya"]);
    // Before any await: the cache, selection and toast have already changed.
    expect(findRow("outlook:maya")).toBeUndefined();
    expect(useSelectionStore.getState().selectedKey).toBe("gmail:stripe");
    expect(useToastStore.getState().toast).toMatchObject({ text: "Archived" });
    expect(api.getMessage("outlook:maya")?.folder).toBe("INBOX");
    await pending;
    expect(api.getMessage("outlook:maya")?.folder).toBe("Archive");

    undoLast();
    expect(findRow("outlook:maya")?.key).toBe("outlook:maya");
    expect(useSelectionStore.getState().selectedKey).toBe("outlook:maya");
    await flush();
    await flush();
    expect(api.getMessage("outlook:maya")?.folder).toBe("INBOX");
  });

  it("rolls back and says so when the write fails", async () => {
    setLatency({ failWrites: true });
    const pending = archive(["gmail:stripe"]);
    expect(findRow("gmail:stripe")).toBeUndefined();
    await pending;
    expect(findRow("gmail:stripe")?.key).toBe("gmail:stripe");
    expect(useToastStore.getState().toast).toMatchObject({ kind: "error" });
  });

  it("marks read optimistically and adjusts nothing on the wire until the call lands", async () => {
    expect(findRow("outlook:maya")?.is_read).toBe(false);
    const pending = markRead(["outlook:maya"], true, { silent: true });
    expect(findRow("outlook:maya")?.is_read).toBe(true);
    expect(useToastStore.getState().toast).toBeNull();
    await pending;
    expect(api.getMessage("outlook:maya")?.is_read).toBe(true);
  });

  it("delays a send for the undo window; undo reopens the editor and nothing is sent", async () => {
    vi.useFakeTimers();
    useComposeStore.getState().open({ inbox_id: "gmail", to: "k@x.co", subject: "Hi", body: "Hello" });
    const c = useComposeStore.getState().compose!;
    expect(send(c, { undoWindowMs: 5000 })).toBe(true);
    expect(useComposeStore.getState().compose).toBeNull();
    expect(useToastStore.getState().toast).toMatchObject({ text: "Sending to k@x.co", durationMs: 5000 });
    vi.advanceTimersByTime(4000);
    useToastStore.getState().runUndo();
    expect(useComposeStore.getState().compose).toMatchObject({ to: "k@x.co", body: "Hello" });
    vi.advanceTimersByTime(5000);
    expect(api.allMessages().some((m) => m.subject === "Hi")).toBe(false);
  });

  it("sends once the undo window passes, and refuses without a recipient", async () => {
    vi.useFakeTimers();
    expect(send({ mode: "new", inbox_id: "gmail", to: " ", cc: "", bcc: "", subject: "x", body: "y" })).toBe(false);
    expect(useToastStore.getState().toast?.text).toBe("Add a recipient before sending.");
    send({ mode: "new", inbox_id: "gmail", to: "k@x.co", cc: "", bcc: "", subject: "Later", body: "y" }, { undoWindowMs: 1000 });
    await vi.advanceTimersByTimeAsync(1100);
    expect(api.allMessages().some((m) => m.subject === "Later" && m.folder === "Sent")).toBe(true);
  });
});

describe("assistant store", () => {
  it("applies a text and tool-call stream", () => {
    const a = useAssistantStore.getState();
    a.applyEvent({ type: "run_started", run_id: "r1" });
    a.applyEvent({ type: "status", text: "Reading Maya", progress: { i: 1, n: 3 } });
    a.applyEvent({ type: "text_delta", message_id: "m1", delta: "Hel" });
    a.applyEvent({ type: "text_delta", message_id: "m1", delta: "lo" });
    const call = { id: "c1", tool: "email_read" as const, human: "Reading Maya", state: "running" as const, keys: ["outlook:maya" as const] };
    a.applyEvent({ type: "tool_call", message_id: "m1", call });

    let s = useAssistantStore.getState();
    expect(s).toMatchObject({ runId: "r1", status: "Reading Maya", progress: { i: 1, n: 3 } });
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ id: "m1", role: "assistant", text: "Hello", streaming: true, run_id: "r1" });
    expect(s.aiTouch["outlook:maya"]).toMatchObject({ tool: "email_read", call_id: "c1", state: "running" });

    a.applyEvent({ type: "tool_call", message_id: "m1", call: { ...call, state: "done", human: "Read Maya" } });
    a.applyEvent({ type: "row_label", keys: ["outlook:maya"], label: "needs reply" });
    a.applyEvent({ type: "done", summary: { text: "Read 1 email", undoable: false } });
    s = useAssistantStore.getState();
    expect(s.messages[0]?.calls).toEqual([{ ...call, state: "done", human: "Read Maya" }]);
    expect(s.messages[0]?.streaming).toBe(false);
    expect(s.aiTouch["outlook:maya"]).toBeUndefined();
    expect(s.lastTrace["outlook:maya"]).toMatchObject({ call_id: "c1", message_id: "m1" });
    expect(s.labels["outlook:maya"]).toBe("needs reply");
    expect(s.lastSummary).toEqual({ text: "Read 1 email", undoable: false, run_id: "r1" });
  });

  it("mirrors a move as a ghost row and a folder bump that clears itself", () => {
    vi.useFakeTimers();
    const a = useAssistantStore.getState();
    a.applyEvent({
      type: "mail_effect",
      effect: { kind: "moved", keys: ["gmail:stripe"], from: { role: "inbox" }, to: { name: "Receipts" }, call_id: "c2" },
    });
    let s = useAssistantStore.getState();
    expect(s.ghosts["gmail:stripe"]).toMatchObject({ to: { name: "Receipts" }, row: { key: "gmail:stripe" } });
    expect(s.folderBump["name:Receipts"]).toBe(1);
    // The row stays in the list (faded) until the ghosts are cleared.
    expect(findRow("gmail:stripe")).toBeDefined();
    vi.advanceTimersByTime(FOLDER_BUMP_MS + 10);
    expect(useAssistantStore.getState().folderBump["name:Receipts"]).toBeUndefined();
    a.clearGhosts();
    s = useAssistantStore.getState();
    expect(s.ghosts).toEqual({});
    expect(findRow("gmail:stripe")).toBeUndefined();
  });

  it("applies flag effects to the cache", () => {
    useAssistantStore.getState().applyEvent({
      type: "mail_effect",
      effect: { kind: "flagged", keys: ["outlook:maya"], flags: { read: true, starred: true }, call_id: "c3" },
    });
    expect(findRow("outlook:maya")).toMatchObject({ is_read: true, is_starred: true });
  });

  it("streams a draft into compose, then an edit, then holds it for approval", async () => {
    const a = useAssistantStore.getState();
    const fields = { to: "maya@lattice-labs.io", subject: "Re: Q4 renewal" };
    a.applyEvent({ type: "draft_stream", phase: "writing", reply_to: "outlook:maya", fields, body_delta: "Hi Maya," });
    a.applyEvent({ type: "draft_stream", phase: "writing", reply_to: "outlook:maya", fields, body_delta: " Thursday works." });
    let c = useComposeStore.getState().compose;
    expect(c).toMatchObject({ mode: "reply", inbox_id: "outlook", replyTo: "outlook:maya", ai: true, streaming: "writing", body: "Hi Maya, Thursday works." });
    expect(useSelectionStore.getState().selectedKey).toBe("outlook:maya");

    a.applyEvent({ type: "draft_stream", phase: "writing", reply_to: "outlook:maya", fields, done: true });
    c = useComposeStore.getState().compose;
    expect(c).toMatchObject({ streaming: null, body: "Hi Maya, Thursday works.", aiOriginal: "Hi Maya, Thursday works." });

    const segments = [{ k: "keep" as const, t: "Hi Maya, " }, { k: "del" as const, t: "Thursday" }, { k: "ins" as const, t: "Friday" }, { k: "keep" as const, t: " works." }];
    a.applyEvent({ type: "draft_stream", phase: "editing", reply_to: "outlook:maya", fields, segments });
    expect(useComposeStore.getState().compose).toMatchObject({ streaming: "editing", preEdit: "Hi Maya, Thursday works.", segments });
    a.applyEvent({ type: "draft_stream", phase: "editing", reply_to: "outlook:maya", fields, done: true });
    expect(useComposeStore.getState().compose).toMatchObject({ streaming: null, body: "Hi Maya, Friday works." });

    const t = fakeTransport([]);
    setAssistantTransport(t);
    a.applyEvent({
      type: "approval_required",
      approval_id: "ap1",
      call_id: "c9",
      external: true,
      draft: { inbox_id: "outlook", to: fields.to, subject: fields.subject, body: "Hi Maya, Friday works.", reply_to: "outlook:maya" },
    });
    expect(useComposeStore.getState().compose?.held).toEqual({ approval_id: "ap1", external: true });
    await a.resolveApproval("approve");
    expect(t.approvals).toEqual(["ap1:approve"]);
    expect(useComposeStore.getState().compose?.held).toBeUndefined();
  });

  it("runs a transport stream end to end", async () => {
    setAssistantTransport(
      fakeTransport([
        { type: "run_started", run_id: "r7" },
        { type: "text_delta", message_id: "m7", delta: "Done." },
        { type: "done" },
      ]),
    );
    await useAssistantStore.getState().run("File receipts", { keys: ["gmail:stripe"], contextLabel: "Stripe · receipt" });
    const s = useAssistantStore.getState();
    expect(s.busy).toBe(false);
    expect(s.messages.map((m) => [m.role, m.text])).toEqual([["user", "File receipts"], ["assistant", "Done."]]);
    expect(s.messages[0]?.context).toEqual({ keys: ["gmail:stripe"], label: "Stripe · receipt" });
    expect(s.messages[1]?.streaming).toBe(false);
  });

  it("stops: cancels running calls, restores a half-edited draft, denies a held send", async () => {
    const t = fakeTransport(
      [
        { type: "run_started", run_id: "r8" },
        { type: "tool_call", message_id: "m8", call: { id: "c8", tool: "email_read", human: "Reading", state: "running", keys: ["outlook:maya"] } },
      ],
      { hang: true },
    );
    setAssistantTransport(t);
    const running = useAssistantStore.getState().run("go");
    await flush();
    expect(useAssistantStore.getState().busy).toBe(true);
    useComposeStore.getState().open({ inbox_id: "outlook", replyTo: "outlook:maya", mode: "reply", ai: true, body: "old", streaming: "editing", preEdit: "old", segments: [], held: { approval_id: "ap2", external: false } });
    useAssistantStore.getState().stop();
    await running;
    const s = useAssistantStore.getState();
    expect(s.busy).toBe(false);
    expect(s.aiTouch).toEqual({});
    expect(s.messages.find((m) => m.id === "m8")?.calls[0]).toMatchObject({ state: "cancelled", meta: "stopped" });
    expect(s.messages[s.messages.length - 1]?.text).toBe("Stopped. Nothing else was changed.");
    expect(t.approvals).toEqual(["ap2:reject"]);
    expect(useComposeStore.getState().compose).toMatchObject({ streaming: null, body: "old" });
    expect(useComposeStore.getState().compose?.held).toBeUndefined();
  });

  it("refuses to run when the allowance is used up, unless the run is free", async () => {
    const t = fakeTransport([{ type: "done" }]);
    setAssistantTransport(t);
    queryClient.setQueryData<AssistantAllowance>(keys.allowance, {
      plan: "free", used: 50, cap: 50, remaining: 0, period_start: "", resets_at: "",
    });
    await useAssistantStore.getState().run("hello");
    expect(useAssistantStore.getState().messages).toEqual([]);
    expect(useToastStore.getState().toast?.text).toContain("all 50 assistant actions");
    await useAssistantStore.getState().run("hello", { free: true });
    expect(useAssistantStore.getState().messages).toHaveLength(1);
  });

  it("holds new mail and hands it back once", () => {
    const row = findRow("gmail:stripe")!;
    const a = useAssistantStore.getState();
    a.addPendingNew([row]);
    expect(useAssistantStore.getState().pendingNew).toHaveLength(1);
    expect(a.takePendingNew()).toEqual([row]);
    expect(useAssistantStore.getState().pendingNew).toEqual([]);
  });
});
