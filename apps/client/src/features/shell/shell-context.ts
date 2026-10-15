import { createContext, useContext } from "react";
import { type Layout, computeLayout } from "./layout";

/** What panes may need to know about the frame they are rendered in. */
export interface ShellInfo {
  layout: Layout;
  phone: boolean;
  /** Sidebar is the icon rail: hide labels. */
  rail: boolean;
  /** Reader toolbar has room for text labels. */
  toolbarLabels: boolean;
  /** Width available to the assistant's transcript, for fitting chips. */
  assistantWidth: number;
}

const fallback = computeLayout(1440, { sideW: null, listW: null, panelW: null }, {
  panelOpen: true,
  panelForced: false,
  hasSelection: false,
});

export const ShellContext = createContext<ShellInfo>({
  layout: fallback,
  phone: false,
  rail: false,
  toolbarLabels: true,
  assistantWidth: fallback.panel,
});

export function useShell(): ShellInfo {
  return useContext(ShellContext);
}

/** DOM ids of the four panes (aria-controls on splitters, F6 cycling). */
export const PANE_ID = {
  sidebar: "pane-sidebar",
  list: "pane-list",
  reader: "pane-reader",
  assistant: "pane-assistant",
} as const;

/** Elements other code needs to find without prop drilling. */
export const SEARCH_INPUT_ATTR = "data-search-input";
export const ASSISTANT_INPUT_ATTR = "data-assistant-input";

export function focusSearch(): void {
  document.querySelector<HTMLElement>(`[${SEARCH_INPUT_ATTR}]`)?.focus();
}
export function focusAssistantInput(): void {
  document.querySelector<HTMLElement>(`[${ASSISTANT_INPUT_ATTR}]`)?.focus();
}

/** Focuses a pane for F6 and "skip to messages". The list's tab stop is its
 *  listbox (arrows move inside it); other panes take focus themselves. */
export function focusPane(id: string): void {
  const pane = document.getElementById(id);
  if (!pane) return;
  const target = id === PANE_ID.list ? (pane.querySelector<HTMLElement>('[role="listbox"]') ?? pane) : pane;
  target.focus();
}

/** ui-store menu ids owned by the shell. Menus are mutually exclusive, so the
 *  Esc ladder and "one thing open at a time" come for free. */
export const SHELL_MENU = { help: "help", palette: "palette", notifications: "notifications" } as const;
