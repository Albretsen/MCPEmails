import { describe, expect, it } from "vitest";
import { TIER, fuzzyScore, rank } from "./fuzzy";
import { type PaletteItem, SECTION_LIMIT, buildSections, flatten } from "./items";

const noop = () => {};

describe("fuzzyScore", () => {
  it("matches case-insensitively and rejects non-matches", () => {
    expect(fuzzyScore("ARC", "Archive")).not.toBeNull();
    expect(fuzzyScore("xyz", "Archive")).toBeNull();
    expect(fuzzyScore("archivee", "Archive")).toBeNull();
    expect(fuzzyScore("", "Archive")).toBe(0);
    expect(fuzzyScore("   ", "Archive")).toBe(0);
  });

  it("ranks prefix > word start > inside a word > subsequence", () => {
    const prefix = fuzzyScore("tra", "Trash")!;
    const wordStart = fuzzyScore("tra", "Move to Trash")!;
    const inside = fuzzyScore("ras", "Move to Trash")!;
    const subsequence = fuzzyScore("mtt", "Move to Trash")!;
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(subsequence);
    expect(prefix).toBeGreaterThan(TIER.wordStart);
    expect(subsequence).toBeLessThan(TIER.subsequence);
  });

  it("prefers shorter texts and earlier matches within a tier", () => {
    expect(fuzzyScore("re", "Reply")!).toBeGreaterThan(fuzzyScore("re", "Reply all")!);
    expect(fuzzyScore("to", "Go to Inbox")!).toBeGreaterThan(fuzzyScore("to", "Move email to folder")!);
  });

  it("rewards word-initial letters in a subsequence", () => {
    expect(fuzzyScore("mau", "Mark as unread")!).toBeGreaterThan(fuzzyScore("mau", "Manage accounts quickly usually")!);
    expect(fuzzyScore("mu", "Mark as unread")).not.toBeNull();
    // A subsequence has to start at the beginning of a word.
    expect(fuzzyScore("tra", "Star or unstar")).toBeNull();
    expect(fuzzyScore("tt", "Move to Trash")).not.toBeNull();
  });

  it("matches several words in any order, below a phrase match", () => {
    const phrase = fuzzyScore("mark as", "Mark as unread")!;
    const scattered = fuzzyScore("unread mark", "Mark as unread")!;
    expect(scattered).not.toBeNull();
    expect(phrase).toBeGreaterThan(scattered);
    expect(fuzzyScore("mark zzz", "Mark as unread")).toBeNull();
  });
});

describe("rank", () => {
  const labels = ["Move to Trash", "Trash", "Mark as unread", "Go to Sent", "Star or unstar"];

  it("orders by score and keeps input order on ties", () => {
    expect(rank(labels, "tra", (x) => x).map((r) => r.item)).toEqual(["Trash", "Move to Trash"]);
    expect(rank(labels, "", (x) => x).map((r) => r.item)).toEqual(labels);
    expect(rank(["b one", "a one"], "one", (x) => x).map((r) => r.item)).toEqual(["b one", "a one"]);
  });

  it("caps the result", () => {
    expect(rank(labels, "", (x) => x, 2)).toHaveLength(2);
  });
});

describe("buildSections", () => {
  const action = (label: string): PaletteItem => ({ id: `a:${label}`, section: "actions", label, run: noop });
  const goto = (label: string): PaletteItem => ({ id: `g:${label}`, section: "goto", label, alias: `go to ${label}`, run: noop });
  const actions = ["Archive", "Move to Trash", "Reply", "Compose", "Search mail"].map(action);
  const gotos = ["Inbox", "Starred", "Drafts", "Sent", "Archive", "Trash", "Receipts"].map(goto);

  it("lists actions then folders, unfiltered, with no query rows when empty", () => {
    const sections = buildSections("", actions, gotos);
    expect(sections.map((s) => s.id)).toEqual(["actions", "goto"]);
    expect(flatten(sections)).toHaveLength(actions.length + gotos.length);
  });

  it("always ends with Search then Ask when there is a query", () => {
    const sections = buildSections("repl", actions, gotos);
    expect(sections.map((s) => s.id)).toEqual(["actions", "search", "ask"]);
    const flat = flatten(sections);
    expect(flat[0]?.label).toBe("Reply");
    expect(flat.at(-2)?.label).toBe("Search for “repl”");
    expect(flat.at(-1)?.label).toBe("Ask: repl");
    // A subsequence match from a word start also counts ("rep" finds Receipts), ranked below the prefix.
    expect(buildSections("rep", actions, gotos).map((s) => s.id)).toEqual(["actions", "goto", "search", "ask"]);
  });

  it("makes Search the default when nothing matches, never Ask", () => {
    const flat = flatten(buildSections("quarterly invoice from maya", actions, gotos));
    expect(flat.map((i) => i.id)).toEqual(["search", "ask"]);
  });

  it("puts the section with the best match first", () => {
    // "inb" is a prefix of the folder and matches no action.
    expect(buildSections("inb", actions, gotos)[0]?.id).toBe("goto");
    // "tra": prefix of the folder "Trash", only a word start in "Move to Trash".
    const tra = buildSections("tra", actions, gotos);
    expect(tra.map((s) => s.id)).toEqual(["goto", "actions", "search", "ask"]);
    // "arch" is a prefix in both: sections keep their natural order.
    expect(buildSections("arch", actions, gotos).map((s) => s.id).slice(0, 2)).toEqual(["actions", "goto"]);
  });

  it("matches folders through the 'go to' alias, below a direct label match", () => {
    const flat = flatten(buildSections("go to sent", actions, gotos));
    expect(flat[0]?.label).toBe("Sent");
    const s = buildSections("s", actions, gotos).find((x) => x.id === "goto")!;
    expect(s.items[0]?.label).toBe("Sent");
  });

  it("caps each section while filtering", () => {
    const many = Array.from({ length: 30 }, (_, i) => action(`Action ${i}`));
    const sections = buildSections("action", many, []);
    expect(sections[0]?.items).toHaveLength(SECTION_LIMIT);
  });
});
