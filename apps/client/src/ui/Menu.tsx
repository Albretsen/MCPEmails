import { type CSSProperties, type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";
import { cx } from "../lib/cx";
import s from "./ui.module.css";

/* Popover: an anchored panel with a click-away backdrop. Position it from the
 * parent with `className` (the parent must be position: relative) or `style`
 * for dynamic pixel offsets. Escape and click-away call onClose; focus returns
 * to whatever had it before. */

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Accessible name of the panel. */
  label?: string;
  role?: "dialog" | "menu" | "listbox";
}

export function Popover({ open, onClose, children, className, style, label, role = "dialog" }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("button, [href], input, select, textarea, [tabindex]");
    first?.focus();
    return () => {
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (role !== "menu" || (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End")) return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <>
      <div className={s.backdrop} onPointerDown={onClose} aria-hidden="true" />
      <div ref={ref} role={role} aria-label={label} className={cx(s.popover, className)} style={style} onKeyDown={onKeyDown}>
        {children}
      </div>
    </>
  );
}

/** A Popover with menu semantics: arrow keys move between MenuItems. */
export function Menu(props: Omit<PopoverProps, "role">) {
  return <Popover {...props} role="menu" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className={s.menuLabel}>{children}</div>;
}

export function MenuSeparator() {
  return <div className={s.menuSeparator} role="separator" />;
}

export interface MenuItemProps {
  onSelect: () => void;
  icon?: ReactNode;
  children: ReactNode;
  /** Second line under the label. */
  sub?: ReactNode;
  /** Right-aligned note (a time, a shortcut). */
  trailing?: ReactNode;
  disabled?: boolean;
}

export function MenuItem({ onSelect, icon, children, sub, trailing, disabled }: MenuItemProps) {
  return (
    <button type="button" role="menuitem" className={s.menuItem} onClick={onSelect} disabled={disabled}>
      {icon ? <span className={s.menuItemIcon}>{icon}</span> : null}
      <span className={s.menuItemText}>
        <span>{children}</span>
        {sub ? <span className={s.menuItemSub}>{sub}</span> : null}
      </span>
      {trailing ? <span className={s.menuItemTrailing}>{trailing}</span> : null}
    </button>
  );
}
