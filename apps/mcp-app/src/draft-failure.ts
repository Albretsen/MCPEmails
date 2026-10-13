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

/** The action the editor was running when it failed. */
export type DraftAction = "save" | "send" | "refresh" | "discard" | "hide";

export interface DraftFailure {
  action: DraftAction;
  /**
   * A server `error_code`, or one of the two the card makes up for failures
   * that never reached the server's copy: `transport` (the call threw: offline,
   * a host timeout, a JSON-RPC error) and `unreadable` (an answer came back and
   * it was not an envelope).
   */
  code: string;
}

export interface FailureNotice {
  text: string;
  /** Offer "Check again", which re-reads the draft and reconciles. */
  recheck: boolean;
  /** Offer "Copy text": the draft cannot be written from here any more. */
  copy: boolean;
}

export function failureNotice(f: DraftFailure): FailureNotice {
  switch (f.code) {
    case "transport":
      return {
        text:
          f.action === "save"
            ? "Could not reach the server, so it is not clear whether your changes were saved. Your text is still here."
            : f.action === "send"
              ? "Could not reach the server, so it is not clear whether this was sent. Check before sending again."
              : f.action === "refresh"
                ? "Could not reach the server to check this draft. Your text is still here."
                : "Could not reach the server, so it is not clear whether that went through. Your text is still here.",
        recheck: true,
        copy: false,
      };
    case "draft_not_found":
      return {
        text: "This draft could not be found in Drafts. It may have been sent, deleted or saved again somewhere else, so it cannot be saved or sent from here right now. Your text is still here.",
        recheck: true,
        copy: true,
      };
    case "draft_has_attachments":
      return {
        text: "Not saved. This draft has attachments, and saving here would rebuild the message without them. Nothing was changed.",
        recheck: false,
        copy: false,
      };
    case "invalid_recipients":
      return {
        text: "Not saved. One of the addresses was rejected. Nothing was changed. Fix the recipients and save again.",
        recheck: false,
        copy: false,
      };
    case "provider_error":
      return {
        text: "The mail provider did not answer, so nothing was changed. Your text is still here. Try again in a moment.",
        recheck: f.action === "refresh",
        copy: false,
      };
    case "insufficient_scope":
      return {
        text: "This connection is not allowed to do that. Nothing was changed, and your text is still here.",
        recheck: false,
        copy: true,
      };
    case "insufficient_role":
      return {
        text: "Only workspace owners and admins can hide the editor for every inbox. Nothing was changed.",
        recheck: false,
        copy: false,
      };
    case "inbox_not_found":
      return {
        text: "This mailbox is no longer connected here, so nothing was changed. Your text is still here.",
        recheck: false,
        copy: true,
      };
    case "draft_editor_hidden":
    case "draft_editor_disabled":
      return {
        text: "The draft editor is turned off for this mailbox, so nothing was changed. Your text is still here.",
        recheck: false,
        copy: true,
      };
    default:
      return {
        text: "That did not work. Nothing was changed, and your text is still here.",
        recheck: f.action === "refresh",
        copy: false,
      };
  }
}
