import { create } from "zustand";
import { getRoute, navigate, subscribeRoute } from "../app/router";
import { type FolderRef, type MailboxScope, type MessageKey, sameFolderRef } from "../api/types";
import { useUiStore } from "./ui-store";

/* What the user is looking at: mailbox scope, folder, search, the open message
 * and the multi-selection. Kept in sync with the URL (see app/router.ts).
 *
 * Selection is synchronous and never waits for the network: `select` only
 * flips state, the reader paints from the list row and fills in the body.
 */

export interface SelectionState {
  scope: MailboxScope;
  folder: FolderRef;
  query: string;
  selectedKey: MessageKey | null;
  /** Rows ticked for the assistant. Empty unless two or more are selected. */
  multiSel: MessageKey[];
  /** The user removed the context chip: the assistant is asked about all mail. */
  ctxOff: boolean;
  /** The context chip carries the whole open conversation, not just the
   *  focused message. Back to one message for every newly opened row. */
  ctxConversation: boolean;

  select(key: MessageKey | null): void;
  /** Moves the selection by `dir` rows in the list currently on screen. */
  step(dir: 1 | -1): void;
  toggleMulti(key: MessageKey): void;
  clearMulti(): void;
  setCtxOff(off: boolean): void;
  setCtxConversation(whole: boolean): void;
  /** Switches folder (and optionally scope). Clears search and selection. */
  openFolder(folder: FolderRef, scope?: MailboxScope): void;
  /** Switches mailbox and lands on its inbox. */
  setScope(scope: MailboxScope): void;
  setQuery(query: string): void;
}

/* The ordered keys of the list on screen. Not state (nothing renders from it):
 * the list pane registers it so `step` and "select next after archive" work
 * without the store holding derived data. */
let visibleKeys: readonly MessageKey[] = [];

export function setVisibleKeys(keys: readonly MessageKey[]): void {
  visibleKeys = keys;
}
export function getVisibleKeys(): readonly MessageKey[] {
  return visibleKeys;
}

/** The key to select after `removed` leave the list: the next row, else the previous. */
export function neighbourAfterRemoval(removed: readonly MessageKey[], current: MessageKey | null): MessageKey | null {
  if (!current || !removed.includes(current)) return current;
  const gone = new Set(removed);
  const i = visibleKeys.indexOf(current);
  if (i < 0) return null;
  for (let j = i + 1; j < visibleKeys.length; j++) {
    const k = visibleKeys[j];
    if (k && !gone.has(k)) return k;
  }
  for (let j = i - 1; j >= 0; j--) {
    const k = visibleKeys[j];
    if (k && !gone.has(k)) return k;
  }
  return null;
}

const initial = getRoute();

export const useSelectionStore = create<SelectionState>((set, get) => ({
  scope: initial.scope,
  folder: initial.folder,
  query: initial.query,
  selectedKey: initial.messageKey,
  multiSel: [],
  ctxOff: false,
  ctxConversation: false,

  select: (key) => {
    const ui = useUiStore.getState();
    const phone = ui.viewport === "phone";
    const prev = get().selectedKey;
    set({ selectedKey: key, multiSel: [], ctxOff: false, ctxConversation: false });
    if (key) {
      // Phone: list -> reader pushes a history entry so Back returns to the list.
      // Desktop (and reader -> reader on phone): replace, so j/k does not flood history.
      navigate({ messageKey: key, compose: false }, { replace: !phone || prev != null });
      if (phone) ui.setScreen("reader");
    } else {
      navigate({ messageKey: null }, { replace: true });
      if (phone && ui.screen === "reader") ui.setScreen("list");
    }
    if (ui.menu) ui.setMenu(null);
  },

  step: (dir) => {
    if (!visibleKeys.length) return;
    const cur = get().selectedKey;
    const i = cur ? visibleKeys.indexOf(cur) : -1;
    const next = visibleKeys[Math.max(0, Math.min(visibleKeys.length - 1, i < 0 ? 0 : i + dir))];
    if (next && next !== cur) get().select(next);
  },

  toggleMulti: (key) => {
    const s = get();
    let m = s.multiSel.length ? [...s.multiSel] : s.selectedKey ? [s.selectedKey] : [];
    m = m.includes(key) ? m.filter((k) => k !== key) : [...m, key];
    set({ multiSel: m.length > 1 ? m : [], ctxOff: false });
  },

  clearMulti: () => {
    if (get().multiSel.length) set({ multiSel: [] });
  },

  setCtxOff: (ctxOff) => {
    if (get().ctxOff !== ctxOff) set({ ctxOff });
  },

  setCtxConversation: (ctxConversation) => {
    if (get().ctxConversation !== ctxConversation) set({ ctxConversation, ctxOff: false });
  },

  openFolder: (folder, scope) => {
    const s = get();
    const nextScope = scope ?? s.scope;
    const ui = useUiStore.getState();
    if (sameFolderRef(s.folder, folder) && nextScope === s.scope && !s.query) {
      if (ui.viewport === "phone") ui.setScreen("list");
      return;
    }
    set({ folder, scope: nextScope, query: "", selectedKey: null, multiSel: [], ctxOff: false, ctxConversation: false });
    navigate({ scope: nextScope, folder, query: "", messageKey: null, compose: false });
    ui.setScreen("list");
    if (ui.menu) ui.setMenu(null);
  },

  setScope: (scope) => get().openFolder({ role: "inbox" }, scope),

  setQuery: (query) => {
    if (get().query === query) return;
    set({ query, multiSel: [] });
    // Typing replaces: one history entry for the whole search, not one per keystroke.
    navigate({ query }, { replace: true });
  },
}));

/* URL -> store. Fires on Back/Forward only: our own navigations already set
 * the store before writing the URL. */
subscribeRoute((route, cause) => {
  if (cause !== "pop") return;
  useSelectionStore.setState({
    scope: route.scope,
    folder: route.folder,
    query: route.query,
    selectedKey: route.messageKey,
    multiSel: [],
  });
  const ui = useUiStore.getState();
  if (ui.viewport === "phone") ui.setScreen(route.compose ? "compose" : route.messageKey ? "reader" : "list");
});

/* ---- selectors ---- */
export const selectHasMulti = (s: SelectionState): boolean => s.multiSel.length > 1;
/** A per-row selector factory: true when this row is the open one or ticked. */
export const selectIsRowSelected =
  (key: MessageKey) =>
  (s: SelectionState): boolean =>
    s.multiSel.length > 1 ? s.multiSel.includes(key) : s.selectedKey === key;

/* A deep link straight to a message opens the reader on phone. */
if (initial.messageKey && useUiStore.getState().viewport === "phone") useUiStore.getState().setScreen("reader");
