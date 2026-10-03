import { PANE_ID } from "../shell/shell-context";

/* Deliberate focus targets for when the focused control goes away (the email
 * was archived, the composer closed). Focus must never fall back to <body>:
 * the next keystroke would have no home and screen readers lose their place. */

function visible(el: Element | null): el is HTMLElement {
  return el instanceof HTMLElement && el.isConnected && el.getClientRects().length > 0;
}

/** Focuses the message list (its listbox, one tab stop). False when it is not on screen. */
export function focusList(): boolean {
  const pane = document.getElementById(PANE_ID.list);
  const target = pane?.querySelector<HTMLElement>('[role="listbox"]') ?? pane;
  if (!visible(target)) return false;
  target.focus({ preventScroll: true });
  return document.activeElement === target;
}

/** Focuses the reader pane (<main>). False when it is not on screen. */
export function focusReader(): boolean {
  const pane = document.getElementById(PANE_ID.reader);
  if (!visible(pane)) return false;
  pane.focus({ preventScroll: true });
  return document.activeElement === pane;
}

function focusIsLost(): boolean {
  const a = document.activeElement;
  return !a || a === document.body || a === document.documentElement || !visible(a);
}

/** After the current render settles: if focus was dropped, put it on the
 *  preferred pane (falling back to the other one). Does nothing when the user
 *  already has focus somewhere real. */
export function restoreFocusSoon(prefer: "list" | "reader" = "list"): void {
  requestAnimationFrame(() => {
    if (!focusIsLost()) return;
    if (prefer === "reader") void (focusReader() || focusList());
    else void (focusList() || focusReader());
  });
}
