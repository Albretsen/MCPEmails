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
import { type ImapPool, isLoginRefusal, isSearchThrottle, poolKey, type PoolableClient } from "../imap-pool.ts";
import type { ApiKeyRow, ExecutorOutcome, InboxRow, McpSeam } from "../seam.ts";
import { type HealthRow, type InboxHealth, reconnectMessage } from "./health.ts";
import { type ExecutorCall, OPS, type OpSpec } from "./ops.ts";
import { withFolderRoles } from "./roles.ts";
import { mailboxStatus } from "./status.ts";
import { mailThread, type ThreadArgs, type ThreadMemory } from "./thread.ts";
import { withThreadKeys } from "./thread-key.ts";

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
  /**
   * `method:ms` for each IMAP client call the op made, in order (capped).
   * Method NAMES from the source only: never an argument. It is what says
   * where an op's provider time went (one entry is roughly one round trip).
   */
  imapCalls?: string[];
}

/** Entries kept in `OpTimings.imapCalls` per request. */
const MAX_TRACED_CALLS = 48;

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
  /** What is known about each inbox without dialling it (mail/health.ts). */
  health?: InboxHealth;
  /** A login this request dialled was refused by the mail server: record it on the row. */
  onLoginRefused?: (inboxId: string) => void;
  /** A login this request dialled worked for an inbox whose row carries a refusal marker: clear it. */
  onLoginAccepted?: (inboxId: string) => void;
  /**
   * When this request arrived, as `pool.arrival()` taken at the top of the
   * handler: its place in every per-inbox IMAP queue it joins. Absent (tests,
   * the assistant): the moment each op reaches the pool.
   */
  arrival?: number;
  /** What the `thread` op remembers between calls (mail/thread.ts). Absent: nothing is remembered. */
  threads?: ThreadMemory;
  now?: () => number;
}

/**
 * Executors that change nothing in a mailbox. Every other executor may have
 * changed a flag, a folder or an id, so the `thread` op's remembered answers
 * for that inbox are dropped when one runs (human or assistant).
 */
const READ_ONLY_TOOLS = new Set([
  "email_list",
  "email_read",
  "email_read_batch",
  "email_search",
  "email_attachment",
  "folder_list",
  "inbox_list",
  "draft_list",
  "schedule_list",
  "signature_get",
  "contact_search",
]);

/** The server throttled a search: "slow down", not "broken" (imap-pool.ts `isSearchThrottle`). */
function isThrottledSearchResult(outcome: ExecutorOutcome): boolean {
  if (outcome.logErrorCode !== "provider_error") return false;
  const at = resultText(outcome.result).indexOf("UID SEARCH failed:");
  return at !== -1 && isSearchThrottle(new Error(resultText(outcome.result).slice(at)));
}

/**
 * Refuse, without contacting the mail host, an inbox that is already known to
 * need reconnecting: its row says so, or a login with the credentials it has
 * now was refused within the last few minutes (in this isolate or, through
 * the marker on the row, in any other). See mail/health.ts.
 */
export function assertReachable(env: MailEnv, inboxId: string | null): void {
  if (!inboxId || !env.health) return;
  const workspaceId = env.apiKey.workspace_id;
  const state = env.health.state(inboxId, workspaceId);
  if (state.status === "ok" || state.status_reason === "unavailable") return;
  if (state.status_reason === "no_mailbox") {
    throw new ApiError(409, "reconnect_required", "This Outlook account has no mailbox.", {
      toolCode: "outlook_no_mailbox",
    });
  }
  throw new ApiError(409, "reconnect_required", reconnectMessage(env.health.provider(inboxId, workspaceId)), {
    toolCode: "auth_failed",
  });
}

/**
 * The public error for an executor's error result. A refused credential gets
 * the sentence written for the person using the app (per provider and
 * credential type) in place of the tool layer's agent-facing text; `code` and
 * `tool_code` are what they always were. Everything else is `executorError`.
 */
export function mailError(env: MailEnv, inboxId: string | null, outcome: ExecutorOutcome): ApiError {
  if (isThrottledSearchResult(outcome)) {
    // Was a 502. The server-authored text is not passed on: it quotes the
    // mail server's own wording, and all the person needs is "wait a moment".
    return new ApiError(429, "rate_limited", "The mail server is limiting searches right now. Try again in a moment.", {
      retryable: true,
      toolCode: "imap_search_throttled",
      retryAfter: 15,
    });
  }
  if (outcome.logErrorCode !== "auth_failed") return executorError(outcome.logErrorCode, resultText(outcome.result));
  let provider = inboxId ? env.health?.provider(inboxId, env.apiKey.workspace_id) ?? null : null;
  // The row was never seen by this isolate's health map: the tool layer's own
  // text names the provider ("Unable to access the gmail inbox: ...").
  provider ??= /^Unable to [^:]{1,80} the ([a-z0-9_-]{1,32}) inbox:/.exec(resultText(outcome.result))?.[1] ?? null;
  return new ApiError(409, "reconnect_required", reconnectMessage(provider), { toolCode: "auth_failed" });
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
  options: {
    scope: string;
    flow: object;
    flagged?: boolean;
    fresh?: boolean;
    human?: boolean;
    /** The op addresses messages by UID only (see `OpSpec.uidOnly`). */
    uidOnly?: boolean;
    /** The op is the folder listing itself (see `OpSpec.freshList`). */
    freshList?: boolean;
    /** See `OpSpec.priority`. */
    priority?: "interactive" | "background";
    /** IMAP listing: octets of part one fetched per row for the preview (0: none). */
    previewBytes?: number;
    /** See `OpSpec.threads`. */
    threads?: boolean;
    timings: OpTimings;
  },
): FirstPartyContext {
  // One place in line for everything this op does on the connection.
  const order = { seq: env.arrival ?? env.pool.arrival(), cls: options.priority ?? "normal" as const };
  return {
    includeFlagged: options.flagged === true,
    // The signed-in human only, never the assistant: an edited reply To list
    // is honoured, and a multi-select move/delete is not turned into a
    // `bulk_review_mode` plan (the person clicking is the reviewer).
    replyRecipients: options.human === true,
    humanBulk: options.human === true,
    // Human and assistant alike: both need the Trash ids to undo a delete.
    trashIds: true,
    listPreviewBytes: options.previewBytes,
    threadHeaders: options.threads === true,
    inboxRow: options.fresh ? undefined : (id, workspaceId) => env.inboxes.get(id, workspaceId),
    rememberInboxRow: (row) => {
      env.inboxes.remember(row as InboxRow);
      env.health?.observe(row as HealthRow);
    },
    imapConnect: async <C>(
      cfg: { host: string; port: number; email: string; password: string; security?: "tls" | "starttls" },
      dial: () => Promise<C>,
    ): Promise<C> => {
      const key = await poolKey(options.scope, cfg);
      let dialled = false;
      // Only a dial made for ONE inbox is recorded against it (the scope is
      // the inbox id for every mail op; `workspace:...` for the inbox list).
      const inboxScope = UUID_RE.test(options.scope) ? options.scope : null;
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
      }, {
        reuseSelection: options.uidOnly === true,
        freshList: options.freshList === true,
        order,
        trace: (method, ms) => {
          const calls = (options.timings.imapCalls ??= []);
          if (calls.length < MAX_TRACED_CALLS && /^[A-Za-z]{1,40}$/.test(method)) calls.push(`${method}:${Math.round(ms)}`);
        },
      }).catch((error) => {
        // The server itself said no to a login made just now. (A refusal the
        // pool answered from memory dialled nothing and is not news.)
        if (dialled && inboxScope && isLoginRefusal(error)) {
          env.health?.noteRefused(inboxScope);
          env.onLoginRefused?.(inboxScope);
        }
        throw error;
      });
      if (dialled && inboxScope && env.health?.noteAccepted(inboxScope)) env.onLoginAccepted?.(inboxScope);
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
    uidOnly?: boolean;
    freshList?: boolean;
    priority?: "interactive" | "background";
    previewBytes?: number;
    threads?: boolean;
    timings: OpTimings;
    apiKey?: ApiKeyRow;
  },
): Promise<ExecutorOutcome> {
  const apiKey = options.apiKey ?? env.apiKey;
  assertReachable(env, options.inboxId);
  const args: Record<string, unknown> = { ...call.args };
  if (options.inboxId) args["inbox_id"] = options.inboxId;
  if (options.idempotencyKey !== undefined) args["idempotency_key"] = options.idempotencyKey;

  const context = firstPartyFor(env, {
    scope: options.inboxId ?? `workspace:${apiKey.workspace_id}`,
    flow: options.flow,
    flagged: options.flagged,
    fresh: options.fresh,
    uidOnly: options.uidOnly,
    freshList: options.freshList,
    priority: options.priority,
    previewBytes: options.previewBytes,
    threads: options.threads,
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
    const mutates = options.inboxId !== null && !READ_ONLY_TOOLS.has(call.tool);
    try {
      outcome = await env.mcp.dispatchExecutor(call.tool, args, apiKey);
    } catch (error) {
      if (mutates) env.threads?.forget(options.inboxId!);
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
    // Whatever the outcome: a failed move may still have moved some.
    if (mutates) env.threads?.forget(options.inboxId!);
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
      assertReachable(env, inboxId);
      const started = performance.now();
      const context = firstPartyFor(env, { scope: inboxId!, flow, priority: spec.priority, timings });
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

    if (spec.special === "thread") {
      assertReachable(env, inboxId);
      const started = performance.now();
      const context = firstPartyFor(env, {
        scope: inboxId!,
        flow,
        flagged: true,
        threads: true,
        uidOnly: true,
        priority: spec.priority,
        timings,
      });
      try {
        const result = await firstPartyContext.run(
          context,
          () =>
            mailThread(
              env.mcp,
              env.apiKey,
              inboxId!,
              calls[0].args as unknown as ThreadArgs,
              env.now,
              env.threads,
              // Gmail over IMAP searches All Mail on a second pooled connection
              // of this inbox (its own pool scope, so it stays parked there).
              (work) =>
                firstPartyContext.run(
                  firstPartyFor(env, {
                    scope: `${inboxId!}:all-mail`,
                    flow: {},
                    flagged: true,
                    threads: true,
                    uidOnly: true,
                    priority: spec.priority,
                    timings,
                  }),
                  work,
                ),
            ),
        );
        return { type: "json", result, timings };
      } finally {
        timings.providerMs += performance.now() - started;
      }
    }

    // `inboxes.provider`, for ops whose result depends on it. The executor that
    // just ran loaded (and cached) the row; the lookup is the fallback for a
    // cache that has since been cleared.
    const providerOf = async (): Promise<string | null> => {
      if (!inboxId) return null;
      const cached = env.inboxes.get(inboxId, env.apiKey.workspace_id)?.provider ?? null;
      if (cached !== null) return cached;
      const context = firstPartyFor(env, { scope: inboxId, flow, timings });
      return (await firstPartyContext.run(context, () => env.mcp.resolveInbox(inboxId, env.apiKey))
        .catch(() => null))?.provider ?? null;
    };

    const results: unknown[] = [];
    for (const call of calls) {
      const outcome = await runExecutor(env, call, {
        inboxId,
        flow,
        flagged: spec.flagged,
        uidOnly: spec.uidOnly,
        freshList: spec.freshList,
        priority: spec.priority,
        previewBytes: request.op === "list" && request.args?.["preview"] === false ? 0 : undefined,
        threads: spec.threads,
        fresh: spec.kind === "send",
        // Two executor calls must not share one ledger row.
        idempotencyKey: idempotencyKey === undefined
          ? undefined
          : calls.length > 1
          ? `${idempotencyKey}:${results.length}`
          : idempotencyKey,
        timings,
      });
      if (isErrorOutcome(outcome)) throw mailError(env, inboxId, outcome);
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
    if (spec.roles && inboxId) {
      const context = firstPartyFor(env, { scope: inboxId, flow, priority: spec.priority, timings });
      const started = performance.now();
      const withRoles = await firstPartyContext.run(
        context,
        () => withFolderRoles(env.mcp, env.apiKey, inboxId, json[0], (env.now ?? Date.now)()),
      );
      timings.providerMs += performance.now() - started;
      return { type: "json", result: withRoles, timings };
    }
    if (spec.threads) return { type: "json", result: withThreadKeys(json[0], await providerOf()), timings };
    if (!spec.combine) return { type: "json", result: json[0], timings };
    const provider = spec.needsProvider ? await providerOf() : null;
    return { type: "json", result: spec.combine(json, calls, { provider }), timings };
  })();

  return await withTimeout(work, TIMEOUT_MS[spec.kind]);
}
