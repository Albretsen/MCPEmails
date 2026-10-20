// ---------------------------------------------------------------------------
// Folder choice per inbox: Inboxes > inbox > Advanced > Folders.
//
// The rules are not restated here. They are imported from the edge function's
// pure module (supabase/functions/mcp-server/folder-overrides.ts), the same
// file mcp-server and client-api enforce them with, so the dashboard shows the
// automatic pick the server really makes and refuses exactly what the server
// would ignore. Dependency-free TypeScript, imported web -> edge like
// lib/automations/rules.ts imports search-translate.ts.
//
// This module only orders the steps; the route supplies the I/O (deps).
// ---------------------------------------------------------------------------

import {
  automaticFolderPick,
  checkFolderOverride,
  FOLDER_OVERRIDE_ROLES,
  type FolderOverrideRefusal,
  type FolderOverrideRole,
  type FolderOverrides,
  parseFolderOverrides,
  pickableFolderNames,
  pickFolderOverride,
  withFolderOverride,
} from '../../../../../supabase/functions/mcp-server/folder-overrides.ts';
import type { MailboxListEntry } from '../../../../../supabase/functions/mcp-server/imap-folder-target.ts';

export { FOLDER_OVERRIDE_ROLES, isFolderOverrideRole } from '../../../../../supabase/functions/mcp-server/folder-overrides.ts';
export type { FolderOverrideRole, FolderOverrides, MailboxListEntry };

/** The inbox columns that decide whether folder choice applies. */
export interface FolderInboxRow {
  provider: string;
  imap_host: string | null;
  imap_security: string | null;
  imap_password: string | null;
  oauth_access_token: string | null;
}

/**
 * Folder choice is for inboxes that read over IMAP with a password: generic
 * IMAP, iCloud, Yahoo, Fastmail app passwords and the rest. Gmail and Outlook
 * API inboxes file Sent themselves and have no IMAP folders to pick, and a
 * send-only inbox has no folders at all. STARTTLS inboxes are left out because
 * the dashboard's IMAP client (lib/email/imap.ts) speaks implicit TLS only.
 */
export function folderChoiceApplies(row: FolderInboxRow): boolean {
  return !!row.imap_host && !!row.imap_password && !row.oauth_access_token && row.imap_security !== 'starttls';
}

export type FolderError =
  | FolderOverrideRefusal
  | 'unsupported_inbox'
  | 'folders_unreachable'
  | 'unavailable'
  | 'load_failed'
  | 'save_failed';

export const FOLDER_ERROR_STATUS: Record<FolderError, number> = {
  invalid_role: 400,
  invalid_folder: 400,
  inbox_not_allowed: 400,
  not_listed: 400,
  used_by_other_role: 409,
  unsupported_inbox: 400,
  folders_unreachable: 502,
  unavailable: 503,
  load_failed: 500,
  save_failed: 500,
};

export type FolderResult<T> = { ok: true; value: T } | { ok: false; error: FolderError };

/** What the read of `folder_overrides` found. `unavailable`: the column is not there yet. */
export type StoredOverrides = { ok: true; raw: unknown } | { ok: false; unavailable: boolean };

export interface FolderDeps {
  /** LIST "" "*" on the inbox's IMAP server, names decoded. Throws when it cannot. */
  listMailboxes(): Promise<MailboxListEntry[]>;
  readOverrides(): Promise<StoredOverrides>;
  /** Store the whole object (null clears the column). Throws on failure. */
  writeOverrides(next: FolderOverrides | null): Promise<void>;
}

export interface RoleSetting {
  role: FolderOverrideRole;
  /** What automatic detection picks right now, or null for "not found". */
  automatic: string | null;
  /** The user's pick, only when the server still lists it (otherwise automatic applies). */
  override: string | null;
}

export interface FolderSettings {
  /** Folders that may be picked, decoded, in the server's LIST order. INBOX is never one. */
  folders: string[];
  roles: RoleSetting[];
}

async function storedOverrides(deps: FolderDeps): Promise<FolderResult<FolderOverrides>> {
  const stored = await deps.readOverrides();
  if (!stored.ok) return { ok: false, error: stored.unavailable ? 'unavailable' : 'load_failed' };
  return { ok: true, value: parseFolderOverrides(stored.raw) };
}

async function liveMailboxes(deps: FolderDeps): Promise<FolderResult<MailboxListEntry[]>> {
  try {
    return { ok: true, value: await deps.listMailboxes() };
  } catch {
    return { ok: false, error: 'folders_unreachable' };
  }
}

function settingsFor(mailboxes: MailboxListEntry[], overrides: FolderOverrides): FolderSettings {
  return {
    folders: pickableFolderNames(mailboxes),
    roles: FOLDER_OVERRIDE_ROLES.map((role) => {
      const pick = pickFolderOverride(overrides, role, mailboxes);
      return {
        role,
        automatic: automaticFolderPick(mailboxes, role),
        override: pick.kind === 'override' ? pick.name : null,
      };
    }),
  };
}

/** The Folders panel: every pickable folder and, per role, the automatic pick and the user's pick. */
export async function loadFolderSettings(deps: FolderDeps): Promise<FolderResult<FolderSettings>> {
  const overrides = await storedOverrides(deps);
  if (!overrides.ok) return overrides;
  const mailboxes = await liveMailboxes(deps);
  if (!mailboxes.ok) return mailboxes;
  return { ok: true, value: settingsFor(mailboxes.value, overrides.value) };
}

/**
 * Save or clear one role. A pick is checked against a fresh LIST (only a
 * folder the server listed may be stored), INBOX and a folder another role
 * already uses are refused. Clearing needs no IMAP connection, so "Reset to
 * automatic" works even while the mail server is unreachable.
 */
export async function saveFolderOverride(
  deps: FolderDeps,
  role: FolderOverrideRole,
  folder: string | null,
): Promise<FolderResult<{ overrides: FolderOverrides }>> {
  const current = await storedOverrides(deps);
  if (!current.ok) return current;
  let mailboxes: MailboxListEntry[] = [];
  if (folder !== null) {
    const listed = await liveMailboxes(deps);
    if (!listed.ok) return listed;
    mailboxes = listed.value;
  }
  const refusal = checkFolderOverride({ role, folder, mailboxes, current: current.value });
  if (refusal) return { ok: false, error: refusal };
  const next = withFolderOverride(current.value, role, folder);
  try {
    await deps.writeOverrides(next);
  } catch {
    return { ok: false, error: 'save_failed' };
  }
  return { ok: true, value: { overrides: next ?? {} } };
}
