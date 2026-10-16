// Integration verifier (u05 x u06): the held draft send's digest reads From
// and Reply-To through u05's structure-first parser (parseAddressHeader), not
// the old decode-then-parse. An encoded-word display name can therefore never
// add, hide or replace a mailbox in what the digest covers.

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { parseAddressHeader } from "./address-header.ts";
import { draftDigest } from "./draft-send-snapshot.ts";

Deno.env.set("MCP_INTROSPECTION_ONLY", "1");
Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-role");
const { draftContentFromRaw, formatAddressEntry } = await import("./index.ts");

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const ew = (s: string) => `=?UTF-8?B?${b64(s)}?=`;

function raw(replyTo: string, from = "Owner <owner@example.com>"): string {
  return [
    `From: ${from}`,
    "To: Ann <ann@example.com>",
    `Reply-To: ${replyTo}`,
    "Subject: Hello",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Body",
    "",
  ].join("\r\n");
}

Deno.test("merge verify: headerFrom/headerReplyTo come from the structure-first parser", () => {
  // Decodes to `Desk, drop@evil.example <x>`-like text: the old path split it
  // into extra mailboxes; structure-first keeps one mailbox, the real address.
  const smuggle = `${ew("Desk, drop@evil.example,")} <desk@example.com>`;
  const c = draftContentFromRaw(raw(smuggle, `${ew("a@evil.example, Owner")} <owner@example.com>`));
  assertEquals(c.headerReplyTo, parseAddressHeader(smuggle).map(formatAddressEntry));
  assertEquals(c.headerReplyTo!.length, 1, "one Reply-To mailbox, not a smuggled second one");
  assert(c.headerReplyTo![0].includes("<desk@example.com>"), String(c.headerReplyTo![0]));
  assertEquals(c.headerFrom!.length, 1);
  assert(c.headerFrom![0].includes("<owner@example.com>"), String(c.headerFrom![0]));
});

Deno.test("merge verify: swapping the real Reply-To address behind the same encoded name changes the raw digest", async () => {
  const name = ew("Desk, drop@evil.example");
  const approved = await draftDigest(draftContentFromRaw(raw(`${name} <desk@example.com>`)));
  const swapped = await draftDigest(draftContentFromRaw(raw(`${name} <drop@evil.example>`)));
  assertNotEquals(swapped, approved);
  // And an untouched draft keeps its digest across re-parsing.
  assertEquals(await draftDigest(draftContentFromRaw(raw(`${name} <desk@example.com>`))), approved);
});
