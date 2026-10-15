import { isOpenInReader } from "../state/conversation-store";
import { subscribeRoute } from "../app/router";
import { getMailApi } from "../api";
import type { MailEvent, MessageRow } from "../api/types";
import { useAssistantStore } from "../state/assistant-store";
import { useComposeStore } from "../state/compose-store";
import { hasHeldRows, releaseHeldRows } from "../state/held-rows";
import { useSelectionStore } from "../state/selection-store";
import { useUiStore } from "../state/ui-store";
import { addToFolderCounts, applyFlags, insertInboxRows, refreshFolders, refreshLists, removeMovedRows } from "./cache";
import { canWrite } from "../state/permissions";
import { flushPendingSends, newCompose, saveDraft } from "./mail-actions";

/* Wires the outside world into the cache and keeps the stores consistent with
 * each other. Started once from app/providers.tsx. */

/** How long after the pointer leaves the list before held mail is inserted. */
const INSERT_AFTER_LEAVE_MS = 250;

/** Inserts rows at the top of the inbox lists, highlights them, bumps counts. */
export function insertNewMail(rows: MessageRow[]): void {
  if (!rows.length) return;
  insertInboxRows(rows);
  addToFolderCounts(rows);
  const assistant = useAssistantStore.getState();
  assistant.markFresh(rows.map((r) => r.key));
  assistant.bumpFolder({ role: "inbox" }, rows.length);
}

/** Inserts whatever new mail was held while the pointer was on the list
 *  (pointer left, or the "N new emails" pill was pressed). */
export function flushPendingNew(): void {
  insertNewMail(useAssistantStore.getState().takePendingNew());
  // Rows of a mailbox that answered late wait behind the same pill.
  releaseHeldRows();
}

function onMailEvent(event: MailEvent): void {
  switch (event.type) {
    case "new_mail": {
      const ui = useUiStore.getState();
      // Nothing moves under the pointer: hold the rows and show a pill instead.
      if (ui.listHover && ui.viewport !== "phone") useAssistantStore.getState().addPendingNew(event.rows);
      else insertNewMail(event.rows);
      break;
    }
    case "flags_changed":
      applyFlags(event.keys, event.flags);
      refreshFolders();
      break;
    case "moved":
      removeMovedRows(event.keys, event.to);
      refreshLists();
      refreshFolders();
      break;
  }
}

let stop: (() => void) | null = null;

export function startRealtime(): () => void {
  if (stop) return stop;
  const unsubs: (() => void)[] = [];

  unsubs.push(getMailApi().subscribe(onMailEvent));

  // Pointer left the list: insert held mail shortly after, if it stayed away.
  let leaveTimer: ReturnType<typeof setTimeout> | null = null;
  unsubs.push(
    useUiStore.subscribe((s, prev) => {
      if (s.listHover === prev.listHover) return;
      if (leaveTimer) clearTimeout(leaveTimer);
      leaveTimer = null;
      if (s.listHover) return;
      useAssistantStore.getState().setLinkCall(null);
      if (!useAssistantStore.getState().pendingNew.length && !hasHeldRows()) return;
      leaveTimer = setTimeout(() => {
        if (!useUiStore.getState().listHover) flushPendingNew();
      }, INSERT_AFTER_LEAVE_MS);
    }),
  );

  // Opening a different email while a draft is open saves that draft, unless
  // it answers the newly opened email, is held, or the assistant is writing it.
  unsubs.push(
    useSelectionStore.subscribe((s, prev) => {
      if (s.selectedKey === prev.selectedKey || !s.selectedKey) return;
      const c = useComposeStore.getState().compose;
      if (!c || isOpenInReader(c.replyTo, s.selectedKey) || c.held || c.streaming) return;
      if (useAssistantStore.getState().busy && c.ai) return;
      // A read-only member cannot save drafts (and never has a form open).
      if (!canWrite()) return;
      void saveDraft({ silent: true });
    }),
  );

  // Back/Forward across /compose.
  unsubs.push(
    subscribeRoute((route, cause) => {
      if (cause !== "pop") return;
      const c = useComposeStore.getState().compose;
      if (!canWrite()) return;
      if (!route.compose && c && !c.replyTo) void saveDraft({ silent: true });
      else if (route.compose && !c) newCompose();
    }),
  );

  // A send still inside its undo window must not be lost when the page closes.
  window.addEventListener("pagehide", flushPendingSends);
  unsubs.push(() => window.removeEventListener("pagehide", flushPendingSends));

  stop = () => {
    for (const u of unsubs) u();
    if (leaveTimer) clearTimeout(leaveTimer);
    stop = null;
  };
  return stop;
}
