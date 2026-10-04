import { create } from "zustand";
import type { MessageKey } from "../api/types";

/* Rows that are in the cache but not shown yet, because showing them would
 * move what is under the pointer: a mailbox that answered late put them
 * between rows the person is looking at. They wait behind the same
 * "N new emails" pill as new mail does, and are shown when the pointer
 * leaves the list or the pill is pressed. Nothing else is held back:
 * every other change to a list passes through. */

interface HeldRows {
  keys: Record<MessageKey, true>;
}

export const useHeldRows = create<HeldRows>(() => ({ keys: {} }));

export function holdRows(keys: readonly MessageKey[]): void {
  if (!keys.length) return;
  const next = { ...useHeldRows.getState().keys };
  for (const k of keys) next[k] = true;
  useHeldRows.setState({ keys: next });
}

/** Shows everything that was held. */
export function releaseHeldRows(): void {
  for (const _ in useHeldRows.getState().keys) {
    useHeldRows.setState({ keys: {} });
    return;
  }
}

export function hasHeldRows(): boolean {
  for (const _ in useHeldRows.getState().keys) return true;
  return false;
}
