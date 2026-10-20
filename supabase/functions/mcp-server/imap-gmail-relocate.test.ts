import { assertEquals } from "jsr:@std/assert@1";
import { type GmailMailboxLike, mayBeGmailAllMail, relocateFromGmailAllMail } from "./imap-gmail-relocate.ts";

const GMAIL_BOXES: GmailMailboxLike[] = [
  { name: "INBOX", flags: [] },
  { name: "[Gmail]/All Mail", flags: ["\\HasNoChildren", "\\All"] },
  { name: "[Gmail]/Sent Mail", flags: ["\\HasNoChildren", "\\Sent"] },
  { name: "[Gmail]/Trash", flags: ["\\HasNoChildren", "\\Trash"] },
  { name: "[Gmail]/Spam", flags: ["\\HasNoChildren", "\\Junk"] },
  { name: "Archive", flags: ["\\HasNoChildren"] },
];

function fakeClient(gmail: boolean) {
  const calls: string[] = [];
  let lists = 0;
  return {
    calls,
    lists: () => lists,
    mailboxes: () => {
      lists++;
      return Promise.resolve(GMAIL_BOXES);
    },
    client: {
      hasCapability: (name: string) => gmail && name === "X-GM-EXT-1",
      uidCopy: (uids: number[], target: string) => {
        calls.push(`COPY ${uids.join(",")} ${target}`);
        return Promise.resolve(new Map<number, number>());
      },
      uidStoreGmailLabels: (uids: number[], labels: string[], mode: "add" | "remove") => {
        calls.push(`STORE ${uids.join(",")} ${mode === "add" ? "+" : "-"}${labels.join(" ")}`);
        return Promise.resolve();
      },
    },
  };
}

Deno.test("Gmail All Mail source: archive takes \\Inbox off, a label move copies then takes \\Inbox off, INBOX only copies", async () => {
  const f = fakeClient(true);
  assertEquals(await relocateFromGmailAllMail(f.client, "[Gmail]/All Mail", [5, 7], "Archive", f.mailboxes), true);
  assertEquals(f.calls, ["COPY 5,7 Archive", "STORE 5,7 -\\Inbox"]);

  f.calls.length = 0;
  assertEquals(await relocateFromGmailAllMail(f.client, "[Gmail]/All Mail", [5], "[Gmail]/All Mail", f.mailboxes), true);
  assertEquals(f.calls, ["STORE 5 -\\Inbox"], "into All Mail itself: an archive, no COPY");

  f.calls.length = 0;
  assertEquals(await relocateFromGmailAllMail(f.client, "[Gmail]/All Mail", [5], "INBOX", f.mailboxes), true);
  assertEquals(f.calls, ["COPY 5 INBOX"], "back to the Inbox: \\Inbox added, nothing removed");
});

Deno.test("Gmail All Mail source: Trash and Spam are left to the ordinary UID MOVE", async () => {
  const f = fakeClient(true);
  for (const dest of ["[Gmail]/Trash", "[Gmail]/Spam"]) {
    assertEquals(await relocateFromGmailAllMail(f.client, "[Gmail]/All Mail", [5], dest, f.mailboxes), false, dest);
  }
  assertEquals(f.calls, []);
});

Deno.test("not All Mail, or not Gmail: nothing is sent, and no LIST unless the folder is under [Gmail]/", async () => {
  const gmail = fakeClient(true);
  assertEquals(await relocateFromGmailAllMail(gmail.client, "INBOX", [5], "Archive", gmail.mailboxes), false);
  assertEquals(await relocateFromGmailAllMail(gmail.client, "Projects", [5], "Archive", gmail.mailboxes), false);
  assertEquals(gmail.lists(), 0, "INBOX and user labels never cost a LIST");
  assertEquals(await relocateFromGmailAllMail(gmail.client, "[Gmail]/Sent Mail", [5], "Archive", gmail.mailboxes), false);
  assertEquals(gmail.lists(), 1, "a [Gmail]/ folder is checked against the listing");
  assertEquals(gmail.calls, []);

  const plain = fakeClient(false);
  assertEquals(await relocateFromGmailAllMail(plain.client, "[Gmail]/All Mail", [5], "Archive", plain.mailboxes), false);
  assertEquals([plain.calls, plain.lists()], [[], 0], "a server without X-GM-EXT-1 is never asked anything");
  assertEquals(mayBeGmailAllMail(plain.client, "[Gmail]/All Mail"), false);
  assertEquals(mayBeGmailAllMail(gmail.client, "[Google Mail]/Alle Nachrichten"), true);
});
