// ---------------------------------------------------------------------------
// Content blocks for the dedicated-download paths (email_attachment,
// email_original).
//
// An EmbeddedResource carrying `blob` does not survive the trip to the model.
// Verified in production on a single message holding both a .txt and a .pdf,
// each downloaded by filename: the `text` resource arrived intact, while the
// `blob` resource reached the client with `text` undefined, `blob` undefined and
// `_meta` materialised as null. That shape matches no branch of the content
// union, so the client rejected the WHOLE tool result with -32602, and a
// successful download surfaced to the agent as a malformed-arguments error.
//
// Both layers we own were excluded by elimination: the Vercel proxy is a
// byte-transparent `await upstream.text()` passthrough, and this server's text
// and blob branches were structurally identical apart from the field name. The
// re-serialisation that knows `uri`/`name`/`mimeType`/`text` but not `blob` is
// above us, and we cannot fix it.
//
// So we stop depending on a blob resource surviving. `image` and `audio` are
// first-class members of the content union and are unaffected. `text/*` is
// proven working in production. Everything else now ships its bytes ONLY in the
// JSON payload (structuredContent plus the text block mirroring it), which is
// where email_attachment has ALWAYS also put them, so on that path this deletes
// a duplicate rather than the data. email_original carried no such mirror, so
// one is added there.
//
// The single rule this module exists to enforce: no block it returns ever
// carries a `blob` key. Building every download's blocks here, rather than at
// each handler, is what makes that rule checkable in one place.
// ---------------------------------------------------------------------------

/** Decode standard base64 to a UTF-8 string, replacing undecodable bytes. */
export function base64ToUtf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export interface DownloadPayload {
  /** Synthetic identifier for the file. Every component of it is also a field of `meta`. */
  uri: string;
  filename: string;
  mimeType: string;
  /** Standard base64 of the file's bytes. Must also be present on `meta` as `data`. */
  data: string;
}

/**
 * Build the `content` array for a dedicated download.
 *
 * `meta` is the same object the caller returns as `structuredContent`; it is
 * mirrored into a text block because many MCP clients expose only `content` and
 * `structuredContent`, and a metadata-only result makes a download unusable.
 * `meta.data` is what actually carries the bytes for binary files, so callers
 * MUST put the base64 there.
 */
export function downloadContentBlocks(
  payload: DownloadPayload,
  meta: Record<string, unknown>,
): Record<string, unknown>[] {
  // Mirrors structuredContent. For binary payloads this is the whole result.
  const mirror: Record<string, unknown> = { type: "text", text: JSON.stringify(meta) };
  const mt = payload.mimeType.toLowerCase();

  if (mt.startsWith("image/")) {
    return [{ type: "image", data: payload.data, mimeType: payload.mimeType }, mirror];
  }
  if (mt.startsWith("audio/")) {
    return [{ type: "audio", data: payload.data, mimeType: payload.mimeType }, mirror];
  }
  if (mt.startsWith("text/")) {
    return [
      {
        type: "resource",
        resource: {
          uri: payload.uri,
          name: payload.filename,
          mimeType: payload.mimeType,
          text: base64ToUtf8(payload.data),
        },
      },
      mirror,
    ];
  }

  // Binary (application/*, message/rfc822, font/*, video/*, and so on).
  // Deliberately no resource block: a `blob` one is dropped in transit and takes
  // the entire result down with it, and there is nothing to put in a `text` one
  // that would not corrupt the bytes. `meta.data` holds the same base64 the blob
  // would have, so the mirror block is a complete, self-sufficient result.
  return [mirror];
}

/**
 * True when a payload this large must not be inlined as base64 into the JSON
 * result. The comparison is exclusive at the boundary: a payload of exactly
 * `maxBytes` is still returned, matching how every other size ceiling in the
 * download paths is applied.
 */
export function exceedsInlineBudget(sizeBytes: number, maxBytes: number): boolean {
  return sizeBytes > maxBytes;
}
