// An in-memory UploadStore for the attachment-uploads and files-extension tests.
import type { UploadSlotRow, UploadStore } from "./attachment-uploads.ts";

export function fakeStore() {
  const rows = new Map<string, UploadSlotRow>();
  const objects = new Map<string, Uint8Array>();
  const removed: string[] = [];
  const store: UploadStore = {
    insert(row) {
      rows.set(row.id, { ...row });
      return Promise.resolve();
    },
    get(id) {
      return Promise.resolve(rows.get(id) ?? null);
    },
    markConsumed(id, at) {
      const row = rows.get(id);
      if (row && row.consumed_at === null) row.consumed_at = at;
      return Promise.resolve();
    },
    claim(id, at) {
      const row = rows.get(id);
      if (!row || row.consumed_at !== null) return Promise.resolve(false);
      row.consumed_at = at;
      return Promise.resolve(true);
    },
    signUpload(path) {
      return Promise.resolve(`https://example.supabase.co/storage/v1/object/upload/sign/attachment-uploads/${path}?token=t`);
    },
    download(path) {
      return Promise.resolve(objects.get(path) ?? null);
    },
    objectSize(path) {
      return Promise.resolve(objects.get(path)?.length ?? null);
    },
    listExpired(now, limit) {
      return Promise.resolve([...rows.values()].filter((r) => r.expires_at < now).slice(0, limit));
    },
    removeObjects(paths) {
      for (const p of paths) {
        objects.delete(p);
        removed.push(p);
      }
      return Promise.resolve();
    },
    deleteRows(ids) {
      for (const id of ids) rows.delete(id);
      return Promise.resolve();
    },
  };
  return { store, rows, objects, removed };
}
