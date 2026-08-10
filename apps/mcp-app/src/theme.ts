// ---------------------------------------------------------------------------
// Theme + host style variables.
//
// Phase-0 Q7.1: the host does NOT apply the theme for you. Host variables are
// wrapped in CSS `light-dark()`, and a sandboxed iframe resolves those against
// the *system* color-scheme, not `hostContext.theme` — the spike card rendered
// light inside a dark host. So the card sets `color-scheme` itself, from
// `hostContext.theme`, and re-applies on every host-context-changed.
//
// Phase-0 Q6: a host "can provide any subset" of the 60 style variables, and
// the reference host omits safeAreaInsets/locale/timeZone entirely. Every
// variable is consumed as var(--host-token, var(--fb-token)) so a host that
// sends nothing still gets a correct light/dark card.
// ---------------------------------------------------------------------------

import type { HostContext, SafeAreaInsets, Theme } from "./bridge";

const VAR_NAME = /^--[a-z0-9-]+$/i;
// Host style values are template-injected into a CSSOM property. Reject the
// handful of shapes that could break out of a declaration or pull in a remote
// resource (the resource CSP is empty, but defence in depth is free here).
const VALUE_REJECT = /[{}<>;]|url\s*\(|expression\s*\(|@import/i;

export function applyTheme(theme: Theme | undefined) {
  const t: Theme = theme === "dark" ? "dark" : "light";
  const root = document.documentElement;
  root.setAttribute("data-theme", t);
  root.style.colorScheme = t;
}

export function applyStyleVariables(vars: Record<string, string> | undefined) {
  if (!vars) return;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(vars)) {
    if (typeof value !== "string") continue;
    if (!VAR_NAME.test(key)) continue;
    if (value.length > 400 || VALUE_REJECT.test(value)) continue;
    root.style.setProperty(key, value);
  }
}

const NO_INSETS: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };

export function applySafeArea(insets: SafeAreaInsets | undefined) {
  const i = insets ?? NO_INSETS;
  const root = document.documentElement;
  const px = (n: unknown) =>
    typeof n === "number" && isFinite(n) && n >= 0 && n < 200 ? `${n}px` : "0px";
  root.style.setProperty("--safe-top", px(i.top));
  root.style.setProperty("--safe-right", px(i.right));
  root.style.setProperty("--safe-bottom", px(i.bottom));
  root.style.setProperty("--safe-left", px(i.left));
}

export function applyHostContext(ctx: HostContext) {
  applyTheme(ctx.theme);
  applyStyleVariables(ctx.styles?.variables);
  applySafeArea(ctx.safeAreaInsets);
}
