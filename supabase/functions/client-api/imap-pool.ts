// ---------------------------------------------------------------------------
// In-isolate IMAP session pool.
//
// WHY. On the MCP path every tool call dials, negotiates TLS and authenticates
// its own IMAP connection: 1 to 2 seconds before the first useful command. A
// person paging through a mailbox makes that same connection dozens of times a
// minute. This pool keeps ONE authenticated connection per inbox alive for a
// short idle window and hands it to the next request.
//
// HOW IT IS WIRED. Nothing in the tool layer knows about it. `ImapClient.connect`
// asks `firstPartyContext` (mcp-server/first-party.ts) for an `imapConnect`
// hook; client-api installs one per call that lands here. So all of the tool
// layer's connect sites are covered at once, and an MCP request, which never
// opens that store, dials exactly as before.
//
// THE SAFETY RULES, each of which a test in tests/imap-pool.test.ts pins:
//
//   1. KEY = inbox scope + a digest of the full connection config (host, port,
//      security, username, password). A connection is only ever handed to a
//      caller presenting the same inbox AND the same credentials. Changing the
//      password changes the key; two inboxes never share an entry.
//   2. ONE LEASE AT A TIME. A lease is exclusive from checkout until the holder
//      calls `logout()` (which, on a lease, means "return it"). IMAP state is
//      per connection (the selected mailbox), so two operations must never
//      interleave on one. Within a lease, commands are still serialised by the
//      client's own `runExclusive` mutex.
//   3. DROP ON ANY ERROR. If any command on a lease rejected, or the lease is
//      returned while a command is still in flight, or the socket is dead, the
//      connection is destroyed, never reused. A half-read response on a reused
//      socket would be read as the answer to the next person's command.
//      ONE EXCEPTION: a UID SEARCH the server throttled (`isSearchThrottle`).
//      Its tagged NO was read in full, and a redial is the wrong reply to
//      "slow down".
//   4. A RETURNED LEASE IS INERT. The handle refuses every further call, so a
//      late background command cannot land on a connection someone else holds.
//   5. NOOP BEFORE REUSE when the connection has idled longer than
//      `validateAfterIdleMs`. A dead one is replaced, not surfaced as an error.
//   6. BOUNDED. At most `maxPerKey` live connections per inbox including
//      overflow (below every provider cap we know: Yahoo 5, iCloud ~10, Gmail
//      15), `maxIdleTotal` idle connections per isolate, LOGOUT on eviction.
//   7. A REFUSED LOGIN IS NOT RETRIED for `authBackoffMs`. The key is the
//      credentials, so the same password would be refused again, and providers
//      answer repeated failed logins by locking the mailbox (seen live on
//      Migadu, 2026-10-04: every login refused, SMTP answering 454, for well
//      over half an hour). A poll every 30 s must not be what keeps a lock
//      alive. New credentials are a new key and dial at once.
//   8. FIRST COME, FIRST SERVED, per inbox, by the order the REQUESTS arrived
//      (not the order they happened to reach the pool: a request does a
//      database read or two first, and those finish in any order). One
//      exception: an interactive request (`list`, `read`) goes ahead of a
//      queued background one (`status`, `folders`), including one that is
//      still dialling: the connection it opens is handed to the interactive
//      request first. See `nextInQueue`.
//
// OVERFLOW. When the pooled connection is leased and the SAME operation asks
// for a second one (a few executors hold two at once), waiting would deadlock,
// so it gets a plain unpooled connection that is really logged out on return:
// exactly what the MCP path does today. A DIFFERENT operation waits for the
// lease, up to `waitMs`, then overflows too.
// ---------------------------------------------------------------------------

export interface PoolableClient {
  logout(options?: { background?: boolean }): Promise<void>;
  destroy?(): void;
  noop?(): Promise<void>;
  readonly busy?: boolean;
  readonly dead?: boolean;
}

export interface ImapPoolOptions {
  /** Idle time after which a pooled connection is logged out. */
  idleTtlMs?: number;
  /** Idle time after which a connection is NOOP-checked before reuse. */
  validateAfterIdleMs?: number;
  /** Live connections per key, pooled + overflow. */
  maxPerKey?: number;
  /** How long a different operation waits for the pooled lease. */
  waitMs?: number;
  /** A lease older than this is presumed leaked and its connection destroyed. */
  maxLeaseMs?: number;
  /** Idle connections kept across the whole isolate. */
  maxIdleTotal?: number;
  /** How long a key whose login was refused is answered without dialling. */
  authBackoffMs?: number;
  /** How long a mailbox list is served from memory (0 disables). */
  listTtlMs?: number;
  now?: () => number;
}

export interface LeaseOptions {
  trace?: CallTrace;
  /**
   * The operation addresses messages by UID only (read, flag, move, delete,
   * search, attachment): re-entering the mailbox the connection already has
   * selected is done with NOOP instead of SELECT. Never set it for an
   * operation that fetches by SEQUENCE number (a listing): those need the
   * message count a real SELECT reports.
   */
  reuseSelection?: boolean;
  /**
   * The operation IS the folder listing (the `folders` op): it always asks the
   * server, and what it learns replaces the remembered list.
   */
  freshList?: boolean;
  /**
   * Where this checkout stands in the per-inbox queue (rule 8). Absent: it
   * queues as a `normal` request that arrived when it reached the pool.
   */
  order?: QueueOrder;
}

/**
 * `interactive`: someone is looking at the result right now (`list`, `read`).
 * `background`: a poll nobody is waiting on (`status`, `folders`).
 */
export type QueueClass = "interactive" | "normal" | "background";

export interface QueueOrder {
  /** From {@link ImapPool.arrival}, taken when the REQUEST arrived. */
  seq: number;
  cls: QueueClass;
}

interface Waiter extends QueueOrder {
  /** Arrival at the pool: orders checkouts that share a request. */
  sub: number;
  wake: () => void;
}

/**
 * Who is served next. Strictly first come, first served, with one exception:
 * when the request at the head is a background one and an interactive request
 * is queued behind it, the (earliest) interactive one goes first.
 */
export function nextInQueue<T extends { seq: number; sub: number; cls: QueueClass }>(queue: readonly T[]): T | null {
  let head: T | null = null;
  let interactive: T | null = null;
  const before = (a: T, b: T) => a.seq < b.seq || (a.seq === b.seq && a.sub < b.sub);
  for (const item of queue) {
    if (head === null || before(item, head)) head = item;
    if (item.cls === "interactive" && (interactive === null || before(item, interactive))) interactive = item;
  }
  return head !== null && head.cls === "background" && interactive !== null ? interactive : head;
}

export interface PoolStats {
  dials: number;
  reuses: number;
  overflows: number;
  validations: number;
  drops: number;
  evictions: number;
  waits: number;
  /** Checkouts answered with a remembered login refusal, without dialling. */
  refusals: number;
  /** Folder lists answered from memory instead of a LIST round trip. */
  listHits: number;
  /** A connection handed to a queued request that outranked the one that dialled it. */
  handovers: number;
  /** Searches the server throttled; the connection was kept (see `isSearchThrottle`). */
  throttles: number;
  idle: number;
  leased: number;
}

interface Entry<C> {
  /** The one pooled connection for this key, or null. */
  client: C | null;
  state: "empty" | "dialing" | "idle" | "leased";
  /** The operation holding (or dialling) the pooled connection. */
  flow: object | null;
  leasedAt: number;
  idleSince: number;
  idleTimer: TimerHandle | null;
  /** Every live connection for this key, pooled and overflow. */
  live: number;
  waiters: Waiter[];
  /** The waiter the connection was just offered to, until it resumes. */
  handoff: Waiter | null;
  /** Checkouts currently working on this entry. */
  pending: number;
  /** Marks the current pooled lease; a stale release compares and no-ops. */
  generation: number;
}

/**
 * Told the NAME of every client method a lease runs and how long it took.
 * Method names are identifiers from the source (`selectMailbox`, `uidStore`):
 * never an argument, so never a folder name, a query or an address.
 */
export type CallTrace = (method: string, ms: number) => void;

export class ImapPoolBusyError extends Error {
  constructor() {
    super("imap_pool_busy");
    this.name = "ImapPoolBusyError";
  }
}

const defaults = {
  idleTtlMs: 25_000,
  validateAfterIdleMs: 10_000,
  maxPerKey: 3,
  waitMs: 8_000,
  maxLeaseMs: 60_000,
  maxIdleTotal: 64,
  authBackoffMs: 60_000,
  listTtlMs: 60_000,
};

/** The mail server refused the credentials (as opposed to a network or protocol failure). */
export function isLoginRefusal(error: unknown): error is Error {
  return error instanceof Error && (error.name === "ImapAuthError" || error.message === "imap_auth_failed");
}

/**
 * The server answered a UID SEARCH with a tagged NO that says "not now": a rate
 * limit (`[LIMIT]`, RFC 5530), a throttle, "too many", "try again". Migadu
 * allows about 60 searches a minute and answers the next one this way.
 *
 * It is the ONE rejected command that does not taint a lease (rule 3). The
 * client throws "UID SEARCH failed: <text>" only after it has read the tagged
 * reply to its own command, so the connection is at a command boundary and in
 * sync; and dropping it is the wrong answer to a throttle: the redial is a
 * fresh login against a server that has just asked for less.
 */
export function isSearchThrottle(error: unknown): error is Error {
  if (!(error instanceof Error) || !error.message.startsWith("UID SEARCH failed:")) return false;
  const text = error.message.slice("UID SEARCH failed:".length).toLowerCase();
  // A charset refusal is its own thing (imap-client.ts retries it folded).
  if (text.includes("badcharset") || text.includes("charset")) return false;
  return /\[limit\]|\[unavailable\]|\[inuse\]|rate.?limit|thrott|too many|too much|try again|slow down|exceeded|temporar/.test(text);
}

/**
 * How long the server asked for, when it said. Migadu's refusal reads (live,
 * 2026-10-04) "search rate limit exceeded: 60 searches in 1m0s, please wait
 * 12s before trying again". Null when no wait is named; capped at a minute.
 */
export function searchThrottleWaitMs(error: unknown): number | null {
  if (!isSearchThrottle(error)) return null;
  const m = /\bwait (\d{1,4})\s*(ms|s|sec|seconds?|m|min|minutes?)\b/i.exec(error.message);
  if (!m) return null;
  const unit = m[2].toLowerCase();
  const ms = Number(m[1]) * (unit === "ms" ? 1 : unit.startsWith("m") ? 60_000 : 1000);
  return Math.min(Math.max(ms, 1000), 60_000);
}

/** `setTimeout` returns a number on older Deno and a Timeout object on newer ones. */
type TimerHandle = ReturnType<typeof setTimeout>;

function unref(timer: TimerHandle): void {
  try {
    const handle = timer as unknown as { unref?: () => void };
    if (typeof handle === "object" && handle !== null && typeof handle.unref === "function") handle.unref();
    else (Deno as unknown as { unrefTimer?: (id: unknown) => void }).unrefTimer?.(timer);
  } catch { /* not available: the timer just keeps the loop alive until it fires */ }
}

export class ImapPool<C extends PoolableClient> {
  readonly #entries = new Map<string, Entry<C>>();
  readonly #opts: Required<Omit<ImapPoolOptions, "now">>;
  readonly #now: () => number;
  readonly #stats = { dials: 0, reuses: 0, overflows: 0, validations: 0, drops: 0, evictions: 0, waits: 0, refusals: 0, listHits: 0, handovers: 0, throttles: 0 };
  #arrivals = 0;
  readonly #refused = new Map<string, { error: Error; until: number }>();
  /** The mailbox each live connection has selected (set by a successful SELECT through a handle). */
  readonly #selected = new WeakMap<object, string>();
  /**
   * `LIST "" "*"` per key, for `listTtlMs`. Refreshed by every real LIST and
   * by `listMailboxesWithStatus` (the `folders` op, which is never served
   * from here), dropped by create / delete / rename on any handle of the key.
   * Stale only for a folder created or renamed by ANOTHER mail client, and
   * then only until the TTL or the client's next folder refresh.
   */
  readonly #lists = new Map<string, { value: unknown; at: number }>();
  #closed = false;

  constructor(options: ImapPoolOptions = {}) {
    this.#opts = {
      idleTtlMs: options.idleTtlMs ?? defaults.idleTtlMs,
      validateAfterIdleMs: options.validateAfterIdleMs ?? defaults.validateAfterIdleMs,
      maxPerKey: options.maxPerKey ?? defaults.maxPerKey,
      waitMs: options.waitMs ?? defaults.waitMs,
      maxLeaseMs: options.maxLeaseMs ?? defaults.maxLeaseMs,
      maxIdleTotal: options.maxIdleTotal ?? defaults.maxIdleTotal,
      authBackoffMs: options.authBackoffMs ?? defaults.authBackoffMs,
      listTtlMs: options.listTtlMs ?? defaults.listTtlMs,
    };
    this.#now = options.now ?? (() => performance.now());
  }

  get stats(): PoolStats {
    let idle = 0;
    let leased = 0;
    for (const e of this.#entries.values()) {
      if (e.state === "idle") idle++;
      if (e.state === "leased") leased++;
    }
    return { ...this.#stats, idle, leased };
  }

  /**
   * A place in line. Call it when a request ARRIVES and pass the number as
   * `LeaseOptions.order.seq` on every checkout that request makes.
   */
  arrival(): number {
    return ++this.#arrivals;
  }

  /**
   * A connection for `key`, exclusive to the caller until it calls `logout()`
   * (or `destroy()`) on the returned handle.
   *
   * `flow` identifies the operation asking: the same object for every connect
   * one operation makes, a different one for every other operation.
   */
  async checkout(key: string, flow: object, dial: () => Promise<C>, lease?: LeaseOptions): Promise<C> {
    if (this.#closed) return await dial();
    const refused = this.#refused.get(key);
    if (refused) {
      if (refused.until > this.#now()) {
        this.#stats.refusals++;
        throw refused.error;
      }
      this.#refused.delete(key);
    }
    const guarded = async (): Promise<C> => {
      try {
        return await dial();
      } catch (error) {
        if (isLoginRefusal(error) && this.#opts.authBackoffMs > 0) {
          if (this.#refused.size > 2000) this.#refused.clear();
          this.#refused.set(key, { error, until: this.#now() + this.#opts.authBackoffMs });
        }
        throw error;
      }
    };
    const entry = this.#entry(key);
    // An entry is never dropped from the map while a checkout is working on
    // it: a second entry for the same key would mean a second pooled
    // connection for the same inbox.
    entry.pending++;
    try {
      return await this.#acquire(entry, key, flow, guarded, lease);
    } finally {
      entry.pending--;
      this.#forget(key, entry);
    }
  }

  async #acquire(entry: Entry<C>, key: string, flow: object, dial: () => Promise<C>, lease?: LeaseOptions): Promise<C> {
    const trace = lease?.trace;
    const deadline = this.#now() + this.#opts.waitMs;
    const sub = ++this.#arrivals;
    const me: Waiter = { seq: lease?.order?.seq ?? sub, cls: lease?.order?.cls ?? "normal", sub, wake: () => {} };

    for (;;) {
      // Rule 7, for a request that was QUEUED behind the login that was just
      // refused. Checking only on entry (as this did) let each of them dial
      // in turn: seen live 2026-10-04, a client's opening status + folders +
      // list for one refused mailbox made three logins and answered at 3.8,
      // 7.5 and 11 s, each waiting out the server's own failed-login delay.
      // They now all answer when the first refusal arrives.
      if (entry.state === "empty") {
        const refusedNow = this.#refused.get(key);
        if (refusedNow && refusedNow.until > this.#now()) {
          this.#stats.refusals++;
          if (entry.handoff === me) entry.handoff = null;
          for (const waiter of [...entry.waiters]) waiter.wake();
          throw refusedNow.error;
        }
      }
      // Rule 8: a free connection goes to whoever is next in line, which is
      // not necessarily whoever is looking at it right now.
      const myTurn = entry.handoff === null
        ? entry.waiters.length === 0 || nextInQueue([...entry.waiters, me]) === me
        : entry.handoff === me;
      if (myTurn && entry.state === "idle" && entry.client) {
        entry.handoff = null;
        const client = entry.client;
        this.#clearIdleTimer(entry);
        entry.state = "leased";
        entry.flow = flow;
        entry.leasedAt = this.#now();
        const generation = ++entry.generation;
        const idleFor = this.#now() - entry.idleSince;
        if (client.dead === true) {
          this.#dropPooled(entry, client, generation);
          continue;
        }
        if (idleFor > this.#opts.validateAfterIdleMs && typeof client.noop === "function") {
          this.#stats.validations++;
          const started = this.#now();
          try {
            await client.noop();
          } catch {
            this.#dropPooled(entry, client, generation);
            continue;
          } finally {
            trace?.("validate", this.#now() - started);
          }
          if (entry.generation !== generation) continue;
        }
        this.#stats.reuses++;
        return this.#lease(entry, key, client, generation, lease);
      }

      if (myTurn && entry.state === "empty" && entry.live < this.#opts.maxPerKey) {
        entry.handoff = null;
        entry.state = "dialing";
        entry.flow = flow;
        entry.live++;
        const generation = ++entry.generation;
        let client: C;
        try {
          client = await dial();
        } catch (error) {
          entry.live--;
          if (entry.generation === generation) {
            entry.state = "empty";
            entry.flow = null;
          }
          this.#wake(entry);
          this.#forget(key, entry);
          throw error;
        }
        this.#stats.dials++;
        if (this.#closed || entry.generation !== generation) {
          // The pool was closed, or the slot was reclaimed, while dialling.
          entry.live--;
          return this.#unpooled(entry, key, client, false, lease);
        }
        entry.client = client;
        entry.state = "leased";
        entry.leasedAt = this.#now();
        if (entry.waiters.length > 0 && nextInQueue([...entry.waiters, me]) !== me) {
          // Someone who outranks this request queued up while it was dialling
          // (a `list` behind a `status` on a cold connection): they get the
          // connection first, and this request takes its place in line.
          this.#stats.handovers++;
          this.#returnPooled(entry, client, generation, false);
          continue;
        }
        return this.#lease(entry, key, client, generation, lease);
      }

      // Not taken. A reservation this request could not use is released, and
      // if the connection is free for someone ahead of it, they are told: a
      // free connection never sits beside a sleeping waiter.
      if (entry.handoff === me) entry.handoff = null;
      if (
        !myTurn && entry.handoff === null &&
        (entry.state === "idle" || (entry.state === "empty" && entry.live < this.#opts.maxPerKey))
      ) {
        this.#wake(entry);
      }

      // The pooled connection is leased or being dialled by someone.
      const sameFlow = entry.flow === flow;
      const timedOut = this.#now() >= deadline;
      if (
        !sameFlow && entry.state === "leased" && entry.client &&
        this.#now() - entry.leasedAt > this.#opts.maxLeaseMs
      ) {
        // Presumed leaked: nobody holds a lease for a minute. Destroy it so
        // the stale holder cannot use it, then take the slot.
        const stale = entry.client;
        this.#dropPooled(entry, stale, entry.generation);
        continue;
      }
      if (sameFlow || timedOut) {
        if (entry.live < this.#opts.maxPerKey) {
          entry.live++;
          let client: C;
          try {
            client = await dial();
          } catch (error) {
            entry.live--;
            this.#wake(entry);
            throw error;
          }
          this.#stats.dials++;
          this.#stats.overflows++;
          return this.#unpooled(entry, key, client, true, lease);
        }
        if (timedOut) throw new ImapPoolBusyError();
      }
      this.#stats.waits++;
      await this.#wait(entry, me, Math.max(1, deadline - this.#now()));
    }
  }

  /** LOGOUT every idle connection and stop pooling. Leases in flight finish unpooled. */
  async closeAll(): Promise<void> {
    this.#closed = true;
    const closing: Promise<unknown>[] = [];
    for (const [key, entry] of this.#entries) {
      this.#clearIdleTimer(entry);
      if (entry.state === "idle" && entry.client) {
        const client = entry.client;
        entry.client = null;
        entry.state = "empty";
        entry.live--;
        closing.push(client.logout().catch(() => {}));
      }
      this.#wake(entry);
      if (entry.live <= 0) this.#entries.delete(key);
    }
    await Promise.all(closing);
  }

  #rememberList(key: string, value: unknown): void {
    if (this.#opts.listTtlMs <= 0 || !Array.isArray(value)) return;
    if (this.#lists.size >= 500) this.#lists.clear();
    this.#lists.set(key, { value: structuredClone(value), at: this.#now() });
  }

  #entry(key: string): Entry<C> {
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = {
        client: null,
        state: "empty",
        flow: null,
        leasedAt: 0,
        idleSince: 0,
        idleTimer: null,
        live: 0,
        waiters: [],
        handoff: null,
        pending: 0,
        generation: 0,
      };
      this.#entries.set(key, entry);
    }
    return entry;
  }

  #forget(key: string, entry: Entry<C>): void {
    if (entry.live <= 0 && entry.pending === 0 && entry.waiters.length === 0 && entry.state === "empty") {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
    }
  }

  #keyOf(entry: Entry<C>): string | null {
    for (const [key, value] of this.#entries) if (value === entry) return key;
    return null;
  }

  #clearIdleTimer(entry: Entry<C>): void {
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  #wake(entry: Entry<C>): void {
    const next = nextInQueue(entry.waiters);
    if (!next) {
      entry.handoff = null;
      return;
    }
    // Reserved for `next` until it resumes, so a request arriving in between
    // cannot slip in front of it.
    entry.handoff = next;
    next.wake();
  }

  #wait(entry: Entry<C>, me: Waiter, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const at = entry.waiters.indexOf(me);
        if (at !== -1) entry.waiters.splice(at, 1);
        resolve();
      };
      const timer = setTimeout(() => {
        // Gave up waiting: whatever was reserved for it is free again.
        if (entry.handoff === me) entry.handoff = null;
        finish();
      }, ms);
      me.wake = finish;
      entry.waiters.push(me);
    });
  }

  /** Destroy the pooled connection and free its slot. */
  #dropPooled(entry: Entry<C>, client: C, generation: number): void {
    if (entry.generation !== generation || entry.client !== client) return;
    this.#stats.drops++;
    this.#clearIdleTimer(entry);
    entry.client = null;
    entry.state = "empty";
    entry.flow = null;
    entry.live--;
    entry.generation++;
    try {
      if (typeof client.destroy === "function") client.destroy();
      else client.logout().catch(() => {});
    } catch { /* already gone */ }
    this.#wake(entry);
    const key = this.#keyOf(entry);
    if (key !== null) this.#forget(key, entry);
  }

  #returnPooled(entry: Entry<C>, client: C, generation: number, tainted: boolean): void {
    if (entry.generation !== generation || entry.client !== client) return;
    if (tainted || client.busy === true || client.dead === true || this.#closed) {
      if (this.#closed && !tainted && client.busy !== true && client.dead !== true) {
        // Clean connection, pool shutting down: say goodbye properly.
        entry.client = null;
        entry.state = "empty";
        entry.flow = null;
        entry.live--;
        entry.generation++;
        client.logout().catch(() => {});
        this.#wake(entry);
        return;
      }
      this.#dropPooled(entry, client, generation);
      return;
    }
    entry.state = "idle";
    entry.flow = null;
    entry.idleSince = this.#now();
    entry.generation++;
    const idleGeneration = entry.generation;
    const timer = setTimeout(() => {
      if (entry.generation !== idleGeneration || entry.state !== "idle" || entry.client !== client) return;
      this.#evictIdle(entry, client);
    }, this.#opts.idleTtlMs);
    unref(timer);
    entry.idleTimer = timer;
    this.#trimIdle();
    this.#wake(entry);
  }

  #evictIdle(entry: Entry<C>, client: C): void {
    this.#stats.evictions++;
    this.#clearIdleTimer(entry);
    entry.client = null;
    entry.state = "empty";
    entry.flow = null;
    entry.live--;
    entry.generation++;
    client.logout().catch(() => {});
    this.#wake(entry);
    const key = this.#keyOf(entry);
    if (key !== null) this.#forget(key, entry);
  }

  /** Keep at most `maxIdleTotal` idle connections, evicting the longest idle. */
  #trimIdle(): void {
    const idle: Entry<C>[] = [];
    for (const e of this.#entries.values()) if (e.state === "idle" && e.client) idle.push(e);
    if (idle.length <= this.#opts.maxIdleTotal) return;
    idle.sort((a, b) => a.idleSince - b.idleSince);
    for (const e of idle.slice(0, idle.length - this.#opts.maxIdleTotal)) {
      if (e.client) this.#evictIdle(e, e.client);
    }
  }

  /** The handle a holder of the POOLED connection gets. */
  #lease(entry: Entry<C>, key: string, client: C, generation: number, lease?: LeaseOptions): C {
    return this.#handle(client, (tainted) => {
      this.#returnPooled(entry, client, generation, tainted);
      return Promise.resolve();
    }, key, lease);
  }

  /** The handle for an overflow connection: really logged out on return. */
  #unpooled(entry: Entry<C>, key: string, client: C, counted = false, lease?: LeaseOptions): C {
    return this.#handle(client, async (tainted, options) => {
      if (counted) entry.live--;
      this.#wake(entry);
      if (tainted && typeof client.destroy === "function" && (client.busy === true || client.dead === true)) {
        client.destroy();
        return;
      }
      await client.logout(options);
    }, key, lease);
  }

  /**
   * Wrap `client` so that `logout()` returns it, every rejected command marks
   * it tainted, and nothing works after it has been returned.
   */
  #handle(
    client: C,
    giveBack: (tainted: boolean, options?: { background?: boolean }) => Promise<void>,
    key: string,
    lease?: LeaseOptions,
  ): C {
    const trace = lease?.trace;
    let released = false;
    let tainted = false;
    /** This lease re-entered a mailbox with NOOP: its SELECT-time snapshot is not current. */
    let reselected = false;
    let releasing: Promise<void> | null = null;
    const release = (options?: { background?: boolean }): Promise<void> => {
      if (releasing) return releasing;
      released = true;
      releasing = giveBack(tainted, options).catch(() => {});
      return releasing;
    };
    return new Proxy(client as object, {
      get: (target, prop) => {
        if (prop === "logout") return (options?: { background?: boolean }) => release(options);
        if (prop === "destroy") {
          return () => {
            tainted = true;
            try {
              (target as PoolableClient).destroy?.();
            } finally {
              void release();
            }
          };
        }
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (released) {
            // Rule 4. Rejected rather than thrown: every command is async.
            return Promise.reject(new Error("imap_lease_released"));
          }
          let invoke = (): unknown => (value as (...a: unknown[]) => unknown).apply(target, args);
          let label = typeof prop === "string" ? prop : "";
          /** Runs on the command's success, before the caller sees the result. */
          let after: ((result: unknown) => void) | undefined;

          if (prop === "selectMailbox" && typeof args[0] === "string") {
            // RE-ENTERING THE SELECTED MAILBOX. A SELECT of the mailbox this
            // connection already has selected is the single most expensive
            // command of a warm read (measured live: ~90 ms against a ~33 ms
            // round trip). For a lease that only addresses messages by UID
            // (`reuseSelection`), NOOP does what the SELECT was for: it makes
            // the server deliver every pending change, so the UID command
            // that follows sees the mailbox as it is now. What NOOP does not
            // do is refresh the SELECT-time snapshot (`selectedMessageCount`),
            // so that reads as unknown on this lease (see below).
            const name = args[0];
            const same = this.#selected.get(target) === name;
            // Unknown until this command completes: a failed SELECT leaves the
            // connection with NO mailbox selected (RFC 3501 6.3.1).
            this.#selected.delete(target);
            if (same && lease?.reuseSelection === true && typeof (target as PoolableClient).noop === "function") {
              invoke = () => (target as PoolableClient).noop!();
              label = "reselect";
              reselected = true;
            } else {
              reselected = false;
            }
            after = () => this.#selected.set(target, name);
          } else if (prop === "selectedMessageCount" && reselected) {
            // "null when the server did not say": every caller already falls
            // back to asking the server.
            return null;
          } else if (prop === "listMailboxes" && (args.length === 0 || args[0] === "*" || args[0] === undefined)) {
            // THE FOLDER LIST, remembered per inbox for `listTtlMs`. Resolving
            // a folder alias ("archive", "sent") lists every mailbox, and the
            // tool layer does it once per alias per call: measured live, two
            // of the five round trips of a three-folder status poll and four
            // of a five-folder search. See `#lists` for what refreshes it.
            const hit = lease?.freshList === true ? undefined : this.#lists.get(key);
            if (hit && this.#now() - hit.at < this.#opts.listTtlMs) {
              this.#stats.listHits++;
              trace?.("listCached", 0);
              return Promise.resolve(structuredClone(hit.value));
            }
            after = (result) => this.#rememberList(key, result);
          } else if (prop === "listMailboxesWithStatus") {
            // NOT remembered, and what was remembered is dropped. An extended
            // LIST (`RETURN (STATUS ...)`) need not carry the SPECIAL-USE
            // attributes a plain LIST does (RFC 6154 section 2), and Gmail
            // leaves them out: found live 2026-10-04, a `status` within a
            // minute of a `folders` answered folder_not_found for sent,
            // drafts, trash and spam, because the alias matcher was reading
            // this reply. The next plain LIST (the `folders` op makes one for
            // the roles) is what gets remembered.
            this.#lists.delete(key);
          } else if (prop === "createMailbox" || prop === "deleteMailbox" || prop === "renameMailbox") {
            // Whatever the outcome, the remembered list may now be wrong; and
            // a deleted or renamed mailbox may be the selected one.
            this.#lists.delete(key);
            if (prop !== "createMailbox") this.#selected.delete(target);
          }

          let out: unknown;
          try {
            out = invoke();
          } catch (error) {
            tainted = true;
            throw error;
          }
          if (out && typeof (out as Promise<unknown>).then === "function") {
            const started = trace ? performance.now() : 0;
            const done = trace && label ? () => trace(label, performance.now() - started) : undefined;
            const settled = after;
            const chained = (out as Promise<unknown>).then((result) => {
              settled?.(result);
              done?.();
              return result;
            }, (error) => {
              // Rule 3, and its one exception: a throttled search.
              if (prop === "uidSearch" && isSearchThrottle(error)) this.#stats.throttles++;
              else tainted = true;
              done?.();
              throw error;
            });
            return chained;
          }
          return out;
        };
      },
    }) as C;
  }
}

/**
 * The pool key for one connection: the inbox scope plus a SHA-256 over the
 * whole connection config, credentials included. The digest is the
 * "credential version": a changed password, host or username is a new key.
 */
export async function poolKey(
  scope: string,
  cfg: { host: string; port: number; email: string; password: string; security?: string },
): Promise<string> {
  const material = [cfg.host, String(cfg.port), cfg.security ?? "tls", cfg.email, cfg.password].join("\u0000");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  let hex = "";
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
  return `${scope}\u0000${hex}`;
}
