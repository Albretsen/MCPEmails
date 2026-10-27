/**
 * sent-card.ts — what the card shows under a direct send, reply or forward.
 *
 * The outbound card is listed on `email_compose` (and per-operation
 * email_send / email_reply / email_forward) for every key that can send
 * (index.ts#keyCanSendOutbound), so the host mounts it under every ordinary
 * send. Until 2026-10-27 it could only say "Sent to Dana" in one line, and on
 * a failure "did not complete. The reply above says why", because the result
 * holds neither the message that went out nor a reason a person can read.
 * Reply and forward fail 11-12% of the time, and the user only ever saw the
 * model's paraphrase of a text written for the model.
 *
 * This module builds the facts the card needs, and index.ts puts them in the
 * result's `_meta[SENT_CARD_META_KEY]`. `_meta`, not `structuredContent`: the
 * model's text result stays byte-identical, and some hosts show
 * `structuredContent` to the model (the draft card's deferred body uses the
 * same channel for the same reason). A host that drops result `_meta` on the
 * way to the view gets the one-line receipt the card drew before.
 *
 * Pure: no I/O. index.ts calls Deno.serve at load and cannot be imported by a
 * test, so the decisions live here.
 */

import { htmlPreviewText } from "./text-extract.ts";

export const SENT_CARD_META_KEY = "mcpemails/sent_card";

/** Dispatch names whose results get the sent card. */
export const SENT_CARD_OPERATIONS: ReadonlySet<string> = new Set(["email_send", "email_reply", "email_forward"]);

/** The card shows a preview; past this the full text is in the Sent folder. */
export const SENT_CARD_BODY_MAX = 4000;

/** What the handler sent, noted before transmission (index.ts#noteSentCard). */
export interface SentCardFacts {
  from: string | null;
  text: string | null | undefined;
  html?: string | null;
  cc?: readonly string[];
  bcc?: readonly string[];
  attachments?: ReadonlyArray<{ filename: string; data: string }>;
}

export type SentCard =
  | {
    outcome: "sent";
    from: string | null;
    cc: string[];
    bcc: string[];
    body_text: string;
    truncated: boolean;
    attachments: Array<{ filename: string; size_bytes: number }>;
    /** False only when an IMAP APPEND to Sent was refused (sent-copy.ts). */
    sent_copy: boolean;
  }
  | { outcome: "not_sent" | "unknown" | "waiting"; headline: string; detail: string };

/** Decoded size of a base64 payload, without decoding it. */
function base64Bytes(data: string): number {
  const clean = data.replace(/[^A-Za-z0-9+/_-]/g, "");
  return Math.floor((clean.length * 3) / 4);
}

export function sentCardForSuccess(facts: SentCardFacts, sentCopyMissing: boolean): SentCard {
  const raw = (facts.text && facts.text.trim()) ? facts.text : facts.html ? htmlPreviewText(facts.html).replace(/\s+/g, " ").trim() : "";
  const text = raw.replace(/\r\n/g, "\n");
  return {
    outcome: "sent",
    from: facts.from,
    cc: [...(facts.cc ?? [])],
    bcc: [...(facts.bcc ?? [])],
    body_text: text.slice(0, SENT_CARD_BODY_MAX),
    truncated: text.length > SENT_CARD_BODY_MAX,
    attachments: (facts.attachments ?? []).map((a) => ({ filename: a.filename, size_bytes: base64Bytes(a.data) })),
    sent_copy: !sentCopyMissing,
  };
}

const NOT_SENT = "Not sent";

/**
 * The one sentence for a failed send, in the user's terms, or null when the
 * code is not one the card can word truthfully (the card then keeps its
 * generic line). Never names a plan limit: customer copy does not mention
 * action caps, so `usage_limit_reached` stays generic on purpose.
 *
 * `text` is the result's own text, read only to tell the two causes behind
 * `provider_not_sent` apart: a mail server's refusal before DATA
 * (index.ts#notSentResult) and a message that could not be built
 * (send-stages.ts#preTransmissionMessage).
 */
export function sentCardForError(code: string | null | undefined, text = ""): SentCard | null {
  const no = (detail: string): SentCard => ({ outcome: "not_sent", headline: NOT_SENT, detail });
  switch (code) {
    case "provider_not_sent":
      return no(
        text.startsWith("The mail server refused")
          ? "Your mail server turned it down before any of it went out. Trying again is safe."
          : "Nothing went out, so trying again is safe.",
      );
    case "provider_error":
      return {
        outcome: "unknown",
        headline: "May not have been sent",
        detail: "The mail server did not confirm it. Check your Sent folder before trying again, so it does not go out twice.",
      };
    case "auth_failed":
      return no("MCPEmails could not sign in to this inbox. Reconnect it in the dashboard, then try again.");
    case "message_not_found":
      return no("The original email could not be found. It may have been moved or deleted.");
    case "inbox_not_found":
    case "no_inbox_connected":
      return no("The inbox to send from is not connected.");
    case "inbox_ambiguous":
      return no("It was not clear which inbox to send from.");
    case "sender_identity_not_authorized":
    case "sender_identity_unsupported_provider":
    case "sender_identity_refused":
      return no("This inbox cannot send from the address that was asked for.");
    case "transport_not_configured":
      return no("This inbox has no outgoing mail server set up.");
    case "quota_exceeded":
      return no("Your mail provider's daily sending limit was reached.");
    case "chat_confirmation_required":
      return { outcome: "waiting", headline: "Not sent yet", detail: "It waits for your OK in this chat." };
    case "invalid_arguments":
      return no("The request was missing something or had a wrong value. The assistant can fix it and try again.");
    default:
      return null;
  }
}
