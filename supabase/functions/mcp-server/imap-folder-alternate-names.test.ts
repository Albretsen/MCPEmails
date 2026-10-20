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
  IMAP_ALIAS_LEGACY_ALTERNATE_NAMES,
  type ImapAliasMatch,
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
    how: "namespaced_localized_name",
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
    how: "localized_name",
  });
  assertEquals(resolveImapAlias(strato, alias("spam")), {
    kind: "matched",
    name: "Spamverdacht",
    how: "localized_name",
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
      { kind: "matched", name, how: "localized_name" },
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

// ---------------------------------------------------------------------------
// No layout that resolved before the localized names resolves differently now.
// ---------------------------------------------------------------------------

/** The alternates exactly as they were on main before the localized names. */
const FROZEN_OLD_ALTERNATES: Record<string, readonly string[]> = {
  sent: ["Sent Items", "Sent Messages", "Sent Mail", "Gesendet", "Envoyés", "已发送"],
  drafts: ["Draft", "Entwürfe", "Brouillons", "草稿箱"],
  trash: ["Deleted Items", "Deleted Messages", "Bin", "Papierkorb", "Corbeille", "已删除"],
  archive: ["Archives"],
  spam: ["Spam", "Bulk", "Junk E-mail", "Junk Email", "Bulk Mail", "垃圾邮件"],
};

/**
 * resolveImapAlias as it was on main before this change, copied verbatim and
 * pointed at FROZEN_OLD_ALTERNATES. Do not update it: it is the reference.
 */
function oldResolveImapAlias(
  mailboxes: MailboxListEntry[],
  aliasEntry: { aliases: string[]; imap: string },
  opts: { forRead?: boolean } = {},
): ImapAliasMatch {
  const key = (n: string) => n.normalize("NFC").toLowerCase();
  const canonicalToken = aliasEntry.aliases[0];
  if (canonicalToken === "inbox") return { kind: "matched", name: "INBOX", how: "reserved" };
  const unselectable = new Set(["\\noselect", "\\nonexistent"]);
  const selectable = mailboxes.filter((mb) => !mb.flags.some((f) => unselectable.has(f.toLowerCase())));
  const specialUse: Record<string, string> = {
    archive: "\\archive",
    sent: "\\sent",
    drafts: "\\drafts",
    trash: "\\trash",
    spam: "\\junk",
  };
  const wantFlag = specialUse[canonicalToken];
  if (wantFlag) {
    const bySpecialUse = selectable.find((mb) => mb.flags.some((f) => f.toLowerCase() === wantFlag));
    if (bySpecialUse) return { kind: "matched", name: bySpecialUse.name, how: "special_use" };
  }
  const wantName = aliasEntry.imap.toLowerCase();
  const byName = selectable.find((mb) => mb.name.toLowerCase() === wantName);
  if (byName) return { kind: "matched", name: byName.name, how: "canonical_name" };
  const canonical = new Set([key(aliasEntry.imap)]);
  const alternates = new Set((FROZEN_OLD_ALTERNATES[canonicalToken] ?? []).map(key));
  const underInbox = (mb: MailboxListEntry): string | null => {
    if (!mb.delimiter) return null;
    const prefix = `inbox${mb.delimiter}`;
    if (mb.name.length <= prefix.length) return null;
    return mb.name.slice(0, prefix.length).toLowerCase() === prefix ? mb.name.slice(prefix.length) : null;
  };
  const tiers: [string, (mb: MailboxListEntry) => boolean][] = [
    ["alternate_name", (mb) => alternates.has(key(mb.name))],
    ["namespaced_canonical_name", (mb) => {
      const rest = underInbox(mb);
      return rest !== null && canonical.has(key(rest));
    }],
    ["namespaced_alternate_name", (mb) => {
      const rest = underInbox(mb);
      return rest !== null && alternates.has(key(rest));
    }],
  ];
  for (const [how, qualifies] of tiers) {
    const hits = selectable.filter(qualifies);
    if (hits.length === 1) return { kind: "matched", name: hits[0].name, how } as ImapAliasMatch;
    if (hits.length > 1) return { kind: "ambiguous", candidates: hits.map((mb) => mb.name) };
  }
  if (canonicalToken === "archive" && opts.forRead) {
    const allMail = selectable.filter((mb) => mb.flags.some((f) => f.toLowerCase() === "\\all"));
    if (allMail.length === 1) return { kind: "matched", name: allMail[0].name, how: "all_mail" };
  }
  return { kind: "none" };
}

/** Layouts that resolve (or refuse) today, each mixed with localized names. */
const PARITY_LAYOUTS: Record<string, MailboxListEntry[]> = {
  "Gesendet + Gesendete Objekte": [
    listed("INBOX", "/"), listed("Gesendet", "/"), listed("Gesendete Objekte", "/"),
    listed("Papierkorb", "/"), listed("Gelöschte Objekte", "/"), listed("Entwürfe", "/"),
    listed("Spamverdacht", "/"), listed("Spam", "/"),
  ],
  "INBOX.Sent + Enviados": [
    listed("INBOX", "."), listed("INBOX.Sent", "."), listed("Enviados", "."),
    listed("INBOX.Trash", "."), listed("Papelera", "."), listed("Borradores", "."),
    listed("INBOX.Archive", "."), listed("Archivo", "."),
  ],
  "Gmail over IMAP": [
    listed("INBOX", "/"), listed("[Gmail]", "/", "\\Noselect"), listed("[Gmail]/All Mail", "/", "\\All"),
    listed("[Gmail]/Sent Mail", "/", "\\Sent"), listed("[Gmail]/Drafts", "/", "\\Drafts"),
    listed("[Gmail]/Trash", "/", "\\Trash"), listed("[Gmail]/Spam", "/", "\\Junk"),
    listed("Archiv", "/"), listed("Enviados", "/"), listed("Papelera", "/"),
  ],
  "Gmail over IMAP, localized labels": [
    listed("INBOX", "/"), listed("[Gmail]/Alle Nachrichten", "/", "\\All"),
    listed("[Gmail]/Gesendet", "/", "\\Sent"), listed("[Gmail]/Papierkorb", "/", "\\Trash"),
    listed("Arkiv", "/"),
  ],
  "Courier INBOX.*": [
    listed("INBOX", "."), listed("INBOX.Sent", "."), listed("INBOX.Drafts", "."),
    listed("INBOX.Trash", "."), listed("INBOX.Junk", "."), listed("INBOX.Archive", "."),
    listed("INBOX.Éléments envoyés", "."), listed("INBOX.Corbeille", "."), listed("INBOX.Archiv", "."),
  ],
  "Courier INBOX.* alternates": [
    listed("INBOX", "."), listed("INBOX.Sent Items", "."), listed("INBOX.Deleted Items", "."),
    listed("INBOX.Junk E-mail", "."), listed("Verzonden", "."), listed("Prullenbak", "."),
  ],
  "Exchange English": [
    listed("INBOX", "/"), listed("Sent Items", "/"), listed("Deleted Items", "/"),
    listed("Drafts", "/"), listed("Junk Email", "/"), listed("Archive", "/"),
    listed("Gesendete Elemente", "/"), listed("Éléments supprimés", "/"),
  ],
  "Exchange English, two legacy Sent names (ambiguous today)": [
    listed("INBOX", "/"), listed("Sent Items", "/"), listed("Sent Messages", "/"),
    listed("Elementos enviados", "/"),
  ],
  "Legacy names only": [
    listed("INBOX", "/"), listed("Envoyés", "/"), listed("Corbeille", "/"), listed("Brouillons", "/"),
    listed("已发送", "/"), listed("Archives", "/"), listed("Bulk Mail", "/"),
  ],
  "Archive read falls to All Mail before any localized archive": [
    listed("INBOX", "/"), listed("[Gmail]/All Mail", "/", "\\All"), listed("Archivio", "/"),
  ],
};

Deno.test("parity: every layout that resolved before resolves exactly the same now", () => {
  for (const [label, layout] of Object.entries(PARITY_LAYOUTS)) {
    for (const entry of CANONICAL_FOLDER_ALIASES) {
      for (const forRead of [false, true]) {
        const before = oldResolveImapAlias(layout, entry, { forRead });
        if (before.kind === "none") continue;
        assertEquals(
          resolveImapAlias(layout, entry, { forRead }),
          before,
          `${label} / ${entry.aliases[0]} / forRead=${forRead}`,
        );
      }
    }
  }
});

Deno.test("parity: Gesendet still wins over Gesendete Objekte, INBOX.Sent over Enviados", () => {
  assertEquals(sentCopyCandidates(PARITY_LAYOUTS["Gesendet + Gesendete Objekte"])[0], "Gesendet");
  assertEquals(sentCopyCandidates(PARITY_LAYOUTS["INBOX.Sent + Enviados"])[0], "INBOX.Sent");
});

Deno.test("parity: the layouts above exercise every old tier that can win", () => {
  const seen = new Set<string>();
  for (const layout of Object.values(PARITY_LAYOUTS)) {
    for (const entry of CANONICAL_FOLDER_ALIASES) {
      for (const forRead of [false, true]) {
        const r = oldResolveImapAlias(layout, entry, { forRead });
        seen.add(r.kind === "matched" ? r.how : r.kind);
      }
    }
  }
  for (const tier of [
    "special_use", "canonical_name", "alternate_name", "namespaced_canonical_name",
    "namespaced_alternate_name", "all_mail", "ambiguous",
  ]) {
    assert(seen.has(tier), `no parity layout reaches ${tier}`);
  }
});

Deno.test("the legacy names are frozen and still part of the full list", () => {
  assertEquals(IMAP_ALIAS_LEGACY_ALTERNATE_NAMES, FROZEN_OLD_ALTERNATES);
  assert(Object.isFrozen(IMAP_ALIAS_LEGACY_ALTERNATE_NAMES));
  for (const [role, names] of Object.entries(FROZEN_OLD_ALTERNATES)) {
    for (const name of names) {
      assert(IMAP_ALIAS_ALTERNATE_NAMES[role]?.includes(name), `${role}: legacy "${name}" missing from the full list`);
    }
  }
});

Deno.test("two localized names in one tier are ambiguous, never ranked", () => {
  const topLevel = [listed("INBOX", "/"), listed("Gesendete Objekte", "/"), listed("Gesendete Elemente", "/")];
  assertEquals(resolveImapAlias(topLevel, alias("sent")), {
    kind: "ambiguous",
    candidates: ["Gesendete Objekte", "Gesendete Elemente"],
  });
  assertEquals(sentCopyCandidates(topLevel), [...LEGACY_SENT_FOLDER_CANDIDATES]);

  const namespaced = [listed("INBOX", "."), listed("INBOX.Corbeille", "."), listed("INBOX.Éléments supprimés", ".")];
  // "Corbeille" is a legacy name, so the legacy pass answers and the localized
  // name never gets a vote.
  assertEquals(resolveImapAlias(namespaced, alias("trash")).kind, "matched");
  const twoNew = [listed("INBOX", "."), listed("INBOX.Elementos eliminados", "."), listed("INBOX.Papelera", ".")];
  assertEquals(resolveImapAlias(twoNew, alias("trash")), {
    kind: "ambiguous",
    candidates: ["INBOX.Elementos eliminados", "INBOX.Papelera"],
  });
});

Deno.test("a whole localized name wins over a namespaced one, like the old tiers", () => {
  const layout = [listed("INBOX", "."), listed("Enviados", "."), listed("INBOX.Verzonden", ".")];
  assertEquals(resolveImapAlias(layout, alias("sent")), { kind: "matched", name: "Enviados", how: "localized_name" });
});

Deno.test("a mailbox the server flags for one role is never another role's by its localized name", () => {
  const layout = [
    listed("INBOX", "/"),
    listed("Skräppost", "/", "\\Sent"),
    listed("Kustutatud üksused", "/", "\\Junk"),
    listed("[Gmail]/Отправленные", "/", "\\All"),
    listed("INBOX/Corbeille-privée", "/"),
  ];
  assertEquals(resolveImapAlias(layout, alias("sent")), { kind: "matched", name: "Skräppost", how: "special_use" });
  assertEquals(resolveImapAlias(layout, alias("spam")), { kind: "matched", name: "Kustutatud üksused", how: "special_use" });
  assertEquals(resolveImapAlias(layout, alias("trash")), { kind: "none" });
  const allMailOnly = [listed("INBOX", "/"), listed("Отправленные", "/", "\\All")];
  assertEquals(resolveImapAlias(allMailOnly, alias("sent")), { kind: "none" });
});

Deno.test("parity, randomized: 20,000 seeded layouts agree with the old matcher wherever it answered", () => {
  let seed = 20261020;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
  const allNames = [...new Set(Object.values(IMAP_ALIAS_ALTERNATE_NAMES).flat())];
  const legacyNames = Object.values(FROZEN_OLD_ALTERNATES).flat();
  const canonicalNames = ["Sent", "Drafts", "Trash", "Archive", "Junk", "sent", "TRASH"];
  const userNames = ["Receipts", "Projects", "Work", "Old", "Projects/Trash", "Archive/2019"];
  const flags = ["\\Sent", "\\Trash", "\\Junk", "\\Drafts", "\\Archive", "\\All", "\\Noselect", "\\HasChildren"];
  let compared = 0;
  for (let i = 0; i < 20_000; i++) {
    const delimiter = pick([".", "/", undefined]);
    const layout: MailboxListEntry[] = [{ name: "INBOX", flags: [], delimiter }];
    const count = 1 + Math.floor(rnd() * 8);
    for (let j = 0; j < count; j++) {
      const r = rnd();
      let name = r < 0.35
        ? pick(allNames)
        : r < 0.55
        ? pick(legacyNames)
        : r < 0.7
        ? pick(canonicalNames)
        : r < 0.8
        ? pick(userNames)
        : pick(allNames).toUpperCase();
      if (delimiter && rnd() < 0.3) name = `INBOX${delimiter}${name}`;
      if (rnd() < 0.1) name = name.normalize("NFD");
      layout.push({ name, flags: rnd() < 0.15 ? [pick(flags)] : [], delimiter });
    }
    const owners = new Map<string, string>();
    for (const entry of CANONICAL_FOLDER_ALIASES) {
      for (const forRead of [false, true]) {
        const before = oldResolveImapAlias(layout, entry, { forRead });
        const now = resolveImapAlias(layout, entry, { forRead });
        if (before.kind !== "none") {
          compared++;
          assertEquals(now, before, JSON.stringify({ layout, role: entry.aliases[0], forRead }));
        }
        if (!forRead && now.kind === "matched" && now.how.includes("localized")) {
          assert(!owners.has(now.name), `${now.name} claimed by ${owners.get(now.name)} and ${entry.aliases[0]}`);
        }
        if (!forRead && now.kind === "matched") owners.set(now.name, entry.aliases[0]);
      }
    }
  }
  assert(compared > 50_000, `only ${compared} comparisons`);
});
