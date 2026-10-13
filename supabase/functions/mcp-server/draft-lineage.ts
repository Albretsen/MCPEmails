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

/** A row to insert, or to overwrite where (inbox, draft_id) already exists. */
export interface DraftLineageWrite {
  line_id: string;
  draft_id: string;
  revision: number;
  written_by: DraftWriter;
  written_at: string;
}

export interface DraftLineageScope {
  workspaceId: string;
  inboxId: string;
}

/** The four queries. Each may throw; callers here catch. */
export interface DraftLineageStore {
  /** The row for exactly this draft id, or null. */
  find(scope: DraftLineageScope, draftId: string): Promise<DraftLineageRow | null>;
  /** The highest-revision row of a line, or null. */
  head(scope: DraftLineageScope, lineId: string): Promise<DraftLineageRow | null>;
  /** Insert rows; a row whose (inbox, draft_id) exists is replaced and reopened. */
  upsert(scope: DraftLineageScope, rows: DraftLineageWrite[]): Promise<void>;
  /** Mark every row of a line closed. */
  close(
    scope: DraftLineageScope,
    lineId: string,
    reason: DraftLineStoredReason,
    at: string,
  ): Promise<void>;
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
 * or null for a brand-new draft.
 *
 *   * known, open line   -> the next revision of that line.
 *   * unknown id         -> a new line. When the write changed the id, the old
 *                           id is recorded as revision 1 so it resolves from
 *                           now on (a draft made before lineage, or in a mail
 *                           client, that we then rewrote).
 *   * closed line        -> a new line holding only the new id. The old line
 *                           stays closed.
 *
 * A line id is a fresh UUID rather than the first draft id, so a line can never
 * collide with rows left over from an older one.
 *
 * Returns the revision the draft now has, or null when nothing was recorded
 * (no store, or the write failed). The draft editor envelope carries it as
 * `draft.revision`, and the card sends it back as `base_revision`.
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
    const rows: DraftLineageWrite[] = [];
    if (previous && previous.known && previous.closed === null && previous.lineId) {
      rows.push({
        line_id: previous.lineId,
        draft_id: input.draftId,
        revision: previous.revision + 1,
        written_by: input.writtenBy,
        written_at: at,
      });
    } else {
      const lineId = crypto.randomUUID();
      const seedOld = previous !== null && !previous.known &&
        previous.draftId !== input.draftId;
      if (seedOld) {
        rows.push({
          line_id: lineId,
          draft_id: previous.draftId,
          revision: 1,
          written_by: input.writtenBy,
          written_at: at,
        });
      }
      rows.push({
        line_id: lineId,
        draft_id: input.draftId,
        revision: seedOld ? 2 : 1,
        written_by: input.writtenBy,
        written_at: at,
      });
    }
    await store.upsert(scope, rows);
    return rows[rows.length - 1].revision;
  } catch (error) {
    log("draft_lineage_write_failed", { inbox_id: scope.inboxId, error: message(error) });
    return null;
  }
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
      lineId = crypto.randomUUID();
      await store.upsert(scope, [{
        line_id: lineId,
        draft_id: resolved.draftId,
        revision: 1,
        written_by: "agent",
        written_at: at,
      }]);
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
