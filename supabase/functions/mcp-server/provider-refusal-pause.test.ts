// ---------------------------------------------------------------------------
// Provider-refusal pause (outbound-brakes.ts).
//
// Three spam or policy refusals from the provider within an hour pause sends
// from that inbox for an hour (error_code sends_paused_provider_refusals), and
// the operator is notified. Refusals about the connecting address (our relay
// egress, the ACR04 family), credentials or Send As are not counted: they are
// not the customer's mail being refused. Counting is atomic in SQL and
// covered by supabase/tests/outbound_abuse_brakes.sql.
//
// Run: deno test --allow-read supabase/functions/mcp-server/provider-refusal-pause.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  type BrakeDb,
  brakeRefusalResult,
  isProviderPolicyRefusal,
  parseGateAnswer,
  recordProviderRefusal,
  REFUSAL_PAUSE_MS,
  REFUSAL_PAUSE_THRESHOLD,
  REFUSAL_WINDOW_MS,
  SENDS_PAUSED_ERROR_CODE,
} from "./outbound-brakes.ts";
import { SmtpNotSentError, SmtpSenderRefusedError } from "./smtp-client.ts";
import { GraphSendRefusedError } from "./outlook-graph.ts";

const SOURCE = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("three refusals in an hour pause for an hour", () => {
  assertEquals(REFUSAL_PAUSE_THRESHOLD, 3);
  assertEquals(REFUSAL_WINDOW_MS, 3_600_000);
  assertEquals(REFUSAL_PAUSE_MS, 3_600_000);
});

Deno.test("spam, content-policy and sending-limit refusals are counted", () => {
  for (
    const err of [
      new SmtpNotSentError("554 5.7.1 Message rejected due to content restrictions", false),
      new Error("SMTP DATA refused: 550 5.7.1 Our system has detected that this message is likely unsolicited mail"),
      new Error("SMTP DATA refused: 554 5.7.520 Message blocked because it contains content identified as spam"),
      new Error("550 5.4.5 Daily user sending quota exceeded"),
      new Error("quota_exceeded"),
      new Error("550 Message rejected: policy violation"),
      new GraphSendRefusedError("sendMail", 403, "ErrorMessageSubmissionBlocked", "Submission blocked"),
      new GraphSendRefusedError("sendMail", 429, "ErrorSubmissionQuotaExceeded", "Too many messages"),
    ]
  ) {
    assert(isProviderPolicyRefusal(err), err.message);
  }
});

Deno.test("origin, credential, ownership and recipient refusals are not", () => {
  for (
    const err of [
      new SmtpNotSentError("550 [ACR04] Amazon AWS IP 100.27.38.52 may not use this server.", false),
      new SmtpNotSentError("550 5.7.1 Service unavailable, client host blocked", false),
      new Error("554 5.7.1 rejected because of the sending IP reputation"),
      new SmtpSenderRefusedError("SMTP MAIL FROM <a@b.example> refused: 553 not owned by user"),
      new Error("imap_auth_failed"),
      new Error("550 5.1.1 Recipient address rejected: User unknown"),
      new Error("IMAP read timeout"),
      new GraphSendRefusedError("sendMail", 400, "ErrorInvalidRecipients", "bad address"),
      new GraphSendRefusedError("sendMail", 403, "ErrorSendAsDenied", "not allowed"),
    ]
  ) {
    assert(!isProviderPolicyRefusal(err), err.message);
  }
  assert(!isProviderPolicyRefusal(null));
  assert(!isProviderPolicyRefusal({ message: "spam" }), "only Errors and strings are classified");
});

Deno.test("a counted refusal calls outbound_send_refusal with the thresholds; others call nothing", async () => {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db: BrakeDb = {
    rpc(fn, args) {
      calls.push({ fn, args });
      return Promise.resolve({
        data: { paused: true, newly_tripped: true, retry_at: "2026-10-24T15:00:00+00:00" },
        error: null,
      });
    },
  };
  assertEquals(
    await recordProviderRefusal(db, { workspaceId: "w", inboxId: "i", error: new Error("imap_auth_failed") }),
    null,
  );
  assertEquals(calls.length, 0, "a non-policy failure costs no query");
  const outcome = await recordProviderRefusal(db, {
    workspaceId: "w",
    inboxId: "i",
    error: new Error("554 5.7.1 spam detected"),
  });
  assertEquals(outcome, { paused: true, newlyTripped: true, retryAt: "2026-10-24T15:00:00+00:00" });
  assertEquals(calls[0].fn, "outbound_send_refusal");
  assertEquals(calls[0].args.p_threshold, 3);
  assertEquals(calls[0].args.p_window_ms, 3_600_000);
  assertEquals(calls[0].args.p_pause_ms, 3_600_000);
});

Deno.test("recording fails open", async () => {
  const failing: BrakeDb = { rpc: () => Promise.resolve({ data: null, error: { message: "down" } }) };
  assertEquals(await recordProviderRefusal(failing, { workspaceId: "w", inboxId: "i", error: "spam" }), null);
  const throwing: BrakeDb = { rpc: () => Promise.reject(new Error("network")) };
  assertEquals(await recordProviderRefusal(throwing, { workspaceId: "w", inboxId: "i", error: "spam" }), null);
});

Deno.test("a paused inbox refuses with sends_paused_provider_refusals and when it resumes", () => {
  const decision = parseGateAnswer({ decision: "paused", retry_at: "2026-10-24T15:00:00+00:00" });
  assertEquals(decision, { kind: "refuse", code: SENDS_PAUSED_ERROR_CODE, retryAt: "2026-10-24T15:00:00+00:00" });
  const refusal = brakeRefusalResult("email_forward", decision as Extract<typeof decision, { kind: "refuse" }>);
  assertEquals(refusal.logErrorCode, "sends_paused_provider_refusals");
  assertEquals(refusal.result.isError, true);
  const text = refusal.result.content[0].text;
  assert(text.includes("2026-10-24 15:00 UTC"), text);
  assert(text.includes("spam or against its policy"), text);
});

Deno.test("every send path counts provider refusals and the pause notifies the operator", () => {
  const handlers = ["executeSendEmail", "executeReplyToEmail", "executeForwardEmail", "executeSendDraft"];
  for (const handler of handlers) {
    const start = SOURCE.indexOf(`async function ${handler}(`);
    const body = SOURCE.slice(start, SOURCE.indexOf("\nasync function ", start + 1));
    assert(/await noteProviderRefusal\(apiKey\.workspace_id, /.test(body), `${handler} counts refusals`);
  }
  const dispatch = SOURCE.slice(SOURCE.indexOf("async function handleScheduledDispatch("));
  assert(/await deps\.noteRefusal\?\.\(/.test(dispatch), "scheduled sends count refusals too");
  assert(
    /if \(outcome\?\.newlyTripped\) \{\s*await notifyBrakeTripped\(\{ workspaceId, inboxId, brake: "provider_refusal_pause"/
      .test(SOURCE),
    "the operator is told once, when the pause starts",
  );
});
