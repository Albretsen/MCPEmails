import { navigate } from "../app/router";
import { type FolderEntry, type FolderRef, type MessageKey, type MessageRow, isRoleRef } from "../api/types";
import { useComposeStore } from "../state/compose-store";
import { useSelectionStore } from "../state/selection-store";
import { remapKeys, resolveFolderEntry } from "./cache";
import { keys } from "./keys";
import { queryClient } from "./query-client";

/* Message ids are not stable across a move (an IMAP id is per folder). When a
 * move reports the ids the messages have now, everything that still points at
 * the old ones is rewritten: cached rows and bodies, the open message, the
 * multi-selection, the reply being written, and whatever else registered. */

export interface KeyPair {
  key: MessageKey;
  new_key: MessageKey;
}

type Listener = (map: ReadonlyMap<MessageKey, MessageKey>) => void;
const listeners = new Set<Listener>();

/** For stores that key state by message (labels, traces). */
export function onKeyRemap(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function applyKeyRemap(pairs: readonly KeyPair[], destination?: FolderRef | null): void {
  const map = new Map<MessageKey, MessageKey>();
  for (const p of pairs) if (p.key !== p.new_key) map.set(p.key, p.new_key);
  if (!map.size) return;

  // Rows that stay visible after the move (search results, Starred) now live
  // in the destination folder: say so where it can be worked out.
  const patch = (row: MessageRow): Partial<MessageRow> => {
    if (!destination) return {};
    const entries = queryClient.getQueryData<FolderEntry[]>(keys.folders(row.inbox_id)) ?? [];
    const entry = resolveFolderEntry(entries, row.inbox_id, destination);
    const out: Partial<MessageRow> = {};
    if (entry) out.folder = entry.id;
    if (isRoleRef(destination)) out.folder_role = destination.role;
    else if (entry) out.folder_role = null;
    return out;
  };
  remapKeys(pairs, patch);

  const selection = useSelectionStore.getState();
  const selected = selection.selectedKey ? map.get(selection.selectedKey) : undefined;
  const multi = selection.multiSel.some((k) => map.has(k));
  if (selected || multi) {
    useSelectionStore.setState({
      selectedKey: selected ?? selection.selectedKey,
      multiSel: selection.multiSel.map((k) => map.get(k) ?? k),
    });
    if (selected) navigate({ messageKey: selected }, { replace: true });
  }

  const compose = useComposeStore.getState().compose;
  const reply = compose?.replyTo ? map.get(compose.replyTo) : undefined;
  if (reply) useComposeStore.getState().patch({ replyTo: reply });

  for (const l of [...listeners]) l(map);
}
