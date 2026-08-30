// ---------------------------------------------------------------------------
// The download paths must never emit an EmbeddedResource carrying `blob`.
//
// A blob resource is dropped by the re-serialisation between this server and the
// model, arriving with `text` undefined, `blob` undefined and `_meta` null. That
// matches no branch of the MCP content union, so the client rejects the ENTIRE
// tool result with -32602: a successful 25 MB download reaches the agent as a
// malformed-arguments error, with no partial result to fall back on.
//
// The last assertion in this file is therefore the one that matters most. It is
// not checking a formatting detail; it is the regression guard for the whole
// class of bug, and it should outlive any particular arrangement of the blocks.
// ---------------------------------------------------------------------------

import { assertEquals } from "jsr:@std/assert@1";
import {
  base64ToUtf8,
  downloadContentBlocks,
  exceedsInlineBudget,
  type DownloadPayload,
} from "./download-content-blocks.ts";

/** base64 of "hello" (5 bytes). */
const HELLO = "aGVsbG8=";
/** base64 of the two bytes 0xFF 0xD8, a JPEG SOI marker: valid bytes, invalid UTF-8. */
const BINARY = "/9g=";

function payload(mimeType: string, data = HELLO): DownloadPayload {
  return {
    uri: "mcpemails://inbox/i1/message/m1/attachment/0/file",
    filename: "file",
    mimeType,
    data,
  };
}

function meta(mimeType: string, data = HELLO): Record<string, unknown> {
  return {
    message_id: "m1",
    inbox_id: "i1",
    attachment_index: 0,
    total_attachments: 1,
    filename: "file",
    mime_type: mimeType,
    size_bytes: 5,
    data,
  };
}

/** Walk an arbitrary result value and collect every object key it contains. */
function everyKey(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) everyKey(item, into);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      everyKey(child, into);
    }
  }
  return into;
}

Deno.test("image/* returns a native image block", () => {
  const blocks = downloadContentBlocks(payload("image/png"), meta("image/png"));
  assertEquals(blocks.length, 2, "image block plus the structuredContent mirror");
  assertEquals(blocks[0]["type"], "image", "first block is ImageContent");
  assertEquals(blocks[0]["data"], HELLO, "image carries the base64 inline");
  assertEquals(blocks[0]["mimeType"], "image/png", "image reports its type");
});

Deno.test("audio/* returns a native audio block", () => {
  const blocks = downloadContentBlocks(payload("audio/mpeg"), meta("audio/mpeg"));
  assertEquals(blocks.length, 2, "audio block plus the structuredContent mirror");
  assertEquals(blocks[0]["type"], "audio", "first block is AudioContent");
  assertEquals(blocks[0]["data"], HELLO, "audio carries the base64 inline");
});

Deno.test("text/* returns an embedded resource with decoded text", () => {
  const blocks = downloadContentBlocks(payload("text/plain"), meta("text/plain"));
  assertEquals(blocks.length, 2, "resource block plus the structuredContent mirror");
  assertEquals(blocks[0]["type"], "resource", "first block is an EmbeddedResource");
  const resource = blocks[0]["resource"] as Record<string, unknown>;
  assertEquals(resource["text"], "hello", "text is decoded, not left as base64");
  assertEquals(resource["uri"], payload("text/plain").uri, "resource keeps its identifier");
  assertEquals(resource["name"], "file", "resource keeps the filename");
  assertEquals("blob" in resource, false, "the working branch never used blob either");
});

Deno.test("the MIME match is case-insensitive", () => {
  const blocks = downloadContentBlocks(payload("IMAGE/PNG"), meta("IMAGE/PNG"));
  assertEquals(blocks[0]["type"], "image", "an uppercase type still resolves");
});

Deno.test("application/pdf emits no resource block, and keeps the base64", () => {
  const blocks = downloadContentBlocks(payload("application/pdf", BINARY), meta("application/pdf", BINARY));
  assertEquals(blocks.length, 1, "only the structuredContent mirror survives");
  assertEquals(blocks[0]["type"], "text", "the mirror is a plain text block");
  const mirrored = JSON.parse(blocks[0]["text"] as string) as Record<string, unknown>;
  assertEquals(mirrored["data"], BINARY, "the bytes are still in the payload");
  assertEquals(mirrored["filename"], "file", "filename survives");
  assertEquals(mirrored["mime_type"], "application/pdf", "mime_type survives");
  assertEquals(mirrored["size_bytes"], 5, "size_bytes survives");
  assertEquals(mirrored["attachment_index"], 0, "attachment_index survives");
});

Deno.test("application/octet-stream emits no resource block, and keeps the base64", () => {
  const mt = "application/octet-stream";
  const blocks = downloadContentBlocks(payload(mt, BINARY), meta(mt, BINARY));
  assertEquals(blocks.length, 1, "only the structuredContent mirror survives");
  const mirrored = JSON.parse(blocks[0]["text"] as string) as Record<string, unknown>;
  assertEquals(mirrored["data"], BINARY, "the bytes are still in the payload");
});

Deno.test("the .eml carries its bytes and its sha256", () => {
  const emlMeta = {
    message_id: "m1",
    inbox_id: "i1",
    provider: "imap",
    filename: "original-message.eml",
    mime_type: "message/rfc822",
    size_bytes: 5,
    sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    content_disposition: "attachment",
    data: HELLO,
  };
  const blocks = downloadContentBlocks(
    {
      uri: "mcpemails://inbox/i1/message/m1/original.eml",
      filename: "original-message.eml",
      mimeType: "message/rfc822",
      data: HELLO,
    },
    emlMeta,
  );
  // message/rfc822 is not text/*, so it takes the binary branch: no resource.
  assertEquals(blocks.length, 1, "the .eml ships in the mirror alone");
  const mirrored = JSON.parse(blocks[0]["text"] as string) as Record<string, unknown>;
  assertEquals(mirrored["data"], HELLO, "the .eml bytes survive");
  assertEquals(mirrored["sha256"], emlMeta.sha256, "integrity check survives with them");
  assertEquals(mirrored["size_bytes"], 5, "declared size survives");
  assertEquals(mirrored["provider"], "imap", "provenance survives");
});

Deno.test("base64ToUtf8 decodes text and does not throw on non-UTF-8 bytes", () => {
  assertEquals(base64ToUtf8(HELLO), "hello", "plain ASCII");
  assertEquals(base64ToUtf8("w6k="), "é", "multi-byte UTF-8");
  assertEquals(base64ToUtf8(BINARY), "��", "undecodable bytes are replaced");
});

Deno.test("exceedsInlineBudget is exclusive at the boundary", () => {
  assertEquals(exceedsInlineBudget(0, 25), false, "empty payload");
  assertEquals(exceedsInlineBudget(25, 25), false, "exactly at the ceiling is allowed");
  assertEquals(exceedsInlineBudget(26, 25), true, "one byte over is refused");
});

Deno.test("REGRESSION GUARD: no returned block ever contains a blob key", () => {
  const types = [
    "image/png",
    "image/jpeg",
    "audio/mpeg",
    "text/plain",
    "text/csv",
    "application/pdf",
    "application/octet-stream",
    "application/zip",
    "message/rfc822",
    "video/mp4",
    "font/woff2",
    "",
  ];
  for (const mimeType of types) {
    const blocks = downloadContentBlocks(payload(mimeType, BINARY), meta(mimeType, BINARY));
    const keys = everyKey(blocks);
    assertEquals(keys.has("blob"), false, `${mimeType || "(empty mime type)"} must emit no blob key`);
    // Every block must also still be a recognised member of the content union.
    for (const block of blocks) {
      const type = block["type"];
      const known = type === "text" || type === "image" || type === "audio" || type === "resource";
      assertEquals(known, true, `${mimeType || "(empty mime type)"} emitted an unknown block type`);
    }
  }
});
