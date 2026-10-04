import { QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setMailApi } from "../../api";
import { ApiClient } from "../../api/http/client";
import { FakeBackend, fakeInbox, fakeMessage } from "../../api/http/fake-backend";
import { HttpMailApi } from "../../api/http/http-mail-api";
import { INBOX_NOTICE } from "../../api/inbox-health";
import { resetRouterForTests } from "../../app/router";
import type { FolderEntry, FolderRef } from "../../api/types";
import { refreshLists } from "../../data/cache";
import { type MessageListResult, useMessageList } from "../../data/hooks";
import { keys } from "../../data/keys";
import { queryClient } from "../../data/query-client";
import { startRealtime } from "../../data/realtime";
import { useAssistantStore } from "../../state/assistant-store";
import { useReconnectStore } from "../../state/connection-store";
import { releaseHeldRows } from "../../state/held-rows";
import { getVisibleKeys, useSelectionStore } from "../../state/selection-store";
import { useUiStore } from "../../state/ui-store";
import { SidebarPane } from "../sidebar";
import { ListPane } from "./index";

/* The unified list and the sidebar, mounted for real against the fake
 * backend: rows as each mailbox answers, the "still loading" mark, rows held
 * behind the pill while the pointer is on the list, and a mailbox that is
 * down or fails mid-session saying so without taking the others' rows away.
 * (jsdom has no layout, so the virtualiser draws no rows: what the list holds
 * is read from the keys it publishes for j/k.) */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const day = (n: number) => `2026-10-${String(n).padStart(2, "0")}T12:00:00Z`;
/** One object: the hook keys its work on the folder's identity. */
const INBOX: FolderRef = { role: "inbox" };

let host: HTMLDivElement;
let root: Root;
let backend: FakeBackend;
let api: HttpMailApi;
let stopRealtime = () => {};

const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
/** Waits until nothing moves any more (requests, rows, markup), however long
 *  the machine takes to get there: at least `ms`, then three quiet looks. */
async function settle(ms = 20): Promise<void> {
  await wait(ms);
  let last = "";
  for (let quiet = 0, i = 0; quiet < 3 && i < 200; i++) {
    await wait(8);
    const now = `${backend.requests.length}|${getVisibleKeys().join(",")}|${host.innerHTML.length}|${queryClient.isMutating()}`;
    quiet = now === last ? quiet + 1 : 0;
    last = now;
  }
}
const text = () => host.textContent ?? "";
const pendingMark = () => host.querySelector<HTMLElement>('[title^="Still loading"]');
const notice = () => [...host.querySelectorAll<HTMLElement>('[role="status"]')].map((n) => n.textContent ?? "");
const pill = () => [...host.querySelectorAll("button")].find((b) => /new emails?$/.test(b.textContent ?? ""));
const shown = () => getVisibleKeys();
const callsTo = (id: string) => backend.calls().filter((c) => c.inbox_id === id).length;

async function mount(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SidebarPane />
        <ListPane />
      </QueryClientProvider>,
    );
  });
}

/** What app/backend.ts does with a `/session` answer, as far as panes care. */
async function reloadSession(): Promise<void> {
  await act(async () => {
    const s = await api.getSession();
    useReconnectStore.setState({ inboxes: {} });
    queryClient.setQueryData(keys.inboxes, s.inboxes);
    refreshLists();
  });
  await settle();
}

beforeEach(async () => {
  backend = new FakeBackend([fakeInbox("a", "a@example.com"), fakeInbox("b", "b@example.com"), fakeInbox("c", "c@example.com")]);
  backend.add("a", fakeMessage("m1", day(9)), fakeMessage("m2", day(5)));
  backend.add("b", fakeMessage("n1", day(7)), fakeMessage("n2", day(3)));
  backend.add("c", fakeMessage("o1", day(8)));
  const client = new ApiClient({
    baseUrl: "https://api.test/client-api",
    getToken: async () => "tok-1",
    refreshToken: async () => null,
    fetch: backend.fetch,
    sleep: async () => {},
    // One request per call, as on the socket (a batch would answer as one).
    maxBatch: 1,
    socket: false,
    onInboxAuth: (id, refused) => {
      const cur = { ...useReconnectStore.getState().inboxes };
      if (refused) cur[id] = true;
      else delete cur[id];
      useReconnectStore.setState({ inboxes: cur });
    },
  });
  api = new HttpMailApi({ client });
  setMailApi(api);
  queryClient.clear();
  releaseHeldRows();
  useReconnectStore.setState({ inboxes: {} });
  useAssistantStore.getState().reset();
  window.history.replaceState(null, "", "/all/inbox");
  resetRouterForTests();
  useSelectionStore.setState({ scope: "all", folder: { role: "inbox" }, query: "", selectedKey: null, multiSel: [] });
  useUiStore.setState({ menu: null, viewport: "desktop", listHover: false });
  stopRealtime = startRealtime();
  await api.getSession();
});

afterEach(async () => {
  stopRealtime();
  await act(async () => root.unmount());
  host.remove();
  setMailApi(null);
});

describe("unified inbox: rows as each mailbox answers", () => {
  it("shows the mailboxes that answered, marks the one still loading, and merges it in date order when it arrives", async () => {
    const release = backend.holdInbox("b");
    await mount();
    await settle();
    // a and c are on screen; nothing waits for b.
    expect(shown()).toEqual(["a:m1", "c:o1", "a:m2"]);
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
    expect(pendingMark()?.title).toBe("Still loading b@example.com");
    // Not a claim of completeness: no "3 emails".
    expect(text()).not.toMatch(/\b3 emails\b/);

    await act(async () => release());
    await settle();
    expect(shown()).toEqual(["a:m1", "c:o1", "b:n1", "a:m2", "b:n2"]);
    expect(pendingMark()).toBeNull();
  });

  it("with nothing to show yet it is loading, never 'Nothing in your inbox'", async () => {
    const releaseA = backend.holdInbox("a");
    const releaseB = backend.holdInbox("b");
    backend.messages.set("c", []);
    await mount();
    await settle();
    // c answered with no mail; a and b are still out.
    expect(shown()).toEqual([]);
    expect(text()).not.toContain("Nothing in your inbox");
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    await act(async () => {
      releaseA();
      releaseB();
    });
    await settle();
    expect(shown()).toEqual(["a:m1", "b:n1", "a:m2", "b:n2"]);
  });

  it("while the pointer is on the list a late mailbox waits behind the pill; leaving the list lets it in", async () => {
    const release = backend.holdInbox("b");
    await mount();
    await settle();
    expect(shown()).toEqual(["a:m1", "c:o1", "a:m2"]);

    await act(async () => useUiStore.getState().setListHover(true));
    await act(async () => release());
    await settle();
    // Nothing moved under the pointer.
    expect(shown()).toEqual(["a:m1", "c:o1", "a:m2"]);
    expect(pill()?.textContent).toBe("2 new emails");
    expect(pendingMark()).toBeNull();

    await act(async () => useUiStore.getState().setListHover(false));
    await settle(320);
    expect(shown()).toEqual(["a:m1", "c:o1", "b:n1", "a:m2", "b:n2"]);
    expect(pill()).toBeUndefined();
  });

  it("the pill itself shows them", async () => {
    const release = backend.holdInbox("b");
    await mount();
    await settle();
    await act(async () => useUiStore.getState().setListHover(true));
    await act(async () => release());
    await settle();
    await act(async () => pill()?.click());
    expect(shown()).toEqual(["a:m1", "c:o1", "b:n1", "a:m2", "b:n2"]);
  });

  it("a refresh keeps the rows of a mailbox that has not answered again yet", async () => {
    await mount();
    await settle();
    expect(shown()).toHaveLength(5);
    backend.add("a", fakeMessage("m3", day(10)));
    const release = backend.holdInbox("b");
    await act(async () => refreshLists());
    await settle();
    // a's new mail is in; b's rows from the earlier load are still there.
    expect(shown()).toEqual(["a:m3", "a:m1", "c:o1", "b:n1", "a:m2", "b:n2"]);
    expect(pendingMark()?.title).toBe("Still loading b@example.com");
    await act(async () => release());
    await settle();
    expect(shown()).toEqual(["a:m3", "a:m1", "c:o1", "b:n1", "a:m2", "b:n2"]);
    expect(pendingMark()).toBeNull();
  });
});

describe("folder roles from the server", () => {
  const folderButtons = () =>
    [...host.querySelectorAll<HTMLElement>('ul[aria-labelledby="nav-folders"] button')].map((b) => b.getAttribute("title") ?? "");
  const folderCount = (label: string) =>
    [...host.querySelectorAll<HTMLElement>('ul[aria-labelledby="nav-folders"] button')]
      .find((b) => b.getAttribute("title") === label)
      ?.querySelector('[aria-hidden="true"]:not(svg)')?.textContent ?? null;

  /** Outlook: ids say nothing and the names are in the account's language. */
  const outlook = () => {
    backend.systemFolders = {
      inbox: { id: "AAMkAD-1", name: "Innboks" },
      sent: { id: "AAMkAD-2", name: "Sendte elementer" },
      archive: { id: "AAMkAD-3", name: "Arkiv" },
      trash: { id: "AAMkAD-4", name: "Slettede elementer" },
      drafts: { id: "AAMkAD-5", name: "Kladd" },
      spam: { id: "AAMkAD-6", name: "Søppelpost" },
    };
    backend.messages.clear();
    for (const id of ["a", "b", "c"]) backend.messages.set(id, []);
    backend.add("a", fakeMessage("m1", day(9), { folder: "AAMkAD-1" }), fakeMessage("s1", day(8), { folder: "AAMkAD-2", is_read: true }));
    backend.add("b", fakeMessage("n1", day(7), { folder: "AAMkAD-1" }), fakeMessage("t1", day(6), { folder: "AAMkAD-2", is_read: true }));
    backend.customFolders.set("a", [{ id: "AAMkAD-9", name: "Kvitteringer", type: "folder", total_messages: 0, unread_messages: 0 }]);
  };

  it("opaque ids and localised names: the system folders are found by role, only the person's own folders are listed as theirs", async () => {
    outlook();
    await mount();
    await settle();
    // Not "Innboks", "Kladd"... as if they were folders the person made.
    expect(folderButtons()).toEqual(["Inbox", "Starred", "Drafts", "Scheduled", "Sent", "Archive", "Trash", "Spam", "Kvitteringer"]);
    // Counts come from each mailbox's real inbox folder.
    expect(folderCount("Inbox")).toBe("2");
    expect(shown()).toEqual(["a:m1", "b:n1"]);
  });

  it("the unified Sent view lists every mailbox's real Sent folder, and its rows know their role", async () => {
    outlook();
    await api.listFolders("a");
    await api.listFolders("b");
    const sent = await api.listMessages({ scope: "all", folder: { role: "sent" }, limit: 50 });
    expect(sent.rows.map((r) => [r.key, r.folder, r.folder_role])).toEqual([
      ["a:s1", "AAMkAD-2", "sent"],
      ["b:t1", "AAMkAD-2", "sent"],
    ]);
    // A search row has no listing to tell its role by: the folder list does.
    const found = await api.searchMessages({ scope: "a", query: "Subject", limit: 50 });
    expect(found.rows.map((r) => [r.id, r.folder_role])).toEqual([
      ["m1", "inbox"],
      ["s1", "sent"],
    ]);
  });

  it("a server that does not send roles yet: names and ids are matched as before", async () => {
    backend.folderRoles = false;
    backend.customFolders.set("a", [{ id: "Receipts", name: "Receipts", type: "folder", total_messages: 0, unread_messages: 0 }]);
    await mount();
    await settle();
    const entries = queryClient.getQueryData<FolderEntry[]>(keys.folders("a")) ?? [];
    expect(entries.every((f) => !("role" in f))).toBe(true);
    expect(folderButtons()).toEqual(["Inbox", "Starred", "Drafts", "Scheduled", "Sent", "Archive", "Trash", "Spam", "Receipts"]);
    expect(folderCount("Inbox")).toBe("5");
  });
});

describe("unified inbox: a mailbox that is down or fails", () => {
  it("a mailbox the session calls down: badge and notice from the session alone, the others listed, nothing asked of it", async () => {
    backend.setInboxStatus("b", "reconnect_required", "password_refused");
    await api.getSession();
    await mount();
    await settle();
    expect(shown()).toEqual(["a:m1", "c:o1", "a:m2"]);
    expect(callsTo("b")).toBe(0);
    // Sidebar: the reason, per mailbox, and where to fix it.
    expect(notice()).toContain(`b@example.com: ${INBOX_NOTICE.password_refused} Reconnect`);
    expect(host.querySelector<HTMLElement>('button[title^="b@example.com."]')?.title).toBe(`b@example.com. ${INBOX_NOTICE.password_refused}`);
    // List: the same reason above the rows of the others.
    expect(notice()).toContain(`b@example.com: ${INBOX_NOTICE.password_refused} The other mailboxes are shown.Reconnect`);
    expect(pendingMark()).toBeNull();
  });

  it("says what each reason means, and offers Reconnect only where reconnecting helps", async () => {
    backend.setInboxStatus("b", "reconnect_required", "access_revoked");
    await api.getSession();
    await mount();
    await settle();
    expect(notice()).toContain(`b@example.com: ${INBOX_NOTICE.access_revoked} Reconnect`);

    backend.setInboxStatus("b", "error", "no_mailbox");
    await reloadSession();
    expect(notice()).toContain("b@example.com: This mailbox is unavailable.");
    expect(notice()).toContain("b@example.com: This mailbox is unavailable. The other mailboxes are shown.");
    expect(shown()).toEqual(["a:m1", "c:o1", "a:m2"]);

    // Send-as only: mail works, so no badge, no notice, and its mail is listed.
    backend.setInboxStatus("b", "reconnect_required", "sender_identity");
    await reloadSession();
    expect(notice().filter((n) => n.includes("b@example.com"))).toEqual([]);
    expect(shown()).toEqual(["a:m1", "c:o1", "b:n1", "a:m2", "b:n2"]);

    // Two down: counted, each with its own reason on its row.
    backend.setInboxStatus("b", "reconnect_required", "password_refused");
    backend.setInboxStatus("c", "reconnect_required", "access_revoked");
    await reloadSession();
    expect(notice()).toContain("2 mailboxes need reconnecting. Reconnect");
    expect(notice()).toContain("2 mailboxes need reconnecting. The other mailboxes are shown.Reconnect");
    expect(shown()).toEqual(["a:m1", "a:m2"]);
    expect(text()).not.toContain("—");
  });

  it("a mailbox that starts failing mid-session shows its notice and hides no row of the healthy ones", async () => {
    await mount();
    await settle();
    expect(shown()).toEqual(["a:m1", "c:o1", "b:n1", "a:m2", "b:n2"]);
    expect(notice().join("")).not.toContain("b@example.com");

    // A provider error: worth a retry.
    backend.failNext({ op: "list", inbox_id: "b" }, { code: "provider_error", message: "imap exploded", retryable: false }, 1);
    await act(async () => refreshLists());
    await settle();
    expect(shown()).toEqual(["a:m1", "c:o1", "a:m2"]);
    expect(notice()).toContain("Could not load b@example.com. The other mailboxes are shown.Retry");
    expect(text()).not.toContain("imap exploded");
    expect(text()).not.toContain("Could not load this list");
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Retry")?.click());
    await settle();
    expect(shown()).toEqual(["a:m1", "c:o1", "b:n1", "a:m2", "b:n2"]);
    expect(notice().join("")).not.toContain("Could not load");

    // Its credentials are refused from now on (the session has not said so yet).
    backend.setInboxStatus("b", "reconnect_required", "password_refused");
    await act(async () => refreshLists());
    await settle();
    expect(shown()).toEqual(["a:m1", "c:o1", "a:m2"]);
    expect(notice()).toContain(`b@example.com: ${INBOX_NOTICE.generic} The other mailboxes are shown.Reconnect`);
    expect(notice()).toContain(`b@example.com: ${INBOX_NOTICE.generic} Reconnect`);
    // Once the session says why, its copy replaces the generic one.
    await reloadSession();
    expect(notice()).toContain(`b@example.com: ${INBOX_NOTICE.password_refused} The other mailboxes are shown.Reconnect`);
    expect(shown()).toEqual(["a:m1", "c:o1", "a:m2"]);
  });

  it("a mailbox that fails on a later page is named too, and the pages already shown stay", async () => {
    for (let i = 0; i < 60; i++) backend.add("a", fakeMessage(`x${i}`, `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00Z`));
    for (let i = 0; i < 60; i++) backend.add("b", fakeMessage(`y${i}`, `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:30:00Z`));
    // The list's own hook, a second time: its `fetchNextPage` is what the
    // list calls when its end comes within reach (jsdom draws no rows).
    let probe: MessageListResult | null = null;
    function Probe() {
      probe = useMessageList({ scope: "all", folder: INBOX });
      return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ListPane />
          <Probe />
        </QueryClientProvider>,
      );
    });
    await settle();
    const first = [...shown()];
    expect(first.length).toBeGreaterThan(0);
    expect((probe as MessageListResult | null)?.hasNextPage).toBe(true);

    backend.failNext({ op: "list", inbox_id: "b" }, { code: "provider_error", message: "boom", retryable: false }, 1);
    await act(async () => (probe as MessageListResult | null)?.fetchNextPage());
    await settle();
    const after = shown();
    // More rows, the first page untouched above them, nothing twice.
    expect(after.length).toBeGreaterThan(first.length);
    expect(after.slice(0, first.length)).toEqual(first);
    expect(new Set(after).size).toBe(after.length);
    expect(after.slice(first.length).every((k) => !k.startsWith("b:"))).toBe(true);
    expect(notice()).toContain("Could not load b@example.com. The other mailboxes are shown.Retry");
  });
});
