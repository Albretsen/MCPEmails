// ---------------------------------------------------------------------------
// The untrusted_content marker on the four surfaces that were missing it.
//
// Two things are asserted for each, and the second is the one that gets
// forgotten:
//
//   1. the marker is present when there IS mailbox text, and
//   2. the marker is present when there is NOT.
//
// A marker that only appears alongside data teaches a client that its absence
// means "trusted", which is exactly backwards — an empty folder list and an
// empty draft list must say the same thing about themselves as a full one.
//
// The neutralisation half is asserted with real invisible characters rather
// than a description of them: RIGHT-TO-LEFT OVERRIDE, the bidi isolates and
// zero-width padding are what let a short scanned field lie about its own
// contents, and a folder name is precisely such a field.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildDraftListEnvelope,
  buildDraftMutationEnvelope,
  buildFolderListEnvelope,
  buildSentMessageEnvelope,
} from "./untrusted-envelope.ts";

/** RIGHT-TO-LEFT OVERRIDE — flips the tail of a string when rendered. */
const RLO = "‮";
/** POP DIRECTIONAL ISOLATE. */
const PDI = "⁩";
/** ZERO WIDTH SPACE. */
const ZWSP = "​";
/** ZERO WIDTH NON-JOINER — the character senders pad preheaders with. */
const ZWNJ = "‌";

// ── folder_list ─────────────────────────────────────────────────────────────

Deno.test("folder_list envelope carries the marker", () => {
  const env = buildFolderListEnvelope({
    inboxId: "inbox-1",
    folders: [{ id: "Label_7", name: "Receipts", type: "label" }],
  });
  assertEquals(env.untrusted_content, true);
  assertEquals(env.inbox_id, "inbox-1");
  assertEquals(env.folders.length, 1);
});

Deno.test("folder_list envelope carries the marker on an EMPTY result", () => {
  assertEquals(
    buildFolderListEnvelope({ inboxId: "inbox-1", folders: [] }).untrusted_content,
    true,
  );
  // A provider that returned nothing at all must not produce a bare result
  // either — absence of folders is not evidence of trustworthiness.
  assertEquals(
    buildFolderListEnvelope({ inboxId: "inbox-1", folders: null }).untrusted_content,
    true,
  );
  assertEquals(
    buildFolderListEnvelope({ inboxId: "inbox-1", folders: undefined }).folders,
    [],
  );
});

Deno.test("a folder name with bidi and invisible characters is neutralised", () => {
  const env = buildFolderListEnvelope({
    inboxId: "inbox-1",
    folders: [{
      id: "Label_9",
      name: `Invoices${RLO} fdp.exe${PDI}${ZWSP}${ZWNJ}`,
      type: "label",
    }],
  });
  assertEquals(env.folders[0].name, "Invoices fdp.exe");
  for (const ch of [RLO, PDI, ZWSP, ZWNJ]) {
    assert(
      !env.folders[0].name!.includes(ch),
      `invisible character ${ch.codePointAt(0)!.toString(16)} survived`,
    );
  }
});

Deno.test("folder ids are left alone: on IMAP the id IS the mailbox name", () => {
  // Rewriting an id would break addressing to fix a display problem. The id
  // has to round-trip verbatim into email_move / email_list.
  const id = `Archive${ZWSP}`;
  const env = buildFolderListEnvelope({
    inboxId: "inbox-1",
    folders: [{ id, name: `Archive${ZWSP}`, type: "folder" }],
  });
  assertEquals(env.folders[0].id, id);
  assertEquals(env.folders[0].name, "Archive");
});

Deno.test("folder_list preserves fields the builder was never taught about", () => {
  const env = buildFolderListEnvelope({
    inboxId: "inbox-1",
    folders: [{
      id: "Label_7",
      name: "Receipts",
      type: "label",
      total_messages: 12,
      unread_messages: 3,
    }],
  });
  assertEquals(env.folders[0].total_messages, 12);
  assertEquals(env.folders[0].unread_messages, 3);
  assertEquals(env.folders[0].type, "label");
});

Deno.test("a folder with no name at all still yields a string", () => {
  const env = buildFolderListEnvelope({
    inboxId: "inbox-1",
    folders: [{ id: "Label_7" } as { id: string; name?: string }],
  });
  assertEquals(env.folders[0].name, "");
});

// ── draft_list ──────────────────────────────────────────────────────────────

Deno.test("draft_list envelope carries the marker, populated and empty", () => {
  assertEquals(
    buildDraftListEnvelope({
      inboxId: "inbox-1",
      drafts: [{ draft_id: "d1", subject: "Re: lunch" }],
    }).untrusted_content,
    true,
  );
  assertEquals(
    buildDraftListEnvelope({ inboxId: "inbox-1", drafts: [] }).untrusted_content,
    true,
  );
  assertEquals(
    buildDraftListEnvelope({ inboxId: "inbox-1", drafts: null }).drafts,
    [],
  );
});

Deno.test("draft_list neutralises the derived subject and recipient names", () => {
  const env = buildDraftListEnvelope({
    inboxId: "inbox-1",
    drafts: [{
      draft_id: "d1",
      subject: `Re: Invoice${RLO}${ZWSP} overdue`,
      to: [{ name: `Acme${ZWNJ} Billing`, email: "billing@acme.example" }],
      cc: [{ name: `${RLO}Finance`, email: "fin@acme.example" }],
      created_at: "2026-08-30T10:00:00Z",
    }],
  });
  const d = env.drafts[0];
  assertEquals(d.subject, "Re: Invoice overdue");
  assertEquals(d.to, [{ name: "Acme Billing", email: "billing@acme.example" }]);
  assertEquals(d.cc, [{ name: "Finance", email: "fin@acme.example" }]);
  // The address itself is an identifier, never rewritten.
  assertEquals(d.created_at, "2026-08-30T10:00:00Z");
});

// ── draft_create / draft_reply / draft_update ───────────────────────────────

Deno.test("draft mutation results carry the marker", () => {
  const created = buildDraftMutationEnvelope({
    draft_id: "d1",
    subject: "Notes",
    to: [{ name: "Bo", email: "bo@example.com" }],
    created_at: "2026-08-30T10:00:00Z",
  });
  assertEquals(created.untrusted_content, true);
  assertEquals(created.draft_id, "d1");
  assertEquals(created.created_at, "2026-08-30T10:00:00Z");
});

Deno.test("a reply draft's derived subject is neutralised", () => {
  const replied = buildDraftMutationEnvelope({
    draft_id: "d2",
    subject: `Re: ${RLO}URGENT${PDI} wire request`,
    to: [{ name: `${ZWSP}Payroll`, email: "payroll@example.com" }],
    in_reply_to: "<abc@example.com>",
    threading: "native",
  });
  assertEquals(replied.subject, "Re: URGENT wire request");
  assertEquals(replied.to, [{ name: "Payroll", email: "payroll@example.com" }]);
  assertEquals(replied.in_reply_to, "<abc@example.com>");
  assertEquals(replied.threading, "native");
  assertEquals(replied.untrusted_content, true);
});

Deno.test("draft_update has no `to` field and must not grow one", () => {
  // The IMAP update path returns draft_id/subject/updated_at only. A builder
  // that invented an empty `to` would look like the update had cleared the
  // draft's recipients.
  const updated = buildDraftMutationEnvelope({
    draft_id: "d3",
    subject: "Notes",
    updated_at: "2026-08-30T11:00:00Z",
  });
  assert(!("to" in updated), "buildDraftMutationEnvelope invented a `to` field");
  assertEquals(updated.untrusted_content, true);
});

// ── email_reply / email_forward ─────────────────────────────────────────────

Deno.test("the sent-message result carries the marker", () => {
  const sent = buildSentMessageEnvelope({
    message_id: "m1",
    thread_id: "t1",
    sent_at: "2026-08-30T12:00:00Z",
    to: [{ name: "Bo", email: "bo@example.com" }],
    cc: [],
    bcc: [],
    subject: "Re: hello",
    status: "sent",
  });
  assertEquals(sent.untrusted_content, true);
  assertEquals(sent.status, "sent");
  assertEquals(sent.message_id, "m1");
});

Deno.test("a forwarded subject and every address list is neutralised", () => {
  const sent = buildSentMessageEnvelope({
    message_id: "m2",
    sent_at: "2026-08-30T12:00:00Z",
    subject: `Fwd: ${ZWNJ}${ZWNJ}${ZWNJ}Payment${RLO} details`,
    to: [{ name: `${RLO}Bo`, email: "bo@example.com" }],
    cc: [{ name: `Cy${ZWSP}`, email: "cy@example.com" }],
    bcc: [{ name: `${PDI}Dee`, email: "dee@example.com" }],
    status: "sent",
  });
  assertEquals(sent.subject, "Fwd: Payment details");
  assertEquals(sent.to, [{ name: "Bo", email: "bo@example.com" }]);
  assertEquals(sent.cc, [{ name: "Cy", email: "cy@example.com" }]);
  assertEquals(sent.bcc, [{ name: "Dee", email: "dee@example.com" }]);
});

Deno.test("an address entry with no display name survives as an empty name", () => {
  const sent = buildSentMessageEnvelope({
    message_id: "m3",
    sent_at: "2026-08-30T12:00:00Z",
    subject: "Re: hi",
    to: [{ email: "bo@example.com" } as { name?: string; email: string }],
  });
  assertEquals(sent.to, [{ name: "", email: "bo@example.com" }]);
});

Deno.test("a sent result with no address lists does not grow any", () => {
  const sent = buildSentMessageEnvelope({
    message_id: "m4",
    sent_at: "2026-08-30T12:00:00Z",
    subject: "Re: hi",
  });
  assert(!("to" in sent));
  assert(!("cc" in sent));
  assert(!("bcc" in sent));
  assertEquals(sent.untrusted_content, true);
});
