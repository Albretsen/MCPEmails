// ---------------------------------------------------------------------------
// UID SEARCH wire-format tests: charset on the way out, response parsing on
// the way back.
//
// Background: until 2026-09-01 this client interpolated the SEARCH criteria
// straight into the command line and let `write` encode it as UTF-8, so a
// search for a Norwegian, French, CJK or emoji term put raw multi-byte octets
// into a command line that had declared no charset. Yahoo answered
// "[BADCHARSET] UID SEARCH Unsupported text encoding" in production and
// ex4.mail.ovh.net answered "Command Error. 11". RFC 3501 6.4.4 wants
// "SEARCH CHARSET UTF-8 <key> {n}CRLF<octets>" instead.
//
// Two properties matter more than the fix itself, and both are asserted here
// on the actual bytes the client puts on the socket rather than on any
// intermediate string:
//
//   1. THE ASCII PATH DID NOT MOVE. It is essentially all live traffic and it
//      still has to be one write of exactly the bytes it always wrote, with no
//      CHARSET clause and no continuation round trip.
//   2. THE LITERAL COUNTS OCTETS, NOT CHARACTERS. "Bjorn" spelled with the
//      Norwegian o is 5 characters and 6 octets; an emoji is 1 character, 2
//      UTF-16 units and 4 octets. A literal that promises the wrong number
//      leaves the tail of the operand in the server's parser as the start of
//      the next command, which desynchronises the connection for good.
//
// The fake below is a socket, not a client: it records every write verbatim
// and answers from a script, so the tests read as a protocol transcript.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import {
  foldSearchCriteriaToAscii,
  hasNonAscii,
  ImapClient,
  isCharsetRejection,
  splitSearchLiterals,
} from "./imap-client.ts";

const LATIN1 = new TextDecoder("latin1");
const UTF8 = new TextEncoder();

/**
 * A scripted IMAP socket. `onWrite` sees each chunk exactly as the client wrote
 * it (latin1-decoded, so one byte is one character and assertions stay
 * byte-faithful) and queues whatever the server should say next.
 *
 * `read` rejects after two seconds rather than parking forever: a test whose
 * script forgot a response should fail with that sentence, not hang the suite.
 */
class FakeImapConn {
  readonly writes: Uint8Array[] = [];
  #inbound: number[] = [];
  #wake: (() => void) | null = null;
  #closed = false;
  readonly #onWrite: (chunk: string, conn: FakeImapConn) => void;

  constructor(onWrite: (chunk: string, conn: FakeImapConn) => void) {
    this.#onWrite = onWrite;
  }

  /** Each write() call the client made, latin1-decoded. */
  get chunks(): string[] {
    return this.writes.map((w) => LATIN1.decode(w));
  }

  write(p: Uint8Array): Promise<number> {
    const copy = p.slice();
    this.writes.push(copy);
    this.#onWrite(LATIN1.decode(copy), this);
    return Promise.resolve(p.length);
  }

  /** Queue server output, encoded the way a real server would send it. */
  send(text: string): void {
    for (const b of UTF8.encode(text)) this.#inbound.push(b);
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  async read(p: Uint8Array): Promise<number | null> {
    while (this.#inbound.length === 0) {
      if (this.#closed) return null;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => {
            this.#wake = null;
            reject(
              new Error(
                "fake IMAP server: the client is waiting for data the script never sent",
              ),
            );
          },
          2000,
        );
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

  close(): void {
    this.#closed = true;
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }
}

/**
 * Build a client straight onto a fake socket.
 *
 * `ImapClient`'s constructor is private because production code must go through
 * `connect()` (greeting, SSRF-guarded dial, SASL). None of that is under test
 * here and `connect()` cannot reach a fake socket anyway: the host guard refuses
 * loopback by design. Casting the constructor is the seam that keeps the
 * production API unwidened.
 */
function clientOn(conn: FakeImapConn): ImapClient {
  const ctor = ImapClient as unknown as { new (conn: unknown): ImapClient };
  return new ctor(conn);
}

/** UTF-8 octet count, spelled out so the expectations read as bytes. */
function octets(s: string): number {
  return UTF8.encode(s).length;
}

// -- Reading the SEARCH response back -----------------------------------------
//
// Separate defect, same command. The UID list used to be read off the FIRST
// `* SEARCH` line only. Nothing in RFC 3501 says a server has to answer on one
// line and some split large result sets, so every continuation line was being
// dropped: no error, just a short UID list, an under-reported match total and a
// silently truncated candidate pool, growing worse the bigger the mailbox.

Deno.test("REGRESSION: a SEARCH split across three untagged lines returns every UID, not just the first line's", async () => {
  const conn = new FakeImapConn((chunk, c) => {
    if (chunk.startsWith("A00001 UID SEARCH")) {
      c.send(
        "* SEARCH 1 2 3\r\n* SEARCH 4 5\r\n* SEARCH 6\r\nA00001 OK SEARCH completed\r\n",
      );
    }
  });

  const uids = await clientOn(conn).uidSearch("ALL");

  assertEquals(
    uids,
    [1, 2, 3, 4, 5, 6],
    "taking only the first line silently truncates the result set",
  );
});

Deno.test("REGRESSION: a split SEARCH is accumulated on the CHARSET path too", async () => {
  const conn = new FakeImapConn((chunk, c) => {
    if (chunk.startsWith("A00001 UID SEARCH")) c.send("+ go\r\n");
    else if (chunk === "\r\n") {
      c.send("* SEARCH 11 12\r\n* SEARCH 13\r\nA00001 OK SEARCH completed\r\n");
    }
  });

  assertEquals(await clientOn(conn).uidSearch('SUBJECT "Bjørn"'), [11, 12, 13]);
});

Deno.test("untagged lines that are not SEARCH results are ignored", async () => {
  const conn = new FakeImapConn((chunk, c) => {
    if (chunk.startsWith("A00001 UID SEARCH")) {
      c.send(
        "* 40 EXISTS\r\n* SEARCH 7\r\n* SEARCHFOO 99\r\n* OK [UIDNEXT 41]\r\n" +
          "* SEARCH 8\r\nA00001 OK SEARCH completed\r\n",
      );
    }
  });

  assertEquals(await clientOn(conn).uidSearch("ALL"), [7, 8]);
});

Deno.test("an empty SEARCH line contributes no UIDs", async () => {
  const conn = new FakeImapConn((chunk, c) => {
    if (chunk.startsWith("A00001 UID SEARCH")) {
      c.send("* SEARCH\r\n* SEARCH 5\r\nA00001 OK SEARCH completed\r\n");
    }
  });

  assertEquals(await clientOn(conn).uidSearch("ALL"), [5]);
});

// -- The ASCII path must not have moved ---------------------------------------

Deno.test("a pure-ASCII search still writes one command line, byte for byte", async () => {
  const conn = new FakeImapConn((chunk, c) => {
    if (chunk.startsWith("A00001 UID SEARCH")) {
      c.send("* SEARCH 1 2 3\r\nA00001 OK SEARCH completed\r\n");
    }
  });

  const uids = await clientOn(conn).uidSearch('SUBJECT "invoice" UNSEEN');

  assertEquals(uids, [1, 2, 3]);
  assertEquals(
    conn.chunks,
    ['A00001 UID SEARCH SUBJECT "invoice" UNSEEN\r\n'],
    "the ASCII path must stay a single write of exactly the old bytes",
  );
});

Deno.test("a pure-ASCII search names no charset and takes no continuation", async () => {
  const conn = new FakeImapConn((chunk, c) => {
    if (chunk.startsWith("A00001 UID SEARCH")) {
      c.send("* SEARCH\r\nA00001 OK SEARCH completed\r\n");
    }
  });

  const uids = await clientOn(conn).uidSearch("ALL");

  assertEquals(uids, []);
  assertEquals(conn.chunks, ["A00001 UID SEARCH ALL\r\n"]);
  assert(!conn.chunks[0].includes("CHARSET"), "ASCII criteria must not grow a CHARSET clause");
});

Deno.test("a failing ASCII search reports the server text unchanged", async () => {
  const conn = new FakeImapConn((chunk, c) => {
    if (chunk.startsWith("A00001 UID SEARCH")) {
      c.send("A00001 NO Mailbox is not selected\r\n");
    }
  });

  const err = await assertRejects(() => clientOn(conn).uidSearch("ALL"), Error);
  assertStringIncludes(err.message, "UID SEARCH failed: Mailbox is not selected");
});

// -- The non-ASCII path -------------------------------------------------------

Deno.test("a non-ASCII search sends CHARSET UTF-8 and a literal counted in octets", async () => {
  const term = "Bjørn";
  assertEquals(term.length, 5, "five characters");
  assertEquals(octets(term), 6, "six octets: the o-slash is two");

  const conn = new FakeImapConn((chunk, c) => {
    if (chunk.startsWith("A00001 UID SEARCH")) c.send("+ Ready for literal\r\n");
    else if (chunk === "\r\n") c.send("* SEARCH 41 42\r\nA00001 OK SEARCH completed\r\n");
  });

  const uids = await clientOn(conn).uidSearch(`SUBJECT "${term}"`);

  assertEquals(uids, [41, 42]);
  assertEquals(conn.chunks.length, 3, "command line, literal octets, then the trailing CRLF");
  assertEquals(conn.chunks[0], "A00001 UID SEARCH CHARSET UTF-8 SUBJECT {6}\r\n");
  assertEquals(
    conn.writes[1].length,
    6,
    "the literal must carry the six octets it promised, not five characters",
  );
  assertEquals(conn.chunks[2], "\r\n");
  assertEquals(new TextDecoder().decode(conn.writes[1]), term);
});

Deno.test("an astral character is counted as four octets, not two UTF-16 units", async () => {
  const term = "\u{1F389}";
  assertEquals(term.length, 2, "one emoji, two UTF-16 code units");
  assertEquals(octets(term), 4);

  const conn = new FakeImapConn((chunk, c) => {
    if (chunk.startsWith("A00001 UID SEARCH")) c.send("+\r\n");
    else if (chunk === "\r\n") c.send("* SEARCH 9\r\nA00001 OK SEARCH completed\r\n");
  });

  const uids = await clientOn(conn).uidSearch(`TEXT "${term}"`);

  assertEquals(uids, [9]);
  assertEquals(conn.chunks[0], "A00001 UID SEARCH CHARSET UTF-8 TEXT {4}\r\n");
  assertEquals(conn.writes[1].length, 4);
});

Deno.test("every non-ASCII operand gets its own literal and continuation", async () => {
  const conn = new FakeImapConn((chunk, c) => {
    if (chunk.endsWith("}\r\n")) c.send("+ go\r\n");
    else if (chunk === " UNSEEN\r\n") c.send("* SEARCH 5\r\nA00001 OK SEARCH completed\r\n");
  });

  const uids = await clientOn(conn).uidSearch(
    'FROM "Bjørn" SUBJECT "møte" UNSEEN',
  );

  assertEquals(uids, [5]);
  assertEquals(conn.chunks, [
    "A00001 UID SEARCH CHARSET UTF-8 FROM {6}\r\n",
    "BjÃ¸rn",
    " SUBJECT {5}\r\n",
    "mÃ¸te",
    " UNSEEN\r\n",
  ]);
});

Deno.test("the contact-scan OR expression survives with one literal per operand", async () => {
  const conn = new FakeImapConn((chunk, c) => {
    if (chunk.endsWith("}\r\n")) c.send("+ go\r\n");
    else if (chunk === "\r\n") c.send("* SEARCH 2\r\nA00001 OK SEARCH completed\r\n");
  });

  const uids = await clientOn(conn).uidSearch(
    'OR OR FROM "Bjørn" TO "Bjørn" CC "Bjørn"',
  );

  assertEquals(uids, [2]);
  assertEquals(conn.chunks[0], "A00001 UID SEARCH CHARSET UTF-8 OR OR FROM {6}\r\n");
  assertEquals(conn.chunks[2], " TO {6}\r\n");
  assertEquals(conn.chunks[4], " CC {6}\r\n");
});

Deno.test("unsolicited untagged data before the continuation is not a refusal", async () => {
  const conn = new FakeImapConn((chunk, c) => {
    if (chunk.startsWith("A00001 UID SEARCH")) {
      // A server is free to volunteer mailbox news at any point in a session.
      c.send("* 12 EXISTS\r\n* 1 RECENT\r\n+ Ready for literal\r\n");
    } else if (chunk === "\r\n") {
      c.send("* SEARCH 12\r\nA00001 OK SEARCH completed\r\n");
    }
  });

  const uids = await clientOn(conn).uidSearch('SUBJECT "café"');

  assertEquals(uids, [12]);
  assertEquals(conn.chunks.length, 3);
});

// -- The charset refusal and its single folded retry ---------------------------

Deno.test("a BADCHARSET refusal at the continuation triggers exactly one folded retry", async () => {
  const conn = new FakeImapConn((chunk, c) => {
    if (chunk.startsWith("A00001 UID SEARCH")) {
      c.send("A00001 NO [BADCHARSET (US-ASCII)] Unsupported text encoding\r\n");
    } else if (chunk.startsWith("A00002 UID SEARCH")) {
      c.send("* SEARCH 3\r\nA00002 OK SEARCH completed\r\n");
    }
  });

  const uids = await clientOn(conn).uidSearch('SUBJECT "Bjørn"');

  assertEquals(uids, [3]);
  assertEquals(
    conn.chunks,
    [
      "A00001 UID SEARCH CHARSET UTF-8 SUBJECT {6}\r\n",
      'A00002 UID SEARCH SUBJECT "Bjorn"\r\n',
    ],
    "the octets must not be sent after a refusal, and the retry happens exactly once",
  );
});

Deno.test("a BADCHARSET refusal in the tagged completion also folds once", async () => {
  const conn = new FakeImapConn((chunk, c) => {
    if (chunk.startsWith("A00001 UID SEARCH")) c.send("+ Ready for literal\r\n");
    else if (chunk === "\r\n") c.send("A00001 NO [BADCHARSET] Unsupported text encoding\r\n");
    else if (chunk.startsWith("A00002 UID SEARCH")) {
      c.send("* SEARCH 8\r\nA00002 OK SEARCH completed\r\n");
    }
  });

  const uids = await clientOn(conn).uidSearch('SUBJECT "Bjørn"');

  assertEquals(uids, [8]);
  assertEquals(conn.chunks.length, 4);
  assertEquals(conn.chunks[3], 'A00002 UID SEARCH SUBJECT "Bjorn"\r\n');
});

Deno.test("a bare BAD is treated as a charset refusal, which is the OVH shape", async () => {
  const conn = new FakeImapConn((chunk, c) => {
    if (chunk.startsWith("A00001 UID SEARCH")) c.send("A00001 BAD Command Error. 11\r\n");
    else if (chunk.startsWith("A00002 UID SEARCH")) {
      c.send("* SEARCH 1\r\nA00002 OK SEARCH completed\r\n");
    }
  });

  const uids = await clientOn(conn).uidSearch('SUBJECT "møte"');

  assertEquals(uids, [1]);
  assertEquals(conn.chunks[1], 'A00002 UID SEARCH SUBJECT "mote"\r\n');
});

Deno.test("the folded retry is not retried again when it fails too", async () => {
  const conn = new FakeImapConn((chunk, c) => {
    if (chunk.startsWith("A00001 UID SEARCH")) c.send("A00001 BAD Command Error. 11\r\n");
    else if (chunk.startsWith("A00002 UID SEARCH")) c.send("A00002 BAD Command Error. 11\r\n");
  });

  const err = await assertRejects(
    () => clientOn(conn).uidSearch('SUBJECT "Bjørn"'),
    Error,
  );
  assertStringIncludes(err.message, "UID SEARCH failed: Command Error. 11");
  assertEquals(conn.chunks.length, 2, "exactly one folded retry, never a third attempt");
});

Deno.test("a term that folds away to nothing errors instead of searching for something else", async () => {
  const conn = new FakeImapConn((chunk, c) => {
    if (chunk.startsWith("A00001 UID SEARCH")) {
      c.send("A00001 NO [BADCHARSET (US-ASCII)] Unsupported text encoding\r\n");
    }
  });

  const err = await assertRejects(
    () => clientOn(conn).uidSearch('SUBJECT "日本語"'),
    Error,
  );
  assertStringIncludes(err.message, "日本語");
  assertStringIncludes(err.message, "no ASCII equivalent");
  assertEquals(conn.chunks.length, 1, "no second search may go out for a term we cannot spell");
});

Deno.test("an emoji-only term is refused rather than searched for as an empty string", async () => {
  const conn = new FakeImapConn((chunk, c) => {
    if (chunk.startsWith("A00001 UID SEARCH")) c.send("A00001 BAD Command Error. 11\r\n");
  });

  await assertRejects(() => clientOn(conn).uidSearch('TEXT "\u{1F389}"'), Error);
  assertEquals(conn.chunks.length, 1);
});

Deno.test("an ordinary NO is reported, not papered over with a different search", async () => {
  const conn = new FakeImapConn((chunk, c) => {
    if (chunk.startsWith("A00001 UID SEARCH")) c.send("+ go\r\n");
    else if (chunk === "\r\n") c.send("A00001 NO Mailbox is not selected\r\n");
  });

  const err = await assertRejects(
    () => clientOn(conn).uidSearch('SUBJECT "Bjørn"'),
    Error,
  );
  assertStringIncludes(err.message, "UID SEARCH failed: Mailbox is not selected");
  assertEquals(conn.chunks.length, 3, "a plain NO must not trigger a folded retry");
});

Deno.test("a refusal never lets unfoldable octets back onto the wire", async () => {
  // An unterminated quoted string reaches the tokenizer through the `raw`
  // escape hatch and is deliberately copied through verbatim, so the folding
  // pass cannot reach the character inside it. Retrying anyway would resend the
  // raw octets that caused the refusal.
  const conn = new FakeImapConn((chunk, c) => {
    if (chunk.startsWith("A00001 UID SEARCH")) c.send("A00001 BAD Command Error. 11\r\n");
  });

  const err = await assertRejects(
    () => clientOn(conn).uidSearch('SUBJECT "Bjørn'),
    Error,
  );
  assertStringIncludes(err.message, "this client can fold to ASCII");
  assertEquals(conn.chunks.length, 1, "no retry may carry the octets the server just refused");
});

// -- The criteria tokenizer ----------------------------------------------------

Deno.test("ASCII criteria tokenize to a single verbatim segment", () => {
  const criteria = 'FROM "a@b.c" SUBJECT "hi" SINCE 01-Jan-2026 UNSEEN';
  assertEquals(splitSearchLiterals(criteria), [{ kind: "verbatim", text: criteria }]);
});

Deno.test("a quoted operand's escaping is undone for the literal but kept when ASCII", () => {
  // The ASCII operand keeps the caller's exact escaping; the non-ASCII one is
  // decoded, because a literal carries raw octets and must not re-escape them.
  assertEquals(
    splitSearchLiterals('SUBJECT "a \\"b\\"" FROM "smør \\\\ ost"'),
    [
      { kind: "verbatim", text: 'SUBJECT "a \\"b\\"" FROM ' },
      { kind: "literal", value: "smør \\ ost", quoted: true },
    ],
  );
});

Deno.test("a bare non-ASCII atom from the raw escape hatch becomes a literal", () => {
  assertEquals(
    splitSearchLiterals("SUBJECT Bjørn"),
    [
      { kind: "verbatim", text: "SUBJECT " },
      { kind: "literal", value: "Bjørn", quoted: false },
    ],
  );
});

Deno.test("an unterminated quoted string is passed through rather than rewritten", () => {
  const criteria = 'SUBJECT "unclosed';
  assertEquals(splitSearchLiterals(criteria), [{ kind: "verbatim", text: criteria }]);
});

Deno.test("hasNonAscii is the gate the fast path turns on", () => {
  assert(!hasNonAscii(""));
  assert(!hasNonAscii('SUBJECT "invoice" UNSEEN'));
  assert(hasNonAscii("Bjørn"));
  assert(hasNonAscii("\u{1F389}"));
});

// -- ASCII folding -------------------------------------------------------------

Deno.test("folding strips diacritics and spells out the letters NFD cannot", () => {
  assertEquals(
    foldSearchCriteriaToAscii('SUBJECT "café naïve"').criteria,
    'SUBJECT "cafe naive"',
  );
  // The Nordic letters have no canonical decomposition, so a plain NFD pass
  // would delete them and turn the term into a different word.
  assertEquals(
    foldSearchCriteriaToAscii('FROM "Bjørn Mæland"').criteria,
    'FROM "Bjorn Maeland"',
  );
  assertEquals(
    foldSearchCriteriaToAscii('SUBJECT "Straße"').criteria,
    'SUBJECT "Strasse"',
  );
});

Deno.test("folding leaves the ASCII scaffolding of the criteria alone", () => {
  const folded = foldSearchCriteriaToAscii('FROM "a@b.c" SUBJECT "årsrapport" SINCE 01-Jan-2026');
  assertEquals(folded.criteria, 'FROM "a@b.c" SUBJECT "arsrapport" SINCE 01-Jan-2026');
  assertEquals(folded.lost, []);
});

Deno.test("folding reports every operand it could not spell in ASCII", () => {
  const folded = foldSearchCriteriaToAscii('SUBJECT "日本語" FROM "Bjørn"');
  assertEquals(folded.lost, ["日本語"]);
});

Deno.test("a folded bare atom stays a bare atom", () => {
  assertEquals(
    foldSearchCriteriaToAscii("SUBJECT Bjørn").criteria,
    "SUBJECT Bjorn",
  );
});

Deno.test("only a charset refusal counts as one", () => {
  assert(isCharsetRejection("NO", "[BADCHARSET (US-ASCII)] Unsupported text encoding"));
  assert(isCharsetRejection("NO", "[badcharset] whatever"));
  assert(isCharsetRejection("BAD", "Command Error. 11"));
  assert(!isCharsetRejection("NO", "Mailbox is not selected"));
  assert(!isCharsetRejection("OK", "SEARCH completed"));
});
