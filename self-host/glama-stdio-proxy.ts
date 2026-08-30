/**
 * Stdio bridge for MCP Emails.
 *
 * Two jobs, picked automatically:
 *
 *   1. With MCP_EMAILS_API_KEY set, it forwards JSON-RPC to the hosted
 *      Streamable HTTP endpoint. That is the path a self-hosted or stdio-only
 *      MCP client wants.
 *
 *   2. Without a key, it boots the real MCP server locally in introspection
 *      mode (MCP_INTROSPECTION_ONLY=1) and forwards to that. This is the path
 *      MCP directory scanners take: they start a stdio process with no
 *      credentials and read `tools/list` to evaluate the server.
 *
 * Why case 2 exists at all: this file used to answer `tools/list` from a
 * hand-maintained array of tool names carrying `inputSchema: { type: "object",
 * additionalProperties: true }`. That array had drifted to the pre-2026-08
 * legacy names (email_list, email_search, email_move, draft_create, ...) which
 * the server no longer exposes, and the empty schemas described no parameters
 * at all. A directory grading tool-definition quality off that would have been
 * scoring a tool surface that does not exist, on schemas with no semantics.
 *
 * Serving the registry from the server itself means this bridge cannot drift
 * again: there is exactly one definition of the tool surface, and it is the
 * one clients actually get.
 */

const endpoint = (Deno.env.get("MCP_EMAILS_ENDPOINT") ?? "https://mcpemails.com/api/mcp").replace(/\/+$/, "");
const apiKey = Deno.env.get("MCP_EMAILS_API_KEY");
let upstreamSessionId: string | null = null;

/** Where the locally booted introspection server listens. Deno.serve's default. */
const LOCAL_PORT = 8000;
const LOCAL_ENDPOINT = `http://127.0.0.1:${LOCAL_PORT}`;

/** Resolved from this file's own location so it works from any CWD. */
const SERVER_ENTRYPOINT = new URL(
  "../supabase/functions/mcp-server/index.ts",
  import.meta.url,
);

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

async function* stdinLines() {
  const reader = Deno.stdin.readable.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        yield buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

function write(message: unknown) {
  return Deno.stdout.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

// ---------------------------------------------------------------------------
// Local introspection server
// ---------------------------------------------------------------------------

let localServer: Deno.ChildProcess | null = null;

/**
 * Boot the real server with no database behind it and wait for it to answer.
 *
 * Its stdout and stderr are swallowed on purpose. This process speaks
 * line-delimited JSON-RPC on stdout, and a stray "Listening on ..." from the
 * child would corrupt that stream.
 */
async function startLocalServer(): Promise<void> {
  if (localServer) return;

  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-net", "--allow-env", SERVER_ENTRYPOINT.href],
    env: { ...Deno.env.toObject(), MCP_INTROSPECTION_ONLY: "1" },
    stdout: "null",
    stderr: "null",
    stdin: "null",
  });
  localServer = command.spawn();

  // Poll until it answers, rather than sleeping a fixed guess.
  const deadline = Date.now() + 60_000;
  let lastError = "no attempt made";
  while (Date.now() < deadline) {
    try {
      const probe = await fetch(LOCAL_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "probe", method: "ping", params: {} }),
      });
      await probe.body?.cancel();
      if (probe.ok) return;
      lastError = `status ${probe.status}`;
    } catch (cause) {
      lastError = errorMessage(cause);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Local MCP Emails server did not start in time: ${lastError}`);
}

/** Best effort teardown. A child that is already gone is the desired state. */
function stopLocalServer(): void {
  try {
    localServer?.kill();
  } catch {
    // Already exited.
  }
}

// ---------------------------------------------------------------------------
// Forwarding
// ---------------------------------------------------------------------------

async function postUpstream(request: JsonRpcRequest) {
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-06-18",
  });

  let target: string;
  if (apiKey) {
    target = endpoint;
    headers.set("Authorization", `Bearer ${apiKey}`);
    if (upstreamSessionId) headers.set("Mcp-Session-Id", upstreamSessionId);
  } else {
    await startLocalServer();
    target = LOCAL_ENDPOINT;
  }

  const response = await fetch(target, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });

  if (apiKey) {
    const sessionId = response.headers.get("Mcp-Session-Id");
    if (sessionId) upstreamSessionId = sessionId;
  }

  const body = await response.text();
  if (!response.ok) throw new Error(`MCP Emails returned ${response.status}: ${body}`);
  return JSON.parse(body);
}

/**
 * The hosted endpoint expects an `initialize` before anything else. The local
 * introspection server does not care, so this is a no-op there.
 */
async function ensureUpstreamSession() {
  if (upstreamSessionId || !apiKey) return;
  await postUpstream({
    jsonrpc: "2.0",
    id: "glama-stdio-bridge-initialize",
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcpemails-stdio-proxy", version: "1.0.0" },
    },
  });
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

for await (const line of stdinLines()) {
  if (!line.trim()) continue;

  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line);
  } catch {
    await write(rpcError(null, -32700, "Parse error"));
    continue;
  }

  if (!request.method) {
    await write(rpcError(request.id, -32600, "Invalid request"));
    continue;
  }

  // Notifications are fire-and-forget and carry no id to reply to.
  if (request.method.startsWith("notifications/")) continue;

  try {
    if (request.method !== "initialize") await ensureUpstreamSession();
    await write(await postUpstream(request));
  } catch (cause) {
    await write(rpcError(request.id, -32603, errorMessage(cause)));
  }
}

stopLocalServer();
