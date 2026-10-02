// ---------------------------------------------------------------------------
// One authenticated IMAP connection per tool call.
//
// ── What this replaces ──────────────────────────────────────────────────────
// Every IMAP entry point in index.ts used to open its own connection, use it
// once, and log out:
//
//   * `readImapMessage` connects, SELECTs, FETCHes one message, logs out — and
//     `email_read_batch` calls it in a loop, so a 50-id batch opened FIFTY
//     TCP + TLS + AUTH handshakes to read fifty messages out of (usually) one
//     mailbox.
//   * `imapBulkMove` / `Copy` / `Delete` / `Flag` already batch efficiently at
//     the protocol level — one `UID MOVE` per source folder with every UID in
//     it — but pay a fresh connect per folder group.
//   * `search_and_move` / `search_and_delete` run the search on one connection,
//     close it, and open another to do the work.
//
// The per-message IMAP cost was never the problem. The CONNECT was, and there
// is a second-order effect that explains the really ugly numbers: providers cap
// simultaneous IMAP connections per account (Yahoo at 5; Fastmail and iCloud
// similar), and a server-side connection often lingers after LOGOUT. Churning
// connections trips that cap, and `ImapClient.connect` answers a connection-limit
// refusal by sleeping 5s and then 10s before retrying. A handful of those in one
// call is the difference between a 4-second p50 and a 139-second p99.
//
// ── The concurrency rule, which is not negotiable ───────────────────────────
// `ImapClient` multiplexes ONE socket with ONE shared read buffer and ONE tag
// stream. Two overlapping commands corrupt it — that is not theoretical, a
// `Promise.allSettled` STATUS fan-out once caused 100% folder_list failure. The
// client defends itself with the `runExclusive` chain, and this session does
// nothing to work around that: it issues commands strictly one at a time and
// awaits each. If parallelism is ever wanted here, it must come from SEPARATE
// clients with a capped pool, never from a second command on this one.
// ---------------------------------------------------------------------------

import {
  type BackgroundRuntime,
  backgroundRuntime,
  settleAfterResponse,
} from "./request-pipeline.ts";

/**
 * The slice of `ImapClient` a session needs to manage. Structural, so the real
 * client satisfies it without changes and a test can supply a fake.
 */
export interface SessionCapableImapClient {
  selectMailbox(mailbox: string): Promise<void>;
  /**
   * `background` says nobody is waiting for this LOGOUT (see
   * {@link releaseImapClient}), so the client keeps it out of the time it
   * reports the caller waited. Optional, and a client may ignore it.
   */
  logout(options?: { background?: boolean }): Promise<void>;
  /**
   * Close the socket without waiting for the command lock. Optional so an
   * existing fake, or any future minimal client, still satisfies this interface
   * without being forced to implement cancellation it has no socket to cancel.
   * See ImapClient.destroy for what it is for.
   */
  destroy?(): void;
  /**
   * True while a command is queued or running. Optional for the same reason as
   * `destroy`; a client that does not report it is treated as idle, which is
   * the behaviour this session had before cancellation existed.
   */
  readonly busy?: boolean;
}

/**
 * A lazily-opened, reused IMAP connection scoped to one tool call.
 *
 * Lazy on purpose: a bulk helper that rejects every id as malformed before it
 * touches the network should not open a connection at all, which is the
 * behaviour the per-call connects accidentally had and which is worth keeping.
 */
export class ImapSession<C extends SessionCapableImapClient> {
  #client: C | null = null;
  #selected: string | null = null;
  #closed = false;
  #connects = 0;
  #selects = 0;
  #selectsSkipped = 0;

  /**
   * @param open Opens and authenticates a fresh client. Called at most once per
   *             live connection; a session that has been invalidated calls it
   *             again for the next unit of work.
   */
  constructor(private readonly open: () => Promise<C>) {}

  /** Connections actually opened. Reused sessions report 1; diagnostics only. */
  get connectCount(): number {
    return this.#connects;
  }

  /** SELECTs issued, and SELECTs elided because the mailbox was already current. */
  get selectStats(): { issued: number; skipped: number } {
    return { issued: this.#selects, skipped: this.#selectsSkipped };
  }

  /**
   * The live client, connecting on first use.
   *
   * Callers must await this and then use the returned client immediately and
   * serially. Holding one across an await that lets another caller in would
   * reintroduce exactly the interleaving `runExclusive` exists to prevent.
   */
  async client(): Promise<C> {
    if (this.#closed) throw new Error("imap_session_closed");
    if (!this.#client) {
      this.#client = await this.open();
      this.#connects++;
      // A brand-new connection has nothing selected, whatever the previous one
      // had. Forgetting this is how a "skip the redundant SELECT" optimisation
      // turns into operating on the wrong mailbox.
      this.#selected = null;
    }
    return this.#client;
  }

  /**
   * SELECT `mailbox`, unless it is already the selected one.
   *
   * The skip is the cheap win: a 50-message read_batch out of INBOX issues one
   * SELECT instead of fifty, and a bulk operation whose ids all live in one
   * folder issues one instead of one per group. It is only safe because this
   * session is the sole owner of the connection for the duration of the call —
   * nothing else can SELECT out from under it.
   */
  async select(mailbox: string): Promise<C> {
    const client = await this.client();
    if (this.#selected === mailbox) {
      this.#selectsSkipped++;
      return client;
    }
    // Clear BEFORE the await: if SELECT throws, the connection's selected
    // mailbox is whatever the server decided, which we must not guess at.
    this.#selected = null;
    await client.selectMailbox(mailbox);
    this.#selected = mailbox;
    this.#selects++;
    return client;
  }

  /**
   * Drop the current connection so the next unit of work gets a fresh one.
   *
   * Called from the error path of every bulk group. Reusing a connection is
   * only a win while it is healthy; a socket that just failed mid-command may
   * be desynchronised or dead, and carrying it into the next folder group would
   * turn one group's failure into every subsequent group's failure. Before
   * connection reuse each group had its own connection and was therefore
   * independently recoverable — this preserves that property exactly, and pays
   * the reconnect cost only when something has already gone wrong.
   */
  async invalidate(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    this.#selected = null;
    if (client) await client.logout().catch(() => {});
  }

  /**
   * Abandon the connection immediately: kill the socket and forget the client.
   *
   * This is the counterpart to `invalidate()` for the case where the caller has
   * stopped waiting rather than hit an error. Handlers bound a slow provider
   * search with `Promise.race` against a timer, and the loser of a race is
   * abandoned, not cancelled: the socket carries on with a UID SEARCH or UID
   * FETCH whose result nobody will read. `invalidate()` and `close()` both go
   * through `logout()`, which is an ordinary command and therefore queues
   * behind that work, so the polite path is exactly the one that cannot get out
   * quickly. `destroy()` bypasses the command lock, which is why it is the one
   * used here.
   *
   * Synchronous on purpose: there is nothing to wait for, and an `await` here
   * would be another place for a caller to give up before the socket is gone.
   * Non-terminal, like `invalidate()`: the cached client is dropped so the
   * session can never hand out a dead one, and a later unit of work opens a
   * fresh connection.
   */
  abort(): void {
    const client = this.#client;
    this.#client = null;
    this.#selected = null;
    client?.destroy?.();
  }

  /**
   * Hand the live connection to a caller that will close it itself, and end
   * this session. Null when the session never connected, in which case the
   * caller opens its own.
   *
   * For the one shape `client()` does not fit: a first step that MAY need the
   * connection (resolving a folder name is a LIST, resolving "inbox" is
   * nothing) followed by a function that has always owned a connection of its
   * own and closes it in its own `finally`. Lending it the client would leave
   * two owners of one socket; giving it the client leaves one. After this the
   * session is closed and empty, so a `close()` on the way out is a no-op and
   * can never log out a connection somebody else is now using.
   *
   * Nothing is selected on the returned client as far as the new owner is
   * concerned: it must SELECT before it reads.
   */
  take(): C | null {
    const client = this.#client;
    this.#closed = true;
    this.#client = null;
    this.#selected = null;
    return client;
  }

  /** Close the connection for good. Safe to call more than once. */
  async close(): Promise<void> {
    this.#closed = true;
    const client = this.#client;
    this.#client = null;
    this.#selected = null;
    if (!client) return;
    // A graceful LOGOUT on a BUSY socket is the thing that was costing 8 to 19
    // seconds: it queues behind a command the caller has already walked away
    // from, and it is being issued precisely because the caller is trying to
    // leave. When the connection still owes work to nobody, close it the polite
    // way, which returns the connection slot to the provider immediately
    // instead of leaving it for the server's idle timeout.
    if (client.busy === true && typeof client.destroy === "function") {
      client.destroy();
      return;
    }
    await client.logout().catch(() => {});
  }

  /**
   * {@link close}, for a caller whose result is already in hand: LOGOUT goes
   * out now and the caller does not wait for the server to answer it.
   *
   * Terminal and repeatable exactly like `close()`, and it makes the same
   * choice on a busy socket (destroy rather than queue a goodbye behind work
   * nobody wants). The one difference is who waits for the BYE; see
   * {@link releaseImapClient} for the rule and its fallback.
   *
   * `close()` is kept for a connection that is closed in the MIDDLE of a
   * piece of work (the automation runner between runs, a folder lookup that
   * is followed by another connect): there the old order, goodbye answered and
   * only then the next dial, is left exactly as it was.
   */
  async release(runtime: BackgroundRuntime | null = backgroundRuntime()): Promise<void> {
    this.#closed = true;
    const client = this.#client;
    this.#client = null;
    this.#selected = null;
    if (!client) return;
    if (client.busy === true && typeof client.destroy === "function") {
      client.destroy();
      return;
    }
    await releaseImapClient(client, runtime);
  }
}

/**
 * Send LOGOUT without making the caller wait for the answer.
 *
 * Measured 2026-10-02: every read tool ended with an awaited LOGOUT, a full
 * round trip to the mail server spent after the result was already built. The
 * goodbye is a courtesy to the server (it frees the connection slot at once
 * instead of at the idle timeout), not something the response depends on.
 *
 * What moves is the WAIT, never the command. LOGOUT is written at the same
 * point it always was, so the server starts releasing the slot just as early,
 * and the socket is still closed by `logout()`'s own `finally` when the reply
 * arrives or its read times out. Where the runtime can keep the isolate alive
 * for that (`EdgeRuntime.waitUntil`), the returned promise is already
 * resolved. Where it cannot (the test runner, `deno run`, self-hosting) the
 * returned promise IS the logout and the caller waits exactly as before: the
 * same seam, and the same fallback, as the post-response writes in
 * request-pipeline.ts. Either way no connection is left open.
 *
 * A failed goodbye is ignored, as `logout().catch(() => {})` always did.
 */
export function releaseImapClient(
  client: Pick<SessionCapableImapClient, "logout">,
  runtime: BackgroundRuntime | null = backgroundRuntime(),
): Promise<void> {
  return settleAfterResponse(
    [["imap_logout", () => client.logout({ background: runtime !== null })]],
    () => {},
    runtime,
  );
}

/**
 * Run `fn` with a session, closing it however `fn` ends.
 *
 * The close is the point: a leaked IMAP connection counts against the account's
 * simultaneous-connection cap until the server times it out, which is precisely
 * the condition that makes the NEXT call slow. Every session must be closed on
 * the error path too, so this wrapper is the intended way to make one.
 */
export async function withImapSession<C extends SessionCapableImapClient, T>(
  open: () => Promise<C>,
  fn: (session: ImapSession<C>) => Promise<T>,
): Promise<T> {
  const session = new ImapSession(open);
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}
