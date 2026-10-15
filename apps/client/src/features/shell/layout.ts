/* Pane layout maths, ported from the design prototype's renderVals().
 * Pure: window width + the user's saved widths + a few flags in, pixels out.
 * Unit-tested in layout.test.ts. */

export const LAYOUT = {
  /** Below this the app is the single-column phone layout. */
  PHONE_MAX: 760,
  /** The reader never gets less than this; other panes give way first. */
  READER_MIN: 340,
  /** Under this reader width the toolbar drops its text labels. */
  READER_NARROW: 560,

  SIDE_DEFAULT: 232,
  SIDE_RAIL: 64,
  SIDE_MAX: 360,
  /** Dragged below this, the sidebar snaps to the rail. */
  SIDE_SNAP: 140,
  /** Narrowest full (non-rail) sidebar a drag can produce. */
  SIDE_MIN_DRAG: 180,
  /** A saved width at or below this means "rail". */
  SIDE_RAIL_AT: 100,
  /** Without a saved width, the sidebar is a rail below this window width. */
  RAIL_BELOW: 1180,

  LIST_DEFAULT: 380,
  LIST_WIDE: 420,
  /** At or above this window width the list defaults to LIST_WIDE. */
  WIDE_FROM: 1440,
  LIST_MIN_SQUEEZED: 240,
  LIST_MIN_DRAG: 280,
  /** Floor for the list's drag maximum. */
  LIST_MAX_FLOOR: 300,
  /** Room a list drag must leave for the reader. */
  LIST_DRAG_READER: 380,

  PANEL_DEFAULT: 360,
  PANEL_MIN_SQUEEZED: 280,
  PANEL_MIN_DRAG: 300,
  PANEL_MAX: 640,
  /** Collapsed assistant strip. */
  PANEL_STRIP: 48,

  /** Arrow-key resize step on a splitter. */
  KEY_STEP: 16,
} as const;

export interface LayoutPrefs {
  sideW: number | null;
  listW: number | null;
  panelW: number | null;
}

export interface LayoutFlags {
  panelOpen: boolean;
  /** The user explicitly reopened a squeezed panel. */
  panelForced: boolean;
  /** A message is open in the reader (only then is the panel squeezed away). */
  hasSelection: boolean;
}

export interface Range {
  min: number;
  max: number;
}

export interface Layout {
  phone: boolean;
  /** Sidebar is the 64 px icon rail. */
  rail: boolean;
  wide: boolean;
  /** Pane widths in px. On phone these are not used. */
  side: number;
  list: number;
  /** Width of the open assistant panel. */
  panel: number;
  /** The panel is open in state but collapsed to the strip for lack of room. */
  panelSqueezed: boolean;
  /** The full panel is on screen. */
  panelShown: boolean;
  /** The 48 px strip is on screen instead. */
  panelStrip: boolean;
  /** Horizontal space the assistant takes (panel, strip, or 0 on phone). */
  panelSpace: number;
  reader: number;
  narrowReader: boolean;
  /** Reader toolbar shows text labels. */
  toolbarLabels: boolean;
  /** Splitter ranges (aria-valuemin / aria-valuemax and drag clamps). */
  bounds: { side: Range; list: Range; panel: Range };
}

export function computeLayout(vw: number, prefs: LayoutPrefs, flags: LayoutFlags): Layout {
  const L = LAYOUT;
  const phone = vw < L.PHONE_MAX;
  const { panelOpen } = flags;
  const panelPref = prefs.panelW ?? L.PANEL_DEFAULT;
  const panelNeed = panelOpen ? L.PANEL_MIN_SQUEEZED : L.PANEL_STRIP;

  // Not even the minimum of everything fits next to a full sidebar: use the rail.
  const tight = !phone && vw - (prefs.sideW ?? L.SIDE_DEFAULT) - L.LIST_MIN_SQUEEZED - panelNeed - L.READER_MIN < 0;
  const rail = !phone && (tight || (prefs.sideW != null ? prefs.sideW <= L.SIDE_RAIL_AT : vw < L.RAIL_BELOW));
  const wide = !phone && vw >= L.WIDE_FROM;

  const side = rail ? L.SIDE_RAIL : (prefs.sideW ?? L.SIDE_DEFAULT);
  let list = prefs.listW ?? (wide ? L.LIST_WIDE : L.LIST_DEFAULT);
  let panel = panelPref;

  // Out of room: shrink the list, then the panel, then collapse the panel.
  let over = side + list + (panelOpen ? panel : L.PANEL_STRIP) + L.READER_MIN - vw;
  if (over > 0) {
    const d = Math.max(0, Math.min(over, list - L.LIST_MIN_SQUEEZED));
    list -= d;
    over -= d;
  }
  if (over > 0 && panelOpen) {
    const d = Math.max(0, Math.min(over, panel - L.PANEL_MIN_SQUEEZED));
    panel -= d;
    over -= d;
  }
  const panelSqueezed = !phone && panelOpen && over > 0 && flags.hasSelection && !flags.panelForced;
  const panelShown = phone ? true : panelOpen && !panelSqueezed;
  const panelStrip = !phone && !panelShown;
  const panelSpace = phone ? 0 : panelShown ? panel : L.PANEL_STRIP;
  const reader = phone ? vw : vw - side - list - panelSpace;
  const narrowReader = !phone && reader < L.READER_NARROW;

  return {
    phone,
    rail,
    wide,
    side,
    list,
    panel,
    panelSqueezed,
    panelShown,
    panelStrip,
    panelSpace,
    reader,
    narrowReader,
    toolbarLabels: !phone && !narrowReader,
    bounds: {
      side: { min: L.SIDE_RAIL, max: L.SIDE_MAX },
      list: {
        min: L.LIST_MIN_DRAG,
        max: Math.max(L.LIST_MAX_FLOOR, vw - side - (panelShown ? panel : 0) - L.LIST_DRAG_READER),
      },
      panel: { min: L.PANEL_MIN_DRAG, max: L.PANEL_MAX },
    },
  };
}

export type SplitterKind = "side" | "list" | "panel";

/** Turns a raw dragged width into the width to store. The sidebar snaps to
 *  the rail below SIDE_SNAP; everything else clamps to its range. */
export function clampPaneWidth(kind: SplitterKind, raw: number, layout: Layout): number {
  const L = LAYOUT;
  if (kind === "side") {
    return raw < L.SIDE_SNAP ? L.SIDE_RAIL : Math.round(Math.min(L.SIDE_MAX, Math.max(L.SIDE_MIN_DRAG, raw)));
  }
  const b = layout.bounds[kind];
  return Math.round(Math.min(b.max, Math.max(b.min, raw)));
}

/** One arrow-key step. The sidebar jumps between the rail and its narrowest
 *  full width instead of crawling through the dead zone between them. */
export function stepPaneWidth(kind: SplitterKind, current: number, dir: 1 | -1, layout: Layout): number {
  const L = LAYOUT;
  if (kind === "side") {
    if (current <= L.SIDE_RAIL_AT) return dir > 0 ? L.SIDE_MIN_DRAG : L.SIDE_RAIL;
    if (dir < 0 && current - L.KEY_STEP < L.SIDE_MIN_DRAG) return L.SIDE_RAIL;
    return clampPaneWidth(kind, current + dir * L.KEY_STEP, layout);
  }
  return clampPaneWidth(kind, current + dir * L.KEY_STEP, layout);
}
