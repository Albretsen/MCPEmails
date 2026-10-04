/* The pure half of the keyboard system: key specs, the matcher and the
 * formatting used by the help dialog and the command palette. No DOM, no
 * stores, so it is unit-tested directly (keymap.test.ts).
 *
 * Key spec grammar (one string per binding):
 *   "j"  "#"  "?"          a character key
 *   "Shift+I"              a shifted letter
 *   "Mod+k" "Mod+Enter"    Mod = Cmd on Apple platforms, Ctrl elsewhere (either is accepted)
 *   "ArrowDown" "Enter" "Escape" "F6" "Shift+F6"   named keys (KeyboardEvent.key)
 *   "g i"                  a two-key sequence, typed within SEQUENCE_TIMEOUT_MS
 */

export const SEQUENCE_TIMEOUT_MS = 1000;

export type ShortcutGroup = "Navigation" | "Go to" | "Email" | "Compose" | "Assistant" | "App";

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ["Navigation", "Email", "Go to", "Compose", "Assistant", "App"];

/** The help dialog's two columns. Every group appears exactly once (checked in keymap.test.ts). */
export const HELP_COLUMNS: readonly (readonly ShortcutGroup[])[] = [
  ["Navigation", "Go to", "Compose"],
  ["Email", "Assistant", "App"],
];

export interface Shortcut {
  id: string;
  /** Every binding of this action. The first one is the hint shown on controls. */
  keys: readonly string[];
  label: string;
  group: ShortcutGroup;
  /** The action applies right now. Checked by the key handler and the palette. */
  when?: () => boolean;
  run: () => void;
  /** Holding the key repeats the action (j / k only). Default false. */
  repeat?: boolean;
  /** Still fires while a modal dialog (help, palette) is open. */
  modal?: boolean;
  /** Leave the browser's default behaviour alone when it fires. */
  passive?: boolean;
  /** Listed in the command palette (default true). */
  palette?: boolean;
  /** Listed in the help dialog (default true). */
  help?: boolean;
  /** Changes mail or sends it. Refused, with an explanation, for a read-only
   *  workspace member (state/permissions.ts). */
  write?: boolean;
}

/** The parts of a KeyboardEvent the matcher reads. */
export interface KeyInput {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  /** 229 while an IME is composing (Safari reports it without isComposing). */
  keyCode?: number;
}

export interface MatchEnv {
  /** Focus is in an input, textarea, select or contenteditable. */
  typing: boolean;
  /** Focus is on a widget that owns arrows / Enter itself (button, splitter, menu). */
  widget: boolean;
  /** A modal dialog is open. */
  modal: boolean;
  /** settings.shortcutsEnabled (WCAG 2.1.4). */
  singleKeyEnabled: boolean;
  /** Epoch ms. */
  now: number;
}

/** A sequence prefix that has been typed and is waiting for its second key. */
export interface MatchState {
  prefix: string | null;
  at: number;
}

export const IDLE: MatchState = { prefix: null, at: 0 };

export interface MatchResult<S extends Shortcut = Shortcut> {
  shortcut: S | null;
  state: MatchState;
}

interface Step {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

/** character: a printable key with no Cmd/Ctrl/Alt (what WCAG 2.1.4 is about).
 *  nav: arrows, Enter and friends. global: modifier combos, Escape, function keys. */
export type KeyClass = "character" | "nav" | "global";

interface Parsed {
  steps: Step[];
  cls: KeyClass;
}

const NAV_KEYS = new Set(["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Enter", "Home", "End", " "]);
const MODIFIER_KEYS = new Set(["Shift", "Meta", "Control", "Alt", "AltGraph", "CapsLock", "Fn", "Dead", "Process"]);

const parseCache = new Map<string, Parsed>();

function parseStep(spec: string): Step {
  const parts = spec.split("+");
  // "Mod++" is not used; the last part is always the key.
  const key = parts[parts.length - 1] ?? "";
  const mods = parts.slice(0, -1);
  return { key, mod: mods.includes("Mod"), shift: mods.includes("Shift"), alt: mods.includes("Alt") };
}

export function parseKeys(spec: string): Parsed {
  let p = parseCache.get(spec);
  if (p) return p;
  const steps = spec.trim().split(/\s+/).map(parseStep);
  const first = steps[0];
  const cls: KeyClass =
    !first || first.mod || first.alt
      ? "global"
      : first.key.length === 1 && first.key !== " "
        ? "character"
        : NAV_KEYS.has(first.key)
          ? "nav"
          : "global";
  p = { steps, cls };
  parseCache.set(spec, p);
  return p;
}

export function keyClass(spec: string): KeyClass {
  return parseKeys(spec).cls;
}

/** True when every binding of the shortcut is a character key or sequence, so
 *  it stops working when single-key shortcuts are switched off. */
export function isSingleKeyOnly(s: Shortcut): boolean {
  return s.keys.every((k) => keyClass(k) === "character");
}

const isLetter = (k: string): boolean => k.length === 1 && k.toLowerCase() !== k.toUpperCase();

function stepMatches(step: Step, e: KeyInput): boolean {
  // Symbols ("#", "?", "/"): which physical keys produce them depends on the
  // layout. Shift, Option (Mac) and AltGr (reported as Ctrl+Alt on Windows) may
  // all be part of typing the character, so only Cmd and a lone Ctrl rule it out.
  if (step.key.length === 1 && !isLetter(step.key) && !step.mod && !step.alt) {
    if (e.metaKey || (e.ctrlKey && !e.altKey)) return false;
    return e.key === step.key;
  }
  const mod = !!(e.metaKey || e.ctrlKey);
  if (step.mod !== mod) return false;
  if (step.alt !== !!e.altKey) return false;
  const shift = !!e.shiftKey;
  if (step.key.length === 1) {
    if (step.mod) return step.shift === shift && e.key.toLowerCase() === step.key.toLowerCase();
    // Letters: "u" and "Shift+U" are different bindings.
    if (step.shift !== shift) return false;
    return e.key.toLowerCase() === step.key.toLowerCase();
  }
  return step.shift === shift && e.key === step.key;
}

function allowed(cls: KeyClass, s: Shortcut, e: KeyInput, env: MatchEnv): boolean {
  if (e.repeat && !s.repeat) return false;
  if (env.modal && !s.modal) return false;
  if (cls === "character") return !env.typing && env.singleKeyEnabled;
  if (cls === "nav") return !env.typing && !env.widget;
  return true;
}

const active = (s: Shortcut): boolean => !s.when || s.when();

/** Finds the shortcut a key press triggers, if any.
 *
 * Rules, in order:
 *  - Nothing fires during IME composition or for a bare modifier key.
 *  - Character shortcuts never fire while typing, with Cmd/Ctrl/Alt held, or
 *    when single-key shortcuts are off. Arrows and Enter never fire while
 *    typing or on a widget that uses them. Modifier combos, Escape and
 *    function keys fire anywhere.
 *  - A held key only repeats shortcuts marked `repeat`.
 *  - While a modal is open only shortcuts marked `modal` fire.
 *  - The first registered shortcut whose `when` passes wins.
 *  - A sequence ("g i") arms on its first key and resolves on the second if
 *    it arrives within SEQUENCE_TIMEOUT_MS; any other key disarms it and is
 *    matched normally.
 */
export function matchShortcut<S extends Shortcut>(
  shortcuts: readonly S[],
  e: KeyInput,
  env: MatchEnv,
  state: MatchState = IDLE,
): MatchResult<S> {
  if (e.isComposing || e.keyCode === 229) return { shortcut: null, state: IDLE };
  if (MODIFIER_KEYS.has(e.key)) return { shortcut: null, state };

  const armed = state.prefix != null && env.now - state.at <= SEQUENCE_TIMEOUT_MS ? state.prefix : null;

  if (armed != null) {
    for (const s of shortcuts) {
      for (const spec of s.keys) {
        const { steps, cls } = parseKeys(spec);
        const [first, second] = steps;
        if (steps.length !== 2 || !first || !second || first.key !== armed) continue;
        if (!stepMatches(second, e) || !allowed(cls, s, e, env) || !active(s)) continue;
        return { shortcut: s, state: IDLE };
      }
    }
  }

  for (const s of shortcuts) {
    for (const spec of s.keys) {
      const { steps, cls } = parseKeys(spec);
      const first = steps[0];
      if (steps.length !== 1 || !first) continue;
      if (!stepMatches(first, e) || !allowed(cls, s, e, env) || !active(s)) continue;
      return { shortcut: s, state: IDLE };
    }
  }

  // Not a shortcut on its own: does it start a sequence?
  if (!e.repeat) {
    for (const s of shortcuts) {
      for (const spec of s.keys) {
        const { steps, cls } = parseKeys(spec);
        const first = steps[0];
        if (steps.length !== 2 || !first) continue;
        if (stepMatches(first, e) && allowed(cls, s, e, env)) return { shortcut: null, state: { prefix: first.key, at: env.now } };
      }
    }
  }

  return { shortcut: null, state: IDLE };
}

/* ------------------------------------------------------------------
 * Display
 * ------------------------------------------------------------------ */

const KEY_GLYPH: Record<string, string> = {
  ArrowDown: "↓",
  ArrowUp: "↑",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  Enter: "Enter",
  " ": "Space",
};

function formatStep(step: Step, mac: boolean): string {
  const key = KEY_GLYPH[step.key] ?? (step.mod && step.key.length === 1 ? step.key.toUpperCase() : step.key);
  const shiftedLetter = step.shift && isLetter(step.key) ? step.key.toUpperCase() : key;
  if (mac) return `${step.mod ? "⌘" : ""}${step.alt ? "⌥" : ""}${step.shift ? "⇧" : ""}${shiftedLetter}`;
  const parts: string[] = [];
  if (step.mod) parts.push("Ctrl");
  if (step.alt) parts.push("Alt");
  if (step.shift) parts.push("Shift");
  parts.push(shiftedLetter);
  return parts.join("+");
}

/** "Mod+k" -> "⌘K" / "Ctrl+K"; "g i" -> "g then i"; "Shift+I" -> "⇧I" / "Shift+I". */
export function formatKeys(spec: string, mac: boolean): string {
  return parseKeys(spec)
    .steps.map((s) => formatStep(s, mac))
    .join(" then ");
}

/** The value for `aria-keyshortcuts`: "Mod+k" -> "Meta+K Control+K". */
export function ariaKeyShortcuts(spec: string): string {
  const { steps } = parseKeys(spec);
  const variants = (meta: string | null): string =>
    steps
      .map((s) => {
        const parts: string[] = [];
        if (s.mod && meta) parts.push(meta);
        if (s.alt) parts.push("Alt");
        if (s.shift) parts.push("Shift");
        parts.push(s.key.length === 1 ? s.key.toUpperCase() : s.key);
        return parts.join("+");
      })
      .join(" ");
  return steps.some((s) => s.mod) ? `${variants("Meta")} ${variants("Control")}` : variants(null);
}
