/**
 * Shared vocabulary for the Active accounts roster.
 *
 * Deliberately its own module with no `'use client'` directive. A value
 * exported from a client module and imported by a Server Component does not
 * arrive as the value: React hands the server a client reference instead, so
 * `row.active_days >= STICKY_MIN_ACTIVE_DAYS` silently compared against
 * `undefined` and the summary card read 0 while the table's own filter found
 * 25. Constants that both sides need have to live outside the client boundary.
 */

import type { GrowthActiveWorkspaceRow } from '@/lib/analytics/growth-types';

/** Server-computed so the internal-domain list never reaches the browser. */
export type RosterRow = GrowthActiveWorkspaceRow & { is_internal: boolean };

/**
 * More than one active day: the page's single definition of an account that
 * came back. Someone who opened it twice is a different animal from someone
 * who tried it once and left, and at this stage that is the distinction worth
 * making. Used by the summary card and by the table's default filter, which is
 * why it cannot live in either of them.
 */
export const STICKY_MIN_ACTIVE_DAYS = 2;

/** Rows counting as returned, over whatever population is passed in. */
export function countReturned(rows: RosterRow[]): number {
  return rows.filter((row) => row.active_days >= STICKY_MIN_ACTIVE_DAYS).length;
}
