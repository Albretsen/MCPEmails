import { describe, expect, it } from "vitest";
import { allowanceView, countSuffix } from "./model";

describe("allowanceView", () => {
  it("shows used / cap and a normal meter below 80%", () => {
    const v = allowanceView({ used: 312, cap: 1000 });
    expect(v.text).toBe("312 / 1,000");
    expect(v.fraction).toBeCloseTo(0.312);
    expect(v.tone).toBe("normal");
  });

  it("turns amber from 80% and never overflows the meter", () => {
    expect(allowanceView({ used: 799, cap: 1000 }).tone).toBe("normal");
    expect(allowanceView({ used: 800, cap: 1000 }).tone).toBe("warn");
    expect(allowanceView({ used: 5000, cap: 1000 }).fraction).toBe(1);
  });

  it("never renders a null cap as a number", () => {
    const v = allowanceView({ used: 42, cap: null });
    expect(v.text).toBe("42 used");
    expect(v.fraction).toBeNull();
    expect(v.tone).toBe("normal");
    expect(v.valueText).not.toMatch(/null|NaN|Infinity/);
  });
});

describe("countSuffix", () => {
  it("is empty for zero and words the count otherwise", () => {
    expect(countSuffix(0, "unread")).toBe("");
    expect(countSuffix(3, "unread")).toBe(", 3 unread");
    expect(countSuffix(1, "total")).toBe(", 1 email");
    expect(countSuffix(1200, "total")).toBe(", 1,200 emails");
  });
});
