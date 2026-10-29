// ---------------------------------------------------------------------------
// Inboxes that need reconnecting: say so before a model offers them.
//
// ── The bug (persona test in claude.ai, 2026-10-26) ─────────────────────────
// A draft tool called without inbox_id on a key with four inboxes answered
// "Multiple inboxes are accessible" with all four listed as equals. The user
// picked the Fastmail one, and the write failed: its app password had been
// refused by the mail server three weeks earlier. Nothing in the list said so,
// so the model presented a broken mailbox as a valid choice.
//
// ── What "needs reconnecting" means here ───────────────────────────────────
// Two signals, both already on the `inboxes` row:
//
//   1. `status = 'error'`. Gmail and Outlook set it when the refresh token is
//      revoked; the dashboard's "Check connection" sets it for a refused
//      password. No tool can use such a row (`resolveInbox` requires
//      'active'), so it used to be left out of every list, including
//      inbox_list, and a user could not learn from their assistant that it
//      needed reconnecting.
//   2. `status = 'active'` with the refused-login marker in `last_error`
//      (client-api/mail/health.ts). An IMAP server said NO to LOGIN. The row
//      stays 'active' on purpose: a refusal can be a transient lockout, and
//      'error' would take the mailbox away until a person reconnects. This
//      server now writes the same marker when a tool call ends `auth_failed`,
//      and clears it when a later call on that inbox succeeds, so the flag
//      tracks what actually happened rather than one stale check.
//
// ── What changes for the model ─────────────────────────────────────────────
//   * The "pick an inbox" error lists the usable inboxes as before, then the
//     ones that need reconnecting under a line that says not to offer them,
//     each with its reconnect link. Structured content carries them apart
//     (`inboxes` vs `needs_reconnect`), so the choosable set holds only
//     inboxes a write can actually use.
//   * inbox_list keeps reporting them, with `status`, `reconnect_url` and a
//     one-line `hint`, so the user can be told what to fix.
//   * Auto-resolution is unchanged: which inbox a call with no selector lands
//     on is still decided by the active rows alone.
//
// The marker format is client-api's, mirrored here rather than imported so
// this function does not bundle client-api code. inbox-health.test.ts holds
// the two copies together.
// ---------------------------------------------------------------------------

const MARKER_HEAD = "The mail server refused this mailbox's password. Reconnect this inbox to restore access.";
const MARKER_RE =
  /^The mail server refused this mailbox's password\. Reconnect this inbox to restore access\. \(Checked ([0-9T:.Z-]{20,30})\)$/;

/** PostgREST `like` pattern matching every marker and nothing else. Same as client-api's. */
export const LOGIN_REFUSED_LIKE = `${MARKER_HEAD} (Checked %)`;

/** `inboxes.last_error` for a login refused at `at` (ms). Same text client-api writes. */
export function loginRefusedMarker(at: number): string {
  return `${MARKER_HEAD} (Checked ${new Date(at).toISOString()})`;
}

/** When the marker in `lastError` was written (ms), or null when it is not a marker. */
export function loginRefusedAt(lastError: unknown): number | null {
  if (typeof lastError !== "string") return null;
  const match = MARKER_RE.exec(lastError);
  if (!match) return null;
  const at = Date.parse(match[1]);
  return Number.isFinite(at) ? at : null;
}

/** Gmail and Outlook move the row to 'error' themselves; the marker is for password mailboxes. */
export function isOAuthProvider(provider: string | null | undefined): boolean {
  return provider === "gmail" || provider === "outlook";
}

/**
 * The `status` an inbox_list entry, or a `needs_reconnect` entry, carries.
 *
 * "reconnect_required": reconnecting fixes it.
 * "unavailable": the row is in 'error' for a reason a reconnect does not fix
 * (an Outlook account with no mailbox). Still never offered as a choice.
 */
export type InboxHealthStatus = "reconnect_required" | "unavailable";

export interface InboxHealthRow {
  provider: string;
  status?: unknown;
  last_error?: unknown;
}

/**
 * Null when the inbox is usable as far as the row knows; otherwise why not.
 *
 * `noMailboxMessage` is outlook-graph.ts's OUTLOOK_NO_MAILBOX_MESSAGE, passed
 * in so this module stays free of the Graph client.
 */
export function inboxHealthStatus(row: InboxHealthRow, noMailboxMessage?: string): InboxHealthStatus | null {
  if (row.status === "error") {
    return noMailboxMessage !== undefined && row.last_error === noMailboxMessage ? "unavailable" : "reconnect_required";
  }
  if (row.status === "active" && loginRefusedAt(row.last_error) !== null) return "reconnect_required";
  return null;
}

/** One sentence for the model, on every inbox_list entry that needs reconnecting. */
export function inboxHealthHint(status: InboxHealthStatus, reconnectUrl: string): string {
  return status === "unavailable"
    ? "This inbox cannot be used: its account has no mailbox the server can reach. " +
      "Do not offer it as a choice. Tell the user this; reconnecting will not help."
    : "This inbox needs to be reconnected: its sign-in has expired, was revoked, or its " +
      "password was refused. Do not offer it as a choice for reading, drafting or sending. " +
      `Tell the user they can reconnect it here: ${reconnectUrl}`;
}

/** What the ambiguity error needs about each inbox. */
export interface ChoiceInbox {
  id: string;
  email_address: string;
  display_name?: string | null;
  provider: string;
  status?: unknown;
  last_error?: unknown;
}

export interface InboxChoice {
  text: string;
  structuredContent: Record<string, unknown>;
}

/**
 * The "Multiple inboxes are accessible" answer, with inboxes that need
 * reconnecting split out of the choosable set.
 *
 * `accessible` is every row the caller could have meant (active, and 'error'
 * rows too); the split is made here so the rule lives in one place.
 */
export function buildInboxChoice(
  accessible: readonly ChoiceInbox[],
  reconnectUrlFor: (provider: string, inboxId: string) => string,
  noMailboxMessage?: string,
): InboxChoice {
  const usable: Array<Record<string, unknown>> = [];
  const broken: Array<Record<string, unknown>> = [];
  for (const ib of accessible) {
    const base = {
      inbox_id: ib.id,
      email_address: ib.email_address,
      display_name: ib.display_name ?? null,
      provider: ib.provider,
    };
    const status = inboxHealthStatus(ib, noMailboxMessage);
    if (status === null) {
      usable.push(base);
    } else {
      broken.push({
        ...base,
        status,
        ...(status === "reconnect_required" ? { reconnect_url: reconnectUrlFor(ib.provider, ib.id) } : {}),
      });
    }
  }

  const usableLines = usable.map((ib) => `  • ${ib.email_address} — inbox_id: ${ib.inbox_id}`).join("\n");
  const brokenLines = broken.map((ib) =>
    ib.status === "unavailable"
      ? `  • ${ib.email_address} — cannot be used (the account has no mailbox)`
      : `  • ${ib.email_address} — needs reconnecting: ${ib.reconnect_url}`
  ).join("\n");

  let text: string;
  if (usable.length === 0) {
    text = "Multiple inboxes are connected, but none of them can be used right now. " +
      "Do not offer any of them as a choice. Tell the user which ones need reconnecting, " +
      "with the links below rendered so they can click them:\n" + brokenLines;
  } else {
    text = "Multiple inboxes are accessible, so inbox_id (or inbox) is required. " +
      "Retry this same tool with one of the inbox_id values below — you do " +
      "not need to call any other tool first:\n" + usableLines;
    if (broken.length > 0) {
      text += "\n\nThese inboxes need attention and will fail, so do not offer them as a choice. " +
        "If the user asks for one of them, give them its reconnect link instead:\n" + brokenLines;
    }
  }

  return {
    text,
    structuredContent: {
      inboxes: usable,
      ...(broken.length > 0 ? { needs_reconnect: broken } : {}),
    },
  };
}

/**
 * The "no usable inbox" answer when the only inboxes the key can reach are in
 * 'error'. Used instead of "No mailbox is connected", which is false for them
 * and sends the user to connect a mailbox they already have.
 */
export function allInboxesBrokenChoice(
  rows: readonly ChoiceInbox[],
  reconnectUrlFor: (provider: string, inboxId: string) => string,
  noMailboxMessage?: string,
): InboxChoice {
  const choice = buildInboxChoice(rows, reconnectUrlFor, noMailboxMessage);
  const broken = (choice.structuredContent.needs_reconnect ?? []) as Array<Record<string, unknown>>;
  const lines = broken.map((ib) =>
    ib.status === "unavailable"
      ? `  • ${ib.email_address} — cannot be used (the account has no mailbox)`
      : `  • ${ib.email_address} — needs reconnecting: ${ib.reconnect_url}`
  ).join("\n");
  return {
    text: "The mailbox connected to this account cannot be used right now, so nothing was done. " +
      "Tell the user and give them the link below, rendered so they can click it:\n" + lines,
    structuredContent: { inboxes: [], needs_reconnect: broken },
  };
}

/**
 * The bookkeeping write this server does after a tool call, given the inbox it
 * resolved. Pure so the decision is testable; the caller runs the query.
 *
 *   "mark":  the call ended `auth_failed` on a password mailbox. Write the
 *            marker so lists show it as needing reconnection (and client-api
 *            stops dialling it for its window).
 *   "clear": the call succeeded on an inbox whose row carried the marker.
 *   null:    nothing to do. Most calls end here without a query.
 */
export function inboxHealthWrite(input: {
  logStatus: string;
  logErrorCode: string | null;
  provider: string | null | undefined;
  rowHadMarker: boolean;
}): "mark" | "clear" | null {
  if (input.logErrorCode === "auth_failed") {
    return input.provider && !isOAuthProvider(input.provider) ? "mark" : null;
  }
  if (input.logStatus === "success" && input.rowHadMarker) return "clear";
  return null;
}
