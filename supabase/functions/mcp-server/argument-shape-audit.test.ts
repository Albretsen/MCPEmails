// ---------------------------------------------------------------------------
// The 2026-09-23 argument-shape audit: every call below was refused in
// production (or by a sweep of all 265 optional parameters) although what the
// caller meant was unambiguous. Each is now replayed through the REAL
// handleToolsCall.
//
// HOW "IT PASSED" IS OBSERVED WITHOUT A DATABASE. A call that passes validation
// goes on to the usage meter and the handler, which need Supabase. So every call
// carries one extra argument, `zz_canary`, that no tool declares. Validation
// then always fails, and the assertion is that the canary is the ONLY failure:
// everything else in the call was accepted, coerced, renamed or inferred. A
// control case proves the canary alone is what fails.
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildClampedArgumentsNote,
  coerceArgumentTypes,
  splitAddressList,
} from "./argument-coercion.ts";
import { dropRedundantAction, normalizeArgumentAliases } from "./argument-aliases.ts";
import { buildResolvedActionNote, inferMissingAction } from "./action-selector.ts";
import { normalizeMessageIdShape } from "./consolidated-arguments.ts";
import {
  byteStringToBase64url,
  recipientOverrideFrom,
  rewriteRecipientHeaders,
} from "./draft-recipients.ts";
import { buildFilteredNoMatchReport, matchesInboxFilter } from "./inbox-filter.ts";
import { invalidArgumentAuditDetails } from "./validation-observability.ts";

// See tool-surface.test.ts for why the environment is set before a dynamic import.
Deno.env.set("MCP_INTROSPECTION_ONLY", "1");
Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
const { CONSOLIDATED_ARGUMENT_INDEX, handleToolsCall, TOOL_REGISTRY } = await import("./index.ts");

const SCOPES = [
  "read:email", "search:email", "send:email", "manage:drafts", "manage:folders",
  "delete:email", "manage:contacts", "manage:automations", "manage:signatures",
  "schedule:email", "organize:email",
];

function key() {
  return {
    id: crypto.randomUUID(),
    workspace_id: crypto.randomUUID(),
    name: "Audit",
    key_prefix: "mcpe_abc",
    key_hash: "",
    scopes: SCOPES,
    inbox_ids: null,
    expires_at: null,
    last_used_at: null,
    deleted_at: null,
    created_at: new Date().toISOString(),
  };
}

/** The validation failures of a call, as "path keyword" strings. */
async function failures(tool: string, args: Record<string, unknown>): Promise<string[]> {
  // deno-lint-ignore no-explicit-any
  const response: any = await handleToolsCall(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: { ...args, zz_canary: 1 } } },
    1,
    key(),
    { ipAddress: null, userAgent: null },
  );
  const errors = response?.result?._meta?.["com.mcpemails/invalid_arguments"]?.errors;
  if (Array.isArray(errors)) {
    return errors.map((error: { path: string; keyword: string }) => `${error.path} ${error.keyword}`);
  }
  const text = response?.result?.content?.[0]?.text ?? response?.error?.message ?? "";
  return [`(unparsed) ${text}`];
}

const CANARY_ONLY = ["arguments.zz_canary additionalProperties"];

async function assertAccepted(tool: string, args: Record<string, unknown>, label: string) {
  assertEquals(await failures(tool, args), CANARY_ONLY, label);
}

// ── Control ─────────────────────────────────────────────────────────────────

Deno.test("control: the canary alone fails, and a real mistake still fails beside it", async () => {
  await assertAccepted("email_read", { action: "read", message_id: "m1" }, "a valid call");
  const withMistake = await failures("email_read", { action: "read", message_id: "m1", body_offset: "ten" });
  assert(withMistake.length === 2 && withMistake.includes("arguments.body_offset type"), withMistake.join("; "));
});

// ── F1: page sizes above their maximum are clamped ──────────────────────────

Deno.test("F1 limit above the maximum is accepted on reads", async () => {
  await assertAccepted("email_read", { action: "search", query: "invoice", limit: 200 }, "search limit 200");
  await assertAccepted("email_read", { action: "list", limit: 1000 }, "list limit 1000");
  await assertAccepted("email_read", { action: "read", message_id: "m1", body_max_chars: 100000 }, "body_max_chars");
  await assertAccepted("draft_list", { limit: 100 }, "draft_list");
  await assertAccepted("contact_search", { query: "anna", limit: 500 }, "contact_search");
  await assertAccepted("schedule_list", { limit: 500 }, "schedule_list");
});

Deno.test("F1 a cap on what a WRITE touches is still refused above its maximum", async () => {
  const refused = await failures("email_search_and_move", {
    from: "a@example.com",
    destination_folder_id: "Archive",
    limit: 501,
  });
  assert(refused.includes("arguments.limit maximum"), refused.join("; "));
  const rule = await failures("automation", {
    action: "create",
    name: "n",
    filter: { from: "a@example.com" },
    rule_action: { type: "mark_read" },
    interval_minutes: 60,
    max_messages_per_run: 1000,
  });
  assert(rule.includes("arguments.max_messages_per_run maximum"), rule.join("; "));
});

Deno.test("F1 the clamp is recorded with what was asked and what was used, and disclosed", () => {
  const args: Record<string, unknown> = { limit: 200, offset: 0 };
  const changed = coerceArgumentTypes(
    { type: "object", properties: { limit: { type: "integer", maximum: 100 }, offset: { type: "integer" } } },
    args,
    "",
    { clamp: ["limit"] },
  );
  assertEquals(args.limit, 100);
  assertEquals(changed, [{ path: "limit", from: "number", to: "clamped", requested: 200, used: 100 }]);
  assertEquals(
    buildClampedArgumentsNote(changed),
    "Note: limit 200 is above the maximum of 100, so 100 was used; call again with the returned next_offset for the rest.",
  );
  // Without the caller naming it as clampable, nothing is clamped.
  const untouched: Record<string, unknown> = { limit: 200 };
  coerceArgumentTypes({ type: "object", properties: { limit: { type: "integer", maximum: 100 } } }, untouched);
  assertEquals(untouched.limit, 200);
});

// ── F2: `action` on a tool that has none ────────────────────────────────────

Deno.test("F2 an action naming the tool's own operation is dropped", async () => {
  await assertAccepted("inbox_list", { action: "list" }, "inbox_list list");
  await assertAccepted("draft_list", { action: "list" }, "draft_list list");
  await assertAccepted("folder_list", { action: "list" }, "folder_list list");
  await assertAccepted("contact_search", { action: "search", query: "anna" }, "contact_search search");
  await assertAccepted("email_search_and_move", {
    action: "search_and_move",
    from: "a@example.com",
    destination_folder_id: "Archive",
  }, "email_search_and_move");
});

Deno.test("F2 an action naming a DIFFERENT operation is still refused", async () => {
  const refused = await failures("signature_set", { action: "get", signature_text: "x" });
  assert(refused.includes("arguments.action additionalProperties"), refused.join("; "));
  const args: Record<string, unknown> = { action: "delete" };
  assertEquals(dropRedundantAction("inbox_list", args), false);
  assertEquals(args.action, "delete");
});

// ── F3: `inbox` wherever `inbox_id` is taken ────────────────────────────────

Deno.test("F3 inbox is accepted on schedule_list, contact_search and inbox_list", async () => {
  await assertAccepted("schedule_list", { inbox: "a@example.com" }, "schedule_list");
  await assertAccepted("contact_search", { query: "anna", inbox: "a@example.com" }, "contact_search");
  await assertAccepted("inbox_list", { inbox: "a@example.com" }, "inbox_list inbox");
  await assertAccepted("inbox_list", { inbox_id: "a@example.com" }, "inbox_list inbox_id");
});

Deno.test("F3 inbox_list's inbox filter matches by address or by id, case-insensitively", () => {
  const row = { id: "1245C938-0000-4000-8000-000000000000", email_address: "Me@Example.com", provider: "imap", service: "gmail" };
  const base = { provider: null, service: null };
  assert(matchesInboxFilter(row, { ...base, inbox: "me@example.com" }));
  assert(matchesInboxFilter(row, { ...base, inbox: "1245c938-0000-4000-8000-000000000000" }));
  assert(!matchesInboxFilter(row, { ...base, inbox: "other@example.com" }));
  assert(matchesInboxFilter(row, { ...base, inbox: null }));
  const report = buildFilteredNoMatchReport({ ...base, inbox: "other@example.com" }, [row]);
  assert(report.message.includes("inbox 'other@example.com'"), report.message);
});

// ── F4: idempotency_key on every draft write ────────────────────────────────

Deno.test("F4 idempotency_key is accepted on draft create, reply, update and delete", async () => {
  await assertAccepted("draft", { action: "create", subject: "s", body: "b", idempotency_key: "k1" }, "create");
  await assertAccepted("draft", { action: "reply", message_id: "m1", body: "b", idempotency_key: "k1" }, "reply");
  await assertAccepted("draft", { action: "update", draft_id: "Drafts:1", body: "b", idempotency_key: "k1" }, "update");
  await assertAccepted("draft", { action: "delete", draft_id: "Drafts:1", idempotency_key: "k1" }, "delete");
});

Deno.test("F4 the migration and the server name the same draft operations", async () => {
  const migration = await Deno.readTextFile(
    new URL("../../migrations/20260923090000_idempotency_draft_writes.sql", import.meta.url),
  );
  const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const set = index.match(/const IDEMPOTENT_MUTATION_OPERATIONS = new Set\(\[([^\]]*)\]/);
  assert(set, "IDEMPOTENT_MUTATION_OPERATIONS not found");
  for (const name of set[1].matchAll(/"([a-z_]+)"/g)) {
    assert(migration.includes(`'${name[1]}'`), `${name[1]} is in the server set but not the CHECK constraint`);
  }
  for (const op of ["draft_create", "draft_reply", "draft_update", "draft_delete"]) {
    assert(set[1].includes(`"${op}"`), `${op} missing from IDEMPOTENT_MUTATION_OPERATIONS`);
  }
});

// ── F5: one id where a list is taken, and the reverse ───────────────────────

Deno.test("F5 message_id on a list-only action, and a one-item list on a single-id action", async () => {
  await assertAccepted("email_organize", { action: "flag", message_id: "m1", flag_action: "read" }, "flag");
  await assertAccepted("email_organize", { action: "move_batch", message_id: "m1", destination_folder_id: "Archive" }, "move_batch");
  await assertAccepted("email_delete", { action: "delete_batch", message_id: "m1" }, "delete_batch");
  await assertAccepted("email_organize", { action: "move", message_ids: ["m1"], destination_folder_id: "Archive" }, "move with [id]");
});

Deno.test("F5 several ids on a single-message action are NOT narrowed to the first", () => {
  const args: Record<string, unknown> = { message_ids: ["m1", "m2"] };
  assertEquals(normalizeMessageIdShape(["message_id"], args), null);
  assertEquals(args.message_ids, ["m1", "m2"]);
  const single: Record<string, unknown> = { message_id: "m1", message_ids: ["m2"] };
  assertEquals(normalizeMessageIdShape(["message_ids"], single), null, "both present: left for the validator");
});

// ── F6: an inbox named beside an object id is a check ───────────────────────

Deno.test("F6 inbox_id / inbox are accepted beside an automation or scheduled-send id", async () => {
  const rule = "33333333-3333-4333-8333-333333333333";
  const inbox = "44444444-4444-4444-8444-444444444444";
  for (const action of ["enable", "disable", "delete", "update"]) {
    const extra = action === "update" ? { name: "renamed" } : {};
    await assertAccepted("automation", { action, automation_id: rule, inbox_id: inbox, ...extra }, `automation ${action}`);
    await assertAccepted("automation", { action, automation_id: rule, inbox: "a@example.com", ...extra }, `automation ${action} by address`);
  }
  await assertAccepted("schedule", { action: "cancel", id: rule, inbox_id: inbox }, "schedule cancel");
});

// deno-lint-ignore no-explicit-any
function automationDeps(rule: any, resolvedInboxId: string, writes: any[]): any {
  const chain = (table: string) => {
    // deno-lint-ignore no-explicit-any
    const state: any = { op: "select" };
    // deno-lint-ignore no-explicit-any
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      is: () => builder,
      order: () => builder,
      limit: () => Promise.resolve({ data: [], error: null }),
      // deno-lint-ignore no-explicit-any
      update: (patch: any) => {
        state.op = "update";
        writes.push({ table, patch });
        return builder;
      },
      maybeSingle: () => Promise.resolve({ data: state.op === "update" ? { ...rule, enabled: true } : rule, error: null }),
      then: undefined,
    };
    return builder;
  };
  return {
    db: { from: chain },
    caller: { id: "key-1", workspace_id: "ws-1", scopes: SCOPES, inbox_ids: null },
    resolveInbox: () =>
      Promise.resolve({
        ok: true,
        inbox: { id: resolvedInboxId, workspace_id: "ws-1", email_address: "named@example.com", provider: "imap" },
      }),
    preview: () => Promise.resolve([]),
    now: () => 1_000_000,
  };
}

Deno.test("F6 a rule in a DIFFERENT inbox is refused and nothing is written", async () => {
  const { runAutomationTool } = await import("./triage-engine.ts");
  const rule = { id: "33333333-3333-4333-8333-333333333333", inbox_id: "inbox-A", action: { type: "mark_read" } };
  for (const action of ["enable", "disable", "delete", "get", "runs", "update"]) {
    const writes: unknown[] = [];
    const result = await runAutomationTool(
      action,
      { automation_id: rule.id, inbox_id: "inbox-B", name: "x" },
      automationDeps(rule, "inbox-B", writes),
    );
    assertEquals(result.logErrorCode, "inbox_mismatch", `${action} must refuse the mismatch`);
    assertEquals(writes.length, 0, `${action} must write nothing`);
  }
});

Deno.test("F6 a rule in the SAME inbox runs exactly as without the check", async () => {
  const { runAutomationTool } = await import("./triage-engine.ts");
  const rule = { id: "33333333-3333-4333-8333-333333333333", inbox_id: "inbox-A", action: { type: "mark_read" } };
  const writes: unknown[] = [];
  const result = await runAutomationTool(
    "enable",
    { automation_id: rule.id, inbox_id: "inbox-A" },
    automationDeps(rule, "inbox-A", writes),
  );
  assertEquals(result.logStatus, "success");
  assertEquals(writes.length, 1, "the enable write happened");
});

// ── F7 / F8: recipients on reply and at draft send ──────────────────────────

Deno.test("F7 cc and bcc are accepted on email_compose reply and draft reply", async () => {
  await assertAccepted("email_compose", { action: "reply", message_id: "m1", body: "b", cc: ["c@example.com"], bcc: ["d@example.com"] }, "compose reply");
  await assertAccepted("draft", { action: "reply", message_id: "m1", body: "b", cc: ["c@example.com"], bcc: ["d@example.com"] }, "draft reply");
});

Deno.test("F8 to / cc / bcc are accepted on draft send", async () => {
  await assertAccepted("draft", { action: "send", draft_id: "Drafts:1", to: ["a@example.com"] }, "send with to");
  await assertAccepted("draft", { action: "send", draft_id: "Drafts:1", cc: "c@example.com" }, "send with cc as a string");
});

Deno.test("F8 the override carries only the lists that were given", () => {
  assertEquals(recipientOverrideFrom({ draft_id: "x" }), null);
  assertEquals(recipientOverrideFrom({ to: [" a@example.com ", ""], bcc: [] }), { to: ["a@example.com"], bcc: [] });
});

Deno.test("F8 rewriting recipients changes only To/Cc/Bcc and keeps every body octet", () => {
  // A body with raw 8-bit octets (UTF-8 "blåbær" as a byte string), a folded
  // Subject and an existing multi-line To.
  const bodyBytes = Array.from(new TextEncoder().encode("blåbær\r\n"), (b) => String.fromCharCode(b)).join("");
  const raw = [
    "From: Me <me@example.com>",
    "To: old@example.com,",
    " older@example.com",
    "Subject: a folded",
    " subject",
    "Message-ID: <abc@mcpemails.com>",
    "Bcc: hidden@example.com",
    "MIME-Version: 1.0",
    "",
    bodyBytes,
  ].join("\r\n");
  const out = rewriteRecipientHeaders(raw, { to: ["new@example.com"], cc: ["c@example.com"] })!;
  const [head, body] = [out.slice(0, out.indexOf("\r\n\r\n")), out.slice(out.indexOf("\r\n\r\n") + 4)];
  assertEquals(body, bodyBytes, "body octets unchanged");
  assert(head.includes("To: new@example.com\r\nCc: c@example.com"), head);
  assert(!head.includes("old@example.com") && !head.includes("older@example.com"), "old To removed with its continuation");
  assert(head.includes("Subject: a folded\r\n subject"), "unrelated folded header kept");
  assert(head.includes("Bcc: hidden@example.com"), "Bcc not named, so kept");
  assert(head.indexOf("From:") < head.indexOf("To: new"), "new fields follow From");
  // Round trip through Gmail's base64url keeps every byte.
  assertEquals(atob(byteStringToBase64url(out).replace(/-/g, "+").replace(/_/g, "/")), out);
});

Deno.test("F8 an empty list removes the field; a messageId is stamped or added", () => {
  const raw = "From: me@example.com\nCc: c@example.com\n\nbody";
  const out = rewriteRecipientHeaders(raw, { cc: [] }, "new-id")!;
  assert(!out.includes("Cc:"), out);
  assert(out.includes("Message-ID: <new-id@mcpemails.com>"), "added when missing");
  assertEquals(rewriteRecipientHeaders("no separator here", { to: ["a@example.com"] }), null);
});

Deno.test("F8 a long recipient list is folded under 78 columns", () => {
  const addresses = Array.from({ length: 20 }, (_, i) => `person${i}@example.com`);
  const out = rewriteRecipientHeaders("From: me@example.com\r\n\r\nx", { to: addresses })!;
  const head = out.slice(0, out.indexOf("\r\n\r\n"));
  for (const line of head.split("\r\n")) assert(line.length <= 78, `line too long: ${line}`);
  for (const address of addresses) assert(head.includes(address), address);
});

// ── F9: synonyms ────────────────────────────────────────────────────────────

Deno.test("F9 the synonyms models write are accepted", async () => {
  await assertAccepted("email_read", { action: "read", email_id: "m1" }, "email_id");
  await assertAccepted("email_read", { action: "read", id: "m1" }, "id");
  await assertAccepted("email_read", { action: "read", message_id: "m1", body_length: 2000 }, "body_length");
  await assertAccepted("email_read", { action: "search", query: "x", body_limit: 500, max_results: 10 }, "body_limit + max_results");
  await assertAccepted("email_read", { action: "search", query: "x", has_attachments: true }, "has_attachments");
  await assertAccepted("email_organize", { action: "move_batch", message_ids: ["m1"], destination_folder: "Archive" }, "destination_folder");
  await assertAccepted("email_search_and_move", { from: "a@example.com", destination_folder: "Archive" }, "destination_folder standalone");
});

Deno.test("F9 is_read inverts into unread; the canonical name wins when both are sent", () => {
  const read: Record<string, unknown> = { is_read: true };
  normalizeArgumentAliases("email_read", read);
  assertEquals(read, { unread: false });
  const both: Record<string, unknown> = { id: "m1", message_id: "m2" };
  normalizeArgumentAliases("email_read", both);
  assertEquals(both, { message_id: "m2" });
});

// ── F10: email_read without an action ───────────────────────────────────────

Deno.test("F10 a selector-less email_read is read from its arguments", async () => {
  await assertAccepted("email_read", { message_id: "m1" }, "→ read");
  await assertAccepted("email_read", { message_ids: ["m1", "m2"] }, "→ read_batch");
  await assertAccepted("email_read", { query: "invoice" }, "→ search");
  await assertAccepted("email_read", { limit: 5 }, "→ list");
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ message_id: "m1", attachment_index: 0 }, "attachment"],
    [{ message_id: "m1" }, "read"],
    [{ message_ids: ["m1"] }, "read_batch"],
    [{ from: "a@example.com" }, "search"],
    [{}, "list"],
  ];
  for (const [args, action] of cases) assertEquals(inferMissingAction("email_read", args)?.action, action);
  const note = buildResolvedActionNote("email_read", inferMissingAction("email_read", { message_id: "m1" })!);
  assert(note.includes("without an action") && note.includes("'read'"), note);
});

Deno.test("F10 no other tool guesses a missing action", async () => {
  assertEquals(inferMissingAction("email_delete", { message_id: "m1" }), null);
  const refused = await failures("email_delete", { message_id: "m1" });
  assert(refused.some((entry) => entry.includes("requires an 'action'")), refused.join("; "));
});

// ── F11 – F14: shapes ───────────────────────────────────────────────────────

Deno.test("F11 null for an unset optional field is treated as absent", async () => {
  await assertAccepted("inbox_list", { provider: null, service: null }, "inbox_list");
  await assertAccepted("email_compose", {
    action: "send", to: ["a@example.com"], subject: "s", body: "b",
    cc: null, bcc: null, attachments: null, html_body: null, reply_to: null,
    // A strict client sends the OTHER actions' fields too, all null. They must
    // not be mistaken for misplaced arguments on this write.
    message_id: null, message_ids: null, reply_all: null, as_attachment: null,
  }, "email_compose send, strict-client shape");
});

Deno.test("F11 a REQUIRED field sent as null is still refused as required", async () => {
  const refused = await failures("email_read", { action: "read", message_id: null });
  assert(refused.includes("arguments.message_id required"), refused.join("; "));
});

Deno.test("F12 enum values are matched ignoring case", async () => {
  await assertAccepted("inbox_list", { provider: "Gmail", service: "YAHOO" }, "inbox_list");
  await assertAccepted("email_organize", { action: "flag", message_ids: ["m1"], flag_action: "Read" }, "flag_action");
});

Deno.test("F13 an object sent as a JSON string is parsed", async () => {
  await assertAccepted("automation", {
    action: "preview",
    automation_id: "33333333-3333-4333-8333-333333333333",
    filter: '{"from":"a@example.com"}',
  }, "filter");
});

Deno.test("F14 'Name <addr>' recipients become bare addresses", async () => {
  await assertAccepted("email_compose", { action: "send", to: ["Anna <a@example.com>"], subject: "s", body: "b" }, "array item");
  await assertAccepted("email_compose", { action: "send", to: '"Doe, John" <j@example.com>, b@example.com', subject: "s", body: "b" }, "one string");
  assertEquals(splitAddressList('"Doe, John" <j@example.com>; b@example.com, Ann <a@example.com>'), [
    "j@example.com",
    "b@example.com",
    "a@example.com",
  ]);
  const refused = await failures("email_compose", { action: "send", to: ["Anna <not-an-address>"], subject: "s", body: "b" });
  assert(refused.includes("arguments.to[0] format"), "what comes out is still validated");
});

// ── Observability ───────────────────────────────────────────────────────────

Deno.test("a type failure records the received JSON type, never the value", () => {
  const details = invalidArgumentAuditDetails("email_read", "list", [
    { path: "arguments.limit", keyword: "type", message: "must be integer; received string" },
    { path: "arguments.x", keyword: "type", message: "must be integer; received secret-value" },
    { path: "arguments.since", keyword: "format", message: "received null" },
  ]);
  assertEquals(details.errors, [
    { path: "arguments.limit", keyword: "type", received: "string" },
    { path: "arguments.x", keyword: "type" },
    { path: "arguments.since", keyword: "format" },
  ]);
});

Deno.test("the published schemas carry the new arguments", () => {
  // deno-lint-ignore no-explicit-any
  const props = (name: string) => Object.keys((TOOL_REGISTRY.find((t: any) => t.name === name)!.inputSchema as any).properties);
  assert(props("inbox_list").includes("inbox"));
  assert(props("schedule_list").includes("inbox"));
  assert(props("contact_search").includes("inbox"));
  const accepts = (tool: string, action: string) => CONSOLIDATED_ARGUMENT_INDEX[tool].allowedByAction[action] as string[];
  for (const action of ["create", "reply", "update", "delete"]) {
    assert(accepts("draft", action).includes("idempotency_key"), `draft ${action}`);
  }
  for (const field of ["cc", "bcc"]) {
    assert(accepts("email_compose", "reply").includes(field), `email_compose reply ${field}`);
    assert(accepts("draft", "reply").includes(field), `draft reply ${field}`);
  }
  for (const field of ["to", "cc", "bcc"]) assert(accepts("draft", "send").includes(field), `draft send ${field}`);
  for (const action of ["enable", "disable", "delete", "update", "get", "runs"]) {
    assert(accepts("automation", action).includes("inbox_id"), `automation ${action}`);
  }
  assert(accepts("schedule", "cancel").includes("inbox"), "schedule cancel");
});
