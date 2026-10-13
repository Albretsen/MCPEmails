import { assert, assertEquals, assertStrictEquals } from "jsr:@std/assert@1";
import {
  capabilitiesForAccess,
  inboxAccess,
  missingTransportMessage,
  missingTransportOf,
  missingTransportPayload,
  transportBlockingTool,
} from "./connection-access.ts";

Deno.test("an IMAP-family row reports the halves it carries", () => {
  assertEquals(inboxAccess({ provider: "imap", imap_host: "imap.x", smtp_host: "smtp.x" }), "send_and_receive");
  assertEquals(inboxAccess({ provider: "imap", imap_host: "imap.x", smtp_host: null }), "receive_only");
  assertEquals(inboxAccess({ provider: "imap", imap_host: null, smtp_host: "smtp.x" }), "send_only");
});

Deno.test("a row with neither host is broken, not partial, and keeps the credential errors", () => {
  assertEquals(inboxAccess({ provider: "imap", imap_host: null, smtp_host: null }), "send_and_receive");
  assertEquals(missingTransportOf({ provider: "imap", imap_host: null, smtp_host: null }), null);
});

Deno.test("OAuth providers always do both, whatever the host columns hold", () => {
  assertEquals(inboxAccess({ provider: "gmail", imap_host: null, smtp_host: null }), "send_and_receive");
  assertEquals(inboxAccess({ provider: "outlook" }), "send_and_receive");
});

Deno.test("the missing half is the one the row does not carry", () => {
  assertEquals(missingTransportOf({ provider: "imap", imap_host: null, smtp_host: "smtp.x" }), "imap");
  assertEquals(missingTransportOf({ provider: "imap", imap_host: "imap.x", smtp_host: null }), "smtp");
  assertEquals(missingTransportOf({ provider: "imap", imap_host: "imap.x", smtp_host: "smtp.x" }), null);
});

Deno.test("capabilities: a full connection is untouched", () => {
  const caps = { flags: true, forward: true, drafts: true, search_syntax: "imap" };
  assertStrictEquals(capabilitiesForAccess(caps, "send_and_receive"), caps);
});

Deno.test("capabilities: send-only turns off everything that needs stored mail", () => {
  const caps = {
    flags: true, folders: true, labels: false, move: true, copy: true, delete: true,
    forward: true, drafts: true, contacts_db: true, scheduling: true, original_message: true,
    search_syntax: "imap",
  };
  const out = capabilitiesForAccess(caps, "send_only");
  assertEquals(out, {
    ...caps,
    flags: false, folders: false, move: false, copy: false, delete: false,
    drafts: false, contacts_db: false, original_message: false,
  });
  assert(caps.flags, "the shared provider table must not be mutated");
});

Deno.test("capabilities: receive-only turns off sending", () => {
  const caps = { flags: true, forward: true, scheduling: true, drafts: true };
  assertEquals(capabilitiesForAccess(caps, "receive_only"), {
    flags: true, forward: false, scheduling: false, drafts: true,
  });
});

Deno.test("the refusal never claims a credential problem and says what still works", () => {
  const url = "https://mcpemails.com/dashboard/inboxes";
  const sendOnly = missingTransportMessage("imap", "noreply@example.com", url);
  const receiveOnly = missingTransportMessage("smtp", "archive@example.com", url);
  for (const text of [sendOnly, receiveOnly]) {
    assert(!/revoked|expired/i.test(text), text);
    assert(text.includes("do not retry"), text);
    assert(text.includes(url), text);
  }
  assert(sendOnly.includes("sending only") && sendOnly.includes("Sending new mail from it works"));
  assert(receiveOnly.includes("receiving only") && receiveOnly.includes("Reading, searching"));
});

Deno.test("the payload is structured for clients that parse it", () => {
  const body = missingTransportPayload("smtp", { id: "ib-1", email_address: "a@x.com" }, "u");
  assertEquals(body.error, "transport_not_configured");
  assertEquals(body.missing, "smtp");
  assertEquals(body.access, "receive_only");
  assertEquals(body.inbox_id, "ib-1");
});

Deno.test("tools are gated by the half they need", () => {
  const sendOnly = { provider: "imap", imap_host: null, smtp_host: "smtp.x" };
  const receiveOnly = { provider: "imap", imap_host: "imap.x", smtp_host: null };
  const full = { provider: "imap", imap_host: "imap.x", smtp_host: "smtp.x" };

  assertEquals(transportBlockingTool("email_send", sendOnly), null);
  assertEquals(transportBlockingTool("email_read", sendOnly), "imap");
  assertEquals(transportBlockingTool("email_reply", sendOnly), "imap");
  assertEquals(transportBlockingTool("draft_create", sendOnly), "imap");

  assertEquals(transportBlockingTool("email_read", receiveOnly), null);
  assertEquals(transportBlockingTool("email_send", receiveOnly), "smtp");
  assertEquals(transportBlockingTool("schedule_create", receiveOnly), "smtp");
  assertEquals(transportBlockingTool("email_forward", receiveOnly), "smtp");
  // Drafting is an IMAP APPEND: a receive-only inbox can still write one.
  assertEquals(transportBlockingTool("draft_create", receiveOnly), null);

  for (const tool of ["email_send", "email_read", "draft_send"]) {
    assertEquals(transportBlockingTool(tool, full), null);
  }
  // Ungated tools pass whatever the inbox lacks.
  assertEquals(transportBlockingTool("inbox_list", sendOnly), null);
  assertEquals(transportBlockingTool("signature_set", receiveOnly), null);
});
