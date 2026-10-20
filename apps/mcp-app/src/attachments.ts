// ---------------------------------------------------------------------------
// attachments.ts - the draft's files as the card edits them (2026-10-17).
//
// Until now the card showed one muted line, "1 attachment: notes.txt 18 B",
// and could do nothing with it. Now each file is a chip that can be removed,
// and a file can be attached. Both are EDITS like any other: nothing is
// written until Save (or Send, which saves first), the footer says "Unsaved
// changes", and the server does the work in `draft_editor_save`
// (`add_attachments`, `remove_attachments`; mcp-app-drafts.ts).
//
// What is NOT kept, on purpose:
//
//   - across a reload. unsaved.ts stashes the text fields in sessionStorage,
//     and a file of up to 5 MB of base64 does not belong there. A reload
//     shows the draft's files as stored; the person attaches again.
//   - by the teardown save. A dirty card writes its text when the host tears
//     the frame down; it does not upload a file nobody is watching.
//
// Opening or downloading a file is not offered: the card holds the files'
// names and sizes, never their bytes (the envelope is metadata only), and
// getting them would need a server read made for it plus a host download
// (`ui/download-file` is not in the published MCP Apps spec this card
// targets). Left for later rather than half done.
// ---------------------------------------------------------------------------

import type { Attachment } from "./contract";

/**
 * The most the card attaches in one save, decoded. Below the server's 10 MB
 * (mcp-app-drafts.ts#EDITOR_ADD_MAX_BYTES) because the upload crosses the
 * host's message channel as base64 first (a third larger), and that channel's
 * limit is the host's and unknown. 5 MB is also clear of the size at which an
 * inline file once crashed the server's base64 check (fixed 2026-10-15).
 */
export const CARD_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

/** A stored file the person asked to remove, named the way the server checks it. */
export interface RemovedFile {
  /** The card's own, so a save can drop exactly the removals it carried. */
  id: string;
  index: number;
  filename: string;
  size_bytes: number | null;
}

/** A file the person attached, not saved yet. `id` is the card's own. */
export interface AddedFile {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  /** Standard base64. */
  data: string;
}

export interface FileEdits {
  removed: RemovedFile[];
  added: AddedFile[];
}

export const NO_FILE_EDITS: FileEdits = { removed: [], added: [] };

export function hasFileEdits(e: FileEdits): boolean {
  return e.removed.length > 0 || e.added.length > 0;
}

/** "18 bytes", "1 byte", "4.5 KB", "1.2 MB". Unknown is "size unknown". */
export function humanSize(n: unknown): string {
  if (typeof n !== "number" || !isFinite(n) || n < 0) return "size unknown";
  if (n === 1) return "1 byte";
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The fields `draft_editor_save` takes for these edits; empty when there are none. */
export function fileEditsPatch(e: FileEdits): {
  add_attachments?: { filename: string; mime_type: string; data: string }[];
  remove_attachments?: { index: number; filename: string; size_bytes: number | null }[];
} {
  return {
    ...(e.removed.length > 0
      ? { remove_attachments: e.removed.map(({ index, filename, size_bytes }) => ({ index, filename, size_bytes })) }
      : {}),
    ...(e.added.length > 0
      ? { add_attachments: e.added.map(({ filename, mime_type, data }) => ({ filename, mime_type, data })) }
      : {}),
  };
}

/**
 * Carry the removals over to a new server copy of the draft.
 *
 * A removal names a file by position AND name, and the server refuses one
 * whose position now holds another file. So when the list moves under the
 * card (the assistant rewrote the draft), each removal is moved to where its
 * file is now, matched by name and size, and dropped when the file is gone
 * (removed elsewhere, or by the save that just landed). Added files are
 * untouched: they are not on the server yet, whatever its list says.
 */
export function rebaseFileEdits(e: FileEdits, now: readonly Attachment[]): FileEdits {
  if (e.removed.length === 0) return e;
  const taken = new Set<number>();
  const removed: RemovedFile[] = [];
  for (const r of e.removed) {
    const same = (a: Attachment, i: number) =>
      !taken.has(i) && a.filename === r.filename && (r.size_bytes === null || a.size_bytes === r.size_bytes);
    // Its old position first, so two files with one name keep their own.
    const at = now[r.index] && same(now[r.index], r.index) ? r.index : now.findIndex(same);
    if (at < 0) continue;
    taken.add(at);
    removed.push({ ...r, index: at });
  }
  return removed.length === e.removed.length && removed.every((r, i) => r.index === e.removed[i].index)
    ? e
    : { ...e, removed };
}

/** A file's bytes as standard base64, without the `data:` prefix. */
export function readAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const url = String(reader.result ?? "");
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}
