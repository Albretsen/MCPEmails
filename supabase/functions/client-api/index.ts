// ---------------------------------------------------------------------------
// client-api: the first-party web mail client's edge function.
//
// A SEPARATE function from `mcp-server`: its own deploy, its own isolates. It
// imports the MCP server's tool layer in-process (so the web client and MCP
// connectors run the same executors) and must never start that server's HTTP
// listener. `loadMcpSeam` sets MCP_SERVER_NO_LISTEN=1, reads it back, and only
// then imports the module. If that guard cannot be established, or the import
// fails, NOTHING below is wired up: every request gets a 500 and one log line,
// and no mail code runs. Fail closed.
//
// The wiring is here; the behaviour is in app.ts (router), auth.ts, mail/,
// imap-pool.ts and rate-limit.ts, each of which is testable without this file.
// ---------------------------------------------------------------------------

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createApp } from "./app.ts";
import type { HandleAssistantRun } from "./assistant-deps.ts";
import { JwtVerifier, WorkspaceGate } from "./auth.ts";
import { corsHeaders, preflightResponse } from "./cors.ts";
import { ImapPool, type PoolableClient } from "./imap-pool.ts";
import { withHealthColumns } from "./mail/health.ts";
import { runDispatch } from "./push/dispatch.ts";
import { createWatchMail } from "./push/mail.ts";
import { supabasePushStore } from "./push/store.ts";
import { createPushSender, vapidFromEnv } from "./push/webpush.ts";
import { RateLimiter } from "./rate-limit.ts";
import { loadMcpSeam } from "./seam.ts";
import { recycleSockets, serveSocket } from "./ws.ts";
import { supabaseStore } from "./store.ts";

type Handler = (req: Request) => Promise<Response>;

function failClosed(reason: string): Handler {
  console.error("[client-api] startup_failed", { reason });
  return (req) => {
    const origin = req.headers.get("origin");
    if (req.method === "OPTIONS") return Promise.resolve(preflightResponse(origin));
    const requestId = crypto.randomUUID();
    console.error("[client-api] refused_not_started", { request_id: requestId, reason });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          error: { code: "internal_error", message: "The service is not available.", retryable: true },
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": requestId,
            "Cache-Control": "no-store",
            "Server-Timing": "total;dur=0",
            ...corsHeaders(origin),
          },
        },
      ),
    );
  };
}

/** The one place the assistant module is imported. */
let assistantModule: Promise<HandleAssistantRun> | null = null;
function loadAssistant(): Promise<HandleAssistantRun> {
  assistantModule ??= import("./assistant/mod.ts").then((mod) => {
    const run = (mod as { handleAssistantRun?: unknown }).handleAssistantRun;
    if (typeof run !== "function") throw new Error("assistant_module_missing_handler");
    return run as HandleAssistantRun;
  });
  // A failed load is retried on the next request rather than cached forever.
  assistantModule.catch(() => {
    assistantModule = null;
  });
  return assistantModule;
}

interface Started {
  handler: Handler;
  /** Signature + expiry check for a socket's `auth` frame; false when the function did not start. */
  authenticate: (token: string) => Promise<boolean>;
}

async function start(): Promise<Started> {
  const closed = (reason: string): Started => ({ handler: failClosed(reason), authenticate: () => Promise.resolve(false) });
  let mcp;
  try {
    mcp = await loadMcpSeam();
  } catch (error) {
    return closed(error instanceof Error ? `${error.name}: ${error.message}` : "seam_load_failed");
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  if (!supabaseUrl) return closed("SUPABASE_URL is not set");

  // The tool layer's projection plus `service` and `last_error`: what `/session`
  // needs to report an inbox's health without a mail call (mail/health.ts).
  const store = supabaseStore(mcp.serviceRoleClient, {
    inboxColumns: mcp.INBOX_SELECT_COLUMNS ? withHealthColumns(mcp.INBOX_SELECT_COLUMNS) : undefined,
  });
  const verifier = new JwtVerifier({
    supabaseUrl,
    jwtSecret: Deno.env.get("SUPABASE_JWT_SECRET") ?? Deno.env.get("JWT_SECRET") ?? undefined,
    apiKey: Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? undefined,
  });
  // Web push. Without the three VAPID secrets there is no sender: subscribe
  // and test answer 503, and the watcher checks mailboxes but sends nothing.
  const pushStore = supabasePushStore(mcp.serviceRoleClient);
  const vapid = vapidFromEnv((name) => Deno.env.get(name));
  const pushSender = vapid ? createPushSender({ vapid }) : null;
  return {
    handler: createApp({
      mcp,
      store,
      verifier,
      gate: new WorkspaceGate(store),
      limiter: new RateLimiter(),
      // Idle TTL 70 s, not the pool's default 25 s. A pooled connection only
      // ever outlives its request on a WebSocket (see the note at the bottom
      // of this file), and there the client's change poll comes every 30 to
      // 60 s: with 25 s every poll found the connection already logged out
      // and paid TCP + TLS + AUTH again, one login per poll per inbox for as
      // long as the tab was open. 70 s keeps the one connection across polls;
      // it is still NOOP-checked after 10 s idle, and the socket's own idle
      // close (ws.ts) ends it when the tab stops talking.
      pool: new ImapPool<PoolableClient>({ idleTtlMs: 70_000 }),
      assistant: loadAssistant,
      push: {
        store: pushStore,
        sender: pushSender,
        // One pass of the new-mail watcher (push/dispatch.ts). It gets its own
        // IMAP pool, closed when the pass ends, and reads mailboxes with the
        // workspace's hidden key narrowed to read scopes.
        dispatch: () =>
          runDispatch({
            store: pushStore,
            sender: pushSender,
            mail: createWatchMail({
              mcp,
              workspaceKey: (workspaceId) => store.ensureWebClientKey(workspaceId),
              onLoginRefused: (inboxId, workspaceId) => {
                void store.markLoginRefused(inboxId, workspaceId, Date.now()).catch(() => {});
              },
            }),
            log: (event, fields) => console.log(`[client-api] ${event}`, fields),
          }),
      },
    }),
    authenticate: (token) => verifier.verify(token).then(() => true, () => false),
  };
}

const { handler, authenticate } = await start();

// ISOLATE LIFETIME, measured on the hosted runtime (2026-10-04, edge runtime
// 1.76). Once a response is sent and nothing is pending, the platform shuts
// the worker down (log event "shutdown", reason EarlyDrop), and consecutive
// HTTP requests from one browser are spread over many workers anyway: of 120
// back-to-back requests, 105 booted a new isolate. So on plain HTTP nearly
// every request is a cold one, and the caches and the IMAP pool below serve
// one request each.
//
// Holding the isolate open with EdgeRuntime.waitUntil was tried and REMOVED:
// it raised reuse only from 3 % to (at best) 14 %, because routing is not
// sticky, while every one of those idle isolates kept its own authenticated
// IMAP connection open for the pool's idle TTL. A person clicking through
// twenty messages would have held twenty connections to a provider that
// allows five. Letting the worker be dropped closes its connection with it.
//
// What does pin an isolate is a WebSocket (ws.ts): every frame on a socket is
// served by the isolate that accepted it, so its caches and its ONE pooled
// IMAP connection per inbox are reused by every request of that tab.
// The runtime says the worker is about to be retired (a resource limit, or a
// deploy): let every socket finish what it has in flight and close with 4409
// so its client reconnects to a fresh worker instead of finding the socket
// dead under a request. See the RECYCLING note in ws.ts for what is documented
// and what was observed.
addEventListener("beforeunload", (event) => {
  const reason = (event as unknown as { detail?: { reason?: unknown } }).detail?.reason;
  const sockets = recycleSockets();
  console.log("[client-api] beforeunload", { reason: typeof reason === "string" ? reason.slice(0, 40) : "unknown", sockets });
});

Deno.serve((req) => {
  if (req.method === "GET" && /\/client-api\/ws\/?$/.test(new URL(req.url).pathname)) {
    return serveSocket(req, {
      handle: handler,
      authenticate,
      log: (event, fields) => console.log(`[client-api] ${event}`, fields),
    });
  }
  return handler(req);
});
