import type { PostgrestError } from '@supabase/supabase-js';

/**
 * PostgREST row-cap escape hatch.
 *
 * Our PostgREST is configured with `db-max-rows = 1000`. Any `.select()` that
 * returns rows is silently truncated at that many rows: no error is raised, and
 * an explicit larger `.limit()` does NOT raise the ceiling. So a query whose
 * result is *scanned* or *counted* in JS is correct only while the table stays
 * under 1,000 matching rows, then quietly starts lying.
 *
 * Only two things defeat the cap: aggregating in SQL, or paging with `.range()`.
 * This helper is the `.range()` half: hand it a callback that applies the range
 * to your query and it drains every page:
 *
 *   const { data, error } = await selectAllRows((from, to) =>
 *     db.from('inboxes').select('id').eq('workspace_id', id).range(from, to),
 *   );
 *
 * The callback is invoked once per page, so keep the filters inside it stable,
 * and give the query a TOTAL ORDER (an `.order()` on a unique column). OFFSET
 * paging over an unordered read is free to return rows in a different order per
 * page, which can repeat some and skip others: the exact failure this helper
 * exists to prevent.
 */

/**
 * Rows requested per page. Must never exceed the server's `db-max-rows`, or the
 * short-page termination check below would mistake a server-truncated page for
 * the last page and we would be back to silently dropping rows.
 */
const PAGE_SIZE = 1000;

/**
 * Safety stop, so a misbehaving query can never spin a serverless invocation
 * forever. 100 pages = 100k rows, far beyond any workspace-scoped result set we
 * page here.
 */
const MAX_PAGES = 100;

/** Drain every page of a `.range()`-able select. */
export async function selectAllRows<Row>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: Row[] | null; error: PostgrestError | null }>,
): Promise<{ data: Row[]; error: PostgrestError | null }> {
  const rows: Row[] = [];

  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
    const from = pageIndex * PAGE_SIZE;
    const { data, error } = await page(from, from + PAGE_SIZE - 1);

    // Return what we have alongside the error and let the caller decide: some
    // call sites fail open, others must treat a partial read as a hard failure.
    if (error) return { data: rows, error };

    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return { data: rows, error: null };
  }

  console.error('[selectAllRows] page cap reached; result may be incomplete');
  return { data: rows, error: null };
}
