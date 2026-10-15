// ---------------------------------------------------------------------------
// What a draft rebuild keeps, against REAL MIME (review round, 2026-10-13).
//
// `mcp-app-drafts.test.ts` drives the partial write with a fake `updateDraft`
// and asserts on what the fake was handed. That proves the merge and proves
// nothing about the message that ends up stored, which is where the losses
// were: the claim "the stored body is kept" was true of the parameters and
// false of the MIME for any stored message that was not a simple one.
//
// So this file goes the whole way round, over the server's own functions:
//
//   raw message
//     -> draftContentFromRaw      (index.ts: what imapGetDraft and Gmail's
//                                  editor reader both end in)
//     -> applyDraftPatch          (mcp-app-drafts.ts: the shared partial write)
//     -> draftMimeFor             (index.ts: what imapUpdateDraft and
//                                  gmailUpdateDraft both store)
//     -> parseEmail               (the stored result, read back)
//
// Nothing between the two raw messages is mocked. The "mailbox" is one
// variable holding the stored bytes.
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  carriableReplyTo,
  draftReadStatusMeansMissing,
  draftRebuildBlockers,
  draftRebuildBlockersOf,
  outlookRecipientPatch,
} from "./draft-rebuild.ts";
import { getHeader, mimeLeafParts, parseEmail } from "./mime.ts";
import { signatureImageCid } from "./signature-images.ts";
import {
  applyDraftPatch,
  type DraftEditorProviderInbox,
  type DraftPatch,
  type DraftPatchResult,
  runBodylessDraftUpdate,
} from "./mcp-app-drafts.ts";

// See tool-surface.test.ts for why the environment is set before a dynamic import.
Deno.env.set("MCP_INTROSPECTION_ONLY", "1");
Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
const { draftContentFromRaw, draftMimeFor } = await import("./index.ts");

const CRLF = "\r\n";
const lines = (...parts: string[]) => parts.join(CRLF);

/** A string's UTF-8 octets as a byte string, which is what the readers hand over. */
function bytes(text: string): string {
  return Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join("");
}

const IMAP_INBOX: DraftEditorProviderInbox = {
  id: "8f1f2a3c-0000-4000-8000-000000000001",
  email_address: "you@example.com",
  display_name: "Asgeir",
  provider: "imap",
  service: null,
  // A signature is configured, so a path that applied one would show it.
  signature_enabled: true,
  signature_text: "--\nAsgeir, MCP Emails",
};

/** One stored message and the real read/write pair over it. */
function mailbox(initial: string) {
  let stored = initial;
  let writes = 0;
  const deps = {
    getDraft: (_inbox: DraftEditorProviderInbox, _id: string) =>
      Promise.resolve(draftContentFromRaw(stored, undefined)),
    updateDraft: (
      _inbox: DraftEditorProviderInbox,
      draftId: string,
      params: Parameters<typeof draftMimeFor>[1],
    ) => {
      stored = draftMimeFor("Asgeir <you@example.com>", params, "rebuilt-1");
      writes++;
      return Promise.resolve({ draft_id: `${draftId}+1` });
    },
  };
  return {
    deps,
    raw: () => stored,
    writes: () => writes,
    patch: (patch: DraftPatch): Promise<DraftPatchResult> =>
      applyDraftPatch(deps, IMAP_INBOX, "Drafts:2", patch),
  };
}

// ── Fixtures: messages as other mail clients store them ────────────────────

const BODY_TEXT = "Hei Åse,\r\n\r\nTakk for sist. Prisen er 1 250 kr.  \r\n\r\n-- \r\nAsgeir, MCP Emails\r\n";
const BODY_HTML = '<div dir="ltr">Hei <b>Åse</b>,<br><br>Takk for sist. Prisen er 1&nbsp;250 kr.</div>';

function quotedPrintable(text: string): string {
  return Array.from(new TextEncoder().encode(text), (b) => {
    if (b === 0x0d || b === 0x0a) return String.fromCharCode(b);
    return b === 0x3d || b > 0x7e || b < 0x20
      ? `=${b.toString(16).toUpperCase().padStart(2, "0")}`
      : String.fromCharCode(b);
  }).join("");
}

/** multipart/alternative, quoted-printable, with a Reply-To and threading. */
const SIMPLE_ALTERNATIVE = lines(
  "From: Asgeir <you@example.com>",
  "To: =?UTF-8?B?w4VzZQ==?= <ase@example.com>, Ola Nordmann <ola@example.com>",
  "Cc: regnskap@example.com",
  "Bcc: arkiv@example.com",
  "Subject: =?UTF-8?Q?Re:_Tilbud_p=C3=A5_levering?=",
  "Date: Mon, 12 Oct 2026 09:00:00 +0200",
  "Message-ID: <original-draft@client.example>",
  "Reply-To: Salg <salg@example.com>",
  "In-Reply-To: <inquiry-77@customer.example>",
  "References: <root-1@customer.example> <inquiry-77@customer.example>",
  "X-Priority: 1",
  "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="alt1"',
  "",
  "--alt1",
  "Content-Type: text/plain; charset=UTF-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  quotedPrintable(BODY_TEXT),
  "--alt1",
  "Content-Type: text/html; charset=UTF-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  quotedPrintable(BODY_HTML),
  "--alt1--",
  "",
);

function withParts(topType: string, boundary: string, parts: string[], headers: string[] = []): string {
  return lines(
    "From: Asgeir <you@example.com>",
    "To: ase@example.com",
    "Subject: Plan",
    ...headers,
    "MIME-Version: 1.0",
    `Content-Type: ${topType}; boundary="${boundary}"`,
    "",
    ...parts.flatMap((part) => [`--${boundary}`, part]),
    `--${boundary}--`,
    "",
  );
}

const PLAIN_PART = lines("Content-Type: text/plain; charset=UTF-8", "", "First part.");
const HTML_PART = lines("Content-Type: text/html; charset=UTF-8", "", '<p>First part.</p><img src="cid:logo@x">');

const INLINE_IMAGE = withParts("multipart/related", "rel1", [
  HTML_PART,
  lines(
    "Content-Type: image/png",
    "Content-Transfer-Encoding: base64",
    "Content-ID: <logo@x>",
    "Content-Disposition: inline",
    "",
    "iVBORw0KGgo=",
  ),
]);

const SECOND_TEXT_PART = withParts("multipart/mixed", "mix1", [
  PLAIN_PART,
  lines("Content-Type: text/plain; charset=UTF-8", "", "A second inline text part, shown below the first."),
]);

const CALENDAR_ALTERNATIVE = withParts("multipart/alternative", "cal1", [
  PLAIN_PART,
  lines("Content-Type: text/html; charset=UTF-8", "", "<p>First part.</p>"),
  lines("Content-Type: text/calendar; method=REQUEST; charset=UTF-8", "", "BEGIN:VCALENDAR", "END:VCALENDAR"),
]);

const FLOWED = lines(
  "From: Asgeir <you@example.com>",
  "To: ase@example.com",
  "Subject: Flowed",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=UTF-8; format=flowed",
  "",
  "A paragraph that the composing client soft-wrapped with a trailing space ",
  "so that the reader may re-flow it to the window width.",
  "",
);

const NAMED_ATTACHMENT = withParts("multipart/mixed", "att1", [
  PLAIN_PART,
  lines(
    'Content-Type: application/pdf; name="q3.pdf"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="q3.pdf"',
    "",
    "JVBERi0xLjQK",
  ),
]);

const NO_SUBJECT = lines(
  "From: Asgeir <you@example.com>",
  "To: ase@example.com",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=UTF-8",
  "",
  "No subject yet.",
  "",
);

// ═══════════════════════════════════════════════════════════════════════════
// 1. The round trip that must hold
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("round trip: a subject-only patch keeps the body text, the HTML, Reply-To and the thread", async () => {
  const box = mailbox(bytes(SIMPLE_ALTERNATIVE));
  const before = parseEmail(box.raw());
  assertEquals(before.text, BODY_TEXT, "the fixture decodes to the text it was built from");
  assertEquals(before.html, BODY_HTML);
  assertEquals(draftRebuildBlockers(box.raw()), [], "one text/plain and one text/html: rebuildable");

  const out = await box.patch({ subject: "Re: Tilbud på levering (oppdatert)" });
  assert(out.ok, JSON.stringify(out));
  assertEquals(box.writes(), 1);

  const after = parseEmail(box.raw());
  const h = after.headers;
  // KEPT: the decoded body text, character for character, line endings and
  // trailing whitespace included, and the HTML string.
  assertEquals(after.text, BODY_TEXT);
  assertEquals(after.html, BODY_HTML);
  // NO SIGNATURE APPLIED: the inbox has one configured and the stored text
  // already ends in it. Exactly one copy after the write.
  assertEquals(after.text!.split("Asgeir, MCP Emails").length - 1, 1);
  // KEPT: who it goes to, who a reply goes to, and where it sits in the thread.
  const reread = draftContentFromRaw(box.raw(), undefined);
  assertEquals(reread.to, ["Åse <ase@example.com>", "Ola Nordmann <ola@example.com>"]);
  assertEquals(reread.cc, ["regnskap@example.com"]);
  assertEquals(reread.bcc, ["arkiv@example.com"]);
  assertEquals(getHeader(h, "reply-to"), "Salg <salg@example.com>");
  assertEquals(getHeader(h, "in-reply-to"), "<inquiry-77@customer.example>");
  assertEquals(
    getHeader(h, "references"),
    "<root-1@customer.example> <inquiry-77@customer.example>",
  );
  // CHANGED: the one field the patch named.
  assertEquals(reread.subject, "Re: Tilbud på levering (oppdatert)");
  // And still rebuildable: a second patch can run over the result.
  assertEquals(draftRebuildBlockers(box.raw()), []);
  assertEquals(reread.rebuildBlockers, []);
});

Deno.test("round trip: what is NOT kept is stated, so no description may say 'exactly'", async () => {
  // The honest half of the test above. A rebuild is a new message: these are
  // the losses that remain after the review, and they are why the `draft` and
  // `draft_editor_save` descriptions say the stored body text is kept and not
  // that the draft is kept exactly. If one of these starts being preserved,
  // this test fails and the wording can be tightened.
  const box = mailbox(bytes(SIMPLE_ALTERNATIVE));
  await box.patch({ subject: "x" });
  const h = parseEmail(box.raw()).headers;
  assertEquals(getHeader(h, "x-priority"), null, "headers outside the carried set are dropped");
  assertEquals(getHeader(h, "message-id"), "<rebuilt-1@mcpemails.com>", "a new Message-ID");
  assert(getHeader(h, "date") !== "Mon, 12 Oct 2026 09:00:00 +0200", "a new Date");
  // The parts are re-encoded: same text, different octets on the wire.
  assert(box.raw().includes("Content-Transfer-Encoding: base64"));
  assert(!box.raw().includes("quoted-printable"));

  const { TOOL_REGISTRY } = await import("./index.ts");
  for (const name of ["draft", "draft_editor_save"]) {
    const tool = TOOL_REGISTRY.find((t: { name: string }) => t.name === name)!;
    assert(!/exactly/.test(tool.description), `${name} must not promise an exact copy`);
  }
});

Deno.test("round trip: a body edit through the same path replaces both parts and still keeps the headers", async () => {
  // The card's save. Not the subject of the review, but the same rebuild.
  const box = mailbox(bytes(SIMPLE_ALTERNATIVE));
  const out = await box.patch({ bodyText: "Ny tekst.\n" });
  assert(out.ok);
  const after = parseEmail(box.raw());
  assertEquals(after.text, "Ny tekst.\n");
  assert(after.html !== BODY_HTML && after.html!.includes("Ny tekst."), "HTML regenerated from the text");
  assertEquals(getHeader(after.headers, "reply-to"), "Salg <salg@example.com>");
  assertEquals(draftContentFromRaw(box.raw(), undefined).subject, "Re: Tilbud på levering");
});

Deno.test("round trip: a draft with no Subject header does not acquire the subject '(no subject)'", async () => {
  const box = mailbox(bytes(NO_SUBJECT));
  const textBefore = parseEmail(box.raw()).text;
  const read = draftContentFromRaw(box.raw(), undefined);
  assertEquals(read.subjectAbsent, true);
  assertEquals(read.subject, "(no subject)", "the display placeholder the list view shows");

  const out = await box.patch({ to: ["ola@example.com"] });
  assert(out.ok);
  if (out.ok) assertEquals(out.saved.subject, "");
  assert(!box.raw().includes("(no subject)"), "the placeholder was not written into the message");
  const after = draftContentFromRaw(box.raw(), undefined);
  assertEquals(getHeader(parseEmail(box.raw()).headers, "subject"), "");
  assertEquals(after.to, ["ola@example.com"]);
  assertEquals(parseEmail(box.raw()).text, textBefore, "and the body text is what it was");
  assert(textBefore!.startsWith("No subject yet."));
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The messages a rebuild cannot represent: refused, and nothing changes
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("refused, byte for byte unchanged: every stored shape the rebuild would lose something from", async () => {
  const cases: Array<[string, string, string[]]> = [
    ["an inline image with a Content-ID and no filename", INLINE_IMAGE, ["an inline image/png part"]],
    ["a second inline text part", SECOND_TEXT_PART, ["a second text/plain part"]],
    ["a text/calendar alternative", CALENDAR_ALTERNATIVE, ["a text/calendar part"]],
    ["format=flowed text", FLOWED, ["a format=flowed text part"]],
  ];
  for (const [label, message, expected] of cases) {
    const raw = bytes(message);
    // The premise: none of these is an "attachment" to the parser, so the old
    // attachments-only guard let every one of them through.
    assertEquals(parseEmail(raw).attachments.length, 0, `${label}: not an attachment`);
    assertEquals(draftRebuildBlockers(raw), expected, label);

    const box = mailbox(raw);
    const out = await box.patch({ subject: "Changed" });
    assertEquals(out, { ok: false, kind: "not_rebuildable", parts: expected }, label);
    assertEquals(box.writes(), 0, `${label}: nothing written`);
    assertEquals(box.raw(), raw, `${label}: the stored message is untouched`);

    // The same refusal through the `draft` tool's body-less path.
    const viaTool = await runBodylessDraftUpdate(
      {
        ...box.deps,
        appUrl: "https://mcpemails.com",
        workspaceGate: () => Promise.resolve({ rolledOut: true, hidden: false }),
        inboxHidden: () => Promise.resolve(false),
      },
      { workspace_id: "w-1", scopes: ["manage:drafts", "read:email"] },
      IMAP_INBOX,
      "Drafts:2",
      { subject: "Changed" },
    );
    assertEquals(viaTool, { ok: false, kind: "not_rebuildable", parts: expected }, label);
    assertEquals(box.raw(), raw, `${label}: still untouched`);
  }
});

Deno.test("a named attachment keeps its own, older refusal", async () => {
  const raw = bytes(NAMED_ATTACHMENT);
  assertEquals(draftRebuildBlockers(raw), [], "attachments are not listed as blockers");
  const box = mailbox(raw);
  assertEquals(await box.patch({ subject: "x" }), {
    ok: false,
    kind: "has_attachments",
    attachmentCount: 1,
  });
  assertEquals(box.raw(), raw);
});

Deno.test("a Reply-To that cannot be written back verbatim is a refusal, not a silent drop", async () => {
  const raw = bytes(SIMPLE_ALTERNATIVE.replace("Reply-To: Salg <salg@example.com>", "Reply-To: Åse <ase@example.com>"));
  const read = draftContentFromRaw(raw, undefined);
  assertEquals(read.replyTo, undefined);
  assertEquals(read.rebuildBlockers, ["a Reply-To header that cannot be rewritten"]);
  const box = mailbox(raw);
  const out = await box.patch({ subject: "x" });
  assert(!out.ok && out.kind === "not_rebuildable");
  assertEquals(box.raw(), raw);

  assertEquals(carriableReplyTo(null), undefined, "no header at all");
  assertEquals(carriableReplyTo("  "), undefined);
  assertEquals(carriableReplyTo("a@example.com"), "a@example.com");
  assertEquals(carriableReplyTo("=?UTF-8?B?w4VzZQ==?= <ase@example.com>"), "=?UTF-8?B?w4VzZQ==?= <ase@example.com>");
  assertEquals(carriableReplyTo("Åse <ase@example.com>"), null);
});

Deno.test("mimeLeafParts agrees with parseEmail on what an attachment is, and sees what it drops", () => {
  const leaves = mimeLeafParts(bytes(INLINE_IMAGE));
  assertEquals(leaves, [
    { mediaType: "text/html", attachment: false, flowed: false },
    { mediaType: "image/png", attachment: false, flowed: false, contentId: "logo@x" },
  ]);
  assertEquals(
    mimeLeafParts(bytes(NAMED_ATTACHMENT)).map((l) => [l.mediaType, l.attachment]),
    [["text/plain", false], ["application/pdf", true]],
  );
  assertEquals(mimeLeafParts(bytes(FLOWED)), [{ mediaType: "text/plain", attachment: false, flowed: true }]);
  // A multipart with no boundary is one opaque leaf rather than nothing.
  const broken = lines("Subject: x", "Content-Type: multipart/mixed", "", "body", "");
  assertEquals(draftRebuildBlockers(bytes(broken)), ["a multipart/mixed part"]);
  // No Content-Type at all is text/plain, as the parser reads it.
  assertEquals(draftRebuildBlockers(bytes(lines("Subject: x", "", "hello"))), []);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Outlook: an explicitly supplied empty list clears; an unsupplied one does not
// ═══════════════════════════════════════════════════════════════════════════

const asGraph = (address: string) => ({ emailAddress: { address } });

Deno.test("outlook PATCH: `cc: []` from the caller is sent as [] and so removes the address", () => {
  // Before: every empty list was omitted, Graph kept the stored value, the
  // call reported success, and Send delivered to the person who was removed.
  assertEquals(
    outlookRecipientPatch(
      { to: ["a@example.com"], cc: [], bcc: [], explicitRecipients: { cc: true } },
      asGraph,
    ),
    { toRecipients: [asGraph("a@example.com")], ccRecipients: [] },
  );
  assertEquals(
    outlookRecipientPatch(
      { to: [], cc: [], bcc: [], explicitRecipients: { to: true, cc: true, bcc: true } },
      asGraph,
    ),
    { toRecipients: [], ccRecipients: [], bccRecipients: [] },
  );
});

Deno.test("outlook PATCH: an empty list the caller did NOT supply is omitted, so Graph keeps what is stored", () => {
  // The full-body update when its (non-fatal) read of the stored draft failed:
  // every list is empty and none was supplied. Sending [] here would wipe the
  // draft's recipients on a call that only changed the body.
  assertEquals(outlookRecipientPatch({ to: [], cc: [], bcc: [] }, asGraph), {});
  assertEquals(
    outlookRecipientPatch(
      { to: [], cc: [], bcc: [], explicitRecipients: { to: false, cc: false, bcc: false } },
      asGraph,
    ),
    {},
  );
  // A non-empty list is sent whether or not it was supplied, as it always was.
  assertEquals(
    outlookRecipientPatch({ to: ["a@example.com"], cc: ["c@example.com"], bcc: [] }, asGraph),
    { toRecipients: [asGraph("a@example.com")], ccRecipients: [asGraph("c@example.com")] },
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. A failed read is not a missing draft
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("only 404 and a malformed-id 400 mean 'no such draft'; throttling and server errors do not", () => {
  assertEquals(draftReadStatusMeansMissing(404), true);
  assertEquals(draftReadStatusMeansMissing(400), true);
  for (const status of [403, 408, 409, 429, 500, 502, 503, 504]) {
    assertEquals(draftReadStatusMeansMissing(status), false, String(status));
  }
});

Deno.test("both editor readers route every non-OK status through that one decision", () => {
  // The readers need a live token, so they cannot be called here. What CAN be
  // held is that neither has a bare `return null` on `!resp.ok` any more: the
  // only null inside that branch is behind draftReadStatusMeansMissing, and
  // the branch ends in a throw.
  const source = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  for (const [name, next] of [
    ["async function gmailGetDraftForEditor(", "async function gmailCreateDraft("],
    ["async function outlookGetDraftForEditor(", "async function outlookCreateDraft("],
  ]) {
    const fn = source.slice(source.indexOf(name), source.indexOf(next));
    const branch = fn.slice(fn.indexOf("if (!resp.ok) {"), fn.indexOf("const data ="));
    assert(branch.length > 0, `${name} has no non-OK branch`);
    assertEquals(branch.match(/draftReadStatusMeansMissing\(resp\.status\)/g)?.length, 1, name);
    assertEquals(branch.match(/return null/g)?.length, 1, `${name}: exactly one null, the guarded one`);
    assert(/throw /.test(branch.slice(branch.indexOf("return null"))), `${name} must throw otherwise`);
  }
});

Deno.test("our own embedded signature image is no rebuild blocker; anyone else's inline image is", () => {
  // signature-images.ts writes the logo as an inline part under a Content-ID
  // it can reverse, and the transport re-attaches it from the `cid:` on every
  // rebuild. Refusing on it would refuse every save of such a draft.
  const ours = signatureImageCid("https://cdn.example.com/logo.png");
  const leaf = (contentId: string) => ({ mediaType: "image/png", attachment: false, flowed: false, contentId });
  const html = { mediaType: "text/html", attachment: false, flowed: false };
  assertEquals(draftRebuildBlockersOf([html, leaf(ours)]), []);
  assertEquals(draftRebuildBlockersOf([html, leaf("logo@x")]), ["an inline image/png part"]);
  assertEquals(
    draftRebuildBlockersOf([html, { mediaType: "image/png", attachment: false, flowed: false }]),
    ["an inline image/png part"],
    "no Content-ID at all",
  );
});
