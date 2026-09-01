/**
 * Classifies a thrown provider failure into a stable reason, and builds the
 * value-free payload that may be persisted to `activity_log.error_details`.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `error_details` was written for exactly one class of failure, JSON-RPC schema
 * validation, so every other error landed in the table as a bare `error_code`
 * string with nothing beside it. On 2026-09-01 `provider_error` was 538 rows
 * over 28 days: 20% of all errors, the second largest bucket, and completely
 * undiagnosable from the database. The only way to find out what those calls
 * actually were was to open the Supabase edge function console, and doing that
 * showed one opaque code standing in for at least four unrelated causes:
 *
 *   "UID SEARCH failed: Command Error. 11"        one OVH host (ex4.mail.ovh.net),
 *                                                 8 occurrences in an 8 minute burst
 *   "IMAP read timeout"                           7 in one day, IONOS and Yahoo
 *   "Mailbox not found: Junk" / ": Drafts"        a folder the mailbox has not got
 *   "UID SEARCH failed: [BADCHARSET] ..."         Yahoo refusing our SEARCH charset
 *
 * Two of those were also filed under the wrong code entirely. A read timeout is
 * a timeout, not a provider fault, and `folder_not_found` already existed in the
 * taxonomy for the third. Both are corrected at the call sites; the reason enum
 * below is what makes the remainder separable without another console dig.
 *
 * ── WHY A REASON ENUM AND NOT AN ERROR STRING ───────────────────────────────
 * `error_details` is persisted and read by operators, so it takes the same
 * contract validation-observability.ts states: no argument values, no error
 * messages, no recipient addresses, no search text, no message content. Raw
 * provider text breaks every clause of that at once. "Mailbox not found: Junk"
 * carries a user's folder name. An IMAP server may echo the failing command
 * line back, and that line contains the caller's search terms. The Yahoo
 * BADCHARSET response above carries a server session id.
 *
 * So the primary signal is this enum, which is ours and is finite. `signals` is
 * a strict ALLOW-LIST of protocol tokens rather than a redaction of the message
 * (see `providerErrorSignals`), because a redactor has to anticipate every
 * shape of content that might appear and an allow-list has to anticipate
 * nothing: a folder name, a search term, an address or a session id cannot
 * match it, whatever the server chose to say.
 *
 * The mail host is deliberately NOT carried either, even though it was the most
 * useful field in the console dig. A vanity host (mail.somecustomer.com)
 * identifies the customer, and `activity_log` already stores `inbox_id`, so an
 * operator who needs the host can join for it under the access controls that
 * table already has.
 *
 * ── WHY CLASSIFICATION IS BY `error.name` AND NOT `instanceof` ──────────────
 * Importing imap-client.ts and host-guard.ts here just to reach two constructors
 * would drag the whole IMAP client into every test that wants to assert a
 * classification. Both classes set `this.name` in their constructor, that name
 * is part of what they are, and matching on it keeps this module dependency
 * free and directly testable.
 */

/**
 * The stable reasons a provider call can fail for.
 *
 * These are persisted, so treat them like `activity_log.error_code`: add
 * freely, never rename, because a rename splits months of history across two
 * spellings of one condition.
 */
export type ProviderErrorReason =
  /** The provider did not answer inside our read budget. IONOS and Yahoo, daily. */
  | "read_timeout"
  /** The account is over its simultaneous-connection cap. Yahoo caps at 5. */
  | "connection_limit"
  /** The SSRF guard refused the mailbox's stored host. See host-guard.ts. */
  | "host_blocked"
  /** Credentials rejected. Permanent until the user reconnects the inbox. */
  | "auth_failed"
  /** The mailbox, label or folder named by the request is not there. */
  | "folder_missing"
  /** A create hit a folder that already exists. A normal outcome, not a fault. */
  | "folder_exists"
  /** The server will not search in the character set we asked for (Yahoo). */
  | "search_charset_unsupported"
  /** SEARCH itself was refused. The OVH "Command Error. 11" burst lands here. */
  | "search_rejected"
  /** Some other IMAP command came back NO or BAD. */
  | "command_rejected"
  /** Connection refused, reset, TLS or DNS. Nothing reached the mail server. */
  | "network_failed"
  /** A Gmail or Graph HTTP call returned 4xx/5xx we do not recognise further. */
  | "http_error"
  /** Genuinely unclassified. Kept explicit so it can be counted and mined. */
  | "unknown";

/**
 * Which narrowing a call site is allowed.
 *
 * ── READ THIS BEFORE CHANGING A CALL SITE FROM "ledger" TO "read" ───────────
 * `logErrorCode === "provider_error"` is load-bearing in the outbound
 * idempotency ledger. `completeOutboundIdempotency` and
 * `completeApprovedOutboundIdempotency` in index.ts both map `provider_error`
 * and `-32603` to ledger status "unknown" and EVERYTHING ELSE to "failed".
 * "unknown" is what lets a later retry with the same idempotency key replay;
 * "failed" is not. So narrowing the code on a path that reaches that ledger
 * would silently change retry semantics, and the two ways that goes wrong are
 * a message stranded with no way to send it and a message sent twice.
 *
 * Every operation in `IDEMPOTENT_OUTBOUND_OPERATIONS` and
 * `IDEMPOTENT_MUTATION_OPERATIONS` is therefore "ledger", which is wider than
 * "the send paths": email_move, email_copy, email_delete, email_flag,
 * email_archive and their batch and search_and_* forms all accept an
 * idempotency_key and all settle through that same mapping. Those sites get the
 * richer `error_details` and keep the exact `error_code` they log today.
 *
 * "read" is for paths that can never reach the ledger: search, list, read,
 * attachment, original, extract, folder create/rename/delete, contact search,
 * draft list. If you cannot prove a handler is one of those, it is "ledger".
 */
export type ProviderErrorBoundary = "read" | "ledger";

/**
 * The narrower `activity_log.error_code` a read-shaped path may log instead of
 * `provider_error`, per reason.
 *
 * Every value here is a code that ALREADY exists in the taxonomy, except
 * `connection_limit`, which is new because "the account is over its connection
 * cap" is a distinct and actionable bucket that no existing code named.
 *
 * `read_timeout` maps onto the existing `search_timeout` rather than earning a
 * new `provider_timeout`: that is already this taxonomy's name for "the
 * provider did not answer inside our budget", and minting a second name for one
 * condition would split the history of it. `tool_name` sits in the same row, so
 * a `search_timeout` on `email_read` is not ambiguous about what timed out.
 */
const READ_PATH_ERROR_CODES: Partial<Record<ProviderErrorReason, string>> = {
  read_timeout: "search_timeout",
  folder_missing: "folder_not_found",
  folder_exists: "folder_already_exists",
  auth_failed: "auth_failed",
  host_blocked: "mail_host_blocked",
  connection_limit: "connection_limit",
};

/**
 * The `activity_log.error_code` to log for a classified provider failure.
 *
 * On a "ledger" boundary this returns `fallback` unchanged, always, whatever
 * the reason turned out to be. That is the whole safety property: the ledger
 * sites get detail without their code moving under them.
 */
export function providerErrorLogCode(
  reason: ProviderErrorReason,
  boundary: ProviderErrorBoundary,
  fallback = "provider_error",
): string {
  if (boundary === "ledger") return fallback;
  return READ_PATH_ERROR_CODES[reason] ?? fallback;
}

/** The message text to classify, whatever the caller happened to throw. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error ?? "");
}

/** The constructor name, when the thrown value is an Error that set one. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

/**
 * Reduce a thrown provider error to one stable reason.
 *
 * Order matters and is not alphabetical. The typed classes come first because
 * they are certain; after that the most specific text patterns run before the
 * general ones, so "UID SEARCH failed: [BADCHARSET] ..." is a charset refusal
 * rather than a generic rejected search, and "UID COPY failed: [NONEXISTENT]
 * Mailbox does not exist" is a missing folder rather than a generic rejected
 * command.
 */
export function classifyProviderError(error: unknown): ProviderErrorReason {
  const name = errorName(error);
  // Set by host-guard.ts. The mailbox's stored host resolves somewhere the SSRF
  // guard will not connect to, which is a settings problem, not a flaky server.
  if (name === "MailHostBlockedError") return "host_blocked";
  // Set by imap-client.ts. Transient and worth retrying, unlike ImapAuthError.
  if (name === "ImapConnectionLimitError") return "connection_limit";
  if (name === "ImapAuthError") return "auth_failed";

  const message = errorMessage(error);

  if (
    /_auth_failed\b/i.test(message) ||
    /\[AUTHENTICATIONFAILED\]/i.test(message) ||
    /authentication failed|invalid credentials|login failed/i.test(message)
  ) {
    return "auth_failed";
  }

  // Covers both our own `search_timeout` race sentinel and the "IMAP read
  // timeout" that imap-client.ts's per-command `withTimeout` throws at 15s.
  // Until 2026-09-01 the second one reached the generic provider branch and was
  // logged as `provider_error`, which is how 7 timeouts in one day disappeared
  // into a bucket nobody could read.
  if (/timed ?out|timeout/i.test(message)) return "read_timeout";

  if (/\[BADCHARSET\]|unsupported (?:text )?(?:encoding|charset)/i.test(message)) {
    return "search_charset_unsupported";
  }

  // Every provider's way of saying "that folder is not there". Mirrors
  // FOLDER_MISSING_RE in index.ts, plus IMAP's SELECT failure text, which is
  // what "Mailbox not found: Junk" is.
  if (
    /\[NONEXISTENT\]|\[TRYCREATE\]|invalid label|no such mailbox/i.test(message) ||
    /mailbox not found/i.test(message) ||
    /does ?n[o']?t exist/i.test(message)
  ) {
    return "folder_missing";
  }

  if (/\[ALREADYEXISTS\]|already exists/i.test(message)) return "folder_exists";

  // "UID SEARCH failed: Command Error. 11" from OVH lands here: a SEARCH the
  // server refused for a reason it did not express in any code we can read.
  if (/\bSEARCH failed\b|\bSEARCH:/i.test(message)) return "search_rejected";

  if (
    /connection (?:refused|reset|closed|aborted)|econnrefused|econnreset|broken pipe/i
      .test(message) ||
    /\bdns\b|getaddrinfo|name not resolved|host not found/i.test(message) ||
    /\btls\b|certificate|handshake/i.test(message)
  ) {
    return "network_failed";
  }

  if (/\b(?:failed|error)\b\W{0,3}[45]\d\d\b/i.test(message)) return "http_error";

  // A tagged NO or BAD on some command other than SEARCH, e.g.
  // "UID COPY failed: ...", "IMAP server refused STARTTLS".
  if (/\b[A-Z]{3,} failed\b/.test(message) || /\brefused\b/i.test(message)) {
    return "command_rejected";
  }

  return "unknown";
}

/**
 * IMAP response codes (RFC 3501 §7.1, RFC 5530) that may be carried verbatim.
 *
 * Every entry is a protocol constant. None of them can hold user content, which
 * is the only reason any of them is allowed through.
 */
const ALLOWED_RESPONSE_CODES = new Set([
  "ALERT",
  "ALREADYEXISTS",
  "AUTHENTICATIONFAILED",
  "AUTHORIZATIONFAILED",
  "BADCHARSET",
  "CANNOT",
  "CLIENTBUG",
  "CONTACTADMIN",
  "EXPIRED",
  "INUSE",
  "LIMIT",
  "NONEXISTENT",
  "NOPERM",
  "OVERQUOTA",
  "PARSE",
  "PRIVACYREQUIRED",
  "SERVERBUG",
  "TRYCREATE",
  "UNAVAILABLE",
]);

/**
 * IMAP commands whose NAME may be carried verbatim. The command's ARGUMENTS
 * never are, and that is the distinction the whole allow-list turns on: "UID
 * SEARCH" is a protocol verb, everything the caller typed after it is content.
 */
const ALLOWED_COMMANDS = new Set([
  "UID SEARCH",
  "UID COPY",
  "UID MOVE",
  "UID STORE",
  "UID FETCH",
  "UID EXPUNGE",
  "AUTHENTICATE",
  "STARTTLS",
  "SELECT",
  "EXAMINE",
  "CREATE",
  "RENAME",
  "DELETE",
  "APPEND",
  "STATUS",
  "SEARCH",
  "FETCH",
  "STORE",
  "LIST",
]);

/** No payload carries more than this many signals, whatever the server said. */
const MAX_SIGNALS = 4;

/**
 * The protocol tokens in a provider message that are safe to persist.
 *
 * This is an ALLOW-LIST, not a redaction, and the difference is the point. A
 * redactor (`redactErrorDetail` in triage-engine.ts is one: it neutralises
 * control characters and truncates at 1000 chars) leaves whatever content it
 * did not think to strip, and 1000 characters of an IMAP error is easily a
 * whole echoed SEARCH command with the caller's terms in it. Here nothing
 * survives unless it is a protocol constant this file names, so a folder name,
 * a search term, an address or a session id cannot come through no matter how
 * the server phrased itself.
 *
 * The one numeric exception is an HTTP status off a Gmail or Graph failure,
 * which is matched only in the "failed: 404" shape and only in the 4xx/5xx
 * range, so a bare number appearing anywhere else in a message is not picked up.
 */
export function providerErrorSignals(error: unknown): string[] {
  const message = errorMessage(error);
  const signals: string[] = [];

  for (const match of message.matchAll(/\[([A-Z][A-Z0-9-]{1,24})\]/g)) {
    const code = match[1];
    if (ALLOWED_RESPONSE_CODES.has(code) && !signals.includes(`[${code}]`)) {
      signals.push(`[${code}]`);
    }
  }

  // Anchored at the start, and only in the "<COMMAND> failed" shape the IMAP
  // client actually throws. A free scan of the whole message would have been a
  // hole rather than a shortcut: a mailbox named "Delete" turns "Mailbox not
  // found: Delete" into the signal DELETE, which is the folder name this module
  // exists to keep out. Nothing a user can name reaches position 0 of these
  // messages, so the anchor is what makes the allow-list a real boundary.
  const command = message.match(/^([A-Z]+(?: [A-Z]+)?) failed\b/);
  if (command && ALLOWED_COMMANDS.has(command[1])) signals.push(command[1]);

  const status = message.match(/\b(?:failed|error)\b\W{0,3}([45]\d\d)\b/i);
  if (status) signals.push(`http_${status[1]}`);

  return signals.slice(0, MAX_SIGNALS);
}

/** The providers this server has. Anything else is reported as "other". */
const KNOWN_PROVIDERS = new Set(["gmail", "outlook", "imap", "fastmail"]);

/**
 * Privacy-safe metadata for a failed provider call.
 *
 * Same contract as `InvalidArgumentAuditDetails`: do not add error messages,
 * folder names, addresses, search text, hostnames or any other request or
 * mailbox content here. Everything in this shape is either an enum this file
 * owns or a protocol constant it allow-lists.
 */
export interface ProviderErrorAuditDetails {
  phase: "provider_call";
  /** The dispatched tool name, e.g. "email_search". Ours, not the caller's. */
  tool: string;
  /** gmail | outlook | imap | fastmail | other. */
  provider: string;
  reason: ProviderErrorReason;
  /** Allow-listed protocol tokens. Often empty, and that is fine. */
  signals: string[];
}

/**
 * Convert a caught provider error into the deliberately value-free shape that
 * may be persisted to `activity_log.error_details`.
 *
 * `provider` is collapsed to a known member or "other" rather than passed
 * through, because it arrives from a database column and this payload is the
 * one place where "it is probably always one of four strings" is not good
 * enough.
 */
export function providerErrorAuditDetails(
  tool: string,
  provider: string,
  error: unknown,
): ProviderErrorAuditDetails {
  return {
    phase: "provider_call",
    tool,
    provider: KNOWN_PROVIDERS.has(provider) ? provider : "other",
    reason: classifyProviderError(error),
    signals: providerErrorSignals(error),
  };
}
