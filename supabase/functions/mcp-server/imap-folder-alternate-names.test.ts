// ---------------------------------------------------------------------------
// Localized role names in IMAP_ALIAS_ALTERNATE_NAMES.
//
// An OVH MX Plan mailbox keeps its Sent folder as "INBOX.Éléments envoyés"
// (Outlook's French name) and sets no SPECIAL-USE flag, so every Sent copy was
// refused: the name was not in the table and the legacy English fallbacks do
// not exist there. A Strato mailbox did the same with "Gesendete Objekte". The
// table now carries the default names in many languages, and the first test
// below is what keeps that safe: these names choose the destination of a move,
// a soft delete and a Sent copy, so no name may belong to two roles.
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  CANONICAL_FOLDER_ALIASES,
  IMAP_ALIAS_ALTERNATE_NAMES,
  lookupCanonicalAlias,
  type MailboxListEntry,
  nameKey,
  resolveImapAlias,
} from "./imap-folder-target.ts";
import { LEGACY_SENT_FOLDER_CANDIDATES, sentCopyCandidates } from "./sent-copy.ts";

function listed(name: string, delimiter: string, ...flags: string[]): MailboxListEntry {
  return { name, delimiter, flags };
}

function alias(token: string) {
  const entry = lookupCanonicalAlias(token);
  assert(entry, `no canonical alias ${token}`);
  return entry;
}

Deno.test("alternate names: every name belongs to exactly one role and is no other role's canonical name", () => {
  const owner = new Map<string, string>();
  const problems: string[] = [];
  for (const [role, names] of Object.entries(IMAP_ALIAS_ALTERNATE_NAMES)) {
    assert(lookupCanonicalAlias(role), `${role} is not a canonical alias token`);
    for (const name of names) {
      const key = nameKey(name);
      const seen = owner.get(key);
      if (seen !== undefined && seen !== role) problems.push(`"${name}" is both ${seen} and ${role}`);
      owner.set(key, role);
    }
  }
  for (const entry of CANONICAL_FOLDER_ALIASES) {
    const role = entry.aliases[0];
    const claimedBy = owner.get(nameKey(entry.imap));
    if (claimedBy !== undefined && claimedBy !== role) {
      problems.push(`"${entry.imap}" is ${role}'s canonical name but listed under ${claimedBy}`);
    }
  }
  assertEquals(problems, []);
});

Deno.test("alternate names: no entry is blank, padded or a hierarchy path", () => {
  for (const [role, names] of Object.entries(IMAP_ALIAS_ALTERNATE_NAMES)) {
    for (const name of names) {
      assert(name.length > 0 && name === name.trim(), `${role}: "${name}" is blank or padded`);
      assert(!/[/\\]/.test(name), `${role}: "${name}" contains a hierarchy delimiter`);
    }
  }
});

Deno.test("OVH MX Plan: the Sent copy goes to INBOX.Éléments envoyés", () => {
  const ovh = [
    listed("INBOX", "."),
    listed("INBOX.Éléments envoyés", "."),
    listed("INBOX.INBOX.Sent", "."),
  ];
  assertEquals(sentCopyCandidates(ovh)[0], "INBOX.Éléments envoyés");
  assertEquals(resolveImapAlias(ovh, alias("sent")), {
    kind: "matched",
    name: "INBOX.Éléments envoyés",
    how: "namespaced_alternate_name",
  });
});

Deno.test("Strato-like layout: top-level Gesendete Objekte is the Sent mailbox", () => {
  const strato = [
    listed("INBOX", "/"),
    listed("Gesendete Objekte", "/"),
    listed("Gelöschte Objekte", "/"),
    listed("Entwürfe", "/"),
    listed("Spamverdacht", "/"),
  ];
  assertEquals(sentCopyCandidates(strato), ["Gesendete Objekte", ...LEGACY_SENT_FOLDER_CANDIDATES]);
  assertEquals(resolveImapAlias(strato, alias("trash")), {
    kind: "matched",
    name: "Gelöschte Objekte",
    how: "alternate_name",
  });
  assertEquals(resolveImapAlias(strato, alias("spam")), {
    kind: "matched",
    name: "Spamverdacht",
    how: "alternate_name",
  });
});

Deno.test("an NFD-encoded Éléments envoyés still matches", () => {
  const nfd = "INBOX.Éléments envoyés".normalize("NFD");
  assert(nfd !== "INBOX.Éléments envoyés".normalize("NFC"));
  const layout = [listed("INBOX", "."), listed(nfd, ".")];
  assertEquals(sentCopyCandidates(layout)[0], nfd);
});

Deno.test("localized names resolve in other scripts", () => {
  const cases: [string, string][] = [
    ["sent", "Отправленные"],
    ["sent", "送信済み"],
    ["sent", "보낸 편지함"],
    ["sent", "Απεσταλμένα"],
    ["sent", "العناصر المرسلة"],
    ["trash", "Корзина"],
    ["trash", "ごみ箱"],
    ["trash", "פריטים שנמחקו"],
    ["drafts", "下書き"],
    ["drafts", "Черновики"],
    ["spam", "迷惑メール"],
    ["spam", "Нежелательная почта"],
    ["archive", "Архив"],
  ];
  for (const [role, name] of cases) {
    const layout = [listed("INBOX", "/"), listed(name, "/")];
    assertEquals(
      resolveImapAlias(layout, alias(role)),
      { kind: "matched", name, how: "alternate_name" },
      `${role} / ${name}`,
    );
  }
});

Deno.test("matching stays whole-name: a localized name as a suffix or segment is not the role", () => {
  const layout = [
    listed("INBOX", "."),
    listed("Projekte.Papierkorb", "."),
    listed("Alte Gesendete Objekte", "."),
    listed("INBOX.Kunden.Éléments supprimés", "."),
  ];
  assertEquals(resolveImapAlias(layout, alias("trash")), { kind: "none" });
  assertEquals(resolveImapAlias(layout, alias("sent")), { kind: "none" });
});
