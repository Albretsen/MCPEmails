// ---------------------------------------------------------------------------
// Naming the inbox's own address must work on every provider.
//
// Production repro: agents called email_send on IMAP inboxes with
// `from: "<the inbox's own address>"`, which is the default written out. The
// provider check ran before the self-address check, so it was refused with
// "Send As identities are currently available only for Gmail", which reads as
// "this inbox cannot send at all". activity_log held 23 of these across four
// workspaces between 2026-08-10 and 2026-09-01, all on IMAP inboxes.
// ---------------------------------------------------------------------------
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  findImapSenderAlias,
  imapAliasSenderView,
  isSelfSenderIdentity,
  senderIdentityErrorCode,
  unauthorizedSenderIdentityText,
  unsupportedSenderIdentityText,
} from "./sender-identity.ts";

Deno.test("the inbox's own address is recognised as itself", () => {
  assert(isSelfSenderIdentity("someone@gmail.com", "someone@gmail.com"));
});

Deno.test("the self-address match ignores case and surrounding space", () => {
  for (const raw of ["  SomeOne@Gmail.com  ", "SOMEONE@GMAIL.COM", "someone@gmail.com "]) {
    assert(isSelfSenderIdentity("someone@gmail.com", raw), raw);
  }
  // The stored address is normalised the same way, so a stray space on either
  // side of the comparison cannot turn a match into a refusal.
  assert(isSelfSenderIdentity(" Someone@Gmail.com ", "someone@gmail.com"));
});

Deno.test("a different address is NOT the inbox's own", () => {
  for (const raw of [
    "someone.else@example.com",
    "someone@gmail.com.evil.example",
    "someone@googlemail.com",
    "asgeir@iago.no",
  ]) {
    assert(!isSelfSenderIdentity("someone@gmail.com", raw), raw);
  }
});

Deno.test("each cause gets its own activity_log code", () => {
  assertEquals(senderIdentityErrorCode("invalid_sender_identity"), "sender_identity_invalid");
  assertEquals(
    senderIdentityErrorCode("sender_identity_unsupported_provider"),
    "sender_identity_unsupported_provider",
  );
  assertEquals(
    senderIdentityErrorCode("gmail_sender_identities_scope_required"),
    "sender_identity_scope_required",
  );
  assertEquals(
    senderIdentityErrorCode("sender_identity_not_authorized"),
    "sender_identity_not_authorized",
  );
  // Anything unexpected must still be distinguishable from the four known
  // causes rather than silently joining one of them.
  assertEquals(senderIdentityErrorCode("boom"), "sender_identity_lookup_failed");
});

// ---------------------------------------------------------------------------
// IMAP Send As (20261018120000). Production trigger: an iCloud customer wanted
// to send as an alias of their Apple ID. Apple refuses the alias as a login and
// the login-collision guard refuses connecting the primary login twice, so the
// alias is stored against the existing inbox and swapped into From at send.
// ---------------------------------------------------------------------------

const ICLOUD = {
  email_address: "primary@icloud.example",
  display_name: "Primary Name",
  imap_username: null as string | null,
};

Deno.test("an IMAP alias is found case-insensitively and nothing else matches", () => {
  const aliases = [{ email_address: "alias@icloud.example", display_name: null }];
  assertEquals(findImapSenderAlias(aliases, "  ALIAS@icloud.example ")?.email_address, "alias@icloud.example");
  for (const raw of ["alias@icloud.example.evil", "other@icloud.example", "alias@icloud"]) {
    assertEquals(findImapSenderAlias(aliases, raw), null, raw);
  }
  assertEquals(findImapSenderAlias([], "alias@icloud.example"), null);
});

Deno.test("sending as an IMAP alias keeps the login of the connected address", () => {
  // imap_username is null on most inboxes and the login falls back to
  // email_address, so swapping the address alone would log in as the alias,
  // which iCloud refuses.
  const view = imapAliasSenderView(ICLOUD, { email_address: "alias@icloud.example", display_name: "Alias" });
  assertEquals(view.email_address, "alias@icloud.example");
  assertEquals(view.display_name, "Alias");
  assertEquals(view.imap_username, "primary@icloud.example");

  // A distinct stored login is kept as it is.
  const custom = imapAliasSenderView({ ...ICLOUD, imap_username: "login-name" }, {
    email_address: "alias@icloud.example",
    display_name: null,
  });
  assertEquals(custom.imap_username, "login-name");
  // No alias name: the inbox's sender name stays.
  assertEquals(custom.display_name, "Primary Name");
});

Deno.test("the refusal texts name IMAP Send As and where to set it up", () => {
  assert(unsupportedSenderIdentityText("email_send", "outlook").includes("Gmail and IMAP"));
  assert(unsupportedSenderIdentityText("email_send", "outlook").includes("outlook only supports"));
  assert(unauthorizedSenderIdentityText("email_send", "imap").includes("dashboard"));
  assert(!unauthorizedSenderIdentityText("email_send", "gmail").includes("dashboard"));
});

// The wiring lives in index.ts, which cannot be imported (it calls Deno.serve
// at load), so these read its source.
const INDEX = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("resolveSenderIdentity accepts verified IMAP aliases before the Gmail-only refusal", () => {
  const body = INDEX.slice(INDEX.indexOf("async function resolveSenderIdentity("));
  const imap = body.indexOf('inbox.provider === "imap"');
  const refusal = body.indexOf('throw new Error("sender_identity_unsupported_provider")');
  assert(imap > 0 && refusal > imap, "the IMAP branch runs before the unsupported-provider throw");
  assert(body.slice(imap, refusal).includes("imapAliasSenderView("), "the login-preserving view is used");
});

Deno.test("only verified alias rows are ever read", () => {
  const fn = INDEX.slice(INDEX.indexOf("async function listImapSenderAliases("));
  const end = fn.indexOf("\n}\n");
  const body = fn.slice(0, end);
  assert(body.includes('.not("verified_at", "is", null)'), "unverified rows are filtered out");
  assert(body.includes('.eq("workspace_id", workspaceId)'), "scoped to the caller's workspace");
});
