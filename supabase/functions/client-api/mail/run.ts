// ---------------------------------------------------------------------------
// Runs one mail op through the tool layer.
//
// What `handleToolsCall` wraps around an executor on the MCP path, and what
// this does instead:
//
//   scope check          the op table + the viewer gate (a human, not a key)
//   schema validation    the op's closed argument list (mail/ops.ts)
//   action cap           NONE: manual operations are not metered
//   rate limit           the in-isolate bucket in the router; no activity_log
//   activity_log write   NONE: those rows feed the MCP limiters
//   idempotency ledger   the SAME ledger, claimed and settled here, so a
//                        retried Send cannot double-send
//
// Every executor call runs inside `firstPartyContext`, which is what routes
// its IMAP connects through the pool, serves the cached inbox row, and asks
// list/search for `is_flagged`.
// ---------------------------------------------------------------------------

import { firstPartyContext, type FirstPartyContext } from "../../mcp-server/first-party.ts";
import { buildReplayEnvelope } from "../../mcp-server/idempotency-replay.ts";
import { settleAfterResponse } from "../../mcp-server/request-pipeline.ts";
import { ApiError, executorError, forbidden, invalidRequest } from "../errors.ts";
import { type ImapPool, poolKey, type PoolableClient } from "../imap-pool.ts";
import type { ApiKeyRow, ExecutorOutcome, InboxRow, McpSeam } from "../seam.ts";
import { type ExecutorCall, OPS, type OpSpec } from "./ops.ts";
import { mailboxStatus } from "./status.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Wall-clock ceilings per op kind. The provider call is not cancelled; the response is. */
const TIMEOUT_MS: Record<OpSpec["kind"], number> = { read: 55_000, write: 90_000, send: 120_000 };

/** How long before expiry a cached OAuth row is treated as stale (the tool layer refreshes at 5 min). */
const TOKEN_FRESH_MARGIN_MS = 6 * 60_000;

export interface MailRequest {
  op: string;
  inbox_id?: string;
  args?: Record<string, unknown>;
}

export interface OpTimings {
  /** Wall time inside executors (their own database reads included). */
  providerMs: number;
  /** Wall time dialling IMAP (zero on a pooled reuse). */
  connectMs: number;
  imapDials: number;
  imapReuses: number;
}

export interface MailEnv {
  mcp: McpSeam;
  pool: ImapPool<PoolableClient>;
  inboxes: InboxRowCache;
  /** The workspace's hidden key, marked `firstPartyHuman`. */
  apiKey: ApiKeyRow;
  /** May this caller run write and send ops. */
  canWrite: boolean;
  /** Runs a task after the response; failures go to `onBackgroundError`. */
  onBackgroundError?: (name: string, error: unknown) => void;
  /**
   * Replaces the socket dial. Tests only: it is how the scripted fake IMAP
   * server stands in for a real one. Production leaves it unset, and the dial
   * is `ImapClient`'s own connect-with-retry.
   */
  imapDial?: (cfg: { host: string; port: number; email: string }) => Promise<PoolableClient>;
  now?: () => number;
}

export type MailOutcome =
  | { type: "json"; result: unknown; timings: OpTimings }
  | { type: "binary"; body: Uint8Array<ArrayBuffer>; contentType: string; filename: string; timings: OpTimings };

/** `inboxes` rows, per isolate, for at most `ttlMs`. Keyed by inbox id, checked against the workspace. */
export class InboxRowCache {
  readonly #rows = new Map<string, { row: InboxRow; at: number }>();
  constructor(
    private readonly ttlMs = 60_000,
    private readonly now: () => number = () => Date.now(),
    private readonly max = 2000,
  ) {}

  get(inboxId: string, workspaceId: string): InboxRow | null {
    const hit = this.#rows.get(inboxId);
    if (!hit) return null;
    if (this.now() - hit.at >= this.ttlMs || hit.row.workspace_id !== workspaceId) {
      this.#rows.delete(inboxId);
      return null;
    }
    // An OAuth row about to need a refresh is re-read: the refreshed token is
    // persisted to the row, and a stale copy would refresh on every call.
    const expires = hit.row.oauth_token_expires_at;
    if (hit.row.oauth_access_token && expires) {
      const at = new Date(expires).getTime();
      if (!Number.isFinite(at) || at - this.now() < TOKEN_FRESH_MARGIN_MS) {
        this.#rows.delete(inboxId);
        return null;
      }
    }
    return hit.row;
  }

  remember(row: InboxRow): void {
    if (this.#rows.size >= this.max) this.#rows.clear();
    this.#rows.set(row.id, { row, at: this.now() });
  }

  forget(inboxId: string): void {
    this.#rows.delete(inboxId);
  }
}

function newTimings(): OpTimings {
  return { providerMs: 0, connectMs: 0, imapDials: 0, imapReuses: 0 };
}

/** The tool-layer context for one executor call. `flow` identifies the op to the pool. */
export function firstPartyFor(
  env: MailEnv,
  options: { scope: string; flow: object; flagged?: boolean; fresh?: boolean; human?: boolean; timings: OpTimings },
): FirstPartyContext {
  return {
    includeFlagged: options.flagged === true,
    // The signed-in human only, never the assistant: an edited reply To list
    // is honoured, and a multi-select move/delete is not turned into a
    // `bulk_review_mode` plan (the person clicking is the reviewer).
    replyRecipients: options.human === true,
    humanBulk: options.human === true,
    // Human and assistant alike: both need the Trash ids to undo a delete.
    trashIds: true,
    inboxRow: options.fresh ? undefined : (id, workspaceId) => env.inboxes.get(id, workspaceId),
    rememberInboxRow: (row) => env.inboxes.remember(row as InboxRow),
    imapConnect: async <C>(
      cfg: { host: string; port: number; email: string; password: string; security?: "tls" | "starttls" },
      dial: () => Promise<C>,
    ): Promise<C> => {
      const key = await poolKey(options.scope, cfg);
      let dialled = false;
      const client = await env.pool.checkout(key, options.flow, async () => {
        dialled = true;
        // Counted when attempted, so a refused dial is visible in the log line.
        options.timings.imapDials++;
        const started = performance.now();
        try {
          return env.imapDial
            ? await env.imapDial(cfg)
            : await dial() as unknown as PoolableClient;
        } finally {
          options.timings.connectMs += performance.now() - started;
        }
      });
      if (!dialled) options.timings.imapReuses++;
      return client as unknown as C;
    },
  };
}

interface ToolResultShape {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** The executor's result as the JSON the client reads: structured when given, else its text parsed. */
export function resultJson(result: unknown): unknown {
  const shaped = (result ?? {}) as ToolResultShape;
  if (shaped.structuredContent && typeof shaped.structuredContent === "object") return shaped.structuredContent;
  const text = shaped.content?.find((block) => block?.type === "text" && typeof block.text === "string")?.text;
  if (text === undefined) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

export function resultText(result: unknown): string {
  const shaped = (result ?? {}) as ToolResultShape;
  const text = shaped.content?.find((block) => block?.type === "text" && typeof block.text === "string")?.text;
  if (typeof text !== "string") return "The request could not be completed.";
  // Several executors answer an error as a JSON document with a `message`.
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed.message === "string") return parsed.message;
    } catch { /* plain text */ }
  }
  return text;
}

function isErrorOutcome(outcome: ExecutorOutcome): boolean {
  return outcome.logStatus !== "success" || (outcome.result as ToolResultShape | null)?.isError === true;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ApiError(504, "timeout", "The mail provider took too long. Try again.", { retryable: true })),
      ms,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Run one executor under the first-party context and the idempotency ledger.
 * Returns the executor's outcome, or throws the ApiError for the caller.
 */
export async function runExecutor(
  env: MailEnv,
  call: ExecutorCall,
  options: {
    inboxId: string | null;
    flow: object;
    flagged?: boolean;
    fresh?: boolean;
    idempotencyKey?: string;
    timings: OpTimings;
    apiKey?: ApiKeyRow;
  },
): Promise<ExecutorOutcome> {
  const apiKey = options.apiKey ?? env.apiKey;
  const args: Record<string, unknown> = { ...call.args };
  if (options.inboxId) args["inbox_id"] = options.inboxId;
  if (options.idempotencyKey !== undefined) args["idempotency_key"] = options.idempotencyKey;

  const context = firstPartyFor(env, {
    scope: options.inboxId ?? `workspace:${apiKey.workspace_id}`,
    flow: options.flow,
    flagged: options.flagged,
    fresh: options.fresh,
    human: apiKey.firstPartyHuman === true,
    timings: options.timings,
  });

  return await firstPartyContext.run(context, async () => {
    const claim = options.idempotencyKey !== undefined
      ? await env.mcp.claimOutboundIdempotency(call.tool, args, apiKey)
      : null;
    if (claim && claim.kind !== "proceed") {
      if (claim.kind === "replay") {
        const envelope = buildReplayEnvelope({
          key: claim.key,
          status: claim.status as "succeeded",
          approvalId: claim.approvalId,
          result: claim.result,
          isMutation: !["email_send", "email_reply", "email_forward", "draft_send", "schedule_create"].includes(
            call.tool,
          ),
        });
        if (claim.status === "succeeded") {
          // The first attempt worked and its response was lost: answer with
          // the original outcome, marked as a replay.
          return {
            result: { structuredContent: { ...(claim.result ?? {}), idempotent_replay: true } },
            logStatus: "success" as const,
            logErrorCode: null,
          };
        }
        throw new ApiError(409, "conflict", String(envelope["message"]), {
          toolCode: `idempotency_${claim.status}`,
        });
      }
      if (claim.kind === "processing") {
        throw new ApiError(409, "conflict", "This request is already being processed.", {
          retryable: true,
          toolCode: "idempotency_in_progress",
        });
      }
      if (claim.kind === "conflict") {
        throw new ApiError(409, "conflict", "This idempotency_key was already used for a different request.", {
          toolCode: "idempotency_key_conflict",
        });
      }
      if (claim.kind === "invalid") throw invalidRequest(claim.message);
      throw new ApiError(503, "provider_error", "Could not establish retry protection. Nothing was sent.", {
        retryable: true,
        toolCode: "idempotency_unavailable",
      });
    }

    const started = performance.now();
    let outcome: ExecutorOutcome | null;
    try {
      outcome = await env.mcp.dispatchExecutor(call.tool, args, apiKey);
    } catch (error) {
      options.timings.providerMs += performance.now() - started;
      // The executor threw past its own error handling. Settle the claim as
      // "unknown": the provider may or may not have acted.
      void settleAfterResponse(
        [["idempotency", () =>
          env.mcp.completeOutboundIdempotency(claim, call.tool, apiKey.id, "error", "-32603")]],
        env.onBackgroundError ?? (() => {}),
      );
      if (options.inboxId) env.inboxes.forget(options.inboxId);
      if (error instanceof Error && error.name === "OutlookNoMailboxError") {
        throw new ApiError(409, "reconnect_required", "This Outlook account has no mailbox.", {
          toolCode: "outlook_no_mailbox",
        });
      }
      if (error instanceof Error && error.name === "ImapPoolBusyError") {
        throw new ApiError(503, "provider_error", "The mailbox is busy. Try again.", {
          retryable: true,
          toolCode: "imap_pool_busy",
        });
      }
      throw new ApiError(502, "provider_error", "The mail provider request failed. Try again.", {
        retryable: true,
        toolCode: "unhandled",
      });
    }
    options.timings.providerMs += performance.now() - started;
    if (outcome === null) throw invalidRequest(`Unsupported operation '${call.tool}'.`);

    if (claim) {
      const wrapped = { jsonrpc: "2.0", id: null, result: outcome.result };
      const settled = outcome;
      // Bookkeeping never blocks the response (EdgeRuntime.waitUntil when
      // present); a send's claim stays "processing" until this lands, which
      // is the safe side: a racing retry is told to wait, not sent again.
      void settleAfterResponse(
        [["idempotency", () =>
          env.mcp.completeOutboundIdempotency(
            claim,
            call.tool,
            apiKey.id,
            settled.logStatus,
            settled.logErrorCode,
            env.mcp.pendingApprovalIdFromToolResult(wrapped),
            env.mcp.isPartialToolResult(wrapped),
            env.mcp.replaySnapshotFromToolResult(wrapped),
          )]],
        env.onBackgroundError ?? (() => {}),
      );
    }

    if (isErrorOutcome(outcome)) {
      const code = outcome.logErrorCode;
      if (options.inboxId && (code === "auth_failed" || code === "inbox_not_found")) {
        env.inboxes.forget(options.inboxId);
      }
    }
    return outcome;
  });
}

function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
  const bin = atob(data);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Validate a `/mail` request body down to its op spec and executor calls. */
export function planMailRequest(request: MailRequest): {
  spec: OpSpec;
  calls: ExecutorCall[];
  inboxId: string | null;
  idempotencyKey: string | undefined;
} {
  if (typeof request.op !== "string" || !Object.hasOwn(OPS, request.op)) {
    throw invalidRequest("Unknown op.");
  }
  const spec = OPS[request.op];
  const args = request.args ?? {};
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw invalidRequest(`${request.op}: 'args' must be an object.`);
  }
  let inboxId: string | null = null;
  if (request.inbox_id !== undefined && request.inbox_id !== null) {
    if (typeof request.inbox_id !== "string" || !UUID_RE.test(request.inbox_id)) {
      throw invalidRequest(`${request.op}: 'inbox_id' must be an inbox id.`);
    }
    inboxId = request.inbox_id.toLowerCase();
  }
  if (spec.needsInbox && inboxId === null) throw invalidRequest(`${request.op}: 'inbox_id' is required.`);

  let idempotencyKey: string | undefined;
  if (spec.idempotency !== "none") {
    const raw = (args as Record<string, unknown>)["idempotency_key"];
    if (raw !== undefined && raw !== null) {
      if (typeof raw !== "string" || raw.trim().length === 0 || raw.length > 200) {
        throw invalidRequest(`${request.op}: 'idempotency_key' must be a non-empty string of at most 200 characters.`);
      }
      idempotencyKey = raw;
    }
    if (spec.idempotency === "required" && idempotencyKey === undefined) {
      throw invalidRequest(`${request.op}: 'idempotency_key' is required.`);
    }
  }
  return { spec, calls: spec.build(args as Record<string, unknown>), inboxId, idempotencyKey };
}

/**
 * Run one `/mail` op. Throws ApiError; never returns an error result.
 * `flow` lets a batch give each call its own identity to the IMAP pool.
 */
export async function runMailOp(
  env: MailEnv,
  request: MailRequest,
  flow: object = {},
  /** Filled in as the op runs, so the caller still has them when the op throws. */
  timings: OpTimings = newTimings(),
): Promise<MailOutcome> {
  const { spec, calls, inboxId, idempotencyKey } = planMailRequest(request);
  if (spec.kind !== "read" && !env.canWrite) {
    throw forbidden("Your role in this workspace is read-only.");
  }

  const work = (async (): Promise<MailOutcome> => {
    if (spec.special === "status") {
      const started = performance.now();
      const context = firstPartyFor(env, { scope: inboxId!, flow, timings });
      try {
        const result = await firstPartyContext.run(
          context,
          () => mailboxStatus(env.mcp, env.apiKey, inboxId!, calls[0].args["folders"] as string[]),
        );
        return { type: "json", result, timings };
      } finally {
        timings.providerMs += performance.now() - started;
      }
    }

    const results: unknown[] = [];
    for (const call of calls) {
      const outcome = await runExecutor(env, call, {
        inboxId,
        flow,
        flagged: spec.flagged,
        fresh: spec.kind === "send",
        // Two executor calls must not share one ledger row.
        idempotencyKey: idempotencyKey === undefined
          ? undefined
          : calls.length > 1
          ? `${idempotencyKey}:${results.length}`
          : idempotencyKey,
        timings,
      });
      if (isErrorOutcome(outcome)) throw executorError(outcome.logErrorCode, resultText(outcome.result));
      results.push(outcome.result);
    }

    if (spec.special === "attachment") {
      const meta = resultJson(results[0]) as {
        filename?: string;
        mime_type?: string;
        data?: string | null;
      };
      if (typeof meta.data !== "string") {
        throw new ApiError(502, "provider_error", "The attachment could not be retrieved.", { retryable: true });
      }
      return {
        type: "binary",
        body: decodeBase64(meta.data),
        contentType: typeof meta.mime_type === "string" && meta.mime_type ? meta.mime_type : "application/octet-stream",
        filename: typeof meta.filename === "string" && meta.filename ? meta.filename : "attachment",
        timings,
      };
    }

    const json = results.map(resultJson);
    if (!spec.combine) return { type: "json", result: json[0], timings };
    let provider: string | null = null;
    if (spec.needsProvider && inboxId) {
      // The executor that just ran loaded (and cached) the row; the lookup
      // below is the fallback for a cache that has since been cleared.
      provider = env.inboxes.get(inboxId, env.apiKey.workspace_id)?.provider ?? null;
      if (provider === null) {
        const context = firstPartyFor(env, { scope: inboxId, flow, timings });
        provider = (await firstPartyContext.run(context, () => env.mcp.resolveInbox(inboxId, env.apiKey))
          .catch(() => null))?.provider ?? null;
      }
    }
    return { type: "json", result: spec.combine(json, calls, { provider }), timings };
  })();

  return await withTimeout(work, TIMEOUT_MS[spec.kind]);
}
