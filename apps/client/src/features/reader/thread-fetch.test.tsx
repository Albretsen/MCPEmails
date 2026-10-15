import { QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMailApi } from "../../api";
import { ApiClient } from "../../api/http/client";
import { FakeBackend, type FakeMessage, fakeInbox, fakeThreadMessage } from "../../api/http/fake-backend";
import { HttpMailApi } from "../../api/http/http-mail-api";
import type { FolderRef, MessageKey, MessageThread } from "../../api/types";
import { resetRouterForTests } from "../../app/router";
import { THREAD_DWELL_MS } from "../../data/hooks";
import { keys } from "../../data/keys";
import { queryClient } from "../../data/query-client";
import { startRealtime } from "../../data/realtime";
import { clearUndo } from "../../data/undo";
import { useAssistantStore } from "../../state/assistant-store";
import { useComposeStore } from "../../state/compose-store";
import { useReconnectStore } from "../../state/connection-store";
import { conversationOf, useThreadStore } from "../../state/conversation-store";
import { releaseHeldRows } from "../../state/held-rows";
import { getVisibleKeys, useSelectionStore } from "../../state/selection-store";
import { useToastStore } from "../../state/toast-store";
import { useUiStore } from "../../state/ui-store";
import { ListPane } from "../list";
import { SHORTCUTS } from "../shell/shortcuts";
import { ReaderPane } from "./index";
import { THREAD_MESSAGE_ATTR } from "./thread";

/* When the reader asks for a conversation's `thread`: once per conversation
 * opened, only after the selection has rested, never for a conversation the
 * selection already left (that request is aborted), and what a partial answer
 * looks like. Same harness as threading.test.tsx: the real panes over HTTP
 * against the fake backend. The tests about time run on fake timers. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const day = (n: number, hour = 12) => `2026-10-${String(n).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`;
const INBOX: FolderRef = { role: "inbox" };
const ME = { name: "Me", email: "a@example.com" };
const MAYA = { name: "Maya Chen", email: "maya@x.example" };
const NOTE = "Some messages may be missing";
const OLD_NOTE = "Some folders could not be searched";

let host: HTMLDivElement;
let root: Root;
let backend: FakeBackend;
let api: HttpMailApi;
let stopRealtime = () => {};

const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
/** Real timers: until the requests and the DOM have gone quiet. */
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
/** Fake timers: `ms` pass, and everything due by then has run. (React applies
 *  what a timer set when `act` returns, and a request that starts then leaves
 *  on a zero timer: two more turns of no time let it reach the server.) */
const tick = async (ms: number) => {
  await act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  for (let i = 0; i < 2; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
};
const fakeTime = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
const selectNow = (key: MessageKey | null) => act(async () => useSelectionStore.getState().select(key));
const run = (id: string) => act(async () => SHORTCUTS.find((s) => s.id === id)?.run());
const threadIds = () => backend.calls("thread").map((c) => c.args.message_id);
const itemKeys = () => [...host.querySelectorAll<HTMLElement>(`[${THREAD_MESSAGE_ATTR}]`)].map((li) => li.getAttribute(THREAD_MESSAGE_ATTR));
const reader = () => host.querySelector("main")!;
const retryButton = () => [...reader().querySelectorAll("button")].find((b) => b.textContent?.trim() === "Retry");
const cached = (id: string) => queryClient.getQueryData<MessageThread>(keys.thread("a", id));

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
      </QueryClientProvider>,
    );
  });
  await settle();
}

/** Mailbox a: `n` conversations of two messages each (a mail in the Inbox and
 *  our answer in Sent). c1 is the newest: the first row of the list. */
function seedConversations(n: number): void {
  for (let i = 1; i <= n; i++) {
    const first = fakeThreadMessage(`c${i}`, day(20 - i), null, { subject: `Topic ${i}`, is_read: true, from: MAYA });
    backend.add("a", first, fakeThreadMessage(`c${i}-sent`, day(20 - i, 15), first, { subject: `Re: Topic ${i}`, is_read: true, folder: "Sent", from: ME, to: [MAYA] }));
  }
}

/** Mailbox a: one conversation of four (r2 in Sent) and a lone mail. */
function seedInvoice(): { r4: FakeMessage } {
  const r1 = fakeThreadMessage("r1", day(1), null, { subject: "Invoice", is_read: true, from: MAYA });
  const r2 = fakeThreadMessage("r2", day(2), r1, { subject: "Re: Invoice", is_read: true, folder: "Sent", from: ME, to: [MAYA] });
  const r3 = fakeThreadMessage("r3", day(3), r2, { subject: "Re: Invoice", is_read: true, from: MAYA });
  const r4 = fakeThreadMessage("r4", day(4), r3, { subject: "Re: Invoice", is_read: true, from: MAYA });
  backend.add("a", r1, r2, r3, r4, fakeThreadMessage("l1", day(5), null, { is_read: true }));
  return { r4 };
}

beforeEach(async () => {
  backend = new FakeBackend([fakeInbox("a", "a@example.com", "imap")]);
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
  window.history.replaceState(null, "", "/a/inbox");
  resetRouterForTests();
  useSelectionStore.setState({ scope: "a", folder: INBOX, query: "", selectedKey: null, multiSel: [], ctxOff: false, ctxConversation: false });
  useUiStore.setState({ menu: null, viewport: "desktop", listHover: false, settings: { shortcutsEnabled: true, conversationView: true } });
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollTo ??= (() => {}) as typeof Element.prototype.scrollTo;
  stopRealtime = startRealtime();
  await api.getSession();
});

afterEach(async () => {
  vi.useRealTimers();
  stopRealtime();
  await act(async () => root.unmount());
  host.remove();
  setMailApi(null);
});

describe("when the thread is asked for", () => {
  it("stepping quickly through N conversations with j asks only for the one the selection rests on; every row still paints at once", async () => {
    expect(THREAD_DWELL_MS).toBe(250);
    seedConversations(6);
    await mount();
    expect(getVisibleKeys()).toEqual(["a:c1", "a:c2", "a:c3", "a:c4", "a:c5", "a:c6"]);
    fakeTime();

    // j, five times, 100 ms apart: faster than the dwell.
    for (let i = 1; i <= 5; i++) {
      await run("next");
      expect(useSelectionStore.getState().selectedKey).toBe(`a:c${i}`);
      // Painted in the same frame, from the row the list holds: no waiting.
      expect(reader().querySelector("h1")?.textContent).toBe(`Topic ${i}`);
      await tick(100);
      expect(threadIds()).toEqual([]);
    }
    // Resting on c5. 100 ms have passed: not yet at 249 ms...
    await tick(THREAD_DWELL_MS - 101);
    expect(threadIds()).toEqual([]);
    // ...and asked for at 250 ms. One call, for c5 only.
    await tick(1);
    expect(backend.calls("thread").map((c) => c.args)).toEqual([{ message_id: "c5", thread_key: "m:c5@fake.mail" }]);
    // Its answer adds the message in Sent.
    await tick(20);
    expect(itemKeys()).toEqual(["a:c5", "a:c5-sent"]);

    // Back and forth again without resting (k, j, k): returning to a row does
    // not count the time spent on it before.
    await run("previous");
    await tick(200);
    await run("next");
    await tick(200);
    await run("previous");
    await tick(200);
    expect(threadIds()).toEqual(["c5"]);
    await tick(50);
    expect(threadIds()).toEqual(["c5", "c4"]);
  });

  it("a superseded request is aborted, and its late answer is not applied", async () => {
    seedConversations(3);
    await mount();
    fakeTime();
    backend.delayOp("thread", 1000);

    await selectNow("a:c1");
    await tick(THREAD_DWELL_MS + 50);
    // Out, and not answered yet.
    expect(threadIds()).toEqual(["c1"]);
    expect(backend.abortedCalls).toEqual([]);
    expect(queryClient.getQueryState(keys.thread("a", "m:c1@fake.mail"))?.fetchStatus).toBe("fetching");

    // The selection moves on: the request for c1 is cancelled at once.
    await selectNow("a:c2");
    await tick(0);
    expect(backend.abortedCalls.map((c) => [c.op, c.args.message_id])).toEqual([["thread", "c1"]]);
    expect(queryClient.getQueryState(keys.thread("a", "m:c1@fake.mail"))?.fetchStatus).toBe("idle");

    // c2 is asked for after its own dwell, and answers.
    await tick(THREAD_DWELL_MS + 50);
    expect(threadIds()).toEqual(["c1", "c2"]);
    await tick(3000);
    expect(backend.abortedCalls).toHaveLength(1);
    expect(cached("m:c2@fake.mail")?.rows.map((r) => r.key)).toEqual(["a:c2", "a:c2-sent"]);
    // Nothing of c1's answer landed: not in the cache, not on screen.
    expect(cached("m:c1@fake.mail")).toBeUndefined();
    expect(itemKeys()).toEqual(["a:c2", "a:c2-sent"]);
  });

  it("a transport that cannot cancel (the socket has no cancel frame): the late answer of a superseded request is dropped", async () => {
    seedConversations(2);
    await mount();
    // The transport ignores the signal entirely and answers late, whatever happened meanwhile.
    const late: Array<() => void> = [];
    const real = api.getThread.bind(api);
    const spy = vi.spyOn(api, "getThread").mockImplementation(async (key, opts) => {
      const answer = await real(key, opts);
      if (key === "a:c1") await new Promise<void>((r) => late.push(r));
      return answer;
    });

    await selectNow("a:c1");
    await settle(THREAD_DWELL_MS + 30);
    expect(spy).toHaveBeenCalledTimes(1);
    await selectNow("a:c2");
    await settle(THREAD_DWELL_MS + 30);
    expect(itemKeys()).toEqual(["a:c2", "a:c2-sent"]);
    // Now c1's answer arrives.
    await act(async () => late.forEach((r) => r()));
    await settle();
    expect(cached("m:c1@fake.mail")).toBeUndefined();
    expect(itemKeys()).toEqual(["a:c2", "a:c2-sent"]);
    expect(spy.mock.calls.map((c) => c[0])).toEqual(["a:c1", "a:c2"]);
  });

  it("one open conversation makes exactly one thread call: stepping between its messages, opening another of its messages, a reply becoming its row", async () => {
    const { r4 } = seedInvoice();
    await mount();
    await selectNow("a:r4");
    await settle(THREAD_DWELL_MS + 30);
    expect(threadIds()).toEqual(["r4"]);
    expect(itemKeys()).toEqual(["a:r1", "a:r2", "a:r3", "a:r4"]);

    // p, p, p, n: the focus moves between the messages.
    for (const id of ["thread-previous", "thread-previous", "thread-previous", "thread-next"]) {
      await run(id);
      await wait(40);
    }
    expect(useThreadStore.getState().focused).toBe("a:r2");
    // Expanding messages reads their bodies, never the thread again.
    await act(async () => useThreadStore.getState().expand("a:r1"));
    await settle(THREAD_DWELL_MS + 30);
    expect(threadIds()).toEqual(["r4"]);

    // Another message of the same conversation becomes the selection.
    await selectNow("a:r3");
    await settle(THREAD_DWELL_MS + 30);
    await selectNow("a:r4");
    await settle(THREAD_DWELL_MS + 30);
    expect(threadIds()).toEqual(["r4"]);

    // A reply arrives: the conversation's row is now r5 (a new anchor), same conversation.
    const r5 = fakeThreadMessage("r5", day(7), r4, { subject: "Re: Invoice", from: MAYA });
    backend.add("a", r5);
    const rows = (await api.listMessages({ scope: "a", folder: INBOX, limit: 5 })).rows.filter((r) => r.id === "r5");
    await act(async () => api.emit({ type: "new_mail", rows }));
    await settle(THREAD_DWELL_MS + 100);
    expect(useSelectionStore.getState().selectedKey).toBe("a:r5");
    expect(conversationOf("a:r5")?.head.key).toBe("a:r5");
    expect(itemKeys()).toEqual(["a:r1", "a:r2", "a:r3", "a:r4", "a:r5"]);
    expect(threadIds()).toEqual(["r4"]);

    // Leaving and coming back within the cache's freshness: still the one call.
    await selectNow("a:l1");
    await settle(THREAD_DWELL_MS + 30);
    await selectNow("a:r5");
    await settle(THREAD_DWELL_MS + 30);
    expect(threadIds()).toEqual(["r4", "l1"]);
  });
});

describe("a partial thread", () => {
  it.each(["rate_limited", "time_budget"])("%s: the messages that came back are shown, with a quiet note and Retry, which asks once more", async (reason) => {
    seedInvoice();
    backend.threadPartial = reason;
    await mount();
    await selectNow("a:r4");
    expect(reader().textContent).not.toContain(NOTE);
    await settle(THREAD_DWELL_MS + 30);
    expect(threadIds()).toEqual(["r4"]);
    // What came back is there (r2 is the one from Sent).
    expect(itemKeys()).toEqual(["a:r1", "a:r2", "a:r3", "a:r4"]);
    const note = retryButton()?.parentElement;
    expect(note?.tagName).toBe("P");
    expect(note?.textContent).toBe(`${NOTE}Retry`);
    expect(reader().textContent).not.toContain(OLD_NOTE);
    expect(reader().textContent).not.toContain("—");

    // Retry: exactly one more call. Still partial: the note stays.
    await act(async () => retryButton()?.click());
    await settle();
    expect(threadIds()).toEqual(["r4", "r4"]);
    expect(retryButton()).toBeDefined();

    // The server has caught up: one more call, and the note goes.
    backend.threadPartial = null;
    await act(async () => retryButton()?.click());
    await settle();
    expect(threadIds()).toEqual(["r4", "r4", "r4"]);
    expect(retryButton()).toBeUndefined();
    expect(reader().textContent).not.toContain(NOTE);
    expect(itemKeys()).toEqual(["a:r1", "a:r2", "a:r3", "a:r4"]);
  });

  it("a lone message whose thread came back rate limited gets the same note", async () => {
    seedInvoice();
    backend.threadPartial = "rate_limited";
    await mount();
    await selectNow("a:l1");
    await settle(THREAD_DWELL_MS + 30);
    expect(itemKeys()).toEqual([]);
    expect(reader().textContent).toContain(NOTE);
    await act(async () => retryButton()?.click());
    await settle();
    expect(threadIds()).toEqual(["l1", "l1"]);
  });

  it("no note for a whole answer, and none for the other reasons (they keep the line they had)", async () => {
    seedInvoice();
    await mount();
    await selectNow("a:r4");
    await settle(THREAD_DWELL_MS + 30);
    expect(cached("m:r1@fake.mail")?.partial).toBe(false);
    expect(reader().textContent).not.toContain(NOTE);
    expect(reader().textContent).not.toContain(OLD_NOTE);
    expect(retryButton()).toBeUndefined();

    for (const reason of ["limit", "folder_error", "candidates"]) {
      backend.threadPartial = reason;
      await act(async () => void (await queryClient.refetchQueries({ queryKey: keys.thread("a", "m:r1@fake.mail") })));
      await settle();
      expect(cached("m:r1@fake.mail")?.partial_reason).toBe(reason);
      expect(reader().textContent).not.toContain(NOTE);
      expect(retryButton()).toBeUndefined();
      expect(reader().textContent).toContain(OLD_NOTE);
    }
  });
});
