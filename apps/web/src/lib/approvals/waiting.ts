/**
 * What counts as waiting, for every count of approvals on the dashboard: the
 * sidebar, the "N waiting" link on an automation row, and the filtered queue.
 * All of them read the one client array from GET /api/approvals, so they cannot
 * disagree. Expired rows keep status 'pending' until the retention job retires
 * them, so status alone would overcount.
 */

/** GET /api/approvals returns at most this many pending rows. */
export const APPROVAL_LIST_LIMIT = 100;

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

type WaitingRow = {
  status?: unknown;
  expires_at?: unknown;
  created_at?: unknown;
  rule_id?: unknown;
};

function expiresAtMs(row: WaitingRow): number {
  if (typeof row.expires_at === 'string') return Date.parse(row.expires_at);
  // Matches the retention job: a row with no expiry lasts 24 hours.
  if (typeof row.created_at === 'string') return Date.parse(row.created_at) + DEFAULT_TTL_MS;
  return Number.NaN;
}

export function waitingApprovals<T extends WaitingRow>(rows: readonly T[], now: number = Date.now()): T[] {
  return rows.filter((row) => {
    if (row.status !== undefined && row.status !== 'pending') return false;
    const expires = expiresAtMs(row);
    return Number.isNaN(expires) || expires > now;
  });
}

export function waitingForRule<T extends WaitingRow>(rows: readonly T[], ruleId: string, now: number = Date.now()): T[] {
  return waitingApprovals(rows, now).filter((row) => row.rule_id === ruleId);
}

/** A full page may mean there are more, so the number says so. */
export function waitingLabel(count: number, listLength: number): string | undefined {
  if (count <= 0) return undefined;
  return listLength >= APPROVAL_LIST_LIMIT ? `${count}+` : String(count);
}
