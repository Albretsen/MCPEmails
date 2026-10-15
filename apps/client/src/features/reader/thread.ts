import type { MessageKey } from "../../api/types";
import { useThreadStore } from "../../state/conversation-store";
import { PANE_ID } from "../shell/shell-context";

/* The thread view's small non-React parts: how a message card is found in the
 * DOM, the scroll arithmetic that keeps what is being read in place, and the
 * keyboard moves between messages (`n` / `p` / `o`). */

/** On each message's <li>: its key. */
export const THREAD_MESSAGE_ATTR = "data-thread-message";

/** The scroll position that puts an element back where it was: it sat `before`
 *  px below the scroller's top edge and now sits `after` px below it. */
export function pinnedScrollTop(scrollTop: number, before: number, after: number): number {
  return Math.max(0, scrollTop + (after - before));
}

/** The CSS selector of one message's <li>. (Not `CSS.escape`: inside a quoted
 *  attribute value only the quote and the backslash need escaping.) */
export function messageSelector(key: MessageKey): string {
  return `[${THREAD_MESSAGE_ATTR}="${key.replace(/["\\]/g, "\\$&")}"]`;
}

function headOf(key: MessageKey): HTMLElement | null {
  const pane = document.getElementById(PANE_ID.reader) ?? document;
  return pane.querySelector<HTMLElement>(`${messageSelector(key)} > button`);
}

/** True while the reader shows a thread (two or more messages). */
export function threadIsOpen(): boolean {
  return useThreadStore.getState().order.length > 1;
}

/** `n` / `p`: focus the next / previous message of the open thread. Its header
 *  takes the keyboard focus (so Enter and Space expand it, and a screen reader
 *  says which message this is) and is scrolled into view. */
export function stepThread(dir: 1 | -1): void {
  const next = useThreadStore.getState().step(dir);
  if (!next) return;
  requestAnimationFrame(() => {
    const head = headOf(next);
    if (!head) return;
    head.focus({ preventScroll: true });
    head.scrollIntoView?.({ block: "nearest" });
  });
}

/** `o`: expand or collapse the focused message. */
export function toggleFocusedMessage(): boolean {
  const t = useThreadStore.getState();
  if (t.order.length < 2 || !t.focused) return false;
  t.toggle(t.focused);
  return true;
}

/** Whether keyboard focus is inside the reader pane. */
export function focusInReader(): boolean {
  const pane = document.getElementById(PANE_ID.reader);
  return !!pane && pane.contains(document.activeElement);
}
