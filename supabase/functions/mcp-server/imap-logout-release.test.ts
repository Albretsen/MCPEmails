// ---------------------------------------------------------------------------
// LOGOUT is sent, not waited for.
//
// Every IMAP read tool used to end with `await client.logout()`: one more
// round trip to the mail server, spent after the result was already built.
// `releaseImapClient` and `ImapSession.release` write the LOGOUT at the same
// point and hand the wait to the runtime (EdgeRuntime.waitUntil), with the
// same fallback as request-pipeline.ts: no hook, the caller waits as before.
//
// The property that must survive is the one the old code had by construction:
// NO CONNECTION IS LEFT OPEN. A leaked IMAP connection counts against the
// account's simultaneous-connection cap (Yahoo allows five) until the server
// times it out. So every test here ends by asserting the socket is closed.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { FakeImapServer, fakeTextMessage } from "./imap-fake-server.ts";
import { ImapSession, releaseImapClient } from "./imap-session.ts";
import { ImapCallTimings, imapTimingStore } from "./imap-timing.ts";
import type { BackgroundRuntime } from "./request-pipeline.ts";

function server(options: { holdLogout?: boolean } = {}): FakeImapServer {
  return new FakeImapServer({
    mailboxes: [{ name: "INBOX", messages: [fakeTextMessage(1), fakeTextMessage(2)] }],
    holdLogout: options.holdLogout,
  });
}

/** A runtime hook that keeps what it was asked to keep alive. */
function hook(): { runtime: BackgroundRuntime; kept: Promise<unknown>[] } {
  const kept: Promise<unknown>[] = [];
  return { kept, runtime: { waitUntil: (p) => void kept.push(p) } };
}

// -- releaseImapClient --------------------------------------------------------

Deno.test("with a runtime hook the caller does not wait for the server's goodbye", async () => {
  const srv = server({ holdLogout: true });
  const client = srv.client();
  await client.selectMailbox("INBOX");
  const { runtime, kept } = hook();

  // The server will not answer LOGOUT until told to. The old code would sit
  // here until the 15 s read timeout; this returns at once.
  await releaseImapClient(client, runtime);

  assert(srv.logoutReceived, "LOGOUT is already on the wire when the caller moves on");
  assertEquals(srv.commands, ['SELECT "INBOX"', "LOGOUT"]);
  assert(!srv.closed, "the socket stays open until the goodbye is answered");
  assertEquals(kept.length, 1, "exactly one promise was handed to the runtime");

  srv.answerLogout();
  await kept[0];
  assert(srv.closed, "and the socket is closed once it is");
});

Deno.test("a server that hangs up instead of answering still gets its socket closed", async () => {
  const srv = server({ holdLogout: true });
  const client = srv.client();
  let closes = 0;
  const conn = (client as unknown as { conn: { close(): void } }).conn;
  const realClose = conn.close;
  conn.close = () => {
    closes++;
    realClose();
  };
  const { runtime, kept } = hook();

  await releaseImapClient(client, runtime);
  assert(srv.logoutReceived);
  assertEquals(closes, 0);
  srv.hangUp();
  await kept[0];
  assertEquals(closes, 1, "the client closed its end");
});

Deno.test("without a runtime hook the caller waits, exactly as before", async () => {
  const srv = server();
  const client = srv.client();
  await client.selectMailbox("INBOX");

  await releaseImapClient(client, null);

  assertEquals(srv.commands, ['SELECT "INBOX"', "LOGOUT"]);
  assert(srv.closed, "closed by the time the call returns: nothing is left to the runtime");
});

Deno.test("a hook that refuses the work falls back to waiting, and still closes", async () => {
  const srv = server();
  const client = srv.client();
  const refusing: BackgroundRuntime = {
    waitUntil: () => {
      throw new Error("isolate is shutting down");
    },
  };

  await releaseImapClient(client, refusing);

  assert(srv.logoutReceived);
  assert(srv.closed);
});

Deno.test("a goodbye that fails is ignored, as logout().catch always did", async () => {
  let calls = 0;
  const failing = {
    logout: () => {
      calls++;
      return Promise.reject(new Error("socket already gone"));
    },
  };
  await releaseImapClient(failing, null);
  const { runtime, kept } = hook();
  await releaseImapClient(failing, runtime);
  await kept[0];
  assertEquals(calls, 2);
});

// -- ImapSession.release ------------------------------------------------------

Deno.test("release() on a session that never connected opens nothing", async () => {
  let opens = 0;
  const session = new ImapSession(() => {
    opens++;
    return Promise.resolve(server().client());
  });
  await session.release(null);
  assertEquals(opens, 0);
  await assertRejects(() => session.client(), Error, "imap_session_closed");
});

Deno.test("release() sends one LOGOUT, is safe to repeat, and ends the session", async () => {
  const srv = server();
  const session = new ImapSession(() => Promise.resolve(srv.client()));
  await session.select("INBOX");

  await session.release(null);
  await session.release(null);
  await session.close();

  assertEquals(srv.commands.filter((c) => c === "LOGOUT").length, 1);
  assert(srv.closed);
  await assertRejects(() => session.client(), Error, "imap_session_closed");
});

Deno.test("release() with a hook returns before the goodbye is answered", async () => {
  const srv = server({ holdLogout: true });
  const session = new ImapSession(() => Promise.resolve(srv.client()));
  await session.select("INBOX");
  const { runtime, kept } = hook();

  await session.release(runtime);

  assert(srv.logoutReceived);
  assert(!srv.closed);
  srv.answerLogout();
  await kept[0];
  assert(srv.closed);
});

Deno.test("release() on a busy socket destroys it instead of queueing a goodbye", async () => {
  let destroyed = 0;
  let logouts = 0;
  const busy = {
    busy: true,
    selectMailbox: () => Promise.resolve(),
    logout: () => {
      logouts++;
      return Promise.resolve();
    },
    destroy: () => {
      destroyed++;
    },
  };
  const session = new ImapSession(() => Promise.resolve(busy));
  await session.client();
  const { runtime, kept } = hook();

  await session.release(runtime);

  assertEquals(destroyed, 1);
  assertEquals(logouts, 0);
  assertEquals(kept.length, 0, "nothing is left for the runtime to wait on");
});

// -- close() is unchanged -----------------------------------------------------

Deno.test("close() still waits for the goodbye even where a runtime hook exists", async () => {
  const srv = server({ holdLogout: true });
  const session = new ImapSession(() => Promise.resolve(srv.client()));
  await session.select("INBOX");

  const kept: Promise<unknown>[] = [];
  const global = globalThis as { EdgeRuntime?: BackgroundRuntime };
  global.EdgeRuntime = { waitUntil: (p) => void kept.push(p) };
  try {
    let returned = false;
    const closing = session.close().then(() => {
      returned = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(!returned, "close() is still waiting on the server");
    assertEquals(kept.length, 0, "and handed nothing to the runtime");
    srv.answerLogout();
    await closing;
    assert(srv.closed);
  } finally {
    delete global.EdgeRuntime;
  }
});

Deno.test("release() picks the runtime hook up from the environment by default", async () => {
  const srv = server({ holdLogout: true });
  const session = new ImapSession(() => Promise.resolve(srv.client()));
  await session.select("INBOX");

  const kept: Promise<unknown>[] = [];
  const global = globalThis as { EdgeRuntime?: BackgroundRuntime };
  global.EdgeRuntime = { waitUntil: (p) => void kept.push(p) };
  try {
    await session.release();
    assertEquals(kept.length, 1);
    assert(!srv.closed);
    srv.answerLogout();
    await kept[0];
    assert(srv.closed);
  } finally {
    delete global.EdgeRuntime;
  }
});

// -- timings ------------------------------------------------------------------

Deno.test("a deferred goodbye is counted as deferred and is not in logout_ms", async () => {
  const deferred = new ImapCallTimings();
  const srv = server();
  const { runtime, kept } = hook();
  await imapTimingStore.run(deferred, async () => {
    const client = srv.client();
    await client.selectMailbox("INBOX");
    await releaseImapClient(client, runtime);
  });
  await kept[0];
  assertEquals(deferred.logoutsDeferred, 1);
  assertEquals(deferred.phaseMs("logout"), 0);
  assertEquals(deferred.commands, 1, "the SELECT; the deferred LOGOUT is not counted");
  assert(srv.closed);

  const waited = new ImapCallTimings();
  await imapTimingStore.run(waited, async () => {
    const client = server().client();
    await client.selectMailbox("INBOX");
    await releaseImapClient(client, null);
  });
  assertEquals(waited.logoutsDeferred, 0);
  assertEquals(waited.commands, 2);
});

// -- wiring -------------------------------------------------------------------
// index.ts boots the server at import, so the handlers are pinned as text (see
// search-phase-wiring.test.ts). What is pinned is WHICH closes moved: the read
// tools, and nothing on the runner's or a mid-call resolver's path.

const INDEX = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const TRIAGE = await Deno.readTextFile(new URL("./triage-engine.ts", import.meta.url));

function functionSource(name: string): string {
  const start = INDEX.indexOf(`async function ${name}(`);
  assert(start !== -1, `${name} not found in index.ts`);
  const end = INDEX.indexOf("\n}\n", start);
  return INDEX.slice(start, end);
}

Deno.test("the read tools release their connection instead of awaiting LOGOUT", () => {
  assert(functionSource("listImapMessages").includes("if (client) await releaseImapClient(client);"));
  assert(functionSource("imapListFolders").includes("if (client) await releaseImapClient(client);"));
  assert(functionSource("readImapMessage").includes("if (!sharedSession) await session.release();"));
  assert(functionSource("executeSearchEmails").includes("if (session) await session.release();"));
  assert(functionSource("executeReadEmails").includes("if (session) await session.release();"));
});

Deno.test("the automation runner and the mid-call folder lookups still wait for it", () => {
  assert(INDEX.includes("if (run?.imap) await run.imap.close();"), "the runner's closeSession");
  assert(!TRIAGE.includes("release("), "triage-engine.ts is untouched by this");
  assert(functionSource("imapMailboxListing").includes("if (!shared) await session.close();"));
  assert(functionSource("resolveImapAliasMailbox").includes("if (!shared) await session.close();"));
  assert(functionSource("searchImapMessages").includes("if (!sharedSession) await session.close();"));
  for (const name of ["executeSearchAndMove", "executeSearchAndDelete"]) {
    assert(functionSource(name).includes("if (session) await session.close();"), name);
  }
});
