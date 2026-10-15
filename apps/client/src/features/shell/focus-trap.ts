import { type KeyboardEvent, type RefObject, useLayoutEffect } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusable(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hidden && el.getAttribute("aria-hidden") !== "true");
}

/** Modal focus handling for a dialog that is mounted only while open.
 *
 * On mount: remembers what had focus and moves focus inside (to `initial`, or
 * the first focusable element, or the container). On unmount: gives focus back,
 * unless something else took it on purpose in the meantime (an action that
 * focuses the search field, say).
 *
 * Layout effects on purpose: focus must move in the same frame the dialog
 * appears and be restored before whatever runs after it closes.
 *
 * `restoreTo` names the element to give focus back to when something else
 * (a loading placeholder) already took focus before this dialog mounted. */
export function useModalFocus(
  container: RefObject<HTMLElement | null>,
  initial?: RefObject<HTMLElement | null>,
  restoreTo?: HTMLElement | null,
): void {
  useLayoutEffect(() => {
    const el = container.current;
    const previous = restoreTo ?? (document.activeElement as HTMLElement | null);
    const first = initial?.current ?? (el ? focusable(el)[0] : null) ?? el;
    first?.focus();
    return () => {
      const now = document.activeElement;
      const lost = !now || now === document.body || (el != null && el.contains(now));
      if (lost && previous && previous !== document.body && document.contains(previous)) previous.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container, initial]);
}

/** Keeps Tab inside the dialog. Call from the dialog's onKeyDown. */
export function trapTab(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== "Tab") return;
  const items = focusable(e.currentTarget);
  if (!items.length) {
    e.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !e.currentTarget.contains(active))) {
    e.preventDefault();
    last?.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first?.focus();
  }
}
