import { assert, assertEquals } from "jsr:@std/assert@1";
import type { MailboxListEntry } from "./imap-folder-target.ts";
import { LEGACY_SENT_FOLDER_CANDIDATES } from "./sent-copy.ts";
import {
  automaticFolderPick,
  checkFolderOverride,
  FOLDER_OVERRIDE_ROLES,
  isRefusedCopy,
  parseFolderOverrides,
  pickableFolderNames,
  pickFolderOverride,
  sentCopyCandidatesWithOverride,
  withFolderOverride,
} from "./folder-overrides.ts";

function listed(name: string, ...flags: string[]): MailboxListEntry {
  return { name, delimiter: ".", flags };
}

/** An OVH MX Plan style layout: everything under INBOX., Sent in French. */
const OVH = [
  listed("INBOX"),
  listed("INBOX.Éléments envoyés"),
  listed("INBOX.INBOX.Sent"),
  listed("INBOX.Brouillons"),
  listed("INBOX.Corbeille"),
];

Deno.test("parse: only the five roles, only plausible strings", () => {
  assertEquals(
    parseFolderOverrides({
      sent: "INBOX.Éléments envoyés",
      drafts: 7,
      trash: "",
      spam: "Bad\r\nname",
      archive: "x".repeat(513),
      inbox: "Somewhere",
      other: "Folder",
    }),
    { sent: "INBOX.Éléments envoyés" },
  );
  for (const raw of [null, undefined, "sent", 42, [], ["sent"]]) assertEquals(parseFolderOverrides(raw), {});
});

Deno.test("parse: INBOX is never a target, in any case", () => {
  assertEquals(parseFolderOverrides({ sent: "INBOX", trash: "inbox", spam: "Inbox", archive: "INBOX.Archive" }), {
    archive: "INBOX.Archive",
  });
});

Deno.test("parse: a folder named by two roles is dropped from both", () => {
  assertEquals(parseFolderOverrides({ sent: "Mail", trash: "Mail", drafts: "Drafts" }), { drafts: "Drafts" });
});

Deno.test("pickable: listed, selectable, not INBOX, no duplicates", () => {
  const layout = [
    listed("INBOX"),
    listed("[Gmail]", "\\Noselect"),
    listed("Gone", "\\NonExistent"),
    listed("Sent"),
    listed("Sent"),
    listed("Archive"),
  ];
  assertEquals(pickableFolderNames(layout), ["Sent", "Archive"]);
});

Deno.test("check: every guardrail, enforced on the server's own listing", () => {
  const current = { drafts: "INBOX.Brouillons" };
  const check = (role: unknown, folder: unknown) => checkFolderOverride({ role, folder, mailboxes: OVH, current });
  assertEquals(check("sent", "INBOX.Éléments envoyés"), null);
  assertEquals(check("sent", null), null, "clearing is always allowed");
  assertEquals(check("inbox", "INBOX.Corbeille"), "invalid_role");
  assertEquals(check("Sent", "INBOX.Corbeille"), "invalid_role");
  assertEquals(check("sent", 5), "invalid_folder");
  assertEquals(check("sent", ""), "invalid_folder");
  assertEquals(check("sent", "a\nb"), "invalid_folder");
  assertEquals(check("trash", "INBOX"), "inbox_not_allowed");
  assertEquals(check("trash", "inbox"), "inbox_not_allowed");
  assertEquals(check("sent", "INBOX.Sent"), "not_listed", "a name the server did not list");
  assertEquals(check("trash", "INBOX.Brouillons"), "used_by_other_role");
  assertEquals(check("drafts", "INBOX.Brouillons"), null, "re-saving a role's own pick is fine");
});

Deno.test("check: a \\Noselect parent cannot be picked", () => {
  const layout = [listed("INBOX"), listed("Parent", "\\Noselect"), listed("Parent.Child")];
  assertEquals(checkFolderOverride({ role: "archive", folder: "Parent", mailboxes: layout, current: {} }), "not_listed");
  assertEquals(checkFolderOverride({ role: "archive", folder: "Parent.Child", mailboxes: layout, current: {} }), null);
});

Deno.test("withFolderOverride: set, replace, clear, and null when empty", () => {
  assertEquals(withFolderOverride({}, "sent", "A"), { sent: "A" });
  assertEquals(withFolderOverride({ sent: "A" }, "sent", "B"), { sent: "B" });
  assertEquals(withFolderOverride({ sent: "A", trash: "T" }, "sent", null), { trash: "T" });
  assertEquals(withFolderOverride({ sent: "A" }, "sent", null), null);
});

Deno.test("pick: a listed override wins, a vanished one is not_listed, none is none", () => {
  assertEquals(pickFolderOverride({ sent: "INBOX.Éléments envoyés" }, "sent", OVH), {
    kind: "override",
    name: "INBOX.Éléments envoyés",
  });
  assertEquals(pickFolderOverride({ sent: "Renamed" }, "sent", OVH), { kind: "not_listed" });
  assertEquals(pickFolderOverride({}, "sent", OVH), { kind: "none" });
  const noselect = [listed("INBOX"), listed("Sent", "\\Noselect")];
  assertEquals(pickFolderOverride({ sent: "Sent" }, "sent", noselect), { kind: "not_listed" });
});

Deno.test("automatic pick: what the server would use today, never All Mail for archive", () => {
  assertEquals(automaticFolderPick(OVH, "drafts"), "INBOX.Brouillons");
  assertEquals(automaticFolderPick(OVH, "trash"), "INBOX.Corbeille");
  assertEquals(automaticFolderPick(OVH, "archive"), null);
  assertEquals(automaticFolderPick(OVH, "spam"), null);
  const gmail = [listed("INBOX"), listed("[Gmail]/All Mail", "\\All"), listed("[Gmail]/Sent Mail", "\\Sent")];
  assertEquals(automaticFolderPick(gmail, "archive"), null);
  assertEquals(automaticFolderPick(gmail, "sent"), "[Gmail]/Sent Mail");
});

Deno.test("automatic pick, Sent: the first legacy name that exists when detection is unsure", () => {
  // Two equal Sent names and no flag: detection refuses to pick, the send path
  // walks the legacy list, and the first one listed is where the copy lands.
  const tied = [listed("INBOX"), listed("Sent Items"), listed("Sent Messages")];
  assertEquals(automaticFolderPick(tied, "sent"), "Sent Messages");
  assertEquals(automaticFolderPick([listed("INBOX")], "sent"), null);
});

Deno.test("sent copy: the override goes first, then exactly the automatic order", () => {
  const layout = [listed("INBOX"), listed("Sent", "\\Sent"), listed("Outbox copies")];
  assertEquals(sentCopyCandidatesWithOverride(layout, { sent: "Outbox copies" }), [
    "Outbox copies",
    "Sent",
    ...LEGACY_SENT_FOLDER_CANDIDATES.filter((n) => n !== "Sent"),
  ]);
});

Deno.test("sent copy: a stale or absent override changes nothing", () => {
  const layout = [listed("INBOX"), listed("Sent", "\\Sent")];
  const automatic = sentCopyCandidatesWithOverride(layout, {});
  assertEquals(sentCopyCandidatesWithOverride(layout, { sent: "Deleted long ago" }), automatic);
  assertEquals(sentCopyCandidatesWithOverride(layout, { trash: "Sent" }), automatic);
});

Deno.test("sent copy: the override is never repeated when it is also the automatic pick", () => {
  const layout = [listed("INBOX"), listed("Sent", "\\Sent")];
  const out = sentCopyCandidatesWithOverride(layout, { sent: "Sent" });
  assertEquals(out.filter((n) => n === "Sent").length, 1);
  assertEquals(out[0], "Sent");
});

Deno.test("refused copy: only the UID COPY NO qualifies for a fallback", () => {
  assert(isRefusedCopy(new Error("UID COPY failed: NO [TRYCREATE] Mailbox does not exist")));
  assert(!isRefusedCopy(new Error("Connection reset")));
  assert(!isRefusedCopy(new Error("UID STORE failed")));
  assert(!isRefusedCopy("UID COPY failed"));
});

Deno.test("refused copy: imap-client still throws the message isRefusedCopy keys on, before any destructive step", async () => {
  const src = await Deno.readTextFile(new URL("./imap-client.ts", import.meta.url));
  assert(src.includes("throw new Error(`UID COPY failed: ${resp.text}`);"));
  const move = src.slice(src.indexOf("  uidMove(uids: number[]"), src.indexOf("  uidExpunge(uids: number[])"));
  const copy = move.indexOf("this.uidCopyUnlocked(");
  assert(copy > 0 && copy < move.indexOf("this.uidStoreUnlocked("), "COPY runs before STORE \\Deleted");
});

Deno.test("roles: the five roles, in dashboard order", () => {
  assertEquals([...FOLDER_OVERRIDE_ROLES], ["sent", "drafts", "trash", "spam", "archive"]);
});

// ── Wiring in index.ts (it calls Deno.serve at load, so a source scan) ──────

const INDEX = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function body(name: string): string {
  const start = INDEX.indexOf(`async function ${name}(`);
  assert(start >= 0, `${name} exists`);
  const next = INDEX.indexOf("\nasync function ", start + 10);
  return INDEX.slice(start, next === -1 ? undefined : next);
}

Deno.test("wiring: every role destination consults the override first", () => {
  assert(body("appendToSentFolder").includes("sentCopyCandidatesWithOverride("));
  assert(body("imapArchiveEmail").includes('imapRoleOverride(inbox, "archive"'));
  assert(body("resolveImapTrashMailbox").includes('imapRoleOverride(inbox, "trash"'));
  assert(body("imapListDrafts").includes('imapRoleOverride(inbox, "drafts"'));
  assert(body("imapCreateDraft").includes('imapRoleOverride(inbox, "drafts"'));
  assert(body("resolveFolderId").includes("imapRoleOverride(inbox, roleToken"));
});

Deno.test("wiring: no override path creates a folder", () => {
  // createMailbox appears only inside the automatic fallbacks.
  for (const name of ["imapArchiveEmail", "imapCreateDraft"]) {
    const fn = body(name);
    const overrideAt = fn.indexOf("imapRoleOverride(");
    const creates = [...fn.matchAll(/createMailbox\(/g)].map((m) => m.index!);
    const automaticAt = fn.indexOf("const automatic");
    assert(creates.length > 0 && creates.every((i) => i > automaticAt && i < overrideAt), name);
  }
  assert(!body("resolveImapTrashMailbox").split("async function automaticImapTrashMailbox")[0].includes("createMailbox("));
});

Deno.test("wiring: folder_overrides is read in its own query, never in INBOX_SELECT_COLUMNS", () => {
  const columns = INDEX.slice(INDEX.indexOf("const INBOX_SELECT_COLUMNS ="), INDEX.indexOf("function imapAuthUser"));
  assert(!columns.includes("folder_overrides"));
  assert(body("readInboxFolderOverrides").includes('.select("folder_overrides")'));
});
