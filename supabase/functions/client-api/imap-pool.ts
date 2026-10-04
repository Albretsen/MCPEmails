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
//   4. A RETURNED LEASE IS INERT. The handle refuses every further call, so a
//      late background command cannot land on a connection someone else holds.
//   5. NOOP BEFORE REUSE when the connection has idled longer than
//      `validateAfterIdleMs`. A dead one is replaced, not surfaced as an error.
//   6. BOUNDED. At most `maxPerKey` live connections per inbox including
//      overflow (below every provider cap we know: Yahoo 5, iCloud ~10, Gmail
//      15), `maxIdleTotal` idle connections per isolate, LOGOUT on eviction.
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
  now?: () => number;
}

export interface PoolStats {
  dials: number;
  reuses: number;
  overflows: number;
  validations: number;
  drops: number;
  evictions: number;
  waits: number;
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
  waiters: Array<() => void>;
  /** Checkouts currently working on this entry. */
  pending: number;
  /** Marks the current pooled lease; a stale release compares and no-ops. */
  generation: number;
}

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
};

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
  readonly #stats = { dials: 0, reuses: 0, overflows: 0, validations: 0, drops: 0, evictions: 0, waits: 0 };
  #closed = false;

  constructor(options: ImapPoolOptions = {}) {
    this.#opts = {
      idleTtlMs: options.idleTtlMs ?? defaults.idleTtlMs,
      validateAfterIdleMs: options.validateAfterIdleMs ?? defaults.validateAfterIdleMs,
      maxPerKey: options.maxPerKey ?? defaults.maxPerKey,
      waitMs: options.waitMs ?? defaults.waitMs,
      maxLeaseMs: options.maxLeaseMs ?? defaults.maxLeaseMs,
      maxIdleTotal: options.maxIdleTotal ?? defaults.maxIdleTotal,
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
   * A connection for `key`, exclusive to the caller until it calls `logout()`
   * (or `destroy()`) on the returned handle.
   *
   * `flow` identifies the operation asking: the same object for every connect
   * one operation makes, a different one for every other operation.
   */
  async checkout(key: string, flow: object, dial: () => Promise<C>): Promise<C> {
    if (this.#closed) return await dial();
    const entry = this.#entry(key);
    // An entry is never dropped from the map while a checkout is working on
    // it: a second entry for the same key would mean a second pooled
    // connection for the same inbox.
    entry.pending++;
    try {
      return await this.#acquire(entry, key, flow, dial);
    } finally {
      entry.pending--;
      this.#forget(key, entry);
    }
  }

  async #acquire(entry: Entry<C>, key: string, flow: object, dial: () => Promise<C>): Promise<C> {
    const deadline = this.#now() + this.#opts.waitMs;

    for (;;) {
      if (entry.state === "idle" && entry.client) {
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
          try {
            await client.noop();
          } catch {
            this.#dropPooled(entry, client, generation);
            continue;
          }
          if (entry.generation !== generation) continue;
        }
        this.#stats.reuses++;
        return this.#lease(entry, client, generation);
      }

      if (entry.state === "empty" && entry.live < this.#opts.maxPerKey) {
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
          return this.#unpooled(entry, key, client);
        }
        entry.client = client;
        entry.state = "leased";
        entry.leasedAt = this.#now();
        return this.#lease(entry, client, generation);
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
          return this.#unpooled(entry, key, client, true);
        }
        if (timedOut) throw new ImapPoolBusyError();
      }
      this.#stats.waits++;
      await this.#wait(entry, Math.max(1, deadline - this.#now()));
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
    const next = entry.waiters.shift();
    next?.();
  }

  #wait(entry: Entry<C>, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const at = entry.waiters.indexOf(finish);
        if (at !== -1) entry.waiters.splice(at, 1);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      entry.waiters.push(finish);
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
  #lease(entry: Entry<C>, client: C, generation: number): C {
    return this.#handle(client, (tainted) => {
      this.#returnPooled(entry, client, generation, tainted);
      return Promise.resolve();
    });
  }

  /** The handle for an overflow connection: really logged out on return. */
  #unpooled(entry: Entry<C>, _key: string, client: C, counted = false): C {
    return this.#handle(client, async (tainted, options) => {
      if (counted) entry.live--;
      this.#wake(entry);
      if (tainted && typeof client.destroy === "function" && (client.busy === true || client.dead === true)) {
        client.destroy();
        return;
      }
      await client.logout(options);
    });
  }

  /**
   * Wrap `client` so that `logout()` returns it, every rejected command marks
   * it tainted, and nothing works after it has been returned.
   */
  #handle(
    client: C,
    giveBack: (tainted: boolean, options?: { background?: boolean }) => Promise<void>,
  ): C {
    let released = false;
    let tainted = false;
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
          let out: unknown;
          try {
            out = (value as (...a: unknown[]) => unknown).apply(target, args);
          } catch (error) {
            tainted = true;
            throw error;
          }
          if (out && typeof (out as Promise<unknown>).then === "function") {
            (out as Promise<unknown>).then(undefined, () => {
              tainted = true;
            });
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
