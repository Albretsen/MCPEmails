/**
 * Value-free diagnostics for a folder ARGUMENT that could not be resolved.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `folder_not_found` raised by the resolver (as opposed to by a provider) was
 * logged with no `error_details` at all. On 2026-10-02 that bucket turned out
 * to hold several unrelated habits of the calling model: a role alias the
 * mailbox has no folder for, the last segment of a nested folder's path, a path
 * typed with the wrong hierarchy delimiter, a Gmail system token sent to a
 * mailbox that is not Gmail. Telling them apart took a manual sample of rows
 * joined against live folder listings, because the row itself said only that
 * something was not found.
 *
 * ── THE CONTRACT ────────────────────────────────────────────────────────────
 * Same one provider-error.ts and validation-observability.ts state: nothing
 * the caller typed and nothing the mailbox contains may be persisted. A folder
 * name is the user's own filing system ("Legal/Settlement") and never appears
 * here, in whole or in part. Every field below is an enum this file owns, a
 * count, a position, or a boolean.
 *
 * The one string that originates outside this file is `alias`, and it is safe
 * for a structural reason rather than a careful one: it is read out of
 * CANONICAL_FOLDER_ALIASES after the lookup succeeded, so it can only ever be
 * one of the six canonical tokens, whatever the caller typed.
 *
 * Pure: listing in, payload out. No I/O, so the classification is testable
 * against layout fixtures and cannot drift from what index.ts persists.
 */

import { decodeModifiedUtf7 } from "./utf7.ts";
import { lookupCanonicalAlias, type MailboxListEntry, resolveImapAlias } from "./imap-folder-target.ts";

/**
 * What kind of value failed to resolve.
 *
 * Persisted, so treat these like `activity_log.error_code`: add freely, never
 * rename.
 */
export type FolderInputClass =
  /** A canonical alias (sent, trash, ...) and the mailbox has no folder in that role. */
  | "alias_no_role"
  /** A synonym of one (junk, deleted, draft), likewise unmatched. */
  | "alias_synonym"
  /** The LAST segment of a folder that exists under a parent ("Receipts" for "Work/Receipts"). */
  | "leaf_of_existing_path"
  /** A folder that exists, typed with a different hierarchy delimiter ("A/B" for "A.B"). */
  | "delimiter_mismatch"
  /** A Gmail system label id or "[Gmail]/..." path, on a mailbox with no such folder. */
  | "gmail_system_token"
  /** A modified-UTF-7 wire name ("Entw&APw-rfe") instead of the decoded name. */
  | "wire_utf7"
  /** Contains characters outside ASCII and matched nothing. */
  | "non_ascii"
  /** An alias whose only candidate is a \\Noselect or \\NonExistent name. */
  | "matches_noselect"
  | "other";

/** Which argument carried the value. */
export type FolderArgumentName = "folder" | "include_folders";

/**
 * Privacy-safe metadata for a folder value the resolver refused.
 *
 * Do not add the value, a folder name, a path segment, a delimiter taken from
 * a name, or the provider's host here. See the contract at the top of the file.
 */
export interface FolderResolveAuditDetails {
  phase: "resolve_folder";
  arg: FolderArgumentName;
  input_class: FolderInputClass;
  /** How many entries the argument held. 1 for a scalar `folder`. */
  entries: number;
  /** Zero-based position of the entry that failed. */
  failed_index: number;
  /** How many folders the mailbox listing held when the value was matched. */
  listing_size: number;
  /**
   * Whether ANY mailbox in the listing carries a SPECIAL-USE role flag. Null on
   * providers that have no such thing (Gmail and Outlook over their own APIs).
   */
  has_special_use: boolean | null;
  /** The canonical alias the value stood for. Only on the alias classes. */
  alias?: string;
}

/** A listing entry, as far as classification cares. IMAP supplies all three. */
export interface DiagnosticFolder {
  name: string;
  flags?: string[];
  delimiter?: string;
}

/** The RFC 6154 role flags, plus \\All. Lower-cased for comparison. */
const SPECIAL_USE_FLAGS = new Set([
  "\\all",
  "\\archive",
  "\\drafts",
  "\\junk",
  "\\sent",
  "\\trash",
]);

const UNSELECTABLE_FLAGS = new Set(["\\noselect", "\\nonexistent"]);

/**
 * Gmail's own vocabulary: the system label ids that are not also alias words
 * (those are classified as aliases first), and the "[Gmail]/..." paths its
 * IMAP server uses. A model that learned folder names from Gmail sends these
 * to every mailbox.
 */
const GMAIL_SYSTEM_TOKEN_RE =
  /^(?:starred|important|unread|chat|all[ _]?mail|category_[a-z]+)$|^\[(?:gmail|google mail)\]/i;

/** Something that can only be modified UTF-7: "&" then base64 then "-". */
const WIRE_UTF7_RE = /&[A-Za-z0-9+,]+-/;

/** Both delimiters folded to one, so "A/B" and "A.B" compare equal. */
function foldDelimiters(name: string): string {
  return name.toLowerCase().replace(/[./]/g, "/");
}

/** The last path segment of a listed folder, by its own delimiter when known. */
function leafOf(folder: DiagnosticFolder): string | null {
  const delimiters = folder.delimiter ? [folder.delimiter] : ["/", "."];
  let cut = -1;
  for (const d of delimiters) cut = Math.max(cut, folder.name.lastIndexOf(d));
  if (cut === -1 || cut === folder.name.length - 1) return null;
  return folder.name.slice(cut + 1).toLowerCase();
}

/**
 * Classify a value the resolver has ALREADY failed to match.
 *
 * Order is most specific first. An alias is an alias whatever else is true of
 * it; after that the classes that name a folder which really exists come
 * before the ones that only describe the value's shape, because "you were one
 * delimiter away" is a more useful fact than "it had an accent in it".
 */
export function classifyFolderInput(
  value: string,
  listing: readonly DiagnosticFolder[],
): { input_class: FolderInputClass; alias?: string } {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();

  const alias = lookupCanonicalAlias(trimmed);
  if (alias) {
    const canonical = alias.aliases[0];
    // Would the role have resolved if unselectable names counted? Then the
    // mailbox has the name and the server will not let anyone open it.
    // Asked both ways so an unrelated \\Noselect parent elsewhere in the tree
    // (Gmail's "[Gmail]") cannot produce this class by merely existing.
    const asListed: MailboxListEntry[] = listing.map((f) => ({
      name: f.name,
      delimiter: f.delimiter,
      flags: f.flags ?? [],
    }));
    const ignoringSelectability = asListed.map((f) => ({
      ...f,
      flags: f.flags.filter((flag) => !UNSELECTABLE_FLAGS.has(flag.toLowerCase())),
    }));
    if (
      resolveImapAlias(asListed, alias).kind === "none" &&
      resolveImapAlias(ignoringSelectability, alias).kind !== "none"
    ) {
      return { input_class: "matches_noselect", alias: canonical };
    }
    return {
      input_class: lower === canonical ? "alias_no_role" : "alias_synonym",
      alias: canonical,
    };
  }

  if (GMAIL_SYSTEM_TOKEN_RE.test(trimmed)) return { input_class: "gmail_system_token" };

  if (WIRE_UTF7_RE.test(trimmed) && decodeModifiedUtf7(trimmed) !== trimmed) {
    return { input_class: "wire_utf7" };
  }

  const folded = foldDelimiters(trimmed);
  if (listing.some((f) => foldDelimiters(f.name) === folded)) {
    return { input_class: "delimiter_mismatch" };
  }

  if (listing.some((f) => leafOf(f) === lower)) return { input_class: "leaf_of_existing_path" };

  // deno-lint-ignore no-control-regex
  if (/[^\x00-\x7f]/.test(trimmed)) return { input_class: "non_ascii" };

  return { input_class: "other" };
}

/**
 * The payload for one failed resolve.
 *
 * `imap` says whether `listing` came from an IMAP LIST, which is the only kind
 * of listing where the absence of a SPECIAL-USE flag means anything. The
 * position fields start as "a scalar `folder`" and are overwritten by
 * {@link locateFolderFailure} when the value was one entry of a list.
 */
export function folderResolveAuditDetails(
  value: string,
  listing: readonly DiagnosticFolder[],
  imap: boolean,
): FolderResolveAuditDetails {
  const { input_class, alias } = classifyFolderInput(value, listing);
  return {
    phase: "resolve_folder",
    arg: "folder",
    input_class,
    entries: 1,
    failed_index: 0,
    listing_size: listing.length,
    has_special_use: imap
      ? listing.some((f) => (f.flags ?? []).some((flag) => SPECIAL_USE_FLAGS.has(flag.toLowerCase())))
      : null,
    ...(alias ? { alias } : {}),
  };
}

/** The same payload, placed in the list argument it actually came from. */
export function locateFolderFailure(
  details: FolderResolveAuditDetails,
  arg: FolderArgumentName,
  entries: number,
  failedIndex: number,
): FolderResolveAuditDetails {
  return { ...details, arg, entries, failed_index: failedIndex };
}
