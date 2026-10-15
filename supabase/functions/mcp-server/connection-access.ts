// ---------------------------------------------------------------------------
// Receive-only and send-only IMAP/SMTP inboxes.
//
// The generic IMAP/SMTP connector can store just one half of a mailbox: a
// receive-only inbox has no SMTP server (an archive, a shared support box read
// by an agent) and a send-only inbox has no IMAP server (a transactional
// sender, a relay account). The missing half is stored as a NULL host.
//
// Before this module, every IMAP and SMTP path in the server treated a NULL
// host the same way it treated a missing password: it threw the
// `imap_auth_failed` sentinel, and the agent was told the inbox's credentials
// had been revoked and to send the user off to reconnect. For a send-only inbox
// asked to read mail that is false, and reconnecting changes nothing. This
// module names the real situation so the dispatcher can say it instead.
// ---------------------------------------------------------------------------

/** Which halves of a mailbox a connection carries. */
export type InboxAccess = "send_and_receive" | "receive_only" | "send_only";

/** The half a tool needed and the inbox does not have. */
export type MissingTransport = "imap" | "smtp";

interface AccessRow {
  provider: string;
  imap_host?: string | null;
  smtp_host?: string | null;
}

/**
 * What an inbox can do, read off which hosts it carries.
 *
 * Gmail and Outlook speak their own APIs and always do both. An IMAP-family row
 * with neither host is not a partial connection, it is a broken one, and is
 * reported as `send_and_receive` so the existing credential errors still apply
 * to it unchanged.
 */
export function inboxAccess(row: AccessRow): InboxAccess {
  if (row.provider === "gmail" || row.provider === "outlook") return "send_and_receive";
  const imap = Boolean(row.imap_host);
  const smtp = Boolean(row.smtp_host);
  if (imap && !smtp) return "receive_only";
  if (smtp && !imap) return "send_only";
  return "send_and_receive";
}

/** The half this inbox deliberately does not have, or null. */
export function missingTransportOf(row: AccessRow): MissingTransport | null {
  const access = inboxAccess(row);
  if (access === "send_only") return "imap";
  if (access === "receive_only") return "smtp";
  return null;
}

/**
 * Capability flags a partial connection cannot honour, by missing half.
 *
 * Everything that reads, lists, files or changes stored mail needs IMAP; a
 * draft is an IMAP APPEND; contact search is a header scan of stored mail.
 * Sending, forwarding and scheduling need SMTP.
 */
const NEEDS_IMAP = [
  "flags",
  "folders",
  "move",
  "copy",
  "delete",
  "drafts",
  "contacts_db",
  "original_message",
] as const;
const NEEDS_SMTP = ["forward", "scheduling"] as const;

/**
 * The capability set for this inbox: the provider's, with every flag the
 * missing half would have carried turned off. A full connection is returned
 * unchanged (the same object), so nothing about an ordinary inbox moves.
 */
export function capabilitiesForAccess<T extends object>(
  caps: T,
  access: InboxAccess,
): T {
  if (access === "send_and_receive") return caps;
  const off = access === "send_only" ? NEEDS_IMAP : NEEDS_SMTP;
  const out: Record<string, unknown> = { ...(caps as Record<string, unknown>) };
  for (const key of off) {
    if (key in out) out[key] = false;
  }
  return out as T;
}

/**
 * The agent-facing refusal for a tool that needs the half this inbox lacks.
 *
 * Deliberately the opposite of the auth-failure text in two ways: it does not
 * say anything was revoked, and it does not tell the agent to retry, because
 * neither is true. It does say what still works, so the agent can carry on with
 * the part of the task this inbox can do.
 */
export function missingTransportMessage(
  missing: MissingTransport,
  emailAddress: string,
  dashboardUrl: string,
): string {
  if (missing === "imap") {
    return `The inbox ${emailAddress} is connected for sending only: it has no IMAP ` +
      "server, so it cannot read, list, search, organize, flag, delete or draft mail, " +
      "and there are no stored messages to look up. Sending new mail from it works. " +
      "Nothing is wrong with its credentials; do not retry and do not ask the user to " +
      "reconnect it for this. If the user wants to read this mailbox too, they can " +
      `reconnect it with IMAP settings in the MCP Emails dashboard: ${dashboardUrl}`;
  }
  return `The inbox ${emailAddress} is connected for receiving only: it has no SMTP ` +
    "server, so it cannot send, reply, forward or schedule mail. Reading, searching " +
    "and organizing its mail works. Nothing is wrong with its credentials; do not " +
    "retry and do not ask the user to reconnect it for this. If the user wants to " +
    "send from this address too, they can reconnect it with SMTP settings in the " +
    `MCP Emails dashboard: ${dashboardUrl}`;
}

/** The structured tool-result body for {@link missingTransportMessage}. */
export function missingTransportPayload(
  missing: MissingTransport,
  inbox: { id: string; email_address: string },
  dashboardUrl: string,
): Record<string, unknown> {
  return {
    error: "transport_not_configured",
    missing,
    access: missing === "imap" ? "send_only" : "receive_only",
    inbox_id: inbox.id,
    email_address: inbox.email_address,
    message: missingTransportMessage(missing, inbox.email_address, dashboardUrl),
  };
}

/**
 * The halves of a mailbox each inbox-bound tool needs, by dispatch name.
 *
 * Checked when the tool resolves its inbox (see resolveInboxArg), which is
 * before any side effect: a held send is never queued for approval, and a
 * scheduled send is never stored, for an inbox that has no way to deliver it.
 * A tool not listed here is not gated (inbox_list, signatures, schedule_list
 * and schedule_cancel, automations, the approval tools), and any IMAP or SMTP
 * call it does make is still caught where the connection is opened.
 */
const TRANSPORTS_BY_TOOL: Record<string, readonly MissingTransport[]> = {
  email_list: ["imap"],
  email_read: ["imap"],
  email_read_batch: ["imap"],
  email_attachment: ["imap"],
  email_original: ["imap"],
  email_extract: ["imap"],
  email_search: ["imap"],
  email_archive: ["imap"],
  email_move: ["imap"],
  email_copy: ["imap"],
  email_delete: ["imap"],
  email_move_batch: ["imap"],
  email_copy_batch: ["imap"],
  email_delete_batch: ["imap"],
  email_flag: ["imap"],
  email_search_and_move: ["imap"],
  email_search_and_delete: ["imap"],
  folder_list: ["imap"],
  folder_create: ["imap"],
  folder_rename: ["imap"],
  folder_delete: ["imap"],
  draft_list: ["imap"],
  draft_create: ["imap"],
  draft_reply: ["imap"],
  draft_update: ["imap"],
  draft_delete: ["imap"],
  contact_search: ["imap"],
  email_send: ["smtp"],
  schedule_create: ["smtp"],
  // A reply or forward reads the original first; a draft is sent from the
  // Drafts folder it is stored in.
  email_reply: ["imap", "smtp"],
  email_forward: ["imap", "smtp"],
  draft_send: ["imap", "smtp"],
};

/**
 * The half `tool` needs that this inbox deliberately lacks, or null when the
 * tool can run (or is not gated at all).
 */
export function transportBlockingTool(tool: string, row: AccessRow): MissingTransport | null {
  const missing = missingTransportOf(row);
  if (!missing) return null;
  return TRANSPORTS_BY_TOOL[tool]?.includes(missing) ? missing : null;
}
