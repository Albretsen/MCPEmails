// ---------------------------------------------------------------------------
// The pure half of the watcher: "did new mail arrive?" and "what does the
// notification say?". No I/O, no clock of its own, nothing logged.
//
// DID NEW MAIL ARRIVE. The watcher compares the inbox folder's cursor from the
// last check with the one from this check. The cursor is the fingerprint
// mail/status.ts computes, plus the folder's two counters. A fingerprint moves
// for ANY change (a star, a read flag, a delete), so a moved fingerprint alone
// never notifies. New mail is:
//
//   IMAP     same UIDVALIDITY, UIDNEXT grew (a message was added), AND the
//            folder's message count or unread count grew. The second half
//            leaves out a message that was already read, moved or deleted by
//            another client or a server rule before this check saw it.
//   Outlook  the folder's total AND unread counters both grew.
//   Gmail    the mailbox historyId moved: the caller then asks the history
//            API which messages were ADDED to the inbox since the old id.
//            (Counters are the fallback when history cannot answer.)
//
// A first look at a mailbox (no cursor), a cursor too old to trust, and a
// cursor that cannot be compared (UIDVALIDITY changed) all just record the new
// cursor: nobody is notified about mail that was already there.
// ---------------------------------------------------------------------------

import { stripInvisibleText } from "../../mcp-server/text-safety.ts";
import type { FolderCursor, PayloadMode, Recipient } from "./store.ts";

export type Arrival =
  /** Nothing to compare with: record the cursor and say nothing. */
  | { kind: "first" }
  /** The fingerprint did not move. */
  | { kind: "unchanged" }
  /** Something changed, but no new mail (flags, a delete, a move, a read). */
  | { kind: "changed" }
  /** The cursors cannot be compared (UIDVALIDITY changed). Start again. */
  | { kind: "reset" }
  /** Gmail: something changed; ask history what was added since `startHistoryId`. */
  | { kind: "ask_history"; startHistoryId: string }
  | { kind: "new"; count: number };

interface ImapCursor {
  uidValidity: string;
  uidNext: number;
}

/** `i:{uidValidity}:{uidNext}:...` as written by mail/status.ts. */
export function parseImapFingerprint(fingerprint: string): ImapCursor | null {
  const match = /^i:(\d+):(\d+):/.exec(fingerprint);
  if (!match) return null;
  const uidNext = Number(match[2]);
  return Number.isSafeInteger(uidNext) ? { uidValidity: match[1], uidNext } : null;
}

/** `g:{historyId}` as written by mail/status.ts. */
export function parseGmailFingerprint(fingerprint: string): string | null {
  return /^g:(\d{1,24})$/.exec(fingerprint)?.[1] ?? null;
}

function grew(before: number | null, after: number | null): number {
  return before !== null && after !== null && after > before ? after - before : 0;
}

/** Both counters grew: the smaller growth is how many unread messages were added. */
export function counterArrival(previous: FolderCursor, next: FolderCursor): Arrival {
  const total = grew(previous.total, next.total);
  const unread = grew(previous.unread, next.unread);
  return total > 0 && unread > 0 ? { kind: "new", count: Math.min(total, unread) } : { kind: "changed" };
}

export function detectArrival(provider: string, previous: FolderCursor | null, next: FolderCursor): Arrival {
  if (!previous) return { kind: "first" };
  if (previous.fingerprint === next.fingerprint) return { kind: "unchanged" };

  if (provider === "gmail") {
    const start = parseGmailFingerprint(previous.fingerprint);
    return start && parseGmailFingerprint(next.fingerprint) ? { kind: "ask_history", startHistoryId: start } : { kind: "reset" };
  }
  if (provider === "outlook") return counterArrival(previous, next);

  const before = parseImapFingerprint(previous.fingerprint);
  const after = parseImapFingerprint(next.fingerprint);
  if (!before || !after || before.uidValidity !== after.uidValidity) return { kind: "reset" };
  const added = after.uidNext - before.uidNext;
  if (added <= 0) return { kind: "changed" };
  const visible = Math.max(grew(previous.total, next.total), grew(previous.unread, next.unread));
  return visible > 0 ? { kind: "new", count: Math.min(added, visible) } : { kind: "changed" };
}

// ── quiet hours ─────────────────────────────────────────────────────────────

/** Minutes after local midnight in `timezone` at `nowMs`, or null for an unknown zone. */
export function localMinutes(timezone: string, nowMs: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(nowMs));
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    const minute = Number(parts.find((p) => p.type === "minute")?.value);
    return Number.isFinite(hour) && Number.isFinite(minute) ? (hour % 24) * 60 + minute : null;
  } catch {
    return null;
  }
}

export function isValidTimezone(timezone: string): boolean {
  return localMinutes(timezone, 0) !== null;
}

/**
 * Is `nowMs` inside this recipient's quiet hours. start == end is an empty
 * window; start > end crosses midnight. An unknown time zone is "not quiet":
 * a missed quiet window is a notification, a wrongly applied one is silence.
 */
export function inQuietHours(
  quiet: Pick<Recipient, "quiet_start" | "quiet_end" | "quiet_timezone">,
  nowMs: number,
): boolean {
  const { quiet_start: start, quiet_end: end, quiet_timezone: zone } = quiet;
  if (start === null || end === null || !zone || start === end) return false;
  const minute = localMinutes(zone, nowMs);
  if (minute === null) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

// ── the notification ────────────────────────────────────────────────────────

/** What the watcher read from the mailbox for a "rich" notification. In memory only. */
export interface NewMessage {
  id: string;
  from: string;
  subject: string;
}

export const MAX_LISTED = 3;
const MAX_NAME = 60;
const MAX_SUBJECT = 110;
const MAX_LABEL = 80;

function clip(text: string, max: number): string {
  // Sender and subject arrive as TEXT: the list rows they come from are
  // decoded by the one header path every caller has (RFC 2047 words and raw
  // 8-bit octets, mcp-server/mime.ts). What is left to do here is what a lock
  // screen needs: no control characters, nothing invisible (zero-width
  // padding, bidi overrides that would reorder a sender's name), no U+FFFD,
  // runs of whitespace as one space.
  const clean = stripInvisibleText(text.replace(/\p{Cc}+/gu, " "))
    .replace(/\ufffd/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Counted and cut in code points, so the cut never leaves half a surrogate pair.
  const chars = Array.from(clean);
  return chars.length <= max ? clean : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** "Maya Berg <maya@north.example>" -> "Maya Berg"; a bare address stays an address. */
export function senderName(from: string): string {
  const text = from.trim();
  const angle = /^\s*"?([^"<]*?)"?\s*<([^<>]*)>\s*$/.exec(text);
  const name = angle ? (angle[1].trim() || angle[2].trim()) : text;
  return clip(name, MAX_NAME) || "Unknown sender";
}

export interface NewMailPayload {
  type: "new_mail";
  mode: PayloadMode;
  title: string;
  body: string;
  /** In-app path the notification opens. */
  url: string;
  /** One notification per mailbox on screen: a newer one replaces it. */
  tag: string;
  inbox_id: string;
  count: number;
  /** Unread messages in that mailbox's inbox, for the app badge. */
  unread: number | null;
}

/** The app's route for a mailbox's inbox, and for one message in it (apps/client router.ts). */
export function mailboxUrl(inboxId: string, messageId?: string): string {
  const base = `/${encodeURIComponent(inboxId)}/inbox`;
  return messageId ? `${base}/${encodeURIComponent(`${inboxId}:${messageId}`)}` : base;
}

/** RFC 8030 Topic and the notification tag are both per mailbox. */
export function topicFor(inboxId: string): string {
  return inboxId.replace(/-/g, "").slice(0, 32);
}

export function buildNewMailPayload(input: {
  mode: PayloadMode;
  inboxId: string;
  /** The mailbox's own name or address, as its owner set it. */
  mailboxLabel: string;
  count: number;
  unread: number | null;
  /** Newest first. Ignored in private mode. */
  messages: NewMessage[];
}): NewMailPayload {
  const count = Math.max(1, Math.round(input.count));
  const label = clip(input.mailboxLabel, MAX_LABEL) || "your mailbox";
  const base = {
    type: "new_mail" as const,
    tag: `mail-${input.inboxId}`,
    inbox_id: input.inboxId,
    count,
    unread: input.unread,
  };
  const listed = input.mode === "rich" ? input.messages.slice(0, MAX_LISTED) : [];
  if (listed.length === 0) {
    // Private mode, and the fallback when the newest messages could not be read.
    return {
      ...base,
      mode: "private",
      title: "New mail",
      body: `${count} new ${count === 1 ? "message" : "messages"} in ${label}`,
      url: mailboxUrl(input.inboxId),
    };
  }
  const subject = (m: NewMessage) => clip(m.subject, MAX_SUBJECT) || "(no subject)";
  if (count === 1) {
    return {
      ...base,
      mode: "rich",
      title: senderName(listed[0].from),
      body: subject(listed[0]),
      url: mailboxUrl(input.inboxId, listed[0].id),
    };
  }
  const lines = listed.map((m) => `${senderName(m.from)}: ${subject(m)}`);
  const more = count - listed.length;
  if (more > 0) lines.push(`and ${more} more`);
  return {
    ...base,
    mode: "rich",
    title: `${count} new messages in ${label}`,
    body: lines.join("\n"),
    url: mailboxUrl(input.inboxId),
  };
}

/** The fixed payload of "Send test notification". No mailbox is read to build it. */
export const TEST_PAYLOAD = {
  type: "test",
  title: "MCP Emails",
  body: "Notifications are working on this device.",
  url: "/",
  tag: "push-test",
} as const;
