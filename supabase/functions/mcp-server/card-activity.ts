// ---------------------------------------------------------------------------
// What the person did in the draft editor card, told to the model by the
// server (QA 2026-10-15).
//
// ── The bug ────────────────────────────────────────────────────────────────
// The card tells the model about a save or a send through
// `ui/update-model-context`. In Claude the model never saw it: after the user
// saved new recipients in the card, Claude reported the old ones, and after the
// card sent the email Claude said "No, I never sent it." When the user then
// asked Claude to send, the server refused (`draft_already_sent`), so nothing
// went out twice, but the user was told two contradictory things.
//
// ── Why the server, and not only the card ──────────────────────────────────
// Whether a host forwards `ui/update-model-context` to the model, and when, is
// the host's decision (the spec says it SHOULD, and MAY defer it). The card's
// actions all reach the server as tool calls, though, and a tool RESULT is the
// one thing every host shows the model. So the server records each card action
// here, and the next draft result the model asks for in that inbox carries one
// note saying what happened, once.
//
// ── Which calls are the card's ─────────────────────────────────────────────
// The server never sees the card's local state, only its calls:
//
//   draft_editor_save            always the card (it is app-only). Recorded
//                                as `saved` when it wrote something.
//   draft{action:"send"} with    the card: it is the only caller that passes
//   base_revision                base_revision, apart from the dispatcher's
//                                re-run of an approved send, which is excluded
//                                by its internal marker. Recorded as `sent`.
//
// A discard (`draft{action:"delete"}`) carries nothing that tells the card's
// call from the model's, so it is not recorded, and the model's own delete
// result already says the draft is gone.
//
// ── Which results carry the note ───────────────────────────────────────────
// `noteCarrier`: the model's own draft calls for the inbox. Never a call the
// card itself makes (`draft_read`, `draft_editor_*`, `draft_delete`, a send
// with base_revision): the host does not put those results in front of the
// model, so a note there would be marked reported and never read. And never a
// non-draft tool: this costs one database round trip, and the draft tools are
// where a model goes to find out about a draft.
//
// ── What is stored ─────────────────────────────────────────────────────────
// No mail content, the same promise `draft_lineage` keeps: a draft id, which
// action, when, the lineage revision, which FIELDS a save changed (names, not
// values) and recipient COUNTS. The note therefore never quotes a subject; it
// says which fields moved and that `draft_read` has them.
//
// ── Fail soft ──────────────────────────────────────────────────────────────
// Bookkeeping around a call that is the user's actual request. Nothing here
// throws: a database without `public.draft_card_activity` (the function
// deployed ahead of its migration) records nothing and notes nothing, and every
// draft tool behaves exactly as before.
//
// Pure apart from the injected store, so it is tested without a database.
// ---------------------------------------------------------------------------

export type CardActivityAction = "saved" | "sent";

/** The fields a card save can change, as `draft_editor_save` takes them. */
export type CardSavedField = "to" | "cc" | "bcc" | "subject" | "body";

const FIELD_ORDER: readonly CardSavedField[] = ["subject", "to", "cc", "bcc", "body"];

/** One card action, as recorded. */
export interface CardActivityEvent {
  draftId: string;
  lineId: string | null;
  action: CardActivityAction;
  /** ISO 8601. The save's own stamp, or the send's `sent_at`. */
  occurredAt: string;
  revision: number | null;
  /** `saved` only: which fields the save was given. Names, never values. */
  fields: CardSavedField[];
  /** `saved` only: recipient counts after the save. Null when not known. */
  toCount: number | null;
  ccCount: number | null;
  bccCount: number | null;
}

/** A recorded event, as read back. */
export interface CardActivityRow extends CardActivityEvent {
  id: string;
}

export interface CardActivityScope {
  workspaceId: string;
  inboxId: string;
}

/** The three operations. Each may throw; the functions here catch. */
export interface CardActivityStore {
  insert(scope: CardActivityScope, event: CardActivityEvent): Promise<void>;
  /**
   * Mark every unreported event at or after `since` reported, in ONE statement,
   * and return the rows that statement changed. A concurrent second claim gets
   * none of them, so each event is told once.
   */
  claim(scope: CardActivityScope, since: string, at: string): Promise<CardActivityRow[]>;
  /**
   * The most recent `sent` event for this draft, by line when one is known,
   * else by draft id. Reported or not.
   */
  lastSent(
    scope: CardActivityScope,
    target: { lineId: string | null; draftId: string },
  ): Promise<CardActivityRow | null>;
}

type Logger = (event: string, details: Record<string, unknown>) => void;

const defaultLog: Logger = (event, details) => {
  console.warn(`[mcp-server] ${event}`, details);
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * How far back a note reaches. An action older than this is not "since your
 * last call" in any conversation still going on, and telling a model about a
 * save from last week, as if it were news, is its own kind of wrong.
 */
export const CARD_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** At most this many actions are spelled out in one note. */
export const CARD_ACTIVITY_NOTE_MAX = 5;

/** Record one card action. Never throws. */
export async function recordCardActivity(
  store: CardActivityStore | null | undefined,
  scope: CardActivityScope,
  event: CardActivityEvent,
  log: Logger = defaultLog,
): Promise<void> {
  if (!store) return;
  try {
    await store.insert(scope, {
      ...event,
      fields: FIELD_ORDER.filter((f) => event.fields.includes(f)),
    });
  } catch (error) {
    log("draft_card_activity_record_failed", { inbox_id: scope.inboxId, error: message(error) });
  }
}

/** An instant as ISO 8601 in UTC, to the second, or null. */
export function instant(iso: string | null | undefined): string | null {
  if (typeof iso !== "string") return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** "the subject, To and the body". */
function fieldWords(fields: readonly CardSavedField[]): string {
  const words = fields.map((f) =>
    f === "subject" ? "the subject" : f === "body" ? "the body" : f === "to" ? "To" : f === "cc" ? "Cc" : "Bcc"
  );
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function count(n: number | null): string {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? String(Math.floor(n)) : "?";
}

/** One sentence for one event. Facts only; never a subject or an address. */
export function cardActivitySentence(row: CardActivityEvent): string {
  const at = instant(row.occurredAt) ?? "an unrecorded time";
  if (row.action === "sent") {
    return `At ${at} the user sent draft ${row.draftId} from the card. ` +
      "It is no longer a draft and that draft_id no longer resolves.";
  }
  const fields = FIELD_ORDER.filter((f) => row.fields.includes(f));
  const changed = fields.length ? `, changing ${fieldWords(fields)}` : "";
  const counts = row.toCount === null && row.ccCount === null && row.bccCount === null
    ? ""
    : ` Its recipients are now to ${count(row.toCount)}, cc ${count(row.ccCount)}, bcc ${count(row.bccCount)}.`;
  return `At ${at} the user saved draft ${row.draftId} in the card${changed}.${counts}`;
}

/**
 * The note for a set of claimed events, oldest first, or null for none.
 *
 * Written as a statement of fact, like every other server note: it does not
 * tell the model what to do, it says what happened and where the current text
 * is. Bounded: at most `CARD_ACTIVITY_NOTE_MAX` actions, newest kept.
 */
export function cardActivityNote(rows: readonly CardActivityEvent[]): string | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  const shown = sorted.slice(-CARD_ACTIVITY_NOTE_MAX);
  const earlier = sorted.length - shown.length;
  const anySaved = shown.some((r) => r.action === "saved");
  return (
    "Since the last draft result for this inbox, the user acted in the MCP Emails draft editor card, " +
    "which is not shown to you. " +
    shown.map(cardActivitySentence).join(" ") +
    (earlier > 0 ? ` ${earlier} earlier card action${earlier === 1 ? " is" : "s are"} not listed.` : "") +
    (anySaved ? " draft_read returns a saved draft's current subject, recipients and text." : "")
  );
}

/**
 * Claim the unreported card actions for one inbox and word them, or null.
 * Never throws.
 */
export async function takeCardActivityNote(
  store: CardActivityStore | null | undefined,
  scope: CardActivityScope,
  nowMs: number = Date.now(),
  log: Logger = defaultLog,
): Promise<string | null> {
  if (!store) return null;
  try {
    const since = new Date(nowMs - CARD_ACTIVITY_WINDOW_MS).toISOString();
    const rows = await store.claim(scope, since, new Date(nowMs).toISOString());
    return cardActivityNote(rows);
  } catch (error) {
    log("draft_card_activity_claim_failed", { inbox_id: scope.inboxId, error: message(error) });
    return null;
  }
}

/** The card's send of this draft, if one was recorded. Never throws. */
export async function cardSendOf(
  store: CardActivityStore | null | undefined,
  scope: CardActivityScope,
  target: { lineId: string | null; draftId: string },
  log: Logger = defaultLog,
): Promise<CardActivityRow | null> {
  if (!store) return null;
  try {
    return await store.lastSent(scope, target);
  } catch (error) {
    log("draft_card_activity_lookup_failed", { inbox_id: scope.inboxId, error: message(error) });
    return null;
  }
}

/**
 * Does this tool call's result carry the note?
 *
 * The model's own draft calls only. `base_revision` on a send marks the card
 * (see the header), and the dispatcher's re-run of an approved send has no
 * result a model reads.
 */
export function noteCarrier(
  dispatchName: string,
  args: unknown,
  opts: { approvalDispatch: boolean },
): boolean {
  if (opts.approvalDispatch) return false;
  switch (dispatchName) {
    case "draft_list":
    case "draft_create":
    case "draft_reply":
    case "draft_update":
      return true;
    case "draft_send": {
      const a = args && typeof args === "object" && !Array.isArray(args)
        ? args as Record<string, unknown>
        : {};
      return a["base_revision"] === undefined || a["base_revision"] === null;
    }
    default:
      return false;
  }
}

/**
 * The model's sentence for a send refused because the draft was already sent.
 *
 * It used to read only "draft X was already sent. Nothing was sent again.",
 * which left a model that had not sent it nothing to reconcile with what it
 * believed. It now says who sent it and when, as far as the server knows.
 */
export function alreadySentText(input: {
  requestedId: string;
  sentCopyKept: boolean;
  cardSentAt: string | null;
  closedAt: string | null;
}): string {
  const card = instant(input.cardSentAt);
  const closed = instant(input.closedAt);
  const how = card
    ? ` by the user from the MCP Emails draft editor card at ${card}`
    : closed
    ? ` at ${closed}`
    : "";
  return `draft_send: draft ${input.requestedId} was already sent${how}` +
    (input.sentCopyKept ? ", and its copy is still in the Drafts folder" : "") +
    ". Nothing was sent again.";
}

/**
 * The model's sentence for a `draft_read` or `draft_editor_save` against a
 * draft whose line a send closed. Null when it was not a send.
 */
export function closedBySendText(input: {
  draftId: string;
  cardSentAt: string | null;
  closedAt: string | null;
}): string {
  const card = instant(input.cardSentAt);
  const closed = instant(input.closedAt);
  const how = card
    ? ` by the user from the MCP Emails draft editor card at ${card}`
    : closed
    ? ` at ${closed}`
    : "";
  return `Draft ${input.draftId} was already sent${how}. It is no longer a draft, so this draft_id ` +
    "no longer resolves. Nothing was changed.";
}

// ---------------------------------------------------------------------------
// In-memory store, for tests
// ---------------------------------------------------------------------------

export class FakeCardActivityStore implements CardActivityStore {
  rows: Array<CardActivityRow & CardActivityScope & { reportedAt: string | null }> = [];
  failing = false;
  private seq = 0;

  insert(scope: CardActivityScope, event: CardActivityEvent): Promise<void> {
    if (this.failing) return Promise.reject(new Error("relation does not exist"));
    this.rows.push({ ...event, ...scope, id: `ev-${++this.seq}`, reportedAt: null });
    return Promise.resolve();
  }

  claim(scope: CardActivityScope, since: string, at: string): Promise<CardActivityRow[]> {
    if (this.failing) return Promise.reject(new Error("relation does not exist"));
    const out: CardActivityRow[] = [];
    for (const r of this.rows) {
      if (r.workspaceId !== scope.workspaceId || r.inboxId !== scope.inboxId) continue;
      if (r.reportedAt !== null || Date.parse(r.occurredAt) < Date.parse(since)) continue;
      r.reportedAt = at;
      const { workspaceId: _w, inboxId: _i, reportedAt: _r, ...row } = r;
      out.push(row);
    }
    return Promise.resolve(out);
  }

  lastSent(
    scope: CardActivityScope,
    target: { lineId: string | null; draftId: string },
  ): Promise<CardActivityRow | null> {
    if (this.failing) return Promise.reject(new Error("relation does not exist"));
    const hits = this.rows.filter((r) =>
      r.workspaceId === scope.workspaceId && r.inboxId === scope.inboxId && r.action === "sent" &&
      (target.lineId ? r.lineId === target.lineId : r.draftId === target.draftId)
    ).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
    const hit = hits[0];
    if (!hit) return Promise.resolve(null);
    const { workspaceId: _w, inboxId: _i, reportedAt: _r, ...row } = hit;
    return Promise.resolve(row);
  }
}
