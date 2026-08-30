// ---------------------------------------------------------------------------
// Folder-operation error mapping tests.
//
// What production actually returned on 2026-08-30:
//
//   Failed to folder_create for gmail inbox: Gmail labels.create failed: Conflict
//   Failed to folder_create for gmail inbox: Gmail labels.create failed: Bad Request
//
// An agent cannot act on either. These tests assert the three things that make
// the replacement actionable, and one thing that keeps it honest:
//
//   * a taken name says so AND hands back the existing id, so the error is a
//     usable result rather than a dead end;
//   * a reserved name says which names are reserved;
//   * an unrecognised failure invents NOTHING — no cause, and no retry hint
//     unless the status is genuinely transient.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  isReservedFolderName,
  mapFolderProviderFailure,
  reservedFolderNames,
} from "./folder-errors.ts";

Deno.test("Gmail 409 hands back the id of the label that owns the name", () => {
  const { payload, logErrorCode } = mapFolderProviderFailure({
    provider: "gmail",
    operation: "create",
    name: "MCPE_HC_20260830_1344",
    status: 409,
    statusText: "Conflict",
    detail: "Label name exists or conflicts",
    existing: { id: "Label_10", name: "MCPE_HC_20260830_1344" },
    itemNoun: "label",
  });
  assertEquals(payload.error, "folder_name_taken");
  assertEquals(logErrorCode, "folder_name_taken");
  assertEquals(payload.existing_folder_id, "Label_10");
  assertEquals(payload.existing_folder_name, "MCPE_HC_20260830_1344");
  assertEquals(payload.provider, "gmail");
  // The remedy is in the message, not just in the payload.
  assertStringIncludes(payload.message as string, "Label_10");
  assertStringIncludes(payload.message as string, "already exists");
  assertStringIncludes(payload.message as string, "label");
});

Deno.test("a 409 with no lookup still names the cause and the next call", () => {
  const { payload } = mapFolderProviderFailure({
    provider: "gmail",
    operation: "create",
    name: "Receipts",
    status: 409,
    statusText: "Conflict",
    itemNoun: "label",
  });
  assertEquals(payload.error, "folder_name_taken");
  assertEquals(payload.existing_folder_id, null);
  assertStringIncludes(payload.message as string, "folder action: list");
});

Deno.test("an IMAP ALREADYEXISTS is a taken name, and the name IS the id", () => {
  const { payload } = mapFolderProviderFailure({
    provider: "imap",
    operation: "create",
    name: "Receipts",
    detail: "CREATE failed: [ALREADYEXISTS] Mailbox already exists",
    existing: { id: "Receipts", name: "Receipts" },
  });
  assertEquals(payload.error, "folder_name_taken");
  assertEquals(payload.existing_folder_id, "Receipts");
  assertStringIncludes(payload.message as string, "folder"); // not "label" off Gmail
});

Deno.test("Gmail 400 on a system label name is a RESERVED-name error", () => {
  const { payload, logErrorCode } = mapFolderProviderFailure({
    provider: "gmail",
    operation: "create",
    name: "INBOX",
    status: 400,
    statusText: "Bad Request",
    itemNoun: "label",
  });
  assertEquals(payload.error, "folder_name_reserved");
  assertEquals(logErrorCode, "folder_name_reserved");
  const reserved = payload.reserved_names as string[];
  assert(reserved.includes("INBOX"));
  assert(reserved.includes("CATEGORY_PROMOTIONS"));
  assertStringIncludes(payload.message as string, "INBOX");
  assertStringIncludes(payload.message as string, "reserved");
  // It must not masquerade as a collision with a user label.
  assert(!(payload.message as string).includes("already exists"));
});

Deno.test("reserved matching ignores case, so 'inbox' is caught too", () => {
  assert(isReservedFolderName("gmail", "inbox"));
  assert(isReservedFolderName("gmail", "  Trash  "));
  assert(isReservedFolderName("imap", "InBoX"));
  assert(!isReservedFolderName("gmail", "Receipts"));
  assert(!isReservedFolderName("gmail", null));
  assertEquals(reservedFolderNames("imap"), ["INBOX"]);
  // An unknown provider slug falls back to the IMAP set rather than throwing.
  assertEquals(reservedFolderNames("fastmail"), ["INBOX"]);
});

Deno.test("deleting a system label explains that system labels are undeletable", () => {
  const { payload } = mapFolderProviderFailure({
    provider: "gmail",
    operation: "delete",
    name: "INBOX",
    status: 400,
    statusText: "Bad Request",
    itemNoun: "label",
  });
  assertEquals(payload.error, "folder_name_reserved");
  assertStringIncludes(payload.message as string, "cannot be deleted");
});

Deno.test("an unknown status invents no cause", () => {
  const { payload, logErrorCode } = mapFolderProviderFailure({
    provider: "gmail",
    operation: "create",
    name: "Receipts",
    status: 418,
    statusText: "I'm a teapot",
    detail: "Something the connector has never seen",
    itemNoun: "label",
  });
  assertEquals(payload.error, "folder_provider_error");
  assertEquals(logErrorCode, "folder_provider_error");
  assertEquals(payload.retryable, false);
  assertEquals(payload.provider_status, 418);
  const message = payload.message as string;
  // It reports what the provider said…
  assertStringIncludes(message, "Something the connector has never seen");
  // …and claims none of the specific causes it has codes for.
  assert(!message.includes("already exists"));
  assert(!message.toLowerCase().includes("reserved"));
  // …and does not tell the agent to wait it out.
  assert(!message.toLowerCase().includes("try again"));
  assert(!message.toLowerCase().includes("in a moment"));
});

Deno.test("a bare 400 on an ordinary name stays generic rather than guessing", () => {
  const { payload } = mapFolderProviderFailure({
    provider: "gmail",
    operation: "create",
    name: "a".repeat(300),
    status: 400,
    statusText: "Bad Request",
    itemNoun: "label",
  });
  assertEquals(payload.error, "folder_provider_error");
  // It quotes the status line and stops there — no invented explanation.
  assertStringIncludes(payload.message as string, "No specific cause was reported");
  assert(!(payload.message as string).includes("too long"));
});

Deno.test("a genuinely transient status is the only one allowed a retry hint", () => {
  for (const status of [429, 500, 503]) {
    const { payload } = mapFolderProviderFailure({
      provider: "outlook",
      operation: "create",
      name: "Receipts",
      status,
      statusText: "Service Unavailable",
    });
    assertEquals(payload.error, "folder_provider_error");
    assertEquals(payload.retryable, true, `status ${status}`);
    assertStringIncludes(payload.message as string, "temporary provider fault");
  }
});

Deno.test("a 404 on rename/delete is folder_not_found, not a provider mystery", () => {
  const { payload, logErrorCode } = mapFolderProviderFailure({
    provider: "outlook",
    operation: "delete",
    name: "AAMkAGI2",
    status: 404,
    statusText: "Not Found",
  });
  assertEquals(payload.error, "folder_not_found");
  assertEquals(logErrorCode, "folder_not_found");
  assertStringIncludes(payload.message as string, "folder action: list");
});

Deno.test("every mapped error names the provider and the operation", () => {
  const cases = [
    { status: 409, name: "Receipts" },
    { status: 400, name: "INBOX" },
    { status: 404, name: "Receipts" },
    { status: 500, name: "Receipts" },
  ];
  for (const c of cases) {
    for (const operation of ["create", "rename", "delete"] as const) {
      const { payload } = mapFolderProviderFailure({
        provider: "gmail",
        operation,
        name: c.name,
        status: c.status,
        statusText: "x",
        itemNoun: "label",
      });
      assertEquals(payload.provider, "gmail");
      assertEquals(payload.operation, operation);
      assert((payload.message as string).length > 40);
    }
  }
});
