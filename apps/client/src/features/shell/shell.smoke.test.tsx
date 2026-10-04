import { QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setMailApi } from "../../api";
import { setLatency } from "../../api/mock/latency";
import { MockMailApi } from "../../api/mock/mock-mail-api";
import { canGoBack, currentOverlay, resetRouterForTests } from "../../app/router";
import { queryClient } from "../../data/query-client";
import { useSelectionStore } from "../../state/selection-store";
import { useUiStore } from "../../state/ui-store";
import { PaletteHost } from "../palette";
import { AppShell } from "./AppShell";
import { SEARCH_INPUT_ATTR } from "./shell-context";

/* Mounts the real shell (with stub panes) in jsdom and drives it with real key
 * events: the registry, the global handler, the help dialog and the lazily
 * loaded palette working together. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = document.activeElement ?? document.body) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))));
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(async () => {
  setLatency({ read: [0, 0], write: [0, 0], failWrites: false });
  setMailApi(new MockMailApi("pro"));
  queryClient.clear();
  window.history.replaceState(null, "", "/all/inbox");
  resetRouterForTests();
  useSelectionStore.setState({ scope: "all", folder: { role: "inbox" }, query: "", selectedKey: null, multiSel: [] });
  useUiStore.setState({ menu: null, viewport: "desktop", settings: { shortcutsEnabled: true, conversationView: true } });
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <AppShell
          sidebar={<div>sidebar</div>}
          list={
            <div>
              <input {...{ [SEARCH_INPUT_ATTR]: "" }} aria-label="Search" />
              <div role="listbox" tabIndex={0} aria-label="Inbox" />
            </div>
          }
          reader={<div>reader</div>}
          compose={<div>compose</div>}
          assistant={<div>assistant</div>}
          overlays={<PaletteHost />}
        />
      </QueryClientProvider>,
    );
  });
  await settle();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("shell", () => {
  it("labels its landmarks and sets the document title", () => {
    expect(document.querySelector("nav")?.getAttribute("aria-label")).toBe("Mailboxes and folders");
    expect(document.querySelector("section#pane-list")?.getAttribute("aria-label")).toBe("Messages");
    expect(document.querySelector("main")?.getAttribute("aria-label")).toBe("Email");
    expect(document.querySelector("aside#pane-assistant")?.getAttribute("aria-label")).toBe("Assistant");
    expect(document.title).toMatch(/^Inbox( \(\d+\))? · mcpemails$/);
    for (const sep of document.querySelectorAll('[role="separator"]')) {
      expect(sep.getAttribute("aria-controls")).toBeTruthy();
      expect(sep.getAttribute("aria-valuenow")).toBeTruthy();
      expect(sep.getAttribute("tabindex")).toBe("0");
    }
    expect(document.querySelectorAll('[role="separator"]')).toHaveLength(3);
  });

  it("opens the help dialog with ?, traps focus in it, and closes with Esc giving focus back", async () => {
    const listbox = document.querySelector<HTMLElement>('[role="listbox"]')!;
    listbox.focus();
    await press("?", { shiftKey: true });
    const d = dialog()!;
    expect(d.getAttribute("aria-modal")).toBe("true");
    expect(d.textContent).toContain("Keyboard shortcuts");
    expect(d.textContent).toContain("Archive");
    expect(d.textContent).toContain("g then i");
    expect(d.contains(document.activeElement)).toBe(true);

    // Single keys do nothing while it is open.
    await press("c");
    expect(dialog()).not.toBeNull();

    await press("Escape");
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(listbox);
  });

  it("turns single-key shortcuts off from the dialog, and keeps them off", async () => {
    await press("?", { shiftKey: true }, document.body);
    const toggle = dialog()!.querySelector<HTMLInputElement>('input[role="switch"]')!;
    expect(toggle.checked).toBe(true);
    await act(async () => toggle.click());
    expect(useUiStore.getState().settings.shortcutsEnabled).toBe(false);
    await press("Escape");
    expect(dialog()).toBeNull();

    await press("?", { shiftKey: true }, document.body);
    expect(dialog()).toBeNull();
    await press("/", {}, document.body);
    expect(document.activeElement?.hasAttribute(SEARCH_INPUT_ATTR)).toBe(false);
  });

  it("focuses search with / but not while typing", async () => {
    await press("/", {}, document.body);
    const search = document.querySelector<HTMLInputElement>(`[${SEARCH_INPUT_ATTR}]`)!;
    expect(document.activeElement).toBe(search);
    await press("?", { shiftKey: true });
    expect(dialog()).toBeNull();
    await press("Escape");
    expect(document.activeElement).not.toBe(search);
  });

  it("goes to a folder with a g sequence", async () => {
    await press("g", {}, document.body);
    expect(document.body.textContent).toContain("g…");
    await press("t", {}, document.body);
    expect(useSelectionStore.getState().folder).toEqual({ role: "sent" });
    expect(window.location.pathname).toBe("/all/sent");
    expect(document.body.textContent).not.toContain("g…");
  });

  it("cycles panes with F6 and Shift+F6", async () => {
    const order = () => document.activeElement?.closest("[id^='pane-']")?.id;
    await press("F6", {}, document.body);
    expect(order()).toBe("pane-sidebar");
    await press("F6");
    expect(order()).toBe("pane-list");
    expect(document.activeElement?.getAttribute("role")).toBe("listbox");
    await press("F6");
    expect(order()).toBe("pane-reader");
    await press("F6", { shiftKey: true });
    expect(order()).toBe("pane-list");
  });
});

describe("phone", () => {
  const toPhone = async () => {
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    await act(async () => void window.dispatchEvent(new Event("resize")));
    await settle();
  };
  const listPane = () => document.getElementById("pane-list")!;

  it("keeps the list mounted but inert under the reader, and Back returns to it", async () => {
    await toPhone();
    expect(useUiStore.getState().viewport).toBe("phone");
    expect(document.querySelector("nav")).toBeNull();
    expect(listPane().hasAttribute("inert")).toBe(false);
    expect(document.querySelector("main")).toBeNull();

    const before = window.history.length;
    await act(async () => useSelectionStore.getState().select("gmail:x"));
    expect(window.history.length).toBe(before + 1);
    expect(useUiStore.getState().screen).toBe("reader");
    expect(listPane().hasAttribute("inert")).toBe(true);
    expect(listPane().getAttribute("aria-hidden")).toBe("true");
    expect(listPane().querySelector('[role="listbox"]')).not.toBeNull();
    expect(document.querySelector("main")).not.toBeNull();

    await act(async () => window.history.back());
    await settle();
    expect(useUiStore.getState().screen).toBe("list");
    expect(useSelectionStore.getState().selectedKey).toBeNull();
    expect(listPane().hasAttribute("inert")).toBe(false);
  });

  it("closes the full-screen chat with Back", async () => {
    await toPhone();
    const url = window.location.href;
    expect(currentOverlay()).toBeNull();
    await act(async () => useUiStore.getState().setChatFull(true));
    // Its own history entry, on the same URL.
    expect(currentOverlay()).toBe("chat");
    expect(canGoBack()).toBe(true);
    expect(window.location.href).toBe(url);

    await act(async () => window.history.back());
    await settle();
    expect(currentOverlay()).toBeNull();
    expect(useUiStore.getState().chatFull).toBe(false);
    expect(useUiStore.getState().screen).toBe("list");

    // Closed from the UI instead: the entry is dropped, so Back is not left pointing at it.
    await act(async () => useUiStore.getState().setChatFull(true));
    expect(currentOverlay()).toBe("chat");
    await act(async () => useUiStore.getState().setChatFull(false));
    await settle();
    expect(currentOverlay()).toBeNull();
    expect(useUiStore.getState().chatFull).toBe(false);
  });
});

describe("command palette", () => {
  const open = async () => {
    await press("k", { ctrlKey: true }, document.body);
    // First open: a focused placeholder (aria-busy) stands in until the chunk loads.
    for (let i = 0; i < 20 && (!dialog() || dialog()?.getAttribute("aria-busy")); i++) await settle();
    return dialog()!;
  };
  const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  const selected = () => document.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');

  it("opens with Ctrl+K as a combobox + listbox and closes with Esc, giving focus back", async () => {
    const listbox = document.querySelector<HTMLElement>('#pane-list [role="listbox"]')!;
    listbox.focus();
    const d = await open();
    const input = d.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-controls")).toBe(d.querySelector('[role="listbox"]')?.id);
    expect(input.getAttribute("aria-activedescendant")).toBe(selected()?.id);
    expect(d.textContent).toContain("Actions");
    expect(d.textContent).toContain("Go to");
    expect(options().length).toBeGreaterThan(5);

    await press("Escape");
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(listbox);
  });

  it("filters as you type, moves with the arrows and runs the choice", async () => {
    const d = await open();
    const input = d.querySelector<HTMLInputElement>("input")!;
    await type(input, "sent");
    expect(selected()?.textContent).toContain("Sent");
    const labels = options().map((o) => o.textContent ?? "");
    expect(labels.at(-2)).toContain("Search for “sent”");
    expect(labels.at(-1)).toContain("Ask: sent");

    await press("End");
    expect(selected()?.textContent).toContain("Ask: sent");
    await press("Home");
    await press("ArrowDown");
    await press("ArrowUp");
    expect(selected()?.textContent).toContain("Sent");
    expect(input.getAttribute("aria-activedescendant")).toBe(selected()?.id);
    // Tab stays in the palette.
    await press("Tab");
    expect(document.activeElement).toBe(input);

    await press("Enter");
    await settle();
    expect(dialog()).toBeNull();
    expect(useSelectionStore.getState().folder).toEqual({ role: "sent" });
  });

  it("searches mail when nothing else matches", async () => {
    const d = await open();
    await type(d.querySelector<HTMLInputElement>("input")!, "zzqx invoice");
    expect(options().map((o) => o.textContent)).toEqual(["Search for “zzqx invoice”", "Ask: zzqx invoice"]);
    await press("Enter");
    await settle();
    expect(useSelectionStore.getState().query).toBe("zzqx invoice");
  });

  it("toggles closed with Ctrl+K", async () => {
    await open();
    await press("k", { ctrlKey: true });
    expect(dialog()).toBeNull();
  });
});
