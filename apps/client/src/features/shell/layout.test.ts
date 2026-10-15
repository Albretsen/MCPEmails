import { describe, expect, it } from "vitest";
import { LAYOUT, type LayoutFlags, type LayoutPrefs, clampPaneWidth, computeLayout, stepPaneWidth } from "./layout";

const NONE: LayoutPrefs = { sideW: null, listW: null, panelW: null };
const OPEN: LayoutFlags = { panelOpen: true, panelForced: false, hasSelection: true };
const CLOSED: LayoutFlags = { panelOpen: false, panelForced: false, hasSelection: true };

describe("computeLayout", () => {
  it("uses the wide defaults at 1440 and up", () => {
    const l = computeLayout(1440, NONE, OPEN);
    expect(l).toMatchObject({ phone: false, rail: false, wide: true, side: 232, list: 420, panel: 360 });
    expect(l.panelShown).toBe(true);
    expect(l.panelStrip).toBe(false);
    expect(l.reader).toBe(1440 - 232 - 420 - 360);
    expect(l.toolbarLabels).toBe(false); // 428 px reader is under 560
  });

  it("uses the 380 list below 1440", () => {
    const l = computeLayout(1300, NONE, OPEN);
    expect(l.wide).toBe(false);
    expect(l.rail).toBe(false);
    expect(l.list).toBe(380 - (232 + 380 + 360 + 340 - 1300)); // squeezed by 12
    expect(l.reader).toBe(LAYOUT.READER_MIN);
  });

  it("collapses the sidebar to a 64 px rail below 1180", () => {
    const l = computeLayout(1179, NONE, OPEN);
    expect(l.rail).toBe(true);
    expect(l.side).toBe(64);
    expect(computeLayout(1180, NONE, OPEN).rail).toBe(false);
  });

  it("honours a saved sidebar width over the 1180 rule", () => {
    expect(computeLayout(1100, { ...NONE, sideW: 232 }, CLOSED).rail).toBe(false);
    expect(computeLayout(1600, { ...NONE, sideW: 64 }, OPEN).rail).toBe(true);
    expect(computeLayout(1600, { ...NONE, sideW: 100 }, OPEN).side).toBe(64);
  });

  it("forces the rail when even the minimums do not fit beside a full sidebar", () => {
    // 232 + 240 + 280 + 340 = 1092
    expect(computeLayout(1091, { ...NONE, sideW: 232 }, OPEN).rail).toBe(true);
    expect(computeLayout(1092, { ...NONE, sideW: 232 }, OPEN).rail).toBe(false);
  });

  it("shrinks the list first, down to 240", () => {
    const l = computeLayout(1100, NONE, OPEN); // rail: 64 + 380 + 360 + 340 = 1144, over 44
    expect(l.side).toBe(64);
    expect(l.list).toBe(336);
    expect(l.panel).toBe(360);
    expect(l.panelSqueezed).toBe(false);
  });

  it("then shrinks the panel, down to 280", () => {
    const l = computeLayout(960, NONE, OPEN); // over 184: list -140 -> 240, panel -44 -> 316
    expect(l.list).toBe(240);
    expect(l.panel).toBe(316);
    expect(l.panelSqueezed).toBe(false);
    expect(l.reader).toBe(340);
  });

  it("then collapses the panel to a 48 px strip", () => {
    const l = computeLayout(900, NONE, OPEN); // 64 + 240 + 280 + 340 = 924 > 900
    expect(l.panelSqueezed).toBe(true);
    expect(l.panelShown).toBe(false);
    expect(l.panelStrip).toBe(true);
    expect(l.panelSpace).toBe(48);
    expect(l.reader).toBe(900 - 64 - 240 - 48);
  });

  it("does not squeeze the panel when the user forced it open", () => {
    const l = computeLayout(900, NONE, { ...OPEN, panelForced: true });
    expect(l.panelSqueezed).toBe(false);
    expect(l.panelShown).toBe(true);
    expect(l.panel).toBe(280);
  });

  it("does not squeeze the panel when no message is open", () => {
    const l = computeLayout(900, NONE, { ...OPEN, hasSelection: false });
    expect(l.panelSqueezed).toBe(false);
    expect(l.panelShown).toBe(true);
  });

  it("shows the strip when the panel is closed", () => {
    const l = computeLayout(1440, NONE, CLOSED);
    expect(l.panelShown).toBe(false);
    expect(l.panelStrip).toBe(true);
    expect(l.panelSpace).toBe(48);
    expect(l.reader).toBe(1440 - 232 - 420 - 48);
    expect(l.toolbarLabels).toBe(true);
  });

  it("respects saved list and panel widths", () => {
    const l = computeLayout(1920, { sideW: 300, listW: 500, panelW: 480 }, OPEN);
    expect(l).toMatchObject({ side: 300, list: 500, panel: 480 });
    expect(l.reader).toBe(1920 - 300 - 500 - 480);
  });

  it("is the phone layout below 760", () => {
    const l = computeLayout(759, NONE, OPEN);
    expect(l.phone).toBe(true);
    expect(l.rail).toBe(false);
    expect(l.panelSqueezed).toBe(false);
    expect(l.panelShown).toBe(true);
    expect(l.panelStrip).toBe(false);
    expect(l.panelSpace).toBe(0);
    expect(l.reader).toBe(759);
    expect(l.toolbarLabels).toBe(false);
    expect(computeLayout(760, NONE, OPEN).phone).toBe(false);
  });

  it("reports splitter ranges", () => {
    const l = computeLayout(1600, NONE, OPEN);
    expect(l.bounds.side).toEqual({ min: 64, max: 360 });
    expect(l.bounds.panel).toEqual({ min: 300, max: 640 });
    expect(l.bounds.list).toEqual({ min: 280, max: 1600 - 232 - 360 - 380 });
    // The list maximum never drops under 300.
    expect(computeLayout(800, NONE, { ...OPEN, hasSelection: false }).bounds.list.max).toBe(300);
  });

  it("never returns a reader narrower than READER_MIN while panes can still give", () => {
    for (let vw = 960; vw <= 2000; vw += 20) {
      expect(computeLayout(vw, NONE, OPEN).reader).toBeGreaterThanOrEqual(LAYOUT.READER_MIN);
    }
  });
});

describe("clampPaneWidth", () => {
  const l = computeLayout(1600, NONE, OPEN);

  it("snaps the sidebar to the rail below 140", () => {
    expect(clampPaneWidth("side", 139, l)).toBe(64);
    expect(clampPaneWidth("side", 20, l)).toBe(64);
  });
  it("keeps the sidebar between 180 and 360 otherwise", () => {
    expect(clampPaneWidth("side", 140, l)).toBe(180);
    expect(clampPaneWidth("side", 250.4, l)).toBe(250);
    expect(clampPaneWidth("side", 900, l)).toBe(360);
  });
  it("clamps the list to 280..max and the panel to 300..640", () => {
    expect(clampPaneWidth("list", 100, l)).toBe(280);
    expect(clampPaneWidth("list", 5000, l)).toBe(l.bounds.list.max);
    expect(clampPaneWidth("panel", 100, l)).toBe(300);
    expect(clampPaneWidth("panel", 5000, l)).toBe(640);
  });
});

describe("stepPaneWidth", () => {
  const l = computeLayout(1600, NONE, OPEN);

  it("moves 16 px per arrow press", () => {
    expect(stepPaneWidth("list", 380, 1, l)).toBe(396);
    expect(stepPaneWidth("panel", 360, -1, l)).toBe(344);
  });
  it("jumps the sidebar across the dead zone between rail and 180", () => {
    expect(stepPaneWidth("side", 64, 1, l)).toBe(180);
    expect(stepPaneWidth("side", 180, -1, l)).toBe(64);
    expect(stepPaneWidth("side", 64, -1, l)).toBe(64);
    expect(stepPaneWidth("side", 232, 1, l)).toBe(248);
  });
});
