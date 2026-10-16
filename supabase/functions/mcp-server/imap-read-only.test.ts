// Read-only keys open mailboxes with EXAMINE; everything else keeps SELECT.
// See imap-read-only.ts. Test-only wire, no real mailbox data.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { ImapClient } from "./imap-client.ts";
import { ImapSession } from "./imap-session.ts";
import { imapSelectCommand, isReadOnlyScopeSet, runWithImapReadOnly } from "./imap-read-only.ts";
import { type ScriptedCommand, ScriptedWire } from "./imap-scripted-wire.ts";

// A server that opens INBOX either way and, like a real one, refuses a STORE
// on a mailbox opened with EXAMINE.
function server(): ScriptedWire {
  let examined = false;
  return new ScriptedWire((command: ScriptedCommand) => {
    const { tag, text } = command;
    if (text.startsWith("SELECT ") || text.startsWith("EXAMINE ")) {
      examined = text.startsWith("EXAMINE ");
      const access = examined ? "READ-ONLY" : "READ-WRITE";
      const permanent = examined ? "()" : "(\\Seen \\Deleted \\*)";
      return `* 3 EXISTS\r\n* OK [PERMANENTFLAGS ${permanent}] flags\r\n` +
        `${tag} OK [${access}] ${examined ? "EXAMINE" : "SELECT"} completed\r\n`;
    }
    if (text.startsWith("UID STORE ")) {
      return examined
        ? `${tag} NO [READ-ONLY] mailbox is read-only\r\n`
        : `* 1 FETCH (UID 7 FLAGS (\\Seen))\r\n${tag} OK STORE completed\r\n`;
    }
    return `${tag} BAD unexpected\r\n`;
  });
}

const commandVerbs = (wire: ScriptedWire) => wire.commands.map((c) => c.text.split(" ")[0]);

Deno.test("isReadOnlyScopeSet: only read and search scopes, and at least one", () => {
  assertEquals(isReadOnlyScopeSet(["read:email"]), true);
  assertEquals(isReadOnlyScopeSet(["read:email", "search:email"]), true);
  assertEquals(isReadOnlyScopeSet(["search:email"]), true);
  assertEquals(isReadOnlyScopeSet(["read:email", "send:email"]), false);
  assertEquals(isReadOnlyScopeSet(["read:email", "manage:folders"]), false);
  assertEquals(isReadOnlyScopeSet(["read:email", "manage:automations"]), false);
  assertEquals(isReadOnlyScopeSet([]), false);
  assertEquals(isReadOnlyScopeSet(null), false);
  assertEquals(isReadOnlyScopeSet(undefined), false);
});

Deno.test("outside a read-only request the command is SELECT, as it always was", async () => {
  assertEquals(imapSelectCommand(), "SELECT");
  const wire = server();
  const client = wire.client<ImapClient>(ImapClient);
  await client.selectMailbox("INBOX");
  assertEquals(wire.commands.map((c) => c.text), ['SELECT "INBOX"']);
});

Deno.test("runWithImapReadOnly(false) leaves SELECT in place", async () => {
  const wire = server();
  const client = wire.client<ImapClient>(ImapClient);
  await runWithImapReadOnly(false, () => client.selectMailbox("INBOX"));
  assertEquals(commandVerbs(wire), ["SELECT"]);
});

Deno.test("a read-only request opens the mailbox with EXAMINE and reads its reply the same way", async () => {
  const wire = server();
  const client = wire.client<ImapClient>(ImapClient);
  await runWithImapReadOnly(true, () => client.selectMailbox("INBOX"));
  assertEquals(wire.commands.map((c) => c.text), ['EXAMINE "INBOX"']);
  assertEquals(client.selectedMessageCount(), 3);
  assertEquals(client.permanentFlags(), []);
});

Deno.test("the mode follows the request across awaits and through an ImapSession", async () => {
  const wire = server();
  const client = wire.client<ImapClient>(ImapClient);
  const session = new ImapSession<ImapClient>(() => Promise.resolve(client));
  await runWithImapReadOnly(true, async () => {
    await Promise.resolve();
    await session.select("INBOX");
  });
  assertEquals(commandVerbs(wire), ["EXAMINE"]);
});

Deno.test("concurrent requests keep their own mode", async () => {
  const readOnlyWire = server();
  const writerWire = server();
  const readOnly = readOnlyWire.client<ImapClient>(ImapClient);
  const writer = writerWire.client<ImapClient>(ImapClient);
  await Promise.all([
    runWithImapReadOnly(true, () => readOnly.selectMailbox("INBOX")),
    runWithImapReadOnly(false, () => writer.selectMailbox("INBOX")),
  ]);
  assertEquals(commandVerbs(readOnlyWire), ["EXAMINE"]);
  assertEquals(commandVerbs(writerWire), ["SELECT"]);
  assertEquals(imapSelectCommand(), "SELECT", "nothing leaks out of the request");
});

Deno.test("after EXAMINE the server, not this code, is what refuses a flag change", async () => {
  const wire = server();
  const client = wire.client<ImapClient>(ImapClient);
  await runWithImapReadOnly(true, async () => {
    await client.selectMailbox("INBOX");
    await assertRejects(() => client.uidStore([7], ["\\Seen"], "add"), Error, "read-only");
  });
});

Deno.test("a server that answers EXAMINE BAD still opens the mailbox, with SELECT", async () => {
  const wire = new ScriptedWire(({ tag, text }) =>
    text.startsWith("EXAMINE ")
      ? `${tag} BAD Unknown command\r\n`
      : `* 2 EXISTS\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`
  );
  const client = wire.client<ImapClient>(ImapClient);
  await runWithImapReadOnly(true, () => client.selectMailbox("INBOX"));
  assertEquals(wire.commands.map((c) => c.text), ['EXAMINE "INBOX"', 'SELECT "INBOX"']);
  assertEquals(client.selectedMessageCount(), 2);
});

Deno.test("EXAMINE answered NO is a mailbox answer, not a reason to retry", async () => {
  const wire = new ScriptedWire(({ tag }) => `${tag} NO [NONEXISTENT] Unknown Mailbox\r\n`);
  const client = wire.client<ImapClient>(ImapClient);
  await assertRejects(
    () => runWithImapReadOnly(true, () => client.selectMailbox("Nope")),
    Error,
    "Mailbox not found: Nope",
  );
  assertEquals(commandVerbs(wire), ["EXAMINE"]);
});

// -- wiring -------------------------------------------------------------------

const INDEX = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("tools/call wraps the executor in the read-only context, decided by the key's scopes", () => {
  assert(
    /runWithImapReadOnly\(\s*isReadOnlyScopeSet\(apiKey\.scopes\),\s*\(\) => dispatchExecutor\(dispatchName, rawArgs, apiKey\),\s*\)/
      .test(INDEX),
    "the tools/call dispatch must run inside runWithImapReadOnly(isReadOnlyScopeSet(apiKey.scopes), ...)",
  );
  // Exactly one place opens the store: the MCP tools/call path.
  assertEquals(INDEX.match(/runWithImapReadOnly\(/g)?.length, 1);
});

Deno.test("dispatchExecutor itself does not set the mode, so client-api keeps SELECT", () => {
  const start = INDEX.indexOf("async function dispatchExecutor(");
  assert(start > 0, "dispatchExecutor not found");
  const end = INDEX.indexOf("\n}\n", start);
  assert(!INDEX.slice(start, end).includes("runWithImapReadOnly"));
});
