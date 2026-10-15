/* Undo stack. Every undoable action pushes one entry; the toast's Undo button
 * and the `z` shortcut both run the most recent one. An entry runs at most
 * once, and expires (a stale undo against a mailbox that has moved on is worse
 * than no undo). */

export interface UndoEntry {
  id: number;
  /** What the action was: "Archived", "Moved to Trash". */
  label: string;
  run: () => void | Promise<void>;
  at: number;
}

const MAX_ENTRIES = 20;
const EXPIRES_MS = 60_000;

let seq = 1;
let stack: UndoEntry[] = [];

export function pushUndo(label: string, run: () => void | Promise<void>): UndoEntry {
  const entry: UndoEntry = { id: seq++, label, run, at: Date.now() };
  stack.push(entry);
  if (stack.length > MAX_ENTRIES) stack = stack.slice(-MAX_ENTRIES);
  return entry;
}

function take(id?: number): UndoEntry | null {
  const now = Date.now();
  stack = stack.filter((e) => now - e.at < EXPIRES_MS);
  const i = id == null ? stack.length - 1 : stack.findIndex((e) => e.id === id);
  if (i < 0) return null;
  const [entry] = stack.splice(i, 1);
  return entry ?? null;
}

/** Runs one entry (the latest when no id is given). Returns its label, or null
 *  when there was nothing to undo. */
export function runUndo(id?: number): string | null {
  const entry = take(id);
  if (!entry) return null;
  void entry.run();
  return entry.label;
}

/** Removes an entry without running it (its window passed, e.g. a send went out). */
export function dropUndo(id: number): void {
  stack = stack.filter((e) => e.id !== id);
}

export function peekUndo(): UndoEntry | null {
  return stack[stack.length - 1] ?? null;
}

export function clearUndo(): void {
  stack = [];
}
