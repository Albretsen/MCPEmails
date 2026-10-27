// ---------------------------------------------------------------------------
// A pushed tool result that is NOT an envelope, read for what it can honestly
// say in one line.
//
// Since 2026-10-27 the server lists the card on `email_compose` and `schedule`
// (per-operation: email_send, email_reply, email_forward, schedule_create) for
// every key that can send, not only for keys whose inboxes hold sends for
// approval (mcp-server/index.ts#keyCanSendOutbound). The tool list is kept for
// the whole chat, so that is the only way approvals switched on mid-chat get
// the review card. The price is that the host now mounts this card under every
// ORDINARY send too, and those results are the plain published payload, not an
// envelope. This file is what makes that price small:
//
//   plainResultReceipt  a successful send / reply / forward / schedule becomes
//                       a client-authored `receipt` envelope: one line, "Sent
//                       to Dana +2" with the subject muted beside it, or
//                       "Scheduled for Oct 28, 2026, 9:00 AM".
//   plainResultNote     anything else the card cannot stand behind (an error,
//                       a refusal such as chat_confirmation_required, a cap
//                       paywall, a held send whose envelope could not be
//                       built) gets a short neutral line. Never a warning: the
//                       host's text result above carries the facts. A batch
//                       forward gets the generic "no preview" line.
//
// Read from the RESULT only, never from `tool-input`: the arguments are what
// the agent asked for, the result is what the server did (store.ts#toolInput).
// `structuredContent` only: every one of these results is built by the
// server's `jsonOk`, which always sets it. Every string goes through
// `neutralizeDeep` because reply and forward recipients' display names come
// from third-party headers.
//
// Kept deliberately small: the bundle sits at its 175 KB cap (codegen.mjs).
// ---------------------------------------------------------------------------

import type { ToolResultParams } from "./bridge";
import { SCHEMA_VERSION, type Envelope } from "./contract";
import { formatDateTime } from "./format";
import { neutralizeDeep } from "./sanitize";

type Plain = Record<string, any>;

const plain = (r: ToolResultParams | undefined): Plain | null =>
  r && !r.isError && r.structuredContent && typeof r.structuredContent === "object"
    ? r.structuredContent
    : null;

/** "Dana Reyes", "Dana Reyes +2", or "" when the result names nobody. */
function who(to: unknown): string {
  const names = (Array.isArray(to) ? to : [])
    .map((e) => String((typeof e === "string" ? e : e?.name || e?.email) ?? "").trim().slice(0, 60))
    .filter(Boolean);
  return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0] ?? "";
}

/**
 * A receipt envelope for a plain successful send or schedule, or null.
 *
 * Recognised by shape, not by tool name (a host may omit `toolInfo`):
 *   sent       `message_id` + `sent_at`, `status` "sent" or absent
 *              (send, reply, single forward, and a plain draft send)
 *   scheduled  `scheduled: true` + `send_at`
 * An `isError` result is never a receipt, whatever it carries.
 */
export function plainResultReceipt(result: ToolResultParams | undefined): Envelope | null {
  const p = plain(result);
  if (!p) return null;
  const to = who(p.to);
  const subject = typeof p.subject === "string" ? p.subject : "";
  let outcome: "sent" | "scheduled";
  let headline: string;
  let subline: string;
  if (p.scheduled === true && typeof p.send_at === "string") {
    outcome = "scheduled";
    headline = `Scheduled for ${formatDateTime(p.send_at)}`;
    subline = [to && `to ${to}`, subject].filter(Boolean).join(" · ");
  } else if (p.message_id && typeof p.sent_at === "string" && (p.status ?? "sent") === "sent") {
    outcome = "sent";
    headline = (p.forwarded_from ? "Forwarded" : "Sent") + (to && ` to ${to}`);
    subline = subject;
  } else {
    return null;
  }
  return neutralizeDeep({
    schema_version: SCHEMA_VERSION,
    card: "receipt",
    state: outcome,
    receipt: { outcome, headline, subline },
  });
}

/**
 * The words after "<Tool>: " for a non-envelope result the card cannot turn
 * into a receipt, or null for the generic "no preview for this result".
 *
 * Errors and refusals (scope, cap paywall, chat confirmation, a provider
 * failure) are deliberately not "nothing was sent": a send whose delivery is
 * unknown is an error too, and the host's text says which it is.
 */
export function plainResultNote(result: ToolResultParams | undefined): string | null {
  if (result?.isError) return "did not complete. The reply above says why.";
  return plain(result)?.status === "pending_approval"
    ? "waiting for approval. The reply above has the link."
    : null;
}
