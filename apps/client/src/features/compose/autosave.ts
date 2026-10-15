import { create } from "zustand";

/* Autosave scheduling, free of React.
 *
 * Why this is more than a debounce: on IMAP a draft's id CHANGES on every
 * update. Two overlapping saves would both send the old id, and the second
 * would update a draft that no longer exists (or create a duplicate). So saves
 * are strictly serialised: one in flight at a time, and edits made while a
 * save is running schedule exactly one more save after it lands, which then
 * reads the fresh id from the store.
 */

export type AutosaveStatus = "idle" | "saving" | "saved" | "error";

export interface AutosaverOptions {
  /** Performs one save. Must read the CURRENT form (and draft id) itself. */
  save: () => Promise<void>;
  delayMs?: number;
  onStatus?: (status: AutosaveStatus) => void;
}

export interface Autosaver {
  /** The content changed: (re)start the quiet period. */
  touch(): void;
  /** Saves now if anything is pending, and resolves when nothing is in flight. */
  flush(): Promise<void>;
  /** Drops the pending timer and resolves when the in-flight save (if any) is
   *  done. Use before send / discard so they see the latest draft id. */
  settle(): Promise<void>;
  /** Drops the pending timer. An in-flight save still completes. */
  cancel(): void;
  readonly pending: boolean;
}

export const AUTOSAVE_DELAY_MS = 1500;

export function createAutosaver({ save, delayMs = AUTOSAVE_DELAY_MS, onStatus }: AutosaverOptions): Autosaver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let dirty = false;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const run = (): Promise<void> => {
    clear();
    if (inFlight) return inFlight; // `dirty` stays set: one more save follows.
    if (!dirty) return Promise.resolve();
    dirty = false;
    onStatus?.("saving");
    inFlight = save()
      .then(
        () => onStatus?.("saved"),
        () => onStatus?.("error"),
      )
      .then(() => {
        inFlight = null;
        // Typed during the save: start a new quiet period, do not save at once.
        if (dirty && !timer) timer = setTimeout(() => void run(), delayMs);
      });
    return inFlight;
  };

  return {
    touch() {
      dirty = true;
      clear();
      timer = setTimeout(() => void run(), delayMs);
    },
    async flush() {
      clear();
      if (inFlight) await inFlight;
      clear();
      if (dirty) await run();
    },
    async settle() {
      clear();
      dirty = false;
      if (inFlight) await inFlight;
      clear();
      dirty = false;
    },
    cancel() {
      clear();
      dirty = false;
    },
    get pending() {
      return dirty || !!inFlight;
    },
  };
}

/* The status line ("Saving…" / "Saved") is shown by the compose bar and the
 * inline card, which do not share a parent. Feature-local, not app state. */
export const useAutosaveStatus = create<{ status: AutosaveStatus; set(status: AutosaveStatus): void }>((set, get) => ({
  status: "idle",
  set: (status) => {
    if (get().status !== status) set({ status });
  },
}));
