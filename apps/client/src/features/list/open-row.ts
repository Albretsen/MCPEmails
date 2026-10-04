import type { MessageRow } from "../../api/types";
import { mailActions } from "../../data/mail-actions";
import { canWrite } from "../../state/permissions";
import { useSelectionStore } from "../../state/selection-store";

/** Opens a row the way a click does. A draft normally opens in the editor; a
 *  read-only workspace member cannot save or send one, so it opens in the
 *  reader like any other email. */
export function openRow(row: MessageRow): void {
  if (row.folder_role === "drafts" && !canWrite()) useSelectionStore.getState().select(row.key);
  else mailActions.openRow(row);
}
