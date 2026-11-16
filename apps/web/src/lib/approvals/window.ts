/**
 * How long a held send stays decidable, per workspace
 * (`workspaces.approval_window_hours`, migration 20261114110000).
 *
 * The choices mirror the DB CHECK and mcp-server's APPROVAL_WINDOW_HOURS
 * (supabase/functions/mcp-server/mcp-app-approvals.ts), which sets each held
 * send's `expires_at` from this value when it is queued.
 */
export const APPROVAL_WINDOW_HOURS = [24, 72, 168, 336] as const;

export type ApprovalWindowHours = (typeof APPROVAL_WINDOW_HOURS)[number];

export const DEFAULT_APPROVAL_WINDOW_HOURS: ApprovalWindowHours = 24;

export function isApprovalWindowHours(value: unknown): value is ApprovalWindowHours {
  return typeof value === 'number' && (APPROVAL_WINDOW_HOURS as readonly number[]).includes(value);
}

/** The stored value, or the 24h default for anything that is not a valid window. */
export function storedApprovalWindowHours(value: unknown): ApprovalWindowHours {
  return isApprovalWindowHours(value) ? value : DEFAULT_APPROVAL_WINDOW_HOURS;
}
