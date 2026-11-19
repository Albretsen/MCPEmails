// ---------------------------------------------------------------------------
// attachment-uploads.ts - a file that reaches a draft without passing through
// the conversation (2026-11-19).
//
// Until now a file on the user's own device could only be attached by the
// model writing it out as base64 in `attachments[].data`: about 1.33 output
// characters per byte, so a 355 KB PDF cost some 150k tokens, and models
// rightly warned the user about it. The draft card's own "Attach file" button
// avoids that, but not every host shows the card, and the card stops at 5 MB.
//
// This module is the shared backend for the two other routes:
//
//   upload slot   `draft` action 'upload_link' creates a row here and a
//                 one-write signed upload URL in the private
//                 `attachment-uploads` bucket. The user drops the file on
//                 mcpemails.com/upload (the signed URL rides in the URL
//                 fragment, so it never reaches our server logs), or an agent
//                 with a shell runs `curl -T file "<put_url>"`. The model then
//                 passes `attachments: [{ upload_id }]`.
//   files ext.    the MCP files extension (files-extension.ts) issues the same
//                 slots as `upload_required` targets. No host speaks it yet.
//
// Supabase's signed-upload endpoint accepts a raw-body PUT (`curl -T`),
// accepts ONE write per path (a second answers 409 KeyAlreadyExists) and keeps
// its token valid for two hours, which is why a slot lives two hours too:
// a slot that expired while its token still worked would let bytes land that
// nothing will ever read. Checked against staging 2026-11-19.
//
// A slot belongs to a workspace. Resolving it from another workspace answers
// exactly as a slot that does not exist, so ids cannot be probed.
//
// Nothing here knows about MIME or providers: it hands back the bytes, base64,
// in the `OutgoingAttachment` shape every builder already takes.
// ---------------------------------------------------------------------------

/** The private bucket. Created by migration 20261119120000_attachment_uploads. */
export const UPLOAD_BUCKET = "attachment-uploads";

/** How long a slot can be filled and used. Matches the storage token's life. */
export const UPLOAD_SLOT_TTL_MS = 2 * 60 * 60 * 1000;

/** Per file, and the bucket's own limit. The send budget is 10 MB in all. */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

const FILENAME_MAX = 255;
// type/subtype per RFC 6838 section 4.2, parameters not accepted.
const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUploadId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** A row of `public.attachment_uploads`. */
export interface UploadSlotRow {
  id: string;
  workspace_id: string;
  api_key_id: string | null;
  inbox_id: string | null;
  filename: string;
  mime_type: string;
  declared_size_bytes: number | null;
  storage_path: string;
  created_at?: string;
  expires_at: string;
  consumed_at: string | null;
}

/**
 * Everything this module needs from the outside, so tests run without a
 * database. `supabaseUploadStore` below is the real one.
 */
export interface UploadStore {
  insert(row: UploadSlotRow): Promise<void>;
  /** The row, or null. Never filters by workspace: the caller compares. */
  get(id: string): Promise<UploadSlotRow | null>;
  markConsumed(id: string, at: string): Promise<void>;
  /**
   * Sets consumed_at only if it is unset, atomically. True for the one caller
   * that set it. The files extension consumes a requestState with it.
   */
  claim(id: string, at: string): Promise<boolean>;
  /** A one-write signed upload URL for `path` (absolute https). */
  signUpload(path: string): Promise<string>;
  /** The object's bytes, or null when nothing was uploaded there. */
  download(path: string): Promise<Uint8Array | null>;
  /** The object's size in bytes, or null when nothing was uploaded there. */
  objectSize(path: string): Promise<number | null>;
  /** Up to `limit` rows whose expires_at is before `now`. */
  listExpired(now: string, limit: number): Promise<UploadSlotRow[]>;
  removeObjects(paths: string[]): Promise<void>;
  deleteRows(ids: string[]): Promise<void>;
}

export class UploadSlotError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "UploadSlotError";
    this.code = code;
  }
}

/**
 * A filename a recipient can be shown: the base name after `/` and `\`,
 * control and bidi characters removed, at most 255 characters. Null when
 * nothing usable is left.
 */
export function cleanUploadFilename(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const base = raw.split(/[\\/]/).pop() ?? "";
  // deno-lint-ignore no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "").trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return null;
  return cleaned.slice(0, FILENAME_MAX);
}

export function cleanMediaType(raw: unknown): string {
  if (typeof raw !== "string") return "application/octet-stream";
  const value = raw.trim().toLowerCase();
  return MEDIA_TYPE.test(value) ? value : "application/octet-stream";
}

export interface UploadSlotRequest {
  filename: string;
  mime_type: string;
  size_bytes: number | null;
}

/** Validates the 'upload_link' arguments. */
export function parseUploadSlotRequest(
  tool: string,
  args: Record<string, unknown>,
): { ok: true; request: UploadSlotRequest } | { ok: false; message: string } {
  const filename = cleanUploadFilename(args["filename"]);
  if (filename === null) {
    return { ok: false, message: `${tool}: filename is required: the name the recipient sees, e.g. "contract.pdf".` };
  }
  const rawSize = args["size_bytes"];
  let size: number | null = null;
  if (rawSize !== undefined && rawSize !== null) {
    if (typeof rawSize !== "number" || !Number.isInteger(rawSize) || rawSize < 0) {
      return { ok: false, message: `${tool}: size_bytes must be a non-negative integer when given.` };
    }
    if (rawSize > UPLOAD_MAX_BYTES) {
      return {
        ok: false,
        message: `${tool}: the file is ${rawSize} bytes; one email takes at most ${UPLOAD_MAX_BYTES} bytes of attachments.`,
      };
    }
    size = rawSize;
  }
  return { ok: true, request: { filename, mime_type: cleanMediaType(args["mime_type"]), size_bytes: size } };
}

export interface IssuedUploadSlot {
  upload_id: string;
  /** Signed, one write, raw-body PUT. A secret until it expires. */
  put_url: string;
  /** The browser page, with the signed URL in its fragment. */
  page_url: string;
  expires_at: string;
}

function base64UrlEncodeText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The page link. Everything after `#` stays in the browser: the signed URL,
 * the filename and size the page shows. `appUrl` is the site origin.
 */
export function uploadPageUrl(appUrl: string, slot: { put_url: string; filename: string; size_bytes: number | null; expires_at: string }): string {
  const fragment = new URLSearchParams({
    t: base64UrlEncodeText(slot.put_url),
    n: slot.filename,
    e: slot.expires_at,
    ...(slot.size_bytes !== null ? { s: String(slot.size_bytes) } : {}),
  });
  return `${appUrl.replace(/\/+$/, "")}/upload#${fragment.toString()}`;
}

/** Creates the row and the signed URL. The row first, so a URL never exists without one. */
export async function issueUploadSlot(
  store: UploadStore,
  input: {
    workspaceId: string;
    apiKeyId: string | null;
    inboxId: string | null;
    request: UploadSlotRequest;
    appUrl: string;
    now?: Date;
    id?: string;
  },
): Promise<IssuedUploadSlot> {
  const now = input.now ?? new Date();
  const id = input.id ?? crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + UPLOAD_SLOT_TTL_MS).toISOString();
  const storagePath = `${input.workspaceId}/${id}`;
  await store.insert({
    id,
    workspace_id: input.workspaceId,
    api_key_id: input.apiKeyId,
    inbox_id: input.inboxId,
    filename: input.request.filename,
    mime_type: input.request.mime_type,
    declared_size_bytes: input.request.size_bytes,
    storage_path: storagePath,
    expires_at: expiresAt,
    consumed_at: null,
  });
  const putUrl = await store.signUpload(storagePath);
  return {
    upload_id: id,
    put_url: putUrl,
    page_url: uploadPageUrl(input.appUrl, {
      put_url: putUrl,
      filename: input.request.filename,
      size_bytes: input.request.size_bytes,
      expires_at: expiresAt,
    }),
    expires_at: expiresAt,
  };
}

/** The slot, if this workspace may use it and it has not expired. */
async function usableSlot(
  store: UploadStore,
  workspaceId: string,
  uploadId: string,
  now: Date,
): Promise<UploadSlotRow> {
  if (!isUploadId(uploadId)) {
    throw new UploadSlotError("upload_not_found", `upload_id ${uploadId} is not an upload id from 'upload_link'.`);
  }
  const row = await store.get(uploadId);
  if (row === null || row.workspace_id !== workspaceId) {
    throw new UploadSlotError("upload_not_found", `upload_id ${uploadId} was not found.`);
  }
  if (Date.parse(row.expires_at) <= now.getTime()) {
    throw new UploadSlotError(
      "upload_expired",
      `upload_id ${uploadId} expired at ${row.expires_at}. Create a new one with 'upload_link'.`,
    );
  }
  return row;
}

/**
 * Has the file arrived, and is it the size that was declared? Used by the
 * files extension before it runs a tool, and by `resolveUploadedAttachment`.
 */
export async function confirmUploadedSize(
  store: UploadStore,
  row: UploadSlotRow,
): Promise<number> {
  const size = await store.objectSize(row.storage_path);
  if (size === null) {
    throw new UploadSlotError(
      "upload_pending",
      `upload_id ${row.id}: no file has been uploaded yet. The user opens the upload page, or a shell runs curl -T on put_url, and then the call is repeated.`,
    );
  }
  if (size > UPLOAD_MAX_BYTES) {
    throw new UploadSlotError("attachment_too_large", `upload_id ${row.id}: the file is ${size} bytes, over the ${UPLOAD_MAX_BYTES}-byte limit.`);
  }
  if (row.declared_size_bytes !== null && size !== row.declared_size_bytes) {
    throw new UploadSlotError(
      "upload_size_mismatch",
      `upload_id ${row.id}: ${size} bytes arrived but ${row.declared_size_bytes} were declared, so the upload is incomplete or a different file.`,
    );
  }
  return size;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export interface ResolvedUpload {
  filename: string;
  mime_type: string;
  data: string;
  size_bytes: number;
}

/**
 * The bytes of an uploaded file, as an attachment. A slot may be used more
 * than once until it expires (a retried call, the same file on a draft and
 * then a send); the first use is recorded.
 */
export async function resolveUploadedAttachment(
  store: UploadStore,
  input: { workspaceId: string; uploadId: string; budgetBytes: number; now?: Date },
): Promise<ResolvedUpload> {
  const now = input.now ?? new Date();
  const row = await usableSlot(store, input.workspaceId, input.uploadId, now);
  const size = await confirmUploadedSize(store, row);
  if (size > input.budgetBytes) {
    throw new UploadSlotError(
      "attachment_too_large",
      `upload_id ${row.id}: the file is ${size} bytes and only ${Math.max(0, input.budgetBytes)} bytes of the attachment limit are left.`,
    );
  }
  const bytes = await store.download(row.storage_path);
  if (bytes === null) {
    throw new UploadSlotError("upload_pending", `upload_id ${row.id}: no file has been uploaded yet.`);
  }
  if (bytes.length !== size) {
    throw new UploadSlotError("upload_size_mismatch", `upload_id ${row.id}: the stored file changed while it was read. Try again.`);
  }
  if (row.consumed_at === null) await store.markConsumed(row.id, now.toISOString());
  return { filename: row.filename, mime_type: row.mime_type, data: bytesToBase64(bytes), size_bytes: size };
}

/** Looks a slot up for the files extension's retry, with the same checks. */
export function loadUsableSlot(
  store: UploadStore,
  workspaceId: string,
  uploadId: string,
  now: Date = new Date(),
): Promise<UploadSlotRow> {
  return usableSlot(store, workspaceId, uploadId, now);
}

/**
 * Removes up to `limit` expired slots, objects first. Run opportunistically
 * when a slot is issued; a failure is the caller's to ignore.
 */
export async function purgeExpiredUploads(store: UploadStore, now: Date = new Date(), limit = 50): Promise<number> {
  const expired = await store.listExpired(now.toISOString(), limit);
  if (expired.length === 0) return 0;
  await store.removeObjects(expired.map((r) => r.storage_path));
  await store.deleteRows(expired.map((r) => r.id));
  return expired.length;
}

// ---------------------------------------------------------------------------
// The real store
// ---------------------------------------------------------------------------

// Structural, so this module does not import supabase-js and tests need no
// network. index.ts passes its service-role client.
// deno-lint-ignore no-explicit-any
type AnyClient = any;

export function supabaseUploadStore(client: AnyClient, supabaseUrl: string, serviceKey: string): UploadStore {
  const table = () => client.from("attachment_uploads");
  const bucket = () => client.storage.from(UPLOAD_BUCKET);
  const base = supabaseUrl.replace(/\/+$/, "");
  return {
    async insert(row) {
      const { error } = await table().insert(row);
      if (error) throw new UploadSlotError("upload_unavailable", "Uploads are unavailable right now. Try again shortly.");
    },
    async get(id) {
      const { data, error } = await table()
        .select("id, workspace_id, api_key_id, inbox_id, filename, mime_type, declared_size_bytes, storage_path, expires_at, consumed_at")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new UploadSlotError("upload_unavailable", "Uploads are unavailable right now. Try again shortly.");
      return (data as UploadSlotRow | null) ?? null;
    },
    async markConsumed(id, at) {
      await table().update({ consumed_at: at }).eq("id", id).is("consumed_at", null);
    },
    async claim(id, at) {
      const { data, error } = await table().update({ consumed_at: at }).eq("id", id).is("consumed_at", null).select("id");
      return !error && Array.isArray(data) && data.length === 1;
    },
    async signUpload(path) {
      const { data, error } = await bucket().createSignedUploadUrl(path);
      if (error || typeof data?.signedUrl !== "string") {
        throw new UploadSlotError("upload_unavailable", "Uploads are unavailable right now. Try again shortly.");
      }
      const signed: string = data.signedUrl;
      return signed.startsWith("http") ? signed : `${base}/storage/v1${signed}`;
    },
    async download(path) {
      const { data, error } = await bucket().download(path);
      if (error || !data) return null;
      return new Uint8Array(await (data as Blob).arrayBuffer());
    },
    async objectSize(path) {
      // GET /object/info/authenticated/... answers the stored size without
      // the bytes (checked on staging 2026-11-19).
      const res = await fetch(
        `${base}/storage/v1/object/info/authenticated/${UPLOAD_BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`,
        { headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey } },
      );
      if (!res.ok) {
        await res.body?.cancel();
        return null;
      }
      const info = await res.json().catch(() => null) as { size?: unknown } | null;
      return typeof info?.size === "number" ? info.size : null;
    },
    async listExpired(now, limit) {
      const { data } = await table()
        .select("id, workspace_id, api_key_id, inbox_id, filename, mime_type, declared_size_bytes, storage_path, expires_at, consumed_at")
        .lt("expires_at", now)
        .order("expires_at", { ascending: true })
        .limit(limit);
      return (data as UploadSlotRow[] | null) ?? [];
    },
    async removeObjects(paths) {
      if (paths.length > 0) await bucket().remove(paths);
    },
    async deleteRows(ids) {
      if (ids.length > 0) await table().delete().in("id", ids);
    },
  };
}
