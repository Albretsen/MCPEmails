// ---------------------------------------------------------------------------
// client-api: the request handler.
//
//   GET  /session         one round trip to boot the app
//   POST /mail            { op, inbox_id, args } -> the executor's result JSON
//   POST /mail/batch      { calls: [...] } (<= 12) -> { results: [...] }
//   GET  /allowance       the assistant allowance
//   POST /assistant/run   text/event-stream (handled by ./assistant/mod.ts)
//   OPTIONS *             CORS preflight
//
// Order of work on every request, cheapest refusal first:
//   CORS -> route -> bearer token (verified locally) -> workspace membership
//   and the web_client_enabled gate (cached) -> rate limit (in memory) ->
//   the hidden workspace key (cached) -> the handler.
// A warm request therefore reaches its handler with ZERO database queries.
//
// LOGGING. One structured line per request: ids, the route, the op name,
// status, error code, timings, counts. Never a subject, an address, a body, a
// folder name, a search query or an error message from a provider. The line is
// built from a fixed set of fields below; nothing request-supplied is spread
// into it.
// ---------------------------------------------------------------------------

import type { AssistantAllowance, HandleAssistantRun, Inbox } from "./assistant-deps.ts";
import { buildAssistantDeps } from "./assistant-wiring.ts";
import { type AuthedUser, bearerToken, canWrite, type JwtVerifier, type Membership, type WorkspaceGate } from "./auth.ts";
import { corsHeaders, preflightResponse } from "./cors.ts";
import { ApiError, invalidRequest, toApiError } from "./errors.ts";
import type { ImapPool, PoolableClient } from "./imap-pool.ts";
import { parseBatch, runMailBatch } from "./mail/batch.ts";
import { OPS } from "./mail/ops.ts";
import { InboxRowCache, type MailEnv, type MailRequest, type OpTimings, resultJson, runExecutor, runMailOp } from "./mail/run.ts";
import type { LimitClass, RateLimiter } from "./rate-limit.ts";
import type { ApiKeyRow, McpSeam } from "./seam.ts";
import { planSlug, type Store, toAssistantAllowance } from "./store.ts";

export interface AppDeps {
  mcp: McpSeam;
  store: Store;
  verifier: JwtVerifier;
  gate: WorkspaceGate;
  limiter: RateLimiter;
  pool: ImapPool<PoolableClient>;
  /** Tests only: stands in for the IMAP socket dial (see MailEnv.imapDial). */
  imapDial?: MailEnv["imapDial"];
  inboxes?: InboxRowCache;
  /** Loads ./assistant/mod.ts. Kept lazy so mail routes never pay for it. */
  assistant?: () => Promise<HandleAssistantRun>;
  env?: (name: string) => string | undefined;
  log?: (event: string, fields: Record<string, unknown>) => void;
  now?: () => number;
}

const MAX_BODY_BYTES = 12 * 1024 * 1024;
const KEY_TTL_MS = 10 * 60_000;
const INBOX_LIST_TTL_MS = 60_000;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const VIEWER_SCOPES = ["read:email", "search:email"];

interface Timing {
  auth: number;
  db: number;
  provider: number;
}

// Which isolate answered, and how many requests it has answered. Random per
// isolate, carries nothing about the caller. It is what makes "was this warm?"
// and "did the IMAP pool get a chance?" answerable from the outside.
const ISOLATE_ID = crypto.randomUUID().slice(0, 8);
const ISOLATE_STARTED = performance.now();
let isolateSeq = 0;

function serverTiming(t: Timing, total: number, seq: number, fields: Record<string, unknown>): string {
  const f = (n: number) => (Math.round(n * 10) / 10).toString();
  // On a mail route: how many IMAP connections this request dialled and how
  // many it took from the pool, and the time spent dialling (part of provider).
  const imap = typeof fields["imap_dials"] === "number"
    ? `, connect;dur=${f(Number(fields["connect_ms"] ?? 0))}, imap;desc="${fields["imap_dials"]}:${fields["imap_reuses"] ?? 0}"` +
      (typeof fields["imap_calls"] === "string" ? `, calls;desc="${fields["imap_calls"]}"` : "")
    : "";
  return `auth;dur=${f(t.auth)}, db;dur=${f(t.db)}, provider;dur=${f(t.provider)}, total;dur=${f(total)}` +
    `${imap}, isolate;desc="${ISOLATE_ID}:${seq}"`;
}

function routeOf(pathname: string): string {
  const at = pathname.lastIndexOf("/client-api");
  const rest = at === -1 ? pathname : pathname.slice(at + "/client-api".length);
  const trimmed = rest.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

const ROUTES: Record<string, "GET" | "POST"> = {
  "/session": "GET",
  "/mail": "POST",
  "/mail/batch": "POST",
  "/allowance": "GET",
  "/assistant/run": "POST",
};

async function readJson(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ApiError(413, "invalid_request", "Request body is too large.");
  }
  let text: string;
  try {
    text = await req.text();
  } catch {
    throw invalidRequest("Could not read the request body.");
  }
  if (text.length > MAX_BODY_BYTES) throw new ApiError(413, "invalid_request", "Request body is too large.");
  try {
    return JSON.parse(text);
  } catch {
    throw invalidRequest("Request body must be JSON.");
  }
}

/** RFC 6266 / 5987: an ASCII fallback plus the UTF-8 name. Never trusts the stored filename. */
export function contentDisposition(filename: string): string {
  const clean = filename.replace(/[\u0000-\u001f\u007f"\\/]/g, "_").slice(0, 200) || "attachment";
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

/** Types a browser would render or run are served as an opaque download instead. */
function safeDownloadType(contentType: string): string {
  const base = contentType.split(";")[0].trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(base)) return "application/octet-stream";
  if (base === "text/html" || base === "application/xhtml+xml" || base === "image/svg+xml" || base.endsWith("script")) {
    return "application/octet-stream";
  }
  return base;
}

export function createApp(deps: AppDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((event, fields) => console.log(`[client-api] ${event}`, fields));
  const readEnv = deps.env ?? ((name) => Deno.env.get(name));
  const inboxRows = deps.inboxes ?? new InboxRowCache();
  const keys = new Map<string, { row: ApiKeyRow; at: number }>();
  const inboxLists = new Map<string, { inboxes: Inbox[]; at: number }>();

  const workspaceKey = async (workspaceId: string, timing: Timing): Promise<ApiKeyRow> => {
    const hit = keys.get(workspaceId);
    if (hit && now() - hit.at < KEY_TTL_MS) return hit.row;
    const started = performance.now();
    try {
      const row = await deps.store.ensureWebClientKey(workspaceId);
      if (row.workspace_id !== workspaceId) throw new Error("web_client_key_workspace_mismatch");
      if (keys.size > 5000) keys.clear();
      keys.set(workspaceId, { row, at: now() });
      return row;
    } finally {
      timing.db += performance.now() - started;
    }
  };

  /** Fill the key and inbox-row caches from a membership load that carried them (store.ts). */
  const seeded = new WeakSet<Membership[]>();
  const seedFromMemberships = (rows: Membership[]): void => {
    // Once per load, not per request: the gate hands back the same array until
    // it reloads, and re-seeding from it would keep restarting the caches'
    // own clocks with rows that are getting older. (A speculative load has
    // already landed in the gate's cache by the time its request asks, so
    // "was it cached" cannot be the test.)
    if (seeded.has(rows)) return;
    seeded.add(rows);
    for (const m of rows) {
      const key = m.web_client_key;
      if (key && key.workspace_id === m.workspace_id) {
        if (keys.size > 5000) keys.clear();
        keys.set(m.workspace_id, { row: key, at: now() });
      }
      for (const inbox of m.inbox_rows ?? []) {
        if (inbox.workspace_id === m.workspace_id && inbox.status === "active") inboxRows.remember(inbox);
      }
    }
  };

  /** The key row an executor sees for this caller. `human` adds the send-gate marker. */
  const callerKey = (row: ApiKeyRow, membership: Membership, human: boolean): ApiKeyRow => ({
    ...row,
    scopes: canWrite(membership.role) ? row.scopes : row.scopes.filter((s) => VIEWER_SCOPES.includes(s)),
    inbox_ids: null,
    ...(human ? { firstPartyHuman: true as const } : {}),
  });

  const mailEnvFor = (row: ApiKeyRow, membership: Membership, requestId: string): MailEnv => ({
    mcp: deps.mcp,
    pool: deps.pool,
    imapDial: deps.imapDial,
    inboxes: inboxRows,
    apiKey: callerKey(row, membership, true),
    canWrite: canWrite(membership.role),
    onBackgroundError: (name, error) =>
      log("background_failed", {
        request_id: requestId,
        task: name,
        error_name: error instanceof Error ? error.name : "error",
      }),
    now,
  });

  const listInboxes = async (env: MailEnv, workspaceId: string, timings: OpTimings): Promise<Inbox[]> => {
    const hit = inboxLists.get(workspaceId);
    if (hit && now() - hit.at < INBOX_LIST_TTL_MS) return hit.inboxes;
    const outcome = await runExecutor(env, { tool: "inbox_list", args: {} }, { inboxId: null, flow: {}, timings });
    const body = resultJson(outcome.result) as { inboxes?: Inbox[] };
    const inboxes = Array.isArray(body.inboxes) ? body.inboxes : [];
    if (outcome.logStatus === "success") {
      if (inboxLists.size > 2000) inboxLists.clear();
      inboxLists.set(workspaceId, { inboxes, at: now() });
    }
    return inboxes;
  };

  const emptyAllowance = (plan: string): AssistantAllowance => {
    const start = new Date(now());
    const monthStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    // The allowance could not be read: report nothing left rather than
    // inventing headroom. The assistant refuses; mail is unaffected.
    return {
      plan: planSlug(plan),
      used: 0,
      cap: 0,
      remaining: 0,
      period_start: monthStart.toISOString(),
      resets_at: monthEnd.toISOString(),
    };
  };

  const readAllowance = async (membership: Membership, timing: Timing, requestId: string): Promise<AssistantAllowance> => {
    const started = performance.now();
    try {
      const row = await deps.store.allowance(membership.workspace_id);
      return row ? toAssistantAllowance(row) : emptyAllowance(membership.plan);
    } catch (error) {
      log("allowance_failed", {
        request_id: requestId,
        workspace_id: membership.workspace_id,
        error_name: error instanceof Error ? error.name : "error",
      });
      return emptyAllowance(membership.plan);
    } finally {
      timing.db += performance.now() - started;
    }
  };

  return async function handle(req: Request): Promise<Response> {
    const startedAt = performance.now();
    const origin = req.headers.get("origin");
    const given = req.headers.get("x-request-id");
    const requestId = given && REQUEST_ID_RE.test(given) ? given : crypto.randomUUID();
    const timing: Timing = { auth: 0, db: 0, provider: 0 };
    const url = new URL(req.url);
    const route = routeOf(url.pathname);

    const fields: Record<string, unknown> = { request_id: requestId, method: req.method, route };

    // Set by ws.ts on the requests it builds. A fixed word, never the header's value.
    if (req.headers.get("x-client-transport") === "ws") fields["transport"] = "ws";
    fields["isolate"] = ISOLATE_ID;
    fields["isolate_seq"] = ++isolateSeq;
    fields["isolate_age_s"] = Math.round((performance.now() - ISOLATE_STARTED) / 1000);

    const finish = (response: Response, extra: Record<string, string> = {}): Response => {
      const total = performance.now() - startedAt;
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(corsHeaders(origin))) headers.set(key, value);
      for (const [key, value] of Object.entries(extra)) headers.set(key, value);
      headers.set("X-Request-Id", requestId);
      headers.set("Server-Timing", serverTiming(timing, total, fields["isolate_seq"] as number, fields));
      headers.set("Cache-Control", "no-store");
      headers.set("X-Content-Type-Options", "nosniff");
      log("request", {
        ...fields,
        status: response.status,
        auth_ms: Math.round(timing.auth),
        db_ms: Math.round(timing.db),
        provider_ms: Math.round(timing.provider),
        total_ms: Math.round(total),
      });
      return new Response(response.body, { status: response.status, headers });
    };

    const json = (body: unknown, status = 200, extra: Record<string, string> = {}): Response =>
      finish(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }), extra);

    const fail = (error: unknown): Response => {
      const api = toApiError(error);
      if (!(error instanceof ApiError)) {
        fields["error_name"] = error instanceof Error ? error.name : "error";
      }
      fields["error_code"] = api.body.code;
      if (api.body.tool_code) fields["tool_code"] = api.body.tool_code;
      return json(
        { error: api.body, ...(api.extra ?? {}) },
        api.status,
        api.body.retry_after !== undefined ? { "Retry-After": String(api.body.retry_after) } : {},
      );
    };

    try {
      if (req.method === "OPTIONS") return finish(preflightResponse(origin));

      const method = ROUTES[route];
      if (!method) throw new ApiError(404, "not_found", "No such route.");
      if (req.method !== method) throw new ApiError(405, "invalid_request", `Use ${method} for this route.`);

      // ── who ────────────────────────────────────────────────────────────────
      const authStarted = performance.now();
      let user: AuthedUser;
      try {
        const token = bearerToken(req);
        // Cold isolate only: the signing keys are about to be fetched, so the
        // membership query runs beside that fetch instead of after it.
        const speculative = deps.verifier.speculativeSubject(token);
        if (speculative) deps.gate.prefetch(speculative);
        const claims = await deps.verifier.verify(token);
        user = { id: claims.sub.toLowerCase(), email: typeof claims.email === "string" ? claims.email : "" };
      } finally {
        timing.auth += performance.now() - authStarted;
        fields["verify_ms"] = Math.round(performance.now() - authStarted);
      }
      fields["user_id"] = user.id;

      // ── where, and whether ────────────────────────────────────────────────
      const gateStarted = performance.now();
      let memberships: Membership[];
      let membership: Membership;
      try {
        const resolved = await deps.gate.resolve(user.id, req.headers.get("x-workspace-id"));
        memberships = resolved.memberships;
        membership = resolved.workspace;
        if (!resolved.cached) timing.db += performance.now() - gateStarted;
        else timing.auth += performance.now() - gateStarted;
        seedFromMemberships(memberships);
        fields["gate_ms"] = Math.round(performance.now() - gateStarted);
        fields["gate_cached"] = resolved.cached;
      } catch (error) {
        timing.db += performance.now() - gateStarted;
        throw error;
      }
      fields["workspace_id"] = membership.workspace_id;

      // ── how often ─────────────────────────────────────────────────────────
      let body: unknown = undefined;
      let limitClass: LimitClass = "read";
      let cost = 1;
      if (route === "/mail" || route === "/mail/batch") {
        body = await readJson(req);
        if (route === "/mail") {
          const op = (body as MailRequest | null)?.op;
          if (typeof op === "string" && Object.hasOwn(OPS, op)) {
            fields["op"] = op;
            limitClass = OPS[op].kind;
          }
        } else {
          const calls = parseBatch(body);
          cost = calls.length;
          fields["calls"] = calls.length;
          for (const call of calls) {
            const kind = typeof call.op === "string" && Object.hasOwn(OPS, call.op) ? OPS[call.op].kind : "read";
            if (kind === "send") limitClass = "send";
            else if (kind === "write" && limitClass === "read") limitClass = "write";
          }
        }
      } else if (route === "/assistant/run") {
        limitClass = "assistant";
      }
      const decision = deps.limiter.take(user.id, limitClass, cost);
      if (!decision.ok) {
        throw new ApiError(429, "rate_limited", "Too many requests. Slow down and try again.", {
          retryable: true,
          retryAfter: decision.retryAfter,
        });
      }

      const keyStarted = performance.now();
      const keyRow = await workspaceKey(membership.workspace_id, timing);
      fields["key_ms"] = Math.round(performance.now() - keyStarted);
      const env = mailEnvFor(keyRow, membership, requestId);

      // ── routes ────────────────────────────────────────────────────────────
      if (route === "/allowance") {
        return json(await readAllowance(membership, timing, requestId));
      }

      if (route === "/session") {
        const timings: OpTimings = { providerMs: 0, connectMs: 0, imapDials: 0, imapReuses: 0 };
        const profileStarted = performance.now();
        const [profile, inboxes, allowance] = await Promise.all([
          deps.store.userProfile(user.id).catch(() => null),
          listInboxes(env, membership.workspace_id, timings),
          readAllowance(membership, { auth: 0, db: 0, provider: 0 }, requestId),
        ]);
        // Three database reads side by side (the inbox list is one too: no
        // mail provider is contacted), so the phase is their shared wall time.
        // Adding each one's own duration reported more "db" than the request took.
        timing.db += performance.now() - profileStarted;
        fields["inboxes"] = inboxes.length;
        return json({
          user: { id: user.id, email: user.email, display_name: profile?.display_name ?? null },
          workspaces: memberships.map((m) => ({
            id: m.workspace_id,
            display_name: m.display_name,
            role: m.role,
            plan: planSlug(m.plan),
            web_client_enabled: m.web_client_enabled,
          })),
          workspace_id: membership.workspace_id,
          role: membership.role,
          inboxes,
          allowance,
        });
      }

      if (route === "/mail") {
        const request = body as MailRequest;
        if (!request || typeof request !== "object" || Array.isArray(request)) {
          throw invalidRequest("Request body must be an object.");
        }
        if (typeof request.inbox_id === "string") fields["inbox_id"] = request.inbox_id.slice(0, 36);
        // Created here so a failed op still reports the time it spent.
        const opTimings: OpTimings = { providerMs: 0, connectMs: 0, imapDials: 0, imapReuses: 0 };
        let outcome: Awaited<ReturnType<typeof runMailOp>>;
        try {
          outcome = await runMailOp(env, request, {}, opTimings);
        } finally {
          timing.provider += opTimings.providerMs;
          fields["imap_dials"] = opTimings.imapDials;
          fields["imap_reuses"] = opTimings.imapReuses;
          fields["connect_ms"] = Math.round(opTimings.connectMs);
          if (opTimings.imapCalls?.length) fields["imap_calls"] = opTimings.imapCalls.join(",");
        }
        if (outcome.type === "binary") {
          fields["bytes"] = outcome.body.byteLength;
          return finish(
            new Response(outcome.body, {
              status: 200,
              headers: {
                "Content-Type": safeDownloadType(outcome.contentType),
                "Content-Length": String(outcome.body.byteLength),
                "Content-Disposition": contentDisposition(outcome.filename),
              },
            }),
          );
        }
        return json(outcome.result);
      }

      if (route === "/mail/batch") {
        const calls = parseBatch(body);
        const outcome = await runMailBatch(env, calls, membership.workspace_id);
        timing.provider += outcome.timings.providerMs;
        fields["imap_dials"] = outcome.timings.imapDials;
        fields["imap_reuses"] = outcome.timings.imapReuses;
        fields["connect_ms"] = Math.round(outcome.timings.connectMs);
        if (outcome.timings.imapCalls?.length) fields["imap_calls"] = outcome.timings.imapCalls.join(",");
        fields["ops"] = outcome.summary.map((s) => `${s.op}:${s.status}`).join(",");
        return json({ results: outcome.results });
      }

      // /assistant/run
      if (!deps.assistant) {
        throw new ApiError(503, "provider_error", "The assistant is not available.", { retryable: true });
      }
      let run: HandleAssistantRun;
      try {
        run = await deps.assistant();
      } catch (error) {
        fields["error_name"] = error instanceof Error ? error.name : "error";
        throw new ApiError(503, "provider_error", "The assistant is not available.", { retryable: true });
      }
      const timings: OpTimings = { providerMs: 0, connectMs: 0, imapDials: 0, imapReuses: 0 };
      const inboxes = await listInboxes(env, membership.workspace_id, timings);
      const assistantDeps = buildAssistantDeps({
        mcp: deps.mcp,
        store: deps.store,
        mailEnv: env,
        assistantKey: callerKey(keyRow, membership, false),
        canWrite: canWrite(membership.role),
        user,
        workspaceId: membership.workspace_id,
        inboxes,
        fallbackAllowance: emptyAllowance(membership.plan),
        env: readEnv,
        log: (event, extra) => log(event, { request_id: requestId, workspace_id: membership.workspace_id, ...extra }),
        timings,
      });
      const response = await run(req, assistantDeps);
      timing.provider += timings.providerMs;
      return finish(response);
    } catch (error) {
      return fail(error);
    }
  };
}
