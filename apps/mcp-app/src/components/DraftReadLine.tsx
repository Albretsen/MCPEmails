import type { DraftEditorData } from "../contract";
import { TextLink } from "./ui";

/**
 * The whole of a card mounted for the MODEL's `draft_read`, until the person
 * asks for the editor.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * `draft_read` carries the card resource like every draft tool, so the host
 * mounts a card under every read. When the model read a draft back (to check
 * what the person had changed, say) that card was a second full editor for the
 * same draft, and one draft piled up as three cards in a thread (QA
 * 2026-10-15). Two live editors for one draft is also two places to type into
 * it.
 *
 * So a card whose mounting result is a read draws one line: which draft, and
 * a link that opens the full editor here, for a conversation where the
 * original card is gone or far above. The card's own `draft_read` calls never
 * land here (store.ts#mountedForRead), so restore, Refresh and the
 * deferred-body fallback are unchanged.
 *
 * One line, never an empty tree (contract §1): the host draws its widget
 * header over this frame whatever it contains.
 *
 * ── Now a fallback only (2026-10-17) ────────────────────────────────────────
 * `draft_read` is listed without the card's resource URI, so a host that has
 * read the current `tools/list` mounts nothing for a model's read (each
 * revision showed this line AND the write's editor). This stays for a host
 * still holding the older listing. See
 * mcp-app-resources.ts#DRAFT_EDITOR_UNMOUNTED_TOOL_NAMES.
 */
export function DraftReadLine(props: { draft: DraftEditorData; onOpen: () => void }) {
  const d = props.draft;
  const subject = (d.subject ?? "").trim() || "(no subject)";
  const shown = subject.length > 90 ? `${subject.slice(0, 89)}…` : subject;
  const to = d.recipients?.to ?? [];
  const others = to.length - 1 + (d.recipients?.cc?.length ?? 0) + (d.recipients?.bcc?.length ?? 0);
  const who = to[0] ? (others > 0 ? `to ${to[0]} +${others}` : `to ${to[0]}`) : null;
  return (
    <div class="hdr">
      <div class="hdr-l">
        <span class="dot" data-tone="neutral" aria-hidden="true" />
        <b>Draft: {shown}</b>
        {who && <span class="muted">{who}</span>}
      </div>
      <div class="hdr-r">
        <TextLink onClick={props.onOpen} title="Open this draft in the editor here">
          Open editor
        </TextLink>
      </div>
    </div>
  );
}
