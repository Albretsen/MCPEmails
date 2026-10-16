// ---------------------------------------------------------------------------
// Where an IMAP tool call spends its time.
//
// Measured 2026-10-02, after the database side of a tools/call was cut to
// about 0.7 s: what is left is the mailbox. email_search p50 3.9 s and p95
// 26.9 s, email_list 2.8 s and 16.3 s, folder_list 5.0 s and 15.7 s, and
// nothing in the logs could say which part of that was the handshake, which
// was the server walking the mailbox, and which was bytes on the wire. On
// Yahoo, half of all search volume, email_list is bimodal at 4 to 5 s and 11
// to 13 s and nobody could name the second mode.
//
// This module is the record that answers it. One per request, opened by
// handleRequest in index.ts and read back onto the `[mcp-server] tools/call`
// log line; ImapClient writes to it and never reads it.
//
// VALUE-FREE BY CONSTRUCTION. Every field is a duration, a count or a byte
// total. There is no string in it, so there is no hostname, address, folder
// name, flag, subject or search term to leak, and adding one would mean
// changing the type below, which is the point of typing it this way.
//
// AsyncLocalStorage rather than a parameter for the same reason index.ts uses
// it for `db_calls`: an isolate serves several requests at once, the IMAP
// client is constructed thirty-odd call frames below the dispatcher, and a
// module-level "current call" would be shared between them. Outside a request
// (the test runner, module load) the store is absent and nothing is recorded.
// ---------------------------------------------------------------------------

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The buckets a command's wall time is charged to. `other` is every command
 * that is not part of a read (STORE, COPY, MOVE, APPEND, EXPUNGE, CREATE and
 * friends): timed so the total adds up, not broken out because no read tool
 * issues one.
 */
export type ImapPhase = "select" | "search" | "fetch" | "list" | "status" | "logout" | "other";

const PHASES: readonly ImapPhase[] = [
  "select",
  "search",
  "fetch",
  "list",
  "status",
  "logout",
  "other",
];

/** Milliseconds since an arbitrary origin; only ever subtracted. */
export function imapClockMs(): number {
  return performance.now();
}

/** The timing record of one request. Numbers only; see the header. */
export class ImapCallTimings {
  /** Connections that reached the authenticated state. */
  connects = 0;
  /**
   * Connect attempts, successful or not. More attempts than connects on a call
   * that succeeded is a connection-limit refusal that was retried, which until
   * now left no trace at all.
   */
  connectAttempts = 0;
  /** Wall time inside ImapClient.connect, back-off sleeps included. */
  connectMs = 0;
  /** The part of `connectMs` spent asleep between attempts. */
  backoffMs = 0;
  /** Host validation (cached DNS) plus the TCP handshake. */
  dialMs = 0;
  /** The TLS handshake on an implicit-TLS port. */
  tlsMs = 0;
  /** Greeting to authenticated, including STARTTLS where that is used. */
  authMs = 0;
  /** Commands that went on the wire after authentication. */
  commands = 0;
  /** UIDs returned by every UID SEARCH in the call, summed. */
  searchUidCount = 0;
  /** Bytes read off the socket while a FETCH was in flight. */
  fetchBytes = 0;
  /**
   * LOGOUTs sent without the caller waiting for the reply. Such a goodbye is
   * in neither `logout_ms` nor `commands`: it may finish after the log line
   * is written, and a field that is sometimes there is worse than none.
   */
  logoutsDeferred = 0;
  readonly #phaseMs = new Map<ImapPhase, number>();

  /** Charge one command's wall time, and the bytes it read, to a phase. */
  addCommand(phase: ImapPhase, elapsedMs: number, bytesRead: number): void {
    this.commands += 1;
    this.#phaseMs.set(phase, (this.#phaseMs.get(phase) ?? 0) + elapsedMs);
    if (phase === "fetch") this.fetchBytes += bytesRead;
  }

  /** Milliseconds charged to `phase` so far. */
  phaseMs(phase: ImapPhase): number {
    return this.#phaseMs.get(phase) ?? 0;
  }

  /**
   * The fields for the tools/call log line, or null when the call never tried
   * to open an IMAP connection (Gmail, Outlook, a call rejected before
   * dispatch), so those lines stay exactly as they were.
   */
  logFields(): Record<string, number> | null {
    if (this.connectAttempts === 0) return null;
    const fields: Record<string, number> = {
      imap_connects: this.connects,
      connect_attempts: this.connectAttempts,
      connect_ms: Math.round(this.connectMs),
      connect_backoff_ms: Math.round(this.backoffMs),
      connect_dial_ms: Math.round(this.dialMs),
      connect_tls_ms: Math.round(this.tlsMs),
      connect_auth_ms: Math.round(this.authMs),
      imap_commands: this.commands,
      search_uid_count: this.searchUidCount,
      fetch_bytes: this.fetchBytes,
      logout_deferred: this.logoutsDeferred,
    };
    for (const phase of PHASES) fields[`${phase}_ms`] = Math.round(this.phaseMs(phase));
    return fields;
  }
}

/** Opened per request by handleRequest; absent everywhere else. */
export const imapTimingStore = new AsyncLocalStorage<ImapCallTimings>();

/** The record of the request in flight, or null outside one. */
export function currentImapTimings(): ImapCallTimings | null {
  return imapTimingStore.getStore() ?? null;
}
