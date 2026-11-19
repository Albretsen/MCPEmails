import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  attachmentsSchemaWithFileInput,
  canonicalJson,
  clientFilesCapability,
  FILES_EXTENSION_ID,
  filesExtensionEnabled,
  MISSING_CLIENT_CAPABILITY,
  type PreparedCall,
  prepareFileArguments,
  signRequestState,
  verifyRequestState,
} from "./files-extension.ts";
import { UPLOAD_SLOT_TTL_MS } from "./attachment-uploads.ts";
import { fakeStore } from "./attachment-uploads-fake.ts";

const SECRET = "x".repeat(40);
const WS = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-19T10:00:00Z");
const UPLOAD = { upload: true, download: false };

function meta(settings: unknown) {
  return { "io.modelcontextprotocol/clientCapabilities": { extensions: { [FILES_EXTENSION_ID]: settings } } };
}

function env(values: Record<string, string>) {
  return { get: (name: string) => values[name] };
}

const pdf = { id: "file-1", name: "Q3 report.pdf", mimeType: "application/pdf", size: 3 };

function baseInput(store: ReturnType<typeof fakeStore>["store"], args: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    tool: "draft_create",
    args,
    requestState: undefined as unknown,
    capability: UPLOAD,
    apiKeyId: "key-1",
    workspaceId: WS,
    store,
    secret: SECRET,
    appUrl: "https://mcpemails.com",
    now: NOW,
    ...extra,
  };
}

Deno.test("off unless switched on with a long enough secret", () => {
  assertEquals(filesExtensionEnabled(env({})), false);
  assertEquals(filesExtensionEnabled(env({ MCP_FILES_EXTENSION: "1" })), false);
  assertEquals(filesExtensionEnabled(env({ MCP_FILES_EXTENSION: "1", FILES_REQUEST_STATE_SECRET: "short" })), false);
  assertEquals(filesExtensionEnabled(env({ MCP_FILES_EXTENSION: "1", FILES_REQUEST_STATE_SECRET: SECRET })), true);
});

Deno.test("client capability is read from the request's _meta, and an unknown revision disables it", () => {
  assertEquals(clientFilesCapability(undefined), null);
  assertEquals(clientFilesCapability({}), null);
  assertEquals(clientFilesCapability(meta({})), { upload: false, download: false });
  assertEquals(clientFilesCapability(meta({ upload: {}, download: {} })), { upload: true, download: true });
  assertEquals(clientFilesCapability(meta({ upload: {}, revision: "2027-01" })), null);
});

Deno.test("the attachments schema gains a FileInput branch marked x-mcp-file", () => {
  const original = { type: "array", items: { type: "object", properties: { data: {} } }, maxItems: 20 };
  const schema = attachmentsSchemaWithFileInput(original) as { items: { anyOf: Record<string, unknown>[] }; maxItems: number };
  assertEquals(schema.maxItems, 20);
  assertEquals(schema.items.anyOf[0], original.items);
  assert("x-mcp-file" in schema.items.anyOf[1]);
  assertEquals((schema.items.anyOf[1] as { required: string[] }).required, ["id", "mimeType", "size"]);
});

Deno.test("canonical JSON ignores member order", () => {
  assertEquals(canonicalJson({ b: 1, a: [{ y: 1, x: 2 }] }), canonicalJson({ a: [{ x: 2, y: 1 }], b: 1.0 }));
});

Deno.test("a call with no FileInput passes through untouched", async () => {
  const { store } = fakeStore();
  const args = { body: "hi", attachments: [{ upload_id: "u" }] };
  assertEquals(await prepareFileArguments(baseInput(store, args)), { kind: "run", args });
});

Deno.test("an inline FileInput becomes today's inline shape", async () => {
  const { store, rows } = fakeStore();
  const out = await prepareFileArguments(baseInput(store, { body: "x", attachments: [{ ...pdf, data: "AQID" }] }));
  assertEquals(out, {
    kind: "run",
    args: { body: "x", attachments: [{ filename: "Q3 report.pdf", mime_type: "application/pdf", data: "AQID" }] },
  });
  assertEquals(rows.size, 0);
});

Deno.test("metadata is refused before any target exists", async () => {
  const { store, rows } = fakeStore();
  const code = async (attachments: unknown[]) =>
    ((await prepareFileArguments(baseInput(store, { attachments }))) as { code?: unknown }).code;
  assertEquals(await code([{ ...pdf, size: 99_000_000 }]), "-32602");
  assertEquals(await code([pdf, pdf]), "-32602");
  assertEquals(await code([{ ...pdf, data: "AQIDBA==" }]), "-32602");
  assertEquals(rows.size, 0);
});

Deno.test("out of band without the upload capability is -32021", async () => {
  const { store } = fakeStore();
  const out = await prepareFileArguments(baseInput(store, { attachments: [pdf] }, { capability: { upload: false, download: false } }));
  assertEquals(out.kind, "rpc_error");
  assertEquals((out as { code: number }).code, MISSING_CLIENT_CAPABILITY);
});

async function uploadRequired() {
  const f = fakeStore();
  const args = { body: "Report attached", attachments: [{ filename: "a.txt", mime_type: "text/plain", data: "AA==" }, pdf] };
  const out = await prepareFileArguments(baseInput(f.store, args));
  assertEquals(out.kind, "upload_required");
  const result = (out as Extract<PreparedCall, { kind: "upload_required" }>).result;
  return { ...f, args, result };
}

Deno.test("a FileInput without data gets one target and a signed requestState", async () => {
  const { result, rows } = await uploadRequired();
  assertEquals(result.resultType, "upload_required");
  assertEquals(result.uploads.length, 1);
  const [target] = result.uploads;
  assertEquals(target.fileId, "file-1");
  assertEquals(target.method, "PUT");
  assertEquals(target.credentials, "omit");
  assert(target.url.startsWith("https://"));
  assertEquals(rows.size, 1);
  const row = [...rows.values()][0];
  assertEquals(row.declared_size_bytes, 3);
  assertEquals(row.filename, "Q3 report.pdf");
  // The state cannot be read as a target, and does not carry the URL.
  assert(!result.requestState.includes("https"));
});

Deno.test("the retry runs the tool with { upload_id } once the bytes are there", async () => {
  const { store, objects, rows, args, result } = await uploadRequired();
  const row = [...rows.values()][0];
  // Before the bytes arrive: the tool does not run.
  const early = await prepareFileArguments(baseInput(store, args, { requestState: result.requestState }));
  assertEquals(early.kind, "tool_error");
  assertEquals((early as { code: string }).code, "upload_pending");
  objects.set(row.storage_path, new Uint8Array([1, 2, 3]));
  // Member order does not matter.
  const reordered = { attachments: args.attachments, body: args.body };
  const out = await prepareFileArguments(baseInput(store, reordered, { requestState: result.requestState }));
  assertEquals(out, {
    kind: "run",
    args: {
      attachments: [{ filename: "a.txt", mime_type: "text/plain", data: "AA==" }, { upload_id: row.id }],
      body: "Report attached",
    },
  });
  // Consumed: a repeated retry is refused, and so never runs the tool twice.
  const again = await prepareFileArguments(baseInput(store, args, { requestState: result.requestState }));
  assertEquals(again.kind, "rpc_error");
  assertEquals((again as { code: number }).code, -32602);
});

Deno.test("the retry is bound to the arguments, tool, principal and size", async () => {
  const { store, objects, rows, args, result } = await uploadRequired();
  const row = [...rows.values()][0];
  const rs = { requestState: result.requestState };
  const kind = async (extra: Record<string, unknown>, a: Record<string, unknown> = args) =>
    (await prepareFileArguments(baseInput(store, a, { ...rs, ...extra }))).kind;
  assertEquals(await kind({}, { ...args, body: "changed" }), "rpc_error");
  assertEquals(await kind({ tool: "email_send" }), "rpc_error");
  assertEquals(await kind({ apiKeyId: "key-2" }), "rpc_error");
  assertEquals(await kind({ requestState: result.requestState + "x" }), "rpc_error");
  assertEquals(await kind({ now: new Date(NOW.getTime() + UPLOAD_SLOT_TTL_MS + 11 * 60 * 1000) }), "rpc_error");
  objects.set(row.storage_path, new Uint8Array([1, 2, 3, 4]));
  const out = await prepareFileArguments(baseInput(store, args, rs));
  assertEquals((out as { code: string }).code, "upload_size_mismatch");
});

Deno.test("requestState verification rejects forgeries and expiry", async () => {
  const claims = { v: 1 as const, k: "k", t: "t", h: "h", f: {}, e: NOW.getTime() + 1000, u: true as const };
  const token = await signRequestState(claims, SECRET);
  assertEquals(await verifyRequestState(token, SECRET, NOW.getTime()), claims);
  assertEquals(await verifyRequestState(token, "y".repeat(40), NOW.getTime()), null);
  assertEquals(await verifyRequestState(token, SECRET, NOW.getTime() + 1000), null);
  assertEquals(await verifyRequestState("a.b.c", SECRET, NOW.getTime()), null);
  assertEquals(await verifyRequestState(null, SECRET, NOW.getTime()), null);
});
