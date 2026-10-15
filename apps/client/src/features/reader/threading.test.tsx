import { QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setMailApi } from "../../api";
import { ApiClient } from "../../api/http/client";
import { FakeBackend, type FakeMessage, fakeInbox, fakeThreadMessage } from "../../api/http/fake-backend";
import { HttpMailApi } from "../../api/http/http-mail-api";
import { resetRouterForTests } from "../../app/router";
import type { FolderRef, MessageKey } from "../../api/types";
import { conversationKeys, conversationMessages } from "../../data/conversation-scope";
import { type MessageListResult, useMessageList } from "../../data/hooks";
import { queryClient } from "../../data/query-client";
import { startRealtime } from "../../data/realtime";
import { clearUndo, peekUndo, runUndo } from "../../data/undo";
import { useAssistantStore } from "../../state/assistant-store";
import { useComposeStore } from "../../state/compose-store";
import { useReconnectStore } from "../../state/connection-store";
import { conversationOf, isOpenInReader, replyTargetOf, useThreadStore } from "../../state/conversation-store";
import { releaseHeldRows } from "../../state/held-rows";
import { getVisibleKeys, useSelectionStore } from "../../state/selection-store";
import { useToastStore } from "../../state/toast-store";
import { useUiStore } from "../../state/ui-store";
import { ListPane } from "../list";
import { SHORTCUTS } from "../shell/shortcuts";
import { ReaderPane } from "./index";
import { THREAD_MESSAGE_ATTR, messageSelector, pinnedScrollTop } from "./thread";

/* Conversations end to end: the real list and reader panes against the fake
 * backend (the same shapes as client-api), over HTTP. jsdom has no layout, so
 * the virtualised list draws no rows: what the list holds is read from the
 * keys it publishes for j / k (the conversation heads). The reader is not
 * virtualised and is read from the DOM. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const day = (n: number, hour = 12) => `2026-10-${String(n).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`;
const INBOX: FolderRef = { role: "inbox" };
const ME = { name: "Me", email: "a@example.com" };

let host: HTMLDivElement;
let root: Root;
let backend: FakeBackend;
let api: HttpMailApi;
let stopRealtime = () => {};
let probe: MessageListResult | null = null;

const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
async function settle(ms = 30): Promise<void> {
  await wait(ms);
  let last = "";
  for (let quiet = 0, i = 0; quiet < 3 && i < 200; i++) {
    await wait(8);
    const now = `${backend.requests.length}|${getVisibleKeys().join(",")}|${host.innerHTML.length}`;
    quiet = now === last ? quiet + 1 : 0;
    last = now;
  }
}
const shown = () => [...getVisibleKeys()];
const select = async (key: MessageKey | null) => {
  await act(async () => useSelectionStore.getState().select(key));
  // Past the dwell after which the thread is asked for.
  await settle(260);
};
const items = () => [...host.querySelectorAll<HTMLElement>(`[${THREAD_MESSAGE_ATTR}]`)];
const itemKeys = () => items().map((li) => li.getAttribute(THREAD_MESSAGE_ATTR));
const head = (key: MessageKey) => host.querySelector<HTMLButtonElement>(`${messageSelector(key)} > button`)!;
const title = () => host.querySelector("main h1")?.textContent;
const expanded = () => items().map((li) => li.querySelector("button")?.getAttribute("aria-expanded") === "true");
const flagCalls = () => backend.calls("flag").map((c) => c.args);
const readIds = () => backend.calls("read").map((c) => c.args.message_id);
const click = (el: Element | null | undefined) => act(async () => void (el as HTMLElement | null)?.click());
const tool = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button')].find((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").startsWith(label));

function Probe() {
  probe = useMessageList({ scope: useSelectionStore((s) => s.scope), folder: INBOX });
  return null;
}

async function mount(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <section id="pane-list">
          <ListPane />
        </section>
        <main id="pane-reader" tabIndex={-1}>
          <ReaderPane />
        </main>
        <Probe />
      </QueryClientProvider>,
    );
  });
  await settle();
}

/** Mailbox a: one conversation across Inbox and Sent, a look-alike and a lone mail. */
function seed(): { r1: FakeMessage; r2: FakeMessage; r3: FakeMessage; r4: FakeMessage } {
  const r1 = fakeThreadMessage("r1", day(1), null, { subject: "Invoice", is_read: true, from: { name: "Maya Chen", email: "maya@x.example" } });
  const r2 = fakeThreadMessage("r2", day(2), r1, { subject: "Re: Invoice", is_read: true, folder: "Sent", from: ME, to: [{ name: "Maya Chen", email: "maya@x.example" }] });
  const r3 = fakeThreadMessage("r3", day(3), r2, { subject: "Re: Invoice", from: { name: "Maya Chen", email: "maya@x.example" } });
  const r4 = fakeThreadMessage("r4", day(4), r3, { subject: "Re: Invoice", from: { name: "Maya Chen", email: "maya@x.example" }, has_attachments: true });
  // The same subject from someone else, answering some other mail: NOT this conversation.
  const other = fakeThreadMessage("x1", day(2, 18), null, {
    subject: "Re: Invoice",
    from: { name: "Odd", email: "odd@y.example" },
    in_reply_to: "elsewhere@fake.mail",
    references: ["elsewhere@fake.mail"],
    thread_key: "m:elsewhere@fake.mail",
    is_read: true,
  });
  backend.add("a", r1, r2, r3, r4, other, fakeThreadMessage("l1", day(5), null, { is_read: true }));
  // Mailbox b holds a message with the SAME ids and key: another mailbox, another conversation.
  backend.add("b", { ...fakeThreadMessage("b1", day(6), r1, { is_read: true }) });
  return { r1, r2, r3, r4 };
}

beforeEach(async () => {
  backend = new FakeBackend([fakeInbox("a", "a@example.com", "imap"), fakeInbox("b", "b@example.com", "imap")]);
  const client = new ApiClient({
    baseUrl: "https://api.test/client-api",
    getToken: async () => "tok-1",
    refreshToken: async () => null,
    fetch: backend.fetch,
    sleep: async () => {},
    maxBatch: 1,
    socket: false,
  });
  api = new HttpMailApi({ client });
  setMailApi(api);
  queryClient.clear();
  releaseHeldRows();
  clearUndo();
  probe = null;
  useReconnectStore.setState({ inboxes: {} });
  useAssistantStore.getState().reset();
  useComposeStore.setState({ compose: null });
  useToastStore.getState().dismiss();
  useThreadStore.getState().clear();
  window.history.replaceState(null, "", "/all/inbox");
  resetRouterForTests();
  useSelectionStore.setState({ scope: "all", folder: INBOX, query: "", selectedKey: null, multiSel: [], ctxOff: false, ctxConversation: false });
  useUiStore.setState({ menu: null, viewport: "desktop", listHover: false, settings: { shortcutsEnabled: true, conversationView: true } });
  // jsdom has no matchMedia (the inline composer asks for reduced motion).
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  // ... and no element scrolling (the inline composer scrolls itself into view).
  Element.prototype.scrollTo ??= (() => {}) as typeof Element.prototype.scrollTo;
  stopRealtime = startRealtime();
  await api.getSession();
});

afterEach(async () => {
  stopRealtime();
  await act(async () => root.unmount());
  host.remove();
  setMailApi(null);
});

describe("conversations in the list", () => {
  it("one row per conversation, on its newest message; look-alikes and other mailboxes stay apart", async () => {
    seed();
    await mount();
    // r4 stands for r4 + r3 + r1 (r2 is in Sent, not in this list).
    expect(shown()).toEqual(["b:b1", "a:l1", "a:r4", "a:x1"]);
    const conv = conversationOf("a:r4")!;
    expect([conv.keys, conv.count, conv.unread, conv.hasAttachment]).toEqual([["a:r4", "a:r3", "a:r1"], 3, true, true]);
    expect(conversationOf("a:r1")).toBe(conv);
    // Same subject, no header link: its own conversation.
    expect(conversationOf("a:x1")?.keys).toEqual(["a:x1"]);
    // Same Message-IDs in another mailbox: never merged.
    expect(conversationOf("b:b1")?.keys).toEqual(["b:b1"]);
    // No extra round trip for the list: one `list` per mailbox, no `thread`.
    expect(backend.calls("list")).toHaveLength(2);
    expect(backend.calls("thread")).toHaveLength(0);
  });

  it("conversation view off: every email is its own row again, and the reader shows one message", async () => {
    seed();
    await mount();
    await act(async () => useUiStore.getState().setSetting("conversationView", false));
    await settle();
    expect(shown()).toEqual(["b:b1", "a:l1", "a:r4", "a:r3", "a:x1", "a:r1"]);
    expect(conversationKeys("a:r4")).toEqual(["a:r4"]);
    await select("a:r4");
    expect(items()).toHaveLength(0);
    expect(backend.calls("thread")).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem("mc-settings-v1") ?? "{}").conversationView).toBe(false);
    // The palette action turns it back on.
    await act(async () => SHORTCUTS.find((s) => s.id === "conversation-view")?.run());
    await settle();
    expect(shown()).toEqual(["b:b1", "a:l1", "a:r4", "a:x1"]);
  });

  it("paging: a conversation that spans pages has no duplicate and loses no row; its row stays where it was", async () => {
    const root1 = fakeThreadMessage("old-root", "2026-08-01T00:00:00Z", null, { is_read: true });
    backend.add("a", root1, fakeThreadMessage("new-reply", day(20), root1));
    for (let i = 0; i < 70; i++) backend.add("a", fakeThreadMessage(`f${i}`, `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00Z`, null));
    await act(async () => useSelectionStore.getState().setScope("a"));
    await mount();
    const first = shown();
    expect(first[0]).toBe("a:new-reply");
    expect(first).toHaveLength(50);
    expect(conversationOf("a:new-reply")?.keys).toEqual(["a:new-reply"]);
    const id = conversationOf("a:new-reply")?.id;

    await act(async () => probe?.fetchNextPage());
    await settle();
    const after = shown();
    // 72 messages, 71 rows: the root on page 2 joined the reply's row.
    expect(after).toHaveLength(71);
    expect(new Set(after).size).toBe(71);
    expect(after.slice(0, 50)).toEqual(first);
    expect(after).not.toContain("a:old-root");
    const conv = conversationOf("a:new-reply")!;
    expect([conv.keys, conv.id]).toEqual([["a:new-reply", "a:old-root"], id]);
    const members = after.flatMap((k) => conversationKeys(k));
    expect(new Set(members).size).toBe(72);
  });

  it("a reply that arrives while the pointer is on the list waits behind the pill; then it becomes the row, and the open conversation follows", async () => {
    const { r4 } = seed();
    await mount();
    await select("a:r4");
    await act(async () => useUiStore.getState().setListHover(true));
    const r5 = fakeThreadMessage("r5", day(7), r4, { subject: "Re: Invoice", from: { name: "Maya Chen", email: "maya@x.example" } });
    backend.add("a", r5);
    const rows = (await api.listMessages({ scope: "a", folder: INBOX, limit: 5 })).rows.filter((r) => r.id === "r5");
    await act(async () => api.emit({ type: "new_mail", rows }));
    await settle();
    // Held: nothing moved under the pointer.
    expect(shown()).toEqual(["b:b1", "a:l1", "a:r4", "a:x1"]);
    expect([...host.querySelectorAll("button")].some((b) => /1 new email$/.test(b.textContent ?? ""))).toBe(true);
    expect(useSelectionStore.getState().selectedKey).toBe("a:r4");

    await act(async () => useUiStore.getState().setListHover(false));
    await settle(320);
    // The conversation's row is now its newest message, at the top, same conversation.
    expect(shown()).toEqual(["a:r5", "b:b1", "a:l1", "a:x1"]);
    expect(conversationOf("a:r5")?.keys).toEqual(["a:r5", "a:r4", "a:r3", "a:r1"]);
    // The open conversation is still open, on its new row, and the reader kept its place.
    expect(useSelectionStore.getState().selectedKey).toBe("a:r5");
    expect(itemKeys()).toEqual(["a:r1", "a:r2", "a:r3", "a:r4", "a:r5"]);
    expect(useThreadStore.getState().focused).toBe("a:r4");
  });
});

describe("the thread view", () => {
  it("paints from the list's rows at once, then the thread op adds Sent without moving the focus or collapsing anything", async () => {
    seed();
    await mount();
    await act(async () => useSelectionStore.getState().select("a:r4"));
    // First paint: the three messages the list already holds, no request for them.
    expect(itemKeys()).toEqual(["a:r1", "a:r3", "a:r4"]);
    expect(backend.calls("thread")).toHaveLength(0);
    // Older read mail is a one-line header; the unread ones and the latest are open.
    expect(expanded()).toEqual([false, true, true]);
    expect(useThreadStore.getState().focused).toBe("a:r4");

    await settle(260);
    expect(backend.calls("thread").map((c) => c.args)).toEqual([{ message_id: "r4", thread_key: "m:r1@fake.mail" }]);
    // The Sent message is inserted where its date puts it, collapsed.
    expect(itemKeys()).toEqual(["a:r1", "a:r2", "a:r3", "a:r4"]);
    expect(expanded()).toEqual([false, false, true, true]);
    expect(useThreadStore.getState().focused).toBe("a:r4");
    expect(head("a:r2").textContent).toContain("me");
    // Bodies are read only for what is open (and, as always, for the list
    // rows next to the open one): never for a collapsed message.
    expect(readIds()).toEqual(expect.arrayContaining(["r3", "r4"]));
    expect(readIds()).not.toContain("r1");
    expect(readIds()).not.toContain("r2");
  });

  it("is a list of expandable items with their state, position and unread status exposed", async () => {
    seed();
    await mount();
    await select("a:r4");
    const list = host.querySelector("ol")!;
    expect(list.getAttribute("aria-label")).toBe("Conversation: 4 messages, oldest first");
    expect(list.children).toHaveLength(4);
    expect([...list.children].every((li) => li.tagName === "LI")).toBe(true);
    const closed = head("a:r1");
    expect(closed.getAttribute("aria-expanded")).toBe("false");
    expect(closed.hasAttribute("aria-controls")).toBe(false);
    expect(closed.textContent).toContain("Maya Chen");
    expect(closed.textContent).toContain("Preview r1");
    expect(closed.textContent).toContain("Message 1 of 4");
    const open = head("a:r4");
    expect(open.getAttribute("aria-expanded")).toBe("true");
    const region = document.getElementById(open.getAttribute("aria-controls") ?? "");
    expect(region?.parentElement).toBe(open.parentElement);
    // The body is the sandboxed frame of the ordinary reader.
    expect(region?.querySelector("iframe")?.getAttribute("srcdoc")).toContain("Body r4");
    expect(open.textContent).toContain("has attachment");
    expect(title()).toBe("Re: Invoice");
  });

  it("click or Enter toggles a message and loads its body then; n / p move the focus between messages; o toggles the focused one", async () => {
    seed();
    await mount();
    await select("a:r4");
    expect(readIds()).not.toContain("r1");
    await click(head("a:r1"));
    await settle();
    expect(head("a:r1").getAttribute("aria-expanded")).toBe("true");
    expect(readIds()).toContain("r1");
    expect(useThreadStore.getState().focused).toBe("a:r1");
    await click(head("a:r1"));
    expect(head("a:r1").getAttribute("aria-expanded")).toBe("false");

    const run = (id: string) => act(async () => SHORTCUTS.find((s) => s.id === id)?.run());
    expect(SHORTCUTS.find((s) => s.id === "thread-next")?.when?.()).toBe(true);
    await run("thread-next");
    expect(useThreadStore.getState().focused).toBe("a:r2");
    await run("thread-next");
    await run("thread-next");
    await run("thread-next"); // at the end: stays
    expect(useThreadStore.getState().focused).toBe("a:r4");
    await run("thread-previous");
    expect(useThreadStore.getState().focused).toBe("a:r3");
    await wait(30);
    // The focused message's header has the keyboard focus (Enter and Space toggle it natively).
    expect(document.activeElement).toBe(head("a:r3"));
    // `o` in the reader collapses / expands the focused message.
    await run("open");
    expect(head("a:r3").getAttribute("aria-expanded")).toBe("false");
    await run("open");
    expect(head("a:r3").getAttribute("aria-expanded")).toBe("true");
    // j / k still move in the list.
    await run("next");
    expect(useSelectionStore.getState().selectedKey).toBe("a:x1");
  });

  it("opening marks every unread message of the conversation read with ONE flag call; mark unread afterwards sticks", async () => {
    seed();
    await mount();
    await select("a:r4");
    expect(flagCalls()).toEqual([{ message_ids: ["r3", "r4"], read: true }]);
    expect(conversationOf("a:r4")?.unread).toBe(false);

    await click(tool("Mark unread"));
    await settle();
    // The whole conversation in this folder, one call; and it is not marked read again.
    expect(flagCalls()).toEqual([
      { message_ids: ["r3", "r4"], read: true },
      { message_ids: ["r4", "r3", "r1"], read: false },
    ]);
    expect(conversationOf("a:r4")?.unread).toBe(true);
  });

  it("a single message opens as before: no thread list, one flag call for it", async () => {
    seed();
    backend.messages.get("a")!.find((m) => m.id === "l1")!.is_read = false;
    await mount();
    await select("a:l1");
    expect(items()).toHaveLength(0);
    expect(title()).toBe("Subject l1");
    expect(flagCalls()).toEqual([{ message_ids: ["l1"], read: true }]);
    // The thread op still runs (a reply of ours could be in Sent) and finds only this message.
    expect(backend.calls("thread")).toHaveLength(1);
    expect(items()).toHaveLength(0);
  });

  it("the scroll arithmetic that keeps the focused message in place when messages are inserted above it", () => {
    // It sat 120 px below the top edge and now sits 176 px below: scroll 56 px further.
    expect(pinnedScrollTop(300, 120, 176)).toBe(356);
    expect(pinnedScrollTop(300, 120, 120)).toBe(300);
    expect(pinnedScrollTop(10, 120, 40)).toBe(0);
  });
});

describe("conversation actions", () => {
  it("archive takes the whole conversation in this folder with ONE call and ONE Undo, which brings every message back", async () => {
    seed();
    await mount();
    await select("a:r4");
    expect(conversationKeys("a:r4")).toEqual(["a:r4", "a:r3", "a:r1"]);
    await click(tool("Archive"));
    await settle();
    // Not r2: it is in Sent, outside the folder on screen.
    expect(backend.calls("archive").map((c) => c.args.message_ids)).toEqual([["r4", "r3", "r1"]]);
    expect(shown()).toEqual(["b:b1", "a:l1", "a:x1"]);
    expect(useSelectionStore.getState().selectedKey).toBe("a:x1");
    expect(useToastStore.getState().toast?.text).toBe("Archived 3 emails");
    expect(peekUndo()?.label).toBe("Archived 3 emails");

    await act(async () => void runUndo());
    await settle();
    expect(peekUndo()).toBeNull();
    expect(shown()).toEqual(["b:b1", "a:l1", "a:r4", "a:x1"]);
    expect(conversationOf("a:r4")?.keys).toEqual(["a:r4", "a:r3", "a:r1"]);
    expect(backend.messages.get("a")!.filter((m) => m.folder === "INBOX").map((m) => m.id).sort()).toEqual(["l1", "r1", "r3", "r4", "x1"]);
    expect(backend.messages.get("a")!.find((m) => m.id === "r2")?.folder).toBe("Sent");
  });

  it("delete and the e / # / s keys act on the conversation; star is any-starred, and toggles all", async () => {
    seed();
    await mount();
    await select("a:r4");
    const run = (id: string) => act(async () => SHORTCUTS.find((s) => s.id === id)?.run());
    await run("star");
    await settle();
    expect(backend.calls("flag").at(-1)?.args).toEqual({ message_ids: ["r4", "r3", "r1"], starred: true });
    expect(conversationOf("a:r4")?.starred).toBe(true);
    await run("star");
    await settle();
    expect(backend.calls("flag").at(-1)?.args).toEqual({ message_ids: ["r4", "r3", "r1"], starred: false });

    await run("trash");
    await settle();
    expect(backend.calls("delete").map((c) => c.args.message_ids)).toEqual([["r4", "r3", "r1"]]);
    expect(shown()).toEqual(["b:b1", "a:l1", "a:x1"]);
    expect(peekUndo()?.label).toBe("Moved 3 emails to Trash");
  });

  it("a message of the conversation in THIS folder on a page not loaded yet is part of the action, once the thread op has found it", async () => {
    const old = fakeThreadMessage("old-root", "2026-08-01T00:00:00Z", null, { is_read: true });
    const mine = fakeThreadMessage("my-answer", "2026-08-02T00:00:00Z", old, { is_read: true, folder: "Sent", from: ME });
    backend.add("a", old, mine, fakeThreadMessage("new-reply", day(20), mine, { is_read: true }));
    for (let i = 0; i < 60; i++) backend.add("a", fakeThreadMessage(`f${i}`, `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00Z`, null, { is_read: true }));
    await act(async () => useSelectionStore.getState().setScope("a"));
    await mount();
    // The first page holds the reply only: the root is on page two.
    expect(conversationKeys("a:new-reply")).toEqual(["a:new-reply"]);
    await select("a:new-reply");
    expect(conversationMessages("a:new-reply").map((r) => r.key)).toEqual(["a:old-root", "a:my-answer", "a:new-reply"]);
    // In scope: the Inbox messages. Not the answer in Sent.
    expect(conversationKeys("a:new-reply")).toEqual(["a:new-reply", "a:old-root"]);
    await click(tool("Archive"));
    await settle();
    expect(backend.calls("archive").map((c) => c.args.message_ids)).toEqual([["new-reply", "old-root"]]);
    expect(backend.messages.get("a")!.find((m) => m.id === "my-answer")?.folder).toBe("Sent");
  });

  it("Reply, Reply all and Forward act on the focused message (the latest by default), inline under the thread", async () => {
    seed();
    await mount();
    await select("a:r4");
    expect(replyTargetOf("a:r4")).toBe("a:r4");
    await click(tool("Reply"));
    expect(useComposeStore.getState().compose?.replyTo).toBe("a:r4");
    await act(async () => useComposeStore.setState({ compose: null }));

    // Focus an older message: the reply goes to it, and is still written under the open thread.
    await act(async () => useThreadStore.getState().focus("a:r3"));
    await click(tool("Reply"));
    const c = useComposeStore.getState().compose;
    expect([c?.replyTo, c?.mode]).toEqual(["a:r3", "reply"]);
    expect(isOpenInReader("a:r3", "a:r4")).toBe(true);
    expect(isOpenInReader("a:x1", "a:r4")).toBe(false);
    await act(async () => useComposeStore.setState({ compose: null }));

    // The key does the same.
    await act(async () => useThreadStore.getState().focus("a:r1"));
    await act(async () => SHORTCUTS.find((s) => s.id === "forward")?.run());
    expect([useComposeStore.getState().compose?.replyTo, useComposeStore.getState().compose?.mode]).toEqual(["a:r1", "forward"]);
  });
});
