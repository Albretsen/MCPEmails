// ---------------------------------------------------------------------------
// gmail-reply-all-raw.test.ts — Gmail reply-all takes To/Cc from the RAW
// headers (2026-10-16), through the real draft_reply handler over the fake
// Gmail network (provider-call-harness.ts).
//
// Gmail's metadata header values are RFC 2047-DECODED. An encoded display
// name "x@evil.com," splits, in the decoded value, into an extra mailbox; the
// raw header holds one. Every mailbox and address here is invented.
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { API_KEY, executeCreateReplyDraft, inboxRow, json, runTool } from "./provider-call-harness.ts";
import { parseAddressHeader } from "./address-header.ts";
import { getHeader, parseEmail } from "./mime.ts";

function encodedWord(text: string): string {
  return `=?UTF-8?B?${btoa(Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join(""))}?=`;
}
function b64urlOf(byteString: string): string {
  return btoa(byteString).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function envelopeOf(stored: string): string[] {
  const h = parseEmail(stored).headers;
  return ["to", "cc", "bcc"].flatMap((name) => parseAddressHeader(getHeader(h, name)).map((a) => a.email));
}

const HOSTILE_RAW_HEADERS = [
  "From: Attacker <attacker@evil.com>",
  `To: ${encodedWord("exfil@evil.com,")} <colleague@corp.example>, owner@gmail-harness.example`,
  `Cc: ${encodedWord("boss@corp.example, Real")} <cc@corp.example>`,
  "Subject: hi",
  "Message-ID: <hostile@evil.com>",
].join("\r\n");

Deno.test("Gmail draft_reply reply_all: an encoded comma in a To/Cc name adds no recipient", async () => {
  const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
  const inbox = await inboxRow("gmail");
  const rawMessage = HOSTILE_RAW_HEADERS + "\r\nContent-Type: text/plain\r\n\r\nhello";
  const run = (rawAvailable: boolean) =>
    runTool(inbox, (call) => {
      if (call.method === "GET" && call.url.startsWith(`${GMAIL}/messages/orig1?format=metadata`)) {
        // Gmail's DECODED values, as the metadata API returns them.
        return json({
          id: "orig1",
          threadId: "t9",
          payload: {
            headers: [
              { name: "From", value: "Attacker <attacker@evil.com>" },
              { name: "To", value: "exfil@evil.com, <colleague@corp.example>, owner@gmail-harness.example" },
              { name: "Cc", value: "boss@corp.example, Real <cc@corp.example>" },
              { name: "Subject", value: "hi" },
              { name: "Message-ID", value: "<hostile@evil.com>" },
            ],
          },
        });
      }
      if (call.method === "GET" && call.url.startsWith(`${GMAIL}/messages/orig1?format=raw`)) {
        return rawAvailable
          ? json({ id: "orig1", threadId: "t9", raw: b64urlOf(rawMessage) })
          : json({ error: { message: "backend error" } }, 503);
      }
      if (call.method === "GET" && call.url.startsWith(`${GMAIL}/messages/orig1`)) {
        return json({ id: "orig1", threadId: "t9", payload: { mimeType: "text/plain", headers: [], body: { data: "aGVsbG8" } } });
      }
      if (call.method === "POST" && call.url === `${GMAIL}/drafts`) return json({ id: "d7", message: { id: "m7" } });
      return json({ error: { message: `unexpected ${call.method} ${call.url}` } }, 500);
    }, () =>
      executeCreateReplyDraft({ message_id: "orig1", body: "ok", reply_all: true }, {
        ...API_KEY,
        scopes: [...API_KEY.scopes, "manage:drafts"],
      }) as Promise<{ result: unknown; logStatus: string }>);

  const { value, world } = await run(true);
  assertEquals(value.logStatus, "success", JSON.stringify(value.result));
  const create = world.calls.find((c) => c.method === "POST" && c.url === `${GMAIL}/drafts`)!;
  const raw = (JSON.parse(create.body!) as { message: { raw: string } }).message.raw;
  const stored = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
  const envelope = envelopeOf(stored).sort();
  assertEquals(envelope, ["attacker@evil.com", "cc@corp.example", "colleague@corp.example"]);
  assertFalse(stored.includes("exfil@evil.com") && envelope.includes("exfil@evil.com"));

  // Raw headers unavailable: reply-all is refused, nothing is created.
  const failed = await run(false);
  assert(failed.value.logStatus !== "success", JSON.stringify(failed.value.result));
  assert(JSON.stringify(failed.value.result).includes("reply_all"), JSON.stringify(failed.value.result));
  assertFalse(failed.world.calls.some((c) => c.method === "POST" && c.url === `${GMAIL}/drafts`));
});
