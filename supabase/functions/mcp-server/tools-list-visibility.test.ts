// ---------------------------------------------------------------------------
// Who sees which tools in `tools/list`, and what the first consent asks for.
//
// Two credentials reach this server and they are treated differently on
// purpose. The gap is the whole point of the file.
//
//   A DASHBOARD API KEY stays scope-filtered, exactly as it has been since the
//   registry existed. A user who ticked only "read" when creating the key made
//   a deliberate security choice, and integrations built on that key expect a
//   narrow key to sync a narrow tool list. Any change to that is a regression
//   in a security feature people paid attention to.
//
//   AN OAUTH TOKEN sees the whole advertised catalogue whatever it currently
//   holds, because claude.ai caches a connector's tool SET at connect time. A
//   tool hidden at connect time stays hidden until the user manually refreshes
//   the tool list, so a step-up that grants `send:email` to a session with no
//   send tool in it grants nothing anyone can use, and the step-up would never
//   be triggered in the first place, because the model never sees a reason to
//   try. Enforcement moves entirely to `tools/call`, which answers with the
//   403 insufficient_scope challenge the MCP step-up flow is built on.
//
// The second half pins the claim the 401 challenge in
// apps/web/app/api/mcp/route.ts is built on: that `read:email` alone covers
// connecting and reading. If someone re-scopes a read tool, that comment
// becomes a lie and the first consent stops being sufficient. This is where
// that is caught.
//
// Run: deno test -A --no-check supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import { isAdvertisedTool } from "./advertised-schema.ts";
import { buildInsufficientScopeChallenge } from "./scope-challenge.ts";

// index.ts builds its registry at module load and reads env while doing it, so
// the environment has to be arranged BEFORE the import runs. See the same note
// in tool-surface.test.ts.
Deno.env.set("MCP_INTROSPECTION_ONLY", "1");
Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
const {
  CONSOLIDATED_SPECS,
  handleToolsCall,
  isOAuthIssuedKey,
  isToolAuthorized,
  TOOL_REGISTRY,
  toolsForListing,
} = await import("./index.ts");

/** The scope our 401 challenge asks a brand-new connection to consent to. */
const FIRST_CONSENT_SCOPES = ["read:email"];

/**
 * An `api_keys` row shaped like the two issuers actually write it.
 *
 * `POST /api/oauth/token` always sets an `expires_at` (one hour out) and names
 * the row "OAuth: <client>". The dashboard routes have no code path that writes
 * `expires_at` at all and take the name verbatim from the user. Both fixtures
 * mirror that, because both fields are what isOAuthIssuedKey reads.
 */
function oauthToken(scopes: string[], name = "OAuth: Claude") {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspace_id: "22222222-2222-4222-8222-222222222222",
    name,
    key_prefix: "mcpe_abc",
    key_hash: "",
    scopes,
    inbox_ids: null,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    last_used_at: null,
    deleted_at: null,
    created_at: new Date().toISOString(),
  };
}

function dashboardKey(scopes: string[], name = "Read-only automation") {
  return { ...oauthToken(scopes, name), expires_at: null };
}

function names(tools: Array<{ name: string }>): string[] {
  return tools.map((tool) => tool.name);
}

/** Every tool `tools/list` may ever emit, withheld names already removed. */
function everyAdvertisedName(): string[] {
  return TOOL_REGISTRY.filter((tool) => isAdvertisedTool(tool.name))
    .map((tool) => tool.name);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Telling the two credentials apart
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("an OAuth token is recognised by BOTH the name prefix and the expiry", () => {
  assert(isOAuthIssuedKey(oauthToken(["read:email"])), "the shape the token route writes");
  // The disambiguated name a second authorization of the same client gets.
  assert(isOAuthIssuedKey(oauthToken(["read:email"], "OAuth: Claude (2)")));
});

Deno.test("a dashboard key is never mistaken for an OAuth token", () => {
  assert(!isOAuthIssuedKey(dashboardKey(["read:email"])));
  // The spoof that matters: key names are free text, so a user CAN name a
  // dashboard key after the OAuth flow. No dashboard route writes an expiry,
  // so the second signal refuses it. Getting this wrong would silently widen
  // one user's own tool list, never anyone else's, but the filtered path is a
  // security feature and must not be reachable by naming a key.
  assert(
    !isOAuthIssuedKey(dashboardKey(["read:email"], "OAuth: Claude")),
    "an OAuth-looking NAME alone must not unfilter a dashboard key",
  );
  // And the mirror: an expiry alone (a future expiring-dashboard-key feature)
  // must not unfilter one either.
  assert(
    !isOAuthIssuedKey(oauthToken(["read:email"], "Expiring CI key")),
    "an expiry alone must not unfilter a dashboard key",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The dashboard key's list is untouched
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("a dashboard key is still filtered to exactly the tools its scopes allow", () => {
  const key = dashboardKey(["read:email"]);
  const listed = names(toolsForListing(key));
  // Stated literally rather than derived: this is the surface a read-only key
  // has been syncing, and the assertion is worth nothing if it recomputes the
  // implementation. contact_search joined it on 2026-09-11, when read:email
  // became an alternative scope on it (section 5).
  assertEquals(listed, [
    "inbox_list",
    "email_read",
    "folder_list",
    "folder",
    "signature_get",
    "contact_search",
  ]);
  for (const forbidden of ["email_compose", "email_delete", "draft", "schedule", "automation"]) {
    assert(!listed.includes(forbidden), `a read-only dashboard key must not see ${forbidden}`);
  }
});

Deno.test("the filtered list is still exactly isToolAuthorized, for every scope subset", () => {
  // The property, checked across the whole scope space one scope at a time
  // plus a couple of realistic combinations, so a change to the filter cannot
  // pass by getting one hand-written case right.
  const allScopes = [
    "read:email",
    "search:email",
    "send:email",
    "manage:folders",
    "delete:email",
    "manage:drafts",
    "manage:contacts",
    "schedule:email",
    "manage:automations",
  ];
  const subsets = [
    [],
    ...allScopes.map((scope) => [scope]),
    ["read:email", "send:email"],
    ["read:email", "manage:folders", "delete:email"],
    allScopes,
  ];
  for (const scopes of subsets) {
    const expected = TOOL_REGISTRY
      .filter((tool) => isAdvertisedTool(tool.name))
      .filter((tool) => isToolAuthorized(tool, scopes))
      .map((tool) => tool.name);
    assertEquals(
      names(toolsForListing(dashboardKey(scopes))),
      expected,
      `a dashboard key with [${scopes.join(", ")}] must see exactly what it is authorized for`,
    );
  }
});

Deno.test("a dashboard key holding every scope sees the whole advertised surface", () => {
  // The boundary case that makes the two paths agree, and the reason the
  // introspection key (all scopes, no expiry) still grades on a full surface.
  const everything = [
    "read:email",
    "search:email",
    "send:email",
    "manage:folders",
    "delete:email",
    "manage:drafts",
    "manage:contacts",
    "schedule:email",
    "manage:automations",
  ];
  assertEquals(names(toolsForListing(dashboardKey(everything))), everyAdvertisedName());
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The OAuth token's list is the whole catalogue
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("a read-only OAuth token is shown every advertised tool", () => {
  // The change. A token holding only the first-consent scope must still be
  // able to SEE email_compose, or the step-up that would grant send:email is
  // never triggered and the scope can never be acquired.
  assertEquals(names(toolsForListing(oauthToken(FIRST_CONSENT_SCOPES))), everyAdvertisedName());
});

Deno.test("an OAuth token with no scopes at all is shown every advertised tool", () => {
  assertEquals(names(toolsForListing(oauthToken([]))), everyAdvertisedName());
});

Deno.test("unfiltering does NOT resurrect a withheld tool", () => {
  // isAdvertisedTool is about a name kept callable for clients that cached it
  // (`signature`), not about permission. Dropping the scope filter must not be
  // read as dropping that one too: publishing `signature` would re-advertise a
  // tool that mixes a read and a write behind one name, which is precisely
  // what the connector review criteria reject.
  const listed = names(toolsForListing(oauthToken([])));
  assert(!listed.includes("signature"), "`signature` stays withheld from every credential");
  assert(
    TOOL_REGISTRY.some((tool) => tool.name === "signature"),
    "and stays in the registry, so a cached client can still call it",
  );
});

Deno.test("the two paths differ, which is what makes the test above meaningful", () => {
  // A guard against a future refactor that quietly unfilters both: if these
  // two ever match for a narrow scope set, every assertion in section 2 is
  // passing for the wrong reason.
  const narrow = ["read:email"];
  assert(
    toolsForListing(oauthToken(narrow)).length > toolsForListing(dashboardKey(narrow)).length,
    "an OAuth token must see strictly more than a dashboard key with the same scopes",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. What the first consent has to cover
//
// The 401 in apps/web/app/api/mcp/route.ts asks a new connection for
// `read:email` and nothing else. These pin the registry facts that claim rests
// on, so re-scoping a read tool fails here rather than in production, where it
// would show up as a connector that cannot read anything after consent.
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("the first-consent scope covers connecting and reading", () => {
  for (const name of ["inbox_list", "email_read", "folder_list", "signature_get"]) {
    const tool = TOOL_REGISTRY.find((candidate) => candidate.name === name);
    assert(tool, `${name} is missing from TOOL_REGISTRY`);
    assert(
      isToolAuthorized(tool, FIRST_CONSENT_SCOPES),
      `${name} must be reachable with the first-consent scope alone, or a new ` +
        `connection can consent and still do nothing`,
    );
  }
});

Deno.test("every email_read action, search included, needs only the first-consent scope", () => {
  // `search:email` is deliberately absent from the first consent: it is only an
  // ALTERNATIVE on this one action, whose primary is already `read:email`. If
  // that ever stops being true, `search` starts 403-ing for a freshly consented
  // user and this is the assertion that says so.
  for (const [action, spec] of Object.entries(CONSOLIDATED_SPECS.email_read.actions)) {
    const { scope, altScopes } = spec as { scope: string; altScopes?: string[] };
    assert(
      FIRST_CONSENT_SCOPES.includes(scope) ||
        (altScopes ?? []).some((alt) => FIRST_CONSENT_SCOPES.includes(alt)),
      `email_read{action:"${action}"} needs ${scope}, which the first consent does not grant`,
    );
  }
});

Deno.test("the first consent grants no write, which is the point of narrowing it", () => {
  const key = dashboardKey(FIRST_CONSENT_SCOPES);
  // Read against the filtered path on purpose: it answers "what can this scope
  // set actually DO", independent of what the OAuth list advertises.
  for (const tool of toolsForListing(key)) {
    const spec = CONSOLIDATED_SPECS[tool.name];
    if (!spec) {
      // A single-operation tool: its own annotation is the answer.
      assertEquals(
        tool.annotations?.readOnlyHint,
        true,
        `${tool.name} is authorized by the first consent but is not read-only`,
      );
      continue;
    }
    // A consolidated tool may be authorized for its read action alone (folder
    // is, via read:email on the withheld `list`). What must hold is that no
    // WRITE action it carries is reachable with the first-consent scope.
    for (const [action, actionSpec] of Object.entries(spec.actions)) {
      const { scope, altScopes, legacy } = actionSpec as {
        scope: string;
        altScopes?: string[];
        legacy: string;
      };
      const reachable = FIRST_CONSENT_SCOPES.includes(scope) ||
        (altScopes ?? []).some((alt) => FIRST_CONSENT_SCOPES.includes(alt));
      if (!reachable) continue;
      assert(
        legacy.endsWith("_list") || legacy.endsWith("_get") ||
          ["email_read", "email_read_batch", "email_search", "email_attachment", "email_extract",
            "email_original"].includes(legacy),
        `${tool.name}{action:"${action}"} dispatches to ${legacy} and is reachable with the ` +
          `first-consent scope, but is not a read`,
      );
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. contact_search under a read:email grant
//
// read:email is an ALTERNATIVE scope on contact_search (2026-09-11). It returns
// only correspondents' names and addresses, which a read:email token already
// reads off message headers, so it grants no new data. Workspace 5bd59bac, on a
// `read:email search:email` grant, was refused it 4 times in one minute.
//
// These drive the real handleToolsCall, not just the registry, because the gate
// that refuses a call is an inline check there. The allowed calls send `{}`,
// which the schema rejects (query is required): validation runs right AFTER the
// scope gate and before any mailbox I/O, so an invalid-arguments answer is
// proof the gate let the call through.
// ═══════════════════════════════════════════════════════════════════════════

const NO_REQUEST_CONTEXT = { ipAddress: null, userAgent: null };

interface CallResponse {
  error?: { code: number; data?: Record<string, unknown> };
  result?: { isError?: boolean; content?: Array<{ text?: string }> };
}

async function callContactSearch(
  key: Parameters<typeof handleToolsCall>[2],
  args: Record<string, unknown> = {},
): Promise<CallResponse> {
  return await handleToolsCall(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "contact_search", arguments: args },
    },
    1,
    key,
    NO_REQUEST_CONTEXT,
  ) as CallResponse;
}

/** Passed the scope gate: stopped at argument validation, not at -32004. */
function assertPassedScopeGate(response: CallResponse, label: string) {
  assert(response.error?.code !== -32004, `${label} was refused by the scope gate`);
  assert(
    response.error?.code === -32602 || response.result?.isError === true,
    `${label} should reach argument validation, got ${JSON.stringify(response)}`,
  );
}

Deno.test("a read:email OAuth token can call contact_search", async () => {
  assertPassedScopeGate(await callContactSearch(oauthToken(["read:email"])), "read:email");
  // The exact grant 5bd59bac was denied on.
  assertPassedScopeGate(
    await callContactSearch(oauthToken(["read:email", "search:email"])),
    "read:email search:email",
  );
});

Deno.test("a read:email dashboard key can call contact_search, and lists it", async () => {
  const key = dashboardKey(["read:email"]);
  assertPassedScopeGate(await callContactSearch(key), "read:email dashboard key");
  assert(names(toolsForListing(key)).includes("contact_search"));
});

Deno.test("a manage:contacts grant still calls contact_search", async () => {
  assertPassedScopeGate(await callContactSearch(dashboardKey(["manage:contacts"])), "dashboard");
  assertPassedScopeGate(await callContactSearch(oauthToken(["manage:contacts"])), "OAuth");
});

Deno.test("a grant with neither read:email nor manage:contacts is still refused with -32004", async () => {
  // search:email is in here on purpose: it is an alternative on
  // email_read{action:"search"} only, and must not unlock contact_search.
  const held = ["send:email", "search:email", "manage:drafts"];
  for (const key of [dashboardKey(held), oauthToken(held), oauthToken([])]) {
    const response = await callContactSearch(key, { query: "priya" });
    assertEquals(response.error?.code, -32004, `[${key.scopes.join(", ")}] must be refused`);
    const data = response.error!.data!;
    // Primary first, alternative after it: the order the step-up relies on.
    assertEquals(data.required_scopes, ["manage:contacts", "read:email"]);
    assertEquals(data.required_scope, "manage:contacts");
  }
});

Deno.test("the step-up challenge for contact_search still names only manage:contacts", () => {
  // Adding an alternative must not widen the consent a 403 asks for.
  assertEquals(
    buildInsufficientScopeChallenge(
      ["manage:contacts", "read:email"],
      ["send:email"],
      "https://mcpemails.com/.well-known/oauth-protected-resource",
    ),
    'Bearer error="insufficient_scope", ' +
      'error_description="The token does not carry a scope this call requires.", ' +
      'scope="manage:contacts send:email", ' +
      'resource_metadata="https://mcpemails.com/.well-known/oauth-protected-resource"',
  );
});

Deno.test("no tool other than contact_search changed which scopes authorize it", () => {
  // [primary, ...alternatives] for every registered tool and every action of a
  // consolidated tool, stated literally from the registry as it stood before
  // the contact_search change. Any other re-scoping has to edit this table.
  const expected: Record<string, string[]> = {
    "inbox_list": ["read:email"],
    "email_read:list": ["read:email"],
    "email_read:read": ["read:email"],
    "email_read:read_batch": ["read:email"],
    "email_read:search": ["read:email", "search:email"],
    "email_read:attachment": ["read:email"],
    "email_read:extract": ["read:email"],
    "email_read:original": ["read:email"],
    "email_organize:move": ["manage:folders"],
    "email_organize:move_batch": ["manage:folders"],
    "email_organize:copy": ["manage:folders"],
    "email_organize:copy_batch": ["manage:folders"],
    "email_organize:flag": ["manage:folders"],
    "email_organize:archive": ["manage:folders"],
    "email_organize:search_and_move": ["manage:folders"],
    "email_search_and_move": ["manage:folders"],
    "email_delete:delete": ["delete:email"],
    "email_delete:delete_batch": ["delete:email"],
    "email_delete:search_and_delete": ["delete:email"],
    "email_compose:send": ["send:email"],
    "email_compose:reply": ["send:email"],
    "email_compose:forward": ["send:email"],
    "folder_list": ["read:email"],
    "folder:list": ["read:email"],
    "folder:create": ["manage:folders"],
    "folder:rename": ["manage:folders"],
    "folder:delete": ["manage:folders"],
    "draft_list": ["manage:drafts"],
    "draft:list": ["manage:drafts"],
    "draft:create": ["manage:drafts"],
    "draft:reply": ["manage:drafts"],
    "draft:update": ["manage:drafts"],
    "draft:send": ["send:email"],
    "draft:delete": ["manage:drafts"],
    "schedule_list": ["schedule:email"],
    "schedule:create": ["schedule:email"],
    "schedule:list": ["schedule:email"],
    "schedule:cancel": ["schedule:email"],
    "signature_get": ["read:email"],
    "signature_set": ["send:email"],
    "signature:get": ["read:email"],
    "signature:set": ["send:email"],
    "automation_read:list": ["manage:automations"],
    "automation_read:get": ["manage:automations"],
    "automation_read:runs": ["manage:automations"],
    "automation_read:preview": ["manage:automations"],
    "automation:create": ["manage:automations"],
    "automation:list": ["manage:automations"],
    "automation:get": ["manage:automations"],
    "automation:update": ["manage:automations"],
    "automation:enable": ["manage:automations"],
    "automation:disable": ["manage:automations"],
    "automation:delete": ["manage:automations"],
    "automation:runs": ["manage:automations"],
    "automation:preview": ["manage:automations"],
    "contact_search": ["manage:contacts", "read:email"],
    "approval_review": ["send:email", "schedule:email"],
    "approval_decide": ["send:email", "schedule:email"],
    "approval_update": ["send:email", "schedule:email"],
    "approval_schedule": ["send:email", "schedule:email"],
    "bulk_execute": ["delete:email", "manage:folders"],
    "bulk_cancel": ["delete:email", "manage:folders"],
  };
  const actual: Record<string, string[]> = {};
  for (const tool of TOOL_REGISTRY) {
    const spec = CONSOLIDATED_SPECS[tool.name];
    if (spec) {
      for (const [action, actionSpec] of Object.entries(spec.actions)) {
        const { scope, altScopes } = actionSpec as { scope: string; altScopes?: string[] };
        actual[`${tool.name}:${action}`] = [scope, ...(altScopes ?? [])];
      }
    } else {
      actual[tool.name] = [tool.requiredScope, ...(tool.altScopes ?? [])];
    }
  }
  assertEquals(actual, expected);
});
