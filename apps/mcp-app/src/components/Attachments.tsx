import { useRef } from "preact/hooks";
import type { Attachment } from "../contract";
import { type FileEdits, humanSize } from "../attachments";
import { TextLink } from "./ui";

/**
 * The draft's files, one chip each, under the subject (2026-10-17).
 *
 * It used to be one muted line, "1 attachment: notes.txt 18 B": nothing on it
 * could be seen whole, removed or added. Now:
 *
 *   - each stored file is a chip with its name and a size in words ("18
 *     bytes", "1.2 MB"), and a remove button;
 *   - a removed file STAYS in its place, struck through, with "Undo" where its
 *     remove button was, until Save. So nothing moves under the pointer, and
 *     the second click of a double-click lands on Undo, the safe choice;
 *   - "Attach file" opens the system file picker; a file picked is a dashed
 *     chip until Save. It shows only its size, like a stored file: Send saves
 *     first, so it goes out either way, and a "not saved" mark read as "will
 *     not be sent" (2026-10-27).
 *
 * Every change here is an edit like a changed subject: the footer says
 * "Unsaved changes" and Save writes it (attachments.ts says what is not kept).
 * Outlook cannot remove a file through a save (mcp-app-drafts.ts), so there
 * the stored files have no remove button; attaching works everywhere.
 *
 * What a file is and how big it may be is the caller's business, like the
 * recipients: this component draws and reports, nothing else.
 */
export function AttachmentList(props: {
  items: Attachment[];
  edits: FileEdits;
  canEdit: boolean;
  /** False where a save cannot remove a stored file (Outlook). */
  canRemove: boolean;
  onRemove: (index: number) => void;
  onKeep: (index: number) => void;
  onDropAdded: (id: string) => void;
  onPick: (files: File[]) => void;
  /** A sentence about the last pick (too large, unreadable), or null. */
  note: string | null;
}) {
  const { items, edits, canEdit } = props;
  const picker = useRef<HTMLInputElement>(null);
  if (items.length === 0 && edits.added.length === 0 && !canEdit) return null;
  const removed = new Set(edits.removed.map((r) => r.index));
  const name = (a: { filename: string }) => a.filename || "(unnamed)";

  return (
    <>
      <div class="row">
        <span class="lbl">Files</span>
        <div class="att-list" role="list" aria-label="Attachments">
          {items.map((a, i) => {
            const gone = removed.has(i);
            return (
              <span
                class="chip att"
                role="listitem"
                key={`s-${i}-${a.filename}`}
                data-removed={gone ? "true" : undefined}
                title={`${name(a)}, ${humanSize(a.size_bytes)}`}
              >
                <span class="name">{name(a)}</span>
                <span class="att-size">{humanSize(a.size_bytes)}</span>
                {gone && <span class="sr-only">, removed when you save</span>}
                {canEdit && props.canRemove && (gone ? (
                  <button type="button" class="chip-x att-undo" aria-label={`Keep ${name(a)}`} onClick={() => props.onKeep(i)}>
                    Undo
                  </button>
                ) : (
                  <button type="button" class="chip-x" aria-label={`Remove ${name(a)}`} onClick={() => props.onRemove(i)}>
                    &#215;
                  </button>
                ))}
              </span>
            );
          })}
          {edits.added.map((f) => (
            <span class="chip att" role="listitem" key={f.id} data-new="true" title={`${f.filename}, ${humanSize(f.size_bytes)}`}>
              <span class="name">{f.filename}</span>
              <span class="att-size">{humanSize(f.size_bytes)}</span>
              {canEdit && (
                <button type="button" class="chip-x" aria-label={`Remove ${f.filename}`} onClick={() => props.onDropAdded(f.id)}>
                  &#215;
                </button>
              )}
            </span>
          ))}
          {canEdit && (
            <TextLink title="Attach a file to this draft" onClick={() => picker.current?.click()}>
              Attach file
            </TextLink>
          )}
          {canEdit && (
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              aria-hidden="true"
              tabIndex={-1}
              onChange={(e) => {
                const el = e.target as HTMLInputElement;
                const files = Array.from(el.files ?? []);
                // Cleared, so picking the same file again is a change too.
                el.value = "";
                if (files.length > 0) props.onPick(files);
              }}
            />
          )}
        </div>
      </div>
      {props.note && (
        <div class="notice fld-note" data-tone="warning" role="status" id="d-files-note">
          {props.note}
        </div>
      )}
    </>
  );
}
