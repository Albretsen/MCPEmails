import { type KeyboardEvent, type PointerEvent, type RefObject, useRef, useState } from "react";
import { cx } from "../../lib/cx";
import s from "./AppShell.module.css";

export interface SplitterProps {
  /** Accessible name: "Resize sidebar". */
  label: string;
  /** id of the pane this handle resizes (aria-controls). */
  controls: string;
  /** Current width of that pane. */
  value: number;
  min: number;
  max: number;
  /** The pane is on the right of the handle: dragging left grows it. */
  invert?: boolean;
  /** Element that carries the pane-width CSS variables. */
  rootRef: RefObject<HTMLElement | null>;
  /** The CSS variable this handle drives while dragging, e.g. "--side-w". */
  cssVar: string;
  /** Raw dragged width -> the width to use (clamp / snap). */
  clamp: (raw: number) => number;
  /** One keyboard step from the current width. */
  step: (dir: 1 | -1) => number;
  onCommit: (width: number) => void;
  /** Double-click: back to the default width. */
  onReset: () => void;
  /** Enter: collapse or restore the pane. Without it, Enter resets the width. */
  onToggle?: () => void;
  /** What Enter does, for the tooltip: "collapse the sidebar". */
  toggleHint?: string;
  /** Called when a drag ends so the shell can re-sync its CSS variables. */
  onDragEnd: () => void;
}

/** A vertical pane splitter (WAI-ARIA window splitter).
 *
 * Pointer: drag to resize, double-click to reset. While dragging, the width is
 * written straight to a CSS variable inside requestAnimationFrame; React state
 * is only touched once, on release, so a drag causes no re-render per move.
 * Keyboard: Left/Right resize by 16 px, Home/End go to the limits, Enter
 * collapses or restores the pane (or resets the width where a pane cannot
 * collapse).
 *
 * The focusable element is the 12 px pointer target; the 6 px line drawn inside
 * it is the visual. The target starts at the pane edge and extends into the
 * pane on its right, so it never lies over the scrollbar of the pane on its left.
 */
export function Splitter(p: SplitterProps) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; start: number; width: number; raf: number } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // Capture throws when the pointer is already gone (a synthetic event, or a
    // release between dispatch and here); the drag still works without it.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* no active pointer */
    }
    drag.current = { x: e.clientX, start: p.value, width: p.value, raf: 0 };
    p.rootRef.current?.setAttribute("data-dragging", "true");
    setDragging(true);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    d.width = p.clamp(d.start + (p.invert ? -dx : dx));
    if (d.raf) return;
    d.raf = requestAnimationFrame(() => {
      d.raf = 0;
      p.rootRef.current?.style.setProperty(p.cssVar, `${d.width}px`);
    });
  };

  const end = (e: PointerEvent<HTMLDivElement>, commit: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (d.raf) cancelAnimationFrame(d.raf);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    p.rootRef.current?.removeAttribute("data-dragging");
    setDragging(false);
    if (commit && d.width !== d.start) p.onCommit(d.width);
    p.onDragEnd();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    // Arrow direction follows the handle on screen, not the pane's growth.
    if (e.key === "ArrowLeft") next = p.step(p.invert ? 1 : -1);
    else if (e.key === "ArrowRight") next = p.step(p.invert ? -1 : 1);
    else if (e.key === "Home") next = p.clamp(p.min);
    else if (e.key === "End") next = p.clamp(p.max);
    else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      (p.onToggle ?? p.onReset)();
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    if (next !== p.value) p.onCommit(next);
  };

  return (
    <div className={s.splitterSlot}>
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label={p.label}
        aria-controls={p.controls}
        aria-valuenow={Math.round(p.value)}
        aria-valuemin={Math.round(p.min)}
        aria-valuemax={Math.round(p.max)}
        title={`Drag to resize. Double-click to reset.${p.toggleHint ? ` Enter to ${p.toggleHint}.` : ""}`}
        className={cx(s.splitter, dragging && s.splitterDragging)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => end(e, true)}
        onPointerCancel={(e) => end(e, false)}
        onDoubleClick={p.onReset}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
