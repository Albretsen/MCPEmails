// ---------------------------------------------------------------------------
// `contact_search` display names.
//
// The first test is the bug verbatim. A live functional run on 2026-09-20
// (F-07) asked for one contact and got the encoded-word back instead of the
// name inside it, on the one field that exists purely to be read.
//
// The bidi test is the reason the strip rides with the decode rather than
// sitting somewhere downstream: an encoded-word is opaque until it is decoded,
// so a RIGHT-TO-LEFT OVERRIDE hidden in its payload is invisible to any
// sanitiser that runs before this. `contact_search` is a tool whose whole
// output an agent reads as a list of people to act on, and a display name that
// renders as somebody else is exactly the spoof text-safety.ts exists for.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------
import { assert, assertEquals } from "jsr:@std/assert@1";
import { contactDisplayName } from "./contact-display-name.ts";

Deno.test("the F-07 name decodes instead of shipping as an encoded-word", () => {
  assertEquals(
    contactDisplayName("=?UTF-8?Q?Karin_p=C3=A5_Teknikkdeler?="),
    "Karin på Teknikkdeler",
  );
});

Deno.test("B-encoded non-ASCII decodes too", () => {
  // =?UTF-8?B?…?= of "田中 太郎", the other half of RFC 2047 that mail uses.
  const encoded = `=?UTF-8?B?${btoa(
    String.fromCharCode(...new TextEncoder().encode("田中 太郎")),
  )}?=`;
  assertEquals(contactDisplayName(encoded), "田中 太郎");
});

Deno.test("adjacent encoded-words join without the folding space", () => {
  // A name longer than 75 octets is split; the whitespace between two
  // encoded-words is separator, not text. Same rule email_read already relies
  // on — this is here so the contact path cannot drift away from it.
  assertEquals(
    contactDisplayName("=?UTF-8?Q?Karin_p=C3=A5?= =?UTF-8?Q?_Teknikkdeler?="),
    "Karin på Teknikkdeler",
  );
});

Deno.test("a plain ASCII name is passed through untouched", () => {
  assertEquals(contactDisplayName("Karin Nilsen"), "Karin Nilsen");
});

Deno.test("an unencoded non-ASCII name survives", () => {
  // Not every sender encodes: SMTPUTF8 senders put the UTF-8 in the header raw.
  assertEquals(contactDisplayName("Karin på Teknikkdeler"), "Karin på Teknikkdeler");
});

Deno.test("a bidi override hidden inside an encoded-word does not survive the decode", () => {
  // U+202E inside the payload: the strip upstream of the decode cannot see it,
  // because at that point it is the four ASCII characters "=E2=80=AE".
  const spoof = "=?UTF-8?Q?Karin=E2=80=AEfdp.exe?=";
  const decoded = contactDisplayName(spoof);
  assert(!decoded.includes("‮"), `bidi override survived: ${JSON.stringify(decoded)}`);
  assertEquals(decoded, "Karinfdp.exe");
});

Deno.test("zero-width padding inside an encoded-word is stripped", () => {
  const padded = `=?UTF-8?B?${btoa(
    String.fromCharCode(...new TextEncoder().encode("Ka​rin﻿")),
  )}?=`;
  assertEquals(contactDisplayName(padded), "Karin");
});

Deno.test("surrounding whitespace is trimmed, and a blank name becomes empty", () => {
  assertEquals(contactDisplayName("  Karin  "), "Karin");
  assertEquals(contactDisplayName("   "), "");
  assertEquals(contactDisplayName(""), "");
  assertEquals(contactDisplayName(null), "");
  assertEquals(contactDisplayName(undefined), "");
});

Deno.test("a malformed encoded-word is left as the sender wrote it", () => {
  // Guessing is worse than showing what arrived: this is not valid base64, and
  // the decoder keeps the payload rather than inventing a name.
  assertEquals(contactDisplayName("=?UTF-8?B?!!!!?="), "!!!!");
});
