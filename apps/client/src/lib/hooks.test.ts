import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDebouncedValue } from "./hooks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const isBlank = (q: string) => q.trim() === "";
let seen: string[] = [];
function Probe({ value }: { value: string }) {
  const settled = useDebouncedValue(value, 300, isBlank);
  if (seen[seen.length - 1] !== settled) seen.push(settled);
  return null;
}

let root: Root;
const show = (value: string) => act(() => root.render(createElement(Probe, { value })));
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
  seen = [];
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe("useDebouncedValue (the search field)", () => {
  it("typing passes only the value the typing paused on", () => {
    show("");
    for (const q of ["w", "we", "wel", "welc"]) {
      show(q);
      wait(80);
    }
    expect(seen).toEqual([""]);
    wait(300);
    expect(seen).toEqual(["", "welc"]);
  });

  it("clearing passes at once, and a value present at mount is not delayed", () => {
    show("welcome");
    expect(seen).toEqual(["welcome"]);
    show("");
    expect(seen).toEqual(["welcome", ""]);
    // Typing again right after clearing does not bring the old value back.
    show("n");
    expect(seen).toEqual(["welcome", ""]);
    wait(300);
    expect(seen).toEqual(["welcome", "", "n"]);
  });
});
