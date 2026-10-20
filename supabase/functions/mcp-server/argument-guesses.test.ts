// ---------------------------------------------------------------------------
// Argument names that exist nowhere on the tool, and a missing message_id.
//
// The shapes are the ones production refused after PR #115 (read-out of
// 2026-10-18; see the header of argument-guesses.ts): one workspace guessed
// seventeen date and criteria names on email_read search before finding
// since/before, and another fanned out eighteen email_read calls with no
// message_id. Pure halves first, then end to end through handleToolsCall on
// both surfaces.
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { guessedArgumentNames, withGuessedArgumentHints } from "./argument-guesses.ts";

Deno.env.set("MCP_INTROSPECTION_ONLY", "1");
Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
const {
  CONSOLIDATED_ARGUMENT_INDEX,
  handleToolsCall,
  PER_OPERATION_LISTING,
} = await import("./index.ts");

const SEARCH_ARGS = CONSOLIDATED_ARGUMENT_INDEX.email_read.allowedByAction.search;
const LIST_ARGS = CONSOLIDATED_ARGUMENT_INDEX.email_read.allowedByAction.list;
const READ_ARGS = CONSOLIDATED_ARGUMENT_INDEX.email_read.allowedByAction.read;

const unknown = (name: string) => ({
  path: `arguments.${name}`,
  keyword: "additionalProperties",
  message: "is not allowed",
});

// ═══════════════════════════════════════════════════════════════════════════
// Pure wording
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("every date name production guessed on search points at since and before", () => {
  // One workspace, 2026-10-18 03:35..03:38 UTC, in the order sent.
  const guessed = [
    "after", "date_after", "date_before", "since_date", "before_date", "received_after",
    "received_before", "after_date", "start_date", "end_date", "until",
  ];
  for (const name of guessed) {
    const [error] = withGuessedArgumentHints([unknown(name)], "action 'search'", SEARCH_ARGS);
    assertEquals(
      error.message,
      "is not an argument of action 'search'; dates are filtered with since (on or after) " +
        "and before (strictly before), each a year-first date such as 2026-10-01",
      name,
    );
    assertEquals(error.path, `arguments.${name}`);
    assertEquals(error.keyword, "additionalProperties");
  }
});

Deno.test("every criteria wrapper production guessed on search lists the real criteria", () => {
  for (const name of ["search", "imap_query", "criteria", "search_query", "search_criteria", "imap_search", "filter", "filters"]) {
    const [error] = withGuessedArgumentHints([unknown(name)], "action 'search'", SEARCH_ARGS);
    assertEquals(
      error.message,
      "is not an argument of action 'search'; the search criteria are separate top-level " +
        "arguments (from, to, cc, subject, body, text, unread, has_attachment, flagged, " +
        "since, before), and query takes the provider's own search syntax",
      name,
    );
  }
});

Deno.test("a pair of date guesses states the fact once", () => {
  const errors = withGuessedArgumentHints(
    [unknown("start_date"), unknown("end_date")],
    "email_search",
    SEARCH_ARGS,
  );
  assertStringIncludes(errors[0].message, "dates are filtered with since");
  assertEquals(errors[1].message, "is not an argument of email_search either");
});

Deno.test("include_body on a summary operation says where the body comes from, never on read", () => {
  const [onSearch] = withGuessedArgumentHints([unknown("include_body")], "action 'search'", SEARCH_ARGS);
  assertStringIncludes(onSearch.message, "results here are summaries without bodies");
  const [onRead] = withGuessedArgumentHints([unknown("include_body")], "action 'read'", READ_ARGS);
  assertEquals(onRead.message, "is not allowed");
});

Deno.test("a date guess on an operation with no date filter names where they are, or stays bare", () => {
  const [named] = withGuessedArgumentHints(
    [unknown("until")],
    "action 'list'",
    LIST_ARGS,
    () => "action 'search' takes since and before",
  );
  assertEquals(
    named.message,
    "is not an argument of action 'list', which has no date filter; action 'search' takes since and before",
  );
  const [bare] = withGuessedArgumentHints([unknown("until")], "action 'list'", LIST_ARGS);
  assertEquals(bare.message, "is not allowed");
});

Deno.test("a fact never names an argument the operation does not take", () => {
  const [error] = withGuessedArgumentHints([unknown("criteria")], "x", ["from", "subject"]);
  assertEquals(
    error.message,
    "is not an argument of x; the search criteria are separate top-level arguments (from, subject)",
  );
  const [none] = withGuessedArgumentHints([unknown("criteria")], "x", ["message_id"]);
  assertEquals(none.message, "is not allowed");
});

Deno.test("an already explained refusal and an unknown name keep their wording", () => {
  const explained = { ...unknown("after"), message: "is not an argument of email_list; email_search takes it" };
  assertEquals(withGuessedArgumentHints([explained], "email_list", SEARCH_ARGS), [explained]);
  assertEquals(withGuessedArgumentHints([unknown("zzz")], "x", SEARCH_ARGS), [unknown("zzz")]);
  const nested = { ...unknown("filter.after"), path: "arguments.filter.after" };
  assertEquals(withGuessedArgumentHints([nested], "x", SEARCH_ARGS), [nested]);
});

Deno.test("camelCase and dashed spellings are recognised", () => {
  for (const name of ["startDate", "received-after", "DateBefore"]) {
    const [error] = withGuessedArgumentHints([unknown(name)], "x", SEARCH_ARGS);
    assertStringIncludes(error.message, "dates are filtered with since", name);
  }
});

Deno.test("a missing message_id says where an id comes from", () => {
  const [error] = withGuessedArgumentHints(
    [{ path: "arguments.message_id", keyword: "required", message: "is required" }],
    "action 'read'",
    READ_ARGS,
  );
  assertEquals(error.message, "is required; it is the id each message carries in a list or search result");
  assertEquals(error.keyword, "required");
});

Deno.test("no guessed name is a real argument of a tool that searches or lists mail", () => {
  // A guess that became a real property would be refused for a reason this
  // table no longer describes. (`filter` is an automation argument, a
  // different tool, where a guess is never hinted.)
  const tools = ["email_read", "email_organize", "email_delete"];
  const real = new Set(
    tools.flatMap((tool) => Object.values(CONSOLIDATED_ARGUMENT_INDEX[tool].allowedByAction).flat()),
  );
  for (const tool of PER_OPERATION_LISTING) {
    if (!/^email_(list|search|read|move|delete|search_and)/.test(tool.name)) continue;
    const schema = (tool as { listedInputSchema?: Record<string, unknown> }).listedInputSchema ??
      tool.inputSchema;
    for (const name of Object.keys((schema.properties ?? {}) as Record<string, unknown>)) real.add(name);
  }
  for (const name of guessedArgumentNames()) assert(!real.has(name), `${name} is a real argument`);
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

Deno.test("a guessed date name is answered on both surfaces", async () => {
  const consolidated = await call("email_read", { action: "search", start_date: "2026-10-01", end_date: "2026-10-10" });
  assertStringIncludes(
    consolidated,
    "arguments.start_date is not an argument of action 'search'; dates are filtered with since (on or after)",
  );
  assertStringIncludes(consolidated, "arguments.end_date is not an argument of action 'search' either.");
  const perOperation = await call("email_search", { after: "2026-10-01" });
  assertStringIncludes(perOperation, "arguments.after is not an argument of email_search; dates are filtered with since");
});

Deno.test("a date guess on list names the search that takes since and before, on both surfaces", async () => {
  const consolidated = await call("email_read", { action: "list", until: "2026-10-10" });
  assertStringIncludes(
    consolidated,
    "arguments.until is not an argument of action 'list', which has no date filter; action 'search' takes since and before.",
  );
  const perOperation = await call("email_list", { until: "2026-10-10" });
  assertStringIncludes(
    perOperation,
    "arguments.until is not an argument of email_list, which has no date filter; email_search takes since and before.",
  );
});

Deno.test("a criteria wrapper is answered end to end", async () => {
  const text = await call("email_read", { action: "search", criteria: "SINCE 1-Oct-2026" });
  assertStringIncludes(text, "arguments.criteria is not an argument of action 'search'; the search criteria are separate");
});

Deno.test("email_read with no message_id says where one comes from", async () => {
  const text = await call("email_read", { action: "read" });
  assertStringIncludes(
    text,
    "arguments.message_id is required; it is the id each message carries in a list or search result.",
  );
});

Deno.test("email_list since/before/include_folders says such a search needs nothing else", async () => {
  const text = await call("email_list", { since: "2026-10-01", before: "2026-10-10", include_folders: ["INBOX"] });
  assertStringIncludes(
    text,
    "arguments.since is not an argument of email_list; a search with only since or before needs no other criterion; email_search takes it.",
  );
  assertStringIncludes(
    text,
    "arguments.include_folders is not an argument of email_list; a list reads the one folder named in folder; email_search takes it.",
  );
});

Deno.test("the per-operation email_list description says where dates and folders are", () => {
  const tool = PER_OPERATION_LISTING.find((listed) => listed.name === "email_list")!;
  assertStringIncludes(tool.description, "It has no date filter and reads one folder");
  assertStringIncludes(tool.description, "include_folders are email_search's");
});
