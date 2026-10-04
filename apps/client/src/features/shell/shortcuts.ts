import { useEffect, useSyncExternalStore } from "react";
import type { FolderRole, MessageKey } from "../../api/types";
import { findRow } from "../../data/cache";
import { conversationStarred, expandToConversations } from "../../data/conversation-scope";
import { mailActions } from "../../data/mail-actions";
import { isMac, isTypingTarget } from "../../lib/platform";
import { useAssistantStore } from "../../state/assistant-store";
import { useComposeStore } from "../../state/compose-store";
import { replyTargetOf } from "../../state/conversation-store";
import { canWrite, guardWrite } from "../../state/permissions";
import { getVisibleKeys, useSelectionStore } from "../../state/selection-store";
import { selectAssistantVisible, useUiStore } from "../../state/ui-store";
import {
  IDLE,
  type KeyInput,
  type MatchState,
  SEQUENCE_TIMEOUT_MS,
  type Shortcut,
  ariaKeyShortcuts,
  formatKeys,
  matchShortcut,
} from "./keymap";
import { openRow } from "../list/open-row";
import { focusInReader, stepThread, threadIsOpen, toggleFocusedMessage } from "../reader/thread";
import { ASSISTANT_INPUT_ATTR, PANE_ID, SHELL_MENU, focusAssistantInput, focusPane, focusSearch } from "./shell-context";

/* The keyboard system. ONE registry (SHORTCUTS) drives three things, so they
 * cannot drift apart:
 *   - the global key handler (useGlobalShortcuts)
 *   - the help dialog (HelpDialog.tsx)
 *   - the "Actions" section of the command palette (features/palette)
 *
 * Matching rules live in keymap.ts (pure, unit-tested): single-character
 * shortcuts never fire while typing or with a modifier held and can be switched
 * off (settings.shortcutsEnabled, WCAG 2.1.4); nothing fires during IME
 * composition; only j / k repeat when held.
 *
 * Nothing here triggers an animation: these are the user's own actions, and
 * motion is reserved for changes the assistant or the server makes.
 */

/* ------------------------------------------------------------------
 * What the actions operate on
 * ------------------------------------------------------------------ */

/** The rows the action is for: the ticked ones, else the open one. */
function selectedRows(): MessageKey[] {
  const s = useSelectionStore.getState();
  if (s.multiSel.length > 1) return s.multiSel;
  return s.selectedKey ? [s.selectedKey] : [];
}
/** Archive, delete, move, star and mark read / unread act on whole
 *  conversations: every message of each selected row's conversation that is
 *  in the folder on screen. */
function targets(): MessageKey[] {
  return expandToConversations(selectedRows());
}
const hasTargets = (): boolean => selectedRows().length > 0;
const openKey = (): MessageKey | null => useSelectionStore.getState().selectedKey;
const hasOpen = (): boolean => openKey() != null;
/** Reply, Reply all and Forward act on ONE message: the focused message of
 *  the open thread (the latest by default). */
const replyKey = (): MessageKey => replyTargetOf(openKey()) as MessageKey;

/** After archive / trash / move the next row is selected by the action itself.
 *  This keeps keyboard focus in the list instead of letting it fall to <body>
 *  when the control that had it (a reader toolbar button) went away. */
function keepFocusInList(): void {
  setTimeout(() => {
    const a = document.activeElement;
    if (!a || a === document.body || !document.contains(a)) focusPane(PANE_ID.list);
  }, 0);
}

/** ⌘J: open and focus the assistant; pressed again while its input has focus, hide it. */
export function focusAssistant(): void {
  const ui = useUiStore.getState();
  if (ui.menu) ui.setMenu(null);
  const visible = selectAssistantVisible(ui);
  const active = document.activeElement as HTMLElement | null;
  if (visible && active?.hasAttribute(ASSISTANT_INPUT_ATTR)) {
    ui.togglePanel();
    // The input is about to go away: keep focus in the app, not on <body>.
    focusPane(PANE_ID.list);
    return;
  }
  if (ui.viewport === "phone") ui.setChatFull(true);
  else if (!ui.panelOpen) ui.setPanelOpen(true);
  else if (!visible) ui.forcePanel();
  setTimeout(focusAssistantInput, 40);
}

function cyclePane(back: boolean): void {
  const ids = [PANE_ID.sidebar, PANE_ID.list, PANE_ID.reader, PANE_ID.assistant];
  const panes = ids.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => !!el && !el.inert);
  if (!panes.length) return;
  const cur = panes.findIndex((el) => el.contains(document.activeElement));
  const next = panes[(cur + (back ? -1 : 1) + panes.length) % panes.length];
  if (next) focusPane(next.id);
}

/** Enter / o: open the selected email (the first one if none is) and move to the reader. */
function openSelected(): void {
  // In the reader, on a thread: `o` expands or collapses the focused message.
  if (focusInReader() && toggleFocusedMessage()) return;
  const selection = useSelectionStore.getState();
  const key = selection.selectedKey ?? getVisibleKeys()[0] ?? null;
  if (!key) return;
  const row = findRow(key);
  if (row && row.key !== selection.selectedKey) openRow(row);
  else if (!selection.selectedKey) selection.select(key);
  if (useUiStore.getState().viewport !== "phone") setTimeout(() => focusPane(PANE_ID.reader), 0);
}

/** The Esc ladder, in the prototype's order: close a menu, stop the assistant,
 *  save and close compose, leave the field. Then the two app-level layers the
 *  prototype did not have: the full-screen chat on phone and a multi-selection. */
function escape(target: EventTarget | null): void {
  const ui = useUiStore.getState();
  const assistant = useAssistantStore.getState();
  const c = useComposeStore.getState().compose;
  const typing = isTypingTarget(target);
  if (ui.menu) ui.setMenu(null);
  else if (assistant.busy && !c?.held) assistant.stop();
  else if (c && !c.held && !typing) {
    // A read-only member cannot save: just close what is open.
    if (canWrite()) void mailActions.saveDraft();
    else useComposeStore.getState().discard();
  }
  else if (typing) (target as HTMLElement).blur();
  else if (ui.viewport === "phone" && ui.chatFull) ui.setChatFull(false);
  else if (useSelectionStore.getState().multiSel.length) useSelectionStore.getState().clearMulti();
}

function sendOrApprove(): void {
  const c = useComposeStore.getState().compose;
  if (!c) return;
  if (c.held) void useAssistantStore.getState().resolveApproval("approve");
  else if (!c.streaming) mailActions.send(c);
}

function goTo(role: FolderRole): () => void {
  return () => useSelectionStore.getState().openFolder({ role });
}

/** The target of the key event being handled (Esc needs it). */
let eventTarget: EventTarget | null = null;

/* ------------------------------------------------------------------
 * The registry
 * ------------------------------------------------------------------ */

/* Entries marked `write` change mail or send it. Their `run` is wrapped below,
 * so the key handler, the palette and anything else that runs a registered
 * shortcut shows a read-only member the explanation instead of acting. */
const REGISTRY: readonly Shortcut[] = [
  // ---- Navigation
  { id: "next", keys: ["j", "ArrowDown"], label: "Next email", group: "Navigation", repeat: true, palette: false, run: () => useSelectionStore.getState().step(1) },
  { id: "previous", keys: ["k", "ArrowUp"], label: "Previous email", group: "Navigation", repeat: true, palette: false, run: () => useSelectionStore.getState().step(-1) },
  { id: "open", keys: ["Enter", "o"], label: "Open email", group: "Navigation", palette: false, when: () => hasOpen() || getVisibleKeys().length > 0, run: openSelected },
  { id: "thread-next", keys: ["n"], label: "Next message in the conversation", group: "Navigation", palette: false, when: threadIsOpen, run: () => stepThread(1) },
  { id: "thread-previous", keys: ["p"], label: "Previous message in the conversation", group: "Navigation", palette: false, when: threadIsOpen, run: () => stepThread(-1) },
  { id: "search", keys: ["/"], label: "Search mail", group: "Navigation", run: focusSearch },
  { id: "pane-next", keys: ["F6"], label: "Next pane", group: "Navigation", palette: false, run: () => cyclePane(false) },
  { id: "pane-previous", keys: ["Shift+F6"], label: "Previous pane", group: "Navigation", palette: false, run: () => cyclePane(true) },

  // ---- Email
  {
    id: "archive",
    write: true,
    keys: ["e"],
    label: "Archive",
    group: "Email",
    when: hasTargets,
    run: () => {
      void mailActions.archive(targets());
      keepFocusInList();
    },
  },
  {
    id: "trash",
    write: true,
    keys: ["#"],
    label: "Move to Trash",
    group: "Email",
    when: hasTargets,
    run: () => {
      void mailActions.trash(targets());
      keepFocusInList();
    },
  },
  { id: "move", write: true, keys: ["v"], label: "Move to folder", group: "Email", when: hasTargets, run: () => useUiStore.getState().setMenu("move") },
  { id: "reply", write: true, keys: ["r"], label: "Reply", group: "Email", when: hasOpen, run: () => mailActions.startReply(replyKey(), "reply") },
  { id: "reply-all", write: true, keys: ["a"], label: "Reply all", group: "Email", when: hasOpen, run: () => mailActions.startReply(replyKey(), "reply_all") },
  { id: "forward", write: true, keys: ["f"], label: "Forward", group: "Email", when: hasOpen, run: () => mailActions.startReply(replyKey(), "forward") },
  {
    id: "star",
    write: true,
    keys: ["s"],
    label: "Star or unstar",
    group: "Email",
    when: hasTargets,
    run: () => {
      // A conversation is starred when any of its messages is: the key stars
      // all of them, or takes the star off all of them.
      const first = selectedRows()[0];
      void mailActions.star(targets(), !(first ? conversationStarred(first) : false));
    },
  },
  { id: "mark-unread", write: true, keys: ["u", "Shift+U"], label: "Mark as unread", group: "Email", when: hasTargets, run: () => void mailActions.markRead(targets(), false) },
  { id: "mark-read", write: true, keys: ["Shift+I"], label: "Mark as read", group: "Email", when: hasTargets, run: () => void mailActions.markRead(targets(), true) },
  { id: "select", keys: ["x"], label: "Select for the assistant", group: "Email", when: hasOpen, run: () => useSelectionStore.getState().toggleMulti(openKey()!) },
  { id: "undo", keys: ["z"], label: "Undo", group: "Email", run: () => mailActions.undoLast() },
  {
    id: "conversation-view",
    keys: [],
    label: "Turn conversation view on or off",
    group: "Email",
    // No key of its own: it is in the palette and the account menu.
    help: false,
    run: () => {
      const ui = useUiStore.getState();
      ui.setSetting("conversationView", !ui.settings.conversationView);
    },
  },

  // ---- Go to
  { id: "go-inbox", keys: ["g i"], label: "Go to Inbox", group: "Go to", palette: false, run: goTo("inbox") },
  { id: "go-starred", keys: ["g s"], label: "Go to Starred", group: "Go to", palette: false, run: goTo("starred") },
  { id: "go-drafts", keys: ["g d"], label: "Go to Drafts", group: "Go to", palette: false, run: goTo("drafts") },
  { id: "go-sent", keys: ["g t"], label: "Go to Sent", group: "Go to", palette: false, run: goTo("sent") },
  { id: "go-archive", keys: ["g a"], label: "Go to Archive", group: "Go to", palette: false, run: goTo("archive") },

  // ---- Compose
  // Not while a message is being written: opening a new one would replace it.
  { id: "compose", write: true, keys: ["c"], label: "Compose", group: "Compose", when: () => useComposeStore.getState().compose == null, run: () => mailActions.newCompose() },
  {
    id: "send",
    write: true,
    keys: ["Mod+Enter"],
    label: "Send, or approve a held send",
    group: "Compose",
    when: () => useComposeStore.getState().compose != null,
    run: sendOrApprove,
  },

  // ---- Assistant
  { id: "assistant", keys: ["Mod+j"], label: "Focus or hide the assistant", group: "Assistant", modal: true, run: focusAssistant },

  // ---- App
  { id: "palette", keys: ["Mod+k"], label: "Command palette", group: "App", modal: true, palette: false, run: () => useUiStore.getState().toggleMenu(SHELL_MENU.palette) },
  { id: "help", keys: ["?"], label: "Keyboard shortcuts", group: "App", modal: true, run: () => useUiStore.getState().toggleMenu(SHELL_MENU.help) },
  { id: "escape", keys: ["Escape"], label: "Close, stop the assistant, or leave a field", group: "App", modal: true, passive: true, palette: false, run: () => escape(eventTarget) },
];

export const SHORTCUTS: readonly Shortcut[] = REGISTRY.map((s) => (s.write ? { ...s, run: guardWrite(s.run) } : s));

const byId = new Map(SHORTCUTS.map((s) => [s.id, s]));

export function getShortcut(id: string): Shortcut | undefined {
  return byId.get(id);
}

/** "⌘K" / "Ctrl+K": the hint to show on a control for a registered shortcut. */
export function shortcutHint(id: string): string {
  const key = byId.get(id)?.keys[0];
  return key ? formatKeys(key, isMac) : "";
}

/** The `aria-keyshortcuts` value for a registered shortcut. */
export function shortcutAria(id: string): string | undefined {
  const s = byId.get(id);
  return s ? s.keys.map(ariaKeyShortcuts).join(" ") : undefined;
}

/** Every binding of a shortcut, formatted for display. */
export function shortcutKeys(s: Shortcut): string[] {
  return s.keys.map((k) => formatKeys(k, isMac));
}

/** Actions the command palette offers right now. */
export function paletteActions(): Shortcut[] {
  return SHORTCUTS.filter((s) => s.palette !== false && (!s.when || s.when()));
}

/* ------------------------------------------------------------------
 * The "g…" hint: a pending sequence, shown by <KeyHint /> without blocking anything.
 * ------------------------------------------------------------------ */

let pendingHint: string | null = null;
const hintListeners = new Set<() => void>();

function setHint(next: string | null): void {
  if (pendingHint === next) return;
  pendingHint = next;
  for (const l of [...hintListeners]) l();
}

function subscribeHint(cb: () => void): () => void {
  hintListeners.add(cb);
  return () => {
    hintListeners.delete(cb);
  };
}

/** The first key of a sequence that is waiting for its second ("g"), or null. */
export function usePendingSequence(): string | null {
  return useSyncExternalStore(
    subscribeHint,
    () => pendingHint,
    () => null,
  );
}

/* ------------------------------------------------------------------
 * The global handler
 * ------------------------------------------------------------------ */

const ARROWS = new Set(["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"]);
const ENTER_OWNERS =
  'button, a[href], summary, [role="button"], [role="link"], [role="menuitem"], [role="separator"], [role="switch"], [role="checkbox"], [role="tab"]';

/** True when the focused element uses this key itself. Arrows move the list
 *  selection only from the list (or when nothing has focus): elsewhere they
 *  scroll the reader, resize a splitter or move inside a menu. */
function ownsKey(target: EventTarget | null, key: string): boolean {
  const el = target instanceof Element ? target : null;
  if (!el || el === document.body || el === document.documentElement) return false;
  const inList = document.getElementById(PANE_ID.list)?.contains(el) ?? false;
  if (ARROWS.has(key)) return !inList;
  if (key === "Enter") return !inList || el.closest(ENTER_OWNERS) != null;
  return false;
}

export function useGlobalShortcuts(): void {
  useEffect(() => {
    let state: MatchState = IDLE;
    let hintTimer: ReturnType<typeof setTimeout> | null = null;

    const disarm = () => {
      if (hintTimer) clearTimeout(hintTimer);
      hintTimer = null;
      setHint(null);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const ui = useUiStore.getState();
      const input: KeyInput = e;
      const result = matchShortcut(
        SHORTCUTS,
        input,
        {
          typing: isTypingTarget(e.target),
          widget: ownsKey(e.target, e.key),
          // Any open menu or dialog owns the keyboard until it closes.
          modal: ui.menu != null || document.querySelector('[aria-modal="true"]') != null,
          singleKeyEnabled: ui.settings.shortcutsEnabled,
          now: Date.now(),
        },
        state,
      );
      // A bare modifier key leaves the state object untouched: nothing to update.
      if (result.state !== state) {
        state = result.state;
        disarm();
        if (state.prefix) {
          setHint(state.prefix);
          hintTimer = setTimeout(() => {
            state = IDLE;
            disarm();
          }, SEQUENCE_TIMEOUT_MS);
        }
      }

      const s = result.shortcut;
      if (!s) return;
      if (!s.passive) e.preventDefault();
      eventTarget = e.target;
      try {
        s.run();
      } finally {
        eventTarget = null;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      disarm();
    };
  }, []);
}
