/* Contract between `client-api` (the server core) and the assistant module
 * (`./assistant/mod.ts`). Types only: this file must not import anything, so
 * either side can depend on it without pulling the other in.
 *
 * The assistant module exports:
 *   handleAssistantRun(req: Request, deps: AssistantDeps): Promise<Response>
 * and client-api's router calls it for `POST /assistant/run` after auth, the
 * workspace gate and the rate limiter have passed.
 */

export interface SenderIdentity {
  email_address: string;
  display_name: string | null;
  is_default: boolean;
}

/** Same shape as `Inbox` in apps/client/src/api/types.ts (the MCP `inbox_list` row). */
export interface Inbox {
  inbox_id: string;
  email_address: string;
  display_name: string;
  provider: "gmail" | "outlook" | "fastmail" | "imap";
  service: string | null;
  sender_identities: SenderIdentity[];
  sender_identity_status: "available" | "reconnect_required" | "unavailable";
}

export type PlanSlug = "free" | "personal" | "solo" | "pro";

/** Same shape as `AssistantAllowance` in apps/client/src/api/types.ts. Counts are RUNS. */
export interface AssistantAllowance {
  plan: PlanSlug;
  used: number;
  /** null = unlimited. */
  cap: number | null;
  remaining: number | null;
  /** ISO 8601, UTC. */
  period_start: string;
  resets_at: string;
  /** Hard ceiling on input+output tokens for one run. The loop must stop before exceeding it. */
  max_tokens_per_run?: number;
}

export interface ToolRunResult {
  /** The executor's result object (the MCP tool's structured result), or an error object. */
  result: unknown;
  isError: boolean;
}

/** Runs one MCP-layer tool as the signed-in human's workspace. Rejects (as
 *  `isError: true`, never by throwing) any tool or action outside the
 *  assistant allow-list: no send, no permanent delete, no folder mutation. */
export type ToolRunner = (name: string, args: Record<string, unknown>) => Promise<ToolRunResult>;

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema, taken from the MCP registry for the allowed tools. */
  inputSchema: Record<string, unknown>;
}

export interface AssistantUsage {
  input_tokens: number;
  output_tokens: number;
  cost_micro_usd: number;
  model: string;
}

export interface AllowanceReservation {
  ok: boolean;
  /** Present when ok. Pass it to finalizeAllowance exactly once. */
  reservationId?: string;
  allowance: AssistantAllowance;
}

export interface AssistantDeps {
  user: { id: string; email: string };
  workspaceId: string;
  inboxes: Inbox[];
  runTool: ToolRunner;
  toolSchemas: ToolSchema[];
  /** Reserves one run. `ok: false` means the allowance is exhausted: answer `allowance_exhausted`. */
  reserveAllowance(): Promise<AllowanceReservation>;
  /** Settles the reservation with real usage. Safe to call after the response has ended. */
  finalizeAllowance(reservationId: string, usage: AssistantUsage): Promise<void>;
  /** Function secrets (`OPENAI_API_KEY`, `ASSISTANT_PROVIDER`, ...). Never log the values. */
  env(name: string): string | undefined;
  /** Structured log line. Fields must be ids, sizes, timings and codes only: never mail content. */
  log(event: string, fields?: Record<string, unknown>): void;
}

export type HandleAssistantRun = (req: Request, deps: AssistantDeps) => Promise<Response>;
