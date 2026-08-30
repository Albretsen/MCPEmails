// ---------------------------------------------------------------------------
// `_meta` on an MCP content block must be an object whenever the key is present.
//
// Clients validate a tools/call result against the content union, and a
// `_meta: null` fails EVERY branch of that union at once. The cost is not the
// one bad field: the whole result is rejected before the model sees any of it,
// so a successful 25 MB download surfaces to the agent as
// `-32602 Invalid tools/call result`. `undefined` is the same hazard one hop
// later — `JSON.stringify` drops the key here, but an intermediary that
// re-serialises the response through its own model can materialise it as an
// explicit null.
//
// Nothing in this server sets `_meta` on a content block today, so this module
// is not undoing a local mistake. It makes the outbound shape structurally
// unable to carry the defect, whichever layer would otherwise introduce it, and
// it does so at the one place every method result passes through rather than at
// each of the handlers that build one.
//
// The pass is copy-on-write: a response with nothing to strip comes back as the
// same reference, so the ordinary case allocates nothing and a base64 blob is
// never cloned.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Drop `_meta` from one object when it is present but null/undefined. A `_meta`
 * that holds anything else is left exactly as it is: this guard exists to keep
 * an unusable value off the wire, not to police what callers put in a valid one.
 */
function withoutEmptyMeta<T extends Record<string, unknown>>(value: T): T {
  if (!("_meta" in value)) return value;
  const meta = value["_meta"];
  if (meta !== null && meta !== undefined) return value;
  const stripped = { ...value };
  delete stripped["_meta"];
  return stripped as T;
}

/**
 * Normalise one content block: its own `_meta`, and the `_meta` of the embedded
 * `resource` that an EmbeddedResource block carries. The nested one is the one
 * that actually bites — `resource` is validated as its own union, so a null
 * there takes out both the text and the blob branch.
 */
export function normalizeContentBlock(block: unknown): unknown {
  if (!isRecord(block)) return block;
  let next = withoutEmptyMeta(block);
  const resource = next["resource"];
  if (isRecord(resource)) {
    const cleaned = withoutEmptyMeta(resource);
    if (cleaned !== resource) next = { ...next, resource: cleaned };
  }
  return next;
}

/** Normalise every block of a `content` / `contents` array. */
export function normalizeContentBlocks(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  let changed = false;
  const next = content.map((block) => {
    const normalized = normalizeContentBlock(block);
    if (normalized !== block) changed = true;
    return normalized;
  });
  return changed ? next : content;
}

/**
 * Outbound guard for one JSON-RPC response. Covers the tools/call `content`
 * array, the resources/read `contents` array, and the result-level `_meta`,
 * which the client constrains the same way it constrains a block's.
 */
export function normalizeResponseContentMeta<T>(response: T): T {
  if (!isRecord(response)) return response;
  const result = response["result"];
  if (!isRecord(result)) return response;

  let next = withoutEmptyMeta(result);
  for (const key of ["content", "contents"]) {
    const blocks = normalizeContentBlocks(next[key]);
    if (blocks !== next[key]) next = { ...next, [key]: blocks };
  }
  if (next === result) return response;
  return { ...response, result: next } as T;
}
