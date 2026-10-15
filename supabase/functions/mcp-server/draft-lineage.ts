// ---------------------------------------------------------------------------
// Draft lineage: which draft id is the CURRENT one for a draft that has been
// rewritten (CONCEPT-draft-editor.md §5, phase 1).
//
// On IMAP every save APPENDs a new message and expunges the old one, so the
// draft gets a new id each time. A card or a model still holding an older id
// then met `draft_not_found` although the draft was sitting in the mailbox
// under a newer id: a reloaded card re-reads the id of its first tool result,
// and a save whose response was lost is retried with the id it was sent with.
//
// A line is every id one draft has had. Each write appends a row (or, where the
// provider keeps the id, bumps the row), and every draft action first asks
// "what is the current id for the one I was given".
//
// WHAT IS STORED: draft ids, a counter, who wrote last, and when. No subject,
// no recipients, no body and no hash of one. The concept sketch listed
// `subject` and `body_sha256`; they were for the conflict rule, which is not
// built, and the product promise is that mail content is not stored.
//
// FAIL SOFT, EVERYWHERE. Lineage is bookkeeping around a provider call that is
// the user's actual request. A read that fails resolves the id to itself (the
// behaviour before this module existed); a write that fails is logged and
// dropped. Nothing here throws, including against a database where the
// `draft_lineage` table does not exist yet.
//
// TENANCY. Every store call carries workspace AND inbox, and the store applies
// both as filters. The inbox comes from `resolveInboxArg`, never from a caller
// argument directly, so one tenant cannot resolve another's ids.
//
// Pure apart from the injected store, so it is testable without a database.
// ---------------------------------------------------------------------------

export type DraftWriter = "agent" | "user";
export type DraftLineCloseReason = "sent" | "deleted";
/**
 * What `closed_reason` may hold. `sent_kept` is a send whose draft could not be
 * removed from Drafts afterwards (IMAP: the post-send delete is best-effort), so
 * the sent message's draft copy is still there under the line's id. Readers see
 * it as `closed: "sent"` with `sentCopyKept: true`.
 */
export type DraftLineStoredReason = DraftLineCloseReason | "sent_kept";

/** One row of `public.draft_lineage`, as far as this module reads it. */
export interface DraftLineageRow {
  line_id: string;
  draft_id: string;
  revision: number;
  written_by: DraftWriter;
  written_at: string;
  closed_at: string | null;
  closed_reason: DraftLineStoredReason | null;
}

/**
 * One write to record, as `public.draft_lineage_record` takes it.
 *
 *   lineId + expectedRevision  continue that line. The revision is computed by
 *                              the store, not by the caller: max + 1 inside one
 *                              locked statement, so two writers can never both
 *                              get N+1 (review 2 of 2026-10-13).
 *   seedDraftId                start a new line holding this older id first
 *                              (a draft made before lineage, or in a mail
 *                              client, that a write then moved).
 *   adopt                      the caller found no line for an id that the
 *                              write did not change. If, by the time the row
 *                              is written, that id IS the head of an open line
 *                              (somebody started one meanwhile, or the
 *                              caller's read failed), continue that line rather
 *                              than starting a second one that resets the
 *                              revision to 1.
 */
export interface DraftLineageRecord {
  lineId: string | null;
  expectedRevision: number | null;
  draftId: string;
  seedDraftId: string | null;
  adopt: boolean;
  writtenBy: DraftWriter;
  writtenAt: string;
}

/**
 * What the store did with a `DraftLineageRecord`.
 *
 * `contended` is true when the line was not where the caller left it: another
 * write was recorded between the caller's read and this one (the line's head
 * revision was not `expectedRevision`), the line was closed meanwhile, or an
 * adopted line was started by somebody else. The row is written either way;
 * the revision it got does not describe content the caller can vouch for,
 * because the provider writes may have landed in the other order.
 */
export interface DraftLineageRecorded {
  lineId: string;
  revision: number;
  contended: boolean;
}

export interface DraftLineageScope {
  workspaceId: string;
  inboxId: string;
}

/** The four operations. Each may throw; callers here catch. */
export interface DraftLineageStore {
  /** The row for exactly this draft id, or null. */
  find(scope: DraftLineageScope, draftId: string): Promise<DraftLineageRow | null>;
  /** The highest-revision row of a line, or null. */
  head(scope: DraftLineageScope, lineId: string): Promise<DraftLineageRow | null>;
  /**
   * Record one write ATOMICALLY: decide the line, compute the next revision
   * and write the row(s) as one step (`public.draft_lineage_record`, under a
   * per-inbox advisory lock). A row whose (inbox, draft_id) exists is moved
   * and reopened.
   */
  record(scope: DraftLineageScope, write: DraftLineageRecord): Promise<DraftLineageRecorded>;
  /** Mark every row of a line closed. */
  close(
    scope: DraftLineageScope,
    lineId: string,
    reason: DraftLineStoredReason,
    at: string,
  ): Promise<void>;
}

/**
 * The `draft_lineage_record` RPC's answer (PostgREST returns the function's
 * one row as an array), checked. Throws on anything else, which the callers
 * here treat like any other store failure.
 */
export function draftLineageRecordedFrom(data: unknown): DraftLineageRecorded {
  const row = Array.isArray(data) ? data[0] : data;
  if (row && typeof row === "object") {
    const r = row as Record<string, unknown>;
    if (
      typeof r.recorded_line_id === "string" && r.recorded_line_id.length > 0 &&
      typeof r.recorded_revision === "number" && Number.isInteger(r.recorded_revision) &&
      r.recorded_revision >= 1 && typeof r.contended === "boolean"
    ) {
      return { lineId: r.recorded_line_id, revision: r.recorded_revision, contended: r.contended };
    }
  }
  throw new Error("draft_lineage_record returned no usable row");
}

/** What a draft action learns about the id it was handed. */
export interface ResolvedDraft {
  /** The id the caller passed. */
  requestedId: string;
  /** The id to act on: the line's current id, or `requestedId` when unknown. */
  draftId: string;
  /** True when `draftId` differs from `requestedId`. */
  redirected: boolean;
  /** True when the id is in a line at all. */
  known: boolean;
  lineId: string | null;
  revision: number;
  writtenBy: DraftWriter | null;
  writtenAt: string | null;
  /** Set when the line ended in a send or a delete. Never redirected. */
  closed: DraftLineCloseReason | null;
  /**
   * The line ended in a send and the draft copy was NOT removed from Drafts,
   * so the id may still name a message: the one that was sent. See
   * `preferExistingId`.
   */
  sentCopyKept?: boolean;
  /** When the line was closed, for a closed line whose store reported it. */
  closedAt?: string | null;
}

type Logger = (event: string, details: Record<string, unknown>) => void;

const defaultLog: Logger = (event, details) => {
  console.warn(`[mcp-server] ${event}`, details);
};

function unknownDraft(draftId: string): ResolvedDraft {
  return {
    requestedId: draftId,
    draftId,
    redirected: false,
    known: false,
    lineId: null,
    revision: 0,
    writtenBy: null,
    writtenAt: null,
    closed: null,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve any id in a line to the current one. Never throws.
 *
 * A CLOSED line is not redirected: the draft was sent or deleted, there is no
 * current id, and the caller is told so (`closed`) rather than pointed at an id
 * that no longer names a draft.
 */
export async function resolveDraftId(
  store: DraftLineageStore | null | undefined,
  scope: DraftLineageScope,
  draftId: string,
  log: Logger = defaultLog,
): Promise<ResolvedDraft> {
  if (!store) return unknownDraft(draftId);
  try {
    const row = await store.find(scope, draftId);
    if (!row) return unknownDraft(draftId);
    // The row may be an older id of the line, so ask for the head. A head that
    // cannot be read (it always exists when `row` does) falls back to the row.
    const head = (await store.head(scope, row.line_id)) ?? row;
    const stored = head.closed_at ? (head.closed_reason ?? "deleted") : null;
    const closed: DraftLineCloseReason | null = stored === null
      ? null
      : stored === "deleted"
      ? "deleted"
      : "sent";
    const current = closed ? draftId : head.draft_id;
    return {
      requestedId: draftId,
      draftId: current,
      redirected: current !== draftId,
      known: true,
      lineId: head.line_id,
      revision: head.revision,
      writtenBy: head.written_by,
      writtenAt: head.written_at,
      closed,
      ...(stored === "sent_kept" ? { sentCopyKept: true } : {}),
      ...(closed && head.closed_at ? { closedAt: head.closed_at } : {}),
    };
  } catch (error) {
    log("draft_lineage_resolve_failed", { inbox_id: scope.inboxId, error: message(error) });
    return unknownDraft(draftId);
  }
}

/**
 * Settle a resolution against whether the REQUESTED id still names a message.
 *
 * Lineage maps an id to its line, and a provider id can name a different
 * message later than the one we recorded: an IMAP mailbox whose UIDVALIDITY was
 * reset numbers its messages again from 1, and a draft made in a mail client
 * can land on an id an old line once held. So the lineage answer is only
 * trusted where it does not contradict the mailbox:
 *
 *   * an OLDER id of an open line (a redirect) that still names a message is
 *     that message, not the line's head. On IMAP the old message is expunged
 *     by every save, so a stale id that resolves normally names nothing; one
 *     that does name something is a reused id (or a copy an expunge left),
 *     and acting on the head instead would act on some other draft.
 *   * an id of a line closed by a DELETE, or by a send that removed its draft,
 *     that still names a message is a reused id, and is a draft like any other.
 *   * an id of a line closed by a send that could NOT remove its draft
 *     (`sentCopyKept`) stays closed: the message there is the copy of what was
 *     sent, and sending it again is the duplicate this exists to stop.
 *
 * "Unknown" is the answer for a reused id: the next write starts a new line for
 * it (`recordDraftWrite`), which is what the store's upsert already does for an
 * id that turns up again.
 *
 * Pure. The caller asks the mailbox, and only when it matters: on a redirect or
 * a closed line, which is rare, so the common path costs no extra read.
 */
export function preferExistingId(
  line: ResolvedDraft,
  requestedExists: boolean,
): ResolvedDraft {
  if (!requestedExists) return line;
  if (line.closed === "sent" && line.sentCopyKept) return line;
  if (line.redirected || line.closed) return unknownDraft(line.requestedId);
  return line;
}

/** True when settling this resolution needs to know whether the requested id exists. */
export function needsExistenceCheck(line: ResolvedDraft): boolean {
  return line.redirected || line.closed !== null;
}

/**
 * Record that a draft was written and now has id `draftId`. Never throws.
 *
 * `previous` is what `resolveDraftId` returned for the id the write acted on,
 * resolved BEFORE the provider write, or null for a brand-new draft.
 *
 *   * known, open line   -> the next revision of that line.
 *   * unknown id         -> a new line. When the write changed the id, the old
 *                           id is recorded as revision 1 so it resolves from
 *                           now on (a draft made before lineage, or in a mail
 *                           client, that we then rewrote).
 *   * closed line        -> a new line holding only the new id. The old line
 *                           stays closed.
 *
 * The revision itself is computed by the store in one locked step
 * (`DraftLineageStore#record`), never as `previous.revision + 1` here: two
 * writers that read the same revision both wrote N+1, and a card holding N+1
 * then passed the `base_revision` check against content it never saw (review 2
 * of 2026-10-13).
 *
 * A line id is a fresh UUID rather than the first draft id, so a line can never
 * collide with rows left over from an older one.
 *
 * Returns the revision the draft now has, or null when nothing trustworthy can
 * be said: no store, an id that is not a real id, the write failed, or the
 * record was CONTENDED (another write was recorded on the line after
 * `previous` was read). In that last case the row is written, but the provider
 * writes may have landed in either order, so the caller is not told a revision
 * it could vouch for: the editor envelope then carries none (or the one the
 * card already had), the line's head is past it, and the card's next save or
 * send is refused as `draft_changed` until it re-reads.
 */
export async function recordDraftWrite(
  store: DraftLineageStore | null | undefined,
  scope: DraftLineageScope,
  input: {
    previous: ResolvedDraft | null;
    draftId: string;
    writtenBy: DraftWriter;
    at?: string;
  },
  log: Logger = defaultLog,
): Promise<number | null> {
  if (!store || !input.draftId) return null;
  const at = input.at ?? new Date().toISOString();
  const previous = input.previous;
  try {
    const continuing = previous !== null && previous.known && previous.closed === null &&
      previous.lineId !== null;
    const unknownBefore = previous !== null && !previous.known;
    const recorded = await store.record(scope, {
      lineId: continuing ? previous!.lineId : null,
      expectedRevision: continuing ? previous!.revision : null,
      draftId: input.draftId,
      seedDraftId: unknownBefore && previous!.draftId !== input.draftId ? previous!.draftId : null,
      adopt: unknownBefore && previous!.draftId === input.draftId,
      writtenBy: input.writtenBy,
      writtenAt: at,
    });
    if (recorded.contended) {
      log("draft_lineage_write_contended", {
        inbox_id: scope.inboxId,
        revision: recorded.revision,
      });
      return null;
    }
    return recorded.revision;
  } catch (error) {
    log("draft_lineage_write_failed", { inbox_id: scope.inboxId, error: message(error) });
    return null;
  }
}

/**
 * True when `draftId` names a message the provider confirmed, so it may go into
 * the lineage.
 *
 * IMAP ids are `<folder>:<uid>`. When the server answers an APPEND without
 * APPENDUID and the Message-ID search then finds nothing, the write path still
 * returns `<folder>:0` (that is what the model has always been handed, so it
 * stays). Uid 0 names no message, and every unconfirmed write would share it:
 * recorded, it joined unrelated drafts into one line. So it is not recorded
 * (review 2 of 2026-10-13); the write stands, its line just does not move.
 * Gmail and Outlook ids are opaque and always confirmed.
 */
export function draftIdIsRecordable(provider: string, draftId: string): boolean {
  if (!draftId) return false;
  if (provider === "gmail" || provider === "outlook") return true;
  const at = draftId.lastIndexOf(":");
  const uid = Number(at === -1 ? draftId : draftId.slice(at + 1));
  return Number.isInteger(uid) && uid > 0;
}

/**
 * Close a line after a send or a delete. Never throws.
 *
 * A draft with no line yet gets a one-row closed line, so a card still holding
 * its id is told what happened to it instead of "not found".
 */
export async function closeDraftLine(
  store: DraftLineageStore | null | undefined,
  scope: DraftLineageScope,
  resolved: ResolvedDraft,
  reason: DraftLineStoredReason,
  at: string = new Date().toISOString(),
  log: Logger = defaultLog,
): Promise<void> {
  if (!store) return;
  try {
    let lineId = resolved.known ? resolved.lineId : null;
    if (!lineId) {
      // `adopt`: if a line has appeared for this id since it was resolved (or
      // the resolve failed), close that one rather than leaving it open.
      lineId = (await store.record(scope, {
        lineId: null,
        expectedRevision: null,
        draftId: resolved.draftId,
        seedDraftId: null,
        adopt: true,
        writtenBy: "agent",
        writtenAt: at,
      })).lineId;
    }
    await store.close(scope, lineId, reason, at);
  } catch (error) {
    log("draft_lineage_close_failed", { inbox_id: scope.inboxId, error: message(error) });
  }
}

// ---------------------------------------------------------------------------
// Writes that come from the draft editor card: never follow a redirect
// ---------------------------------------------------------------------------

/**
 * The revision to publish for a resolved draft (`draft.revision` in the editor
 * envelope), or null when no open line names it.
 */
export function lineRevision(line: ResolvedDraft): number | null {
  return line.known && line.closed === null ? line.revision : null;
}

/**
 * `base_revision` as a caller passed it: null when absent, a non-negative
 * integer when valid, and `"invalid"` for anything else.
 */
export function parseBaseRevision(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  return "invalid";
}

/**
 * Has the draft moved on since the card that is writing (or sending) loaded it?
 *
 * Lineage lets a READ follow an old id to the current draft, and a reloaded
 * card needs exactly that. A WRITE from a card must not (review of 2026-10-13):
 * a card still showing revision 1 of a draft the assistant has since rewritten
 * would put its body over the newer one, and a send would deliver recipients
 * and wording the person never saw. So a card write is refused when:
 *
 *   * the id it holds is an OLDER id of the line (IMAP moved it), or
 *   * it says which revision it loaded (`base_revision`, 0 for "no recorded
 *     revision") and the line is now at another one. This is what covers Gmail
 *     and Outlook, where the id never moves and the first rule cannot fire.
 *
 * A revision rather than the envelope's content `version`: the version of a
 * write's own answer is computed from what was SENT to the provider, and a
 * provider hands content back normalised (Outlook rewrites the HTML), so a
 * fresh read of a draft nobody touched can carry another version and every
 * Save-and-send would be refused. The revision is our own counter, bumped by
 * every write that goes through this server and by nothing else.
 *
 * Fail soft, like everything here: an id the lineage cannot place (unknown,
 * the store unreadable, a reused id) is never refused on revision.
 */
export function cardWriteConflict(line: ResolvedDraft, baseRevision: number | null): boolean {
  if (line.redirected) return true;
  if (baseRevision === null || !line.known || line.closed !== null) return false;
  return line.revision !== baseRevision;
}

/** How far a provider's own timestamp may trail ours before it means "edited elsewhere". */
const EXTERNAL_EDIT_TOLERANCE_MS = 2 * 60 * 1000;

/**
 * Who saved a stored draft last, and when, as truthfully as can be known.
 *
 * `providerSavedAt` is the mailbox's own timestamp for the stored message when
 * the provider gives one. When it is clearly later than our last recorded
 * write, somebody changed the draft outside these tools (a mail client), so the
 * writer is unknown rather than whoever we last saw.
 */
export function lastSaveOf(
  line: ResolvedDraft | null,
  providerSavedAt: string | null | undefined,
): { at: string | null; by: DraftWriter | null } {
  const providerMs = providerSavedAt ? Date.parse(providerSavedAt) : NaN;
  const lineMs = line?.writtenAt ? Date.parse(line.writtenAt) : NaN;
  const hasProvider = Number.isFinite(providerMs);
  const hasLine = line !== null && line.known && Number.isFinite(lineMs);
  if (!hasLine) {
    return { at: hasProvider ? new Date(providerMs).toISOString() : null, by: null };
  }
  if (hasProvider && providerMs - lineMs > EXTERNAL_EDIT_TOLERANCE_MS) {
    return { at: new Date(providerMs).toISOString(), by: null };
  }
  return { at: new Date(lineMs).toISOString(), by: line!.writtenBy };
}
