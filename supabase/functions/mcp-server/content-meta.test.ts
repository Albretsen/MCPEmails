// ---------------------------------------------------------------------------
// A null `_meta` is not a cosmetic defect, so these are not cosmetic tests.
//
// Observed in production on 2026-08-30: `email_read action: original` returned a
// perfectly good .eml and the client threw the whole result away with
//
//   MCP error -32602: Invalid tools/call result
//     path ["content", 0] -> resource._meta
//     "Invalid input: expected record, received null"
//
// because `_meta: null` fails every branch of the content union at once. The
// last test in this file reconstructs that exact block and asserts it comes out
// the other side valid.
//
// The other property worth holding on to is that this pass is copy-on-write: a
// response with nothing to strip must come back as the SAME reference, or every
// 25 MB attachment result pays for a clone it did not need.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  normalizeContentBlock,
  normalizeContentBlocks,
  normalizeResponseContentMeta,
} from "./content-meta.ts";

Deno.test("a null `_meta` on a resource is removed, not nulled out", () => {
  const block = {
    type: "resource",
    resource: { uri: "mcpemails://x", mimeType: "message/rfc822", blob: "AAA=", _meta: null },
  };
  const out = normalizeContentBlock(block) as Record<string, unknown>;
  const resource = out["resource"] as Record<string, unknown>;
  assert(!("_meta" in resource), "_meta key omitted, not set to undefined");
  assertEquals(resource["blob"], "AAA=", "payload survives the strip");
  assertEquals(resource["uri"], "mcpemails://x", "uri survives the strip");
});

Deno.test("an undefined `_meta` is removed too", () => {
  // JSON.stringify would drop this one for us; an intermediary that re-encodes
  // the response through its own model can hand it on as an explicit null, so
  // the key never gets to leave.
  const block = { type: "resource", resource: { uri: "u", text: "hi", _meta: undefined } };
  const out = normalizeContentBlock(block) as Record<string, unknown>;
  const resource = out["resource"] as Record<string, unknown>;
  assert(!("_meta" in resource), "undefined _meta key omitted");
  assertEquals(resource["text"], "hi", "payload survives the strip");
});

Deno.test("a `_meta` object is left exactly as it was", () => {
  const meta = { "ui/resourceUri": "ui://review-card" };
  const block = { type: "resource", resource: { uri: "ui://review-card", text: "<p/>", _meta: meta } };
  const out = normalizeContentBlock(block) as Record<string, unknown>;
  const resource = out["resource"] as Record<string, unknown>;
  assertEquals(resource["_meta"], meta, "valid _meta preserved by value");
  assert(resource["_meta"] === meta, "valid _meta preserved by reference");
  assert(out === block, "an untouched block is not cloned");
});

Deno.test("a block-level `_meta` is normalised as well as the nested one", () => {
  const block = { type: "resource", _meta: null, resource: { uri: "u", blob: "AA==", _meta: null } };
  const out = normalizeContentBlock(block) as Record<string, unknown>;
  assert(!("_meta" in out), "block _meta removed");
  assert(!("_meta" in (out["resource"] as Record<string, unknown>)), "resource _meta removed");
});

Deno.test("blocks without `_meta` are returned untouched, by reference", () => {
  const text = { type: "text", text: "{}" };
  assert(normalizeContentBlock(text) === text, "text block not cloned");

  const resource = { type: "resource", resource: { uri: "u", blob: "AA==" } };
  assert(normalizeContentBlock(resource) === resource, "clean resource block not cloned");

  const content = [text, resource];
  assert(normalizeContentBlocks(content) === content, "clean content array not cloned");
});

Deno.test("non-block values pass straight through", () => {
  assertEquals(normalizeContentBlock(null), null, "null block");
  assertEquals(normalizeContentBlock("text"), "text", "string block");
  assertEquals(normalizeContentBlocks("not an array"), "not an array", "non-array content");
  assertEquals(normalizeResponseContentMeta(null), null, "null response");
  assertEquals(
    normalizeResponseContentMeta({ jsonrpc: "2.0", id: 1, error: { code: -32602 } }),
    { jsonrpc: "2.0", id: 1, error: { code: -32602 } },
    "error response has no result to walk",
  );
});

Deno.test("the whole response is normalised: content, contents, and result `_meta`", () => {
  const response = {
    jsonrpc: "2.0",
    id: 7,
    result: {
      _meta: null,
      content: [
        { type: "resource", resource: { uri: "u", blob: "AA==", _meta: null } },
        { type: "text", text: "{}" },
      ],
      contents: [{ uri: "ui://card", text: "<p/>", _meta: null }],
      isError: false,
    },
  };
  const out = normalizeResponseContentMeta(response) as Record<string, unknown>;
  const result = out["result"] as Record<string, unknown>;
  assert(!("_meta" in result), "result-level _meta removed");

  const content = result["content"] as Record<string, unknown>[];
  assert(!("_meta" in (content[0]["resource"] as Record<string, unknown>)), "content[0] cleaned");
  assertEquals(content[1], { type: "text", text: "{}" }, "sibling text block untouched");

  const contents = result["contents"] as Record<string, unknown>[];
  assert(!("_meta" in contents[0]), "resources/read contents cleaned");
  assertEquals(result["isError"], false, "unrelated result fields survive");
});

Deno.test("a clean response comes back as the same reference", () => {
  const response = {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: "ok" }], isError: false },
  };
  assert(normalizeResponseContentMeta(response) === response, "no clone when nothing to strip");
});

Deno.test("the production email_original block becomes valid", () => {
  // The exact shape the client rejected, with the `_meta: null` an intermediary
  // put on it. After the pass it satisfies BlobResourceContents: a uri, a base64
  // blob, and no `_meta` key at all.
  const rejected = {
    jsonrpc: "2.0",
    id: 3,
    result: {
      content: [
        {
          type: "resource",
          resource: {
            uri: "mcpemails://inbox/8a63a5ce/message/INBOX%3A110/original.eml",
            name: "original-message.eml",
            mimeType: "message/rfc822",
            blob: "RnJvbTogYUBiLmNvbQ0KDQpoaQ==",
            _meta: null,
          },
        },
        { type: "text", text: '{"filename":"original-message.eml"}' },
      ],
      isError: false,
    },
  };

  const out = normalizeResponseContentMeta(rejected);
  const resource = (out.result.content[0] as Record<string, unknown>)["resource"] as
    Record<string, unknown>;

  assert(!("_meta" in resource), "no _meta key survives to the wire");
  assertEquals(typeof resource["uri"], "string", "uri present");
  assertEquals(typeof resource["blob"], "string", "blob present");
  assertEquals(resource["mimeType"], "message/rfc822", "mimeType present");
  // And the response really was re-encoded, so the null cannot come back via a
  // shared reference with the original object.
  assert(out !== rejected, "a dirty response is rewritten");
  assertEquals(
    JSON.stringify(out).includes("_meta"),
    false,
    "serialised response carries no _meta at all",
  );
});
