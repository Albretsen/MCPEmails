import type { Inbox, InboxStatusReason } from "./types";

/* What the app does with a mailbox's `status` / `status_reason` from
 * `/session` (the server derives them without opening the mailbox, so they
 * can be trusted without a failing mail call).
 *
 * The server's word wins. What the client heard from mail calls itself
 * (`refused`: a call answered `reconnect_required` since the last `/session`)
 * only adds to it, for a mailbox that starts failing mid-session, and stands
 * in for it when the server does not send `status` at all.
 */

export interface InboxHealth {
  /** Mail calls for this mailbox can work. False: they are not made. */
  usable: boolean;
  /** Mail works, but the send-as addresses need a reconnect. */
  senderHint: boolean;
  reason: InboxStatusReason | null;
  /** Reconnecting in the dashboard is the fix. */
  reconnectable: boolean;
  /** Text for the person, or null when there is nothing to say. */
  notice: string | null;
  /** The code a list uses for this mailbox when it is left out. */
  code: "reconnect_required" | "inbox_unavailable" | null;
}

export const INBOX_NOTICE = {
  password_refused: "This mailbox's password was refused. Reconnect it in the dashboard.",
  access_revoked: "Access to this mailbox expired. Reconnect it in the dashboard.",
  no_mailbox: "This mailbox is unavailable.",
  unavailable: "This mailbox is unavailable.",
  /** A refusal heard from a mail call, with no reason from the server yet. */
  generic: "This mailbox needs reconnecting in the dashboard.",
} as const;

/** Shown in the From menu of compose, nowhere else. */
export const SENDER_IDENTITY_HINT = "Send-as addresses for this mailbox need a reconnect in the dashboard.";

const HEALTHY: InboxHealth = { usable: true, senderHint: false, reason: null, reconnectable: false, notice: null, code: null };

function down(reason: InboxStatusReason | null): InboxHealth {
  const dead = reason === "no_mailbox" || reason === "unavailable";
  return {
    usable: false,
    senderHint: false,
    reason,
    reconnectable: !dead,
    notice: reason && reason !== "sender_identity" ? INBOX_NOTICE[reason] : INBOX_NOTICE.generic,
    code: dead ? "inbox_unavailable" : "reconnect_required",
  };
}

export function inboxHealth(inbox: Pick<Inbox, "status" | "status_reason" | "sender_identity_status">, refused = false): InboxHealth {
  const { status } = inbox;
  const reason = inbox.status_reason ?? null;
  if (status === "error") return down(reason === "sender_identity" || reason == null ? "unavailable" : reason);
  if (status === "reconnect_required" && reason !== "sender_identity") return down(reason);
  // From here on the server says mail works, or says nothing.
  if (refused) return down(null);
  if (status === "reconnect_required") return { ...HEALTHY, senderHint: true, reason: "sender_identity" };
  if (status === "ok") return HEALTHY;
  // A server without `status`: its sender identity field is all there is.
  return inbox.sender_identity_status === "reconnect_required" ? { ...HEALTHY, senderHint: true, reason: "sender_identity" } : HEALTHY;
}

/** Whether `/session` carries per-inbox status at all. */
export function hasServerStatus(inboxes: readonly Pick<Inbox, "status">[]): boolean {
  return inboxes.some((i) => i.status !== undefined);
}

/** The mailboxes mail calls are made for. */
export function usableInboxes<T extends Pick<Inbox, "inbox_id" | "status" | "status_reason" | "sender_identity_status">>(
  inboxes: readonly T[],
  refused: Readonly<Record<string, true>> = {},
): T[] {
  return inboxes.filter((i) => inboxHealth(i, refused[i.inbox_id] === true).usable);
}

