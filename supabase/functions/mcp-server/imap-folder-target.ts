// ---------------------------------------------------------------------------
// imap-folder-target.ts - which mailbox an IMAP operation actually opens.
//
// ── The bug this exists to fix ─────────────────────────────────────────────
// An IMAP message id is "<folder>:<uid>" and the folder half is MINTED BY US
// from a name the server itself reported (encodeImapId is only ever called with
// a mailbox that came back from LIST, from resolveFolderId, or from the SELECT
// that produced the UID). Thirteen call sites nonetheless pushed that name back
// through `imapFolderName`, a static alias-table lookup, before SELECTing it:
//
//   imapFolderName("Spam")    === "Junk"     ← the reported bug
//   imapFolderName("Draft")   === "Drafts"
//   imapFolderName("Deleted") === "Trash"
//   imapFolderName("trash")   === "Trash"
//
// So a Yandex account, whose spam mailbox is literally named "Spam" and which
// has no "Junk" at all, could list its spam fine and then fail every read,
// reply, flag, move, copy and delete of those messages with
// "Mailbox not found: Junk". The server told us the name; we overwrote it with
// a guess about what the name ought to be.
//
// The same second mapping was removed from the search path earlier (see the
// "must not alias-map folder names a second time" scan in
// search-phase-wiring.test.ts) and from the draft path before that (see
// imapUpdateDraft's comment in index.ts). This module is where that rule now
// lives once, for every caller.
//
// ── Why the folder half of an id is treated as OPAQUE ──────────────────────
// {@link imapMailboxForServerFolder} returns the name VERBATIM and never
// consults the alias table. The cost of that is a hand-crafted id like
// "spam:5", built from an alias word instead of from folder_list output: it
// used to work by accident on a server whose mailbox happens to be named
// "Junk", and now it fails with "Mailbox not found: spam". That trade is
// deliberate, and the reasons are in priority order:
//
//   1. A UID is unique only WITHIN a mailbox. Resolving an unmatched folder
//      token to some other mailbox does not find the caller's message — it
//      re-points their UID at a different, unrelated message. On email_delete
//      and email_move that silently destroys or relocates mail nobody asked
//      about. Refusing is not a worse outcome than that; it is the only safe
//      one.
//   2. The accident was never dependable anyway. "spam:5" only ever resolved
//      when the account's mailbox happened to carry the alias table's English
//      default, which is exactly the coin flip that broke Yandex. Keeping it as
//      a fallback would enshrine the coin flip instead of removing it.
//   3. The failure is already legible and already recoverable: ImapClient
//      raises "Mailbox not found: <the literal we tried>", and folder_list
//      returns the server's real names to build a correct id from. Alias words
//      still work everywhere they are a user-facing ARGUMENT (email_list's
//      `folder`, a move destination): those go through resolveFolderId, which
//      resolves against the account's REAL layout rather than a fixed name.
//   4. The "just retry with the alias on failure" variant is not free either.
//      A command that failed mid-exchange may have left the socket
//      desynchronised — the reason resolveImapAliasMailbox invalidates a
//      borrowed session after a throw — so a second SELECT on that same
//      connection is precisely what that rule warns against.
//
// Everything here is PURE (no I/O, no client), which is the usual reason for a
// module in this directory: index.ts calls `Deno.serve` at load and cannot be
// imported by a test, so a decision that only lives there can be pinned by a
// source scan and nothing more. The decisions below are run for real in
// imap-folder-target.test.ts; the source scan only pins the wiring.
// ---------------------------------------------------------------------------

/**
 * Single source of truth mapping a canonical folder alias to each provider's
 * native value. Every provider-specific folder map (`outlookWellKnownFolder`,
 * `imapFolderName`) and the cross-provider `resolveFolderId` helper derive from
 * this table — keep this the only place provider folder vocabulary lives.
 *
 * - `gmail`: system label ID (e.g. "INBOX", "TRASH"). Gmail has no system
 *   "archive" label — archiving means removing the INBOX label — so the
 *   `archive` alias has no Gmail value (`null`); resolveFolderId falls through
 *   to listing / pass-through, and email_archive handles the real archive op.
 * - `outlook`: Graph well-known folder name (e.g. "inbox", "deleteditems").
 * - `fastmail`: JMAP mailbox `role`; resolved to a concrete mailbox id at
 *   runtime via the folder list (no static id exists).
 * - `imap`: common mailbox name; for IMAP the name *is* the id.
 *
 * `aliases` lists every accepted user-facing token (case-insensitive) for the
 * canonical entry, including the legacy UPPER canonical names used by callers.
 */
export interface CanonicalFolderAlias {
  /** Accepted user-facing tokens (matched case-insensitively). */
  aliases: string[];
  /** Gmail system label ID, or null when no system label exists (archive). */
  gmail: string | null;
  /** Microsoft Graph well-known folder name. */
  outlook: string;
  /** Common IMAP mailbox name (the name is the id). */
  imap: string;
}

export const CANONICAL_FOLDER_ALIASES: CanonicalFolderAlias[] = [
  { aliases: ["inbox"], gmail: "INBOX", outlook: "inbox", imap: "INBOX" },
  { aliases: ["sent"], gmail: "SENT", outlook: "sentitems", imap: "Sent" },
  { aliases: ["drafts", "draft"], gmail: "DRAFT", outlook: "drafts", imap: "Drafts" },
  { aliases: ["trash", "deleted"], gmail: "TRASH", outlook: "deleteditems", imap: "Trash" },
  { aliases: ["archive"], gmail: null, outlook: "archive", imap: "Archive" },
  { aliases: ["spam", "junk"], gmail: "SPAM", outlook: "junkemail", imap: "Junk" },
];

/** Case-insensitive lookup of a canonical alias entry by any of its tokens. */
export function lookupCanonicalAlias(
  token: string,
): CanonicalFolderAlias | undefined {
  const lower = token.trim().toLowerCase();
  return CANONICAL_FOLDER_ALIASES.find((e) => e.aliases.includes(lower));
}

/**
 * Maps a canonical folder alias (matched by its first token) to the IMAP
 * SPECIAL-USE attribute flag a mailbox advertises for that role (RFC 6154),
 * lower-cased for case-insensitive comparison against LIST flags.
 *
 * Used to resolve aliases ("archive", "trash", …) against the server's ACTUAL
 * mailbox layout instead of assuming a fixed English name like "Archive" — the
 * generic-IMAP move bug where "archive" hard-resolved to a non-existent
 * "Archive" mailbox. "inbox" has no SPECIAL-USE flag (it is always the reserved
 * name "INBOX"), so it is intentionally absent.
 */
export const IMAP_ALIAS_SPECIAL_USE: Record<string, string> = {
  archive: "\\archive",
  sent: "\\sent",
  drafts: "\\drafts",
  trash: "\\trash",
  spam: "\\junk",
};

/**
 * Other WHOLE names a role's mailbox commonly wears on servers that do not flag
 * it with SPECIAL-USE, keyed by the canonical alias token. Matched
 * case-insensitively, after the flag and after the canonical name
 * (`CanonicalFolderAlias.imap`), so nothing here can outvote either.
 *
 * WHY THIS EXISTS. Measured over the 14 days to 2026-10-02: about 239
 * `folder_not_found` errors across 61 workspaces from a model passing `sent`,
 * `trash`, `junk`, `drafts` or `archive` without listing folders first (87% had
 * no prior `folder_list`). Yahoo and iCloud, which flag their roles, failed
 * 0.02 to 0.05% of searches; generic IMAP failed 1.2% and Gmail over IMAP 3.4%.
 * The role existed on those mailboxes. It was just not called the one English
 * word the matcher knew.
 *
 * WHICH NAMES. English: the names Outlook/Exchange, Apple Mail, Thunderbird and
 * the common webmail suites create. Localized: the defaults those clients and
 * the big national providers create in each language, because many hosts that
 * do not set SPECIAL-USE (OVH MX Plan, Strato, QQ Mail, plenty of cPanel and
 * Courier servers) keep whatever the first client to connect named the folder.
 * An OVH mailbox whose Sent is "INBOX.Éléments envoyés" (Outlook's French
 * name) saved no Sent copy at all until that name was here.
 *
 * Every name has to pass all four of these rules. A wrong entry is a wrong
 * DESTINATION for a move, a soft delete or a Sent copy, so when in doubt a name
 * stays out: the flag already covers every server that sets it, in any
 * language.
 *   1. It is the default folder name a real client or server creates in that
 *      language: Outlook/Exchange, Apple Mail, Thunderbird, Roundcube, Gmail's
 *      localized labels, Dovecot/cPanel/Plesk, or a big national provider
 *      (GMX/Web.de, Orange, Libero, Seznam, WP, Yandex/Mail.ru, Naver, Daum,
 *      QQ). Documented or widely attested, not translated by us.
 *   2. After nameKey (NFC, lower case) it belongs to exactly ONE role across
 *      all languages. A string that means two roles in two languages is
 *      dropped from both ("Lixo" is trash in Thunderbird pt-PT and close to
 *      junk elsewhere; "Sampah" is Gmail's Indonesian trash and part of
 *      Outlook's Indonesian junk; "垃圾箱" is trash on some Chinese hosts and
 *      spam on others). The same string meaning the same role in several
 *      languages is fine ("Poslano", "Arkiv", "Koncepty").
 *   3. It is not a word a user would plausibly give a folder of their own.
 *      Bare "Mail", "Items", "Old", "Other", "Notes" never; nor drafts names
 *      that also mean "sketches" ("Skice", "Szkice", "Schițe"), nor names that
 *      collide with Outbox ("寄件匣", "Вихідні").
 *   4. It is not another role's canonical name (`CanonicalFolderAlias.imap`).
 * imap-folder-target.test.ts enforces 2 and 4 over the whole map, so a later
 * cross-role duplicate fails CI. Rules 1 and 3 are on the person adding a name.
 *
 * Variant spellings that NFC does not unify are listed separately: Romanian
 * comma-below and cedilla (ș/ş), Vietnamese tone-mark placement (xóa/xoá), the
 * Russian ё/е, the Persian zero-width non-joiner.
 */
/**
 * The alternate names as they stood before the localized names were added,
 * frozen. {@link resolveImapAlias} runs every tier it always ran with ONLY
 * these, and returns that answer whenever it is a match or an ambiguity. The
 * localized names are consulted only when this pass finds nothing, so a layout
 * that resolved before resolves to the same mailbox now: an account holding
 * both "Gesendet" and "Gesendete Objekte" still gets "Gesendet", and
 * "INBOX.Sent" is not pre-empted by a top-level "Enviados". Do not add names
 * here; add them to IMAP_ALIAS_ALTERNATE_NAMES.
 */
export const IMAP_ALIAS_LEGACY_ALTERNATE_NAMES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  sent: Object.freeze(["Sent Items", "Sent Messages", "Sent Mail", "Gesendet", "Envoyés", "已发送"]),
  drafts: Object.freeze(["Draft", "Entwürfe", "Brouillons", "草稿箱"]),
  trash: Object.freeze(["Deleted Items", "Deleted Messages", "Bin", "Papierkorb", "Corbeille", "已删除"]),
  archive: Object.freeze(["Archives"]),
  spam: Object.freeze(["Spam", "Bulk", "Junk E-mail", "Junk Email", "Bulk Mail", "垃圾邮件"]),
});

/**
 * Every alternate name a role answers to: the legacy names above plus the
 * localized ones. The legacy names must stay in here too (a test checks it), so
 * this is the one list the collision rules are enforced over.
 */
export const IMAP_ALIAS_ALTERNATE_NAMES: Record<string, readonly string[]> = {
  sent: [
    // English
    "Sent Items", "Sent Messages", "Sent Mail",
    // German
    "Gesendet", "Gesendete Objekte", "Gesendete Elemente", "Gesendete Nachrichten",
    // French
    "Envoyés", "Éléments envoyés", "Messages envoyés",
    // Spanish, Portuguese (PT, BR)
    "Enviados", "Elementos enviados", "Mensajes enviados", "Itens Enviados", "Mensagens Enviadas",
    "E-mails enviados",
    // Italian, Catalan
    "Posta inviata", "Inviata", "Inviati", "Messaggi inviati", "Enviats", "Elements enviats",
    "Missatges enviats",
    // Dutch
    "Verzonden", "Verzonden items", "Verzonden berichten",
    // Norwegian, Danish, Swedish, Finnish, Icelandic
    "Sendt", "Sendte elementer", "Sendte meldinger", "Sendt post", "Sendte meddelelser", "Skickat",
    "Skickade", "Skickade objekt", "Skickade meddelanden", "Lähetetyt", "Lähetetyt kohteet",
    "Lähetetyt viestit", "Sendir hlutir",
    // Polish, Czech, Slovak, Hungarian, Romanian
    "Wysłane", "Elementy wysłane", "Odeslané", "Odeslaná pošta", "Odoslané", "Odoslaná pošta",
    "Elküldött", "Elküldött elemek", "Elküldött üzenetek", "Trimise", "Elemente trimise",
    "Mesaje trimise",
    // Croatian, Serbian, Slovenian, Bosnian (Latin)
    "Poslano", "Poslane stavke", "Poslato", "Poslate stavke", "Poslana pošta",
    // Bulgarian, Russian, Ukrainian, Greek
    "Изпратени", "Отправленные", "Надіслані", "Відправлені", "Απεσταλμένα",
    // Turkish, Lithuanian, Latvian, Estonian
    "Gönderilmiş Öğeler", "Gönderilenler", "Išsiųsti", "Išsiųsti elementai", "Nosūtītie",
    "Nosūtītie vienumi", "Saadetud", "Saadetud üksused", "Saadetud kirjad",
    // Japanese, Korean, Chinese (Simplified, Traditional)
    "送信済み", "送信済みアイテム", "送信済みメール", "送信済みトレイ", "보낸 편지함", "보낸편지함",
    "보낸 메일함", "보낸메일함", "已发送", "已发送邮件", "已發送", "寄件備份", "已傳送", "已傳送郵件",
    // Vietnamese, Indonesian, Malay, Thai
    "Đã gửi", "Thư đã gửi", "Mục đã gửi", "Terkirim", "Item Terkirim", "Item Dihantar",
    "รายการที่ส่ง", "ส่งแล้ว",
    // Hebrew, Arabic, Persian, Hindi
    "פריטים שנשלחו", "נשלחו", "العناصر المرسلة", "المرسلة", "البريد المرسل", "ارسال شده",
    "ارسال‌شده", "موارد ارسال شده", "भेजे गए", "भेजे गए आइटम",
  ],
  drafts: [
    "Draft",
    "Entwürfe",
    "Brouillons",
    "Borradores", "Rascunhos",
    "Bozze", "Esborranys",
    "Concepten",
    "Utkast", "Kladder", "Luonnokset", "Drög",
    "Wersje robocze", "Kopie robocze", "Koncepty", "Rozepsané", "Piszkozatok", "Ciorne",
    "Nacrti", "Radne verzije", "Osnutki",
    "Чернови", "Черновики", "Чернетки", "Πρόχειρα",
    "Taslaklar", "Juodraščiai", "Melnraksti", "Mustandid",
    "下書き", "임시 보관함", "임시보관함", "草稿箱", "草稿", "草稿匣",
    "Thư nháp", "Bản nháp", "Draf", "แบบร่าง", "ฉบับร่าง",
    "טיוטות", "المسودات", "پیش‌نویس‌ها", "پیش نویس ها", "ड्राफ़्ट",
  ],
  trash: [
    "Deleted Items", "Deleted Messages", "Bin",
    "Papierkorb", "Gelöschte Objekte", "Gelöschte Elemente", "Gelöschte Nachrichten",
    "Corbeille", "Éléments supprimés", "Messages supprimés",
    "Papelera", "Elementos eliminados", "Mensajes eliminados", "Lixeira", "Itens Excluídos",
    "Itens Eliminados",
    "Cestino", "Posta eliminata", "Elementi eliminati", "Paperera", "Elements suprimits",
    "Prullenbak", "Prullenmand", "Verwijderde items", "Verwijderde berichten",
    "Papirkurv", "Slettede elementer", "Slettede meldinger", "Slettet post", "Papperskorgen",
    "Borttaget", "Borttagna objekt", "Poistetut", "Poistetut kohteet", "Roskakori",
    "Eyddir hlutir",
    "Kosz", "Elementy usunięte", "Koš", "Odstraněná pošta", "Kôš", "Odstránená pošta", "Kuka",
    "Törölt elemek", "Törölt üzenetek", "Elemente șterse", "Elemente şterse", "Coș de gunoi",
    "Coş de gunoi",
    "Izbrisane stavke", "Smeće", "Izbrisano", "Izbrisani elementi",
    "Кошче", "Изтрити", "Изтрити елементи", "Корзина", "Удаленные", "Удалённые", "Кошик",
    "Видалені", "Διαγραμμένα", "Διαγραμμένα στοιχεία", "Κάδος απορριμμάτων",
    "Silinmiş Öğeler", "Çöp Kutusu", "Çöp", "Šiukšlinė", "Panaikinti elementai", "Atkritne",
    "Izdzēstie vienumi", "Prügikast", "Kustutatud üksused",
    "ごみ箱", "ゴミ箱", "削除済みアイテム", "削除済みメール", "휴지통", "지운 편지함", "삭제된 항목",
    "已删除", "已删除邮件", "已刪除", "已刪除郵件", "刪除的郵件", "垃圾桶",
    "Thùng rác", "Mục đã xóa", "Mục đã xoá", "Tong Sampah", "Item yang Dihapus", "Item Terhapus",
    "Item Dipadam", "ถังขยะ", "รายการที่ถูกลบ",
    "פריטים שנמחקו", "אשפה", "العناصر المحذوفة", "المهملات", "سلة المهملات", "موارد حذف شده",
    "سطل زباله", "हटाए गए आइटम", "ट्रैश",
  ],
  archive: [
    "Archives",
    "Archiv", "Archivio", "Archivi", "Archivo", "Arquivo", "Arquivo Morto", "Arxiu", "Archief",
    "Arkiv", "Arkisto",
    "Archiwum", "Archív", "Archívum", "Arhivă", "Arhiva", "Arhiv",
    "Архив", "Архів", "Αρχειοθέτηση",
    "Arşiv", "Arşivler", "Archyvas", "Arhīvs", "Arhiiv",
    "アーカイブ", "存档", "归档", "封存",
    "Lưu trữ", "Arsip", "Arkib", "เก็บถาวร",
    "ארכיון", "الأرشيف", "بایگانی",
  ],
  spam: [
    "Spam", "Bulk", "Junk E-mail", "Junk Email", "Bulk Mail",
    "Junk-E-Mail", "Spamverdacht",
    "Courrier indésirable", "Courriers indésirables", "Indésirables", "Pourriel",
    "Correo no deseado", "Correo basura", "Lixo Eletrônico",
    "Posta indesiderata", "Indesiderata", "Correu brossa", "Correu no desitjat",
    "Ongewenste e-mail",
    "Søppelpost", "Uønsket mail", "Uønsket e-mail", "Uønsket post", "Skräppost", "Roskaposti",
    "Ruslpóstur",
    "Wiadomości-śmieci", "Nevyžádaná pošta", "Nevyžiadaná pošta", "Levélszemét", "E-mail nedorit",
    "Neželjena pošta", "Neželjena e-pošta", "Neželena pošta", "Neželena e-pošta",
    "Нежелана поща", "Спам", "Нежелательная почта", "Небажана пошта",
    "Ανεπιθύμητη αλληλογραφία", "Ανεπιθύμητα",
    "Gereksiz E-posta", "Nepageidaujamas el. paštas", "Nevēlamais e-pasts", "Rämpspost",
    "迷惑メール", "정크 메일", "스팸메일함", "스팸 메일함", "스팸편지함", "垃圾邮件", "垃圾郵件",
    "Thư rác", "Email Rác", "Email Sampah", "E-mel Remeh", "อีเมลขยะ", "จดหมายขยะ",
    "דואר זבל", "البريد العشوائي", "البريد الإلكتروني العمومي", "هرزنامه", "जंक ईमेल", "स्पैम",
  ],
};

/** SPECIAL-USE flag of the mailbox that holds every message (Gmail's All Mail). */
const IMAP_ALL_MAIL_FLAG = "\\all";

/** LIST attributes of a name that exists in the hierarchy but cannot be opened. */
const IMAP_UNSELECTABLE_FLAGS = new Set(["\\noselect", "\\nonexistent"]);

/**
 * The part of an `ImapMailboxInfo` this module needs. Structural on purpose, so
 * the matcher stays free of any dependency on the client (and so a test can
 * hand it a two-field layout fixture).
 */
export interface MailboxListEntry {
  name: string;
  flags: string[];
  /**
   * Hierarchy delimiter LIST reported for this mailbox ("." or "/"). Optional
   * so the two-field fixtures still type-check; without it the namespaced tiers
   * below simply do not run for that entry.
   */
  delimiter?: string;
}

export interface ImapAliasMatchOptions {
  /**
   * True only when the mailbox will be READ (listed or searched), never when it
   * is the destination of a move, copy, archive or delete.
   *
   * It unlocks exactly one thing: `archive` falling back to the mailbox flagged
   * \\All when the account has no archive of its own, which is Gmail over IMAP.
   * "[Gmail]/All Mail" is where archived mail can be READ. It is not where
   * mail is archived TO: on Gmail, archiving means removing the message from
   * INBOX, and a COPY into All Mail does not do that. So a write never takes
   * this branch, and the default is false so a caller has to ask for it.
   */
  forRead?: boolean;
}

/** What {@link resolveImapAlias} found. */
export type ImapAliasMatch =
  | { kind: "matched"; name: string; how: ImapAliasMatchTier }
  /** Two or more mailboxes qualify equally. The caller must refuse, not pick. */
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "none" };

export type ImapAliasMatchTier =
  | "reserved"
  | "special_use"
  | "canonical_name"
  | "alternate_name"
  | "namespaced_canonical_name"
  | "namespaced_alternate_name"
  | "all_mail"
  | "localized_name"
  | "namespaced_localized_name";

/** Case- and normalization-insensitive key for comparing mailbox names. */
export function nameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/**
 * Match a canonical folder alias against an already-fetched IMAP mailbox list.
 * Pure (no I/O) so it can be shared by callers that own a connection. Tiers, in
 * order, first hit wins:
 *   1. "inbox" → always the reserved name "INBOX".
 *   2. SPECIAL-USE flag match (\\Archive, \\Trash, \\Sent, \\Drafts, \\Junk).
 *   3. Case-insensitive match against the canonical English name (e.g.
 *      a mailbox literally named "Archive").
 *   4. One of the role's {@link IMAP_ALIAS_LEGACY_ALTERNATE_NAMES} ("Sent Items",
 *      "Deleted Items", "Papierkorb").
 *   5. The canonical name under the personal namespace: "INBOX" + the mailbox's
 *      own hierarchy delimiter + the name ("INBOX.Sent", "INBOX/Trash"), which
 *      is how Courier and many Dovecot/cPanel hosts lay an account out.
 *   6. An alternate name under that same prefix ("INBOX.Sent Items").
 *   7. `archive` only, and only with `forRead`: the mailbox flagged \\All.
 *   8. Only when 1 to 7 found nothing: one of the localized names in
 *      {@link IMAP_ALIAS_ALTERNATE_NAMES} that is not a legacy name
 *      ("Éléments envoyés", "Отправленные").
 *   9. A localized name under the INBOX + delimiter prefix
 *      ("INBOX.Éléments envoyés").
 *
 * Tiers 4 to 6 use only {@link IMAP_ALIAS_LEGACY_ALTERNATE_NAMES}, so adding a
 * localized name can never change the answer for a layout tiers 1 to 7 already
 * resolve (or already refuse as ambiguous).
 *
 * Every name tier is a match on the WHOLE name (for 5 and 6, the whole name
 * after the "INBOX" + delimiter prefix), never on a path segment or a suffix,
 * and that is load-bearing rather than incidental: this matcher chooses the
 * destination of a soft DELETE. A user's own "Projects/Trash" or
 * "Archive/2019/Trash" must not become the account's trash can because its last
 * segment reads "Trash". Only a mailbox the SERVER flags \\Trash, or one whose
 * entire name is one of the names above, may win. Do not loosen this to
 * endsWith().
 *
 * AMBIGUITY. Tiers 2 and 3 take the first hit, as they always have. Tiers 4 to
 * 6 and 8 to 9 do not guess: when two mailboxes qualify at the same tier (an
 * account with both "Sent Items" and "Sent Messages" and no flag on either),
 * the answer is `ambiguous`, and the caller refuses with both names.
 *
 * A mailbox flagged \\Noselect or \\NonExistent is never an answer at any tier:
 * it is a name in the hierarchy, not something that can be opened or written.
 */
export function resolveImapAlias(
  mailboxes: MailboxListEntry[],
  alias: CanonicalFolderAlias,
  opts: ImapAliasMatchOptions = {},
): ImapAliasMatch {
  const canonicalToken = alias.aliases[0];
  if (canonicalToken === "inbox") return { kind: "matched", name: "INBOX", how: "reserved" };

  const selectable = mailboxes.filter((mb) =>
    !mb.flags.some((f) => IMAP_UNSELECTABLE_FLAGS.has(f.toLowerCase()))
  );

  // (2) SPECIAL-USE flag match.
  const wantFlag = IMAP_ALIAS_SPECIAL_USE[canonicalToken];
  if (wantFlag) {
    const bySpecialUse = selectable.find((mb) =>
      mb.flags.some((f) => f.toLowerCase() === wantFlag)
    );
    if (bySpecialUse) return { kind: "matched", name: bySpecialUse.name, how: "special_use" };
  }

  // (3) Case-insensitive match against the canonical English name.
  const wantName = alias.imap.toLowerCase();
  const byName = selectable.find((mb) => mb.name.toLowerCase() === wantName);
  if (byName) return { kind: "matched", name: byName.name, how: "canonical_name" };

  // (4)-(6) The alternate-name tiers, legacy names only. Each is unique-or-refuse.
  const canonical = new Set([nameKey(alias.imap)]);
  const legacy = new Set((IMAP_ALIAS_LEGACY_ALTERNATE_NAMES[canonicalToken] ?? []).map(nameKey));
  /** The part of a name after "INBOX" + its own delimiter, or null. */
  const underInbox = (mb: MailboxListEntry): string | null => {
    if (!mb.delimiter) return null;
    const prefix = `inbox${mb.delimiter}`;
    if (mb.name.length <= prefix.length) return null;
    return mb.name.slice(0, prefix.length).toLowerCase() === prefix
      ? mb.name.slice(prefix.length)
      : null;
  };
  const uniqueOrRefuse = (
    tiers: [ImapAliasMatchTier, (mb: MailboxListEntry) => boolean][],
  ): ImapAliasMatch | null => {
    for (const [how, qualifies] of tiers) {
      const hits = selectable.filter(qualifies);
      if (hits.length === 1) return { kind: "matched", name: hits[0].name, how };
      if (hits.length > 1) return { kind: "ambiguous", candidates: hits.map((mb) => mb.name) };
    }
    return null;
  };
  const legacyAnswer = uniqueOrRefuse([
    ["alternate_name", (mb) => legacy.has(nameKey(mb.name))],
    ["namespaced_canonical_name", (mb) => {
      const rest = underInbox(mb);
      return rest !== null && canonical.has(nameKey(rest));
    }],
    ["namespaced_alternate_name", (mb) => {
      const rest = underInbox(mb);
      return rest !== null && legacy.has(nameKey(rest));
    }],
  ]);
  if (legacyAnswer) return legacyAnswer;

  // (7) Reads only: the archive role on a mailbox with no archive is All Mail.
  if (canonicalToken === "archive" && opts.forRead) {
    const allMail = selectable.filter((mb) =>
      mb.flags.some((f) => f.toLowerCase() === IMAP_ALL_MAIL_FLAG)
    );
    if (allMail.length === 1) return { kind: "matched", name: allMail[0].name, how: "all_mail" };
  }

  // (8)-(9) Only when everything above found nothing: the localized names, as a
  // whole name and then under INBOX + delimiter. Same unique-or-refuse rule; two
  // localized names in one tier are ambiguous, never ranked.
  const localized = new Set(
    (IMAP_ALIAS_ALTERNATE_NAMES[canonicalToken] ?? []).map(nameKey).filter((k) => !legacy.has(k)),
  );
  const localizedAnswer = uniqueOrRefuse([
    ["localized_name", (mb) => localized.has(nameKey(mb.name))],
    ["namespaced_localized_name", (mb) => {
      const rest = underInbox(mb);
      return rest !== null && localized.has(nameKey(rest));
    }],
  ]);
  if (localizedAnswer) return localizedAnswer;

  return { kind: "none" };
}

/**
 * {@link resolveImapAlias}, reduced to the mailbox name or null.
 *
 * For the callers that pick a DESTINATION on a connection they own (soft
 * delete, archive, the drafts mailbox) and that create the canonical mailbox
 * when nothing matches. An ambiguous layout answers null here, exactly like no
 * match: those callers then create or fall back as they did before the new
 * tiers existed, rather than writing into one of two equal candidates. It never
 * passes `forRead`, so it can never answer with All Mail.
 */
export function matchImapAliasMailbox(
  mailboxes: MailboxListEntry[],
  alias: CanonicalFolderAlias,
): string | null {
  const match = resolveImapAlias(mailboxes, alias);
  return match.kind === "matched" ? match.name : null;
}

/**
 * The mailbox to SELECT for a folder name that ALREADY CAME FROM THE SERVER:
 * the folder half of an id decoded by `decodeImapId`, or a name resolveFolderId
 * has already matched against the account's real layout.
 *
 * It returns the name verbatim. The whole point is that it does NOT re-run the
 * alias table over a name the server gave us — see this file's header for why
 * "Spam" must stay "Spam" and why a hand-crafted "spam:5" is allowed to fail
 * instead of being quietly aimed at some other mailbox's UID 5.
 *
 * It exists as a named function rather than as nothing at all so the rule has
 * one place to be read, one place to be tested, and one token
 * ("imapMailboxForServerFolder") that a source scan can pin at every call site
 * — the previous shape of this code, `selectMailbox(imapFolderName(folder))`,
 * looked deliberate at all thirteen of them.
 */
export function imapMailboxForServerFolder(folder: string): string {
  return folder;
}
