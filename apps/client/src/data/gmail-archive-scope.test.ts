import { beforeEach, describe, expect, it } from "vitest";
import type { MessageRow } from "../api/types";
import { gmailInboxCopies, type ListData } from "./cache";
import { keys, listMeta } from "./keys";
import { queryClient } from "./query-client";

/* Gmail over IMAP shows one message under several ids: "INBOX:11" in the
 * Inbox list, "[Gmail]/All Mail:101" in a thread opened from Sent. Archiving
 * it by the All Mail id must take the Inbox row off the screen too. */

const row = (inbox_id: string, id: string, folder: string, thread_key: string, mid: string): MessageRow => ({
  id,
  key: `${inbox_id}:${id}`,
  inbox_id,
  from: { name: "", email: "maya@x.example" },
  to: [],
  subject: "Roadmap",
  date: "2026-10-03T10:00:00Z",
  preview: "",
  is_read: true,
  is_starred: false,
  has_attachments: false,
  folder,
  folder_role: folder === "INBOX" ? "inbox" : null,
  thread_id: id,
  thread_key,
  message_id_header: mid,
});

const listOf = (rows: MessageRow[]): ListData =>
  ({ pages: [{ rows, next_cursor: null, total: rows.length }], pageParams: [null] }) as unknown as ListData;

beforeEach(() => queryClient.clear());

describe("gmailInboxCopies", () => {
  it("finds the Inbox row of the same Gmail message, in the same mailbox only", () => {
    queryClient.setQueryData(
      keys.messages(listMeta("all", { role: "inbox" })),
      listOf([
        row("a", "INBOX:11", "INBOX", "g:77", "g1@x"),
        row("a", "INBOX:14", "INBOX", "g:88", "other@x"),
        row("b", "INBOX:3", "INBOX", "g:5", "g1@x"),
      ]),
    );
    const archived = row("a", "[Gmail]/All Mail:101", "INBOX", "g:77", "g1@x");
    expect(gmailInboxCopies([archived])).toEqual(["a:INBOX:11"]);
  });

  it("matches nothing for a header-keyed (non-Gmail) conversation: there two ids are two messages", () => {
    queryClient.setQueryData(
      keys.messages(listMeta("all", { role: "inbox" })),
      listOf([row("a", "INBOX:1", "INBOX", "m:root@x", "root@x")]),
    );
    expect(gmailInboxCopies([row("a", "Archive:9", "Archive", "m:root@x", "root@x")])).toEqual([]);
  });
});
