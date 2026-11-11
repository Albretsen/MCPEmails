// ---------------------------------------------------------------------------
// The Business recipient rule on every tool-initiated outbound path
// (recipient-domain-rule.ts, workspaces.allowed_recipient_domains, migration
// 20261111130000): a send with any To/Cc/Bcc outside the allowed domains is
// written to send_approvals with hold_reason 'recipient_rule' and NOT sent;
// inside the list, or with no rule, it goes as before. The web mail client's
// person is refused instead (that client has no held-send flow), and the
// approval dispatcher's re-run is never asked again.
//
// Real executors over the fake network of provider-call-harness.ts: Gmail is
// answered below, PostgREST by the harness (the `workspaces` read returns the
// rule given in dbRows). The harness answers an insert with no row, so a hold
// reports "unable to create the required approval request"; what matters is
// the row the server WROTE and that Gmail was never asked to send. The
// dispatcher half is in scheduled-send-tenancy.test.ts; the automation
// forward half is pinned on the source below. Every address is invented.
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import * as harness from "./provider-call-harness.ts";
import {
  normalizeAllowedDomains,
  recipientRuleHeldMessage,
  recipientRuleRefusalText,
  recipientsOutsideDomains,
} from "./recipient-domain-rule.ts";

const server = await import("./index.ts");

type Row = Record<string, unknown>;

const CREATOR = "44444444-4444-4444-8444-444444444444";
const KEY = { ...harness.API_KEY, created_by: CREATOR };
const RULE = { workspaces: [{ allowed_recipient_domains: ["corp.example"] }] };
const DRAFT_ID = "r-77";
const MESSAGE_ID = "m-77";

/** A Gmail that answers sends, one draft and one original message. */
function gmail(original: { from: string; to?: string; cc?: string; replyTo?: string }, draftTo = "in@corp.example") {
  const sends: string[] = [];
  const handler: harness.ProviderHandler = (call) => {
    const url = new URL(call.url);
    if (url.pathname.endsWith("/messages/send") && call.method === "POST") {
      sends.push(String(call.body));
      return harness.json({ id: "sent-1", threadId: "t-1" });
    }
    if (url.pathname.endsWith("/drafts/send") && call.method === "POST") {
      sends.push(String(call.body));
      return harness.json({ id: "sent-2", threadId: "t-2" });
    }
    if (url.pathname.endsWith(`/drafts/${DRAFT_ID}`) && call.method === "GET") {
      return harness.json({
        id: DRAFT_ID,
        message: {
          id: "dm-77",
          threadId: "t-77",
          internalDate: "1792058400000",
          payload: { headers: [{ name: "To", value: draftTo }, { name: "Subject", value: "Draft" }] },
          raw: harness.b64url(
            [`From: owner@gmail-harness.example`, `To: ${draftTo}`, "Subject: Draft", "MIME-Version: 1.0",
              "Content-Type: text/plain; charset=utf-8", "", "Body", ""].join("\r\n"),
          ),
        },
      });
    }
    if (url.pathname.endsWith(`/messages/${MESSAGE_ID}`) && call.method === "GET") {
      const headers = [
        { name: "From", value: original.from },
        { name: "To", value: original.to ?? "owner@gmail-harness.example" },
        ...(original.cc ? [{ name: "Cc", value: original.cc }] : []),
        ...(original.replyTo ? [{ name: "Reply-To", value: original.replyTo }] : []),
        { name: "Subject", value: "Question" },
        { name: "Message-ID", value: "<orig-77@corp.example>" },
        { name: "Date", value: "Thu, 15 Oct 2026 10:00:00 +0000" },
      ];
      return harness.json({
        id: MESSAGE_ID,
        threadId: "t-77",
        labelIds: ["INBOX"],
        snippet: "",
        internalDate: "1792058400000",
        payload: { mimeType: "text/plain", headers, body: { size: 4, data: harness.b64url("Body") } },
      });
    }
    return harness.json({ error: { code: 404 } }, 404);
  };
  return { handler, sends };
}

async function run(tool: string, args: Row, opts: { rule?: boolean; key?: Row; original?: { from: string; to?: string; cc?: string; replyTo?: string }; draftTo?: string } = {}) {
  const { handler, sends } = gmail(opts.original ?? { from: "asker@corp.example" }, opts.draftTo);
  const inbox = await harness.inboxRow("gmail");
  const { value, world } = await harness.runToolWithInboxes(
    [inbox],
    handler,
    // The harness answers an insert with no row, which a path that reads the
    // inserted row back can trip on; the request it wrote is what is asserted.
    () => server.dispatchExecutor(tool, { inbox_id: harness.INBOX_ID, ...args }, (opts.key ?? KEY) as never).catch((e) => ({ thrown: e })),
    opts.rule === false ? {} : RULE,
  );
  const approval = world.db.find((c) => c.method === "POST" && c.target === "send_approvals");
  const ruleReads = world.db.filter((c) => c.method === "GET" && c.target === "workspaces" && c.query.includes("allowed_recipient_domains"));
  // deno-lint-ignore no-explicit-any
  const text = String((value as any)?.result?.content?.[0]?.text ?? "");
  return { value, world, sends, approval: approval?.body as Row | undefined, ruleReads, text };
}

function assertRuleHold(r: Awaited<ReturnType<typeof run>>, operation: string) {
  assert(r.approval, `${operation}: an approval row was written`);
  assertEquals(r.approval!.operation, operation);
  assertEquals(r.approval!.hold_reason, "recipient_rule");
  assertEquals(r.approval!.requested_by, CREATOR);
  assertEquals(r.sends.length, 0, `${operation}: nothing was sent`);
}

// ── The pure rule ───────────────────────────────────────────────────────────

Deno.test("rule: exact domain, case-insensitive; subdomains are not the domain; no address is outside", () => {
  const allowed = normalizeAllowedDomains(["Corp.Example", "@partner.example", "", 7]);
  assertEquals(allowed, ["corp.example", "partner.example"]);
  assertEquals(recipientsOutsideDomains(allowed, ["A <a@CORP.example>", "b@partner.example"]), []);
  assertEquals(recipientsOutsideDomains(allowed, ["x@sales.corp.example"]), ["x@sales.corp.example"]);
  assertEquals(recipientsOutsideDomains(allowed, ["x@corp.example.evil"]), ["x@corp.example.evil"]);
  assertEquals(recipientsOutsideDomains(allowed, ["undisclosed-recipients"]), ["undisclosed-recipients"]);
  assertEquals(recipientsOutsideDomains(null, ["anyone@anywhere.example"]), []);
  assertEquals(normalizeAllowedDomains([]), null);
  assertEquals(normalizeAllowedDomains(null), null);
});

Deno.test("rule: the held message counts recipients and never names them", () => {
  const one = recipientRuleHeldMessage("email", 1, "https://mcpemails.com/approvals/x");
  assertStringIncludes(one, "1 recipient is outside");
  assertStringIncludes(one, "owner or admin");
  assertStringIncludes(one, "Nothing was sent");
  assertStringIncludes(recipientRuleHeldMessage("reply", 3, "u"), "3 recipients are outside");
  assert(!/@/.test(one));
  assert(!/@/.test(recipientRuleRefusalText("email_send", 2)));
  assert(!/—/.test(one + recipientRuleRefusalText("email_send", 2)), "no em dash");
});

// ── email_send ──────────────────────────────────────────────────────────────

Deno.test("email_send: a recipient outside the allowed domains is held, never sent", async () => {
  const r = await run("email_send", { to: ["out@elsewhere.example"], subject: "Hi", body: "Hello" });
  assertRuleHold(r, "email_send");
});

Deno.test("email_send: Bcc counts, and a subdomain is outside", async () => {
  assertRuleHold(await run("email_send", { to: ["in@corp.example"], bcc: ["hidden@elsewhere.example"], subject: "Hi", body: "Hello" }), "email_send");
  assertRuleHold(await run("email_send", { to: ["in@sales.corp.example"], subject: "Hi", body: "Hello" }), "email_send");
});

Deno.test("email_send: everyone inside the list goes out as before, no approval", async () => {
  const r = await run("email_send", { to: ["in@corp.example"], cc: ["IN2@Corp.Example"], subject: "Hi", body: "Hello" });
  assertEquals(r.approval, undefined);
  assertEquals(r.sends.length, 1);
  assertEquals(r.ruleReads.length, 1, "the rule is one workspace read");
});

Deno.test("email_send: no rule set, any recipient goes", async () => {
  const r = await run("email_send", { to: ["out@elsewhere.example"], subject: "Hi", body: "Hello" }, { rule: false });
  assertEquals(r.approval, undefined);
  assertEquals(r.sends.length, 1);
});

Deno.test("email_send from the web mail client: refused with a clear reason, nothing queued or sent", async () => {
  const r = await run("email_send", { to: ["out@elsewhere.example"], subject: "Hi", body: "Hello" }, { key: { ...KEY, firstPartyHuman: true } });
  assertEquals(r.approval, undefined);
  assertEquals(r.sends.length, 0);
  // deno-lint-ignore no-explicit-any
  assertEquals((r.value as any).logErrorCode, "recipient_rule_refused");
  assertStringIncludes(r.text, "approved email domains");
});

Deno.test("email_send re-run by the approval dispatcher: not asked again, sent", async () => {
  const r = await run("email_send", { to: ["out@elsewhere.example"], subject: "Hi", body: "Hello" }, { key: { ...KEY, internalApprovalDispatch: true } });
  assertEquals(r.ruleReads.length, 0);
  assertEquals(r.approval, undefined);
  assertEquals(r.sends.length, 1);
});

// ── email_forward ───────────────────────────────────────────────────────────

Deno.test("email_forward: outside the list is held; the batch form too", async () => {
  assertRuleHold(await run("email_forward", { message_id: MESSAGE_ID, to: ["out@elsewhere.example"] }), "email_forward");
  assertRuleHold(await run("email_forward", { message_ids: [MESSAGE_ID, "m-78"], to: ["in@corp.example"], cc: ["out@elsewhere.example"] }), "email_forward");
});

// ── email_reply ─────────────────────────────────────────────────────────────

Deno.test("email_reply: the derived recipient (the original's sender) is checked", async () => {
  const r = await run("email_reply", { message_id: MESSAGE_ID, body: "Thanks" }, { original: { from: "client@elsewhere.example" } });
  assertRuleHold(r, "email_reply");
  assert(r.world.calls.some((c) => c.url.includes(`/messages/${MESSAGE_ID}`)), "the original was read for its recipients");
});

Deno.test("email_reply: Reply-To decides, and reply_all brings in the thread", async () => {
  // Sender inside, Reply-To outside: the reply goes to Reply-To, so it is held.
  assertRuleHold(
    await run("email_reply", { message_id: MESSAGE_ID, body: "Thanks" }, { original: { from: "colleague@corp.example", replyTo: "ticket@elsewhere.example" } }),
    "email_reply",
  );
  // reply_all to a thread with an outside Cc.
  assertRuleHold(
    await run("email_reply", { message_id: MESSAGE_ID, body: "Thanks", reply_all: true }, { original: { from: "colleague@corp.example", cc: "partner@elsewhere.example" } }),
    "email_reply",
  );
  // An extra Bcc the caller added.
  assertRuleHold(
    await run("email_reply", { message_id: MESSAGE_ID, body: "Thanks", bcc: ["spy@elsewhere.example"] }, { original: { from: "colleague@corp.example" } }),
    "email_reply",
  );
});

Deno.test("email_reply: an original that cannot be read is held, never sent", async () => {
  const r = await run("email_reply", { message_id: "m-missing", body: "Thanks" });
  assertRuleHold(r, "email_reply");
});

// ── draft_send ──────────────────────────────────────────────────────────────

Deno.test("draft_send: the draft's recipients are read and checked", async () => {
  const r = await run("draft_send", { draft_id: DRAFT_ID }, { draftTo: "Someone <out@elsewhere.example>" });
  assertRuleHold(r, "draft_send");
});

Deno.test("draft_send: a draft addressed inside the list is sent", async () => {
  const r = await run("draft_send", { draft_id: DRAFT_ID }, { draftTo: "in@corp.example" });
  assertEquals(r.approval, undefined);
  assertEquals(r.sends.length, 1);
});

// ── schedule_create ─────────────────────────────────────────────────────────

Deno.test("schedule_create: outside the list is held from the start (a held schedule)", async () => {
  const sendAt = new Date(Date.now() + 86_400_000).toISOString();
  const r = await run("schedule_create", { to: ["out@elsewhere.example"], subject: "Later", body: "Hello", send_at: sendAt });
  assertRuleHold(r, "schedule_create");
  assert(!r.world.db.some((c) => c.method === "POST" && c.target === "scheduled_sends"), "nothing was scheduled to go out");
});

Deno.test("schedule_create: inside the list is scheduled as before", async () => {
  const sendAt = new Date(Date.now() + 86_400_000).toISOString();
  const r = await run("schedule_create", { to: ["in@corp.example"], subject: "Later", body: "Hello", send_at: sendAt });
  assertEquals(r.approval, undefined);
  const scheduled = r.world.db.find((c) => c.method === "POST" && c.target === "scheduled_sends");
  assert(scheduled, "the send was scheduled");
  assertEquals((scheduled!.body as Row).created_by, CREATOR);
});

// ── Every hold path, pinned on the source ───────────────────────────────────

const SOURCE = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("every send handler asks the rule before it queues, and queues the rule's hold first", () => {
  for (const handler of ["executeSendEmail", "executeReplyToEmail", "executeForwardEmail", "executeSendDraft", "executeScheduleSend"]) {
    const start = SOURCE.indexOf(`async function ${handler}(`);
    assert(start > 0, handler);
    const body = SOURCE.slice(start, SOURCE.indexOf("\nasync function ", start + 1));
    const gate = body.indexOf("await recipientRuleGate(");
    const queue = body.indexOf("queueSendApproval(");
    assert(gate > 0, `${handler} asks recipientRuleGate`);
    assert(gate < queue, `${handler} asks before it queues`);
    assert(/recipientRuleHeldInbox\(/.test(body), `${handler} holds with recipientRuleHeldInbox`);
    assert(/if \("refusal" in rule\) return rule\.refusal;/.test(body), `${handler} returns the refusal`);
  }
});

Deno.test("the automation forward action asks the rule and holds with the rule's reason", () => {
  const start = SOURCE.indexOf('case "forward": {');
  const body = SOURCE.slice(start, SOURCE.indexOf('case "draft_reply": {', start));
  assert(/recipientRuleGate\(\{\s*tool: "email_forward",[\s\S]*recipients: \(\) => Promise\.resolve\(action\.to\)/.test(body));
  assert(/rule\.hold\s*\?\s*recipientRuleHeldInbox\(inboxRow, rule\.outside\)/.test(body));
});

Deno.test("queueSendApproval writes hold_reason only for the rule, and never lets it be dropped", () => {
  const start = SOURCE.indexOf("async function queueSendApproval(");
  const body = SOURCE.slice(start, SOURCE.indexOf("\n}\n", start));
  assert(/inbox\.brakeHold\?\.reason === RECIPIENT_RULE_HOLD_REASON \? \{ hold_reason: RECIPIENT_RULE_HOLD_REASON \} : \{\}/.test(body));
  assert(/requested_by: apiKey\.created_by \?\? null/.test(body));
  assert(/\[\.\.\.PENDING_APPROVAL_COLUMNS, "requested_by"\]/.test(body), "requested_by may be dropped, hold_reason may not");
});

Deno.test("every activity_log write that has the key passes its creator as user_id", () => {
  const writes = SOURCE.split("writeActivityLog({").slice(1).map((rest) => rest.slice(0, rest.indexOf("})")));
  const withKey = writes.filter((w) => /apiKeyId: apiKey\.id,/.test(w));
  assert(withKey.length >= 9, `found ${withKey.length}`);
  for (const w of withKey) assert(/userId: apiKey\.created_by \?\? null,/.test(w), w);
  assert(/user_id: params\.userId \?\? null,/.test(SOURCE), "the row carries user_id");
});
