import type { InboxHealth } from "../../api/inbox-health";
import type { Inbox } from "../../api/types";

/* The From menu of compose. Pure. */

type Box = Pick<Inbox, "inbox_id" | "email_address" | "display_name"> & { health: InboxHealth };

/** The mailboxes a message can be sent from: the ones whose mail works. A
 *  mailbox that is down (per `/session`) is left out. The one the form is
 *  already set to stays listed whatever its state, so the menu never shows a
 *  different mailbox than the one the message would go out from. */
export function fromChoices<T extends Box>(boxes: readonly T[], current: string): T[] {
  return boxes.filter((b) => b.health.usable || b.inbox_id === current);
}

/** "a@x.com · Work", plus a short note when only this mailbox's send-as
 *  addresses need a reconnect (mail itself works). */
export function fromOptionLabel(box: Box, multi: boolean): string {
  const name = multi && box.display_name ? ` · ${box.display_name}` : "";
  const hint = box.health.senderHint ? " (send-as addresses need a reconnect)" : "";
  return `${box.email_address}${name}${hint}`;
}
