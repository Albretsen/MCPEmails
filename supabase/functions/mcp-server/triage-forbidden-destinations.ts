/**
 * Move destinations an automation may not file mail into, because moving mail
 * there is deletion wearing a different hat.
 *
 * Every provider empties its trash on a timer, so a rule with
 * {type:'move', folder:'Trash'} is an unattended delete with a delayed fuse. We
 * advertise that Automations never delete mail, and that claim has to survive
 * somebody typing "Trash" into the folder box, in any language.
 *
 * JUNK AND SPAM ARE ALLOWED, on purpose (decided 2026-10-20). Filing unwanted
 * mail into the junk folder is one of the main things people build automations
 * for: that day 14 enabled rules did exactly that (Outlook "Junk Email", Yahoo
 * and AOL "Bulk"). They used to be refused by name here too; they are not any
 * more. Do not add the spam role back without asking.
 *
 * WHY THIS IS DERIVED, NOT LISTED. Until 2026-10-20 the list was a handful of
 * English words, so "Papierkorb", "Корзина" or "Éléments supprimés" saved and
 * ran as a delete on a timer. The names a trash mailbox really wears are
 * already maintained in one place, IMAP_ALIAS_ALTERNATE_NAMES in
 * imap-folder-target.ts, because the folder resolver needs them to FIND that
 * mailbox. Refusing the same set here means a name added there for resolving
 * is refused here for free, and the two can never disagree.
 *
 * ONE COPY FOR BOTH RUNTIMES. This module and imap-folder-target.ts are pure and
 * import nothing outside this folder, so apps/web/src/lib/automations/rules.ts
 * imports `isForbiddenMoveDestination` from here (web -> edge, the same
 * crossing it already makes for search-translate.ts) instead of keeping a copy.
 *
 * A name is the last line of defence only for what the rule SAYS. A mailbox the
 * server flags \Trash under a name nobody listed ("Müll") is caught at run time
 * instead, against the resolved destination: see
 * TriageFolderTarget.forbiddenRole in triage-engine.ts.
 */

import {
  CANONICAL_FOLDER_ALIASES,
  IMAP_ALIAS_ALTERNATE_NAMES,
  nameKey,
} from "./imap-folder-target.ts";

/**
 * English words kept from the original list, plus Graph's well-known id for
 * the same folder (Gmail's TRASH is already "trash"). Not all are folder NAMES
 * anywhere, which is why they are not in IMAP_ALIAS_ALTERNATE_NAMES, but a
 * user can still type them.
 */
const EXTRA_FORBIDDEN_NAMES = [
  "trash",
  "bin",
  "deleted",
  "deleted items",
  "deleted messages",
  "deleteditems",
];

/** NFC, lower case, trimmed, inner whitespace collapsed. */
function forbiddenKey(name: string): string {
  return nameKey(name).trim().replace(/\s+/g, " ");
}

const TRASH_ALIAS = CANONICAL_FOLDER_ALIASES.find((a) => a.aliases[0] === "trash");

/**
 * Every refused name, as a comparison key. Exported for tests and for the
 * engine's doc reference; compare through {@link isForbiddenMoveDestination}.
 */
export const TRIAGE_FORBIDDEN_MOVE_DESTINATIONS: ReadonlySet<string> = new Set(
  [
    ...EXTRA_FORBIDDEN_NAMES,
    ...(TRASH_ALIAS?.aliases ?? []),
    TRASH_ALIAS?.imap ?? "",
    ...(IMAP_ALIAS_ALTERNATE_NAMES.trash ?? []),
  ].filter(Boolean).map(forbiddenKey),
);

/**
 * Is `folder` a trash folder by name?
 *
 * Checked against the whole value and every tail after a hierarchy delimiter
 * ("/", "." or "\"), so "[Gmail]/Trash", "INBOX.Papierkorb" and
 * "INBOX/Deleted Items" are caught. Only whole names match: "Trashed drafts"
 * is an ordinary folder.
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

/**
 * "trash" when an IMAP mailbox advertises SPECIAL-USE \Trash, else null. Used
 * on the RESOLVED destination at run time, where the name alone may be one
 * nobody listed. \Junk is deliberately not checked: see the header.
 */
export function purgedRoleFromFlags(flags: readonly string[]): "trash" | null {
  return flags.some((flag) => flag.toLowerCase() === "\\trash") ? "trash" : null;
}
