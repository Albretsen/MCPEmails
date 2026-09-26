// ---------------------------------------------------------------------------
// COPYUID: a moved IMAP message's new id.
//
// The reviewer flow this guards: "move the DevWeekly newsletter to Archive, then
// move it back to my inbox". An IMAP id is "<folder>:<uid>" and the uid changes
// on a move, so the move result has to say what the new id is or the second
// move fails with message_not_found. See imap-copyuid.ts.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  expandUidSet,
  newMessageIdsFor,
  parseCopyUid,
  succeededBulkRow,
  unknownNewIdNote,
} from "./imap-copyuid.ts";
import { ImapClient } from "./imap-client.ts";

const encode = (folder: string, uid: number) => `${folder}:${uid}`;

// -- Parsing -------------------------------------------------------------------

Deno.test("expandUidSet keeps the written order and expands ranges", () => {
  assertEquals(expandUidSet("304,319:320"), [304, 319, 320]);
  assertEquals(expandUidSet("3956:3958"), [3956, 3957, 3958]);
  assertEquals(expandUidSet("7"), [7]);
  assertEquals(expandUidSet("4:2"), [2, 3, 4], "4:2 means 2:4 (RFC 3501)");
});

Deno.test("expandUidSet refuses malformed sets, '*', zero and absurd ranges", () => {
  assertEquals(expandUidSet("*"), null);
  assertEquals(expandUidSet("1:*"), null);
  assertEquals(expandUidSet("0"), null);
  assertEquals(expandUidSet(""), null);
  assertEquals(expandUidSet("1,,2"), null);
  assertEquals(expandUidSet("1:4294967295"), null, "must not allocate billions");
});

Deno.test("RFC 4315 example: COPYUID 38505 304,319:320 3956:3958 maps in order", () => {
  const m = parseCopyUid(["[COPYUID 38505 304,319:320 3956:3958] Done"]);
  assertEquals([...m], [[304, 3956], [319, 3957], [320, 3958]]);
});

Deno.test("COPYUID on an untagged OK line (RFC 6851 MOVE) is found", () => {
  const m = parseCopyUid([
    "Move completed",
    "* OK [COPYUID 432432 42:43 10:11] Moved UIDs.",
    "* 1 EXPUNGE",
    "* 1 EXPUNGE",
  ]);
  assertEquals([...m], [[42, 10], [43, 11]]);
});

Deno.test("COPYUID is case-insensitive and single-uid", () => {
  assertEquals([...parseCopyUid(["[copyuid 1 84450 17] ok"])], [[84450, 17]]);
});

Deno.test("no COPYUID, or mismatched set lengths, yields an empty map", () => {
  assertEquals(parseCopyUid(["Move completed"]).size, 0);
  assertEquals(parseCopyUid(["* 3 EXPUNGE"]).size, 0);
  assertEquals(
    parseCopyUid(["[COPYUID 1 1:3 10:11] off by one"]).size,
    0,
    "pairing unequal sets would hand out ids for the wrong messages",
  );
  assertEquals(parseCopyUid(["[COPYUID 1 * 5]"]).size, 0);
});

Deno.test("requested restricts the map to the uids this command moved", () => {
  const m = parseCopyUid(["[COPYUID 9 5:7 50:52]"], [5, 7]);
  assertEquals([...m], [[5, 50], [7, 52]]);
});

// -- Result shape --------------------------------------------------------------

Deno.test("newMessageIdsFor encodes the destination id the way email_read does", () => {
  const items = [
    { uid: 304, messageId: "INBOX:304" },
    { uid: 319, messageId: "INBOX:319" },
    { uid: 999, messageId: "INBOX:999" },
  ];
  const mapping = new Map([[304, 3956], [319, 3957]]);
  assertEquals(newMessageIdsFor(items, mapping, "Archive", encode), {
    "INBOX:304": "Archive:3956",
    "INBOX:319": "Archive:3957",
  });
});

Deno.test("newMessageIdsFor keeps a destination name that itself contains ':'", () => {
  // decodeImapId splits on the LAST colon, so this round-trips.
  const ids = newMessageIdsFor(
    [{ uid: 1, messageId: "INBOX:1" }],
    new Map([[1, 2]]),
    "Work:2026",
    encode,
  );
  assertEquals(ids["INBOX:1"], "Work:2026:2");
});

Deno.test("succeededBulkRow adds new_message_id only when reported", () => {
  const ids = { "INBOX:1": "Archive:10" };
  assertEquals(succeededBulkRow("INBOX:1", ids), {
    message_id: "INBOX:1",
    success: true,
    new_message_id: "Archive:10",
  });
  assertEquals(succeededBulkRow("INBOX:2", ids), { message_id: "INBOX:2", success: true });
  assertEquals(
    succeededBulkRow("gmail-abc", undefined),
    { message_id: "gmail-abc", success: true },
    "Gmail/Outlook/non-UIDPLUS rows are byte-for-byte what they were",
  );
  assert(!("new_message_id" in succeededBulkRow("x", {})));
  assertEquals(
    succeededBulkRow("toString", {}),
    { message_id: "toString", success: true },
    "own keys only",
  );
});

Deno.test("unknownNewIdNote names the destination and the next step", () => {
  const one = unknownNewIdNote("Archive");
  assert(one.includes('"Archive"'));
  assert(one.includes("email_read"));
  assert(one.includes("the moved message's new id"));
  assert(unknownNewIdNote("Archive", 3).includes("the moved messages' new ids"));
});

// -- On the wire ---------------------------------------------------------------

const LATIN1 = new TextDecoder("latin1");
const UTF8 = new TextEncoder();

/** Minimal scripted socket: answers each client write from `onWrite`. */
class FakeImapConn {
  readonly chunks: string[] = [];
  #inbound: number[] = [];
  #wake: (() => void) | null = null;
  readonly #onWrite: (chunk: string, conn: FakeImapConn) => void;
  constructor(onWrite: (chunk: string, conn: FakeImapConn) => void) {
    this.#onWrite = onWrite;
  }
  write(p: Uint8Array): Promise<number> {
    const chunk = LATIN1.decode(p.slice());
    this.chunks.push(chunk);
    this.#onWrite(chunk, this);
    return Promise.resolve(p.length);
  }
  send(text: string): void {
    for (const b of UTF8.encode(text)) this.#inbound.push(b);
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }
  async read(p: Uint8Array): Promise<number | null> {
    while (this.#inbound.length === 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#wake = null;
          reject(new Error("fake IMAP server: script never answered"));
        }, 2000);
        this.#wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    const n = Math.min(p.length, this.#inbound.length);
    for (let i = 0; i < n; i++) p[i] = this.#inbound[i];
    this.#inbound.splice(0, n);
    return n;
  }
  close(): void {}
}

function clientOn(conn: FakeImapConn): ImapClient {
  const ctor = ImapClient as unknown as { new (conn: unknown): ImapClient };
  return new ctor(conn);
}

Deno.test("uidMove returns the COPYUID mapping from the untagged OK (RFC 6851)", async () => {
  const conn = new FakeImapConn((chunk, c) => {
    if (chunk.startsWith("A00001 UID MOVE 84450 ")) {
      c.send(
        "* OK [COPYUID 1700000000 84450 17] Moved UIDs.\r\n* 3 EXPUNGE\r\nA00001 OK Move completed\r\n",
      );
    }
  });
  const moved = await clientOn(conn).uidMove([84450], "Archive");
  assertEquals([...moved], [[84450, 17]]);
});

Deno.test("uidMove reads COPYUID off the tagged OK too", async () => {
  const conn = new FakeImapConn((chunk, c) => {
    if (chunk.startsWith("A00001 UID MOVE")) {
      c.send("* 1 EXPUNGE\r\n* 1 EXPUNGE\r\nA00001 OK [COPYUID 5 3,9 40:41] Done\r\n");
    }
  });
  const moved = await clientOn(conn).uidMove([9, 3], "Archive");
  assertEquals(moved.get(3), 40);
  assertEquals(moved.get(9), 41);
});

Deno.test("uidMove without UIDPLUS resolves to an empty map, not an error", async () => {
  const conn = new FakeImapConn((chunk, c) => {
    if (chunk.startsWith("A00001 UID MOVE")) c.send("* 1 EXPUNGE\r\nA00001 OK Done\r\n");
  });
  const moved = await clientOn(conn).uidMove([5], "Archive");
  assertEquals(moved.size, 0);
});

Deno.test("uidMove COPY+EXPUNGE fallback takes COPYUID from the UID COPY", async () => {
  const conn = new FakeImapConn((chunk, c) => {
    if (chunk.startsWith("A00001 UID MOVE")) c.send("A00001 BAD Unknown command\r\n");
    else if (chunk.startsWith("A00002 UID COPY 7 ")) {
      c.send("A00002 OK [COPYUID 77 7 1234] Copy completed\r\n");
    } else if (chunk.startsWith("A00003 UID STORE 7 +FLAGS")) {
      c.send("* 1 FETCH (FLAGS (\\Deleted))\r\nA00003 OK Store completed\r\n");
    } else if (chunk.startsWith("A00004 UID EXPUNGE 7")) {
      c.send("* 1 EXPUNGE\r\nA00004 OK Expunge completed\r\n");
    }
  });
  const moved = await clientOn(conn).uidMove([7], "Archive");
  assertEquals([...moved], [[7, 1234]]);
  assert(conn.chunks.some((c) => c.startsWith("A00004 UID EXPUNGE 7")), "fallback still expunges");
});

Deno.test("move then move back: the returned id is what the second move needs", async () => {
  // Archive: INBOX:84450 → Archive:17. Back: Archive:17 → INBOX:84451.
  const conn = new FakeImapConn((chunk, c) => {
    if (chunk.startsWith("A00001 UID MOVE 84450 ")) {
      c.send("* OK [COPYUID 1 84450 17] Moved\r\nA00001 OK Done\r\n");
    } else if (chunk.startsWith("A00002 UID MOVE 17 ")) {
      c.send("* OK [COPYUID 2 17 84451] Moved\r\nA00002 OK Done\r\n");
    }
  });
  const client = clientOn(conn);
  const there = newMessageIdsFor(
    [{ uid: 84450, messageId: "INBOX:84450" }],
    await client.uidMove([84450], "Archive"),
    "Archive",
    encode,
  )["INBOX:84450"];
  assertEquals(there, "Archive:17");
  const uidThere = Number(there.slice(there.lastIndexOf(":") + 1));
  const back = newMessageIdsFor(
    [{ uid: uidThere, messageId: there }],
    await client.uidMove([uidThere], "INBOX"),
    "INBOX",
    encode,
  )[there];
  assertEquals(back, "INBOX:84451");
});
