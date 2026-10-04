import { QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMailApi, setMailApi } from "../api";
import { setLatency } from "../api/mock/latency";
import { MockMailApi } from "../api/mock/mock-mail-api";
import type { MessageRow, SessionInfo, WorkspaceRole } from "../api/types";
import { resetRouterForTests } from "../app/router";
import { EMPTY_SESSION, useSessionStore } from "../auth/session-store";
import type { ListData } from "../data/cache";
import { keys, listMeta } from "../data/keys";
import { mailActions } from "../data/mail-actions";
import { queryClient } from "../data/query-client";
import { AssistantOverlays } from "../features/assistant/overlays";
import { openRow } from "../features/list/open-row";
import { actionItems } from "../features/palette/items";
import { ReaderPane } from "../features/reader";
import { SHORTCUTS, getShortcut, paletteActions, useGlobalShortcuts } from "../features/shell/shortcuts";
import { SidebarPane } from "../features/sidebar";
import { useAssistantStore } from "./assistant-store";
import { useComposeStore } from "./compose-store";
import { READ_ONLY_EXPLANATION, canWrite, guardWrite, refuseWrite } from "./permissions";
import { useSelectionStore } from "./selection-store";
import { useToastStore } from "./toast-store";
import { useUiStore } from "./ui-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function signInAs(role: WorkspaceRole | null): void {
  if (role == null) {
    useSessionStore.setState(EMPTY_SESSION);
    return;
  }
  const session = {
    user: { id: "u-1", email: "vera@example.com", display_name: "Vera" },
    workspaces: [{ id: "ws-1", display_name: "Acme", role, plan: "solo", web_client_enabled: true }],
    workspace_id: "ws-1",
    role,
    inboxes: [],
    allowance: {},
  } as unknown as SessionInfo;
  useSessionStore.setState({ session, status: "ready", fromCache: false, errorCode: null });
}

const toastText = () => useToastStore.getState().toast?.text ?? null;
const settle = (ms = 20) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

const WRITE_IDS = ["archive", "trash", "move", "reply", "reply-all", "forward", "star", "mark-unread", "mark-read", "compose", "send"];

function spyOnActions() {
  return {
    archive: vi.spyOn(mailActions, "archive").mockResolvedValue(),
    trash: vi.spyOn(mailActions, "trash").mockResolvedValue(),
    move: vi.spyOn(mailActions, "move").mockResolvedValue(),
    markRead: vi.spyOn(mailActions, "markRead").mockResolvedValue(),
    star: vi.spyOn(mailActions, "star").mockResolvedValue(),
    send: vi.spyOn(mailActions, "send").mockReturnValue(true),
    schedule: vi.spyOn(mailActions, "schedule").mockResolvedValue(true),
    saveDraft: vi.spyOn(mailActions, "saveDraft").mockResolvedValue(),
    newCompose: vi.spyOn(mailActions, "newCompose").mockImplementation(() => {}),
    startReply: vi.spyOn(mailActions, "startReply").mockImplementation(() => {}),
    openDraft: vi.spyOn(mailActions, "openDraft").mockResolvedValue(),
  };
}

let spies: ReturnType<typeof spyOnActions>;
const calls = () => Object.values(spies).reduce((n, s) => n + s.mock.calls.length, 0);

beforeEach(() => {
  setLatency({ read: [0, 0], write: [0, 0], failWrites: false });
  setMailApi(new MockMailApi("pro"));
  queryClient.clear();
  window.history.replaceState(null, "", "/all/inbox");
  resetRouterForTests();
  useSelectionStore.setState({ scope: "all", folder: { role: "inbox" }, query: "", selectedKey: "a:m1", multiSel: [] });
  useUiStore.setState({ menu: null, viewport: "desktop", settings: { shortcutsEnabled: true, conversationView: true } });
  useComposeStore.setState({ compose: null });
  useToastStore.getState().dismiss();
  signInAs(null);
  spies = spyOnActions();
});

afterEach(() => {
  vi.restoreAllMocks();
  signInAs(null);
  useAssistantStore.setState({ push: null });
});

describe("canWrite", () => {
  it("allows writing with no session (mock mode, or not loaded yet)", () => {
    expect(canWrite()).toBe(true);
  });

  it("allows every role except viewer", () => {
    for (const role of ["owner", "admin", "member", "something-new"]) {
      signInAs(role);
      expect(canWrite()).toBe(true);
    }
    signInAs("viewer");
    expect(canWrite()).toBe(false);
  });

  it("refuseWrite explains once to a viewer and stays silent otherwise", () => {
    expect(refuseWrite()).toBe(false);
    expect(toastText()).toBeNull();
    signInAs("viewer");
    expect(refuseWrite()).toBe(true);
    expect(toastText()).toBe(READ_ONLY_EXPLANATION);
  });

  it("guardWrite passes arguments through when writing is allowed", () => {
    const run = vi.fn();
    guardWrite(run)(1, "two");
    expect(run).toHaveBeenCalledWith(1, "two");
    signInAs("viewer");
    guardWrite(run)(3, "four");
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("shortcut registry", () => {
  it("marks exactly the actions that change or send mail", () => {
    expect(SHORTCUTS.filter((s) => s.write).map((s) => s.id).sort()).toEqual([...WRITE_IDS].sort());
  });

  it("viewer: no write shortcut reaches a mail action; each shows the explanation", () => {
    signInAs("viewer");
    useComposeStore.setState({ compose: { held: null, streaming: false } as never });
    for (const id of WRITE_IDS) {
      useToastStore.getState().dismiss();
      getShortcut(id)!.run();
      expect(toastText(), id).toBe(READ_ONLY_EXPLANATION);
    }
    expect(calls()).toBe(0);
    expect(useUiStore.getState().menu).toBeNull();
  });

  for (const role of ["member", null] as const) {
    it(`${role ?? "no session"}: write shortcuts call the mail actions as before`, () => {
      signInAs(role);
      for (const id of ["archive", "trash", "reply", "reply-all", "forward", "star", "mark-unread", "mark-read", "compose"]) getShortcut(id)!.run();
      expect(spies.archive).toHaveBeenCalledWith(["a:m1"]);
      expect(spies.trash).toHaveBeenCalledWith(["a:m1"]);
      expect(spies.startReply).toHaveBeenCalledTimes(3);
      expect(spies.star).toHaveBeenCalledTimes(1);
      expect(spies.markRead).toHaveBeenCalledWith(["a:m1"], false);
      expect(spies.markRead).toHaveBeenCalledWith(["a:m1"], true);
      expect(spies.newCompose).toHaveBeenCalledTimes(1);
      getShortcut("move")!.run();
      expect(useUiStore.getState().menu).toBe("move");
      expect(toastText()).toBeNull();
    });
  }

  it("viewer: navigation and the assistant shortcut are untouched", () => {
    signInAs("viewer");
    getShortcut("go-sent")!.run();
    expect(useSelectionStore.getState().folder).toEqual({ role: "sent" });
    getShortcut("help")!.run();
    expect(useUiStore.getState().menu).toBe("help");
    expect(toastText()).toBeNull();
  });
});

describe("command palette actions", () => {
  const item = (id: string) => actionItems(paletteActions(), () => "").find((i) => i.id === `action:${id}`)!;

  it("viewer: running a write item shows the explanation instead of acting", () => {
    signInAs("viewer");
    for (const id of ["archive", "trash", "reply", "star", "mark-unread", "compose"]) item(id).run();
    expect(calls()).toBe(0);
    expect(toastText()).toBe(READ_ONLY_EXPLANATION);
  });

  it("member: the same items act", () => {
    signInAs("member");
    item("archive").run();
    item("compose").run();
    expect(spies.archive).toHaveBeenCalledTimes(1);
    expect(spies.newCompose).toHaveBeenCalledTimes(1);
    expect(toastText()).toBeNull();
  });
});

describe("opening a draft row", () => {
  const draft = { key: "a:d1", folder_role: "drafts" } as unknown as MessageRow;

  it("opens the editor for a member and the reader for a viewer", () => {
    const editor = vi.spyOn(mailActions, "openRow").mockImplementation(() => {});
    signInAs("member");
    openRow(draft);
    expect(editor).toHaveBeenCalledTimes(1);
    signInAs("viewer");
    openRow(draft);
    expect(editor).toHaveBeenCalledTimes(1);
    expect(useSelectionStore.getState().selectedKey).toBe("a:d1");
  });
});

describe("rendered controls", () => {
  let host: HTMLDivElement;
  let root: Root;

  function Keys() {
    useGlobalShortcuts();
    return null;
  }

  async function mount(): Promise<void> {
    const page = await getMailApi().listMessages({ scope: "all", folder: { role: "inbox" }, limit: 50 });
    const unread = page.rows.find((m) => !m.is_read) ?? page.rows[0]!;
    // The list the row was opened from.
    queryClient.setQueryData<ListData>(keys.messages(listMeta("all", { role: "inbox" })), { pages: [page], pageParams: [null] });
    useSelectionStore.setState({ selectedKey: unread.key });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Keys />
          <SidebarPane />
          <ReaderPane />
          <AssistantOverlays />
        </QueryClientProvider>,
      );
    });
    await settle(60);
  }

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const toolbar = () => [...host.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button')];
  const press = (key: string) =>
    act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });

  it("viewer: write controls are disabled and say why; opening does not mark read", async () => {
    signInAs("viewer");
    useAssistantStore.setState({ push: { approval_id: "ap-1", text: "Send to Dana", draft: {} as never } });
    await mount();

    const compose = button("Compose")!;
    expect(compose.disabled).toBe(true);
    expect(compose.title).toBe(READ_ONLY_EXPLANATION);

    const badge = host.querySelector<HTMLElement>("[data-read-only]")!;
    expect(badge.textContent).toContain("Read-only");
    expect(badge.title).toBe(READ_ONLY_EXPLANATION);

    const tools = toolbar();
    expect(tools.length).toBe(7);
    for (const t of tools) {
      expect(t.disabled, t.textContent ?? "").toBe(true);
      expect(t.title).toBe(READ_ONLY_EXPLANATION);
    }

    const approve = [...host.querySelectorAll("button")].find((b) => b.textContent === "Approve")!;
    expect(approve.disabled).toBe(true);
    expect(approve.title).toBe(READ_ONLY_EXPLANATION);
    const review = [...host.querySelectorAll("button")].find((b) => b.textContent === "Review")!;
    expect(review.disabled).toBe(false);

    expect(spies.markRead).not.toHaveBeenCalled();

    // Real key events through the global handler.
    for (const key of ["e", "#", "r", "s", "u", "c"]) await press(key);
    expect(calls()).toBe(0);
    expect(toastText()).toBe(READ_ONLY_EXPLANATION);
  });

  it("member: the same controls are enabled, and opening marks read", async () => {
    signInAs("member");
    useAssistantStore.setState({ push: { approval_id: "ap-1", text: "Send to Dana", draft: {} as never } });
    await mount();

    expect(button("Compose")!.disabled).toBe(false);
    expect(host.querySelector("[data-read-only]")).toBeNull();
    const tools = toolbar();
    expect(tools.length).toBe(7);
    for (const t of tools) expect(t.disabled).toBe(false);
    expect([...host.querySelectorAll("button")].find((b) => b.textContent === "Approve")!.disabled).toBe(false);

    const key = useSelectionStore.getState().selectedKey;
    expect(spies.markRead).toHaveBeenCalledWith([key], true, { silent: true });

    await press("e");
    expect(spies.archive).toHaveBeenCalledWith([key]);
    expect(toastText()).toBeNull();
  });

  it("no session (mock mode): nothing is disabled", async () => {
    await mount();
    expect(button("Compose")!.disabled).toBe(false);
    expect(host.querySelector("[data-read-only]")).toBeNull();
    for (const t of toolbar()) expect(t.disabled).toBe(false);
  });
});
