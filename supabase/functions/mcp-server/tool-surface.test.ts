// ---------------------------------------------------------------------------
// The tool surface: what `tools/list` advertises, and what `tools/call` still
// accepts.
//
// These are two different sets on purpose, and the gap between them is a
// back-compatibility obligation rather than an oversight.
//
// WHY THE GAP EXISTS. Anthropic's connector review criteria reject a tool that
// mixes safe and unsafe operations behind one name, and require the halves to
// be separate TOOLS rather than separately documented actions. Five tools were
// non-compliant: `folder`, `draft`, `schedule`, `signature` and `automation`
// each carried a read action in among their writes.
//
// WHY THE GAP CANNOT BE CLOSED. claude.ai caches a connector's tool SET at
// connect time. Every user connected before 2026-09-09 holds those five names
// with their ORIGINAL action enums. Moving the read actions rather than
// copying them would break the first `folder{action:"list"}` that any of those
// sessions makes, with no warning and no path to recovery short of every user
// reconnecting. So the split is advertised-only: the read halves are published
// under new names, and the old names keep accepting everything they ever did.
//
// That makes this file's second half the load-bearing one. The first half can
// only tell you the directory submission is well-formed; the second half is
// what tells you the paying customers connected right now still work.
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isAdvertisedTool } from "./advertised-schema.ts";
import { allowsLenientArguments } from "./consolidated-arguments.ts";
import { actionSelectorIndex, resolveActionSelector } from "./action-selector.ts";
import { retiredArgumentNames } from "./argument-aliases.ts";
import { serializeToolForList } from "./mcp-app-resources.ts";

// index.ts builds its registry at module load and reads env while doing it, so
// the environment has to be arranged BEFORE the import runs. A static import is
// hoisted above these calls, hence the dynamic one.
//
//   MCP_INTROSPECTION_ONLY  the mode the Dockerfile already uses to load this
//                           module with no Supabase credentials. Its whole
//                           point is looking at the tool surface.
//   MCP_SERVER_NO_LISTEN    skip the Deno.serve at the bottom of index.ts, so
//                           importing it here does not bind a port.
Deno.env.set("MCP_INTROSPECTION_ONLY", "1");
Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
const { CONSOLIDATED_SPECS, TOOL_ANNOTATIONS, TOOL_REGISTRY, validateInputSchema } = await import(
  "./index.ts"
);

/** Every tool `tools/list` emits for a key holding every scope. */
function advertisedTools() {
  return TOOL_REGISTRY.filter((tool) => isAdvertisedTool(tool.name));
}

function registryEntry(name: string) {
  const tool = TOOL_REGISTRY.find((candidate) => candidate.name === name);
  assert(tool, `${name} is missing from TOOL_REGISTRY`);
  return tool!;
}

/** The `action` enum as it reaches a client, via the real serializer. */
function advertisedActions(name: string): string[] {
  const listed = serializeToolForList(registryEntry(name)) as {
    inputSchema: { properties?: Record<string, { enum?: string[] }> };
  };
  return listed.inputSchema.properties?.action?.enum ?? [];
}

/** The `action` enum the validator enforces, which is the wider one. */
function acceptedActions(name: string): string[] {
  const schema = registryEntry(name).inputSchema as {
    properties?: Record<string, { enum?: string[] }>;
  };
  return schema.properties?.action?.enum ?? [];
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. The advertised surface
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("tools/list advertises exactly the post-split surface", () => {
  assertEquals(
    advertisedTools().map((tool) => tool.name),
    [
      "inbox_list",
      "email_read",
      "email_organize",
      "email_delete",
      "email_compose",
      "folder_list",
      "folder",
      "draft_list",
      "draft",
      "schedule_list",
      "schedule",
      "signature_get",
      "signature_set",
      "automation_read",
      "automation",
      "contact_search",
      "approval_review",
      "approval_decide",
      "approval_update",
      "approval_schedule",
      "bulk_execute",
      "bulk_cancel",
    ],
  );
});

Deno.test("`signature` is registered and callable but never listed", () => {
  assert(!isAdvertisedTool("signature"), "signature is withheld from tools/list");
  assert(
    !advertisedTools().some((tool) => tool.name === "signature"),
    "and really is absent from the advertised list",
  );
  // The point of withholding rather than deleting.
  assert(registryEntry("signature"), "but it is still in the registry, so it still dispatches");
});

Deno.test("no advertised tool mixes read and write operations", () => {
  // The review criterion itself, expressed against the annotations the
  // directory reads. For a consolidated tool, every action it ADVERTISES must
  // agree with the tool's own readOnlyHint: a read-only tool may keep an
  // action enum, but a tool that writes must not advertise a way to only read.
  //
  // Derived from TOOL_ANNOTATIONS, which is the per-operation table the legacy
  // tools already publish, so this cannot drift from what the operations are.
  for (const tool of advertisedTools()) {
    const spec = CONSOLIDATED_SPECS[tool.name];
    if (!spec) continue; // inbox_list, contact_search, the app-only tools.
    const toolIsReadOnly = tool.annotations?.readOnlyHint === true;
    for (const [actionName, action] of Object.entries(spec.actions)) {
      if (action.advertised === false) continue;
      const operation = TOOL_ANNOTATIONS[action.legacy];
      assert(operation, `${action.legacy} has no annotations to check`);
      assertEquals(
        operation.readOnlyHint,
        toolIsReadOnly,
        `${tool.name} is ${toolIsReadOnly ? "read-only" : "a write tool"} but advertises ` +
          `'${actionName}' (${action.legacy}), which is ` +
          `${operation.readOnlyHint ? "read-only" : "a write"}`,
      );
    }
  }
});

Deno.test("the write tools advertise their writes and nothing else", () => {
  assertEquals(advertisedActions("folder"), ["create", "rename", "delete"]);
  assertEquals(advertisedActions("draft"), ["create", "reply", "update", "send", "delete"]);
  assertEquals(advertisedActions("schedule"), ["create", "cancel"]);
  assertEquals(advertisedActions("automation"), [
    "create",
    "update",
    "enable",
    "disable",
    "delete",
  ]);
});

Deno.test("the read tools are read-only and carry no write action", () => {
  // A read-only tool MAY keep an action enum under the criteria, which is why
  // automation_read is one tool over four actions rather than four tools.
  assertEquals(advertisedActions("automation_read"), ["list", "get", "runs", "preview"]);
  // The other four have no selector at all: they are one operation each.
  for (const name of ["folder_list", "draft_list", "schedule_list", "signature_get"]) {
    assertEquals(advertisedActions(name), [], `${name} takes no action argument`);
  }
  for (const name of ["folder_list", "draft_list", "schedule_list", "signature_get", "automation_read"]) {
    assertEquals(
      registryEntry(name).annotations?.readOnlyHint,
      true,
      `${name} must be annotated read-only, the directory auto-permissions on it`,
    );
    assertEquals(registryEntry(name).annotations?.destructiveHint, false, `${name} destroys nothing`);
  }
});

Deno.test("the tools split out of a mixed one keep the right write annotations", () => {
  assertEquals(registryEntry("signature_set").annotations?.readOnlyHint, false);
  assertEquals(registryEntry("signature_set").annotations?.destructiveHint, false);
  // folder deletes a label off every message carrying it, and draft discards an
  // unsent draft. Both were already flagged destructive and must stay so: the
  // client reads the annotation, not the prose.
  assertEquals(registryEntry("folder").annotations?.destructiveHint, true);
  assertEquals(registryEntry("draft").annotations?.destructiveHint, true);
  assertEquals(registryEntry("automation").annotations?.destructiveHint, true);
});

Deno.test("every advertised tool is directory-submittable", () => {
  for (const tool of advertisedTools()) {
    const listed = serializeToolForList(tool) as Record<string, unknown>;
    assert(listed.name, "a tool needs a name");
    assert(
      (listed.name as string).length <= 64,
      `${listed.name} is ${(listed.name as string).length} characters, over the 64 limit`,
    );
    assert(listed.title, `${tool.name} needs a title`);
    const annotations = listed.annotations as Record<string, unknown> | undefined;
    assert(annotations, `${tool.name} needs annotations`);
    assertEquals(
      typeof annotations!.readOnlyHint,
      "boolean",
      `${tool.name} needs readOnlyHint, the directory auto-permissions on it`,
    );
    assertEquals(
      typeof annotations!.destructiveHint,
      "boolean",
      `${tool.name} needs destructiveHint`,
    );
  }
});

Deno.test("a read tool that returns mailbox-authored text keeps its untrusted_content warning", () => {
  // Folder and label names are written by whoever created them, which on a
  // shared, delegated or migrated mailbox is not the account owner. Splitting
  // the read out of `folder` must not lose the warning that travelled with it.
  assert(
    registryEntry("folder_list").description.includes("untrusted_content"),
    "folder_list must still say its result is data, never instructions",
  );
  assert(
    registryEntry("draft_list").description.includes("untrusted_content"),
    "a reply draft's subject and recipients come from the message it answers",
  );
});

Deno.test("a write tool no longer describes the read action it lost", () => {
  // The prose has to match the enum, or a model reads about an action it
  // cannot select and the directory reviewer reads a tool that documents a
  // read it does not perform.
  for (const name of ["folder", "draft", "schedule"]) {
    const description = registryEntry(name).description;
    assert(
      !/'list'/.test(description),
      `${name} still describes a 'list' action it does not advertise: ${description}`,
    );
  }
  for (const quoted of ["'list'", "'get'", "'runs'", "'preview'"]) {
    assert(
      !registryEntry("automation").description.includes(quoted),
      `automation still describes ${quoted}, which moved to automation_read`,
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Back-compatibility: the surface `tools/call` still accepts
//
// Everything below describes a client that connected BEFORE the split and is
// holding a cached tool set. None of these calls can be made by a client that
// connects today, and all of them must keep working.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The retired call shapes, and the handler each one must still reach.
 *
 * `args` carries the action's own required arguments and nothing else, so a
 * validation failure below means the ACTION was refused rather than that the
 * fixture forgot a field.
 */
const RETIRED_READ_CALLS: ReadonlyArray<
  { tool: string; action: string; legacy: string; args?: Record<string, unknown> }
> = [
  { tool: "folder", action: "list", legacy: "folder_list" },
  { tool: "draft", action: "list", legacy: "draft_list" },
  { tool: "schedule", action: "list", legacy: "schedule_list" },
  { tool: "signature", action: "get", legacy: "signature_get" },
  { tool: "automation", action: "list", legacy: "automation_list" },
  {
    tool: "automation",
    action: "get",
    legacy: "automation_get",
    args: { automation_id: "8f1d0b6e-0000-4000-8000-000000000000" },
  },
  {
    tool: "automation",
    action: "runs",
    legacy: "automation_runs",
    args: { automation_id: "8f1d0b6e-0000-4000-8000-000000000000" },
  },
  { tool: "automation", action: "preview", legacy: "automation_preview" },
];

Deno.test("every old consolidated name is still in the registry, so it still dispatches", () => {
  // handleToolsCall looks the tool up with TOOL_REGISTRY.find(t => t.name ===
  // toolName). A name absent from here is an immediate -32602 Unknown tool.
  for (const name of ["folder", "draft", "schedule", "signature", "automation"]) {
    assert(registryEntry(name), `${name} must stay callable`);
  }
});

Deno.test("the old names still ACCEPT the read actions they no longer advertise", () => {
  for (const { tool, action } of RETIRED_READ_CALLS) {
    assert(
      acceptedActions(tool).includes(action),
      `${tool}{action:"${action}"} must still validate`,
    );
    assert(
      !advertisedActions(tool).includes(action) || !isAdvertisedTool(tool),
      `${tool} should no longer advertise '${action}'`,
    );
  }
  // `signature` keeps both halves: it is withheld from tools/list entirely
  // rather than narrowed, so a cached client can still read AND write.
  assertEquals(acceptedActions("signature"), ["get", "set"]);
});

Deno.test("a retired read call passes the server's own validator", () => {
  // This is the assertion that would actually catch the break. handleToolsCall
  // validates against `tool.inputSchema`, the FULL schema, never the narrowed
  // copy that goes out on the wire, so the two must genuinely differ here.
  for (const { tool, action, args } of RETIRED_READ_CALLS) {
    const errors = validateInputSchema(registryEntry(tool).inputSchema, { action, ...args });
    assertEquals(
      errors,
      [],
      `${tool}{action:"${action}"} was rejected by the validator: ${JSON.stringify(errors)}`,
    );
  }
  const setErrors = validateInputSchema(registryEntry("signature").inputSchema, {
    action: "set",
    signature_text: "hello",
  });
  assertEquals(setErrors, [], `signature{action:"set"} was rejected: ${JSON.stringify(setErrors)}`);
});

Deno.test("a retired read call is rejected by the schema we now advertise", () => {
  // The mirror of the test above, and the reason both are here: if the
  // advertised schema still accepted these, the split would be cosmetic and
  // the directory criterion would not be met. If the full schema rejected
  // them, every existing connection would be broken. Only both together say
  // the change did what it claims.
  for (const { tool, action, args } of RETIRED_READ_CALLS) {
    if (!isAdvertisedTool(tool)) continue; // `signature` publishes no schema at all.
    const listed = serializeToolForList(registryEntry(tool)) as {
      inputSchema: Record<string, unknown>;
    };
    const errors = validateInputSchema(listed.inputSchema, { action, ...args });
    assert(
      errors.length > 0,
      `${tool} still advertises '${action}', so the read/write split is not real`,
    );
  }
});

Deno.test("a retired read action still routes to the handler it always did", () => {
  // dispatchName = actionSpec.legacy in handleToolsCall, and every downstream
  // decision keys off that name: billing (BILLABLE_TOOL_NAMES), rate limits,
  // the byte-heavy concurrency cap, idempotency, and the activity_log row an
  // operator reads. A changed legacy target would silently re-bill and
  // re-route a call that used to work.
  for (const { tool, action, legacy } of RETIRED_READ_CALLS) {
    assertEquals(
      CONSOLIDATED_SPECS[tool].actions[action].legacy,
      legacy,
      `${tool}{action:"${action}"} must still dispatch to ${legacy}`,
    );
  }
});

Deno.test("both names for one operation reach the same handler", () => {
  // The split must be two names for one code path, not two code paths. If
  // these ever diverge, a caller gets a different answer depending on which
  // name it used, which is the failure the whole design is meant to prevent.
  assertEquals(registryEntry("folder_list").name, CONSOLIDATED_SPECS.folder.actions.list.legacy);
  assertEquals(registryEntry("draft_list").name, CONSOLIDATED_SPECS.draft.actions.list.legacy);
  assertEquals(
    registryEntry("schedule_list").name,
    CONSOLIDATED_SPECS.schedule.actions.list.legacy,
  );
  assertEquals(
    registryEntry("signature_get").name,
    CONSOLIDATED_SPECS.signature.actions.get.legacy,
  );
  assertEquals(
    registryEntry("signature_set").name,
    CONSOLIDATED_SPECS.signature.actions.set.legacy,
  );
  for (const action of ["list", "get", "runs", "preview"]) {
    assertEquals(
      CONSOLIDATED_SPECS.automation_read.actions[action].legacy,
      CONSOLIDATED_SPECS.automation.actions[action].legacy,
      `automation_read '${action}' must reach the same handler as automation '${action}'`,
    );
  }
});

Deno.test("the old names keep their scopes, so an existing key stays authorized", () => {
  // isToolAuthorized is required-scope OR any altScope. A read-only key has
  // always been able to call folder{action:"list"}; narrowing the tool to its
  // writes must not take that away, which means the withheld action's scope
  // has to stay in the union.
  const folder = registryEntry("folder");
  const folderScopes = [folder.requiredScope, ...(folder.altScopes ?? [])];
  assert(
    folderScopes.includes("read:email"),
    `a read:email key must stay authorized for folder{action:"list"}, got ${folderScopes}`,
  );
  const signature = registryEntry("signature");
  const signatureScopes = [signature.requiredScope, ...(signature.altScopes ?? [])];
  assert(signatureScopes.includes("read:email"), "signature{get} needs read:email");
  assert(signatureScopes.includes("send:email"), "signature{set} needs send:email");
});

Deno.test("the action selector still resolves a retired read action", () => {
  // Selector resolution is built from spec.actions, and the sibling-argument
  // leniency from LENIENT_ACTIONS. Both are keyed by tool name, so a tool that
  // kept an action in its spec but lost it from one of these tables would
  // reject or harden a call that used to succeed.
  for (const { tool, action } of RETIRED_READ_CALLS) {
    const index = actionSelectorIndex(CONSOLIDATED_SPECS[tool].actions);
    const resolved = resolveActionSelector(
      tool,
      action,
      index,
      (candidate) => allowsLenientArguments(tool, candidate),
    );
    assertEquals(resolved?.action, action, `${tool} must still resolve the selector '${action}'`);
    assertEquals(resolved?.kind, "exact", `and read it as the enum member it is`);
  }
});

Deno.test("automation_read can never be dispatched under its own name", () => {
  // A NAMING HAZARD worth pinning. handleToolsCall routes automations by
  // prefix — `dispatchName.startsWith("automation_")` — and then strips that
  // prefix to get the operation: runAutomationTool(dispatchName.slice(11)).
  // `automation_read` matches that prefix, so if it ever reached dispatch
  // under its own name it would call a nonexistent "read" operation.
  //
  // It cannot, because a consolidated tool always has dispatchName rewritten
  // to actionSpec.legacy before dispatch, and the only other path returns an
  // error. This test pins the premise that makes that true: it must stay a
  // CONSOLIDATED tool, never a registry entry that dispatches under its name.
  assert(
    CONSOLIDATED_SPECS.automation_read,
    "automation_read must remain consolidated; a bare registry entry would " +
      "dispatch under its own name and hit the automation_ prefix route",
  );
  for (const [action, spec] of Object.entries(CONSOLIDATED_SPECS.automation_read.actions)) {
    assert(
      spec.legacy.startsWith("automation_") && spec.legacy !== "automation_read",
      `automation_read '${action}' dispatches to ${spec.legacy}, which the prefix route cannot handle`,
    );
  }
});

Deno.test("no promoted read tool depends on argument-alias rewriting", () => {
  // normalizeArgumentAliases runs only on the CONSOLIDATED path. A read tool
  // promoted to its own name skips it, so it must not be one whose arguments
  // were ever renamed, or a retired argument name would silently stop being
  // accepted under the new tool while still working under the old one.
  for (const name of ["folder_list", "draft_list", "schedule_list", "signature_get", "signature_set"]) {
    assertEquals(
      retiredArgumentNames(name),
      [],
      `${name} has retired argument names but is dispatched off the consolidated path`,
    );
  }
});

Deno.test("the new read tool is exactly as lenient as the actions it replaced", () => {
  // A misplaced sibling argument is dropped and disclosed on a read, refused on
  // a write. automation_read must inherit that decision unchanged, 'preview'
  // included: it is a dry run, but its purpose is to decide whether to enable a
  // rule that then runs unattended, so it stays strict.
  for (const action of ["list", "get", "runs", "preview"]) {
    assertEquals(
      allowsLenientArguments("automation_read", action),
      allowsLenientArguments("automation", action),
      `automation_read '${action}' must match automation '${action}'`,
    );
  }
});
