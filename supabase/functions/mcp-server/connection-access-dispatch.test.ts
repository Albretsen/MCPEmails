// ---------------------------------------------------------------------------
// Receive-only and send-only inboxes, through the real executors.
//
// connection-access.test.ts pins the rules; this pins the wiring: that
// `dispatchExecutor` (the entry both tools/call and client-api use) refuses a
// tool needing the half an inbox lacks, with the accurate explanation rather
// than the credential-failure one, and BEFORE the handler writes anything. A
// receive-only inbox with send approval turned on is the case that matters
// most: without the gate, email_send would queue a held send for a person to
// approve that could never be delivered.
//
// No socket is opened. The harness fakes PostgREST, and a refusal at
// resolution never gets as far as dialling IMAP or SMTP.
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import * as harness from "./provider-call-harness.ts";

// The harness has already imported index.ts with the listener off; this is
// the same module instance.
const server = await import("./index.ts") as unknown as {
  dispatchExecutor: (
    name: string,
    args: unknown,
    apiKey: unknown,
  ) => Promise<{ result: { isError?: boolean; content: { text: string }[] }; logStatus: string; logErrorCode: string | null } | null>;
};

async function imapInbox(overrides: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await harness.inboxRow("gmail", {
    provider: "imap",
    email_address: "owner@example.com",
    oauth_access_token: null,
    oauth_refresh_token: null,
    oauth_token_expires_at: null,
    imap_host: "imap.fake-server.example",
    imap_port: 993,
    imap_security: "tls",
    imap_password: await harness.encryptToken("app-password-invented"),
    smtp_host: "smtp.fake-server.example",
    smtp_port: 465,
    smtp_security: "tls",
    ...overrides,
  });
}

const noProvider: harness.ProviderHandler = (call) => {
  throw new Error(`no provider call expected, got ${call.method} ${call.url}`);
};

async function dispatch(inbox: Record<string, unknown>, tool: string, args: Record<string, unknown>) {
  const { value, world } = await harness.runTool(
    inbox,
    noProvider,
    () => server.dispatchExecutor(tool, { inbox_id: harness.INBOX_ID, ...args }, harness.API_KEY),
  );
  assert(value, `${tool} should have an executor`);
  return { outcome: value, world };
}

function body(outcome: { result: { content: { text: string }[] } }): Record<string, unknown> {
  return JSON.parse(outcome.result.content[0].text);
}

Deno.test("a send-only inbox asked to read says so, and never claims a credential failure", async () => {
  const inbox = await imapInbox({ imap_host: null, imap_port: null });
  const { outcome } = await dispatch(inbox, "email_list", {});
  assertEquals(outcome.logStatus, "error");
  assertEquals(outcome.logErrorCode, "transport_not_configured");
  assertEquals(outcome.result.isError, true);
  const payload = body(outcome);
  assertEquals(payload.error, "transport_not_configured");
  assertEquals(payload.missing, "imap");
  assertEquals(payload.access, "send_only");
  assertEquals(payload.inbox_id, harness.INBOX_ID);
  assert(!/revoked|expired/i.test(String(payload.message)));
});

Deno.test("a receive-only inbox refuses a send before a held send is queued", async () => {
  // Approval on: without the gate this send would be written to
  // send_approvals and wait for a person to approve an undeliverable message.
  const inbox = await imapInbox({ smtp_host: null, smtp_port: null, send_approval_required: true });
  const { outcome, world } = await dispatch(inbox, "email_send", {
    to: ["someone@example.org"],
    subject: "Hello",
    body: "Hi",
  });
  assertEquals(outcome.logErrorCode, "transport_not_configured");
  assertEquals(body(outcome).missing, "smtp");
  const writes = world.db.filter((call) => call.method !== "GET");
  assertEquals(writes, [], "nothing may be written for a send that cannot happen");
});

Deno.test("a receive-only inbox refuses to schedule a send, and stores nothing", async () => {
  const inbox = await imapInbox({ smtp_host: null, smtp_port: null });
  const { outcome, world } = await dispatch(inbox, "schedule_create", {
    to: ["someone@example.org"],
    subject: "Later",
    body: "Hi",
    send_at: new Date(Date.now() + 3_600_000).toISOString(),
  });
  assertEquals(outcome.logErrorCode, "transport_not_configured");
  assertEquals(world.db.filter((call) => call.target.startsWith("scheduled_sends")), []);
});

Deno.test("inbox_list names a partial connection and turns off what it cannot do", async () => {
  const inbox = await imapInbox({ imap_host: null, imap_port: null });
  const { outcome } = await dispatch(inbox, "inbox_list", { include_capabilities: true });
  assertEquals(outcome.logStatus, "success");
  const [listed] = (body(outcome) as { inboxes: Array<Record<string, any>> }).inboxes;
  assertEquals(listed.access, "send_only");
  assertEquals(listed.capabilities.folders, false);
  assertEquals(listed.capabilities.drafts, false);
  assertEquals(listed.capabilities.scheduling, true);
});

Deno.test("inbox_list says nothing extra about an inbox that does both", async () => {
  const inbox = await imapInbox({});
  const { outcome } = await dispatch(inbox, "inbox_list", {});
  const [listed] = (body(outcome) as { inboxes: Array<Record<string, unknown>> }).inboxes;
  assertEquals("access" in listed, false);
});

Deno.test("contact_search across inboxes keeps another inbox's credential error, not the send-only note", async () => {
  // A sweep with no inbox named acts on no single inbox. Before the fix the
  // send-only inbox in the sweep was recorded anyway, and the dispatcher then
  // replaced the revoked inbox's real error with "connected for sending only,
  // do not ask the user to reconnect", which sent nobody to fix the real one.
  const revokedId = "44444444-4444-4444-8444-444444444444";
  const revoked = await imapInbox({ id: revokedId, email_address: "revoked@example.com", imap_password: null });
  const sendOnly = await imapInbox({ imap_host: null, imap_port: null });
  const { value: outcome } = await harness.runToolWithInboxes(
    [revoked, sendOnly],
    noProvider,
    () => server.dispatchExecutor("contact_search", { query: "someone" }, harness.API_KEY),
  );
  assert(outcome);
  assertEquals(outcome.result.isError, true);
  assertEquals(outcome.logErrorCode, "auth_failed");
  const text = outcome.result.content[0].text;
  assert(!/send_only|sending only|transport_not_configured/i.test(text), text);
});

Deno.test("contact_search on one named send-only inbox still says so", async () => {
  const inbox = await imapInbox({ imap_host: null, imap_port: null });
  const { outcome } = await dispatch(inbox, "contact_search", { query: "someone" });
  assertEquals(outcome.logErrorCode, "transport_not_configured");
  assertEquals(body(outcome).access, "send_only");
});
