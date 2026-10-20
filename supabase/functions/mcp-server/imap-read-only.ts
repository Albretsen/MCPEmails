// ---------------------------------------------------------------------------
// Read-only mailbox access for read-only credentials.
//
// A key that holds nothing but `read:email` / `search:email` can only reach
// tools that read. That has always been enforced here, in the scope check on
// tools/call, and every body fetch already uses BODY.PEEK so reading never sets
// \Seen. Both are promises this server keeps. Neither is something the mail
// server enforces: the mailbox was opened with SELECT, read-write, so a bug in
// a read path could still have changed the account.
//
// EXAMINE (RFC 3501 6.3.2) is SELECT with the mailbox opened read-only. The
// server itself then refuses STORE, COPY into it, MOVE out of it and EXPUNGE
// for the session, and it does not clear \Recent either. So for a read-only key
// the guarantee no longer rests on this code alone.
//
// SCOPE OF THE CHANGE. The flag is set in exactly one place: the MCP tools/call
// path, and only for a key whose scopes are all read scopes (index.ts, around
// dispatchExecutor). Every other caller never opens this store, so
// `imapSelectCommand()` answers "SELECT" for them exactly as before:
//   - any key holding a write scope, even when it is making a read call;
//   - client-api (the web client), which runs the same executors in-process;
//   - the automation runner and scheduled sends.
// A key with no scopes at all is not treated as read-only either: it cannot
// call anything, and "no scopes" is not a claim worth changing a wire command
// for.
//
// Per request, not per connection. The MCP path dials per call (the IMAP pool
// was removed, PR #121), so a connection opened inside a read-only call never
// serves a write call. The command is still decided at SELECT time rather than
// at connect time so a client handed across that boundary by some future pool
// cannot carry the wrong mode into a write.
// ---------------------------------------------------------------------------

import { AsyncLocalStorage } from "node:async_hooks";

/** The scopes that confer reading and nothing else. */
const READ_ONLY_SCOPES: ReadonlySet<string> = new Set(["read:email", "search:email"]);

const readOnlyStore = new AsyncLocalStorage<true>();

/**
 * True when every scope is a read scope, and there is at least one.
 */
export function isReadOnlyScopeSet(scopes: readonly string[] | null | undefined): boolean {
  if (!scopes || scopes.length === 0) return false;
  return scopes.every((scope) => READ_ONLY_SCOPES.has(scope));
}

/**
 * Run `fn` with IMAP mailboxes opened read-only when `readOnly` is true.
 *
 * When it is false `fn` runs directly, outside any store, so the default path
 * is not merely equivalent but literally the same call it always was.
 */
export function runWithImapReadOnly<T>(readOnly: boolean, fn: () => Promise<T>): Promise<T> {
  return readOnly ? readOnlyStore.run(true, fn) : fn();
}

/** The command that opens a mailbox in the current request: EXAMINE or SELECT. */
export function imapSelectCommand(): "EXAMINE" | "SELECT" {
  return readOnlyStore.getStore() === true ? "EXAMINE" : "SELECT";
}
