import { useEffect, useMemo } from "react";
import { mailActions } from "../../data";
import { isComposeEmpty, useComposeStore } from "../../state/compose-store";
import { canWrite } from "../../state/permissions";
import { type Autosaver, createAutosaver, useAutosaveStatus } from "./autosave";

/* Wires the autosaver to the compose form. One instance at a time (there is
 * one compose surface), reachable through `settleAutosave` by code outside
 * the card (the pane's close button).
 *
 * The form calls `touch()` from its own change handlers. Changes that do not
 * come from the user (the assistant streaming, a saved draft's body arriving)
 * are deliberately not "typing" and never start a save.
 */

let current: Autosaver | null = null;

/** Stops the pending autosave and waits for the one in flight. Call before
 *  anything that reads `draft_id` (close, send, discard): the id changes on
 *  every save, so acting on it mid-save would leave a stale draft behind. */
export async function settleAutosave(): Promise<void> {
  await current?.settle();
}

async function saveOnce(): Promise<void> {
  const before = useComposeStore.getState().compose;
  // A read-only workspace member cannot save drafts.
  if (!canWrite()) return;
  if (!before || before.streaming || before.held || isComposeEmpty(before)) return;
  await mailActions.saveDraft({ keepOpen: true, silent: true });
  const after = useComposeStore.getState().compose;
  // saveDraft reports its own failure with a toast and resolves; tell the status line too.
  if (after && after.savedAt === before.savedAt && after.replyTo === before.replyTo) throw new Error("draft_not_saved");
}

export function useAutosave(): Autosaver {
  const saver = useMemo(
    () => createAutosaver({ save: saveOnce, onStatus: (status) => useAutosaveStatus.getState().set(status) }),
    [],
  );
  const opened = useComposeStore((x) => x.openSeq);

  // A different form opened in the same card: nothing of the old one is pending.
  useEffect(() => {
    saver.cancel();
    useAutosaveStatus.getState().set("idle");
  }, [opened, saver]);

  useEffect(() => {
    current = saver;
    return () => {
      saver.cancel();
      if (current === saver) current = null;
      useAutosaveStatus.getState().set("idle");
    };
  }, [saver]);

  return saver;
}
