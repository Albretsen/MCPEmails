// ---------------------------------------------------------------------------
// draft-attachments.ts - files on a saved draft (2026-10-15).
//
// A customer prepares emails in ChatGPT with PDFs and spreadsheets and sends
// them himself from Thunderbird or Outlook, so the draft has to carry the
// files. Three sources, one list:
//
//   attachments[]  the email_compose shape, unchanged: inline base64
//                  { filename, mime_type, data } or a file already in this
//                  inbox { source_message_id, attachment_index }.
//   files[]        a file the user gave ChatGPT. ChatGPT hands a tool that
//                  declares `_meta["openai/fileParams"]` a short-lived
//                  { download_url, file_id, mime_type?, file_name? } instead
//                  of the bytes, and the server downloads it. Listed to OpenAI
//                  clients only, because no other host fills it in.
//   (carried)      the files the stored draft already has. On IMAP and Gmail
//                  an update REBUILDS the message from fields, and until now
//                  the full-body update dropped every attachment without a
//                  word while the partial one refused. Both now carry them.
//
// ── WHAT A REBUILD CARRIES ─────────────────────────────────────────────────
// Every part the parser calls an attachment, as a plain attachment with its
// own filename, media type and decoded bytes (re-encoded as base64, so the
// bytes are identical). NOT a named part the stored HTML shows through
// `cid:`: that is an inline image, part of the body, and carrying it as a file
// would hand the recipient a stray picture. The caller decides what that
// means (the partial write refuses; a full-body update replaces the body the
// image belonged to).
//
// The download is guarded like the signature image fetch (signature-images.ts):
// https on 443 only, the host-guard address policy on every resolved address
// and every redirect, a byte cap enforced while reading, and one deadline.
// ---------------------------------------------------------------------------

import { guardMailHost, type HostLookup } from "./host-guard.ts";
import type { MimeAttachment } from "./mime.ts";

/** What the MIME builders and Graph take. `data` is standard base64. */
export interface OutgoingAttachment {
  filename: string;
  mime_type: string;
  data: string;
}

/**
 * Ceiling on what a draft rebuild holds in memory: the stored files plus the
 * new ones. Above it the write is refused rather than attempted, because the
 * message is built as one string in an isolate with a fixed memory budget.
 */
export const DRAFT_REBUILD_MAX_BYTES = 25 * 1024 * 1024;

/** At most this many entries in `files` per call, the same as `attachments`. */
export const UPLOADED_FILES_MAX_ITEMS = 20;

const FETCH_DEADLINE_MS = 30_000;
const MAX_REDIRECTS = 3;
const MAX_URL_LENGTH = 4096;

// ---------------------------------------------------------------------------
// The advertised schema
// ---------------------------------------------------------------------------

/**
 * One ChatGPT file. OpenAI's scan requires exactly these four properties,
 * `download_url` and `file_id` required and the other two optional, and
 * rejects a schema that requires anything else.
 */
export const UPLOADED_FILE_SCHEMA = {
  type: "object",
  properties: {
    download_url: { type: "string", description: "Temporary download URL ChatGPT provides." },
    file_id: { type: "string", description: "ChatGPT file id." },
    mime_type: { type: "string", description: "MIME type, when known." },
    file_name: { type: "string", description: "Filename the recipient sees." },
  },
  required: ["download_url", "file_id"],
  additionalProperties: false,
} as const;

/** The `files` property. Only OpenAI clients are shown it. */
export const UPLOADED_FILES_PROPERTY = {
  type: "array",
  items: UPLOADED_FILE_SCHEMA,
  maxItems: UPLOADED_FILES_MAX_ITEMS,
  description:
    "Files the user shared in this conversation, attached to the draft. " +
    "Counts toward the same 10 MB as attachments.",
} as const;

/** Properties that only the per-operation (OpenAI) listing shows. */
export const PER_OPERATION_ONLY_PROPERTIES: ReadonlySet<string> = new Set(["files"]);

/** The draft tools that take `files`, for `_meta["openai/fileParams"]`. */
export const FILE_PARAM_TOOLS: ReadonlySet<string> = new Set([
  "draft_create",
  "draft_reply",
  "draft_update",
]);

// ---------------------------------------------------------------------------
// Parsing `files`
// ---------------------------------------------------------------------------

export interface UploadedFileRef {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
}

export type UploadedFilesParse =
  | { ok: true; files: UploadedFileRef[] }
  | { ok: false; code: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The URL if it may be fetched at all: https, default port, no credentials. */
export function fetchableFileUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.port !== "" && url.port !== "443") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url.href;
}

export function parseUploadedFiles(tool: string, raw: unknown): UploadedFilesParse {
  if (raw === undefined || raw === null) return { ok: true, files: [] };
  // A single file object is accepted as a list of one: OpenAI documents a
  // file param as "a file object or an array of file objects".
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length > UPLOADED_FILES_MAX_ITEMS) {
    return {
      ok: false,
      code: "-32602",
      message: `${tool}: files must not exceed ${UPLOADED_FILES_MAX_ITEMS} items per call.`,
    };
  }
  const files: UploadedFileRef[] = [];
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (!isRecord(entry)) {
      return { ok: false, code: "-32602", message: `${tool}: files[${i}] must be an object.` };
    }
    const url = fetchableFileUrl(entry["download_url"]);
    if (url === null) {
      return {
        ok: false,
        code: "-32602",
        message: `${tool}: files[${i}].download_url must be an https URL on the standard port, with no user name or password.`,
      };
    }
    const fileId = typeof entry["file_id"] === "string" ? entry["file_id"].trim() : "";
    if (!fileId) {
      return { ok: false, code: "-32602", message: `${tool}: files[${i}].file_id is required.` };
    }
    const mime = typeof entry["mime_type"] === "string" ? entry["mime_type"].trim() : "";
    const name = typeof entry["file_name"] === "string" ? entry["file_name"].trim() : "";
    files.push({
      download_url: url,
      file_id: fileId,
      ...(mime ? { mime_type: mime } : {}),
      ...(name ? { file_name: name } : {}),
    });
  }
  return { ok: true, files };
}

// ---------------------------------------------------------------------------
// Names and types
// ---------------------------------------------------------------------------

const EXTENSION_BY_TYPE: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "text/csv": ".csv",
  "text/plain": ".txt",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/** `type/subtype` lowercased, or null when it is not one. Parameters dropped. */
export function cleanMediaType(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.split(";")[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value) ? value : null;
}

/**
 * The filename the recipient sees. Control characters and path separators are
 * removed (the MIME builder neutralises header syntax on its own; this is
 * about what a mail client would do with "../" or a NUL), and an empty or
 * missing name becomes "attachment" plus an extension for the type.
 */
export function uploadedFileName(raw: string | undefined, mimeType: string): string {
  // deno-lint-ignore no-control-regex
  const cleaned = (raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\/]/g, "_").trim()
    .slice(0, 200);
  if (cleaned && cleaned !== "." && cleaned !== "..") return cleaned;
  return `attachment${EXTENSION_BY_TYPE[mimeType] ?? ""}`;
}

// ---------------------------------------------------------------------------
// Downloading `files`
// ---------------------------------------------------------------------------

/** A download failed. `code` is the tool error code; nothing was written. */
export class UploadedFileError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "UploadedFileError";
  }
}

export interface UploadedFileFetcherOptions {
  /** Test seams. */
  fetch?: typeof fetch;
  lookup?: HostLookup;
  deadlineMs?: number;
}

export interface DownloadedFile extends OutgoingAttachment {
  size_bytes: number;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Build the downloader. `budgetBytes` is what is left of the call's total; a
 * file that would exceed it is refused while it is being read, so a lying or
 * absent Content-Length cannot make the isolate hold more than that.
 */
export function createUploadedFileFetcher(
  options: UploadedFileFetcherOptions = {},
): (tool: string, position: number, ref: UploadedFileRef, budgetBytes: number) => Promise<DownloadedFile> {
  const doFetch = options.fetch ?? fetch;

  const hostAllowed = async (hostname: string): Promise<boolean> => {
    // The mail-host guard's ADDRESS policy (every resolved address public,
    // every literal encoding understood); its port rule is about mail and is
    // met with a constant, as in signature-images.ts. The URL's own port is
    // pinned to 443 by fetchableFileUrl.
    const verdict = await guardMailHost(hostname, {
      protocol: "imap",
      port: 993,
      ...(options.lookup ? { lookup: options.lookup } : {}),
    });
    return verdict.ok;
  };

  return async (tool, position, ref, budgetBytes) => {
    const where = `${tool}: files[${position}]${ref.file_name ? ` ('${ref.file_name}')` : ""}`;
    const unavailable = () =>
      new UploadedFileError(
        "file_unavailable",
        `${where} could not be downloaded, so the draft was not saved. The ` +
          "link ChatGPT provides expires after a few minutes; share the file " +
          "again and retry.",
      );
    const tooLarge = () =>
      new UploadedFileError(
        "attachment_too_large",
        `${where} would take the draft's new attachments past 10 MB, so the ` +
          "draft was not saved.",
      );
    const signal = AbortSignal.timeout(options.deadlineMs ?? FETCH_DEADLINE_MS);
    let current = ref.download_url;
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const safe = fetchableFileUrl(current);
        if (safe === null) throw unavailable();
        if (!(await hostAllowed(new URL(safe).hostname))) throw unavailable();
        const resp = await doFetch(safe, { redirect: "manual", signal });
        if (resp.status >= 300 && resp.status < 400) {
          const location = resp.headers.get("location");
          await resp.body?.cancel().catch(() => {});
          if (!location) throw unavailable();
          current = new URL(location, safe).href;
          continue;
        }
        if (resp.status !== 200 || !resp.body) {
          await resp.body?.cancel().catch(() => {});
          throw unavailable();
        }
        const declared = Number(resp.headers.get("content-length") ?? "");
        if (Number.isFinite(declared) && declared > budgetBytes) {
          await resp.body.cancel().catch(() => {});
          throw tooLarge();
        }
        const reader = resp.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > budgetBytes) {
            await reader.cancel().catch(() => {});
            throw tooLarge();
          }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const mimeType = cleanMediaType(ref.mime_type) ??
          cleanMediaType(resp.headers.get("content-type")) ?? "application/octet-stream";
        return {
          filename: uploadedFileName(ref.file_name, mimeType),
          mime_type: mimeType,
          data: bytesToBase64(bytes),
          size_bytes: size,
        };
      }
      throw unavailable();
    } catch (error) {
      if (error instanceof UploadedFileError) throw error;
      console.warn("[mcp-server] uploaded_file_fetch_failed", {
        host: (() => {
          try {
            return new URL(current).hostname;
          } catch {
            return null;
          }
        })(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw unavailable();
    }
  };
}

// ---------------------------------------------------------------------------
// Carrying a stored draft's files through a rebuild
// ---------------------------------------------------------------------------

export interface CarriedAttachments {
  /** How many files a rebuild keeps. */
  count: number;
  /** Their decoded size. */
  bytes: number;
  /**
   * Named parts the stored HTML shows through `cid:`. Not carried, and not
   * counted above; see the header.
   */
  inlineImages: number;
  /** Each file's decoded size, in the order `encode` returns them. */
  sizes: number[];
  /**
   * The files, encoded on demand: most reads never write. `skip` holds the
   * positions of files to leave out (the editor card's remove, 2026-10-17);
   * every other file is re-encoded from its own decoded bytes, so what the
   * rebuilt message carries is byte for byte what the stored one had.
   */
  encode(skip?: ReadonlySet<number>): OutgoingAttachment[];
}

/** The `cid:` references an HTML body makes, lowercased, brackets stripped. */
function referencedContentIds(html: string | null): Set<string> {
  const ids = new Set<string>();
  if (!html) return ids;
  for (const match of html.matchAll(/cid:([^"'\s>)]+)/gi)) {
    let id = match[1];
    try {
      id = decodeURIComponent(id);
    } catch {
      // Left as written.
    }
    ids.add(id.replace(/^<|>$/g, "").toLowerCase());
  }
  return ids;
}

/** What a rebuild of a parsed stored draft keeps of its files. */
export function carriedAttachmentsOf(
  parsed: { html: string | null; attachments: readonly MimeAttachment[] },
): CarriedAttachments {
  const referenced = referencedContentIds(parsed.html);
  const files: MimeAttachment[] = [];
  let inlineImages = 0;
  for (const attachment of parsed.attachments) {
    const cid = attachment.contentId?.toLowerCase();
    if (cid && referenced.has(cid)) {
      inlineImages++;
      continue;
    }
    files.push(attachment);
  }
  return {
    count: files.length,
    bytes: files.reduce((total, file) => total + file.content.length, 0),
    inlineImages,
    sizes: files.map((file) => file.content.length),
    encode: (skip) =>
      files.filter((_, i) => !skip?.has(i)).map((file) => ({
        filename: file.filename,
        mime_type: cleanMediaType(file.mimeType) ?? "application/octet-stream",
        data: bytesToBase64(file.content),
      })),
  };
}

/** "2 files (1.4 MB)" style size, for messages. */
export function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
