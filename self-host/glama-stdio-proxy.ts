/**
 * Stdio bridge for MCP Emails.
 *
 * Glama's release evaluator starts a local stdio MCP process, whereas the
 * production MCP Emails service is a protected Streamable HTTP endpoint. This
 * bridge presents the same public tool catalogue over stdio and forwards tool
 * calls to the hosted service when an MCP_EMAILS_API_KEY is supplied.
 *
 * It is also useful for self-hosted/local MCP clients that only support stdio.
 */

const endpoint = (Deno.env.get("MCP_EMAILS_ENDPOINT") ?? "https://mcpemails.com/api/mcp").replace(/\/+$/, "");
const apiKey = Deno.env.get("MCP_EMAILS_API_KEY");
let upstreamSessionId: string | null = null;

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

const tools = [
  ["inbox_list", "List the inboxes available to the API key and their provider capabilities. Call this first to discover inbox IDs."],
  ["email_list", "List messages in an inbox with pagination, folders, labels, and read-state filters."],
  ["email_read", "Read a message's headers and body, or retrieve a requested body format."],
  ["email_search", "Search email using provider-neutral structured filters such as sender, recipient, subject, text, dates, and flags."],
  ["email_attachment", "Retrieve metadata or content for an attachment on a permitted email message."],
  ["folder_list", "List folders, labels, and mailbox organization available for an inbox."],
  ["email_move", "Move one email to a folder or label after confirming the target inbox and destination."],
  ["email_copy", "Copy one email to a folder or label without removing it from its original location."],
  ["email_delete", "Permanently delete an email. Treat this as destructive and request human confirmation first."],
  ["email_flag", "Set or clear the flagged/important state of an email message."],
  ["email_send", "Send a new email through the connected mailbox. Confirm recipients and content before sending."],
  ["email_reply", "Reply to an existing message through the connected mailbox, preserving thread context."],
  ["email_forward", "Forward an existing email to one or more recipients after confirming the recipients."],
  ["email_archive", "Archive an email where the connected provider supports archiving."],
  ["draft_list", "List saved email drafts for a connected inbox."],
  ["draft_create", "Create an email draft without sending it."],
  ["draft_update", "Update a saved email draft's recipients, subject, or content."],
  ["draft_send", "Send a saved email draft after confirming the final recipients and content."],
  ["draft_delete", "Delete a saved email draft. Treat this as destructive."],
  ["contact_search", "Search contacts available through a connected provider."],
  ["schedule_create", "Schedule an email to be sent at a future time."],
  ["schedule_list", "List pending scheduled emails and their planned send times."],
  ["schedule_cancel", "Cancel a pending scheduled email before it is sent."],
  ["signature_get", "Read the configured signature for a connected inbox."],
  ["signature_set", "Set the configured signature for a connected inbox."],
] as const;

function write(message: unknown) {
  return Deno.stdout.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
}

function result(id: JsonRpcRequest["id"], value: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result: value };
}

function error(id: JsonRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function postUpstream(request: JsonRpcRequest) {
  if (!apiKey) {
    throw new Error("Set MCP_EMAILS_API_KEY to forward MCP calls to the hosted MCP Emails service.");
  }
  const headers = new Headers({
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-06-18",
  });
  if (upstreamSessionId) headers.set("Mcp-Session-Id", upstreamSessionId);
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(request) });
  const sessionId = response.headers.get("Mcp-Session-Id");
  if (sessionId) upstreamSessionId = sessionId;
  const body = await response.text();
  if (!response.ok) throw new Error(`MCP Emails returned ${response.status}: ${body}`);
  return JSON.parse(body);
}

async function ensureUpstreamSession() {
  if (upstreamSessionId || !apiKey) return;
  await postUpstream({
    jsonrpc: "2.0",
    id: "glama-stdio-bridge-initialize",
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcpemails-stdio-proxy", version: "1.0.0" } },
  });
}

for await (const line of stdinLines()) {
  if (!line.trim()) continue;
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line);
  } catch {
    await write(error(null, -32700, "Parse error"));
    continue;
  }

  if (!request.method) {
    await write(error(request.id, -32600, "Invalid request"));
    continue;
  }
  if (request.method === "notifications/initialized") continue;
  if (request.method === "initialize") {
    await write(result(request.id, {
      protocolVersion: "2025-06-18",
      serverInfo: { name: "MCP Emails", version: "1.0.1" },
      capabilities: { tools: { listChanged: false } },
      instructions: "Set MCP_EMAILS_API_KEY to enable authenticated calls through the hosted MCP Emails service.",
    }));
    continue;
  }
  if (request.method === "ping") {
    await write(result(request.id, {}));
    continue;
  }
  if (request.method === "tools/list") {
    await write(result(request.id, {
      tools: tools.map(([name, description]) => ({
        name,
        description,
        inputSchema: { type: "object", additionalProperties: true },
      })),
    }));
    continue;
  }
  if (request.method === "tools/call") {
    try {
      await ensureUpstreamSession();
      await write(await postUpstream(request));
    } catch (cause) {
      await write(result(request.id, {
        content: [{ type: "text", text: cause instanceof Error ? cause.message : "Unable to call MCP Emails." }],
        isError: true,
      }));
    }
    continue;
  }
  await write(error(request.id, -32601, `Method not found: ${request.method}`));
}
