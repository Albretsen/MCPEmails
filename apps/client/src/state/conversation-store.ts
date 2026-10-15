import { create } from "zustand";
import type { MessageKey } from "../api/types";
import { type Conversation, type ConversationList, EMPTY_CONVERSATIONS } from "../data/conversations";

/* Two small pieces of conversation state that more than one pane reads.
 *
 * 1. The conversations of the list on screen. The list pane groups its rows
 *    (data/conversations.ts) and registers the result here, the same way it
 *    registers the visible keys: the reader, the keyboard shortcuts, the
 *    reader toolbar and the assistant's context chip all need "which messages
 *    belong to the conversation this row stands for".
 *
 * 2. The open thread: which of its messages are expanded and which one has
 *    the focus (Reply, Reply all and Forward act on it; `n` / `p` move it).
 */

interface ConversationIndex {
  list: ConversationList;
}

export const useConversationIndex = create<ConversationIndex>(() => ({ list: EMPTY_CONVERSATIONS }));

export function setConversationList(list: ConversationList): void {
  if (useConversationIndex.getState().list !== list) useConversationIndex.setState({ list });
}

export function conversationOf(key: MessageKey | null | undefined): Conversation | undefined {
  return key ? useConversationIndex.getState().list.byKey.get(key) : undefined;
}

/** The row that stands for `key` in the list: its conversation's head. */
export function headKeyOf(key: MessageKey): MessageKey {
  return conversationOf(key)?.head.key ?? key;
}

/* ------------------------------------------------------------------
 * The open thread
 * ------------------------------------------------------------------ */

export interface ThreadMessageState {
  key: MessageKey;
  is_read: boolean;
}

export interface ThreadState {
  /** The conversation this state belongs to (its id; a message key for a
   *  message the list does not hold). */
  anchor: string | null;
  /** Its messages, oldest first. */
  order: MessageKey[];
  /** Expanded by default: the latest message, and every message that was
   *  unread when it was first seen here. */
  auto: Record<MessageKey, true>;
  /** What the person toggled: wins over `auto`. */
  toggled: Record<MessageKey, boolean>;
  focused: MessageKey | null;
  /** A message to focus when its thread opens (a link to one message of a
   *  conversation). Used once. */
  wanted: MessageKey | null;

  wantFocus(key: MessageKey | null): void;
  /** Called by the thread view whenever its messages change. A new anchor
   *  starts over; the same anchor only ADDS: nothing the person is reading
   *  collapses or loses focus because a message was found in another folder. */
  sync(anchor: string, messages: readonly ThreadMessageState[], focus?: MessageKey | null): void;
  toggle(key: MessageKey): void;
  expand(key: MessageKey): void;
  focus(key: MessageKey): void;
  /** `n` / `p`: the next / previous message. Returns the new focus, or null at an end. */
  step(dir: 1 | -1): MessageKey | null;
  clear(): void;
}

export const useThreadStore = create<ThreadState>((set, get) => ({
  anchor: null,
  order: [],
  auto: {},
  toggled: {},
  focused: null,
  wanted: null,

  wantFocus: (wanted) => set({ wanted }),

  sync: (anchor, messages, focus = get().wanted) => {
    const s = get();
    const order = messages.map((m) => m.key);
    const last = order[order.length - 1] ?? null;
    if (s.anchor !== anchor) {
      const auto: Record<MessageKey, true> = {};
      for (const m of messages) if (!m.is_read) auto[m.key] = true;
      if (last) auto[last] = true;
      const wanted = focus && order.includes(focus) ? focus : last;
      if (wanted) auto[wanted] = true;
      set({ anchor, order, auto, toggled: {}, focused: wanted, wanted: null });
      return;
    }
    let focused = s.focused;
    let toggled = s.toggled;
    let wanted = s.wanted;
    if (focus && wanted === focus && order.includes(focus)) {
      // Asked for while this thread is already open: go to it.
      focused = focus;
      toggled = { ...toggled, [focus]: true };
      wanted = null;
    }
    const sameOrder = order.length === s.order.length && order.every((k, i) => k === s.order[i]);
    if (sameOrder && focused === s.focused && toggled === s.toggled) return;
    const known = new Set(s.order);
    const auto = { ...s.auto };
    for (const m of messages) {
      // New here: expanded when unread, or when it is now the latest.
      if (!known.has(m.key) && (!m.is_read || m.key === last)) auto[m.key] = true;
    }
    if (!focused || !order.includes(focused)) focused = last;
    set({ order, auto, focused, toggled, wanted });
  },

  toggle: (key) => {
    const s = get();
    set({ toggled: { ...s.toggled, [key]: !selectExpanded(key)(s) }, focused: key });
  },
  expand: (key) => {
    const s = get();
    if (!selectExpanded(key)(s)) set({ toggled: { ...s.toggled, [key]: true } });
  },
  focus: (key) => {
    if (get().focused !== key && get().order.includes(key)) set({ focused: key });
  },
  step: (dir) => {
    const s = get();
    if (!s.order.length) return null;
    const i = s.focused ? s.order.indexOf(s.focused) : -1;
    const next = s.order[i < 0 ? (dir > 0 ? 0 : s.order.length - 1) : i + dir];
    if (!next) return null;
    set({ focused: next });
    return next;
  },
  clear: () => {
    if (get().anchor !== null) set({ anchor: null, order: [], auto: {}, toggled: {}, focused: null });
  },
}));

export const selectExpanded =
  (key: MessageKey) =>
  (s: ThreadState): boolean =>
    s.toggled[key] ?? s.auto[key] === true;

export const selectFocused =
  (key: MessageKey) =>
  (s: ThreadState): boolean =>
    s.focused === key;

/** Is `key` what the reader is showing: the open row itself, or a message of
 *  the conversation that row stands for. A reply to such a message is written
 *  inline under the thread, exactly as a reply to the open message is. */
export function isOpenInReader(key: MessageKey | null | undefined, selected: MessageKey | null): boolean {
  if (!key || !selected) return false;
  if (key === selected) return true;
  const conv = conversationOf(selected);
  if (conv && conv.rows.length > 1 && conv.keys.includes(key)) return true;
  const order = useThreadStore.getState().order;
  return order.length > 1 && order.includes(selected) && order.includes(key);
}

/** The message Reply / Reply all / Forward act on: the focused message of the
 *  open thread, else the open row itself. */
export function replyTargetOf(selected: MessageKey | null): MessageKey | null {
  if (!selected) return null;
  const t = useThreadStore.getState();
  return t.focused && t.order.length > 1 && t.order.includes(selected) ? t.focused : selected;
}
