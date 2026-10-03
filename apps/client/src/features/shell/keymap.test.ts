import { describe, expect, it } from "vitest";
import {
  HELP_COLUMNS,
  IDLE,
  type KeyInput,
  type MatchEnv,
  type MatchState,
  SEQUENCE_TIMEOUT_MS,
  SHORTCUT_GROUPS,
  type Shortcut,
  ariaKeyShortcuts,
  formatKeys,
  isSingleKeyOnly,
  keyClass,
  matchShortcut,
} from "./keymap";
import { SHORTCUTS } from "./shortcuts";

const noop = () => {};
const sc = (id: string, keys: string[], extra: Partial<Shortcut> = {}): Shortcut => ({ id, keys, label: id, group: "Email", run: noop, ...extra });

const LIST: Shortcut[] = [
  sc("next", ["j", "ArrowDown"], { repeat: true }),
  sc("archive", ["e"]),
  sc("trash", ["#"]),
  sc("star", ["s"]),
  sc("unread", ["u", "Shift+U"]),
  sc("read", ["Shift+I"]),
  sc("open", ["Enter", "o"]),
  sc("go-inbox", ["g i"]),
  sc("go-starred", ["g s"]),
  sc("assistant", ["Mod+j"], { modal: true }),
  sc("palette", ["Mod+k"], { modal: true }),
  sc("send", ["Mod+Enter"]),
  sc("help", ["?"], { modal: true }),
  sc("pane", ["F6"]),
  sc("pane-back", ["Shift+F6"]),
  sc("escape", ["Escape"], { modal: true }),
];

const env = (patch: Partial<MatchEnv> = {}): MatchEnv => ({ typing: false, widget: false, modal: false, singleKeyEnabled: true, now: 1000, ...patch });
const key = (k: string, patch: Partial<KeyInput> = {}): KeyInput => ({ key: k, ...patch });
const hit = (input: KeyInput, e: MatchEnv = env(), state: MatchState = IDLE, list: Shortcut[] = LIST) =>
  matchShortcut(list, input, e, state).shortcut?.id ?? null;

describe("matchShortcut: single keys", () => {
  it("matches plain characters and named keys", () => {
    expect(hit(key("j"))).toBe("next");
    expect(hit(key("ArrowDown"))).toBe("next");
    expect(hit(key("e"))).toBe("archive");
    expect(hit(key("Enter"))).toBe("open");
    expect(hit(key("o"))).toBe("open");
    expect(hit(key("F6"))).toBe("pane");
    expect(hit(key("F6", { shiftKey: true }))).toBe("pane-back");
    expect(hit(key("q"))).toBeNull();
  });

  it("tells a letter from its shifted form", () => {
    expect(hit(key("u"))).toBe("unread");
    expect(hit(key("U", { shiftKey: true }))).toBe("unread");
    expect(hit(key("I", { shiftKey: true }))).toBe("read");
    expect(hit(key("i"))).toBeNull();
    expect(hit(key("E", { shiftKey: true }))).toBeNull();
  });

  it("matches symbols by the character, whatever keys the layout needs for it", () => {
    expect(hit(key("#", { shiftKey: true }))).toBe("trash"); // US: Shift+3
    expect(hit(key("#"))).toBe("trash"); // German: its own key
    expect(hit(key("#", { altKey: true }))).toBe("trash"); // Option+3 on some Mac layouts
    expect(hit(key("#", { ctrlKey: true, altKey: true }))).toBe("trash"); // AltGr on Windows
    expect(hit(key("?", { shiftKey: true }))).toBe("help");
    expect(hit(key("#", { metaKey: true }))).toBeNull();
    expect(hit(key("#", { ctrlKey: true }))).toBeNull();
  });
});

describe("matchShortcut: modifiers", () => {
  it("never fires a single-character shortcut with Cmd, Ctrl or Alt held", () => {
    expect(hit(key("e", { metaKey: true }))).toBeNull();
    expect(hit(key("e", { ctrlKey: true }))).toBeNull();
    expect(hit(key("e", { altKey: true }))).toBeNull();
    expect(hit(key("s", { metaKey: true }))).toBeNull(); // Cmd+S is not "star"
  });

  it("accepts Cmd or Ctrl for Mod, in either letter case", () => {
    expect(hit(key("k", { metaKey: true }))).toBe("palette");
    expect(hit(key("k", { ctrlKey: true }))).toBe("palette");
    expect(hit(key("K", { ctrlKey: true }))).toBe("palette"); // caps lock
    expect(hit(key("j", { metaKey: true }))).toBe("assistant");
    expect(hit(key("Enter", { metaKey: true }))).toBe("send");
    expect(hit(key("k", { metaKey: true, shiftKey: true }))).toBeNull();
  });

  it("ignores bare modifier presses without disturbing a pending sequence", () => {
    const armed = matchShortcut(LIST, key("g"), env()).state;
    const r = matchShortcut(LIST, key("Shift", { shiftKey: true }), env({ now: 1100 }), armed);
    expect(r.shortcut).toBeNull();
    expect(r.state).toBe(armed);
  });
});

describe("matchShortcut: typing guard", () => {
  const typing = env({ typing: true });

  it("ignores single characters, arrows and Enter while typing", () => {
    expect(hit(key("e"), typing)).toBeNull();
    expect(hit(key("#", { shiftKey: true }), typing)).toBeNull();
    expect(hit(key("ArrowDown"), typing)).toBeNull();
    expect(hit(key("Enter"), typing)).toBeNull();
    expect(matchShortcut(LIST, key("g"), typing).state).toBe(IDLE);
  });

  it("still fires modifier combos, Escape and function keys while typing", () => {
    expect(hit(key("k", { metaKey: true }), typing)).toBe("palette");
    expect(hit(key("j", { ctrlKey: true }), typing)).toBe("assistant");
    expect(hit(key("Enter", { metaKey: true }), typing)).toBe("send");
    expect(hit(key("Escape"), typing)).toBe("escape");
    expect(hit(key("F6"), typing)).toBe("pane");
  });

  it("leaves arrows and Enter to a widget that owns them, but not letters", () => {
    const widget = env({ widget: true });
    expect(hit(key("ArrowDown"), widget)).toBeNull();
    expect(hit(key("Enter"), widget)).toBeNull();
    expect(hit(key("j"), widget)).toBe("next");
    expect(hit(key("e"), widget)).toBe("archive");
  });

  it("does nothing during IME composition", () => {
    expect(hit(key("e", { isComposing: true }))).toBeNull();
    expect(hit(key("Process", { keyCode: 229 }))).toBeNull();
    expect(hit(key("Enter", { metaKey: true, isComposing: true }))).toBeNull();
    expect(hit(key("Escape", { isComposing: true }))).toBeNull();
  });
});

describe("matchShortcut: single-key shortcuts switched off (WCAG 2.1.4)", () => {
  const off = env({ singleKeyEnabled: false });

  it("disables every character shortcut and sequence", () => {
    for (const k of ["j", "e", "s", "u", "o", "?", "#"]) expect(hit(key(k), off)).toBeNull();
    expect(hit(key("I", { shiftKey: true }), off)).toBeNull();
    const r = matchShortcut(LIST, key("g"), off);
    expect(r.state).toBe(IDLE);
    expect(hit(key("i"), off, { prefix: "g", at: 1000 })).toBeNull();
  });

  it("keeps arrows, Enter, modifier combos, Escape and F6", () => {
    expect(hit(key("ArrowDown"), off)).toBe("next");
    expect(hit(key("Enter"), off)).toBe("open");
    expect(hit(key("k", { metaKey: true }), off)).toBe("palette");
    expect(hit(key("Escape"), off)).toBe("escape");
    expect(hit(key("F6"), off)).toBe("pane");
  });
});

describe("matchShortcut: key repeat", () => {
  it("repeats only shortcuts that opt in", () => {
    expect(hit(key("j", { repeat: true }))).toBe("next");
    expect(hit(key("ArrowDown", { repeat: true }))).toBe("next");
    expect(hit(key("e", { repeat: true }))).toBeNull();
    expect(hit(key("#", { repeat: true }))).toBeNull();
    expect(hit(key("j", { metaKey: true, repeat: true }))).toBeNull();
  });

  it("does not arm a sequence from a held key", () => {
    expect(matchShortcut(LIST, key("g", { repeat: true }), env()).state).toBe(IDLE);
  });
});

describe("matchShortcut: modal", () => {
  const modal = env({ modal: true });

  it("lets through only shortcuts marked modal", () => {
    expect(hit(key("e"), modal)).toBeNull();
    expect(hit(key("ArrowDown"), modal)).toBeNull();
    expect(hit(key("F6"), modal)).toBeNull();
    expect(hit(key("Enter", { metaKey: true }), modal)).toBeNull();
    expect(hit(key("Escape"), modal)).toBe("escape");
    expect(hit(key("k", { metaKey: true }), modal)).toBe("palette");
    expect(hit(key("?", { shiftKey: true }), modal)).toBe("help");
    expect(matchShortcut(LIST, key("g"), modal).state).toBe(IDLE);
  });
});

describe("matchShortcut: sequences", () => {
  it("arms on the first key and resolves on the second", () => {
    const first = matchShortcut(LIST, key("g"), env({ now: 1000 }));
    expect(first.shortcut).toBeNull();
    expect(first.state).toEqual({ prefix: "g", at: 1000 });
    const second = matchShortcut(LIST, key("i"), env({ now: 1400 }), first.state);
    expect(second.shortcut?.id).toBe("go-inbox");
    expect(second.state).toBe(IDLE);
  });

  it("prefers the sequence over the plain meaning of the second key", () => {
    const armed: MatchState = { prefix: "g", at: 1000 };
    expect(hit(key("s"), env({ now: 1200 }), armed)).toBe("go-starred");
    expect(hit(key("s"), env({ now: 1200 }))).toBe("star");
  });

  it("times out after one second", () => {
    const armed: MatchState = { prefix: "g", at: 1000 };
    expect(hit(key("s"), env({ now: 1000 + SEQUENCE_TIMEOUT_MS }), armed)).toBe("go-starred");
    expect(hit(key("s"), env({ now: 1001 + SEQUENCE_TIMEOUT_MS }), armed)).toBe("star");
    expect(hit(key("i"), env({ now: 5000 }), armed)).toBeNull();
  });

  it("disarms on any other key and handles that key normally", () => {
    const armed: MatchState = { prefix: "g", at: 1000 };
    const r = matchShortcut(LIST, key("e"), env({ now: 1100 }), armed);
    expect(r.shortcut?.id).toBe("archive");
    expect(r.state).toBe(IDLE);
    const miss = matchShortcut(LIST, key("q"), env({ now: 1100 }), armed);
    expect(miss.shortcut).toBeNull();
    expect(miss.state).toBe(IDLE);
  });

  it("re-arms when the prefix is pressed twice", () => {
    const armed: MatchState = { prefix: "g", at: 1000 };
    const r = matchShortcut(LIST, key("g"), env({ now: 1500 }), armed);
    expect(r.shortcut).toBeNull();
    expect(r.state).toEqual({ prefix: "g", at: 1500 });
  });
});

describe("matchShortcut: when", () => {
  it("skips a shortcut whose `when` fails and falls through to the next binding", () => {
    let has = false;
    const list = [sc("a", ["e"], { when: () => has }), sc("b", ["e"])];
    expect(hit(key("e"), env(), IDLE, list)).toBe("b");
    has = true;
    expect(hit(key("e"), env(), IDLE, list)).toBe("a");
    expect(hit(key("e"), env(), IDLE, [sc("a", ["e"], { when: () => false })])).toBeNull();
  });
});

describe("classification and display", () => {
  it("classifies bindings", () => {
    expect(keyClass("e")).toBe("character");
    expect(keyClass("g i")).toBe("character");
    expect(keyClass("Shift+I")).toBe("character");
    expect(keyClass("ArrowDown")).toBe("nav");
    expect(keyClass("Enter")).toBe("nav");
    expect(keyClass("Mod+k")).toBe("global");
    expect(keyClass("Escape")).toBe("global");
    expect(keyClass("Shift+F6")).toBe("global");
    expect(isSingleKeyOnly(sc("x", ["e"]))).toBe(true);
    expect(isSingleKeyOnly(sc("x", ["j", "ArrowDown"]))).toBe(false);
  });

  it("formats keys per platform", () => {
    expect(formatKeys("Mod+k", true)).toBe("⌘K");
    expect(formatKeys("Mod+k", false)).toBe("Ctrl+K");
    expect(formatKeys("Mod+Enter", true)).toBe("⌘Enter");
    expect(formatKeys("Shift+I", true)).toBe("⇧I");
    expect(formatKeys("Shift+I", false)).toBe("Shift+I");
    expect(formatKeys("g i", true)).toBe("g then i");
    expect(formatKeys("ArrowDown", false)).toBe("↓");
    expect(formatKeys("Escape", false)).toBe("Esc");
    expect(formatKeys("Shift+F6", false)).toBe("Shift+F6");
    expect(ariaKeyShortcuts("Mod+k")).toBe("Meta+K Control+K");
    expect(ariaKeyShortcuts("e")).toBe("E");
  });
});

describe("the real registry", () => {
  const ids = SHORTCUTS.map((s) => s.id);
  const real = (input: KeyInput, e: MatchEnv = env(), state: MatchState = IDLE) => {
    // `when` reads live stores; the registry's shape is what is under test here.
    const always = SHORTCUTS.map((s) => ({ ...s, when: undefined }));
    return matchShortcut(always, input, e, state).shortcut?.id ?? null;
  };

  it("has unique ids and no binding claimed twice", () => {
    expect(new Set(ids).size).toBe(ids.length);
    const keys = SHORTCUTS.flatMap((s) => s.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("covers the whole set", () => {
    const expected: [KeyInput, string][] = [
      [key("j"), "next"],
      [key("ArrowDown"), "next"],
      [key("k"), "previous"],
      [key("ArrowUp"), "previous"],
      [key("Enter"), "open"],
      [key("o"), "open"],
      [key("e"), "archive"],
      [key("#", { shiftKey: true }), "trash"],
      [key("r"), "reply"],
      [key("a"), "reply-all"],
      [key("f"), "forward"],
      [key("c"), "compose"],
      [key("/"), "search"],
      [key("x"), "select"],
      [key("s"), "star"],
      [key("u"), "mark-unread"],
      [key("U", { shiftKey: true }), "mark-unread"],
      [key("I", { shiftKey: true }), "mark-read"],
      [key("z"), "undo"],
      [key("v"), "move"],
      [key("j", { metaKey: true }), "assistant"],
      [key("k", { ctrlKey: true }), "palette"],
      [key("Enter", { metaKey: true }), "send"],
      [key("?", { shiftKey: true }), "help"],
      [key("F6"), "pane-next"],
      [key("F6", { shiftKey: true }), "pane-previous"],
      [key("Escape"), "escape"],
    ];
    for (const [input, id] of expected) expect(real(input), `${input.key} -> ${id}`).toBe(id);
    const armed: MatchState = { prefix: "g", at: 1000 };
    const go: [string, string][] = [
      ["i", "go-inbox"],
      ["s", "go-starred"],
      ["d", "go-drafts"],
      ["t", "go-sent"],
      ["a", "go-archive"],
    ];
    for (const [k, id] of go) expect(real(key(k), env({ now: 1200 }), armed)).toBe(id);
  });

  it("only next / previous repeat, so a held key cannot archive or delete a run of mail", () => {
    expect(SHORTCUTS.filter((s) => s.repeat).map((s) => s.id)).toEqual(["next", "previous"]);
  });

  it("puts every group in the help dialog exactly once", () => {
    const shown = HELP_COLUMNS.flat();
    expect([...shown].sort()).toEqual([...SHORTCUT_GROUPS].sort());
    for (const s of SHORTCUTS) expect(shown).toContain(s.group);
  });
});
