// ---------------------------------------------------------------------------
// What a refused folder argument leaves in activity_log.error_details.
//
// ── Why ────────────────────────────────────────────────────────────────────
// A `folder_not_found` raised by the resolver was logged as a bare code. On
// 2026-10-02 that one code was hiding several unrelated habits of the calling
// model (a role alias the mailbox has no folder for, the leaf of a nested
// path, the wrong hierarchy delimiter, a Gmail token sent to a non-Gmail
// mailbox), and separating them took a hand sample of rows joined against live
// listings. These payloads make the same question a GROUP BY.
//
// ── The property that matters most ─────────────────────────────────────────
// The payload is persisted and read by operators. It must not contain what the
// caller typed or what the mailbox is called, in whole or in part. So half of
// this file is not about classification at all: it feeds the builder
// distinctive fake names and asserts that no fragment of them comes out.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  classifyFolderInput,
  type DiagnosticFolder,
  type FolderInputClass,
  folderResolveAuditDetails,
  locateFolderFailure,
} from "./folder-resolve-diagnostics.ts";
import { FolderTargetError } from "./folder-errors.ts";
import { CANONICAL_FOLDER_ALIASES } from "./imap-folder-target.ts";

const SOURCE = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

/** Same crude extractor the neighbouring wiring tests use. */
function functionBody(name: string): string {
  let start = SOURCE.indexOf(`\nasync function ${name}(`);
  if (start === -1) start = SOURCE.indexOf(`\nfunction ${name}(`);
  assert(start !== -1, `index.ts no longer declares ${name}`);
  const end = SOURCE.indexOf("\n}\n", start);
  assert(end !== -1, `could not find the end of ${name}`);
  return SOURCE.slice(start, end);
}

function listed(name: string, delimiter: string, ...flags: string[]): DiagnosticFolder {
  return { name, delimiter, flags };
}

/** Names nothing real would be called, so a leak is unmistakable. */
const SECRET_INPUT = "Zebra Quartz Ledger 7731";
const SECRET_FOLDERS = [
  "Vellum Harbour Notes",
  "Vellum Harbour Notes/Obsidian Tally 4402",
  "INBOX.Cobalt Wren Dossier",
  "Entwürfe Ülküm Privat",
];
const SECRET_FRAGMENTS = [
  "Zebra", "Quartz", "Ledger", "7731",
  "Vellum", "Harbour", "Notes", "Obsidian", "Tally", "4402",
  "Cobalt", "Wren", "Dossier", "Entw", "lküm", "Privat",
];

const SECRET_LISTING: DiagnosticFolder[] = [
  listed("INBOX", "/"),
  ...SECRET_FOLDERS.map((name) => listed(name, name.includes(".") ? "." : "/")),
];

function assertValueFree(persisted: string, context: string): void {
  for (const fragment of SECRET_FRAGMENTS) {
    assert(
      !persisted.includes(fragment),
      `"${fragment}" reached the persisted payload (${context}): ${persisted}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Value-free, whatever was typed and whatever the mailbox holds.
// ---------------------------------------------------------------------------

Deno.test("the payload never contains the input value or any folder name", () => {
  const inputs = [
    SECRET_INPUT,
    // Each of these classifies differently, so every branch is exercised.
    "Obsidian Tally 4402", // leaf of an existing path
    "Vellum Harbour Notes.Obsidian Tally 4402", // delimiter mismatch
    "Cobalt Wren Dossier", // leaf under INBOX.
    "Entw&APw-rfe Zebra", // wire UTF-7
    "Ülküm Privat Zebra", // non-ASCII
    "[Gmail]/Zebra Quartz", // Gmail path
    "CATEGORY_ZEBRA",
    "sent",
    "junk",
  ];
  for (const input of inputs) {
    const details = folderResolveAuditDetails(input, SECRET_LISTING, true);
    assertValueFree(JSON.stringify(details), `scalar "${input}"`);
    const inList = locateFolderFailure(details, "include_folders", 3, 2);
    assertValueFree(JSON.stringify(inList), `list entry "${input}"`);
  }
});

Deno.test("the payload has exactly the documented keys, and no field that can hold free text", () => {
  const details = folderResolveAuditDetails(SECRET_INPUT, SECRET_LISTING, true);
  assertEquals(Object.keys(details).sort(), [
    "arg",
    "entries",
    "failed_index",
    "has_special_use",
    "input_class",
    "listing_size",
    "phase",
  ]);
  assertEquals(details.phase, "resolve_folder");
  // Only an alias class adds a key, and its value is from a closed list.
  const aliased = folderResolveAuditDetails("junk", SECRET_LISTING, true);
  assertEquals(Object.keys(aliased).sort(), [
    "alias",
    "arg",
    "entries",
    "failed_index",
    "has_special_use",
    "input_class",
    "listing_size",
    "phase",
  ]);
  const canonical = CANONICAL_FOLDER_ALIASES.map((entry) => entry.aliases[0]);
  assert(canonical.includes(aliased.alias!), `alias "${aliased.alias}" is not a canonical token`);
  // Every string value in the payload is one this module chose.
  for (const [key, value] of Object.entries(aliased)) {
    if (typeof value !== "string") continue;
    assert(/^[a-z_]+$/.test(value), `${key} holds something that is not an enum token: ${value}`);
  }
});

Deno.test("the alias stored is the CANONICAL token, never the spelling that was typed", () => {
  // "Junk", " JUNK " and "junk" are all the spam role. What is stored is the
  // table's own word for it, so the caller's casing and padding cannot ride
  // along, and neither can a synonym.
  for (const typed of ["junk", "Junk", " JUNK ", "spam", "SPAM"]) {
    assertEquals(folderResolveAuditDetails(typed, [], true).alias, "spam", typed);
  }
  assertEquals(folderResolveAuditDetails("Deleted", [], true).alias, "trash");
  assertEquals(folderResolveAuditDetails("draft", [], true).alias, "drafts");
  // A value that is not an alias stores no alias key at all.
  assert(!("alias" in folderResolveAuditDetails(SECRET_INPUT, [], true)));
});

// ---------------------------------------------------------------------------
// Classification.
// ---------------------------------------------------------------------------

const LAYOUT: DiagnosticFolder[] = [
  listed("INBOX", "/"),
  listed("Receipts", "/"),
  listed("Work", "/", "\\HasChildren"),
  listed("Work/Invoices", "/"),
  listed("Work/Invoices/2024", "/"),
  listed("Entwürfe", "/"),
];

Deno.test("table: each kind of failed value gets its own class", () => {
  const cases: [string, DiagnosticFolder[], FolderInputClass][] = [
    // A canonical alias the mailbox has no folder for.
    ["sent", LAYOUT, "alias_no_role"],
    ["Archive", LAYOUT, "alias_no_role"],
    ["TRASH", LAYOUT, "alias_no_role"],
    // A synonym of one.
    ["junk", LAYOUT, "alias_synonym"],
    ["deleted", LAYOUT, "alias_synonym"],
    ["Draft", LAYOUT, "alias_synonym"],
    // The last segment of a nested folder.
    ["Invoices", LAYOUT, "leaf_of_existing_path"],
    ["invoices", LAYOUT, "leaf_of_existing_path"],
    ["2024", LAYOUT, "leaf_of_existing_path"],
    // The right path with the wrong delimiter.
    ["Work.Invoices", LAYOUT, "delimiter_mismatch"],
    ["work.invoices.2024", LAYOUT, "delimiter_mismatch"],
    ["INBOX/Projects", [listed("INBOX", "."), listed("INBOX.Projects", ".")], "delimiter_mismatch"],
    // Gmail's vocabulary, sent to a mailbox that does not have it.
    ["[Gmail]/All Mail", LAYOUT, "gmail_system_token"],
    ["[Google Mail]/Papierkorb", LAYOUT, "gmail_system_token"],
    ["STARRED", LAYOUT, "gmail_system_token"],
    ["CATEGORY_PROMOTIONS", LAYOUT, "gmail_system_token"],
    ["All Mail", LAYOUT, "gmail_system_token"],
    // The wire form of a name instead of the decoded one.
    ["Entw&APw-rfe", LAYOUT, "wire_utf7"],
    // Non-ASCII that matched nothing.
    ["Reçus", LAYOUT, "non_ascii"],
    // And the rest.
    ["Recietps", LAYOUT, "other"],
    ["R&D", LAYOUT, "other"],
  ];
  for (const [value, layout, want] of cases) {
    assertEquals(classifyFolderInput(value, layout).input_class, want, `"${value}"`);
  }
});

Deno.test("an alias whose only candidate cannot be opened is matches_noselect", () => {
  const layout = [
    listed("INBOX", "/"),
    listed("Sent Items", "/", "\\Noselect", "\\HasChildren"),
    listed("Sent Items/2024", "/"),
  ];
  assertEquals(classifyFolderInput("sent", layout), { input_class: "matches_noselect", alias: "sent" });
  // An unrelated \\Noselect parent elsewhere does not produce the class by
  // merely existing: Gmail's "[Gmail]" is one on every Gmail mailbox.
  const gmail = [
    listed("INBOX", "/"),
    listed("[Gmail]", "/", "\\Noselect", "\\HasChildren"),
    listed("[Gmail]/All Mail", "/", "\\All"),
  ];
  assertEquals(classifyFolderInput("archive", gmail), { input_class: "alias_no_role", alias: "archive" });
});

Deno.test("an alias is classified as an alias before anything else", () => {
  // "trash" is also the leaf of "Projects/Trash". The caller asked for a role,
  // and that is the fact worth counting.
  const layout = [listed("INBOX", "/"), listed("Projects/Trash", "/")];
  assertEquals(classifyFolderInput("trash", layout).input_class, "alias_no_role");
});

Deno.test("listing_size, has_special_use and the position fields say what they mean", () => {
  const flagged = [listed("INBOX", "/"), listed("Papierkorb", "/", "\\Trash"), listed("Receipts", "/")];
  const d = folderResolveAuditDetails("sent", flagged, true);
  assertEquals(d.listing_size, 3);
  assertEquals(d.has_special_use, true);
  assertEquals([d.arg, d.entries, d.failed_index], ["folder", 1, 0]);

  // Attribute flags that are not ROLE flags do not count.
  const unflagged = [listed("INBOX", "/", "\\HasChildren"), listed("Receipts", "/", "\\HasNoChildren")];
  assertEquals(folderResolveAuditDetails("sent", unflagged, true).has_special_use, false);

  // Gmail and Outlook over their own APIs have no such flags to be missing.
  const labels: DiagnosticFolder[] = [{ name: "INBOX" }, { name: "Receipts" }];
  assertEquals(folderResolveAuditDetails("nope", labels, false).has_special_use, null);

  const located = locateFolderFailure(d, "include_folders", 4, 2);
  assertEquals([located.arg, located.entries, located.failed_index], ["include_folders", 4, 2]);
  assertEquals(located.input_class, d.input_class, "locating changes nothing else");
});

// ---------------------------------------------------------------------------
// Wiring: the payload is what gets logged, and the folder name is not.
// ---------------------------------------------------------------------------

Deno.test("FolderTargetError keeps the diagnostics apart from the payload the caller reads", () => {
  const details = folderResolveAuditDetails(SECRET_INPUT, SECRET_LISTING, true);
  const err = new FolderTargetError({
    error: "folder_not_found",
    provider: "imap",
    folder: SECRET_INPUT,
    message: `No folder matching "${SECRET_INPUT}" exists in this imap inbox.`,
  }, details);
  // The caller's copy names what they typed. That is the point of it.
  assertStringIncludes(JSON.stringify(err.payload), SECRET_INPUT);
  // The logged copy does not, and the two are different objects.
  assertValueFree(JSON.stringify(err.details), "FolderTargetError.details");
  assert(!("phase" in err.payload), "diagnostics must not be merged into the caller's payload");
  // And an error raised without a listing in hand logs nothing rather than a guess.
  assertEquals(
    new FolderTargetError({ error: "folder_not_found", provider: "imap", folder: "x", message: "m" })
      .details,
    null,
  );
});

Deno.test("every refusal in resolveFolderId carries diagnostics, built from the raw value", () => {
  const body = functionBody("resolveFolderId");
  assertStringIncludes(
    body,
    "folderResolveAuditDetails(nameOrId, imapMailboxes ?? folders, imapMailboxes !== null)",
  );
  const throws = body.split("throw new FolderTargetError(").length - 1;
  const diagnosed = body.split("}, diagnose());").length - 1;
  assertEquals(throws, 4, "resolveFolderId gained or lost a refusal; give it diagnostics too");
  assertEquals(diagnosed, throws, "a refusal in resolveFolderId is thrown without diagnostics");
});

Deno.test("folderTargetErrorResult logs err.details and never err.payload", () => {
  const body = functionBody("folderTargetErrorResult");
  assertStringIncludes(body, "...(err.details ? { logErrorDetails: err.details } : {}),");
  assert(
    !/logErrorDetails:\s*err\.payload/.test(body),
    "the caller's payload, which names the folder, must never be what is logged",
  );
});

Deno.test("include_folders records which entry failed, by position", () => {
  const body = functionBody("resolveIncludeFolders");
  assertStringIncludes(body, "for (const [index, f] of includeFolders.entries())");
  assertStringIncludes(body, "locateFolderFailure(");
  assertStringIncludes(body, '"include_folders",');
  assertStringIncludes(body, "includeFolders.length,");
});
