/* Platform detection for presentation only (which modifier glyph to show).
 * Capabilities are feature-detected in src/platform, never sniffed. */

const nav: Navigator | undefined = typeof navigator !== "undefined" ? navigator : undefined;

export const isMac: boolean = !!nav && /Mac|iPhone|iPad/.test(nav.platform || nav.userAgent);

export const isIOS: boolean =
  !!nav && (/iPhone|iPad|iPod/.test(nav.userAgent) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1));

export const isStandalone: boolean =
  typeof window !== "undefined" &&
  (window.matchMedia?.("(display-mode: standalone)").matches ||
    (nav as (Navigator & { standalone?: boolean }) | undefined)?.standalone === true);

/** "⌘J" on Apple platforms, "Ctrl J" elsewhere. */
export function modKey(key: string): string {
  return isMac ? `⌘${key}` : `Ctrl ${key}`;
}

/** True when the event target is somewhere the user types. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}
