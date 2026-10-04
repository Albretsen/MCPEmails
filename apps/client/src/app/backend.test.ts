import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getAssistantTransport, getMailApi, setAssistantTransport, setMailApi } from "../api";
import { FakeBackend, fakeInbox, fakeMessage } from "../api/http/fake-backend";
import type { AssistantAllowance, Inbox, SessionInfo } from "../api/types";
import { type AuthBackend, type AuthChange, type AuthSession, readIdentity, signInWithPassword, useAuthStore, useSessionStore } from "../auth";
import { type ListData } from "../data/cache";
import { keys, listMeta } from "../data/keys";
import { flushPendingSends } from "../data/mail-actions";
import { getCacheNamespace, queryClient, setCacheNamespace, startQueryPersistence } from "../data/query-client";
import { getPlatform, setPlatform } from "../platform";
import { useAssistantStore } from "../state/assistant-store";
import { useComposeStore } from "../state/compose-store";
import { useSelectionStore } from "../state/selection-store";
import { useToastStore } from "../state/toast-store";
import { INBOX_NOTICE } from "../api/inbox-health";
import { defaultInboxId } from "../data/mail-actions";
import { useReconnectStore } from "../state/connection-store";
import { bootHttp, getHttpMailApi, loadSession, readRefused, signOutEverywhere } from "./backend";

/* HTTP mode end to end, against the fake backend: boot, the assistant's
 * approval flow through the real stores and mail actions, and what a
 * sign-out leaves behind (nothing). One scenario, in order. */

const disk = new Map<string, unknown>();
const backend = new FakeBackend([fakeInbox("a", "me@example.com")]);
const me: AuthSession = { access_token: "tok-1", user: { id: "user-1", email: "me@example.com", name: "Me" } };

const auth = {
  session: null as AuthSession | null,
  refreshable: true,
  listeners: new Set<(e: AuthChange, s: AuthSession | null) => void>(),
};
const authBackend: AuthBackend = {
  getSession: async () => auth.session,
  refreshSession: async () => (auth.refreshable ? auth.session : null),
  onChange(l) {
    auth.listeners.add(l);
    return () => void auth.listeners.delete(l);
  },
  signInWithPassword: async () => {
    auth.session = me;
    return me;
  },
  sendMagicLink: async () => {},
  signInWithOAuth: async () => {},
  exchangeCode: async () => null,
  signOut: async () => {
    auth.session = null;
  },
};

const A = () => useAssistantStore.getState();
const INBOX = keys.messages(listMeta("all", { role: "inbox" }));
const flush = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !cond(); i++) await flush(2);
  if (!cond()) throw new Error("condition never became true");
}
const runs = () => backend.requests.filter((r) => r.path === "/assistant/run");
const lastRun = () => runs().at(-1)?.body as { context: unknown; conversation: unknown };

const approval = (approval_id: string) => [
  { type: "run_started", run_id: `run-${approval_id}` },
  { type: "tool_call", message_id: "am1", call: { id: "c1", tool: "email_compose", human: "Reply to Sender", state: "waiting", keys: ["a:m1"] } },
  {
    type: "draft_stream",
    phase: "writing",
    reply_to: { inbox_id: "a", message_id: "m1" },
    fields: { inbox_id: "a", to: "sender@example.com", subject: "Re: Subject m1" },
    body: "Sounds good.",
    call_id: "c1",
    message_id: "am1",
    done: true,
  },
  {
    type: "approval_required",
    approval_id,
    call_id: "c1",
    external: false,
    draft: { inbox_id: "a", to: "sender@example.com", subject: "Re: Subject m1", body: "Sounds good.", reply_to: { inbox_id: "a", message_id: "m1" } },
  },
  { type: "done", conversation: { after: approval_id } },
];

let stopPersisting = () => {};

beforeAll(() => {
  backend.add("a", fakeMessage("m1", "2026-10-02T10:00:00Z"), fakeMessage("m2", "2026-10-01T10:00:00Z"));
  vi.stubGlobal("fetch", backend.fetch);
  setPlatform({
    ...getPlatform(),
    storage: {
      get: async <T,>(k: string) => disk.get(k) as T | undefined,
      set: async (k, v) => void disk.set(k, structuredClone(v)),
      del: async (k) => void disk.delete(k),
    },
  });
  localStorage.clear();
  queryClient.clear();
  // Tests run in mock mode, where the namespace is fixed. HTTP mode starts with none.
  setCacheNamespace(null);
  window.history.replaceState({}, "", "/all/inbox");
  stopPersisting = startQueryPersistence();
});

afterAll(() => {
  stopPersisting();
  setCacheNamespace("mock");
  vi.unstubAllGlobals();
  setPlatform(null);
  setMailApi(null);
  setAssistantTransport(null);
});

describe("HTTP mode, end to end", () => {
  it("signed out: nothing is requested and nothing is cached", async () => {
    await bootHttp(async () => authBackend);
    await until(() => useAuthStore.getState().status === "signed-out");
    expect(backend.requests).toHaveLength(0);
    expect(getCacheNamespace()).toBeNull();
  });

  it("sign in: /session boots the app and names the cache after user and workspace", async () => {
    await signInWithPassword("me@example.com", "pw");
    await until(() => useSessionStore.getState().status === "ready");
    const s = useSessionStore.getState();
    expect(s.session?.inboxes.map((i) => i.inbox_id)).toEqual(["a"]);
    expect(s.fromCache).toBe(false);
    expect(getCacheNamespace()).toBe("user-1:ws-1");
    expect(readIdentity()).toMatchObject({ user: { id: "user-1" }, workspace_id: "ws-1" });
    // The session seeds what the panes would otherwise fetch one by one.
    expect(queryClient.getQueryData<Inbox[]>(keys.inboxes)).toHaveLength(1);
    expect(queryClient.getQueryData<AssistantAllowance>(keys.allowance)?.cap).toBe(1000);
    expect(queryClient.getQueryData<SessionInfo>(keys.session)?.workspace_id).toBe("ws-1");
    expect(backend.count("/session")).toBe(1);
    expect(backend.count("/allowance")).toBe(0);
    // Folders were asked for in the same tick as the session landed.
    await until(() => queryClient.getQueryData(keys.folders("a")) !== undefined);
    expect(backend.calls("folders")).toHaveLength(1);
    // Later requests carry the workspace.
    await getMailApi().listFolders("a");
    expect(backend.requests.at(-1)?.headers["x-workspace-id"]).toBe("ws-1");
  });

  it("approval: the run ends holding the draft; Approve sends it as the human", async () => {
    const page = await getMailApi().listMessages({ scope: "all", folder: { role: "inbox" }, limit: 50 });
    queryClient.setQueryData<ListData>(INBOX, { pages: [page], pageParams: [null] });
    expect(getAssistantTransport().approvalsOutliveRun).toBe(true);

    backend.assistantEvents = approval("ap1");
    await A().run("Reply that it sounds good", { keys: ["a:m1"] });
    expect(A().busy).toBe(false);
    // The run is over and the draft is still held, waiting for the person.
    const c = useComposeStore.getState().compose;
    expect(c).toMatchObject({ replyTo: "a:m1", body: "Sounds good.", to: "sender@example.com", held: { approval_id: "ap1" } });
    expect(A().messages.flatMap((m) => m.calls).find((x) => x.id === "c1")?.state).toBe("waiting");
    expect(A().conversations[A().conversationId]).toEqual({ after: "ap1" });
    // The server sent nothing.
    expect(backend.delivered).toHaveLength(0);

    await A().resolveApproval("approve");
    expect(useComposeStore.getState().compose).toBeNull();
    expect(A().messages.flatMap((m) => m.calls).find((x) => x.id === "c1")).toMatchObject({ state: "done", meta: "approved" });
    // It goes through the normal send (undo window and all).
    expect(backend.delivered).toHaveLength(0);
    expect(useToastStore.getState().toast?.undo).toBeTypeOf("function");
    await flushPendingSends();
    expect(backend.delivered).toHaveLength(1);
    // The threaded reply op, with the To line as it stood on screen.
    expect(backend.delivered[0]).toMatchObject({ op: "reply", inbox_id: "a", args: { message_id: "m1", body: "Sounds good.", reply_all: false } });
    expect(backend.delivered[0]?.args.to).toEqual(["sender@example.com"]);
    expect(typeof backend.delivered[0]?.args.idempotency_key).toBe("string");
    // Approval was never a server call.
    expect(runs()).toHaveLength(1);

    // The next run carries the conversation and what was decided.
    backend.assistantEvents = [{ type: "run_started", run_id: "r2" }, { type: "done", conversation: { after: "r2" } }];
    await A().run("Thanks");
    expect(lastRun()).toMatchObject({
      conversation: { after: "ap1" },
      context: { keys: [], notes: [{ type: "approval", approval_id: "ap1", decision: "approved" }] },
    });
    expect(A().conversations[A().conversationId]).toEqual({ after: "r2" });
  });

  it("approval: Reject and Edit never send", async () => {
    backend.assistantEvents = approval("ap2");
    await A().run("Reply again", { keys: ["a:m1"] });
    expect(useComposeStore.getState().compose?.held?.approval_id).toBe("ap2");
    await A().resolveApproval("reject");
    expect(useComposeStore.getState().compose?.held).toBeUndefined();
    expect(A().messages.flatMap((m) => m.calls).filter((x) => x.state === "waiting")).toEqual([]);

    backend.assistantEvents = approval("ap3");
    await A().run("And again", { keys: ["a:m1"] });
    expect(lastRun().context).toMatchObject({ notes: [{ approval_id: "ap2", decision: "rejected" }] });
    await A().resolveApproval("edit");
    // Edit: the draft stays open, no longer held, for the person to change and send.
    expect(useComposeStore.getState().compose).toMatchObject({ body: "Sounds good.", held: undefined });
    await flushPendingSends();
    expect(backend.delivered).toHaveLength(1);
    useComposeStore.setState({ compose: null });
  });

  it("an assistant edit can clear Cc; the Bcc the person typed stays and goes out when they approve", async () => {
    const reply = { inbox_id: "a", message_id: "m1" };
    const edit = (approval_id: string) => [
      { type: "run_started", run_id: `run-${approval_id}` },
      // The header as it stands after the edit: Cc is present and empty.
      {
        type: "draft_stream",
        phase: "editing",
        kind: "reply",
        reply_to: reply,
        fields: { inbox_id: "a", to: "sender@example.com", cc: "", subject: "Re: Subject m1" },
        body: "Short.",
        call_id: "c1",
        message_id: "am1",
        done: true,
      },
      {
        type: "approval_required",
        approval_id,
        call_id: "c1",
        external: false,
        draft: { inbox_id: "a", kind: "reply", to: "sender@example.com", subject: "Re: Subject m1", body: "Short.", reply_to: reply },
      },
      { type: "done" },
    ];
    const open = () =>
      useComposeStore.getState().open({
        mode: "reply",
        inbox_id: "a",
        replyTo: "a:m1",
        to: "sender@example.com",
        cc: "cc@example.com",
        bcc: "boss@example.com",
        subject: "Re: Subject m1",
        body: "A long draft.",
      });

    open();
    backend.assistantEvents = edit("ap4");
    await A().run("Drop the cc, make it short and send it", { keys: ["a:m1"] });
    // Bcc still travels with the draft (the server ignores it today).
    expect((lastRun() as unknown as { draft: { bcc: string } }).draft.bcc).toBe("boss@example.com");
    expect(useComposeStore.getState().compose).toMatchObject({ to: "sender@example.com", cc: "", bcc: "boss@example.com", body: "Short.", held: { approval_id: "ap4" } });
    const before = backend.delivered.length;
    await A().resolveApproval("approve");
    await flushPendingSends();
    expect(backend.delivered).toHaveLength(before + 1);
    expect(backend.delivered.at(-1)?.args).toMatchObject({ to: ["sender@example.com"], bcc: ["boss@example.com"], body: "Short." });
    expect(backend.delivered.at(-1)?.args.cc).toBeUndefined();

    // The same with the form closed before the person approves (from the
    // notice): the assistant's copy has no Bcc, the one typed is put back.
    open();
    backend.assistantEvents = edit("ap5");
    await A().run("Send it", { keys: ["a:m1"] });
    useComposeStore.setState({ compose: null });
    await getAssistantTransport().resolveApproval("ap5", "approve");
    await flushPendingSends();
    expect(backend.delivered).toHaveLength(before + 2);
    expect(backend.delivered.at(-1)?.args).toMatchObject({ to: ["sender@example.com"], bcc: ["boss@example.com"] });
    A().clear();
    useComposeStore.setState({ compose: null });
  });

  it("per-inbox status from /session: a mailbox that is down is listed, shown, and never asked for mail", async () => {
    const mail = getMailApi();
    backend.inboxes = [...backend.inboxes, fakeInbox("b", "b@example.com", "imap")];
    backend.add("b", fakeMessage("n1", "2026-10-03T10:00:00Z"));
    backend.setInboxStatus("b", "reconnect_required", "password_refused");
    const callsTo = (id: string) => backend.calls().filter((c) => c.inbox_id === id).length;

    await loadSession();
    const inboxes = useSessionStore.getState().session?.inboxes ?? [];
    expect(inboxes.map((i) => [i.inbox_id, i.status, i.status_reason])).toEqual([
      ["a", "ok", null],
      ["b", "reconnect_required", "password_refused"],
    ]);
    // Known from the session alone: remembered for the next load too.
    expect(readRefused("ws-1")).toEqual(["b"]);
    await flush();
    expect(callsTo("b")).toBe(0);

    // The unified inbox works with the rest and names the one left out.
    const page = await mail.listMessages({ scope: "all", folder: { role: "inbox" }, limit: 50 });
    expect(page.rows.map((r) => r.inbox_id)).toEqual(["a", "a"]);
    expect(page.failed_inboxes).toEqual([{ inbox_id: "b", code: "reconnect_required", message: INBOX_NOTICE.password_refused }]);
    await expect(mail.listMessages({ scope: "b", folder: { role: "inbox" }, limit: 50 })).rejects.toMatchObject({
      code: "reconnect_required",
      message: INBOX_NOTICE.password_refused,
    });
    await expect(mail.setFlags(["b:n1"], { read: true })).rejects.toMatchObject({ code: "reconnect_required" });
    await mail.searchMessages({ scope: "all", query: "Subject", limit: 50 });
    expect(callsTo("b")).toBe(0);
    expect(backend.refusedCalls).toHaveLength(0);
    // A new message is never set to go out from it.
    useSelectionStore.setState({ scope: "b" });
    expect(defaultInboxId()).toBe("a");
    useSelectionStore.setState({ scope: "all" });

    // Reconnected in the dashboard: the next session says so, and the
    // mailbox is asked again (its folders, the lists it belongs to).
    backend.setInboxStatus("b", "ok");
    await loadSession();
    await until(() => queryClient.getQueryData(keys.folders("b")) !== undefined);
    expect(readRefused("ws-1")).toEqual([]);
    const again = await mail.listMessages({ scope: "all", folder: { role: "inbox" }, limit: 50 });
    expect(again.rows.map((r) => r.inbox_id)).toEqual(["b", "a", "a"]);
    expect(again.failed_inboxes).toBeUndefined();

    // It starts failing mid-session: marked at once from the failed call,
    // and the session is asked for the reason.
    backend.setInboxStatus("b", "reconnect_required", "access_revoked");
    const sessions = backend.count("/session");
    const partial = await mail.listMessages({ scope: "all", folder: { role: "inbox" }, limit: 50 });
    expect(partial.rows.map((r) => r.inbox_id)).toEqual(["a", "a"]);
    expect(partial.failed_inboxes?.map((f) => [f.inbox_id, f.code])).toEqual([["b", "reconnect_required"]]);
    await until(() => useSessionStore.getState().session?.inboxes.find((i) => i.inbox_id === "b")?.status_reason === "access_revoked");
    expect(backend.count("/session")).toBe(sessions + 1);
    // The server's status has replaced what the client had noted itself.
    expect(useReconnectStore.getState().inboxes).toEqual({});
    expect(readRefused("ws-1")).toEqual(["b"]);

    // Back to one mailbox for the rest of the scenario.
    backend.inboxes = backend.inboxes.filter((i) => i.inbox_id === "a");
    await loadSession();
    expect(useSessionStore.getState().session?.inboxes.map((i) => i.inbox_id)).toEqual(["a"]);
    const page1 = await mail.listMessages({ scope: "all", folder: { role: "inbox" }, limit: 50 });
    queryClient.setQueryData<ListData>(INBOX, { pages: [page1], pageParams: [null] });
  });

  it("a new conversation starts without the old state", async () => {
    A().clear();
    backend.assistantEvents = [{ type: "run_started", run_id: "r9" }, { type: "done" }];
    await A().run("Fresh start");
    expect(lastRun().conversation).toBeNull();
  });

  it("allowance exhausted: an inline state, no error bubble, no retry loop", async () => {
    backend.assistantError = { status: 402, error: { code: "allowance_exhausted", message: "cap", retryable: false } };
    const before = runs().length;
    const bubbles = A().messages.length;
    await A().run("One more");
    expect(runs()).toHaveLength(before + 1);
    expect(A().allowanceBlocked).toBe(true);
    // The user's own message is there; no assistant "error" message was added.
    expect(A().messages.slice(bubbles).map((m) => m.role)).toEqual(["user"]);
    // The cached allowance now says so too, so the next attempt asks nobody.
    await until(() => queryClient.getQueryState(keys.allowance)?.fetchStatus === "idle");
    queryClient.setQueryData<AssistantAllowance>(keys.allowance, { ...backend.allowance, used: 1000, remaining: 0 });
    await A().run("And another");
    await A().run("And another");
    expect(runs()).toHaveLength(before + 1);
    expect(A().allowanceBlocked).toBe(true);
    backend.assistantError = null;
  });

  it("a session the server no longer accepts: signed out, URL kept, nothing left behind", async () => {
    useSelectionStore.getState().select("a:m1");
    const url = window.location.pathname;
    expect(url).toContain("a%3Am1");
    window.dispatchEvent(new Event("pagehide"));
    await flush();
    expect([...disk.keys()].some((k) => k.includes("user-1:ws-1"))).toBe(true);

    backend.tokens = new Set(["tok-after-relogin"]);
    auth.refreshable = false;
    await expect(getHttpMailApi()?.listFolders("a")).rejects.toMatchObject({ code: "unauthenticated" });
    await until(() => useAuthStore.getState().status === "signed-out");
    await until(() => disk.size === 0);

    expect(useAuthStore.getState().notice).toMatch(/session ended/);
    expect(window.location.pathname).toBe(url);
    expect(useSessionStore.getState().session).toBeNull();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(getCacheNamespace()).toBeNull();
    expect(readIdentity()).toBeNull();
    expect(A().messages).toEqual([]);
    expect(A().conversations).toEqual({});
    expect(getHttpMailApi()?.peekSession()).toBeNull();
  });

  it("signing out here goes back to the inbox URL", async () => {
    backend.tokens = new Set(["tok-1"]);
    auth.refreshable = true;
    await signInWithPassword("me@example.com", "pw");
    await until(() => useSessionStore.getState().status === "ready");
    expect(window.location.pathname).toContain("a%3Am1");
    await signOutEverywhere();
    await until(() => useAuthStore.getState().status === "signed-out");
    expect(window.location.pathname).toBe("/all/inbox");
    expect(useSelectionStore.getState().selectedKey).toBeNull();
    await until(() => getCacheNamespace() === null);
    expect(readIdentity()).toBeNull();
  });
});
