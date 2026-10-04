import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cx } from "../lib/cx";
import { initials } from "../lib/format";
import s from "./ui.module.css";

/* ---------- Spinner ---------- */

export function Spinner({ label, className }: { label?: string; className?: string }) {
  return <span className={cx(s.spinner, className)} role={label ? "status" : undefined} aria-label={label} />;
}

/* ---------- Kbd ---------- */

export interface KbdProps {
  children: ReactNode;
  /** onBrand: inside a primary button. bare: no chip, just the glyphs. */
  variant?: "default" | "onBrand" | "bare";
  className?: string;
}

/** A keyboard hint. Decorative: the shortcut is announced via aria-keyshortcuts on the control. */
export function Kbd({ children, variant = "default", className }: KbdProps) {
  return (
    <kbd
      aria-hidden="true"
      className={cx(s.kbd, variant === "onBrand" && s.kbdOnBrand, variant === "bare" && s.kbdBare, className)}
    >
      {children}
    </kbd>
  );
}

/* ---------- Button ---------- */

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "md" | "sm";
  /** Shown in the tooltip and exposed as aria-keyshortcuts, e.g. "Meta+Enter". */
  shortcut?: string;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({ variant = "secondary", size = "md", shortcut, className, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      aria-keyshortcuts={shortcut}
      className={cx(s.button, s[variant], size === "sm" && s.sm, className)}
      {...rest}
    />
  );
}

/* ---------- IconButton ---------- */

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  /** Accessible name. Also the tooltip (with the shortcut hint appended). */
  label: string;
  /** Replaces the tooltip (why the control is disabled). The name stays `label`. */
  title?: string;
  /** Human hint appended to the tooltip: "E", "⌘J". */
  hint?: string;
  /** aria-keyshortcuts value: "E", "Meta+J". */
  shortcut?: string;
  size?: "md" | "sm";
  active?: boolean;
  danger?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/** An icon-only button. Always labelled; the tooltip is the native title. */
export function IconButton({
  label,
  hint,
  shortcut,
  size = "md",
  active,
  danger,
  className,
  type,
  title,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type ?? "button"}
      aria-label={label}
      title={title ?? (hint ? `${label} (${hint})` : label)}
      aria-keyshortcuts={shortcut}
      aria-pressed={active === undefined ? undefined : active}
      className={cx(s.iconButton, size === "sm" && s.iconSm, active && s.iconActive, danger && s.iconDanger, className)}
      {...rest}
    />
  );
}

/* ---------- Avatar ---------- */

export interface AvatarProps {
  name: string;
  email?: string;
  size?: "md" | "sm";
  /** Brand tint: the signed-in user. */
  brand?: boolean;
  className?: string;
}

export function Avatar({ name, email, size = "md", brand, className }: AvatarProps) {
  return (
    <div aria-hidden="true" className={cx(s.avatar, size === "sm" && s.avatarSm, brand && s.avatarBrand, className)}>
      {initials(name, email)}
    </div>
  );
}

/* ---------- EmptyState ---------- */

export interface EmptyStateProps {
  icon?: ReactNode;
  title?: string;
  children?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, children, className }: EmptyStateProps) {
  return (
    <div className={cx(s.empty, className)}>
      {icon ? <div className={s.emptyIcon}>{icon}</div> : null}
      {title ? <div className={s.emptyTitle}>{title}</div> : null}
      {children ? <div className={s.emptySub}>{children}</div> : null}
    </div>
  );
}

/* ---------- Skeleton ---------- */

export function Skeleton({ width, height = 12, className }: { width?: number | string; height?: number; className?: string }) {
  // Dynamic pixel values only: everything else is in the stylesheet.
  return <span aria-hidden="true" className={cx(s.skeleton, className)} style={{ display: "block", width, height }} />;
}

/* ---------- LogoMark ---------- */

export function LogoMark({ size = 22, alt = "", className }: { size?: number; alt?: string; className?: string }) {
  return <img src="/logo-mark.svg" alt={alt} width={size} height={size} className={className} draggable={false} />;
}
