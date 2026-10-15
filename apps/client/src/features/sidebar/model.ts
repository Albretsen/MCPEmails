import { INBOX_NOTICE, type InboxHealth } from "../../api/inbox-health";
import { type AssistantAllowance, type Inbox, allowanceFraction, formatAllowance } from "../../api/types";

/* Pure derivations for the sidebar. */

/** From this share of the monthly allowance the meter turns amber. */
export const ALLOWANCE_WARN_AT = 0.8;

export interface AllowanceView {
  /** "312 / 1,000", or "312 used" when the plan has no cap. */
  text: string;
  /** 0..1 for the meter. null = no cap, so there is nothing to measure against. */
  fraction: number | null;
  tone: "normal" | "warn";
  /** Spoken value of the meter. */
  valueText: string;
}

/** A null cap means unlimited and is never turned into a number or a bar. */
export function allowanceView(a: Pick<AssistantAllowance, "used" | "cap">): AllowanceView {
  const fraction = allowanceFraction(a);
  const used = a.used.toLocaleString("en-US");
  return {
    text: formatAllowance(a),
    fraction,
    tone: fraction != null && fraction >= ALLOWANCE_WARN_AT ? "warn" : "normal",
    valueText:
      a.cap == null
        ? `${used} assistant actions used, no monthly limit`
        : `${used} of ${a.cap.toLocaleString("en-US")} assistant actions used`,
  };
}

type Box = Pick<Inbox, "email_address" | "status"> & { health: InboxHealth };

/** Why a mailbox carries the warning badge, or null. A mailbox whose mail
 *  works and whose send-as list alone needs a reconnect has no badge: that
 *  is said in compose's From menu, where it matters. (A server that sends no
 *  `status` only has that one signal, and keeps the badge it always had.) */
export function mailboxProblem(box: Box): string | null {
  if (!box.health.usable) return box.health.notice;
  return box.health.senderHint && box.status === undefined ? INBOX_NOTICE.generic : null;
}

/** The line under the mailbox list: what is wrong, and whether reconnecting
 *  in the dashboard is the fix. One mailbox: its own reason. */
export function sidebarAttention(boxes: readonly Box[]): { text: string; reconnect: boolean } | null {
  const bad = boxes.filter((b) => mailboxProblem(b) != null);
  const first = bad[0];
  if (!first) return null;
  const reconnect = bad.some((b) => b.health.usable || b.health.reconnectable);
  if (bad.length === 1) {
    const why = mailboxProblem(first) ?? "";
    // With one mailbox in all, "this mailbox" needs no name in front.
    return { text: boxes.length === 1 ? why : `${first.email_address}: ${why}`, reconnect };
  }
  const allReconnect = bad.every((b) => b.health.usable || b.health.reconnectable);
  return { text: allReconnect ? `${bad.length} mailboxes need reconnecting.` : `${bad.length} mailboxes need attention.`, reconnect };
}

/** Text for assistive tech after a nav item's name: ", 3 unread" / ", 12 emails". */
export function countSuffix(count: number, kind: "unread" | "total"): string {
  if (count <= 0) return "";
  const n = count.toLocaleString("en-US");
  return kind === "unread" ? `, ${n} unread` : `, ${n} ${count === 1 ? "email" : "emails"}`;
}
