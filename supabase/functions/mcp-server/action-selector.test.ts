import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  actionSelectorIndex,
  buildResolvedActionNote,
  canonicalActionToken,
  resolveActionSelector,
  safeActionToken,
} from "./action-selector.ts";

/** The real email_read action map, trimmed to what this module reads. */
const EMAIL_READ = {
  list: { legacy: "email_list" },
  read: { legacy: "email_read" },
  read_batch: { legacy: "email_read_batch" },
  search: { legacy: "email_search" },
  attachment: { legacy: "email_attachment" },
  extract: { legacy: "email_extract" },
  original: { legacy: "email_original" },
};

/** The real email_delete map. Nothing here may be reached by a synonym. */
const EMAIL_DELETE = {
  delete: { legacy: "email_delete" },
  delete_batch: { legacy: "email_delete_batch" },
  search_and_delete: { legacy: "email_search_and_delete" },
};

const READ_INDEX = actionSelectorIndex(EMAIL_READ);
const DELETE_INDEX = actionSelectorIndex(EMAIL_DELETE);

/** email_read's real leniency: every action of it is read-only. */
const readIsLenient = () => true;
/** email_delete's real leniency: none of it is. */
const deleteIsLenient = () => false;

Deno.test("an exact action resolves to itself and reports nothing to disclose", () => {
  const resolution = resolveActionSelector("email_read", "read", READ_INDEX, readIsLenient);
  assertEquals(resolution?.action, "read");
  assertEquals(resolution?.kind, "exact");
});

Deno.test("case and separators are punctuation, not meaning", () => {
  for (const sent of ["Read", "READ", " read ", "read "]) {
    const resolution = resolveActionSelector("email_read", sent, READ_INDEX, readIsLenient);
    assertEquals(resolution?.action, "read", `${sent} did not resolve`);
  }
  for (const sent of ["read-batch", "Read Batch", "READ_BATCH", "read.batch"]) {
    const resolution = resolveActionSelector("email_read", sent, READ_INDEX, readIsLenient);
    assertEquals(resolution?.action, "read_batch", `${sent} did not resolve`);
    assertEquals(resolution?.kind, "canonical");
  }
});

Deno.test("an action's own legacy tool name names that action", () => {
  const cases: [string, string][] = [
    ["email_list", "list"],
    ["email_read_batch", "read_batch"],
    ["email_search", "search"],
    ["email_attachment", "attachment"],
  ];
  for (const [sent, expected] of cases) {
    const resolution = resolveActionSelector("email_read", sent, READ_INDEX, readIsLenient);
    assertEquals(resolution?.action, expected, `${sent} did not resolve`);
    assertEquals(resolution?.kind, "legacy");
  }
});

Deno.test("a legacy name that collides with an action name never redirects it", () => {
  // 'email_read' is BOTH the tool and the legacy name of action 'read'. The
  // action name is what the schema publishes, so the enum member wins.
  assertEquals(READ_INDEX.byCanonical["read"], "read");
  const resolution = resolveActionSelector("email_read", "email_read", READ_INDEX, readIsLenient);
  assertEquals(resolution?.action, "read");
});

Deno.test("a synonym resolves onto a read-only action", () => {
  const cases: [string, string][] = [
    ["get", "read"],
    ["fetch", "read"],
    ["view", "read"],
    ["find", "search"],
    ["list_emails", "list"],
    ["download_attachment", "attachment"],
    ["raw", "original"],
  ];
  for (const [sent, expected] of cases) {
    const resolution = resolveActionSelector("email_read", sent, READ_INDEX, readIsLenient);
    assertEquals(resolution?.action, expected, `${sent} did not resolve`);
    assertEquals(resolution?.kind, "alias");
  }
});

Deno.test("a synonym is refused when the action it would reach is not read-only", () => {
  // The guard is the leniency predicate, not the table: even if a destructive
  // tool ever gained an alias entry, this is what keeps it from firing.
  assertEquals(
    resolveActionSelector("email_delete", "remove", DELETE_INDEX, deleteIsLenient),
    null,
  );
  assertEquals(
    resolveActionSelector("email_delete", "purge", DELETE_INDEX, deleteIsLenient),
    null,
  );
});

Deno.test("a destructive action still resolves through case and its legacy name", () => {
  // Refusing synonyms must not cost the two tiers that are not guesses.
  assertEquals(
    resolveActionSelector("email_delete", "Delete_Batch", DELETE_INDEX, deleteIsLenient)?.action,
    "delete_batch",
  );
  assertEquals(
    resolveActionSelector("email_delete", "email_search_and_delete", DELETE_INDEX, deleteIsLenient)
      ?.action,
    "search_and_delete",
  );
});

Deno.test("an ambiguous word is refused rather than guessed", () => {
  // "get_messages" reads as 'list' or as 'read_batch' with equal force, and a
  // wrong guess answers a question nobody asked. Deliberately absent.
  for (const sent of ["get_messages", "read_messages", "messages_batch", "everything"]) {
    assertEquals(
      resolveActionSelector("email_read", sent, READ_INDEX, readIsLenient),
      null,
      `${sent} should not have resolved`,
    );
  }
});

Deno.test("a non-string selector never resolves", () => {
  for (const sent of [null, undefined, 42, { name: "list" }, ["list"]]) {
    assertEquals(resolveActionSelector("email_read", sent, READ_INDEX, readIsLenient), null);
  }
});

Deno.test("an empty or whitespace selector never resolves", () => {
  for (const sent of ["", "   ", "_", "-"]) {
    assertEquals(resolveActionSelector("email_read", sent, READ_INDEX, readIsLenient), null);
  }
});

Deno.test("no alias resolves onto an action the tool does not have", () => {
  // The alias table is hand-written; every value in it must be a real action of
  // the tool it is keyed under, or dispatch would be handed a name that is not
  // in the registry.
  const tools: Record<string, Record<string, { legacy: string }>> = {
    email_read: EMAIL_READ,
    folder: { list: { legacy: "folder_list" }, create: { legacy: "folder_create" } },
    draft: { list: { legacy: "draft_list" }, create: { legacy: "draft_create" } },
    schedule: { list: { legacy: "schedule_list" }, create: { legacy: "schedule_create" } },
    automation: {
      list: { legacy: "automation_list" },
      get: { legacy: "automation_get" },
      runs: { legacy: "automation_runs" },
    },
    signature: { get: { legacy: "signature_get" }, set: { legacy: "signature_set" } },
  };
  // Every alias this module knows, exercised through the public entry point
  // with leniency granted, must land on an action the tool declares.
  for (const [tool, actions] of Object.entries(tools)) {
    const index = actionSelectorIndex(actions);
    for (const candidate of ALL_ALIAS_KEYS) {
      const resolution = resolveActionSelector(tool, candidate, index, () => true);
      if (!resolution || resolution.kind !== "alias") continue;
      assert(
        resolution.action in actions,
        `${tool}: alias '${candidate}' names '${resolution.action}', which is not an action of it`,
      );
    }
  }
});

/**
 * Every key the alias table could hold, taken from the tests above plus the
 * words the module documents. Kept as a list rather than exported from the
 * module so the table stays private and the test still covers it.
 */
const ALL_ALIAS_KEYS = [
  "get",
  "fetch",
  "open",
  "show",
  "view",
  "read_message",
  "read_email",
  "get_message",
  "get_email",
  "list_messages",
  "list_emails",
  "list_email",
  "inbox",
  "recent",
  "search_messages",
  "search_emails",
  "search_email",
  "find",
  "query",
  "batch_read",
  "read_many",
  "get_attachment",
  "download_attachment",
  "download",
  "extract_text",
  "attachment_text",
  "raw",
  "eml",
  "source",
  "raw_message",
  "original_message",
  "list_folders",
  "get_folders",
  "folders",
  "list_drafts",
  "get_drafts",
  "drafts",
  "list_scheduled",
  "list_schedules",
  "scheduled",
  "list_automations",
  "list_rules",
  "rules",
  "get_automation",
  "get_rule",
  "history",
  "list_runs",
  "get_signature",
  "read",
];

Deno.test("canonicalisation folds only punctuation", () => {
  assertEquals(canonicalActionToken("  Read-Batch "), "read_batch");
  assertEquals(canonicalActionToken("READ__BATCH"), "read_batch");
  assertEquals(canonicalActionToken("read/batch"), "read_batch");
  // A word is still a word: nothing is stemmed, truncated or spell-corrected.
  assertEquals(canonicalActionToken("reads"), "reads");
  assertEquals(canonicalActionToken("rd"), "rd");
});

Deno.test("the logged selector is an allow-list, not a redaction", () => {
  assertEquals(safeActionToken("Get_Message"), "get_message");
  assertEquals(safeActionToken(""), "(empty)");
  assertEquals(safeActionToken("   "), "(empty)");
  assertEquals(safeActionToken(42), "(number)");
  assertEquals(safeActionToken({}), "(object)");
  // Anything carrying content rather than a word collapses to one marker.
  assertEquals(safeActionToken("read the mail from bob@example.com"), "(unprintable)");
  assertEquals(safeActionToken("subject:\"invoice\""), "(unprintable)");
  assertEquals(safeActionToken("x".repeat(41)), "(oversized)");
});

Deno.test("the disclosure note says what was sent and what ran", () => {
  const note = buildResolvedActionNote("email_read", {
    action: "read",
    kind: "alias",
    received: "get",
  });
  assert(note.includes("'get'"));
  assert(note.includes("'read'"));
  // Declarative, never imperative: no instruction addressed to the model.
  assert(!/\bplease\b|\byou should\b|\btry\b|\buse instead\b/i.test(note));
});
