/**
 * A tiny in-memory stand-in for the PostgREST client, for the lifecycle queue
 * tests. TEST SUPPORT ONLY. Nothing in the app imports this.
 *
 * WHY THIS EXISTS RATHER THAN A MOCK OF `upsert`.
 *
 * The property the dunning queue rests on is not "upsert was called". It is
 * "the SECOND call inserts nothing", and that is a property of the unique index
 *
 *   UNIQUE (stripe_customer_id, template, scope_key)
 *
 * not of the code under test. A mock that records calls would pass whether or
 * not that index exists and whether or not `onConflict` names the right
 * columns; getting either wrong is how a customer receives four copies of "your
 * payment failed". So this fake enforces the constraint itself, from the same
 * column list the migration declares, and `ignoreDuplicates` behaves the way
 * ON CONFLICT DO NOTHING behaves: the conflicting rows are simply not returned.
 *
 * It implements only the query shapes src/lib/billing/lifecycle-queue.ts
 * actually uses. An unimplemented shape throws rather than quietly returning
 * nothing, because a silent empty result is exactly the failure this file is
 * meant to make impossible.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';

type Row = Record<string, unknown>;
type Filter = {
  op: 'eq' | 'neq' | 'is' | 'in' | 'like' | 'gt' | 'gte' | 'lt' | 'lte' | 'notIs';
  column: string;
  value: unknown;
};

/** Mirrors the unique index in 20260902130000_billing_lifecycle_emails.sql. */
const CONFLICT_COLUMNS = ['stripe_customer_id', 'template', 'scope_key'];

/**
 * A filter column's value. `<table>.<column>` is a filter on an `!inner`
 * embed: the parent row is found through `<table minus s>_id` (referrals ->
 * referral_id), which is the only foreign-key shape the tests embed.
 */
type Resolve = (row: Row, column: string) => unknown;

function matches(row: Row, filters: Filter[], resolve: Resolve = (r, c) => r[c]): boolean {
  return filters.every((f) => {
    const actual = resolve(row, f.column);
    switch (f.op) {
      case 'eq':
        return actual === f.value;
      case 'is':
        return f.value === null ? actual === null || actual === undefined : actual === f.value;
      case 'in':
        return Array.isArray(f.value) && f.value.includes(actual);
      case 'neq':
        return actual !== f.value;
      case 'gt':
        return actual != null && String(actual) > String(f.value);
      // ISO timestamps compare correctly as strings; that is all these serve.
      case 'gte':
        return actual != null && String(actual) >= String(f.value);
      case 'lt':
        return actual != null && String(actual) < String(f.value);
      case 'lte':
        return actual != null && String(actual) <= String(f.value);
      case 'notIs':
        return f.value === null ? actual !== null && actual !== undefined : actual !== f.value;
      case 'like': {
        const pattern = String(f.value).replace(/%/g, '');
        return typeof actual === 'string' && actual.startsWith(pattern);
      }
      default:
        return false;
    }
  });
}

interface Pending {
  kind: 'select' | 'update' | 'upsert' | 'insert' | 'delete';
  table: string;
  filters: Filter[];
  patch?: Row;
  inserted?: Row[];
  limit?: number;
  /** upsert only: the conflict columns, default the billing_email_sends index. */
  onConflict?: string[];
  /** upsert only: false merges the patch into the clashing row (ON CONFLICT DO UPDATE). */
  ignoreDuplicates?: boolean;
  order?: { column: string; ascending: boolean };
  /** `select(_, { count: 'exact', head: true })`: answer with `count`, no rows. */
  countHead?: boolean;
}

type Result = {
  data: Row[] | null;
  error: { message: string; code?: string } | null;
  count?: number | null;
};

class Query implements PromiseLike<Result> {
  // Written out rather than declared as parameter properties: the test runner
  // is `node --test --experimental-strip-types`, which erases types without
  // transforming, and parameter properties are a transform.
  private readonly store: FakeSupabase;
  private readonly pending: Pending;

  constructor(store: FakeSupabase, pending: Pending) {
    this.store = store;
    this.pending = pending;
  }

  eq(column: string, value: unknown): this {
    this.pending.filters.push({ op: 'eq', column, value });
    return this;
  }
  is(column: string, value: unknown): this {
    this.pending.filters.push({ op: 'is', column, value });
    return this;
  }
  in(column: string, value: unknown[]): this {
    this.pending.filters.push({ op: 'in', column, value });
    return this;
  }
  like(column: string, value: string): this {
    this.pending.filters.push({ op: 'like', column, value });
    return this;
  }
  gt(column: string, value: unknown): this {
    this.pending.filters.push({ op: 'gt', column, value });
    return this;
  }
  neq(column: string, value: unknown): this {
    this.pending.filters.push({ op: 'neq', column, value });
    return this;
  }
  gte(column: string, value: unknown): this {
    this.pending.filters.push({ op: 'gte', column, value });
    return this;
  }
  lt(column: string, value: unknown): this {
    this.pending.filters.push({ op: 'lt', column, value });
    return this;
  }
  lte(column: string, value: unknown): this {
    this.pending.filters.push({ op: 'lte', column, value });
    return this;
  }
  order(column: string, options?: { ascending?: boolean }): this {
    this.pending.order = { column, ascending: options?.ascending ?? true };
    return this;
  }
  /** Only the `.not(column, 'is', value)` shape. */
  not(column: string, operator: string, value: unknown): this {
    if (operator !== 'is') throw new Error(`FakeSupabase: .not(_, '${operator}', _) is not implemented`);
    this.pending.filters.push({ op: 'notIs', column, value });
    return this;
  }
  limit(n: number): this {
    this.pending.limit = n;
    return this;
  }
  select(_columns?: string, options?: { count?: string; head?: boolean }): this {
    if (options?.head) this.pending.countHead = true;
    return this;
  }

  private run(): Result {
    const failure = this.store.failNext.get(this.pending.table);
    if (failure) {
      const left = (this.store.failCounts.get(this.pending.table) ?? 1) - 1;
      if (left > 0) {
        this.store.failCounts.set(this.pending.table, left);
      } else {
        this.store.failNext.delete(this.pending.table);
        this.store.failCounts.delete(this.pending.table);
      }
      return { data: null, error: failure };
    }

    const table = this.store.table(this.pending.table);

    if (this.pending.kind === 'upsert') {
      const out: Row[] = [];
      const conflictColumns = this.pending.onConflict ?? CONFLICT_COLUMNS;
      for (const candidate of this.pending.inserted ?? []) {
        const clash = table.find((existing) =>
          conflictColumns.every((c) => existing[c] === candidate[c]),
        );
        // ON CONFLICT DO NOTHING: skipped rows are not inserted and, because
        // ignoreDuplicates is set, are not returned either. Without
        // ignoreDuplicates (and with an explicit onConflict) it is DO UPDATE.
        if (clash) {
          if (this.pending.ignoreDuplicates === false) {
            Object.assign(clash, candidate);
            out.push(clash);
          }
          continue;
        }
        const row: Row = { id: this.store.nextId++, ...candidate, sent_at: null, cancelled_at: null };
        table.push(row);
        out.push(row);
      }
      return { data: out, error: null };
    }

    if (this.pending.kind === 'insert') {
      const out: Row[] = [];
      // Opt-in unique constraints (FakeSupabase.unique), checked before any
      // row of the batch lands, as one INSERT statement would be.
      for (const columns of this.store.uniques.get(this.pending.table) ?? []) {
        for (const candidate of this.pending.inserted ?? []) {
          if (table.some((existing) => columns.every((c) => existing[c] === candidate[c]))) {
            return {
              data: null,
              error: { code: '23505', message: `duplicate key value violates unique constraint (${columns.join(', ')})` },
            };
          }
        }
      }
      for (const candidate of this.pending.inserted ?? []) {
        const row: Row = { id: this.store.nextId++, ...candidate };
        table.push(row);
        out.push(row);
      }
      return { data: out, error: null };
    }

    const resolve: Resolve = (row, column) => {
      const dot = column.indexOf('.');
      if (dot < 0) return row[column];
      const parentTable = column.slice(0, dot);
      const fk = row[`${parentTable.replace(/s$/, '')}_id`];
      const parent = (this.store.tables.get(parentTable) ?? []).find((p) => String(p.id) === String(fk));
      return parent ? parent[column.slice(dot + 1)] : undefined;
    };
    let hits = table.filter((row) => matches(row, this.pending.filters, resolve));
    if (this.pending.order) {
      const { column, ascending } = this.pending.order;
      hits = [...hits].sort((a, b) => {
        const x = String(a[column] ?? '');
        const y = String(b[column] ?? '');
        return (x < y ? -1 : x > y ? 1 : 0) * (ascending ? 1 : -1);
      });
    }
    if (this.pending.limit != null) hits = hits.slice(0, this.pending.limit);
    if (this.pending.countHead && this.pending.kind === 'select') {
      return { data: null, error: null, count: hits.length };
    }

    if (this.pending.kind === 'update') {
      for (const row of hits) Object.assign(row, this.pending.patch);
    }
    if (this.pending.kind === 'delete') {
      const gone = new Set(hits);
      const kept = table.filter((row) => !gone.has(row));
      table.length = 0;
      table.push(...kept);
    }
    // A read returns copies, as PostgREST does: a row read before a write
    // must not change under the caller when the write lands.
    if (this.pending.kind === 'select') return { data: hits.map((row) => ({ ...row })), error: null };
    return { data: hits, error: null };
  }

  then<A, B = never>(
    onfulfilled?: ((v: Result) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }

  async maybeSingle(): Promise<{ data: Row | null; error: { message: string; code?: string } | null }> {
    const { data, error } = this.run();
    return { data: data?.[0] ?? null, error };
  }

  /** PostgREST `.single()`: exactly one row, else an error. */
  async single(): Promise<{ data: Row | null; error: { message: string; code?: string } | null }> {
    const { data, error } = this.run();
    if (error) return { data: null, error };
    if (!data || data.length !== 1) {
      return { data: null, error: { message: `expected 1 row, got ${data?.length ?? 0}`, code: 'PGRST116' } };
    }
    return { data: data[0], error: null };
  }
}

export type RpcHandler = (
  args: Record<string, unknown>,
  store: FakeSupabase,
) => { data: unknown; error: { message: string; code?: string } | null };

export class FakeSupabase {
  readonly tables = new Map<string, Row[]>();
  readonly failNext = new Map<string, { message: string; code?: string }>();
  /** Opt-in UNIQUE constraints for `insert`, per table. See unique(). */
  readonly uniques = new Map<string, string[][]>();
  /** `rpc(fn, args)` answers, per function name. An unregistered name throws. */
  readonly rpcs = new Map<string, RpcHandler>();
  readonly rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  nextId = 1;

  /** Make `insert` into `table` fail with 23505 when these columns repeat. */
  unique(table: string, columns: string[]): void {
    this.uniques.set(table, [...(this.uniques.get(table) ?? []), columns]);
  }

  /**
   * One rpc() for both registries: `rpcs` (handler gets the store too) and
   * `onRpc` / `rpcHandlers`. An unregistered name throws.
   */
  async rpc(fn: string, args: Record<string, unknown> = {}) {
    const handler = this.rpcs.get(fn);
    if (handler) {
      this.rpcCalls.push({ fn, args });
      return handler(args, this);
    }
    const simple = this.rpcHandlers.get(fn);
    if (!simple) throw new Error(`FakeSupabase: rpc('${fn}') has no handler`);
    this.rpcCalls.push({ fn, args });
    return simple(args);
  }

  table(name: string): Row[] {
    let rows = this.tables.get(name);
    if (!rows) {
      rows = [];
      this.tables.set(name, rows);
    }
    return rows;
  }

  /** Seed a table with rows exactly as written. */
  seed(name: string, rows: Row[]): void {
    this.table(name).push(...rows.map((r) => ({ id: this.nextId++, ...r })));
  }

  readonly failCounts = new Map<string, number>();

  /** Make the next query against `table` return this error, once. */
  failOnce(table: string, error: { message: string; code?: string }): void {
    this.failTimes(table, error, 1);
  }

  /** Make the next `count` queries against `table` return this error. */
  failTimes(table: string, error: { message: string; code?: string }, count: number): void {
    this.failNext.set(table, error);
    this.failCounts.set(table, count);
  }

  /**
   * RPC answers by function name: a function of the call's arguments. An RPC
   * with no handler throws, like an unimplemented query shape.
   */
  readonly rpcHandlers = new Map<string, (args: Record<string, unknown>) => { data: unknown; error: { message: string; code?: string } | null }>();

  /** Answer `rpc(name, ...)` with `handler`. */
  onRpc(
    name: string,
    handler: (args: Record<string, unknown>) => { data: unknown; error: { message: string; code?: string } | null },
  ): void {
    this.rpcHandlers.set(name, handler);
  }


  from(table: string) {
    return {
      select: (columns?: string, options?: { count?: string; head?: boolean }) =>
        new Query(this, { kind: 'select', table, filters: [] }).select(columns, options),
      update: (patch: Row) => new Query(this, { kind: 'update', table, filters: [], patch }),
      insert: (rows: Row | Row[]) =>
        new Query(this, { kind: 'insert', table, filters: [], inserted: Array.isArray(rows) ? rows : [rows] }),
      delete: () => new Query(this, { kind: 'delete', table, filters: [] }),
      upsert: (rows: Row | Row[], options?: { onConflict?: string; ignoreDuplicates?: boolean }) =>
        new Query(this, {
          kind: 'upsert',
          table,
          filters: [],
          inserted: Array.isArray(rows) ? rows : [rows],
          // Named conflict columns without ignoreDuplicates behave like
          // PostgREST's merge-duplicates (DO UPDATE). The lifecycle queue's
          // call names ignoreDuplicates and keeps DO NOTHING.
          ...(options?.onConflict
            ? {
                onConflict: options.onConflict.split(',').map((c) => c.trim()),
                ignoreDuplicates: options.ignoreDuplicates === true,
              }
            : {}),
        }),
    };
  }
}

/**
 * Hand the fake to code that wants a real `SupabaseClient<Database>`.
 *
 * TEST SUPPORT ONLY, and the ONE place in the repo where a Supabase client type
 * is asserted rather than checked. The fake implements a handful of the
 * client's query shapes and none of its auth, realtime or storage surface, so
 * there is no structural way to satisfy the real type; the assertion is
 * confined here so that every test call site is still typed as the real client
 * and nothing else has to widen to `any`. If a test starts calling a shape the
 * fake does not implement, the fake throws at runtime rather than compiling to
 * a silent no-op.
 */
export function asClient(fake: FakeSupabase): SupabaseClient<Database> {
  return fake as unknown as SupabaseClient<Database>;
}
