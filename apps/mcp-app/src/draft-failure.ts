// ---------------------------------------------------------------------------
// What the draft editor says when something it started did not work.
//
// The server's own failure copy is written for two readers at once, and one of
// them is the model ("Reload the draft list to get the current id."). A
// transport failure has no copy at all, only `-32603: Failed to fetch`. Neither
// belongs in front of a person, so the editor never prints either: a known
// `error_code` maps to a sentence here, and everything else gets one generic
// sentence. Every sentence says what happened to the user's text, because that
// is the first thing anybody wants to know.
// ---------------------------------------------------------------------------

import type { DraftEditorData } from "./contract";
import { bodyTextChanged } from "./format";

/** The action the editor was running when it failed. */
export type DraftAction = "save" | "send" | "refresh" | "discard" | "hide";

/**
 * What a re-read after a LOST answer found (App.tsx#reconcile).
 *
 *   landed      the draft holds what the lost save sent: it was saved.
 *   not_landed  the draft does not hold it: it was not saved.
 *   still_there the draft is still in Drafts (after a lost send or discard).
 */
export type Settled = "landed" | "not_landed" | "still_there";

export interface DraftFailure {
  action: DraftAction;
  /**
   * A server `error_code`, or one of the two the card makes up for failures
   * that never reached the server's copy: `transport` (the call threw: offline,
   * a host timeout, a JSON-RPC error such as -32603) and `unreadable` (an answer
   * came back and it was not an envelope, e.g. a bare `isError` text result).
   */
  code: string;
  /**
   * The server's receipt headline, used ONLY to tell apart the cases one code
   * covers (a `draft_not_found` that the server knows was sent or discarded).
   * Never printed.
   */
  headline?: string | null;
  /** Set once a re-read after a lost answer has settled what happened. */
  settled?: Settled | null;
  /**
   * When the failed call was answered (ms epoch). Shown beside a failed check,
   * so checking again and getting the same answer still changes the screen.
   */
  at?: number;
}

export interface FailureNotice {
  text: string;
  tone: "danger" | "warning" | "success";
  /** Offer "Check again", which re-reads the draft and reconciles. */
  recheck: boolean;
  /** Offer "Try again", which repeats the save. */
  retry: boolean;
  /** Offer "Copy text": the draft cannot be written from here any more. */
  copy: boolean;
  /**
   * Offer "Load the newer version": the draft was rewritten after this copy was
   * loaded (`draft_changed`). Loading re-reads it and keeps the person's
   * unsaved edits on top (DraftEditor#rebaseEdit), so nothing typed is lost.
   */
  load?: boolean;
}

/**
 * A tool result that is not an envelope but IS an answer: `isError` with the
 * server's own sentence, the way `draft{action:"send"|"delete"}` refuses for
 * anything the lineage does not cover (draft not found, sending quota, a
 * mailbox that needs reconnecting, the approval queue unavailable). Returns
 * the code the card shows it under, or null when the result says nothing
 * certain (not an error, no text, a send whose delivery is unknown, or a
 * sentence that is not one of the server's refusals), which the caller then
 * treats as a lost answer. Only `draft{action}` answers are read this way: the
 * draft editor's own tools always answer with an envelope.
 *
 * These used to be "unreadable", i.e. a lost answer, and a send refused for
 * its quota read "the connection dropped while sending" with Send held off
 * (review 2 of 2026-10-13). An error result is the server saying it did not
 * act. The one exception is spelled out by the server itself:
 * `delivery_status: "unknown"` and "may or may not have been delivered" are
 * kept as a lost answer, because there the message may have gone.
 *
 * The sentence is matched only to pick a code; it is never shown (it is
 * written for the model and names tools and ids).
 */
export function textRefusalCode(
  result: { isError?: unknown; content?: unknown; [k: string]: unknown } | null | undefined,
): string | null {
  if (!result || result.isError !== true) return null;
  const parts = Array.isArray(result.content) ? result.content : [];
  const text = parts
    .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
    .join(" ")
    .trim();
  if (!text) return null;
  const sc = result.structuredContent as Record<string, unknown> | undefined;
  const delivery = result.delivery_status ?? sc?.delivery_status;
  if (delivery === "unknown" || /may or may not have been delivered/i.test(text)) return null;
  if (/\bnot found\b|no longer exists/i.test(text)) return "draft_not_found";
  if (/quota/i.test(text)) return "quota_exceeded";
  if (/reconnect|token has been revoked|oauth/i.test(text)) return "auth_failed";
  if (/approval request/i.test(text)) return "approval_unavailable";
  if (/no recipients/i.test(text)) return "draft_has_no_recipients";
  if (delivery === "not_sent" || /nothing was sent/i.test(text)) return "not_sent";
  // Anything else is not recognised as one of the server's own refusals. A
  // host can also report a failed call as a bare error sentence, and then the
  // server may well have acted: a lost answer, re-read and reconciled.
  return null;
}

/** A failure the card could not get an answer for: the server may have acted. */
export function isLostAnswer(code: string): boolean {
  return code === "transport" || code === "unreadable";
}

/** The actions whose lost answer leaves the stored draft in doubt. */
export function changesDraft(action: DraftAction): boolean {
  return action === "save" || action === "send" || action === "discard";
}

const KEEP = "Your text is still here.";

/** How a refusal that changed nothing opens, for the action that was refused. */
function lead(f: DraftFailure): string {
  switch (f.action) {
    case "send":
      return "Not sent.";
    case "save":
      return "Not saved.";
    case "discard":
      return "Not discarded.";
    default:
      return "That did not go through.";
  }
}

export function failureNotice(f: DraftFailure): FailureNotice {
  const base = { tone: "danger" as const, recheck: false, retry: false, copy: false };

  if (isLostAnswer(f.code)) {
    switch (f.settled) {
      case "landed":
        return {
          ...base,
          tone: "success",
          text: "The connection dropped, but your changes were saved.",
        };
      case "not_landed":
        return {
          ...base,
          tone: "warning",
          retry: true,
          text: `The connection dropped before your changes were saved. ${KEEP}`,
        };
      case "still_there":
        return f.action === "send"
          ? {
            ...base,
            tone: "warning",
            text: "The connection dropped while sending. The draft is still in Drafts, so it does not look like it was sent, but we could not confirm it. Check your Sent folder before sending again.",
          }
          : {
            ...base,
            tone: "warning",
            text: `The connection dropped, and the draft is still in Drafts, so nothing was changed. ${KEEP}`,
          };
    }
    return {
      ...base,
      recheck: true,
      text:
        f.action === "save"
          ? `Could not reach the server, so it is not clear whether your changes were saved. ${KEEP}`
          : f.action === "send"
            ? "Could not reach the server, so it is not clear whether this was sent. Check your Sent folder before sending again."
            : f.action === "refresh"
              ? `Could not reach the server to check this draft. ${KEEP}`
              : `Could not reach the server, so it is not clear whether that went through. ${KEEP}`,
    };
  }

  switch (f.code) {
    case "draft_changed":
      // Somebody (the assistant, another card, a second device) wrote the
      // draft after this copy was loaded. Nothing was written or sent.
      return {
        ...base,
        tone: "warning",
        copy: true,
        load: true,
        text: f.action === "send"
          ? `Not sent. This draft was changed somewhere else after you opened it, so it was not sent. ${KEEP} Load the newer version and check it before sending.`
          : `Not saved. This draft was changed somewhere else after you opened it, so saving here would replace that version. ${KEEP} Load the newer version to see what changed; your edits stay on top.`,
      };
    // Refusals that arrive as a bare error sentence (`textRefusalCode`). The
    // server did not act, so these say so and leave Send where it was.
    case "quota_exceeded":
      return {
        ...base,
        tone: "warning",
        text: `${lead(f)} Your email account has reached its sending limit for now. ${KEEP} Try again later.`,
      };
    case "auth_failed":
      return {
        ...base,
        copy: true,
        text: `${lead(f)} This mailbox needs to be reconnected in MCP Emails first. ${KEEP}`,
      };
    case "approval_unavailable":
      return {
        ...base,
        tone: "warning",
        text: `${lead(f)} This mailbox asks for approval before sending, and the approval could not be set up just now. ${KEEP} Try again in a moment.`,
      };
    case "draft_has_no_recipients":
      return {
        ...base,
        tone: "warning",
        text: `${lead(f)} This draft has no recipients. Add someone to send it to.`,
      };
    case "not_sent":
      return {
        ...base,
        tone: "warning",
        text: `${lead(f)} The mail server refused it before anything went out, so trying again is safe. ${KEEP}`,
      };
    case "draft_already_sent":
      return {
        ...base,
        tone: "warning",
        copy: true,
        text: `This draft was already sent, so it cannot be saved or sent again from here. ${KEEP}`,
      };
    case "draft_not_found": {
      // The newer server knows when a draft it cannot find was SENT or
      // DISCARDED (draft lineage) and says so in the headline, under the same
      // code. Older servers only ever say "could not be found".
      const h = String(f.headline ?? "");
      if (/already sent/i.test(h)) {
        return {
          ...base,
          tone: "warning",
          copy: true,
          text: `This draft was already sent, so it cannot be saved or sent again from here. ${KEEP}`,
        };
      }
      if (/discarded/i.test(h)) {
        return {
          ...base,
          tone: "warning",
          copy: true,
          text: `This draft was discarded, so it cannot be saved or sent from here. ${KEEP}`,
        };
      }
      return {
        ...base,
        recheck: true,
        copy: true,
        text: `This draft could not be found in Drafts. It may have been sent, deleted or saved again somewhere else, so it cannot be saved or sent from here right now. ${KEEP}`,
      };
    }
    case "draft_has_attachments":
      return {
        ...base,
        text: "Not saved. This draft has attachments, and saving here would rebuild the message without them. Nothing was changed.",
      };
    case "invalid_recipients":
      return {
        ...base,
        text: "Not saved. One of the addresses was rejected, so nothing was changed. Fix the recipients and save again.",
      };
    case "provider_error":
      return {
        ...base,
        recheck: f.action === "refresh",
        retry: f.action === "save",
        text: `The mail provider did not answer, so nothing was changed. ${KEEP}`,
      };
    case "insufficient_scope":
      return {
        ...base,
        copy: true,
        text: `This connection is not allowed to do that. Nothing was changed. ${KEEP}`,
      };
    case "insufficient_role":
      return {
        ...base,
        text: "Only workspace owners and admins can hide the editor for every inbox. Nothing was changed.",
      };
    case "inbox_not_found":
      return {
        ...base,
        copy: true,
        text: `This mailbox is no longer connected here, so nothing was changed. ${KEEP}`,
      };
    case "draft_editor_hidden":
    case "draft_editor_disabled":
      return {
        ...base,
        copy: true,
        text: `The draft editor is turned off for this mailbox, so nothing was changed. ${KEEP}`,
      };
    default:
      return {
        ...base,
        recheck: f.action === "refresh",
        retry: f.action === "save",
        text: `That did not work. Nothing was changed. ${KEEP}`,
      };
  }
}

/** Compare addresses the way a mailbox does: the bare address, any case. */
function addressKey(a: string): string {
  const angled = /<([^>]+)>/.exec(a);
  return (angled ? angled[1] : a).trim().toLowerCase();
}

function sameAddresses(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => addressKey(v) === addressKey(b[i]));
}

export interface PatchFields {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body_text?: string;
}

/**
 * Does `draft` hold what `patch` asked for? Decides whether a save whose
 * answer was lost actually happened (QA 2026-10-13: a save came back as
 * `-32603: Failed to fetch` after the server had stored it under a new id).
 *
 * Only the fields the patch carried are compared, and with the same
 * tolerances the editor uses elsewhere: line endings in the body
 * (`bodyTextChanged`), and case and display names in addresses. An empty patch
 * cannot tell, and answers false: claiming "saved" is the direction that
 * costs the user their edits.
 */
export function patchLanded(
  patch: PatchFields,
  draft: DraftEditorData | null | undefined,
): boolean {
  if (!draft) return false;
  const keys = (["to", "cc", "bcc", "subject", "body_text"] as const).filter(
    (k) => patch[k] !== undefined,
  );
  if (keys.length === 0) return false;
  for (const k of keys) {
    if (k === "subject") {
      if ((draft.subject ?? "") !== patch.subject) return false;
    } else if (k === "body_text") {
      if (bodyTextChanged(patch.body_text ?? "", draft.body?.text ?? "")) return false;
    } else if (!sameAddresses(patch[k] ?? [], draft.recipients?.[k] ?? [])) {
      return false;
    }
  }
  return true;
}

/**
 * Which notice about the person's own unsaved edits may be shown, if any.
 *
 * The one place this is decided, because the two it chooses between both offer
 * something ("saving will replace the newer version", "Use the newer version",
 * "Discard these edits") and an offer is only honest while it can be taken up.
 * QA, 2026-10-13: the amber "saving will replace the newer version" sat under
 * the red "it cannot be saved or sent from here".
 *
 *   - Saving is not possible (read only, or the draft is `unverified`): none.
 *     The notice that says why saving is off is the one notice, and it already
 *     says the text is still here.
 *   - `conflict` is a claim about what the mailbox holds, so it needs a copy
 *     that has been checked (`trusted`). Against a replay still being checked
 *     it is only "your edits were put back".
 */
export function editsNotice(s: {
  canEdit: boolean;
  check: "trusted" | "pending" | "checking" | "unverified";
  restored: boolean;
  conflict: boolean;
}): "conflict" | "restored" | null {
  if (!s.canEdit || s.check === "unverified") return null;
  if (s.conflict && s.check === "trusted") return "conflict";
  return s.restored ? "restored" : null;
}
