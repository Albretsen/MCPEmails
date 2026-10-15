import { describe, expect, it } from "vitest";
import { cx } from "./cx";
import { diffWords } from "./diffWords";
import { formatBytes, formatListTime, initials, pluralize } from "./format";

describe("diffWords", () => {
  it("returns one keep op for identical text", () => {
    expect(diffWords("a b c", "a b c")).toEqual([{ k: "keep", t: "a b c" }]);
  });

  it("marks replaced words and merges adjacent ops", () => {
    const ops = diffWords("Thursday at 2pm works for me.", "Friday at 2pm works well for me.");
    expect(ops.filter((o) => o.k === "del").map((o) => o.t)).toEqual(["Thursday"]);
    expect(ops.filter((o) => o.k === "ins").map((o) => o.t.trim())).toEqual(["Friday", "well"]);
    for (let i = 1; i < ops.length; i++) expect(ops[i]?.k).not.toBe(ops[i - 1]?.k);
  });

  it("reconstructs both sides", () => {
    const a = "Hi Maya,\n\nGreat news, thanks for pushing this through legal. Thursday at 2pm works for me.";
    const b = "Hi Maya,\n\nThursday at 2pm works. I'll send an invite shortly.";
    const ops = diffWords(a, b);
    expect(ops.filter((o) => o.k !== "ins").map((o) => o.t).join("")).toBe(a);
    expect(ops.filter((o) => o.k !== "del").map((o) => o.t).join("")).toBe(b);
  });
});

describe("format", () => {
  const now = new Date(2026, 9, 3, 9, 52).getTime();

  it("shows a time today, a weekday this week, a date before that", () => {
    expect(formatListTime(new Date(2026, 9, 3, 9, 41).toISOString(), now)).toMatch(/9:41/);
    expect(formatListTime(new Date(2026, 8, 29, 12, 0).toISOString(), now)).toMatch(/Tue/);
    expect(formatListTime(new Date(2026, 8, 20, 12, 0).toISOString(), now)).toMatch(/Sep 20/);
    expect(formatListTime(new Date(2025, 8, 20, 12, 0).toISOString(), now)).toMatch(/2025/);
    expect(formatListTime("not a date", now)).toBe("");
  });

  it("a later day (a scheduled send) is not shown as a bare time", () => {
    // Tomorrow 8:00: "Sun 8:00 AM", never "8:00 AM" (which would read as today).
    expect(formatListTime(new Date(2026, 9, 4, 8, 0).toISOString(), now)).toMatch(/Sun.*8:00/);
    expect(formatListTime(new Date(2026, 9, 3, 23, 30).toISOString(), now)).toMatch(/^11:30/);
    expect(formatListTime(new Date(2026, 10, 20, 8, 0).toISOString(), now)).toMatch(/Nov 20/);
  });

  it("makes initials, sizes and plurals", () => {
    expect(initials("Maya Chen")).toBe("MC");
    expect(initials("", "kale@hn.com")).toBe("K");
    expect(initials("")).toBe("?");
    expect(formatBytes(184_320)).toBe("180 KB");
    expect(pluralize(1, "email")).toBe("1 email");
    expect(pluralize(1200, "email")).toBe("1,200 emails");
  });

  it("joins class names", () => {
    expect(cx("a", false, undefined, "b", null, 0)).toBe("a b");
  });
});
