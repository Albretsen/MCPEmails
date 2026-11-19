// ---------------------------------------------------------------------------
// files-extension.ts - ready for the MCP files extension (2026-11-19).
//
// `io.modelcontextprotocol/files` is a DRAFT extension of the File Uploads
// working group (experimental-ext-file-uploads, specification/draft/
// file-uploads.md, announced 2026-11-10). A tool marks a file argument with
// `x-mcp-file`; the host fills it with a `FileInput` { id, name, mimeType,
// size, data? }. Without `data` the server answers `upload_required` with one
// target per file and an opaque `requestState`; the host PUTs the bytes and
// repeats the call with `requestState`; the server confirms the bytes and runs
// the tool. Neither the bytes nor the target URL reach the model.
//
// No host speaks it yet, and this server cannot be reached by it yet either:
// see TODO below. So this module is everything that can be built and tested
// now, against the same upload slots `draft` 'upload_link' uses
// (attachment-uploads.ts), and nothing in index.ts calls it. Wiring it in is
// the TODO list, and the env switch below keeps it off even then until it is
// flipped on purpose.
//
// What it does, all pure or behind `UploadStore`:
//   * `clientFilesCapability`: what a request declared in
//     `_meta["io.modelcontextprotocol/clientCapabilities"]`.
//   * `attachmentsSchemaWithFileInput`: the `attachments` schema with a
//     `FileInput` branch marked `x-mcp-file`, for declaring clients only.
//   * `prepareFileArguments`: turns the FileInputs in `attachments` into the
//     shapes the handlers already take (inline `{filename, mime_type, data}` or
//     `{ upload_id }`), or answers `upload_required`, or refuses.
//   * `requestState`: HMAC-SHA256 over a JSON claim set bound to the key, the
//     tool, a canonical hash of every argument, each file's slot and an
//     expiry; consumed at most once through the slot row (the draft and send
//     tools are not safe to run twice).
//
// TODO before a host can use this (each is a spec requirement this server
// does not meet today):
//   1. Protocol revision 2026-07-28: `server/discover` must advertise
//      `extensions["io.modelcontextprotocol/files"] = serverFilesSettings()`;
//      a client MUST NOT use the extension with a server that did not.
//   2. MRTR: `tools/call` must accept `params.requestState` and be able to
//      return a result with `resultType: "upload_required"` (not a
//      CallToolResult). handleToolsCall in index.ts does neither.
//   3. In handleToolsCall, for draft_create / draft_reply / draft_update /
//      email_send / email_reply (and their consolidated spellings), when
//      `filesExtensionEnabled()` and `clientFilesCapability(params._meta)`:
//      call `prepareFileArguments`, then dispatch with the rewritten args, map
//      `rpc_error` to a JSON-RPC error and `tool_error` to `isError: true`.
//   4. In handleToolsList, swap `attachments` for
//      `attachmentsSchemaWithFileInput(...)` on those tools for a declaring
//      client only.
//   5. -32021 MissingRequiredClientCapabilityError when a FileInput without
//      data arrives from a request that did not declare `upload`
//      (`prepareFileArguments` reports it; the code needs the 2026-07-28
//      error type).
//   6. Downloads (email_attachment returning a download target) are not
//      started: the working group has not reviewed that shape.
//   7. Set FILES_REQUEST_STATE_SECRET (32+ bytes) and MCP_FILES_EXTENSION=1.
// ---------------------------------------------------------------------------

import {
  confirmUploadedSize,
  issueUploadSlot,
  loadUsableSlot,
  UPLOAD_MAX_BYTES,
  UPLOAD_SLOT_TTL_MS,
  UploadSlotError,
  type UploadStore,
} from "./attachment-uploads.ts";
import { decodedBase64ByteLength } from "./attachment-validation.ts";

export const FILES_EXTENSION_ID = "io.modelcontextprotocol/files";
export const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

/** JSON-RPC code for MissingRequiredClientCapabilityError (2026-07-28). */
export const MISSING_CLIENT_CAPABILITY = -32021;

/** Off unless switched on, and never on without a secret. */
export function filesExtensionEnabled(env: { get(name: string): string | undefined } = Deno.env): boolean {
  return env.get("MCP_FILES_EXTENSION") === "1" && (env.get("FILES_REQUEST_STATE_SECRET") ?? "").length >= 32;
}

/** What `server/discover` would advertise (TODO 1). */
export function serverFilesSettings(): Record<string, unknown> {
  return { upload: {}, maxInlineBytes: UPLOAD_MAX_BYTES };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ClientFilesCapability {
  upload: boolean;
  download: boolean;
}

/**
 * The files settings a request declared, or null when it declared none (or a
 * `revision` this module does not know, which the draft says not to enable).
 */
export function clientFilesCapability(meta: unknown): ClientFilesCapability | null {
  if (!isRecord(meta)) return null;
  const caps = meta[CLIENT_CAPABILITIES_META_KEY];
  if (!isRecord(caps) || !isRecord(caps.extensions)) return null;
  const settings = caps.extensions[FILES_EXTENSION_ID];
  if (!isRecord(settings)) return null;
  if (settings.revision !== undefined && settings.revision !== null) return null;
  return { upload: isRecord(settings.upload), download: isRecord(settings.download) };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** One `FileInput`, marked for the host. Required: id, mimeType, size. */
export const FILE_INPUT_SCHEMA = {
  type: "object",
  "x-mcp-file": { maxSize: UPLOAD_MAX_BYTES },
  properties: {
    id: { type: "string", minLength: 1, maxLength: 128 },
    name: { type: "string" },
    mimeType: { type: "string" },
    size: { type: "integer", minimum: 0 },
    digest: {
      type: "object",
      properties: { algorithm: { const: "sha-256" }, value: { type: "string" } },
      required: ["algorithm", "value"],
    },
    data: { type: "string" },
  },
  required: ["id", "mimeType", "size"],
} as const;

/**
 * The `attachments` array for a declaring client: each item is either one of
 * today's shapes or a `FileInput`. The draft lets `x-mcp-file` sit in an
 * `anyOf` branch, and a host hides only that branch from its model.
 */
export function attachmentsSchemaWithFileInput(attachments: Record<string, unknown>): Record<string, unknown> {
  const items = attachments.items;
  return {
    ...attachments,
    items: { anyOf: [items, FILE_INPUT_SCHEMA] },
  };
}

// ---------------------------------------------------------------------------
// FileInput values
// ---------------------------------------------------------------------------

export interface FileInputValue {
  id: string;
  name?: string;
  mimeType: string;
  size: number;
  data?: string;
}

/**
 * A FileInput, told apart from today's shapes by its camelCase `mimeType` and
 * integer `size` next to an `id`. None of the existing shapes has those.
 */
export function isFileInput(entry: unknown): entry is FileInputValue {
  return isRecord(entry) && typeof entry.id === "string" && "mimeType" in entry && "size" in entry;
}

function fileInputProblem(entry: Record<string, unknown>): string | null {
  const id = entry.id;
  if (typeof id !== "string" || id.length < 1 || id.length > 128) return "id must be 1 to 128 characters";
  if (typeof entry.mimeType !== "string") return "mimeType must be a string";
  if (typeof entry.size !== "number" || !Number.isInteger(entry.size) || entry.size < 0) {
    return "size must be a non-negative integer";
  }
  if (entry.size > UPLOAD_MAX_BYTES) return `size is over the ${UPLOAD_MAX_BYTES}-byte limit`;
  if ("data" in entry && typeof entry.data !== "string") return "data must be a base64 string when present";
  if (entry.name !== undefined && typeof entry.name !== "string") return "name must be a string";
  return null;
}

// ---------------------------------------------------------------------------
// requestState
// ---------------------------------------------------------------------------

/** Canonical JSON: sorted keys, numbers as JSON prints them. Instance equality. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const normal = text.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normal + "=".repeat((4 - normal.length % 4) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function sha256(text: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** What a requestState binds. `u` records that an upload request was issued. */
export interface RequestStateClaims {
  v: 1;
  /** api key id: the authenticated principal. */
  k: string;
  /** tool name */
  t: string;
  /** canonical SHA-256 of every argument */
  h: string;
  /** FileInput.id -> upload_id */
  f: Record<string, string>;
  /** expiry, ms since epoch */
  e: number;
  u: true;
}

export async function signRequestState(claims: RequestStateClaims, secret: string): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(body)));
  return `${body}.${b64url(sig)}`;
}

/** The claims, or null when the value is malformed, forged or expired. */
export async function verifyRequestState(token: unknown, secret: string, now: number): Promise<RequestStateClaims | null> {
  if (typeof token !== "string" || token.length > 8192) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const sigBytes = fromB64url(sig);
  if (!sigBytes) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), sigBytes, new TextEncoder().encode(body));
  if (!ok) return null;
  const raw = fromB64url(body);
  if (!raw) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
  if (!isRecord(claims) || claims.v !== 1 || claims.u !== true) return null;
  if (typeof claims.e !== "number" || claims.e <= now) return null;
  if (typeof claims.k !== "string" || typeof claims.t !== "string" || typeof claims.h !== "string") return null;
  if (!isRecord(claims.f)) return null;
  return claims as unknown as RequestStateClaims;
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

export interface UploadTarget {
  fileId: string;
  url: string;
  method: "PUT";
  credentials: "omit";
  expiresAt: string;
}

export type PreparedCall =
  /** Nothing for the extension to do, or every file is now an existing shape. */
  | { kind: "run"; args: Record<string, unknown> }
  | { kind: "upload_required"; result: { resultType: "upload_required"; uploads: UploadTarget[]; requestState: string } }
  /** JSON-RPC error: -32602 for a bad requestState, -32021 for a missing capability. */
  | { kind: "rpc_error"; code: number; message: string; data?: Record<string, unknown> }
  /** A CallToolResult with isError: true; the tool has not run. */
  | { kind: "tool_error"; code: string; message: string };

export interface PrepareInput {
  tool: string;
  args: Record<string, unknown>;
  /** params.requestState, as received. */
  requestState: unknown;
  capability: ClientFilesCapability | null;
  apiKeyId: string;
  workspaceId: string;
  store: UploadStore;
  secret: string;
  appUrl: string;
  now?: Date;
}

/**
 * Rewrites the FileInputs in `args.attachments`, or says why it cannot.
 * Follows the draft's Uploads section: metadata checks first, one target per
 * file without data, the retry verified in order (state, binding, bytes,
 * consume) before the tool runs.
 */
export async function prepareFileArguments(input: PrepareInput): Promise<PreparedCall> {
  const now = input.now ?? new Date();
  const list = input.args.attachments;
  const entries = Array.isArray(list) ? list : [];
  const fileInputs = entries
    .map((entry, position) => ({ entry, position }))
    .filter((x): x is { entry: FileInputValue & Record<string, unknown>; position: number } => isFileInput(x.entry));

  if (input.requestState !== undefined && input.requestState !== null) {
    return await retry(input, entries, now);
  }
  if (fileInputs.length === 0) return { kind: "run", args: input.args };

  // Metadata checks, before any target exists.
  const seen = new Set<string>();
  let inlineBytes = 0;
  for (const { entry, position } of fileInputs) {
    const problem = fileInputProblem(entry);
    if (problem) return { kind: "tool_error", code: "-32602", message: `${input.tool}: attachments[${position}]: ${problem}.` };
    if (seen.has(entry.id)) {
      return { kind: "tool_error", code: "-32602", message: `${input.tool}: attachments[${position}]: duplicate file id ${entry.id}.` };
    }
    seen.add(entry.id);
    if (typeof entry.data === "string") {
      const decoded = decodedBase64ByteLength(entry.data);
      if (decoded === null || decoded !== entry.size) {
        return {
          kind: "tool_error",
          code: "-32602",
          message: `${input.tool}: attachments[${position}]: data does not decode to the declared ${entry.size} bytes.`,
        };
      }
      inlineBytes += decoded;
    }
  }
  if (inlineBytes > UPLOAD_MAX_BYTES) {
    return { kind: "tool_error", code: "attachment_too_large", message: `${input.tool}: inline files total ${inlineBytes} bytes, over ${UPLOAD_MAX_BYTES}.` };
  }

  const needUpload = fileInputs.filter(({ entry }) => entry.data === undefined && entry.size > 0);
  if (needUpload.length === 0) {
    return { kind: "run", args: { ...input.args, attachments: entries.map(toExistingShapeInline) } };
  }
  if (!input.capability?.upload) {
    return {
      kind: "rpc_error",
      code: MISSING_CLIENT_CAPABILITY,
      message: "This call sends a file out of band, which needs the files extension's upload capability.",
      data: { requiredCapabilities: { extensions: { [FILES_EXTENSION_ID]: { upload: {} } } } },
    };
  }

  const files: Record<string, string> = {};
  const uploads: UploadTarget[] = [];
  try {
    for (const { entry } of needUpload) {
      const slot = await issueUploadSlot(input.store, {
        workspaceId: input.workspaceId,
        apiKeyId: input.apiKeyId,
        inboxId: null,
        request: {
          filename: (entry.name ?? "").split(/[\\/]/).pop() || "file",
          mime_type: entry.mimeType || "application/octet-stream",
          size_bytes: entry.size,
        },
        appUrl: input.appUrl,
        now,
      });
      files[entry.id] = slot.upload_id;
      // Content-Type is left out: the draft forbids sending one the target
      // does not list, and the slot already knows the type.
      uploads.push({ fileId: entry.id, url: slot.put_url, method: "PUT", credentials: "omit", expiresAt: slot.expires_at });
    }
  } catch (err) {
    if (err instanceof UploadSlotError) return { kind: "tool_error", code: err.code, message: `${input.tool}: ${err.message}` };
    throw err;
  }
  const requestState = await signRequestState({
    v: 1,
    k: input.apiKeyId,
    t: input.tool,
    h: await sha256(canonicalJson(input.args)),
    f: files,
    // The storage token lives two hours; the state outlives it, so a transfer
    // started at expiresAt can still be retried, and no target stays valid
    // after the state that issued it has expired.
    e: now.getTime() + UPLOAD_SLOT_TTL_MS + 10 * 60 * 1000,
    u: true,
  }, input.secret);
  return { kind: "upload_required", result: { resultType: "upload_required", uploads, requestState } };
}

/** An inline or empty FileInput as today's inline shape; anything else unchanged. */
function toExistingShapeInline(entry: unknown): unknown {
  if (!isFileInput(entry)) return entry;
  return {
    filename: (entry.name ?? "").split(/[\\/]/).pop() || "file",
    mime_type: entry.mimeType || "application/octet-stream",
    data: entry.data ?? "",
  };
}

async function retry(input: PrepareInput, entries: unknown[], now: Date): Promise<PreparedCall> {
  const bad = (message: string): PreparedCall => ({ kind: "rpc_error", code: -32602, message });
  // 1. Verify.
  const claims = await verifyRequestState(input.requestState, input.secret, now.getTime());
  if (!claims) return bad("requestState is not valid, has expired or was already used.");
  // 2. Binding: principal, tool, every argument.
  if (claims.k !== input.apiKeyId || claims.t !== input.tool) {
    return bad("requestState was issued for a different call.");
  }
  if (claims.h !== await sha256(canonicalJson(input.args))) {
    return bad("The arguments differ from the call requestState was issued for.");
  }
  // 3. The bytes arrived, at the declared size.
  const fileIds = Object.keys(claims.f);
  try {
    for (const fileId of fileIds) {
      const row = await loadUsableSlot(input.store, input.workspaceId, claims.f[fileId], now);
      await confirmUploadedSize(input.store, row, { exact: true });
    }
  } catch (err) {
    if (err instanceof UploadSlotError) {
      return { kind: "tool_error", code: err.code, message: `${input.tool}: ${err.message} The tool did not run.` };
    }
    throw err;
  }
  // 4. Consume, once, in storage every instance shares: the first slot's row.
  const claimed = fileIds.length === 0 ? true : await input.store.claim(claims.f[fileIds[0]], now.toISOString());
  if (!claimed) return bad("requestState was already used.");
  // 5. Run, with each FileInput as the shape the handlers take.
  return {
    kind: "run",
    args: {
      ...input.args,
      attachments: entries.map((entry) => {
        if (!isFileInput(entry)) return entry;
        const uploadId = claims.f[entry.id];
        return uploadId ? { upload_id: uploadId } : toExistingShapeInline(entry);
      }),
    },
  };
}
