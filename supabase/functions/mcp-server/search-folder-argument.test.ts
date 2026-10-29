// ---------------------------------------------------------------------------
// `folder` on a search scopes the search to that folder.
//
// 2026-10-24: `email_read {action: "search", folder: "Demo"}` on an IMAP inbox
// returned INBOX messages ("INBOX:54"), with a note that `folder` belongs to
// list and was not applied. `include_folders: ["Demo"]` returned "Demo:NN".
// The schema lists `folder` beside the search fields, so a model asking to
// search one folder sends it there. See normalizeSearchFolderScope.
//
// Pure half first, then end to end through handleToolsCall on both surfaces.
// The end-to-end calls carry a bad `since` so validation refuses them before
// any I/O; what is checked is whether `folder` is still in the refusal.
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { allowsLenientArguments, normalizeSearchFolderScope } from "./consolidated-arguments.ts";

Deno.env.set("MCP_INTROSPECTION_ONLY", "1");
Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
const { CONSOLIDATED_ARGUMENT_INDEX, handleToolsCall } = await import("./index.ts");

const SEARCH_ARGS = CONSOLIDATED_ARGUMENT_INDEX.email_read.allowedByAction.search;
const LIST_ARGS = CONSOLIDATED_ARGUMENT_INDEX.email_read.allowedByAction.list;

// ═══════════════════════════════════════════════════════════════════════════
// Pure
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("folder on a search becomes a one-entry include_folders", () => {
  const args: Record<string, unknown> = { action: "search", folder: "Demo", subject: "a" };
  assertEquals(normalizeSearchFolderScope(SEARCH_ARGS, args), true);
  assertEquals(args, { action: "search", subject: "a", include_folders: ["Demo"] });
});

Deno.test("an empty include_folders is filled from folder", () => {
  const args: Record<string, unknown> = { folder: "Demo", include_folders: [] };
  assertEquals(normalizeSearchFolderScope(SEARCH_ARGS, args), true);
  assertEquals(args, { include_folders: ["Demo"] });
});

Deno.test("a folder already in include_folders is dropped as a repeat", () => {
  const args: Record<string, unknown> = { folder: "Demo", include_folders: ["Demo", "Archive"] };
  assertEquals(normalizeSearchFolderScope(SEARCH_ARGS, args), true);
  assertEquals(args, { include_folders: ["Demo", "Archive"] });
});

Deno.test("a folder that conflicts with include_folders is left for the review", () => {
  const args: Record<string, unknown> = { folder: "Demo", include_folders: ["Archive"] };
  assertEquals(normalizeSearchFolderScope(SEARCH_ARGS, args), false);
  assertEquals(args, { folder: "Demo", include_folders: ["Archive"] });
});

Deno.test("list keeps its own folder", () => {
  const args: Record<string, unknown> = { action: "list", folder: "Demo" };
  assertEquals(normalizeSearchFolderScope(LIST_ARGS, args), false);
  assertEquals(args, { action: "list", folder: "Demo" });
});

Deno.test("a blank or non-string folder is not rewritten", () => {
  for (const folder of ["", "  ", 3, null]) {
    const args: Record<string, unknown> = { folder };
    assertEquals(normalizeSearchFolderScope(SEARCH_ARGS, args), false, JSON.stringify(folder));
  }
});

Deno.test("the only read-only email_read action the rewrite reaches is search", () => {
  // If another action grows include_folders without folder, this says so, so
  // someone decides on purpose whether folder means the same thing there.
  const reached = Object.entries(CONSOLIDATED_ARGUMENT_INDEX.email_read.allowedByAction)
    .filter(([action, allowed]) =>
      allowsLenientArguments("email_read", action) &&
      allowed.includes("include_folders") && !allowed.includes("folder")
    )
    .map(([action]) => action);
  assertEquals(reached, ["search"]);
});

// ═══════════════════════════════════════════════════════════════════════════
// End to end
// ═══════════════════════════════════════════════════════════════════════════

const ALL_SCOPES = [
  "read:email",
  "send:email",
  "manage:folders",
  "delete:email",
  "manage:drafts",
  "schedule:email",
  "manage:automations",
  "manage:contacts",
];

function oauthToken(name: string) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspace_id: "22222222-2222-4222-8222-222222222222",
    name,
    key_prefix: "mcpe_abc",
    key_hash: "",
    scopes: ALL_SCOPES,
    inbox_ids: null,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    last_used_at: null,
    deleted_at: null,
    created_at: new Date().toISOString(),
  };
}

interface CallResponse {
  result?: { isError?: boolean; content?: Array<{ text?: string }> };
}

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const response = await handleToolsCall(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    1,
    oauthToken("OAuth: ChatGPT"),
    { userAgent: null },
  ) as CallResponse;
  return response.result?.content?.[0]?.text ?? "";
}

Deno.test("email_read search accepts folder on both surfaces", async () => {
  const consolidated = await call("email_read", { action: "search", folder: "Demo", since: "not a date" });
  assertStringIncludes(consolidated, "arguments.since");
  assert(!consolidated.includes("folder"), consolidated);
  const perOperation = await call("email_search", { folder: "Demo", since: "not a date" });
  assertStringIncludes(perOperation, "arguments.since");
  assert(!perOperation.includes("folder"), perOperation);
});

Deno.test("a conflicting folder is still refused on the per-operation email_search", async () => {
  const perOperation = await call("email_search", {
    folder: "Demo",
    include_folders: ["Archive"],
    since: "not a date",
  });
  assertStringIncludes(perOperation, "arguments.folder is not an argument of email_search");
});

Deno.test("search_and_move keeps refusing folder", async () => {
  // A destructive sweep: a folder it was not written for is refused, never
  // reinterpreted. See LENIENT_ACTIONS.
  const text = await call("email_organize", {
    action: "search_and_move",
    folder: "Demo",
    subject: "x",
    destination_folder_id: "Archive",
  });
  assertStringIncludes(text, "arguments.folder is not allowed");
});
