import { create } from "zustand";

/* One toast at a time. 5 s by default, paused while hovered or focused.
 * Toasts never take focus (the host renders role=status, aria-live=polite). */

export interface ToastInput {
  text: string;
  /** Shows an Undo button. Runs at most once. */
  undo?: () => void | Promise<void>;
  /** Another button ("Retry"). Runs at most once; ignored when `undo` is set. */
  action?: { label: string; run: () => void | Promise<void> };
  durationMs?: number;
  kind?: "info" | "error";
}

export interface Toast extends ToastInput {
  id: number;
  durationMs: number;
  kind: "info" | "error";
}

export interface ToastState {
  toast: Toast | null;
  paused: boolean;
  /** Replaces any toast on screen. Returns its id. */
  show(input: ToastInput | string): number;
  /** Without an id, dismisses whatever is showing. */
  dismiss(id?: number): void;
  /** Runs the toast's undo and dismisses it. */
  runUndo(): void;
  /** Runs the toast's action and dismisses it. */
  runAction(): void;
  pause(): void;
  resume(): void;
}

export const DEFAULT_TOAST_MS = 5000;

let seq = 1;
let timer: ReturnType<typeof setTimeout> | null = null;
let endsAt = 0;
let remaining = 0;

function clear(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

export const useToastStore = create<ToastState>((set, get) => {
  const arm = (id: number, ms: number) => {
    clear();
    remaining = ms;
    endsAt = Date.now() + ms;
    timer = setTimeout(() => get().dismiss(id), ms);
  };

  return {
    toast: null,
    paused: false,
    show: (input) => {
      const t = typeof input === "string" ? { text: input } : input;
      const toast: Toast = {
        ...t,
        id: seq++,
        durationMs: t.durationMs ?? DEFAULT_TOAST_MS,
        kind: t.kind ?? "info",
      };
      set({ toast, paused: false });
      arm(toast.id, toast.durationMs);
      return toast.id;
    },
    dismiss: (id) => {
      const cur = get().toast;
      if (!cur || (id != null && cur.id !== id)) return;
      clear();
      set({ toast: null, paused: false });
    },
    runUndo: () => {
      const cur = get().toast;
      if (!cur) return;
      get().dismiss(cur.id);
      void cur.undo?.();
    },
    runAction: () => {
      const cur = get().toast;
      if (!cur) return;
      get().dismiss(cur.id);
      void cur.action?.run();
    },
    pause: () => {
      if (!get().toast || get().paused) return;
      remaining = Math.max(0, endsAt - Date.now());
      clear();
      set({ paused: true });
    },
    resume: () => {
      const cur = get().toast;
      if (!cur || !get().paused) return;
      set({ paused: false });
      // Always leave at least a second to react after the pointer leaves.
      arm(cur.id, Math.max(1000, remaining));
    },
  };
});

/** Shorthand for non-React callers. */
export function showToast(input: ToastInput | string): number {
  return useToastStore.getState().show(input);
}
