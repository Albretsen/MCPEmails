// ---------------------------------------------------------------------------
// folder-errors.ts - turning a provider's refusal into something an agent can act on.
//
// `folder action: create` used to hand back the raw HTTP status line:
//
//   Failed to folder_create for gmail inbox: Gmail labels.create failed: Conflict
//   Failed to folder_create for gmail inbox: Gmail labels.create failed: Bad Request
//
// "Conflict" and "Bad Request" are not answers. An agent cannot tell a name
// collision from a transient fault, so it invents a variant name ("Receipts_2")
// or retries forever. Both of those outcomes leave the mailbox worse than the
// truthful answer would have: the label ALREADY EXISTS, here is its id, use it.
//
// The standard this module aims at is the connector's best existing error, the
// permanent-delete refusal: it names the provider, the constraint, and the
// remedy. Everything here is PURE - status codes and strings in, a structured
// payload out - so the mapping is testable without a mailbox, and so the three
// operations (create / rename / delete) cannot drift apart.
// ---------------------------------------------------------------------------

/** Machine-readable `error` codes this module emits. */
export type FolderErrorCode =
  | "folder_name_taken"
  | "folder_name_reserved"
  | "folder_not_found"
  | "folder_provider_error";

export type FolderOperation = "create" | "rename" | "delete";

/** The JSON body returned to the caller. Extra keys are per-code payload. */
export interface ConnectorFolderError {
  error: FolderErrorCode;
  provider: string;
  operation: FolderOperation;
  message: string;
  [key: string]: unknown;
}

export interface MappedFolderFailure {
  payload: ConnectorFolderError;
  /** activity_log error_code. Mirrors `payload.error`. */
  logErrorCode: FolderErrorCode;
}

/**
 * Names the provider owns and will not let a user take.
 *
 * Gmail's system labels are ids AND names (labels.list returns
 * {id:"INBOX", name:"INBOX"}), which is why a create named "INBOX" comes back
 * 400 rather than 409: the label is not a duplicate of a user label, it is a
 * name out of the reserved namespace. Outlook's well-known folders behave the
 * same way; IMAP reserves exactly one name, "INBOX" (RFC 3501 5.1).
 */
export const RESERVED_FOLDER_NAMES: Record<string, readonly string[]> = {
  gmail: [
    "INBOX",
    "SENT",
    "DRAFT",
    "DRAFTS",
    "TRASH",
    "SPAM",
    "STARRED",
    "IMPORTANT",
    "UNREAD",
    "CHAT",
    "CATEGORY_PERSONAL",
    "CATEGORY_SOCIAL",
    "CATEGORY_PROMOTIONS",
    "CATEGORY_UPDATES",
    "CATEGORY_FORUMS",
  ],
  outlook: [
    "Inbox",
    "Drafts",
    "Sent Items",
    "Deleted Items",
    "Junk Email",
    "Outbox",
    "Archive",
    "Conversation History",
  ],
  imap: ["INBOX"],
};

/** Reserved names for a provider slug, defaulting to the IMAP set. */
export function reservedFolderNames(provider: string): readonly string[] {
  return RESERVED_FOLDER_NAMES[provider] ?? RESERVED_FOLDER_NAMES["imap"];
}

/** Whether `name` is one the provider reserves (case-insensitive). */
export function isReservedFolderName(provider: string, name: string | null | undefined): boolean {
  if (!name) return false;
  const lower = name.trim().toLowerCase();
  return reservedFolderNames(provider).some((n) => n.toLowerCase() === lower);
}

export interface ProviderFolderFailure {
  provider: string;
  operation: FolderOperation;
  /** The name that was requested (create) / the new name (rename) / the id (delete). */
  name?: string | null;
  /** HTTP status, when the provider speaks HTTP. Null for IMAP. */
  status?: number | null;
  /** HTTP status text or the raw IMAP response line. */
  statusText?: string | null;
  /** Provider-supplied human detail, already extracted from the error body. */
  detail?: string | null;
  /** The colliding folder, when the caller was able to look it up. */
  existing?: { id: string; name: string } | null;
  /** What the provider calls the thing; defaults to the Gmail/other split. */
  itemNoun?: "folder" | "label";
}

/** Anything a provider says when a name is already in use. */
const ALREADY_EXISTS_RE = /already\s*exists|\[ALREADYEXISTS\]|duplicate|conflict/i;

/** Statuses that mean "the provider had a bad minute", not "your input is wrong". */
function isTransientStatus(status: number | null | undefined): boolean {
  if (typeof status !== "number") return false;
  return status === 408 || status === 429 || status >= 500;
}

function nounFor(input: ProviderFolderFailure): "folder" | "label" {
  return input.itemNoun ?? (input.provider === "gmail" ? "label" : "folder");
}

/** "create" -> "created", for a sentence that reads like English. */
const OPERATION_VERB: Record<FolderOperation, string> = {
  create: "create",
  rename: "rename",
  delete: "delete",
};

/**
 * Maps a provider refusal onto a structured, actionable connector error.
 *
 * The one rule worth stating: a cause is only ever claimed when the provider
 * actually said it. An unrecognised status becomes `folder_provider_error`
 * carrying whatever detail the provider gave and NOTHING invented on top - and
 * it only suggests waiting when the status is genuinely transient, because a
 * retry hint on a permanent failure is the bug this module was written to fix.
 */
export function mapFolderProviderFailure(
  input: ProviderFolderFailure,
): MappedFolderFailure {
  const noun = nounFor(input);
  const provider = input.provider;
  const operation = input.operation;
  const name = (input.name ?? "").trim();
  const detail = (input.detail ?? "").trim() || null;
  const statusText = (input.statusText ?? "").trim() || null;
  const said = detail ?? statusText;

  // ── Name already taken ───────────────────────────────────────────────────
  // A 409, an explicit "already exists", or a lookup that FOUND the colliding
  // folder. The last one is the useful case: the error carries the id, so the
  // caller's next move is a plain "use it" rather than another round-trip.
  const collided = input.existing ?? null;
  if (collided || input.status === 409 || (said !== null && ALREADY_EXISTS_RE.test(said))) {
    const where = collided
      ? `Use ${noun} id "${collided.id}" - it is that same ${noun}, so there is nothing left to ${OPERATION_VERB[operation]}.`
      : `Call folder action: list on this inbox to get its id and use that.`;
    return {
      logErrorCode: "folder_name_taken",
      payload: {
        error: "folder_name_taken",
        provider,
        operation,
        requested_name: name || null,
        existing_folder_id: collided?.id ?? null,
        existing_folder_name: collided?.name ?? null,
        message: `A ${noun} named "${name}" already exists in this ${provider} inbox, and ` +
          `${provider} does not allow two with the same name. ${where} ` +
          `Repeating this call will fail the same way.`,
      },
    };
  }

  // ── Reserved / system name ───────────────────────────────────────────────
  if (isReservedFolderName(provider, name)) {
    const reserved = reservedFolderNames(provider);
    const remedy = operation === "delete"
      ? `System ${noun}s cannot be deleted. Delete only ${noun}s you created (folder action: list shows which exist).`
      : `Pick a name outside that set - e.g. "${name}_2026" or "My ${name}" - and reissue the call.`;
    return {
      logErrorCode: "folder_name_reserved",
      payload: {
        error: "folder_name_reserved",
        provider,
        operation,
        requested_name: name,
        reserved_names: [...reserved],
        message: `"${name}" is a reserved ${provider} ${noun} name: ${provider} owns it and ` +
          `refuses to ${OPERATION_VERB[operation]} a ${noun} under it. Reserved on ${provider}: ` +
          `${reserved.join(", ")}. ${remedy} Repeating this call will fail the same way.`,
      },
    };
  }

  // ── Gone ─────────────────────────────────────────────────────────────────
  if (input.status === 404) {
    return {
      logErrorCode: "folder_not_found",
      payload: {
        error: "folder_not_found",
        provider,
        operation,
        message: `That ${noun} does not exist in this ${provider} inbox, so it cannot be ` +
          `${operation === "delete" ? "deleted" : "renamed"}. Call folder action: list to ` +
          `see the current ids. Repeating this call will fail the same way.`,
      },
    };
  }

  // ── Anything else: report, never diagnose ────────────────────────────────
  const transient = isTransientStatus(input.status);
  const saidPart = said ? ` The provider said: "${said}".` : " The provider gave no reason.";
  return {
    logErrorCode: "folder_provider_error",
    payload: {
      error: "folder_provider_error",
      provider,
      operation,
      requested_name: name || null,
      provider_status: input.status ?? null,
      retryable: transient,
      message: `The ${provider} inbox refused this ${noun} ${OPERATION_VERB[operation]}.` +
        saidPart +
        (transient
          ? " That status is a temporary provider fault, so the same call may succeed shortly."
          : " No specific cause was reported, so do not assume one: call folder action: list " +
            "to see the inbox's actual state before trying a different value."),
    },
  };
}

/**
 * A provider failure already mapped to its connector error, thrown so the
 * provider helpers can keep their `throw`-shaped control flow while the
 * handlers render one structured result.
 */
export class FolderOperationError extends Error {
  readonly payload: ConnectorFolderError;
  readonly logErrorCode: string;

  constructor(mapped: MappedFolderFailure) {
    super(mapped.payload.message);
    this.name = "FolderOperationError";
    this.payload = mapped.payload;
    this.logErrorCode = mapped.logErrorCode;
  }
}

/**
 * A folder ARGUMENT that matched nothing - the read-side twin of the above.
 *
 * Thrown by the resolution seam so a `folder:` / `include_folders:` value that
 * cannot be resolved fails before the provider is called, with the message from
 * `folderNotFoundMessage` rather than a provider's "Invalid label" wrapped in a
 * retry hint.
 */
export class FolderTargetError extends Error {
  readonly payload: Record<string, unknown>;
  readonly logErrorCode: string;

  constructor(
    payload: { error: string; provider: string; folder: string; message: string },
  ) {
    super(payload.message);
    this.name = "FolderTargetError";
    this.payload = payload;
    this.logErrorCode = payload.error;
  }
}
