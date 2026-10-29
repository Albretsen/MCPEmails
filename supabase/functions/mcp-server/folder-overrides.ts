// ---------------------------------------------------------------------------
// folder-overrides.ts - the folder a user picked for a role, and when it wins.
//
// Automatic role detection (resolveImapAlias in imap-folder-target.ts) finds
// Sent, Drafts, Trash, Spam and Archive on almost every IMAP layout. For the
// few it cannot resolve (a name no list knows, two equal candidates), a user
// can pick the folder per inbox in the dashboard: Inboxes > inbox > Advanced >
// Folders. The pick is stored in `inboxes.folder_overrides`, a jsonb object
// such as {"sent": "INBOX.Éléments envoyés"}.
//
// The rules, in priority order:
//
//   1. An override is only ever a folder the server LISTS right now, selectable
//      (not \Noselect / \NonExistent). One that has gone away is ignored and
//      automatic detection runs exactly as if nothing were stored.
//   2. Never INBOX, and never the same folder for two roles. A stored value
//      that breaks either rule is dropped on read, so a bad row cannot move
//      mail into the inbox or merge Trash into Sent.
//   3. Never create a folder for an override. Creating stays what automatic
//      detection already did (the canonical "Archive", "Trash", "Drafts").
//   4. A refused APPEND or COPY into the override falls back to automatic
//      detection. Only refusals that provably changed nothing qualify (a
//      rejected APPEND, a UID COPY answered NO), so a fallback can never
//      duplicate or lose a message.
//
// Pure: no I/O and no imports beyond other pure modules, so the web dashboard
// (apps/web/src/lib/inboxes/folder-overrides.ts) imports the same rules and
// shows the same automatic pick the server makes.
// ---------------------------------------------------------------------------

import {
  lookupCanonicalAlias,
  type MailboxListEntry,
  resolveImapAlias,
} from "./imap-folder-target.ts";
import { sentCopyCandidates } from "./sent-copy.ts";

/** The roles a user may pick a folder for, in the order the dashboard shows them. */
export const FOLDER_OVERRIDE_ROLES = ["sent", "drafts", "trash", "spam", "archive"] as const;

export type FolderOverrideRole = typeof FOLDER_OVERRIDE_ROLES[number];

export type FolderOverrides = Partial<Record<FolderOverrideRole, string>>;

/** Longest folder name accepted. Mirrors the CHECK on inboxes.folder_overrides. */
export const FOLDER_OVERRIDE_MAX_LENGTH = 512;

/** Why a pick was refused. Each has a one-line message in the dashboard. */
export type FolderOverrideRefusal =
  | "invalid_role"
  | "invalid_folder"
  | "inbox_not_allowed"
  | "not_listed"
  | "used_by_other_role";

const UNSELECTABLE_FLAGS = new Set(["\\noselect", "\\nonexistent"]);

export function isFolderOverrideRole(value: unknown): value is FolderOverrideRole {
  return typeof value === "string" && (FOLDER_OVERRIDE_ROLES as readonly string[]).includes(value);
}

/** INBOX is reserved and case-insensitive (RFC 3501 5.1). */
export function isInboxName(name: string): boolean {
  return name.toUpperCase() === "INBOX";
}

/** A string that could be a folder name at all: non-empty, bounded, no control characters. */
function isPlausibleFolderName(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= FOLDER_OVERRIDE_MAX_LENGTH &&
    !/[\x00-\x1F\x7F]/.test(value);
}

/**
 * The stored column, reduced to what may be used. Unknown keys, non-strings,
 * INBOX and any folder named by two roles are dropped (both roles, since there
 * is no telling which one the user meant). Never throws.
 */
export function parseFolderOverrides(raw: unknown): FolderOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries: [FolderOverrideRole, string][] = [];
  for (const role of FOLDER_OVERRIDE_ROLES) {
    const value = (raw as Record<string, unknown>)[role];
    if (isPlausibleFolderName(value) && !isInboxName(value)) entries.push([role, value]);
  }
  const counts = new Map<string, number>();
  for (const [, name] of entries) counts.set(name, (counts.get(name) ?? 0) + 1);
  const out: FolderOverrides = {};
  for (const [role, name] of entries) if (counts.get(name) === 1) out[role] = name;
  return out;
}

export function isSelectableMailbox(mb: MailboxListEntry): boolean {
  return !mb.flags.some((f) => UNSELECTABLE_FLAGS.has(f.toLowerCase()));
}

/** Folders a user may pick from: listed, selectable, not INBOX, de-duplicated, in LIST order. */
export function pickableFolderNames(mailboxes: readonly MailboxListEntry[]): string[] {
  const out: string[] = [];
  for (const mb of mailboxes) {
    if (!isSelectableMailbox(mb) || isInboxName(mb.name) || !isPlausibleFolderName(mb.name)) continue;
    if (!out.includes(mb.name)) out.push(mb.name);
  }
  return out;
}

/**
 * Check one pick against the live listing and the other roles' picks. `null`
 * clears the role and is always allowed. Returns the refusal, or null when the
 * pick may be saved.
 */
export function checkFolderOverride(input: {
  role: unknown;
  folder: unknown;
  mailboxes: readonly MailboxListEntry[];
  current: FolderOverrides;
}): FolderOverrideRefusal | null {
  if (!isFolderOverrideRole(input.role)) return "invalid_role";
  if (input.folder === null) return null;
  if (!isPlausibleFolderName(input.folder)) return "invalid_folder";
  if (isInboxName(input.folder)) return "inbox_not_allowed";
  if (!pickableFolderNames(input.mailboxes).includes(input.folder)) return "not_listed";
  for (const role of FOLDER_OVERRIDE_ROLES) {
    if (role !== input.role && input.current[role] === input.folder) return "used_by_other_role";
  }
  return null;
}

/** `current` with one role set or cleared. The result is what gets stored (null when empty). */
export function withFolderOverride(
  current: FolderOverrides,
  role: FolderOverrideRole,
  folder: string | null,
): FolderOverrides | null {
  const next: FolderOverrides = { ...current };
  if (folder === null) delete next[role];
  else next[role] = folder;
  return Object.keys(next).length > 0 ? next : null;
}

/** What {@link pickFolderOverride} found for one role. */
export type FolderOverridePick =
  | { kind: "override"; name: string }
  /** Nothing stored for this role. */
  | { kind: "none" }
  /** Stored, but the server no longer lists it as selectable. Automatic detection runs. */
  | { kind: "not_listed" };

/** The stored folder for `role`, if the server still lists it as selectable. */
export function pickFolderOverride(
  overrides: FolderOverrides,
  role: FolderOverrideRole,
  mailboxes: readonly MailboxListEntry[],
): FolderOverridePick {
  const name = overrides[role];
  if (!name) return { kind: "none" };
  return pickableFolderNames(mailboxes).includes(name) ? { kind: "override", name } : { kind: "not_listed" };
}

/**
 * The folder automatic detection would write `role` into, or null when it
 * finds none (and would create the canonical folder, or for Sent fall back to
 * the legacy names, none of which exist). What the dashboard shows as
 * "Automatic (...)". Destination semantics: never All Mail for archive.
 */
export function automaticFolderPick(
  mailboxes: readonly MailboxListEntry[],
  role: FolderOverrideRole,
): string | null {
  if (role === "sent") {
    const listed = new Set(mailboxes.filter(isSelectableMailbox).map((mb) => mb.name));
    return sentCopyCandidates(mailboxes).find((name) => listed.has(name)) ?? null;
  }
  const match = resolveImapAlias([...mailboxes], lookupCanonicalAlias(role)!);
  return match.kind === "matched" ? match.name : null;
}

/**
 * Mailboxes to try the Sent copy in, in order: the override (when listed),
 * then exactly the automatic order. A refused APPEND changes nothing on the
 * server, so walking on to the next candidate is safe.
 */
export function sentCopyCandidatesWithOverride(
  mailboxes: readonly MailboxListEntry[],
  overrides: FolderOverrides,
): string[] {
  const automatic = sentCopyCandidates(mailboxes);
  const pick = pickFolderOverride(overrides, "sent", mailboxes);
  if (pick.kind !== "override") return automatic;
  return [pick.name, ...automatic.filter((name) => name !== pick.name)];
}

/**
 * True for the one move failure that provably changed nothing: the server
 * answered the UID COPY (or the MOVE and then the COPY) with NO. imap-client's
 * uidMove only throws this before the \Deleted/EXPUNGE steps, so the message
 * is still in its source folder and a second attempt elsewhere is safe.
 */
export function isRefusedCopy(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("UID COPY failed");
}
