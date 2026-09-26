// ---------------------------------------------------------------------------
// Per-tool `securitySchemes` (security-schemes.ts) and the OpenAI client
// classifier the scope-denial path branches on.
//
// ChatGPT only offers to relink a connector for a tool that declares
// `securitySchemes: [{ type: "oauth2", scopes }]`. The scopes have to be the
// ones the tools/call gate will actually demand, or ChatGPT relinks for the
// wrong permission and the retry fails the same way. So the wire listing is
// checked against the real action tables, not against a hand-kept copy.
//
// Run: deno test -A --no-check supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  consolidatedSecurityScopes,
  isOpenAiClientName,
  isOpenAiOAuthKeyName,
  toolSecuritySchemes,
} from "./security-schemes.ts";
import { serializeToolForList } from "./mcp-app-resources.ts";

Deno.test("toolSecuritySchemes declares one oauth2 scheme, deduplicated, order kept", () => {
  assertEquals(toolSecuritySchemes(["manage:folders", "read:email", "manage:folders"]), [
    { type: "oauth2", scopes: ["manage:folders", "read:email"] },
  ]);
  assertEquals(toolSecuritySchemes([]), undefined, "no scope, nothing declared");
  assertEquals(toolSecuritySchemes(["", ""]), undefined, "empty strings are not scopes");
});

Deno.test("consolidatedSecurityScopes declares only the first advertised action's primary scope", () => {
  assertEquals(
    consolidatedSecurityScopes({
      list: { scope: "read:email" },
      search: { scope: "read:email", altScopes: ["search:email"] } as { scope: string },
      move: { scope: "manage:folders" },
    }),
    ["read:email"],
  );
  // An unadvertised leading action is skipped: `folder` must not demand the
  // read:email of its legacy 'list', nor `draft` the send:email of its 'send'.
  assertEquals(
    consolidatedSecurityScopes({
      list: { scope: "read:email", advertised: false },
      create: { scope: "manage:folders" },
      send: { scope: "send:email" },
    }),
    ["manage:folders"],
  );
  assertEquals(consolidatedSecurityScopes({}), []);
});

Deno.test("a fixture without a scope serialises with no securitySchemes key", () => {
  // The byte-identity pins in mcp-app-resources.test.ts build tools without a
  // requiredScope; they must keep their exact bytes.
  const listed = serializeToolForList({
    name: "x",
    title: "X",
    description: "d",
    inputSchema: { type: "object" },
  });
  assert(!("securitySchemes" in listed));
});

Deno.test("a standalone tool falls back to its requiredScope; securitySchemes sits before _meta", () => {
  const listed = serializeToolForList({
    name: "inbox_list",
    title: "List inboxes",
    description: "d",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
    requiredScope: "read:email",
    _meta: { ui: { resourceUri: "ui://x" } },
  });
  assertEquals(listed.securitySchemes, [{ type: "oauth2", scopes: ["read:email"] }]);
  assertEquals(
    Object.keys(listed),
    ["name", "title", "description", "inputSchema", "annotations", "securitySchemes", "_meta"],
  );
  assert(!("requiredScope" in listed), "the registry's scope fields stay off the wire");
  assert(!("securityScopes" in listed));
});

Deno.test("OpenAI client names are recognised, and nothing else is", () => {
  // Every OpenAI name in mcp_client_capabilities on 2026-09-25.
  for (
    const name of [
      "openai-mcp",
      "openai-mcp (Codex)",
      "openai-mcp (ChatGPT)",
      "codex-mcp-client",
      "Codex",
      "codex-config-check",
      "  OpenAI-MCP  ",
    ]
  ) {
    assert(isOpenAiClientName(name), `${name} is OpenAI`);
  }
  for (
    const name of [
      "claude-ai",
      "claude-code",
      "Anthropic/Toolbox",
      "cursor-vscode",
      "Cursor",
      "sheet-add-in",
      "Poke",
      "unknown",
      "",
      null,
      undefined,
    ]
  ) {
    assert(!isOpenAiClientName(name), `${String(name)} is not OpenAI`);
  }
});

Deno.test("OAuth key names minted for OpenAI clients are recognised", () => {
  for (
    const name of [
      "OAuth: ChatGPT",
      "OAuth: ChatGPT (4)",
      "OAuth: chatgpt.com",
      "OAuth: chatgpt.com (2)",
      "OAuth: Codex",
      "OAuth: Codex (2)",
    ]
  ) {
    assert(isOpenAiOAuthKeyName(name), name);
  }
  for (
    const name of [
      "OAuth: Claude",
      "OAuth: claude.ai (2)",
      "OAuth: Claude Code (mcpemails)",
      "OAuth: Cursor",
      "OAuth: Grok",
      "OAuth: ChatGPT clone by someone",
      "ChatGPT",
      "Read-only automation",
      null,
    ]
  ) {
    assert(!isOpenAiOAuthKeyName(name), String(name));
  }
});

// ---------------------------------------------------------------------------
// Against the real registry and the real wire. Same env arrangement as
// tool-surface.test.ts: index.ts builds its registry at module load.
// ---------------------------------------------------------------------------

Deno.env.set("MCP_INTROSPECTION_ONLY", "1");
Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
const { CONSOLIDATED_SPECS, TOOL_REGISTRY, handleRequest } = await import("./index.ts");

async function wireTools(): Promise<Array<Record<string, unknown>>> {
  const response = await handleRequest(
    new Request("https://mcp.example.test/mcp-server", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
  assertEquals(response.status, 200);
  const body = JSON.parse(await response.text()) as { result: { tools: Array<Record<string, unknown>> } };
  return body.result.tools;
}

Deno.test("every tool on the tools/list wire declares an oauth2 securityScheme", async () => {
  const tools = await wireTools();
  assert(tools.length > 0);
  for (const tool of tools) {
    const schemes = tool.securitySchemes as Array<{ type: string; scopes: string[] }> | undefined;
    assert(Array.isArray(schemes) && schemes.length === 1, `${tool.name} declares one scheme`);
    assertEquals(schemes![0].type, "oauth2", `${tool.name} is oauth2`);
    assert(schemes![0].scopes.length > 0, `${tool.name} names at least one scope`);
  }
});

Deno.test("each consolidated tool declares exactly its first advertised action's scope", async () => {
  const byName = new Map((await wireTools()).map((t) => [t.name as string, t]));
  const specs = CONSOLIDATED_SPECS as Record<
    string,
    { actions: Record<string, { scope: string; advertised?: boolean }> }
  >;
  let checked = 0;
  for (const [name, spec] of Object.entries(specs)) {
    const tool = byName.get(name);
    if (!tool) continue; // registered but not advertised (signature)
    const declared = (tool.securitySchemes as Array<{ scopes: string[] }>)[0].scopes;
    const first = Object.values(spec.actions).find((a) => a.advertised !== false)!;
    assertEquals(declared, [first.scope], name);
    checked++;
  }
  assert(checked >= 8, `checked ${checked} consolidated tools`);
});

Deno.test("the two tools OpenAI's review failed on declare the scope the gate demands", async () => {
  const byName = new Map((await wireTools()).map((t) => [t.name as string, t]));
  const scopesOf = (name: string) =>
    (byName.get(name)!.securitySchemes as Array<{ scopes: string[] }>)[0].scopes;
  assert(scopesOf("email_compose").includes("send:email"), "email_compose asks for send");
  assert(scopesOf("automation").includes("manage:automations"), "automation asks for automations");
  assert(scopesOf("email_organize").includes("manage:folders"), "email_organize asks for folders");
  assertEquals(scopesOf("folder"), ["manage:folders"], "folder never demands its legacy list scope");
  assertEquals(scopesOf("draft"), ["manage:drafts"], "a drafts-only grant is not made to look short of send");
  assertEquals(scopesOf("email_read"), ["read:email"], "a read tool asks for read only");
});

Deno.test("a standalone registry tool declares its requiredScope", () => {
  for (const tool of TOOL_REGISTRY) {
    if (tool.securityScopes) continue;
    const listed = serializeToolForList(tool);
    assertEquals(
      listed.securitySchemes,
      [{ type: "oauth2", scopes: [tool.requiredScope] }],
      tool.name,
    );
  }
});
