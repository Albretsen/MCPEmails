/* What the assistant panel shows, as pure functions of state: which context
 * chip, which suggestions, which placeholder, which requests are collapsed.
 * Ported from the design prototype's renderVals(). */

import type { MessageKey, MessageRow } from "../../api/types";
import { displayName, firstName } from "../../lib/format";
import type { AssistantMessage, LastAct } from "../../state/assistant-store";

export interface Suggestion {
  label: string;
  /** Scenario the button asks for (sent as the request's `intent`). */
  intent: string;
  /** Does not use an allowance action. */
  free?: boolean;
}

export interface StandardAction extends Suggestion {
  icon: "file-pen" | "align-left";
  title: string;
}

/** How many requests stay visible before "Show N earlier requests". */
export const RECENT_TURNS = 3;
/** The panel width from which tool-call steps show their mono meta text. */
export const STEP_META_MIN_WIDTH = 400;

/** The email the composer can attach: the open one, unless it is the user's own. */
export function attachable(row: MessageRow | undefined): MessageRow | null {
  if (!row) return null;
  const role = row.folder_role;
  return role === "drafts" || role === "sent" || role === "scheduled" ? null : row;
}

/**
 * The email the composer acts on RIGHT NOW: the attachable open email, and on
 * phone only while the reader is the screen showing. A phone shows one screen
 * at a time and the selection outlives the reader (it is what restores the
 * list's position on the way back), so on the list or the compose screen the
 * "open" email is not on screen: no "Draft a reply", no "Summarize", no chip
 * naming an email the person cannot see.
 */
export function onScreenTarget(
  row: MessageRow | undefined,
  view: { phone: boolean; screen: "list" | "reader" | "compose" },
): MessageRow | null {
  if (view.phone && view.screen !== "reader") return null;
  return attachable(row);
}

/** Emails that ride along with the next message. `conversation`: every
 *  message of the open conversation, given when the person chose "the whole
 *  conversation" (otherwise the chip carries the focused message alone). */
export function chipKeys(o: {
  inboxRun: boolean;
  multiSel: MessageKey[];
  target: MessageRow | null;
  ctxOff: boolean;
  conversation?: MessageKey[] | null;
}): MessageKey[] {
  if (o.inboxRun) return [];
  if (o.multiSel.length > 1) return o.multiSel;
  if (!o.target || o.ctxOff) return [];
  return o.conversation && o.conversation.length > 1 ? o.conversation : [o.target.key];
}

export function chipLabel(keys: MessageKey[], target: MessageRow | null, wholeConversation = false): string {
  if (wholeConversation && keys.length > 1 && target) return `Conversation · ${target.subject} (${keys.length} emails)`;
  if (keys.length > 1) return `${keys.length} emails`;
  return keys.length && target ? `${displayName(target.from)} · ${target.subject}` : "";
}

export function composerPlaceholder(o: { busy: boolean; keys: MessageKey[]; target: MessageRow | null; aiDraftInline: boolean }): string {
  if (o.busy) return "Working… Esc to stop";
  if (o.keys.length > 1) return `Ask about these ${o.keys.length} emails…`;
  if (o.keys.length && o.target) {
    return o.aiDraftInline ? "Ask for changes to the draft…" : `Ask about ${firstName(displayName(o.target.from))}'s email…`;
  }
  return "Ask about all your mail…";
}

/** Follow-ups for the open email, from what the assistant last did with it. */
export function threadSuggestions(o: {
  busy: boolean;
  target: MessageRow | null;
  act: LastAct | undefined;
  /** A reply to the open email is in the editor. */
  inline: boolean;
  /** ...and the assistant wrote it, it is not held, and it is not streaming. */
  aiDraftReady: boolean;
  /** The user's last question about this email. */
  lastQuestion: string | undefined;
}): Suggestion[] {
  if (o.busy || !o.target) return [];
  const first = firstName(displayName(o.target.from));
  if (o.inline) {
    return o.aiDraftReady
      ? [
          { label: "Make it shorter", intent: "shorter" },
          { label: "Make it warmer", intent: "warmer" },
          { label: "Review and send", intent: "send" },
        ]
      : [];
  }
  if (o.act === "about") {
    return [
      { label: "What do they need from me?", intent: "about" },
      { label: "Any deadlines?", intent: "about" },
      { label: `Earlier from ${first}`, intent: "sender" },
    ].filter((x) => x.label !== o.lastQuestion);
  }
  if (o.act === "sent") {
    return [
      { label: "Archive this email", intent: "archiveOne" },
      { label: `Earlier from ${first}`, intent: "sender" },
    ];
  }
  if (o.act === "sender") return [{ label: "Archive this email", intent: "archiveOne" }];
  return [];
}

/** Starters shown while the conversation is empty and no email is open. */
export function inboxSuggestions(o: { busy: boolean; empty: boolean; firstRun: boolean }): Suggestion[] {
  if (o.busy || !o.empty) return [];
  const out: Suggestion[] = [];
  if (o.firstRun) out.push({ label: "Go through my inbox", intent: "firstrun", free: true });
  out.push({ label: "What needs a reply?", intent: "needs" });
  out.push({ label: "File this week's receipts", intent: "receipts" });
  return out.slice(0, 3);
}

const AUTOMATED =
  /^(no-?reply|do-?not-?reply|notifications?|notify|receipts?|billing|invoices?|aws-billing|news(letter)?|digest|issue|dispatch|hello|reservations?|stay|mailer|updates?|alerts?|info|team)$/i;

/** Best guess at "a person wrote this", so "Draft a reply" is only offered
 *  where a reply makes sense. The assistant itself decides for real. */
export function looksLikePerson(row: Pick<MessageRow, "from">): boolean {
  const email = row.from.email.toLowerCase();
  const local = email.split("@")[0] ?? "";
  const domain = email.split("@")[1] ?? "";
  if (AUTOMATED.test(local) || /\+|bounce|mailer/.test(local)) return false;
  if (/newsletter|digest|weekly/.test(domain)) return false;
  return true;
}

export function standardActions(o: { target: MessageRow | null; inline: boolean }): StandardAction[] {
  if (!o.target || o.inline) return [];
  const out: StandardAction[] = [];
  if (looksLikePerson(o.target)) {
    out.push({ label: "Draft a reply", intent: "draft", icon: "file-pen", title: "The assistant writes a reply under the email" });
  }
  out.push({ label: "Summarize", intent: "summary", icon: "align-left", title: "A short summary of this email" });
  return out;
}

/** As many suggestions as fit one row of the given width (always at least one).
 *  Same arithmetic as the prototype: 7 px per character plus pill padding,
 *  after the "Suggested" label and the pane's own padding. */
export function fitSuggestions<T extends { label: string }>(list: T[], width: number): T[] {
  let room = width - 28 - 84;
  const out: T[] = [];
  for (const g of list) {
    const w = g.label.length * 7 + 26;
    if (out.length && w > room) break;
    out.push(g);
    room -= w + 6;
  }
  return out;
}

/** Splits the transcript into the requests shown and how many are folded away. */
export function visibleMessages(messages: AssistantMessage[], showEarlier: boolean): { shown: AssistantMessage[]; turns: number; hidden: number } {
  const turns = [...new Set(messages.map((m) => m.turn))];
  if (showEarlier || turns.length <= RECENT_TURNS) return { shown: messages, turns: turns.length, hidden: 0 };
  const keep = new Set(turns.slice(-RECENT_TURNS));
  return { shown: messages.filter((m) => keep.has(m.turn)), turns: turns.length, hidden: turns.length - RECENT_TURNS };
}

export function earlierLabel(turns: number, showEarlier: boolean): string {
  if (showEarlier) return "Show only recent";
  const n = turns - RECENT_TURNS;
  return `Show ${n} earlier ${n === 1 ? "request" : "requests"}`;
}

/** Header status line. */
export function panelStatus(o: { held: boolean; busy: boolean; status: string; progress: { i: number; n: number } | null }): {
  text: string;
  tone: "idle" | "busy" | "held";
} {
  if (o.held) return { text: "A reply needs your approval", tone: "held" };
  if (o.busy) return { text: o.status + (o.progress ? ` · ${o.progress.i} of ${o.progress.n}` : ""), tone: "busy" };
  return { text: "Asks before sending", tone: "idle" };
}
