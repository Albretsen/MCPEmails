import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  CHAT_CONFIRM_MIN_WAIT_MS,
  CHAT_CONFIRM_TTL_MS,
  type ChatConfirmBinding,
  chatConfirmContent,
  chatConfirmDigest,
  chatConfirmRefusalText,
  issueChatConfirmation,
  verifyChatConfirmation,
} from "./chat-confirm.ts";

const key = await crypto.subtle.importKey(
  "raw",
  new Uint8Array(32).fill(7),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"],
);
const sign = async (value: string) => {
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
};

const T0 = Date.UTC(2026, 9, 23, 12, 0, 0);

async function binding(content: Record<string, unknown>, over: Partial<ChatConfirmBinding> = {}) {
  return {
    apiKeyId: "key-1",
    inboxId: "inbox-1",
    operation: "email_send",
    contentDigest: await chatConfirmDigest(chatConfirmContent(content)),
    ...over,
  };
}

const message = { to: ["a@example.com"], subject: "Hi", body: "Hello" };

Deno.test("a code confirms the same message after the user had time to answer", async () => {
  const b = await binding(message);
  const token = await issueChatConfirmation(sign, b, T0);
  assertEquals(await verifyChatConfirmation(sign, b, token, T0 + CHAT_CONFIRM_MIN_WAIT_MS), "ok");
});

Deno.test("no code, or a code repeated at once, is not a confirmation", async () => {
  const b = await binding(message);
  const token = await issueChatConfirmation(sign, b, T0);
  assertEquals(await verifyChatConfirmation(sign, b, undefined, T0), "missing");
  assertEquals(await verifyChatConfirmation(sign, b, "", T0), "missing");
  assertEquals(await verifyChatConfirmation(sign, b, token, T0 + 1_000), "too_soon");
});

Deno.test("a code expires", async () => {
  const b = await binding(message);
  const token = await issueChatConfirmation(sign, b, T0);
  assertEquals(await verifyChatConfirmation(sign, b, token, T0 + CHAT_CONFIRM_TTL_MS + 1), "expired");
});

Deno.test("a changed message, another inbox, key or operation needs a new yes", async () => {
  const b = await binding(message);
  const token = await issueChatConfirmation(sign, b, T0);
  const later = T0 + 60_000;
  const changed = await binding({ ...message, bcc: ["x@example.com"] });
  assertEquals(await verifyChatConfirmation(sign, changed, token, later), "mismatch");
  assertEquals(await verifyChatConfirmation(sign, { ...b, inboxId: "inbox-2" }, token, later), "mismatch");
  assertEquals(await verifyChatConfirmation(sign, { ...b, apiKeyId: "key-2" }, token, later), "mismatch");
  assertEquals(await verifyChatConfirmation(sign, { ...b, operation: "email_reply" }, token, later), "mismatch");
});

Deno.test("a forged issue time does not pass: the time is under the MAC", async () => {
  const b = await binding(message);
  const token = await issueChatConfirmation(sign, b, T0);
  const [prefix, , mac] = token.split("-");
  const backdated = `${prefix}-${(T0 - 60_000).toString(36)}-${mac}`;
  assertEquals(await verifyChatConfirmation(sign, b, backdated, T0 + 1_000), "mismatch");
});

Deno.test("garbage is malformed, not a crash", async () => {
  const b = await binding(message);
  for (const bad of ["yes", "c1-zz", "c2-abc-def", 42, { a: 1 }]) {
    assertEquals(await verifyChatConfirmation(sign, b, bad, T0), "malformed");
  }
});

Deno.test("key order, the code itself, the retry key and how the inbox is named do not change the content", async () => {
  const a = await chatConfirmDigest(chatConfirmContent({ ...message, inbox: "me@example.com" }));
  const b = await chatConfirmDigest(chatConfirmContent({
    body: "Hello",
    subject: "Hi",
    to: ["a@example.com"],
    confirmation: "c1-x-y",
    idempotency_key: "k",
    inbox_id: "inbox-1",
  }));
  assertEquals(a, b);
  assertNotEquals(a, await chatConfirmDigest(chatConfirmContent({ ...message, body: "Hello!" })));
});

Deno.test("the refusal carries the code, says nothing was sent, and steers to the card when it is on", () => {
  const withCard = chatConfirmRefusalText({
    operation: "email_send",
    verdict: "missing",
    token: "c1-abc-123",
    inboxAddress: "me@example.com",
    cardAvailable: true,
  });
  assertStringIncludes(withCard, "not sent");
  assertStringIncludes(withCard, 'confirmation: "c1-abc-123"');
  assertStringIncludes(withCard, "draft{action:'create'}");
  assertStringIncludes(withCard, "not a draft tool from another connector");

  const noCard = chatConfirmRefusalText({
    operation: "email_send",
    verdict: "too_soon",
    token: "c1-abc-123",
    inboxAddress: "me@example.com",
    cardAvailable: false,
  });
  assert(!noCard.includes("draft card"));
  assertStringIncludes(noCard, "too fast");

  const draft = chatConfirmRefusalText({
    operation: "draft_send",
    verdict: "mismatch",
    token: "c1-abc-123",
    inboxAddress: "me@example.com",
    cardAvailable: true,
    draftId: "Drafts:7",
  });
  assertStringIncludes(draft, "draft card for Drafts:7");
  assertStringIncludes(draft, "draft{action:'send'}");
});

Deno.test("every send handler asks the gate before it queues or sends", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  for (const op of ["email_send", "email_reply", "email_forward", "draft_send", "schedule_create"]) {
    const gate = source.indexOf(`apiKey, operation: "${op}", inboxes:`);
    assert(gate > 0, `${op} has no chatConfirmGate call`);
    const fn = source.lastIndexOf("\nasync function execute", gate);
    const queue = source.indexOf("queueSendApproval(", gate);
    const nextFn = source.indexOf("\nasync function ", gate);
    assert(queue > gate && queue < nextFn, `${op}: the gate must come before queueSendApproval`);
    assert(fn > 0 && !source.slice(fn, gate).includes("queueSendApproval("), `${op}: queued before the gate`);
  }
});
