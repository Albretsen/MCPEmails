// Source-level guards for the per-command IMAP idle budget.
//
// The behaviour cannot be exercised without a mail server that goes quiet for
// twenty seconds, so what is pinned here is the WIRING, in the same style as
// search-phase-wiring.test.ts: which commands get the raised budget, that the
// raise cannot leak onto the next command, and that the ordering against the
// outer search race is preserved. Each of those is a property a future edit
// could break silently, and each is visible in the source.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

const CLIENT = await Deno.readTextFile(new URL("./imap-client.ts", import.meta.url));
const INDEX = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

/** The body of a named method, from its signature to the next one-tab close. */
function methodSource(name: string): string {
  const start = CLIENT.indexOf(`  private async ${name}(`);
  assert(start > 0, `${name} not found in imap-client.ts`);
  const end = CLIENT.indexOf("\n  }\n", start);
  assert(end > start, `${name} has no terminator`);
  return CLIENT.slice(start, end);
}

Deno.test("the socket read honours the per-command budget, not a fixed constant", () => {
  const body = methodSource("readSocket");
  assertStringIncludes(body, "this.readIdleTimeoutMs");
  assert(
    !body.includes("COMMAND_TIMEOUT_MS"),
    "readSocket pins the constant again, so a raised budget would not reach the socket",
  );
});

Deno.test("both UID SEARCH paths get the raised budget", () => {
  // The ASCII path and the CHARSET UTF-8 path are separate commands, and a
  // mailbox that needs the folded retry is exactly the sort that is slow.
  const ascii = methodSource("uidSearchAsciiUnlocked");
  assertStringIncludes(ascii, "idleTimeoutMs: SEARCH_IDLE_TIMEOUT_MS");
  const utf8 = methodSource("uidSearchUtf8Unlocked");
  assertStringIncludes(utf8, "idleTimeoutMs: SEARCH_IDLE_TIMEOUT_MS");
});

Deno.test("no command other than UID SEARCH raises the budget", () => {
  // A FETCH or a STORE that went quiet for twenty-five seconds is a fault, not
  // a slow mailbox, and should keep failing at fifteen.
  const raises = CLIENT.split("idleTimeoutMs: SEARCH_IDLE_TIMEOUT_MS").length - 1;
  assertEquals(raises, 2, "the raised idle budget spread beyond the two search commands");
});

Deno.test("the raised budget is restored before the next command", () => {
  const start = CLIENT.indexOf("  private async readTagged(");
  assert(start > 0);
  const body = CLIENT.slice(start);
  const finallyAt = body.indexOf("} finally {");
  assert(finallyAt > 0, "readTagged no longer restores state in a finally");
  const restore = body.slice(finallyAt, finallyAt + 400);
  assertStringIncludes(restore, "this.readIdleTimeoutMs = COMMAND_TIMEOUT_MS");
});

Deno.test("the idle budget stays under the outer search race", () => {
  // Ordering is the whole design: the inner timer destroys the connection, the
  // outer one only stops waiting, so the inner must still be the one that
  // fires on a genuinely dead socket.
  const idle = /const SEARCH_IDLE_TIMEOUT_MS = ([\d_]+);/.exec(CLIENT);
  assert(idle, "SEARCH_IDLE_TIMEOUT_MS is gone");
  const outer = /const SEARCH_TIMEOUT_MS = ([\d_]+);/.exec(INDEX);
  assert(outer, "SEARCH_TIMEOUT_MS is gone");
  const idleMs = Number(idle[1].replace(/_/g, ""));
  const outerMs = Number(outer[1].replace(/_/g, ""));
  assert(
    idleMs < outerMs,
    `idle budget ${idleMs}ms must stay under the search race ${outerMs}ms`,
  );
  // And above the default, or the raise does nothing at all.
  const base = /const COMMAND_TIMEOUT_MS = ([\d_]+);/.exec(CLIENT);
  assert(base);
  assert(idleMs > Number(base[1].replace(/_/g, "")));
});
