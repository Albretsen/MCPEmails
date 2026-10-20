import { assert, assertEquals } from "jsr:@std/assert@1";
import type { MailboxListEntry } from "./imap-folder-target.ts";
import { LEGACY_SENT_FOLDER_CANDIDATES, SENT_COPY_NOT_SAVED_NOTE, sentCopyCandidates } from "./sent-copy.ts";

function listed(name: string, ...flags: string[]): MailboxListEntry {
  return { name, delimiter: "/", flags };
}

const LEGACY = [...LEGACY_SENT_FOLDER_CANDIDATES];

Deno.test("sent copy: QQ's 已发送 is tried first on a layout without SPECIAL-USE", () => {
  const qq = [listed("INBOX"), listed("已发送"), listed("草稿箱"), listed("已删除"), listed("垃圾邮件")];
  assertEquals(sentCopyCandidates(qq), ["已发送", ...LEGACY]);
});

Deno.test("sent copy: the \\Sent flag wins over every name", () => {
  const layout = [listed("Sent"), listed("Gesendete Objekte", "\\Sent")];
  assertEquals(sentCopyCandidates(layout)[0], "Gesendete Objekte");
});

Deno.test("sent copy: a resolved legacy name is not tried twice", () => {
  const layout = [listed("INBOX"), listed("Sent Messages")];
  assertEquals(sentCopyCandidates(layout), ["Sent Messages", "Sent", "Sent Items", "INBOX.Sent"]);
});

Deno.test("sent copy: an unlistable or unmatched layout keeps the legacy order", () => {
  assertEquals(sentCopyCandidates([]), LEGACY);
  assertEquals(sentCopyCandidates([listed("INBOX"), listed("Receipts")]), LEGACY);
});

Deno.test("sent copy: an ambiguous layout falls back to the legacy order rather than guessing", () => {
  const layout = [listed("Sent Items"), listed("Sent Messages")];
  assertEquals(sentCopyCandidates(layout), LEGACY);
});

Deno.test("sent copy: the note says the message went out and must not be resent", () => {
  assert(SENT_COPY_NOT_SAVED_NOTE.includes("was sent"));
  assert(SENT_COPY_NOT_SAVED_NOTE.includes("Do not resend"));
});
