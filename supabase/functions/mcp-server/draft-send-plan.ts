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
//      summary reads and what the post-approval re-run sends, AND with the
//      revision the draft had when it was queued (`base_revision`), so the
//      re-run refuses a draft rewritten after the approval was asked for
//      (review 2 of 2026-10-13: on Gmail and Outlook the id never moves, so
//      rule 1 alone sent whatever the draft said at approval time).
//
// And, for a send-time recipient override (`applyRecipientOverride`):
//
//   5. the rewrite of the stored recipients is recorded in the lineage EVERY
//      time, also when the id did not move (Gmail, Outlook). A rewrite that was
//      not recorded left the draft at its old revision with new recipients, so
//      a card at that revision could Send to people it never showed, after the
//      model's send was held or failed.
// ---------------------------------------------------------------------------

import { cardWriteConflict, lineRevision, type ResolvedDraft } from "./draft-lineage.ts";
import {
  APPROVED_DRAFT_CHANGED_DETAIL,
  APPROVED_DRAFT_UNREADABLE_DETAIL,
  APPROVED_DRAFT_UNVERIFIED_DETAIL,
} from "./draft-send-snapshot.ts";

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
  // Rule 3. A card send carries `base_revision`, and so does the re-run of an
  // approved send (rule 4); a model's own send does not, and may follow the
  // line, which is what it asked for.
  if (input.baseRevision !== null && cardWriteConflict(line, input.baseRevision)) {
    return { kind: "refuse", code: "draft_changed" };
  }
  // Rule 4.
  return {
    kind: "proceed",
    draftId: line.draftId,
    line,
    approvalArgs: heldSendArgs(input.args, line.draftId, line, false),
  };
}

/**
 * What a held `draft{action:"send"}` is queued with: the caller's arguments,
 * the resolved id, and ALWAYS a `base_revision` the SERVER chose.
 *
 * The revision is the line's as it is now (`lineRevision`), or 0 ("no recorded
 * revision") when no open line names the draft: a line that exists by the time
 * of the re-run means something wrote the draft after it was queued, and the
 * re-run is refused as `draft_changed` (draft-lineage.ts#cardWriteConflict). A
 * lineage read that failed at queue time can therefore refuse an approved send
 * that was fine; that is the safe direction, and the approver is told why.
 *
 * NEVER the caller's own `base_revision` (security review 2026-10-16, F-04-03).
 * For a draft no line names (a Gmail or Outlook draft written in the mail
 * client) the caller could pass `base_revision: 1`, rewrite the draft (which
 * adopts it into a new line at revision 1), and the re-run's check compared 1
 * to 1 and sent the rewritten draft. The caller's value is checked against the
 * line (planDraftSend, rule 3) and then dropped. The approval's content digest
 * (draft-send-snapshot.ts) is the second, provider-independent check.
 *
 * `recipientsApplied`: the send-time `to`/`cc`/`bcc` were written into the
 * stored draft already, so the re-run must not write them again (on IMAP the
 * id they would be written to no longer exists).
 */
export function heldSendArgs(
  args: Record<string, unknown>,
  draftId: string,
  line: ResolvedDraft,
  recipientsApplied: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args, draft_id: draftId };
  if (recipientsApplied) {
    delete out["to"];
    delete out["cc"];
    delete out["bcc"];
  }
  out["base_revision"] = lineRevision(line) ?? 0;
  return out;
}

/** The provider and lineage calls `applyRecipientOverride` needs, injected. */
export interface RecipientOverrideDeps {
  /** Write the override into the stored draft. Resolves to the id afterwards; throws as the provider does. */
  rewrite(draftId: string): Promise<string>;
  /** Record a write on `previous`'s line (draft-lineage.ts#recordDraftWrite). Never throws. */
  record(previous: ResolvedDraft, draftId: string): Promise<number | null>;
  /** Resolve an id (draft-lineage.ts#resolveDraftId). Never throws. */
  resolve(draftId: string): Promise<ResolvedDraft>;
}

/**
 * Rule 5: apply a send-time recipient override BEFORE anything else looks at
 * the draft, record it, and say what a held send is then queued with.
 *
 * Throws whatever `rewrite` throws; nothing is recorded then, because nothing
 * was written.
 */
export async function applyRecipientOverride(
  input: {
    args: Record<string, unknown>;
    draftId: string;
    line: ResolvedDraft;
    baseRevision: number | null;
  },
  deps: RecipientOverrideDeps,
): Promise<{ draftId: string; line: ResolvedDraft; approvalArgs: Record<string, unknown> }> {
  const rewrittenId = await deps.rewrite(input.draftId);
  // Recorded whether or not the id moved: the recipients changed, so the
  // revision must, or a card at the old revision would still pass its check.
  // On IMAP it also keeps the id the caller holds resolving if this send is
  // then held.
  await deps.record(input.line, rewrittenId);
  const line = await deps.resolve(rewrittenId);
  return {
    draftId: rewrittenId,
    line,
    approvalArgs: heldSendArgs(input.args, rewrittenId, line, true),
  };
}

/**
 * The `scheduled_sends.error_detail` an approved send leaves when its re-run
 * is refused, in words for the person who approved it (the dashboard shows
 * it). Null for any other code: the caller keeps its generic sentence.
 */
export function approvedSendRefusalDetail(
  operation: string,
  code: string | null,
): string | null {
  if (operation !== "draft_send") return null;
  switch (code) {
    case "draft_changed":
      return "Not sent. The draft was changed after this send was approved, so the approved " +
        "version no longer exists. Review the draft and send it again.";
    case "draft_not_found":
      return "Not sent. The draft was changed or removed after this send was approved. " +
        "Review the draft and send it again.";
    case "draft_already_sent":
      return "Not sent again. This draft had already been sent.";
    case "approved_draft_changed":
      return APPROVED_DRAFT_CHANGED_DETAIL;
    case "approved_draft_unverified":
      return APPROVED_DRAFT_UNVERIFIED_DETAIL;
    case "approved_draft_unreadable":
      return APPROVED_DRAFT_UNREADABLE_DETAIL;
    default:
      return null;
  }
}
