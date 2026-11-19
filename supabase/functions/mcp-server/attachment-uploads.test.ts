import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  cleanMediaType,
  cleanUploadFilename,
  issueUploadSlot,
  parseUploadSlotRequest,
  purgeExpiredUploads,
  resolveUploadedAttachment,
  UPLOAD_MAX_BYTES,
  UPLOAD_SLOT_TTL_MS,
  UploadSlotError,
  uploadPageUrl,
} from "./attachment-uploads.ts";
import { parseAttachmentInputs } from "./attachment-reference.ts";
import { fakeStore } from "./attachment-uploads-fake.ts";

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";

const NOW = new Date("2026-11-19T10:00:00Z");

async function issued(declared: number | null = null) {
  const f = fakeStore();
  const slot = await issueUploadSlot(f.store, {
    workspaceId: WS,
    apiKeyId: "key-1",
    inboxId: null,
    request: { filename: "contract.pdf", mime_type: "application/pdf", size_bytes: declared },
    appUrl: "https://mcpemails.com/",
    now: NOW,
    id: ID,
  });
  return { ...f, slot };
}

Deno.test("a slot is a row first, then a signed URL, and lives two hours", async () => {
  const { slot, rows } = await issued(5);
  assertEquals(slot.upload_id, ID);
  assertEquals(slot.expires_at, new Date(NOW.getTime() + UPLOAD_SLOT_TTL_MS).toISOString());
  const row = rows.get(ID)!;
  assertEquals(row.storage_path, `${WS}/${ID}`);
  assertEquals(row.declared_size_bytes, 5);
  assert(slot.put_url.startsWith("https://"));
});

Deno.test("the page link carries the signed URL in the fragment only", async () => {
  const { slot } = await issued();
  const url = new URL(slot.page_url);
  assertEquals(url.origin + url.pathname, "https://mcpemails.com/upload");
  assertEquals(url.search, "");
  const fragment = new URLSearchParams(url.hash.slice(1));
  const token = fragment.get("t")!.replace(/-/g, "+").replace(/_/g, "/");
  assertEquals(atob(token + "=".repeat((4 - token.length % 4) % 4)), slot.put_url);
  assertEquals(fragment.get("n"), "contract.pdf");
  assert(!slot.page_url.split("#")[0].includes("token"));
});

Deno.test("uploadPageUrl encodes non-ASCII names", () => {
  const url = uploadPageUrl("https://mcpemails.com", {
    put_url: "https://x/y?token=å",
    filename: "fakturå #1.pdf",
    size_bytes: 10,
    expires_at: "2026-11-19T12:00:00.000Z",
  });
  const fragment = new URLSearchParams(new URL(url).hash.slice(1));
  assertEquals(fragment.get("n"), "fakturå #1.pdf");
  assertEquals(fragment.get("s"), "10");
});

Deno.test("an uploaded file resolves to base64 with the slot's name and type", async () => {
  const { store, objects, rows } = await issued(3);
  objects.set(`${WS}/${ID}`, new Uint8Array([1, 2, 3]));
  const file = await resolveUploadedAttachment(store, { workspaceId: WS, uploadId: ID, budgetBytes: 100, now: NOW });
  assertEquals(file, { filename: "contract.pdf", mime_type: "application/pdf", data: "AQID", size_bytes: 3 });
  assertEquals(rows.get(ID)!.consumed_at, NOW.toISOString());
  // Usable again within its life, e.g. a retried call.
  await resolveUploadedAttachment(store, { workspaceId: WS, uploadId: ID, budgetBytes: 100, now: NOW });
});

Deno.test("another workspace's slot answers exactly like a missing one", async () => {
  const { store, objects } = await issued();
  objects.set(`${WS}/${ID}`, new Uint8Array([1]));
  const other = await assertRejects(
    () => resolveUploadedAttachment(store, { workspaceId: OTHER_WS, uploadId: ID, budgetBytes: 100, now: NOW }),
    UploadSlotError,
  );
  const missing = await assertRejects(
    () =>
      resolveUploadedAttachment(store, {
        workspaceId: OTHER_WS,
        uploadId: "44444444-4444-4444-8444-444444444444",
        budgetBytes: 100,
        now: NOW,
      }),
    UploadSlotError,
  );
  assertEquals(other.code, "upload_not_found");
  assertEquals(missing.code, "upload_not_found");
  assertEquals(other.message.replace(ID, "X"), missing.message.replace("44444444-4444-4444-8444-444444444444", "X"));
});

Deno.test("refusals: not uploaded, expired, wrong size, over budget, not an id", async () => {
  const code = async (fn: () => Promise<unknown>) => (await assertRejects(fn, UploadSlotError)).code;
  const a = await issued(4);
  assertEquals(
    await code(() => resolveUploadedAttachment(a.store, { workspaceId: WS, uploadId: ID, budgetBytes: 100, now: NOW })),
    "upload_pending",
  );
  a.objects.set(`${WS}/${ID}`, new Uint8Array([1, 2, 3]));
  assertEquals(
    await code(() => resolveUploadedAttachment(a.store, { workspaceId: WS, uploadId: ID, budgetBytes: 100, now: NOW })),
    "upload_size_mismatch",
  );
  const b = await issued();
  b.objects.set(`${WS}/${ID}`, new Uint8Array(50));
  assertEquals(
    await code(() => resolveUploadedAttachment(b.store, { workspaceId: WS, uploadId: ID, budgetBytes: 10, now: NOW })),
    "attachment_too_large",
  );
  const later = new Date(NOW.getTime() + UPLOAD_SLOT_TTL_MS);
  assertEquals(
    await code(() => resolveUploadedAttachment(b.store, { workspaceId: WS, uploadId: ID, budgetBytes: 100, now: later })),
    "upload_expired",
  );
  assertEquals(
    await code(() => resolveUploadedAttachment(b.store, { workspaceId: WS, uploadId: "../etc", budgetBytes: 100, now: NOW })),
    "upload_not_found",
  );
});

Deno.test("the purge removes expired objects, then their rows", async () => {
  const { store, rows, objects, removed } = await issued();
  objects.set(`${WS}/${ID}`, new Uint8Array([1]));
  assertEquals(await purgeExpiredUploads(store, NOW), 0);
  assertEquals(await purgeExpiredUploads(store, new Date(NOW.getTime() + UPLOAD_SLOT_TTL_MS + 1)), 1);
  assertEquals(removed, [`${WS}/${ID}`]);
  assertEquals(rows.size, 0);
});

Deno.test("parseUploadSlotRequest: names, types and sizes", () => {
  const ok = parseUploadSlotRequest("t", { filename: "C:\\Users\\me\\Q3 report.pdf", mime_type: "Application/PDF", size_bytes: 12 });
  assertEquals(ok, { ok: true, request: { filename: "Q3 report.pdf", mime_type: "application/pdf", size_bytes: 12 } });
  assertEquals(parseUploadSlotRequest("t", { filename: "a", mime_type: "text/html; charset=x" }), {
    ok: true,
    request: { filename: "a", mime_type: "application/octet-stream", size_bytes: null },
  });
  assertEquals(parseUploadSlotRequest("t", { filename: ".." }).ok, false);
  assertEquals(parseUploadSlotRequest("t", {}).ok, false);
  assertEquals(parseUploadSlotRequest("t", { filename: "a", size_bytes: -1 }).ok, false);
  assertEquals(parseUploadSlotRequest("t", { filename: "a", size_bytes: UPLOAD_MAX_BYTES + 1 }).ok, false);
  assertEquals(cleanUploadFilename("in\u202Evoice.pdf"), "invoice.pdf");
  assertEquals(cleanMediaType(undefined), "application/octet-stream");
});

Deno.test("attachments[] takes { upload_id } as a third shape, alone", () => {
  const limits = { maxItems: 20, maxInlineBytes: 100 };
  const parsed = parseAttachmentInputs("email_send", [{ upload_id: ` ${ID} ` }], limits);
  assert(parsed.ok);
  assertEquals(parsed.specs, [{ kind: "upload", position: 0, upload_id: ID }]);
  assertEquals(parsed.referenceCount, 1);
  const mixed = parseAttachmentInputs("email_send", [{ upload_id: ID, data: "AA==" }], limits);
  assert(!mixed.ok);
  assert(mixed.message.includes("ambiguous"));
  const withRef = parseAttachmentInputs("email_send", [{ upload_id: ID, source_message_id: "INBOX:1" }], limits);
  assert(!withRef.ok);
  const blank = parseAttachmentInputs("email_send", [{ upload_id: "" }], limits);
  assert(!blank.ok);
});
