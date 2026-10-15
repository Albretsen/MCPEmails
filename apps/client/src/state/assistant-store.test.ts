import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAssistantTransport, setMailApi } from "../api";
import { ScriptedAssistantTransport, setAssistantPace } from "../api/mock/assistant";
import { setLatency } from "../api/mock/latency";
import { MockMailApi } from "../api/mock/mock-mail-api";
import { THREADS } from "../api/mock/seed";
import type { AssistantAllowance } from "../api/types";
import { resetRouterForTests } from "../app/router";
import { type ListData, findRow } from "../data/cache";
import { keys, listMeta } from "../data/keys";
import { queryClient } from "../data/query-client";
import { clearUndo } from "../data/undo";
import { type AppNotification, type PlatformAdapter, getPlatform, setPlatform } from "../platform";
import { HOLD_RELEASE_MS, LEAVING_MS, useAssistantStore } from "./assistant-store";
import { useComposeStore } from "./compose-store";
import { setVisibleKeys, useSelectionStore } from "./selection-store";
import { useToastStore } from "./toast-store";
import { useUiStore } from "./ui-store";

/* The visible-AI reducer against the real scripted engine: what the list,
 * the compose view and the notice end up showing. */

let api: MockMailApi;
const INBOX = keys.messages(listMeta("all", { role: "inbox" }));
const flush = () => new Promise((r) => setTimeout(r, 0));
const A = () => useAssistantStore.getState();
// Mail in Sent, not counting the seeded conversations' own replies.
const SEEDED_REPLIES = THREADS.filter((e) => e.folder === "sent").length;
const sentCount = () => api.allMessages().filter((m) => m.folder === "Sent").length - SEEDED_REPLIES;

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await flush();
  if (!cond()) throw new Error("condition never became true");
}

beforeEach(async () => {
  setLatency({ read: [0, 0], write: [0, 0], failWrites: false });
  setAssistantPace(0);
  api = new MockMailApi("pro");
  setMailApi(api);
  setAssistantTransport(new ScriptedAssistantTransport());
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
  const page = await api.listMessages({ scope: "all", folder: { role: "inbox" }, limit: 30 });
  queryClient.setQueryData<ListData>(INBOX, { pages: [page], pageParams: [null] });
  setVisibleKeys(page.rows.map((r) => r.key));
});

afterEach(() => {
  setMailApi(null);
  setAssistantTransport(null);
  setPlatform(null);
  setAssistantPace(1);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("visible AI", () => {
  it("files receipts: rows become ghosts in place, the folder is bumped, Undo puts everything back", async () => {
    await A().run("File this week's receipts");
    let s = A();
    expect(s.busy).toBe(false);
    expect(Object.keys(s.ghosts).sort()).toEqual(["gmail:figr", "gmail:ghr", "gmail:notion", "gmail:stripe", "gmail:vercel", "outlook:aws"]);
    expect(s.ghosts["gmail:stripe"]).toMatchObject({ to: { name: "Receipts" }, run_id: s.runId });
    expect(s.folderBump["name:Receipts"]).toBe(6);
    // Nothing is touched any more, but each row remembers the call that moved it.
    expect(s.aiTouch).toEqual({});
    expect(s.lastTrace["gmail:stripe"]).toMatchObject({ tool: "email_organize" });
    expect(s.lastSummary).toMatchObject({ text: "Filed 6 emails in Receipts", undoable: true });
    // The rows are still in the list (faded) until "Hide moved".
    expect(findRow("gmail:stripe")).toBeDefined();
    expect(api.getMessage("gmail:stripe")?.folder).toBe("Receipts");
    // One request: the user's message and the assistant's replies share a turn.
    expect(new Set(s.messages.map((m) => m.turn))).toEqual(new Set([1]));
    expect(s.messages.every((m) => !m.streaming)).toBe(true);

    await s.undoRun();
    s = A();
    expect(s.ghosts).toEqual({});
    expect(s.lastSummary).toBeNull();
    expect(api.getMessage("gmail:stripe")?.folder).toBe("INBOX");
    expect(useToastStore.getState().toast?.text).toBe("Moved 6 emails back");
  });

  it("a moved row fades out, then stays as a ghost", () => {
    vi.useFakeTimers();
    A().applyEvent({ type: "mail_effect", effect: { kind: "moved", keys: ["gmail:stripe"], to: { name: "Receipts" }, call_id: "c1" } });
    expect(A().leaving["gmail:stripe"]).toBe(true);
    expect(A().ghosts["gmail:stripe"]).toBeDefined();
    vi.advanceTimersByTime(LEAVING_MS + 1);
    expect(A().leaving["gmail:stripe"]).toBeUndefined();
    expect(A().ghosts["gmail:stripe"]).toBeDefined();
  });

  it("holds a move while the pointer is on the list and applies it once the pointer leaves", () => {
    vi.useFakeTimers();
    useUiStore.getState().setListHover(true);
    A().applyEvent({ type: "run_started", run_id: "r1" });
    A().applyEvent({ type: "mail_effect", effect: { kind: "moved", keys: ["gmail:stripe"], to: { name: "Receipts" }, call_id: "c1" } });
    expect(A().ghosts).toEqual({});
    expect(A().leaving).toEqual({});
    expect(A().holdNote).toBe(true);
    // A running call does not clear the note while something is still held.
    A().applyEvent({ type: "tool_call", message_id: "m1", call: { id: "c2", tool: "email_read", human: "Reading", state: "running", keys: [] } });
    expect(A().holdNote).toBe(true);

    // Leaving and coming straight back keeps it held.
    useUiStore.getState().setListHover(false);
    vi.advanceTimersByTime(HOLD_RELEASE_MS - 20);
    useUiStore.getState().setListHover(true);
    vi.advanceTimersByTime(HOLD_RELEASE_MS + 20);
    expect(A().ghosts).toEqual({});

    useUiStore.getState().setListHover(false);
    vi.advanceTimersByTime(HOLD_RELEASE_MS + 1);
    expect(A().ghosts["gmail:stripe"]).toMatchObject({ run_id: "r1" });
    expect(A().holdNote).toBe(false);
  });

  it("does not hold anything on phone, and drops held moves of a run that is undone", async () => {
    vi.useFakeTimers();
    useUiStore.setState({ viewport: "phone", listHover: true });
    A().applyEvent({ type: "mail_effect", effect: { kind: "moved", keys: ["gmail:stripe"], to: { name: "Receipts" }, call_id: "c1" } });
    expect(A().ghosts["gmail:stripe"]).toBeDefined();

    useUiStore.setState({ viewport: "desktop", listHover: true });
    A().applyEvent({ type: "run_started", run_id: "r2" });
    A().applyEvent({ type: "mail_effect", effect: { kind: "moved", keys: ["gmail:vercel"], to: { name: "Receipts" }, call_id: "c2" } });
    expect(A().holdNote).toBe(true);
    await A().undoRun("r2");
    expect(A().holdNote).toBe(false);
    useUiStore.getState().setListHover(false);
    vi.advanceTimersByTime(HOLD_RELEASE_MS + 1);
    expect(A().ghosts["gmail:vercel"]).toBeUndefined();
  });

  it("a call that moves from row to row only highlights the current one", () => {
    const call = { id: "c1", tool: "email_read" as const, human: "Reading 3 more", state: "running" as const, keys: ["gmail:stripe" as const] };
    A().applyEvent({ type: "tool_call", message_id: "m1", call });
    A().applyEvent({ type: "tool_call", message_id: "m1", call: { ...call, keys: ["gmail:vercel"] } });
    expect(Object.keys(A().aiTouch)).toEqual(["gmail:vercel"]);
    expect(A().lastTrace["gmail:stripe"]).toMatchObject({ call_id: "c1" });
    A().applyEvent({ type: "tool_call", message_id: "m1", call: { ...call, state: "done", keys: [] } });
    expect(A().aiTouch).toEqual({});
  });

  it("ends a message's caret when its text is done, not when the run is", () => {
    A().applyEvent({ type: "text_delta", message_id: "m1", delta: "Hi" });
    expect(A().messages[0]?.streaming).toBe(true);
    A().applyEvent({ type: "text_delta", message_id: "m1", delta: "", done: true });
    expect(A().messages[0]).toMatchObject({ text: "Hi", streaming: false });
  });

  it("drafts into the inline compose under the email, then edits it", async () => {
    await A().run("Draft a reply", { intent: "draft", keys: ["outlook:maya"], contextLabel: "Maya Chen · Q4 renewal" });
    const reply = api.getHints("outlook:maya")!.reply!;
    let c = useComposeStore.getState().compose!;
    expect(useSelectionStore.getState().selectedKey).toBe("outlook:maya");
    expect(c).toMatchObject({ mode: "reply", replyTo: "outlook:maya", ai: true, streaming: null, body: reply, aiOriginal: reply, to: "maya@lattice-labs.io" });
    expect(c.draft_id).toBeTruthy();
    expect(c.draftCall?.call_id).toBeTruthy();
    expect(A().folderBump.drafts).toBe(1);
    expect(A().lastAct["outlook:maya"]).toBe("draft");
    expect(A().messages[0]).toMatchObject({ role: "user", context: { keys: ["outlook:maya"] } });

    await A().run("Make it shorter", { intent: "shorter", keys: ["outlook:maya"] });
    c = useComposeStore.getState().compose!;
    const shorter = api.getHints("outlook:maya")!.shorter!;
    expect(c).toMatchObject({ streaming: null, body: shorter, aiOriginal: shorter });
    expect(c.segments).toBeUndefined();
    expect((await api.readDraft("outlook", c.draft_id!)).body_text).toBe(shorter);
  });

  describe("an edit of the draft's header", () => {
    const KEY = "outlook:maya" as const;
    const open = () =>
      useComposeStore.getState().open({
        mode: "reply",
        inbox_id: "outlook",
        replyTo: KEY,
        to: "maya@lattice-labs.io, sam@example.com",
        cc: "lee@example.com",
        bcc: "boss@example.com",
        subject: "Re: Q4 renewal",
        body: "Hello.",
      });
    const edit = (fields: Record<string, string>, extra: Record<string, unknown> = { body: "Hello.", done: true }) =>
      A().applyEvent({ type: "draft_stream", phase: "editing", reply_to: KEY, fields: fields as never, ...extra });
    const form = () => useComposeStore.getState().compose!;

    it("a field that is present and empty is cleared; one that is absent is left as it was", () => {
      open();
      // The assistant removed the Cc recipient and one of two To recipients.
      edit({ inbox_id: "outlook", to: "maya@lattice-labs.io", cc: "", subject: "Re: Q4 renewal" });
      expect(form()).toMatchObject({ to: "maya@lattice-labs.io", cc: "", subject: "Re: Q4 renewal", body: "Hello." });

      // Nothing about the header in this one: nothing changes.
      useComposeStore.getState().patch({ cc: "lee@example.com" });
      edit({ inbox_id: "outlook" }, { body: "Hello again.", done: true });
      expect(form()).toMatchObject({ to: "maya@lattice-labs.io", cc: "lee@example.com", subject: "Re: Q4 renewal", body: "Hello again." });

      // The last recipient goes too: the To line is empty, not the old address.
      edit({ inbox_id: "outlook", to: "", subject: "" });
      expect(form()).toMatchObject({ to: "", cc: "lee@example.com", subject: "" });
    });

    it("the diff phase applies the same rule before the final text arrives", () => {
      open();
      edit({ inbox_id: "outlook", to: "maya@lattice-labs.io", cc: "", subject: "Re: Q4 renewal" }, { segments: [{ k: "keep", t: "Hello." }] });
      expect(form()).toMatchObject({ streaming: "editing", to: "maya@lattice-labs.io", cc: "" });
    });

    it("never touches a Bcc the person typed", () => {
      open();
      edit({ inbox_id: "outlook", to: "maya@lattice-labs.io", cc: "", subject: "Re: Q4 renewal" });
      edit({ inbox_id: "outlook", to: "", cc: "", subject: "" });
      expect(form().bcc).toBe("boss@example.com");
    });

    it("while a draft is being written, an empty field only means it has not streamed in yet", () => {
      open();
      A().applyEvent({ type: "draft_stream", phase: "writing", reply_to: KEY, fields: { inbox_id: "outlook", to: "", subject: "" }, body_delta: "Hi" });
      expect(form()).toMatchObject({ to: "maya@lattice-labs.io, sam@example.com", cc: "lee@example.com", subject: "Re: Q4 renewal", bcc: "boss@example.com" });
    });
  });

  it("send: holds the draft in compose, sends on approve and closes it", async () => {
    const running = A().run("Reply that Thursday works, and send it", { keys: ["outlook:maya"] });
    await until(() => !!useComposeStore.getState().compose?.held);
    expect(A().busy).toBe(true);
    expect(A().status).toBe("Waiting for your approval");
    expect(A().aiTouch["outlook:maya"]).toMatchObject({ tool: "email_compose", state: "waiting" });
    // The user is looking at the draft: no notice needed.
    expect(A().push).toBeNull();
    expect(sentCount()).toBe(1);

    await A().resolveApproval("approve");
    await running;
    expect(sentCount()).toBe(2);
    expect(useComposeStore.getState().compose).toBeNull();
    expect(A().aiTouch).toEqual({});
    expect(A().folderBump.sent).toBe(1);
    expect(A().lastAct["outlook:maya"]).toBe("sent");
    expect(A().messages.at(-1)?.text).toBe("Sent to maya@lattice-labs.io. It's in Sent.");
  });

  it("send: Stop while held is a denial", async () => {
    const running = A().run("send it", { intent: "send", keys: ["outlook:maya"] });
    await until(() => !!useComposeStore.getState().compose?.held);
    A().stop();
    await running;
    expect(sentCount()).toBe(1);
    expect(useComposeStore.getState().compose?.held).toBeUndefined();
    const send = A().messages.flatMap((m) => m.calls).find((c) => c.tool === "email_compose");
    expect(send).toMatchObject({ state: "cancelled", meta: "stopped" });
    expect(A().messages.at(-1)?.text).toBe("Stopped. Nothing else was changed.");
  });

  it("raises the notice instead of taking over when the user is not on that email; Approve sends", async () => {
    const running = A().run("", { intent: "send_background", keys: ["imap:alex"], silent: true, free: true });
    await until(() => !!A().push);
    // Nothing was opened or selected.
    expect(useComposeStore.getState().compose).toBeNull();
    expect(useSelectionStore.getState().selectedKey).toBeNull();
    expect(A().push).toMatchObject({ text: 'To alex@romero.studio: "Good to hear from you. The morning of the 9th works. How about 9am at Astro on Main?"' });
    expect(A().push?.approval_id).toBeTruthy();

    await A().resolveApproval("approve");
    await running;
    expect(A().push).toBeNull();
    expect(sentCount()).toBe(2);
  });

  it("Review on the notice opens the held draft under its email; rejecting there sends nothing", async () => {
    const running = A().run("", { intent: "send_background", keys: ["imap:alex"], silent: true, free: true });
    await until(() => !!A().push);
    const id = A().push!.approval_id!;
    A().reviewPush();
    expect(A().push).toBeNull();
    expect(useSelectionStore.getState().selectedKey).toBe("imap:alex");
    expect(useComposeStore.getState().compose).toMatchObject({ replyTo: "imap:alex", ai: true, held: { approval_id: id, external: true } });
    await A().resolveApproval("reject");
    await running;
    expect(sentCount()).toBe(1);
    expect(useComposeStore.getState().compose?.held).toBeUndefined();
  });

  it("uses the platform notification when the page is hidden and permission is granted", async () => {
    const show = vi.fn(async (_n: AppNotification) => {});
    const real = getPlatform();
    const fake = { ...real, notifications: { ...real.notifications, supported: true, permission: () => "granted" as const, show } } as PlatformAdapter;
    setPlatform(fake);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    useSelectionStore.getState().select("outlook:maya");
    const draft = { inbox_id: "outlook", to: "maya@lattice-labs.io", subject: "Re: Q4", body: "Hi Maya,\n\nThursday works.\n\nJordan", reply_to: "outlook:maya" as const };
    useComposeStore.getState().open({ inbox_id: "outlook", mode: "reply", replyTo: "outlook:maya", body: draft.body, ai: true });
    A().applyEvent({ type: "approval_required", approval_id: "ap9", call_id: "c9", draft, external: true });
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0]?.[0]).toMatchObject({ title: "Assistant wants to send", body: 'To maya@lattice-labs.io: "Thursday works."', tag: "approval-ap9" });
    // Held in place AND announced in the app for when the user comes back.
    expect(useComposeStore.getState().compose?.held).toEqual({ approval_id: "ap9", external: true });
    expect(A().push?.approval_id).toBe("ap9");

    // Not granted: no system notification.
    show.mockClear();
    setPlatform({ ...fake, notifications: { ...fake.notifications, permission: () => "default" as const } } as PlatformAdapter);
    A().applyEvent({ type: "approval_required", approval_id: "ap10", call_id: "c10", draft, external: true });
    expect(show).not.toHaveBeenCalled();
  });

  it("counts the request against the allowance at once", async () => {
    const allowance: AssistantAllowance = { plan: "solo", used: 312, cap: 1000, remaining: 688, period_start: "", resets_at: "" };
    queryClient.setQueryData(keys.allowance, allowance);
    const seen: number[] = [];
    const unsub = useAssistantStore.subscribe((s, prev) => {
      if (s.busy && !prev.busy) seen.push(queryClient.getQueryData<AssistantAllowance>(keys.allowance)?.used ?? -1);
    });
    await A().run("Summarize", { intent: "summary", keys: ["outlook:maya"] });
    unsub();
    expect(seen).toEqual([313]);
    expect(api.consumeAssistantAction(0).used).toBe(313);
    expect(A().lastAct["outlook:maya"]).toBe("about");
  });

  it("groups requests into turns and resets cleanly", async () => {
    await A().run("Summarize", { intent: "summary", keys: ["outlook:maya"] });
    await A().run("What needs a reply?");
    const turns = A().messages.map((m) => m.turn);
    expect(new Set(turns)).toEqual(new Set([1, 2]));
    expect(A().labels["outlook:maya"]).toBe("needs reply");
    A().reset();
    expect(A()).toMatchObject({ messages: [], labels: {}, ghosts: {}, lastAct: {}, push: null, holdNote: false });
  });
});
