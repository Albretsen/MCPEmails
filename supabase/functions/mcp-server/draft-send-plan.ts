// ---------------------------------------------------------------------------
// What `draft{action:"send"}` does with the id it was handed, once the lineage
// has resolved it (draft-lineage.ts). The decision only: the provider calls,
// the approval queue and the refusal texts stay in index.ts#executeSendDraft.
//
// A separate module because index.ts cannot be imported by a test (it calls
// `Deno.serve` and builds a service-role client at module load), and these four
// rules are the ones that decide whether a message goes out twice or goes out
// with content the person never saw (review of 2026-10-13):
//
//   1. an APPROVED held send keeps the id it was queued with. Following the
//      line would send a version written after the reviewer approved.
//   2. a line closed by a send is never sent again (`draft_already_sent`).
//   3. a send from the draft editor card (it carries `base_revision`) against
//      an older id or a rewritten draft is refused (`draft_changed`).
//   4. a held send is queued with the RESOLVED id, which is what the approval
//      summary reads and what the post-approval re-run sends.
// ---------------------------------------------------------------------------

import { cardWriteConflict, type ResolvedDraft } from "./draft-lineage.ts";

export type DraftSendPlan =
  | { kind: "refuse"; code: "draft_already_sent"; sentCopyKept: boolean }
  | { kind: "refuse"; code: "draft_changed" }
  | {
    kind: "proceed";
    /** The id to send (and to queue an approval for). */
    draftId: string;
    /** The line as the rest of the send should see it. */
    line: ResolvedDraft;
    /** What a held send is queued with. The recipient override is applied later. */
    approvalArgs: Record<string, unknown>;
  };

export function planDraftSend(input: {
  args: Record<string, unknown>;
  line: ResolvedDraft;
  /** `base_revision` as parsed: null when the caller did not send one. */
  baseRevision: number | null;
  /** The dispatcher re-running a send a reviewer approved. */
  approvalDispatch: boolean;
}): DraftSendPlan {
  let line = input.line;
  // Rule 1: an approved send sends the draft that was approved, or fails as
  // not found if that id has since been rewritten (IMAP).
  if (input.approvalDispatch && line.redirected) {
    line = { ...line, draftId: line.requestedId, redirected: false };
  }
  // Rule 2.
  if (line.closed === "sent") {
    return { kind: "refuse", code: "draft_already_sent", sentCopyKept: line.sentCopyKept === true };
  }
  // Rule 3. Only a card send carries `base_revision`; a model's send may follow
  // the line, which is what it asked for.
  if (input.baseRevision !== null && cardWriteConflict(line, input.baseRevision)) {
    return { kind: "refuse", code: "draft_changed" };
  }
  // Rule 4.
  return {
    kind: "proceed",
    draftId: line.draftId,
    line,
    approvalArgs: { ...input.args, draft_id: line.draftId },
  };
}
