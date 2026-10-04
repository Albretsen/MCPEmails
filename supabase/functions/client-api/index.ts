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
import { RateLimiter } from "./rate-limit.ts";
import { loadMcpSeam } from "./seam.ts";
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

async function start(): Promise<Handler> {
  let mcp;
  try {
    mcp = await loadMcpSeam();
  } catch (error) {
    return failClosed(error instanceof Error ? `${error.name}: ${error.message}` : "seam_load_failed");
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  if (!supabaseUrl) return failClosed("SUPABASE_URL is not set");

  const store = supabaseStore(mcp.serviceRoleClient);
  return createApp({
    mcp,
    store,
    verifier: new JwtVerifier({
      supabaseUrl,
      jwtSecret: Deno.env.get("SUPABASE_JWT_SECRET") ?? Deno.env.get("JWT_SECRET") ?? undefined,
      apiKey: Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? undefined,
    }),
    gate: new WorkspaceGate(store),
    limiter: new RateLimiter(),
    pool: new ImapPool<PoolableClient>(),
    assistant: loadAssistant,
  });
}

const handler = await start();

Deno.serve(handler);
