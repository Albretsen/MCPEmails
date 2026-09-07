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

type Row = Record<string, unknown>;
type Filter = { op: 'eq' | 'is' | 'in' | 'like'; column: string; value: unknown };

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
  kind: 'select' | 'update' | 'upsert';
  table: string;
  filters: Filter[];
  patch?: Row;
  inserted?: Row[];
  limit?: number;
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
  limit(n: number): this {
    this.pending.limit = n;
    return this;
  }
  select(_columns?: string): this {
    return this;
  }

  private run(): { data: Row[] | null; error: { message: string; code?: string } | null } {
    const failure = this.store.failNext.get(this.pending.table);
    if (failure) {
      this.store.failNext.delete(this.pending.table);
      return { data: null, error: failure };
    }

    const table = this.store.table(this.pending.table);

    if (this.pending.kind === 'upsert') {
      const out: Row[] = [];
      for (const candidate of this.pending.inserted ?? []) {
        const clash = table.some((existing) =>
          CONFLICT_COLUMNS.every((c) => existing[c] === candidate[c]),
        );
        // ON CONFLICT DO NOTHING: skipped rows are not inserted and, because
        // ignoreDuplicates is set, are not returned either.
        if (clash) continue;
        const row: Row = { id: this.store.nextId++, ...candidate, sent_at: null, cancelled_at: null };
        table.push(row);
        out.push(row);
      }
      return { data: out, error: null };
    }

    let hits = table.filter((row) => matches(row, this.pending.filters));
    if (this.pending.limit != null) hits = hits.slice(0, this.pending.limit);

    if (this.pending.kind === 'update') {
      for (const row of hits) Object.assign(row, this.pending.patch);
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

  /** Make the next query against `table` return this error, once. */
  failOnce(table: string, error: { message: string; code?: string }): void {
    this.failNext.set(table, error);
  }

  from(table: string) {
    return {
      select: (columns?: string) =>
        new Query(this, { kind: 'select', table, filters: [] }).select(columns),
      update: (patch: Row) => new Query(this, { kind: 'update', table, filters: [], patch }),
      upsert: (rows: Row | Row[], _options?: unknown) =>
        new Query(this, {
          kind: 'upsert',
          table,
          filters: [],
          inserted: Array.isArray(rows) ? rows : [rows],
        }),
    };
  }
}

/** The queue module is typed against SupabaseClient; the fake satisfies the slice it uses. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function asClient(fake: FakeSupabase): any {
  return fake;
}
