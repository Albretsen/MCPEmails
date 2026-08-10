/**
 * Tolerance shims for approval columns that are still in flight.
 *
 * The MCP Apps work splits schema and application code across separate
 * changes: `send_approvals.decided_via`, `send_approvals.expires_at` and
 * `inboxes.send_review_mode` are added by a migration that may land after
 * this code. Rather than hard-failing every read and write until then, the
 * helpers below let a statement degrade to the pre-migration shape.
 *
 * Reads are already safe (`select('*')` simply omits the column). Writes and
 * explicit column lists are not, so they route through `runTolerantly`.
 *
 * DELETE THESE SHIMS once the migration is applied everywhere; they exist
 * only to keep the two changes independently deployable.
 */

/** Columns this codebase writes/selects that may not exist yet. */
export const PENDING_APPROVAL_COLUMNS = ['decided_via'] as const;
export const PENDING_INBOX_COLUMNS = ['send_review_mode'] as const;

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * True when a PostgREST/Postgres error means "that column does not exist".
 * PostgREST reports a schema-cache miss as PGRST204; Postgres itself uses
 * 42703 (undefined_column).
 */
export function isUnknownColumnError(error: any): boolean {
  if (!error) return false;
  if (error.code === '42703' || error.code === 'PGRST204') return true;
  const message = String(error.message ?? '');
  return (
    /column .* does not exist/i.test(message) ||
    /could not find the '.+' column/i.test(message)
  );
}

/**
 * Runs a Supabase statement built from `patch`. If it fails purely because one
 * of `optional` does not exist yet, it retries once without those keys.
 */
export async function runTolerantly<T>(
  patch: Record<string, unknown>,
  optional: readonly string[],
  run: (patch: Record<string, unknown>) => Promise<{ data: T; error: any }>,
): Promise<{ data: T; error: any }> {
  const first = await run(patch);
  if (!first.error || !isUnknownColumnError(first.error)) return first;
  const reduced = { ...patch };
  let dropped = false;
  for (const key of optional) {
    if (key in reduced) {
      delete reduced[key];
      dropped = true;
    }
  }
  if (!dropped) return first;
  console.warn('[approvals] Retrying without pending columns:', optional.join(', '));
  return run(reduced);
}

/**
 * Same idea for an explicit `select()` list: try the full list, fall back to
 * the list without the not-yet-migrated columns.
 */
export async function selectTolerantly<T>(
  columns: string[],
  optional: readonly string[],
  run: (columns: string) => Promise<{ data: T; error: any }>,
): Promise<{ data: T; error: any }> {
  const first = await run(columns.join(', '));
  if (!first.error || !isUnknownColumnError(first.error)) return first;
  const reduced = columns.filter((c) => !optional.includes(c));
  if (reduced.length === columns.length) return first;
  console.warn('[approvals] Re-selecting without pending columns:', optional.join(', '));
  return run(reduced.join(', '));
}
