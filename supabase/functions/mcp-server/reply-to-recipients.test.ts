// ---------------------------------------------------------------------------
// reply-to-recipients.test.ts: reply drafts follow Reply-To through the real
// draft_reply handler over the fake provider network (2026-10-31). The rule
// itself is in recipient-rules.test.ts. Every mailbox here is invented.
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { API_KEY, executeCreateReplyDraft, inboxRow, json, runTool } from "./provider-call-harness.ts";
import { parseAddressHeader } from "./address-header.ts";
import { getHeader, parseEmail } from "./mime.ts";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const GRAPH = "https://graph.microsoft.com/v1.0";
const DRAFT_KEY = { ...API_KEY, scopes: [...API_KEY.scopes, "manage:drafts"] };

function encodedWord(text: string): string {
  return `=?UTF-8?B?${btoa(text)}?=`;
}
function b64url(byteString: string): string {
  return btoa(byteString).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A Gmail reply draft over the fake network, for a message with these headers. */
async function gmailReply(
  decoded: Record<string, string>,
  rawHeaders: string,
  opts: { rawAvailable?: boolean; replyAll?: boolean } = {},
) {
  const inbox = await inboxRow("gmail");
  const headers = Object.entries({ Subject: "hi", "Message-ID": "<m@corp.example>", ...decoded })
    .map(([name, value]) => ({ name, value }));
  const raw = `${rawHeaders}\r\nSubject: hi\r\nContent-Type: text/plain\r\n\r\nhello`;
  const { value, world } = await runTool(inbox, (call) => {
    if (call.method === "GET" && call.url.startsWith(`${GMAIL}/messages/orig1?format=metadata`)) {
      return json({ id: "orig1", threadId: "t9", payload: { headers } });
    }
    if (call.method === "GET" && call.url.startsWith(`${GMAIL}/messages/orig1?format=raw`)) {
      return opts.rawAvailable === false
        ? json({ error: { message: "backend error" } }, 503)
        : json({ id: "orig1", threadId: "t9", raw: b64url(raw) });
    }
    if (call.method === "GET" && call.url.startsWith(`${GMAIL}/messages/orig1`)) {
      return json({ id: "orig1", threadId: "t9", payload: { mimeType: "text/plain", headers: [], body: { data: "aGVsbG8" } } });
    }
    if (call.method === "POST" && call.url === `${GMAIL}/drafts`) return json({ id: "d7", message: { id: "m7" } });
    return json({ error: { message: `unexpected ${call.method} ${call.url}` } }, 500);
  }, () =>
    executeCreateReplyDraft({ message_id: "orig1", body: "ok", reply_all: opts.replyAll === true }, DRAFT_KEY) as Promise<
      { result: unknown; logStatus: string }
    >);
  const create = world.calls.find((c) => c.method === "POST" && c.url === `${GMAIL}/drafts`);
  const to = create
    ? parseAddressHeader(getHeader(
      parseEmail(atob((JSON.parse(create.body!) as { message: { raw: string } }).message.raw.replace(/-/g, "+").replace(/_/g, "/"))).headers,
      "to",
    )).map((a) => a.email)
    : null;
  return { value, world, to };
}

Deno.test("Gmail reply draft: goes to Reply-To, not to a From that is the inbox", async () => {
  const own = String((await inboxRow("gmail")).email_address);
  const { value, to } = await gmailReply(
    { From: own, To: own, "Reply-To": "Customer <customer@corp.example>" },
    `From: ${own}\r\nTo: ${own}\r\nReply-To: Customer <customer@corp.example>`,
  );
  assertEquals(value.logStatus, "success", JSON.stringify(value.result));
  assertEquals(to, ["customer@corp.example"]);
});

Deno.test("Gmail reply draft: no Reply-To stays on From and reads no raw headers", async () => {
  const { to, world } = await gmailReply(
    { From: "Sender <sender@corp.example>", To: "someone@corp.example" },
    "From: Sender <sender@corp.example>",
  );
  assertEquals(to, ["sender@corp.example"]);
  assertFalse(world.calls.some((c) => c.url.includes("format=raw")));
});

Deno.test("Gmail reply draft: an encoded comma in a Reply-To name adds no recipient", async () => {
  const { to } = await gmailReply(
    { From: "sender@corp.example", "Reply-To": "exfil@evil.example, <real@corp.example>" },
    `From: sender@corp.example\r\nReply-To: ${encodedWord("exfil@evil.example,")} <real@corp.example>`,
  );
  assertEquals(to, ["real@corp.example"]);
});

Deno.test("Gmail reply draft: raw headers unavailable with a Reply-To creates nothing", async () => {
  const { value, to } = await gmailReply(
    { From: "sender@corp.example", "Reply-To": "real@corp.example" },
    "From: sender@corp.example",
    { rawAvailable: false },
  );
  assert(value.logStatus !== "success");
  assertEquals(to, null);
});

/** An Outlook reply draft whose original carries this Reply-To. */
async function outlookReply(
  replyTo: { emailAddress: { name?: string; address: string } }[],
  opts: { readStatus?: number; replyAll?: boolean } = {},
) {
  const inbox = await inboxRow("outlook");
  const graphBuilt = { emailAddress: { name: "Graph", address: "graph-built@corp.example" } };
  const { value, world } = await runTool(inbox, (call) => {
    if (call.method === "GET" && call.url.startsWith(`${GRAPH}/me/messages/orig1?`)) {
      if (opts.readStatus) return json({ error: { message: "nope" } }, opts.readStatus);
      return json({
        from: { emailAddress: { address: inbox.email_address } },
        replyTo,
        toRecipients: [{ emailAddress: { address: inbox.email_address } }],
        ccRecipients: [],
      });
    }
    if (call.method === "POST" && /\/me\/messages\/orig1\/createReply(All)?$/.test(call.url)) {
      return json({ id: "d1", conversationId: "c1", subject: "RE: hi", body: { contentType: "html", content: "<p>quote</p>" }, toRecipients: [graphBuilt] }, 201);
    }
    if (call.method === "PATCH" && call.url === `${GRAPH}/me/messages/d1`) return json({ id: "d1" });
    if (call.method === "GET" && call.url.startsWith(`${GRAPH}/me/messages/d1`)) return json({ error: { message: "read-back skipped" } }, 503);
    return json({ error: { message: `unexpected ${call.method} ${call.url}` } }, 500);
  }, () =>
    executeCreateReplyDraft({ message_id: "orig1", body: "ok", reply_all: opts.replyAll === true }, DRAFT_KEY) as Promise<
      { result: unknown; logStatus: string }
    >);
  const patch = world.calls.find((c) => c.method === "PATCH" && c.url === `${GRAPH}/me/messages/d1`);
  return { value, world, patched: JSON.parse(patch?.body ?? "{}") as Record<string, unknown> };
}

Deno.test("Outlook reply draft: Reply-To is written onto the draft and reported", async () => {
  const { value, patched } = await outlookReply([{ emailAddress: { name: "Customer", address: "customer@corp.example" } }]);
  assertEquals(value.logStatus, "success", JSON.stringify(value.result));
  assertEquals(patched.toRecipients, [{ emailAddress: { name: "Customer", address: "customer@corp.example" } }]);
  assertEquals(patched.ccRecipients, []);
  const text = JSON.stringify(value.result);
  assert(text.includes("customer@corp.example"), text);
  assertFalse(text.includes("graph-built@corp.example"), text);
});

Deno.test("Outlook reply draft: no Reply-To keeps what createReply wrote", async () => {
  const { patched } = await outlookReply([]);
  assertFalse("toRecipients" in patched);
  assertFalse("ccRecipients" in patched);
});

Deno.test("Outlook reply draft: a failed read of the original keeps createReply's addressing", async () => {
  const { value, patched } = await outlookReply([], { readStatus: 503 });
  assertEquals(value.logStatus, "success", JSON.stringify(value.result));
  assertFalse("toRecipients" in patched);
});

Deno.test("every reply path hands Reply-To to the shared rule", async () => {
  const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const calls = index.split("computeReplyRecipients({").slice(1).map((rest) => rest.slice(0, rest.indexOf("});")));
  assertEquals(calls.length, 7, "a reply path was added or removed: update this count and check it reads Reply-To");
  for (const call of calls) assert(/\breplyTo:/.test(call), `no replyTo in: ${call}`);
});
