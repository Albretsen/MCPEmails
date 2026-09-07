import {
  type AttachmentManifestEntry,
  attachmentTooLargeMessage,
  parseAttachmentInputs,
  selectAttachment,
} from "./attachment-reference.ts";

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const LIMITS = { maxItems: 20, maxInlineBytes: 10 * 1024 * 1024 };

const INLINE = { filename: "a.txt", mime_type: "text/plain", data: "YWJj" };

Deno.test("parseAttachmentInputs treats an absent array as no attachments", () => {
  for (const raw of [undefined, null]) {
    const parsed = parseAttachmentInputs("email_send", raw, LIMITS);
    assert(parsed.ok, "absent attachments are accepted");
    if (!parsed.ok) return;
    assertEquals(parsed.specs.length, 0, "no specs");
    assertEquals(parsed.referenceCount, 0, "no references");
  }
});

Deno.test("parseAttachmentInputs classifies an inline attachment and sizes it", () => {
  const parsed = parseAttachmentInputs("email_send", [INLINE], LIMITS);
  assert(parsed.ok, "inline attachment is accepted");
  if (!parsed.ok) return;
  assertEquals(parsed.specs.length, 1, "one spec");
  assertEquals(parsed.specs[0].kind, "inline", "classified inline");
  assertEquals(parsed.inlineBytes, 3, "decoded size counted");
  assertEquals(parsed.referenceCount, 0, "no references");
});

Deno.test("parseAttachmentInputs classifies a reference and keeps its selector", () => {
  const parsed = parseAttachmentInputs("email_send", [
    { source_message_id: " INBOX:83122 ", attachment_index: 2 },
  ], LIMITS);
  assert(parsed.ok, "reference is accepted");
  if (!parsed.ok) return;
  const spec = parsed.specs[0];
  assertEquals(spec.kind, "reference", "classified as a reference");
  if (spec.kind !== "reference") return;
  assertEquals(spec.reference.source_message_id, "INBOX:83122", "id is trimmed");
  assertEquals(spec.reference.attachment_index, 2, "index kept");
  assertEquals(parsed.inlineBytes, 0, "a reference contributes no inline bytes");
  assertEquals(parsed.referenceCount, 1, "one reference");
});

Deno.test("parseAttachmentInputs accepts a reference with no selector", () => {
  const parsed = parseAttachmentInputs("email_send", [
    { source_message_id: "INBOX:1" },
  ], LIMITS);
  assert(parsed.ok, "a bare reference is accepted for single-attachment messages");
  if (!parsed.ok) return;
  const spec = parsed.specs[0];
  if (spec.kind !== "reference") throw new Error("expected a reference");
  assertEquals(spec.reference.attachment_index, undefined, "no index");
  assertEquals(spec.reference.filename, undefined, "no filename");
});

Deno.test("parseAttachmentInputs accepts a filename selector on a reference", () => {
  const parsed = parseAttachmentInputs("email_send", [
    { source_message_id: "INBOX:1", filename: "invoice.pdf" },
  ], LIMITS);
  assert(parsed.ok, "filename selector accepted");
  if (!parsed.ok) return;
  const spec = parsed.specs[0];
  if (spec.kind !== "reference") throw new Error("expected a reference");
  assertEquals(spec.reference.filename, "invoice.pdf", "filename kept");
});

Deno.test("parseAttachmentInputs preserves order when the two variants are mixed", () => {
  const parsed = parseAttachmentInputs("email_send", [
    { source_message_id: "INBOX:1", attachment_index: 0 },
    INLINE,
    { source_message_id: "INBOX:2", attachment_index: 1 },
  ], LIMITS);
  assert(parsed.ok, "mixing inline and referenced attachments is allowed");
  if (!parsed.ok) return;
  assertEquals(parsed.specs.map((s) => s.kind).join(","), "reference,inline,reference", "order preserved");
  assertEquals(parsed.specs.map((s) => s.position).join(","), "0,1,2", "positions preserved");
  assertEquals(parsed.referenceCount, 2, "two references");
  assertEquals(parsed.inlineBytes, 3, "only the inline entry is counted");
});

Deno.test("parseAttachmentInputs refuses an entry that is both inline and a reference", () => {
  const parsed = parseAttachmentInputs("email_send", [
    { ...INLINE, source_message_id: "INBOX:1" },
  ], LIMITS);
  assert(!parsed.ok, "an ambiguous entry is refused");
  if (parsed.ok) return;
  assertEquals(parsed.code, "-32602", "argument error");
  assert(parsed.message.includes("ambiguous"), "says why it was refused");
});

Deno.test("parseAttachmentInputs refuses a malformed reference selector", () => {
  const badIndexes = [1.5, -1, "0", null];
  for (const attachment_index of badIndexes) {
    const parsed = parseAttachmentInputs("email_send", [
      { source_message_id: "INBOX:1", attachment_index },
    ], LIMITS);
    assert(!parsed.ok, `attachment_index ${String(attachment_index)} is refused`);
    if (parsed.ok) return;
    assert(
      parsed.message.includes("attachment_index"),
      "names the offending field",
    );
  }
});

Deno.test("parseAttachmentInputs refuses an empty source_message_id", () => {
  const parsed = parseAttachmentInputs("email_send", [
    { source_message_id: "   ", attachment_index: 0 },
  ], LIMITS);
  assert(!parsed.ok, "blank source id is refused");
  if (parsed.ok) return;
  assert(parsed.message.includes("source_message_id"), "names the field");
});

Deno.test("parseAttachmentInputs refuses non-base64 inline data and points at references", () => {
  const parsed = parseAttachmentInputs("email_send", [
    { ...INLINE, data: "not base64!" },
  ], LIMITS);
  assert(!parsed.ok, "bad base64 is refused");
  if (parsed.ok) return;
  assert(
    parsed.message.includes("source_message_id"),
    "the remedy for a re-encoded file is named in the error",
  );
});

Deno.test("parseAttachmentInputs enforces the item cap and the inline byte budget", () => {
  const many = Array.from({ length: 21 }, () => INLINE);
  const capped = parseAttachmentInputs("email_send", many, LIMITS);
  assert(!capped.ok, "21 items is refused");
  if (capped.ok) return;
  assertEquals(capped.code, "-32602", "argument error");

  const overBudget = parseAttachmentInputs("email_send", [INLINE, INLINE], {
    maxItems: 20,
    maxInlineBytes: 4,
  });
  assert(!overBudget.ok, "over-budget inline bytes are refused");
  if (overBudget.ok) return;
  assertEquals(overBudget.code, "attachment_too_large", "typed size error");
  assert(overBudget.message.includes("6 bytes"), "reports the observed total");
});

Deno.test("attachmentTooLargeMessage names both the observed size and the limit", () => {
  const text = attachmentTooLargeMessage("email_send", 12, 10);
  assert(text.includes("12 bytes"), "observed size");
  assert(text.includes("10-byte"), "limit");
});

// ── selectAttachment ────────────────────────────────────────────────────────

function manifest(...names: string[]): AttachmentManifestEntry[] {
  return names.map((filename, index) => ({
    index,
    filename,
    mime_type: "application/pdf",
    size_bytes: 100 + index,
  }));
}

Deno.test("selectAttachment picks the only attachment with no selector", () => {
  const selection = selectAttachment("INBOX:1", manifest("invoice.pdf"), {});
  assert(selection.ok, "single attachment needs no selector");
  if (!selection.ok) return;
  assertEquals(selection.index, 0, "index 0");
});

Deno.test("selectAttachment refuses to guess between several attachments", () => {
  const selection = selectAttachment("INBOX:1", manifest("a.pdf", "b.pdf"), {});
  assert(!selection.ok, "ambiguous selection is refused");
  if (selection.ok) return;
  assertEquals(selection.error, "attachment_selector_required", "typed error");
  assertEquals(selection.logCode, "-32602", "argument error code");
  assertEquals(
    (selection.payload.attachments as AttachmentManifestEntry[]).length,
    2,
    "the manifest is returned so the caller can choose",
  );
});

Deno.test("selectAttachment resolves an index and rejects one out of range", () => {
  const files = manifest("a.pdf", "b.pdf");
  const ok = selectAttachment("INBOX:1", files, { attachment_index: 1 });
  assert(ok.ok && ok.index === 1, "index 1 resolves");

  const bad = selectAttachment("INBOX:1", files, { attachment_index: 2 });
  assert(!bad.ok, "index 2 is out of range");
  if (bad.ok) return;
  assertEquals(bad.error, "attachment_index_out_of_range", "typed error");
  assert(String(bad.payload.message).includes("0–1"), "names the valid range");
});

Deno.test("selectAttachment matches a filename case-insensitively", () => {
  const files = manifest("a.pdf", "Invoice.PDF");
  const ok = selectAttachment("INBOX:1", files, { filename: "invoice.pdf" });
  assert(ok.ok && ok.index === 1, "case-insensitive match");

  const missing = selectAttachment("INBOX:1", files, { filename: "nope.pdf" });
  assert(!missing.ok, "unknown filename is refused");
  if (missing.ok) return;
  assertEquals(missing.error, "attachment_not_found", "typed error");
  assertEquals(missing.logCode, "attachment_not_found", "logged under its own code");
});

Deno.test("selectAttachment prefers attachment_index when both selectors are given", () => {
  const files = manifest("a.pdf", "b.pdf");
  const selection = selectAttachment("INBOX:1", files, {
    attachment_index: 0,
    filename: "b.pdf",
  });
  assert(selection.ok && selection.index === 0, "index wins");
});

Deno.test("selectAttachment reports a message with no attachments", () => {
  const selection = selectAttachment("INBOX:1", [], { attachment_index: 0 });
  assert(!selection.ok, "refused");
  if (selection.ok) return;
  assertEquals(selection.error, "no_attachments", "typed error");
});
