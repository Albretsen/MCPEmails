// ---------------------------------------------------------------------------
// A refused SELECT is not a missing folder.
//
// ── What went wrong ────────────────────────────────────────────────────────
// `ImapClient.selectMailbox` turned EVERY non-OK SELECT into
// "Mailbox not found: <name>". provider-error.ts classifies that text
// `folder_missing`, the read paths log it as `folder_not_found`, and the caller
// is told a permanent naming mismatch was made and that retrying cannot help.
//
// Measured over the 14 days to 2026-10-02: about 140 of those errors, 110 on
// Yahoo, mostly a SELECT of INBOX itself, arriving in bursts on inboxes whose
// calls otherwise succeed 94 to 99% of the time. An inbox that is selected
// thousands of times a day does not stop existing for ninety seconds. The
// server was refusing under load, and we reported that the folder was gone.
//
// ── The rule ───────────────────────────────────────────────────────────────
// "Mailbox not found" is thrown only when the server's answer says so: the
// response codes [NONEXISTENT] and [TRYCREATE], or wording that can only mean
// missing. Anything else is an ImapSelectRefusedError, which classifies as the
// retryable `command_rejected` and carries only protocol constants. INBOX is
// never missing, whatever the server said.
//
// The decision is a pure function (classifySelectFailure) and is tested as
// one; the socket tests then pin that selectMailbox is wired to it.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { classifySelectFailure, ImapClient, ImapSelectRefusedError } from "./imap-client.ts";
import {
  classifyProviderError,
  providerErrorAuditDetails,
  providerErrorLogCode,
  providerErrorSignals,
} from "./provider-error.ts";

const UTF8 = new TextEncoder();
const LATIN1 = new TextDecoder("latin1");

/**
 * A scripted IMAP socket that answers one SELECT with a canned tagged line.
 * The same seam imap-search-charset.test.ts uses, cut down to what a SELECT
 * needs: the client writes one command and reads until its tag comes back.
 */
class SelectOnlyConn {
  #inbound: number[] = [];
  readonly #taggedReply: string;
  readonly written: string[] = [];

  constructor(taggedReply: string) {
    this.#taggedReply = taggedReply;
  }

  write(p: Uint8Array): Promise<number> {
    const chunk = LATIN1.decode(p);
    this.written.push(chunk);
    const tag = /^(\S+) SELECT /.exec(chunk)?.[1];
    if (tag) {
      for (const b of UTF8.encode(`${tag} ${this.#taggedReply}\r\n`)) this.#inbound.push(b);
    }
    return Promise.resolve(p.length);
  }

  read(p: Uint8Array): Promise<number | null> {
    if (this.#inbound.length === 0) {
      return Promise.reject(new Error("fake IMAP server: nothing left to read"));
    }
    const n = Math.min(p.length, this.#inbound.length);
    for (let i = 0; i < n; i++) p[i] = this.#inbound[i];
    this.#inbound.splice(0, n);
    return Promise.resolve(n);
  }

  close(): void {}
}

/** See imap-search-charset.test.ts: the constructor is private on purpose. */
function clientAnswering(taggedReply: string): ImapClient {
  const ctor = ImapClient as unknown as { new (conn: unknown): ImapClient };
  return new ctor(new SelectOnlyConn(taggedReply));
}

/** A mailbox name no assertion below may ever see in a persisted payload. */
const SECRET_FOLDER = "Zebra Quartz Ledger 7731";

async function selectError(mailbox: string, taggedReply: string): Promise<Error> {
  return await assertRejects(() => clientAnswering(taggedReply).selectMailbox(mailbox), Error);
}

// ---------------------------------------------------------------------------
// The server says the mailbox is missing: still "Mailbox not found".
// ---------------------------------------------------------------------------

Deno.test("NO with [NONEXISTENT] or [TRYCREATE] is a missing mailbox", async () => {
  for (
    const reply of [
      "NO [NONEXISTENT] Unknown Mailbox: Reports (now in authenticated state) (Failure)",
      "NO [TRYCREATE] Mailbox doesn't exist: Reports",
      "NO [nonexistent] lower-case codes are still codes",
    ]
  ) {
    const err = await selectError("Reports", reply);
    assertEquals(err.message, "Mailbox not found: Reports", reply);
    assertEquals(classifyProviderError(err), "folder_missing", reply);
    assertEquals(providerErrorLogCode(classifyProviderError(err), "read"), "folder_not_found");
  }
});

Deno.test("a server with no response codes still gets a missing mailbox from its wording", async () => {
  // Every caller that depends on the not-found classification for a REAL
  // missing folder (move destination checks, the bulk paths, triage) has to
  // keep getting it from servers that predate RFC 5530.
  for (
    const reply of [
      "NO Mailbox doesn't exist: Reports (0.001 + 0.000 secs).",
      "NO Mailbox does not exist",
      "NO SELECT failed: Can't open mailbox Reports: no such mailbox",
      "NO Unknown Mailbox: Reports",
      "NO [CLIENTBUG] SELECT No such folder",
      "NO Folder not found",
    ]
  ) {
    const err = await selectError("Reports", reply);
    assertEquals(err.message, "Mailbox not found: Reports", reply);
    assertEquals(classifyProviderError(err), "folder_missing", reply);
  }
});

// ---------------------------------------------------------------------------
// The server refuses without saying missing: a retryable provider error.
// ---------------------------------------------------------------------------

Deno.test("a bare NO, [SERVERBUG], [UNAVAILABLE] and [LIMIT] are refusals, not missing folders", async () => {
  const cases: [string, string[]][] = [
    ["NO", ["SELECT", "NO"]],
    ["NO SELECT failed", ["SELECT", "NO"]],
    ["NO Unable to open this mailbox.", ["SELECT", "NO"]],
    ["NO [SERVERBUG] Internal error occurred. Refer to server log.", ["[SERVERBUG]", "SELECT", "NO"]],
    ["NO [UNAVAILABLE] Temporary failure, please try again later", ["[UNAVAILABLE]", "SELECT", "NO"]],
    ["NO [LIMIT] Too many simultaneous operations", ["[LIMIT]", "SELECT", "NO"]],
    ["NO [INUSE] Mailbox is locked by another session", ["[INUSE]", "SELECT", "NO"]],
    ["BAD Command received in Invalid state.", ["SELECT", "BAD"]],
  ];
  for (const [reply, signals] of cases) {
    const err = await selectError(SECRET_FOLDER, reply);
    assert(err instanceof ImapSelectRefusedError, `${reply} must be a refusal`);
    assert(!/not found/i.test(err.message), `${reply} must not read as a missing mailbox`);

    const reason = classifyProviderError(err);
    assertEquals(reason, "command_rejected", reply);
    // Retryable: on a read path this is provider_error, the code whose message
    // tells the caller to try again, and never folder_not_found.
    assertEquals(providerErrorLogCode(reason, "read"), "provider_error", reply);
    assertEquals(providerErrorLogCode(reason, "ledger"), "provider_error", reply);
    assertEquals(providerErrorSignals(err), signals, reply);
  }
});

Deno.test("a transient code outranks wording that happens to read like missing", async () => {
  // The server has said what kind of failure this is. Its prose does not get
  // to overrule its own response code.
  const err = await selectError("Reports", "NO [UNAVAILABLE] Mailbox does not exist right now");
  assert(err instanceof ImapSelectRefusedError);
  assertEquals(classifyProviderError(err), "command_rejected");
});

Deno.test("the refusal carries no folder name and no server prose, in the error or the payload", async () => {
  // Servers echo the mailbox back ("... for Zebra Quartz Ledger 7731"), and a
  // name can even look like a response code. Neither may survive.
  for (
    const reply of [
      `NO Cannot open ${SECRET_FOLDER} at this time`,
      `NO [UNAVAILABLE] ${SECRET_FOLDER} is temporarily locked`,
      `NO SELECT "[${SECRET_FOLDER}]" refused`,
    ]
  ) {
    const err = await selectError(SECRET_FOLDER, reply);
    assert(err instanceof ImapSelectRefusedError);
    const persisted = JSON.stringify(providerErrorAuditDetails("email_read", "imap", err));
    for (const secret of [SECRET_FOLDER, "Zebra", "Quartz", "Ledger", "7731", "locked", "Cannot"]) {
      assert(!err.message.includes(secret), `"${secret}" is in the error message: ${err.message}`);
      assert(!persisted.includes(secret), `"${secret}" reached the payload: ${persisted}`);
    }
  }
});

Deno.test("a bracketed word later in the text is not a response code", () => {
  // resp-text-code is only ever the first thing in the response text. A mailbox
  // the user named "[ALERT]" appearing in echoed prose is content.
  assertEquals(classifySelectFailure("Reports", "NO", "cannot open [ALERT] right now"), {
    kind: "refused",
    responseCode: null,
  });
  // Codes with arguments are read by their name alone.
  assertEquals(classifySelectFailure("Reports", "NO", "[BADCHARSET (UTF-8)] nope"), {
    kind: "refused",
    responseCode: "BADCHARSET",
  });
});

// ---------------------------------------------------------------------------
// INBOX is never missing.
// ---------------------------------------------------------------------------

Deno.test("a failed SELECT of INBOX is never classified as a missing folder", async () => {
  // The measured case: Yahoo refusing INBOX in bursts. Whatever the server
  // says, including the very words and codes that mean missing for any other
  // mailbox, the inbox exists (RFC 3501 5.1) and the failure is the server's.
  for (
    const reply of [
      "NO",
      "NO [SERVERBUG] SELECT Server error - Please try again later",
      "NO [UNAVAILABLE] try again",
      "NO [NONEXISTENT] Mailbox does not exist",
      "NO [TRYCREATE] Mailbox doesn't exist: INBOX",
      "NO Mailbox doesn't exist: INBOX",
      "BAD no such mailbox",
    ]
  ) {
    for (const spelling of ["INBOX", "inbox", "Inbox"]) {
      const err = await selectError(spelling, reply);
      assert(err instanceof ImapSelectRefusedError, `${spelling} / ${reply}`);
      const reason = classifyProviderError(err);
      assertEquals(reason, "command_rejected", `${spelling} / ${reply}`);
      assert(
        providerErrorLogCode(reason, "read") !== "folder_not_found",
        `${spelling} / ${reply} must never log folder_not_found`,
      );
      // Not even through a caller that pattern-matches the message text, which
      // is what index.ts's FOLDER_MISSING_RE and the classifier's own fallbacks do.
      assert(
        !/nonexistent|trycreate|not found|no such|exist/i.test(err.message),
        `the message must not carry a missing-folder marker: ${err.message}`,
      );
    }
  }
});

Deno.test("a mailbox that merely starts with INBOX is an ordinary mailbox", async () => {
  // Only the reserved name itself is exempt. "INBOX.Reports" can be missing.
  const err = await selectError("INBOX.Reports", "NO [NONEXISTENT] Mailbox does not exist");
  assertEquals(err.message, "Mailbox not found: INBOX.Reports");
});

// ---------------------------------------------------------------------------
// And the success path is untouched.
// ---------------------------------------------------------------------------

Deno.test("an OK SELECT still resolves and still sends the mailbox quoted", async () => {
  const ctor = ImapClient as unknown as { new (conn: unknown): ImapClient };
  const conn = new SelectOnlyConn("OK [READ-WRITE] SELECT completed");
  await new ctor(conn).selectMailbox("Reports");
  assertEquals(conn.written.length, 1);
  assert(/^\S+ SELECT "Reports"\r\n$/.test(conn.written[0]), conn.written[0]);
});
