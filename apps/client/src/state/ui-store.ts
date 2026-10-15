import { create } from "zustand";

/* UI chrome state: viewport class, pane widths, which panel/screen/menu is
 * showing. Nothing derived is stored here: the actual pixel layout is computed
 * by features/shell/layout.ts from these preferences plus the window width. */

export type Viewport = "phone" | "desktop";
export type PhoneScreen = "list" | "reader" | "compose";
export type PaneKind = "side" | "list" | "panel";
/** Menus are mutually exclusive. Panes may add their own ids. */
export type MenuId = "move" | "schedule" | "scenes" | "help" | (string & {});

export const PHONE_MAX_WIDTH = 760;
export const LAYOUT_STORAGE_KEY = "mc-layout-v1";
const SETTINGS_STORAGE_KEY = "mc-settings-v1";

export interface UiSettings {
  /** Single-key shortcuts (WCAG 2.1.4: must be possible to turn off). */
  shortcutsEnabled: boolean;
  /** Group mail into conversations (list rows and the reader). Default on. */
  conversationView: boolean;
}

export interface UiState {
  viewport: Viewport;
  /** null = use the default for the current window width. */
  sideW: number | null;
  listW: number | null;
  panelW: number | null;
  panelOpen: boolean;
  /** The user opened the panel while it was squeezed to a strip: keep it open. */
  panelForced: boolean;
  /** Phone only: which full-screen view is showing. */
  screen: PhoneScreen;
  /** Phone only: the assistant dock is expanded to full screen. */
  chatFull: boolean;
  menu: MenuId | null;
  /** The pointer is over the message list (changes there are held meanwhile). */
  listHover: boolean;
  settings: UiSettings;

  setViewport(v: Viewport): void;
  setPaneWidth(kind: PaneKind, width: number | null): void;
  resetLayout(kinds?: PaneKind[]): void;
  setPanelOpen(open: boolean): void;
  /** Desktop: show/hide the panel. Phone: grow/shrink the dock. */
  togglePanel(): void;
  forcePanel(): void;
  setScreen(screen: PhoneScreen): void;
  setChatFull(full: boolean): void;
  setMenu(menu: MenuId | null): void;
  toggleMenu(menu: MenuId): void;
  setListHover(hover: boolean): void;
  setSetting<K extends keyof UiSettings>(key: K, value: UiSettings[K]): void;
}

const WIDTH_KEY: Record<PaneKind, "sideW" | "listW" | "panelW"> = { side: "sideW", list: "listW", panel: "panelW" };

function readJson<T>(key: string): Partial<T> {
  try {
    const raw = localStorage.getItem(key);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" ? (v as Partial<T>) : {};
  } catch {
    return {};
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota: layout just is not remembered */
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function initialViewport(): Viewport {
  return typeof window !== "undefined" && window.innerWidth < PHONE_MAX_WIDTH ? "phone" : "desktop";
}

const savedLayout = readJson<{ sideW: number; listW: number; panelW: number }>(LAYOUT_STORAGE_KEY);
const savedSettings = readJson<UiSettings>(SETTINGS_STORAGE_KEY);

export const useUiStore = create<UiState>((set, get) => {
  const saveLayout = () => {
    const { sideW, listW, panelW } = get();
    writeJson(LAYOUT_STORAGE_KEY, { sideW, listW, panelW });
  };

  return {
    viewport: initialViewport(),
    sideW: num(savedLayout.sideW),
    listW: num(savedLayout.listW),
    panelW: num(savedLayout.panelW),
    panelOpen: true,
    panelForced: false,
    screen: "list",
    chatFull: false,
    menu: null,
    listHover: false,
    settings: {
      shortcutsEnabled: savedSettings.shortcutsEnabled !== false,
      conversationView: savedSettings.conversationView !== false,
    },

    setViewport: (viewport) => {
      if (get().viewport !== viewport) set({ viewport, listHover: false });
    },
    setPaneWidth: (kind, width) => {
      const key = WIDTH_KEY[kind];
      const value = width == null ? null : Math.round(width);
      if (get()[key] === value) return;
      set({ [key]: value } as Pick<UiState, typeof key>);
      saveLayout();
    },
    resetLayout: (kinds = ["side", "list", "panel"]) => {
      const patch: Partial<UiState> = {};
      for (const k of kinds) patch[WIDTH_KEY[k]] = null;
      set(patch);
      saveLayout();
    },
    setPanelOpen: (panelOpen) => set({ panelOpen, panelForced: false }),
    togglePanel: () => {
      const s = get();
      if (s.viewport === "phone") set({ chatFull: !s.chatFull });
      else set({ panelOpen: !s.panelOpen, panelForced: false });
    },
    forcePanel: () => set({ panelOpen: true, panelForced: true }),
    setScreen: (screen) => {
      if (get().screen !== screen) set({ screen });
    },
    setChatFull: (chatFull) => {
      if (get().chatFull !== chatFull) set({ chatFull });
    },
    setMenu: (menu) => {
      if (get().menu !== menu) set({ menu });
    },
    toggleMenu: (menu) => set({ menu: get().menu === menu ? null : menu }),
    setListHover: (listHover) => {
      if (get().listHover !== listHover) set({ listHover });
    },
    setSetting: (key, value) => {
      const settings = { ...get().settings, [key]: value };
      set({ settings });
      writeJson(SETTINGS_STORAGE_KEY, settings);
    },
  };
});

/* ---- selectors ---- */
export const selectIsPhone = (s: UiState): boolean => s.viewport === "phone";
export const selectLayoutCustom = (s: UiState): boolean => s.sideW != null || s.listW != null || s.panelW != null;
/** Whether the assistant's transcript is on screen right now. */
export const selectAssistantVisible = (s: UiState): boolean => (s.viewport === "phone" ? s.chatFull : s.panelOpen);

export const selectConversationView = (s: UiState): boolean => s.settings.conversationView;

export const isPhone = (): boolean => useUiStore.getState().viewport === "phone";
