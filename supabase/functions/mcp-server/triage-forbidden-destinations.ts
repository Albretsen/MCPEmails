/**
 * Move destinations an automation may not file mail into, because moving mail
 * there is deletion wearing a different hat.
 *
 * Every provider empties its trash and junk folders on a timer, so a rule with
 * {type:'move', folder:'Trash'} is an unattended delete with a delayed fuse. We
 * advertise that Automations never delete mail, and that claim has to survive
 * somebody typing "Trash" into the folder box, in any language.
 *
 * WHY THIS IS DERIVED, NOT LISTED. Until 2026-10-20 the list was seven English
 * words, so "Papierkorb", "Корзина" or "Éléments supprimés" saved and ran as a
 * delete on a timer. The names a trash or junk mailbox really wears are already
 * maintained in one place, IMAP_ALIAS_ALTERNATE_NAMES in imap-folder-target.ts,
 * because the folder resolver needs them to FIND those mailboxes. Refusing the
 * same set here means a name added there for resolving is refused here for
 * free, and the two can never disagree.
 *
 * ONE COPY FOR BOTH RUNTIMES. This module and imap-folder-target.ts are pure and
 * import nothing outside this folder, so apps/web/src/lib/automations/rules.ts
 * imports `isForbiddenMoveDestination` from here (web -> edge, the same
 * crossing it already makes for search-translate.ts) instead of keeping a copy.
 *
 * A name is the last line of defence only for what the rule SAYS. A mailbox the
 * server flags \Trash or \Junk under a name nobody listed ("Müll") is caught at
 * run time instead, against the resolved destination: see
 * TriageFolderTarget.forbiddenRole in triage-engine.ts.
 */

import {
  CANONICAL_FOLDER_ALIASES,
  IMAP_ALIAS_ALTERNATE_NAMES,
  nameKey,
} from "./imap-folder-target.ts";

/** The canonical alias roles whose mailbox the provider purges on a timer. */
const PURGED_ROLES = ["trash", "spam"] as const;

/**
 * English words kept from the original list, plus the provider-native ids of
 * the same folders (Graph's well-known names; Gmail's TRASH and SPAM are
 * already "trash" and "spam"). Some are not folder NAMES anywhere, which is
 * why they are not in IMAP_ALIAS_ALTERNATE_NAMES, but a user can still type them.
 */
const EXTRA_FORBIDDEN_NAMES = [
  "trash",
  "bin",
  "deleted",
  "deleted items",
  "deleted messages",
  "junk",
  "spam",
  "deleteditems",
  "junkemail",
];

/**
 * Spam-role names NOT refused by name, because they are also ordinary folders
 * people make. Yahoo and AOL call their spam folder "Bulk", but on 2026-10-20
 * one iCloud workspace had 91 enabled rules filing mail into its OWN "Bulk"
 * and "Bulk Mail" folders (iCloud's junk is "Junk"). Yahoo and AOL flag their
 * Bulk \\Junk, so a move there is still refused, at run time, by
 * TriageFolderTarget.forbiddenRole.
 */
const NOT_REFUSED_BY_NAME = new Set(["bulk", "bulk mail"]);

/** NFC, lower case, trimmed, inner whitespace collapsed. */
function forbiddenKey(name: string): string {
  return nameKey(name).trim().replace(/\s+/g, " ");
}

/**
 * Every refused name, as a comparison key. Exported for tests and for the
 * engine's doc reference; compare through {@link isForbiddenMoveDestination}.
 */
export const TRIAGE_FORBIDDEN_MOVE_DESTINATIONS: ReadonlySet<string> = new Set(
  [
    ...EXTRA_FORBIDDEN_NAMES,
    ...PURGED_ROLES.flatMap((role) => [
      ...(CANONICAL_FOLDER_ALIASES.find((a) => a.aliases[0] === role)?.aliases ?? []),
      CANONICAL_FOLDER_ALIASES.find((a) => a.aliases[0] === role)?.imap ?? "",
      ...(IMAP_ALIAS_ALTERNATE_NAMES[role] ?? []),
    ]),
  ].filter(Boolean).map(forbiddenKey).filter((key) => !NOT_REFUSED_BY_NAME.has(key)),
);

/**
 * Is `folder` a trash or junk folder by name?
 *
 * Checked against the whole value and every tail after a hierarchy delimiter
 * ("/", "." or "\"), so "[Gmail]/Trash", "INBOX.Papierkorb" and
 * "INBOX/Deleted Items" are caught, and so is a name that itself contains a
 * dot: "INBOX.Nepageidaujamas el. paštas" has the leaf " paštas", which a
 * leaf-only check would have let through. Only whole names match: "Trashed
 * drafts" and "Junk mail leads" are ordinary folders.
 */
export function isForbiddenMoveDestination(folder: string): boolean {
  if (TRIAGE_FORBIDDEN_MOVE_DESTINATIONS.has(forbiddenKey(folder))) return true;
  for (let i = 0; i < folder.length; i++) {
    const ch = folder[i];
    if (ch !== "/" && ch !== "." && ch !== "\\") continue;
    if (TRIAGE_FORBIDDEN_MOVE_DESTINATIONS.has(forbiddenKey(folder.slice(i + 1)))) return true;
  }
  return false;
}

/** SPECIAL-USE flags (lower case, RFC 6154) of the mailboxes refused above. */
const PURGED_SPECIAL_USE_FLAGS = new Set(["\\trash", "\\junk"]);

/**
 * The purged role an IMAP mailbox advertises through SPECIAL-USE, or null.
 * Used on the RESOLVED destination at run time, where the name alone may be
 * one nobody listed.
 */
export function purgedRoleFromFlags(flags: readonly string[]): "trash" | "junk" | null {
  for (const flag of flags) {
    const lower = flag.toLowerCase();
    if (!PURGED_SPECIAL_USE_FLAGS.has(lower)) continue;
    return lower === "\\trash" ? "trash" : "junk";
  }
  return null;
}
