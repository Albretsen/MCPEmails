/* Hand-off between the palette's loading placeholder (./index.tsx) and the
 * palette itself (./CommandPalette.tsx, a separate chunk).
 *
 * If ⌘K is pressed before the chunk has arrived, the placeholder takes focus at
 * once, so nothing the user types lands in the field they came from. What they
 * typed, and the element to give focus back to on close, wait here. */

export interface PendingPalette {
  query: string;
  returnTo: HTMLElement | null;
}

const EMPTY: PendingPalette = { query: "", returnTo: null };

let pending: PendingPalette = EMPTY;

export function setPending(next: Partial<PendingPalette>): void {
  pending = { ...pending, ...next };
}

/** Read-only (safe to call from a render that React may repeat). */
export function takePending(): PendingPalette {
  return pending;
}

export function clearPending(): void {
  pending = EMPTY;
}
