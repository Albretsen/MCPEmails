import { QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setMailApi } from "../../api";
import { ApiClient } from "../../api/http/client";
import { FakeBackend, type FakeMessage, fakeInbox, fakeThreadMessage } from "../../api/http/fake-backend";
import { HttpMailApi } from "../../api/http/http-mail-api";
import type { FolderRef, MessageKey } from "../../api/types";
import { openDeepLink } from "../../app/route-sync";
import { resetRouterForTests } from "../../app/router";
import { conversationKeys } from "../../data/conversation-scope";
import { queryClient } from "../../data/query-client";
import { startRealtime } from "../../data/realtime";
import { clearUndo, peekUndo, runUndo } from "../../data/undo";
import { useAssistantStore } from "../../state/assistant-store";
import { useComposeStore } from "../../state/compose-store";
import { useReconnectStore } from "../../state/connection-store";
import { conversationOf, useThreadStore } from "../../state/conversation-store";
import { releaseHeldRows } from "../../state/held-rows";
import { getVisibleKeys, useSelectionStore } from "../../state/selection-store";
import { useToastStore } from "../../state/toast-store";
import { useUiStore } from "../../state/ui-store";
import { Composer } from "../assistant/Composer";
import { ListPane } from "../list";
import { SHORTCUTS } from "../shell/shortcuts";
import { ReaderPane } from "./index";
import { THREAD_MESSAGE_ATTR } from "./thread";

/* Where conversations meet the features that were there before them and the
 * ones that landed beside them: the phone assistant dock, push deep links,
 * Undo on a server that renumbers moved mail, the progressive unified inbox,
 * and new mail for a conversation already on screen. Same harness as
 * threading.test.tsx: the real panes over HTTP against the fake backend. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const day = (n: number, hour = 12) => `2026-10-${String(n).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`;
const INBOX: FolderRef = { role: "inbox" };
const ME = { name: "Me", email: "a@example.com" };
const MAYA = { name: "Maya Chen", email: "maya@x.example" };

let host: HTMLDivElement;
let root: Root;
let backend: FakeBackend;
let api: HttpMailApi;
let stopRealtime = () => {};

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
  await settle(260);
};
const itemKeys = () => [...host.querySelectorAll<HTMLElement>(`[${THREAD_MESSAGE_ATTR}]`)].map((li) => li.getAttribute(THREAD_MESSAGE_ATTR));
const click = (el: Element | null | undefined) => act(async () => void (el as HTMLElement | null)?.click());
const tool = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button')].find((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").startsWith(label));
const dock = () => host.querySelector<HTMLElement>("#dock")!;
const dockButtons = () => [...dock().querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");
const chip = () => dock().querySelector('[role="group"]');
const placeholder = () => dock().querySelector("textarea")?.getAttribute("placeholder");

async function mount(options: { phone?: boolean } = {}): Promise<void> {
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
        <div id="dock">
          <Composer phone={options.phone === true} compact={options.phone === true} />
        </div>
      </QueryClientProvider>,
    );
  });
  await settle();
}

/** Mailbox a: Maya's conversation across Inbox and Sent, and a lone mail. */
function seed(): { r1: FakeMessage; r2: FakeMessage; r3: FakeMessage; r4: FakeMessage } {
  const r1 = fakeThreadMessage("r1", day(1), null, { subject: "Invoice", is_read: true, from: MAYA });
  const r2 = fakeThreadMessage("r2", day(2), r1, { subject: "Re: Invoice", is_read: true, folder: "Sent", from: ME, to: [MAYA] });
  const r3 = fakeThreadMessage("r3", day(3), r2, { subject: "Re: Invoice", is_read: true, from: MAYA });
  const r4 = fakeThreadMessage("r4", day(4), r3, { subject: "Re: Invoice", is_read: true, from: MAYA });
  backend.add("a", r1, r2, r3, r4, fakeThreadMessage("l1", day(5), null, { is_read: true, from: { name: "Lone Sender", email: "lone@y.example" } }));
  backend.add("b", fakeThreadMessage("b1", day(6), null, { is_read: true }));
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
  useReconnectStore.setState({ inboxes: {} });
  useAssistantStore.getState().reset();
  useComposeStore.setState({ compose: null });
  useToastStore.getState().dismiss();
  useThreadStore.getState().clear();
  window.history.replaceState(null, "", "/all/inbox");
  resetRouterForTests();
  useSelectionStore.setState({ scope: "all", folder: INBOX, query: "", selectedKey: null, multiSel: [], ctxOff: false, ctxConversation: false });
  useUiStore.setState({ menu: null, viewport: "desktop", screen: "list", chatFull: false, listHover: false, settings: { shortcutsEnabled: true, conversationView: true } });
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollTo ??= (() => {}) as typeof Element.prototype.scrollTo;
  stopRealtime = startRealtime();
  await api.getSession();
});

afterEach(async () => {
  stopRealtime();
  await act(async () => root.unmount());
  host.remove();
  setMailApi(null);
  useUiStore.setState({ viewport: "desktop", screen: "list", chatFull: false });
});

describe("phone: the assistant dock follows the screen that is showing", () => {
  it("on the list there are no per-message actions and no chip for the last opened email; on the reader they are back", async () => {
    seed();
    useUiStore.setState({ viewport: "phone", screen: "list" });
    await mount({ phone: true });

    // Nothing opened yet: the dock is about all mail.
    expect(dockButtons()).not.toContain("Summarize");
    expect(chip()).toBeNull();

    await select("a:l1");
    expect(useUiStore.getState().screen).toBe("reader");
    expect(dockButtons()).toEqual(expect.arrayContaining(["Draft a reply", "Summarize"]));
    expect(chip()?.getAttribute("aria-label")).toContain("Lone Sender");
    expect(placeholder()).toBe("Ask about Lone's email…");

    // Back to the list. The selection stays (it restores the position) ...
    await act(async () => useUiStore.getState().setScreen("list"));
    await settle();
    expect(useSelectionStore.getState().selectedKey).toBe("a:l1");
    // ... but the email is not on screen, so nothing in the dock is about it.
    expect(dockButtons()).not.toContain("Draft a reply");
    expect(dockButtons()).not.toContain("Summarize");
    expect(chip()).toBeNull();
    expect(dock().textContent).not.toContain("Lone Sender");
    expect(placeholder()).toBe("Ask about all your mail…");
    // The starters for an empty chat are what the list screen offers.
    expect(dockButtons()).toContain("What needs a reply?");

    // The reader again: the same email, its actions and its chip.
    await act(async () => useUiStore.getState().setScreen("reader"));
    await settle();
    expect(dockButtons()).toEqual(expect.arrayContaining(["Draft a reply", "Summarize"]));
    expect(chip()?.getAttribute("aria-label")).toContain("Lone Sender");
  });

  it("an open conversation: no chip and no 'whole conversation' control on the list screen; a multi-selection still shows", async () => {
    seed();
    useUiStore.setState({ viewport: "phone", screen: "list" });
    await mount({ phone: true });
    await select("a:r4");
    expect(dockButtons().some((t) => /^The whole conversation \(\d+\)$/.test(t))).toBe(true);

    await act(async () => useUiStore.getState().setScreen("list"));
    await settle();
    expect(chip()).toBeNull();
    expect(dockButtons().some((t) => /whole conversation|focused message/.test(t))).toBe(false);
    expect(dockButtons()).not.toContain("Summarize");

    // A multi-selection is made ON the list: its chip belongs there.
    await act(async () => useSelectionStore.setState({ multiSel: ["a:l1", "b:b1"] }));
    await settle();
    expect(chip()?.getAttribute("aria-label")).toContain("2 emails");
    expect(dockButtons()).not.toContain("Summarize");
  });

  it("desktop is unchanged: list and reader are both on screen, so the open email keeps its actions", async () => {
    seed();
    await mount();
    await select("a:l1");
    expect(useUiStore.getState().screen).toBe("list");
    expect(dockButtons()).toEqual(expect.arrayContaining(["Draft a reply", "Summarize"]));
    expect(chip()?.getAttribute("aria-label")).toContain("Lone Sender");
  });
});

describe("a push notification's deep link", () => {
  /** The path the server puts in a rich notification (client-api push/notify.ts `mailboxUrl`). */
  const mailboxUrl = (inboxId: string, messageId?: string) => {
    const base = `/${encodeURIComponent(inboxId)}/inbox`;
    return messageId ? `${base}/${encodeURIComponent(`${inboxId}:${messageId}`)}` : base;
  };
  const open = async (path: string) => {
    await act(async () => openDeepLink({ url: `${window.location.origin}${path}`, action: null }));
    await settle(260);
  };

  it("for the newest message opens the whole conversation in that mailbox, with that message focused", async () => {
    seed();
    await mount();
    await open(mailboxUrl("a", "r4"));
    expect(useSelectionStore.getState().scope).toBe("a");
    expect(useSelectionStore.getState().selectedKey).toBe("a:r4");
    expect(itemKeys()).toEqual(["a:r1", "a:r2", "a:r3", "a:r4"]);
    expect(useThreadStore.getState().focused).toBe("a:r4");
    expect(conversationOf("a:r4")?.keys).toEqual(["a:r4", "a:r3", "a:r1"]);
  });

  it("for a message that is NOT the conversation's row (a newer reply arrived since) still opens that conversation", async () => {
    seed();
    await mount();
    // The notification was about r3; by the time it is tapped r4 is the row.
    await open(mailboxUrl("a", "r3"));
    expect(shown()).toEqual(["a:l1", "a:r4"]);
    expect(itemKeys()).toEqual(["a:r1", "a:r2", "a:r3", "a:r4"]);
    // The conversation is open and its row is the one marked as open in the list.
    const selected = useSelectionStore.getState().selectedKey!;
    expect(conversationOf(selected)?.keys).toEqual(["a:r4", "a:r3", "a:r1"]);
    // Acting on it takes the conversation, not one stray message.
    expect(conversationKeys(selected)).toEqual(["a:r4", "a:r3", "a:r1"]);
  });

  it("on phone lands on the reader screen; a mailbox-only link lands on the list", async () => {
    seed();
    useUiStore.setState({ viewport: "phone", screen: "list" });
    await mount({ phone: true });
    await open(mailboxUrl("a", "r4"));
    expect(useUiStore.getState().screen).toBe("reader");
    expect(dockButtons()).toContain("Summarize");

    await open(mailboxUrl("b"));
    expect(useSelectionStore.getState().scope).toBe("b");
    expect(useUiStore.getState().screen).toBe("list");
    expect(dockButtons()).not.toContain("Summarize");
  });
});

describe("Undo of a conversation action on a server that renumbers moved mail", () => {
  it("archive then Undo: every message comes back under its NEW id as one conversation, and the next action uses those ids", async () => {
    seed();
    backend.renumberOnMove = true;
    await mount();
    await select("a:r4");
    await click(tool("Archive"));
    await settle();
    expect(backend.calls("archive").map((c) => c.args.message_ids)).toEqual([["r4", "r3", "r1"]]);
    expect(shown()).toEqual(["b:b1", "a:l1"]);
    expect(peekUndo()?.label).toBe("Archived 3 emails");

    await act(async () => void runUndo());
    await settle(320);
    expect(peekUndo()).toBeNull();
    const inboxIds = backend.messages.get("a")!.filter((m) => m.folder === "INBOX").map((m) => m.id);
    expect(inboxIds).toHaveLength(4);
    // One row for the conversation again, between the other two.
    const rows = shown();
    expect(rows).toHaveLength(3);
    const headKey = rows.find((k) => k !== "b:b1" && k !== "a:l1")!;
    const conv = conversationOf(headKey)!;
    expect(conv.count).toBe(3);
    // Every key the client now holds names a message the server has.
    for (const key of conv.keys) expect(inboxIds).toContain(key.slice(2));

    // Acting again addresses the ids the server gave back, in one call.
    await select(headKey);
    const run = (id: string) => act(async () => SHORTCUTS.find((s) => s.id === id)?.run());
    await run("star");
    await settle();
    const starred = backend.calls("flag").filter((c) => c.args.starred === true).at(-1)!.args.message_ids as string[];
    expect([...starred].sort()).toEqual(conv.keys.map((k) => k.slice(2)).sort());
    for (const id of starred) expect(inboxIds).toContain(id);
  });
});

describe("the unified inbox filling in, and new mail, with conversations", () => {
  it("a mailbox that answers late adds its rows without regrouping or reordering the conversation already shown", async () => {
    seed();
    const release = backend.holdInbox("b");
    await mount();
    // Mailbox a is on screen while b is still loading.
    expect(shown()).toEqual(["a:l1", "a:r4"]);
    await select("a:r4");
    expect(itemKeys()).toEqual(["a:r1", "a:r2", "a:r3", "a:r4"]);

    await act(async () => release());
    await settle(320);
    expect(shown()).toEqual(["b:b1", "a:l1", "a:r4"]);
    // The open conversation is untouched by the other mailbox arriving.
    expect(useSelectionStore.getState().selectedKey).toBe("a:r4");
    expect(conversationOf("a:r4")?.keys).toEqual(["a:r4", "a:r3", "a:r1"]);
    expect(itemKeys()).toEqual(["a:r1", "a:r2", "a:r3", "a:r4"]);
  });

  it("new mail for a conversation on screen: one row, never two; count and unread follow; the reader gains the message", async () => {
    const { r4 } = seed();
    await mount();
    await select("a:r4");
    const before = backend.calls("thread").length;
    const r5 = fakeThreadMessage("r5", day(7), r4, { subject: "Re: Invoice", from: MAYA });
    backend.add("a", r5);
    const rows = (await api.listMessages({ scope: "a", folder: INBOX, limit: 5 })).rows.filter((r) => r.id === "r5");
    await act(async () => api.emit({ type: "new_mail", rows }));
    await settle(320);

    // Exactly one row stands for the conversation, whichever message heads it.
    const convRows = shown().filter((k) => conversationOf(k)?.keys.includes("a:r1"));
    expect(convRows).toHaveLength(1);
    const conv = conversationOf(convRows[0]!)!;
    expect(conv.keys).toEqual(["a:r5", "a:r4", "a:r3", "a:r1"]);
    expect(conv.count).toBe(4);
    // It arrived in the conversation that is open: it is marked read on the
    // server, and the row agrees with the server (never read in one place only).
    const markedRead = backend.calls("flag").some((c) => c.args.read === true && (c.args.message_ids as string[]).includes("r5"));
    expect(conv.unread).toBe(!markedRead);
    expect(backend.messages.get("a")!.find((m) => m.id === "r5")?.is_read).toBe(markedRead);
    // The other rows kept their relative order.
    expect(shown().filter((k) => !convRows.includes(k))).toEqual(["b:b1", "a:l1"]);
    // The open conversation is still the open one, and shows the new message.
    expect(conversationOf(useSelectionStore.getState().selectedKey!)).toBe(conv);
    expect(itemKeys()).toEqual(["a:r1", "a:r2", "a:r3", "a:r4", "a:r5"]);
    expect(useThreadStore.getState().focused).toBe("a:r4");
    expect(backend.calls("thread").length).toBeGreaterThanOrEqual(before);
  });
});
