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
            text: "The connection dropped while sending. The draft is still in Drafts, so it does not look like it was sent. Check your Sent folder before sending again.",
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
