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
type Filter = { op: 'eq' | 'is' | 'in' | 'like' | 'gt' | 'gte' | 'lte' | 'notIs'; column: string; value: unknown };

/** Mirrors the unique index in 20260902130000_billing_lifecycle_emails.sql. */
const CONFLICT_COLUMNS = ['stripe_customer_id', 'template', 'scope_key'];

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    const actual = row[f.column];
    switch (f.op) {
      case 'eq':
        return actual === f.value;
      case 'is':
        return f.value === null ? actual === null || actual === undefined : actual === f.value;
      case 'in':
        return Array.isArray(f.value) && f.value.includes(actual);
      case 'gt':
        return actual != null && String(actual) > String(f.value);
      case 'gte':
        return actual != null && String(actual) >= String(f.value);
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
  order?: { column: string; ascending: boolean };
  /** upsert only: the conflict target, and whether a clash is skipped or merged. */
  onConflict?: string[];
  ignoreDuplicates?: boolean;
}

class Query implements PromiseLike<{ data: Row[] | null; error: { message: string; code?: string } | null }> {
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
  /** Only the `.not(column, 'is', value)` shape. */
  not(column: string, operator: string, value: unknown): this {
    if (operator !== 'is') throw new Error(`FakeSupabase: .not(_, '${operator}', _) is not implemented`);
    this.pending.filters.push({ op: 'notIs', column, value });
    return this;
  }
  gte(column: string, value: unknown): this {
    this.pending.filters.push({ op: 'gte', column, value });
    return this;
  }
  lte(column: string, value: unknown): this {
    this.pending.filters.push({ op: 'lte', column, value });
    return this;
  }
  limit(n: number): this {
    this.pending.limit = n;
    return this;
  }
  /** Sorts by the column's string form, which is chronological for ISO timestamps. */
  order(column: string, options: { ascending?: boolean } = {}): this {
    this.pending.order = { column, ascending: options.ascending !== false };
    return this;
  }
  select(_columns?: string): this {
    return this;
  }

  private run(): { data: Row[] | null; error: { message: string; code?: string } | null } {
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
      // Without an explicit target this keeps the billing_email_sends index,
      // which is what every caller written before the target was read assumed.
      const columns = this.pending.onConflict ?? CONFLICT_COLUMNS;
      const ignore = this.pending.onConflict ? this.pending.ignoreDuplicates === true : true;
      for (const candidate of this.pending.inserted ?? []) {
        const existing = table.find((row) => columns.every((c) => row[c] === candidate[c]));
        // ON CONFLICT DO NOTHING: skipped rows are not inserted and, because
        // ignoreDuplicates is set, are not returned either.
        if (existing && ignore) continue;
        // ON CONFLICT DO UPDATE: the named columns overwrite, the rest stay.
        if (existing) {
          Object.assign(existing, candidate);
          out.push(existing);
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
      for (const candidate of this.pending.inserted ?? []) {
        const row: Row = { id: this.store.nextId++, ...candidate };
        table.push(row);
        out.push(row);
      }
      return { data: out, error: null };
    }

    let hits = table.filter((row) => matches(row, this.pending.filters));
    if (this.pending.order) {
      const { column, ascending } = this.pending.order;
      hits = [...hits].sort((a, b) => {
        const left = String(a[column] ?? '');
        const right = String(b[column] ?? '');
        if (left === right) return 0;
        return (left < right ? -1 : 1) * (ascending ? 1 : -1);
      });
    }
    if (this.pending.limit != null) hits = hits.slice(0, this.pending.limit);

    if (this.pending.kind === 'update') {
      for (const row of hits) Object.assign(row, this.pending.patch);
    }
    if (this.pending.kind === 'delete') {
      const gone = new Set(hits);
      const kept = table.filter((row) => !gone.has(row));
      table.length = 0;
      table.push(...kept);
    }
    return { data: hits, error: null };
  }

  then<A, B = never>(
    onfulfilled?:
      | ((v: { data: Row[] | null; error: { message: string; code?: string } | null }) => A | PromiseLike<A>)
      | null,
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

export class FakeSupabase {
  readonly tables = new Map<string, Row[]>();
  readonly failNext = new Map<string, { message: string; code?: string }>();
  nextId = 1;

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

  from(table: string) {
    return {
      select: (columns?: string) =>
        new Query(this, { kind: 'select', table, filters: [] }).select(columns),
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
          onConflict: options?.onConflict?.split(',').map((c) => c.trim()),
          ignoreDuplicates: options?.ignoreDuplicates,
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
