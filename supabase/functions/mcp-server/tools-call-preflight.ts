// ---------------------------------------------------------------------------
// The tools/call pre-handler reads, answered by one RPC.
//
// Measured 2026-10-19/20: pre_ms p50 ~560-590 ms, 44% of total time for
// non-IMAP calls. The function runs in us-east-1 and Postgres in eu-north-1,
// about 124 ms per round trip, and a metered call paid four in sequence before
// its handler: the key lookup; the limiter counts, plan row and allowance row;
// the owner's entitlement; the reservation. `mcp_tools_call_preflight`
// (migration 20261020100000) returns the first three in one.
//
// It returns raw rows and counts only. This module checks their shape and
// hands them to index.ts, which feeds them into the same checkRateLimit and
// checkPlanQuota code the per-query path runs, so the decisions cannot drift
// between the two paths. Anything unexpected (an RPC error, a missing
// function, a malformed answer) means "use the per-query path", which is the
// pre-existing behaviour and fails open exactly as it always did.
//
// No cache. Every value here gates a call (revocation, plan ceiling, cap), so
// each request reads it fresh; the saving comes from asking once, not from
// remembering.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/** What the RPC answered, after its shape was checked. */
export type ToolsCallPreflight =
  | { kind: "no_key" }
  | {
    kind: "key";
    key: Row;
    /** One count per window start the caller passed, in the same order. */
    keyCounts: number[];
    /** null: no workspace row, which checkPlanQuota fails open on. */
    workspace: Row | null;
    entitlement: { kind?: unknown; expires_at?: unknown } | null;
    /** null exactly when `workspace` is null. */
    workspaceCount: number | null;
    /** The workspace_action_allowance() row; null when not asked for or none. */
    allowance: Row | null;
    allowanceRequested: boolean;
    /**
     * mcp_tools_call_gate only: the reservation it made, if it made one. Null
     * when none was asked for, the workspace is not metered, or the answer
     * came from the older preflight.
     */
    reservation: GateReservation | null;
    /** mcp_tools_call_gate only: true when it already handled last_used_at. */
    lastUsedHandled: boolean;
  };

/**
 * A reservation mcp_tools_call_gate made with `reserve_action_usage()` before
 * the edge function had decided anything. It is used only when the resolved
 * tool, cap and window match what the edge function would have reserved
 * itself, and released otherwise. `row` is that function's answer; `error` is
 * set instead when it raised, which the separate call treated as fail-open.
 */
export interface GateReservation {
  toolName: string;
  cap: number;
  periodStart: string;
  periodEnd: string;
  row: { reservation_id: string | null; allowed: boolean; used_actions: number } | null;
  error: { message: string; code: string | null } | null;
}

/** The RPC's parameters. Window starts are ISO strings from the caller's clock. */
export function preflightParams(
  keyHash: string,
  keyWindowStarts: string[],
  workspaceWindowStart: string,
  includeAllowance: boolean,
): Record<string, unknown> {
  return {
    p_key_hash: keyHash,
    p_key_window_starts: keyWindowStarts,
    p_workspace_window_start: workspaceWindowStart,
    p_include_allowance: includeAllowance,
  };
}

/** The tools/call gate RPC (migration 20261020214737). */
export const GATE_RPC = "mcp_tools_call_gate";

/**
 * mcp_tools_call_gate's parameters: the preflight's, plus the tool to reserve
 * against (null: reserve nothing) and the meter version to reserve under.
 */
export function gateParams(
  keyHash: string,
  keyWindowStarts: string[],
  workspaceWindowStart: string,
  includeAllowance: boolean,
  reserveToolName: string | null,
  meterVersion: number,
): Record<string, unknown> {
  return {
    ...preflightParams(keyHash, keyWindowStarts, workspaceWindowStart, includeAllowance),
    p_reserve_tool_name: includeAllowance ? reserveToolName : null,
    p_meter_version: meterVersion,
  };
}

/**
 * The reservation id inside a gate answer, read as leniently as possible.
 *
 * Called on ANY answer, including one parsePreflight rejects: a reservation
 * that exists in the database must be released even when the rest of the
 * answer is unusable, or it would hold one unit of the cap for 15 minutes.
 */
export function reservationIdIn(data: unknown): string | null {
  if (!isRow(data) || !isRow(data.reservation) || !isRow(data.reservation.row)) return null;
  const id = data.reservation.row.reservation_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** undefined: present but not the expected shape. */
function parseReservation(value: unknown): GateReservation | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isRow(value)) return undefined;
  const { tool_name, cap, period_start, period_end } = value;
  if (typeof tool_name !== "string" || !isCount(cap)) return undefined;
  if (typeof period_start !== "string" || typeof period_end !== "string") return undefined;
  const terms = { toolName: tool_name, cap, periodStart: period_start, periodEnd: period_end };
  if (typeof value.error === "string") {
    return {
      ...terms,
      row: null,
      error: { message: value.error, code: typeof value.error_code === "string" ? value.error_code : null },
    };
  }
  const row = value.row ?? null;
  if (row === null) return { ...terms, row: null, error: null };
  if (!isRow(row) || typeof row.allowed !== "boolean" || !isCount(row.used_actions)) return undefined;
  const id = row.reservation_id ?? null;
  if (id !== null && typeof id !== "string") return undefined;
  return { ...terms, row: { reservation_id: id, allowed: row.allowed, used_actions: row.used_actions }, error: null };
}

const isRow = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * The RPC's answer, or null when it is not the shape this code was written
 * against. Null sends the caller down the per-query path, so a mismatch
 * between a deployed function and an applied migration costs latency, never a
 * wrong gate decision.
 */
export function parsePreflight(
  data: unknown,
  expectedWindows: number,
  includeAllowance: boolean,
): ToolsCallPreflight | null {
  if (!isRow(data) || !("key" in data)) return null;
  if (data.key === null) return { kind: "no_key" };
  const key = data.key;
  if (!isRow(key) || typeof key.id !== "string" || typeof key.workspace_id !== "string") return null;
  if (typeof key.key_hash !== "string") return null;

  const keyCounts = data.key_counts;
  if (!Array.isArray(keyCounts) || keyCounts.length !== expectedWindows || !keyCounts.every(isCount)) {
    return null;
  }

  const workspace = data.workspace ?? null;
  if (workspace !== null && !isRow(workspace)) return null;
  const workspaceCount = data.workspace_count ?? null;
  if (workspace !== null && !isCount(workspaceCount)) return null;

  const entitlement = data.entitlement ?? null;
  if (entitlement !== null && !isRow(entitlement)) return null;

  const allowance = data.allowance ?? null;
  if (allowance !== null && !isRow(allowance)) return null;

  const reservation = parseReservation(data.reservation);
  if (reservation === undefined) return null;

  return {
    kind: "key",
    key,
    keyCounts,
    workspace,
    entitlement,
    workspaceCount: workspace === null ? null : workspaceCount as number,
    allowance: includeAllowance ? allowance : null,
    allowanceRequested: includeAllowance,
    reservation,
    lastUsedHandled: typeof data.last_used_stamped === "boolean",
  };
}

/** PostgREST's code for "no such function": the migration is not applied yet. */
export const RPC_NOT_FOUND_CODE = "PGRST202";

/**
 * How long one isolate stops asking after the function was reported missing.
 * Long enough that a deploy ahead of its migration pays the extra round trip
 * about once a minute per isolate, short enough that applying the migration
 * takes effect without a redeploy.
 */
export const PREFLIGHT_MISSING_BACKOFF_MS = 60_000;

/**
 * Per-isolate: until when the RPC is skipped because it was reported missing.
 * An object rather than a `let` so the pipeline tests can reset it.
 */
export const preflightAvailability = { missingUntil: 0 };

/** True while the RPC is known to be missing in this isolate. */
export function preflightSkipped(nowMs = Date.now()): boolean {
  return nowMs < preflightAvailability.missingUntil;
}

/** Called with the RPC's error code; starts the backoff only for "no such function". */
export function notePreflightError(code: string | undefined, nowMs = Date.now()): void {
  if (code === RPC_NOT_FOUND_CODE) preflightAvailability.missingUntil = nowMs + PREFLIGHT_MISSING_BACKOFF_MS;
}
