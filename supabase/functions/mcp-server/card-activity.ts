// ---------------------------------------------------------------------------
// What happened through the draft editor, told to the model by the server
// (QA 2026-10-15).
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
// one thing every host shows the model. So the server records each editor
// action here, and the next draft result a model asks for, on the SAME API key
// and inbox, carries one note saying what happened, once.
//
// ── What is recorded, and why the wording never says "the user" ────────────
//   draft_editor_save            recorded as `saved` when it wrote something.
//   draft{action:"send"} with    recorded as `sent`. The card is the caller
//   base_revision                that passes base_revision; the dispatcher's
//                                re-run of an approved send is excluded.
//
// Neither is PROOF that a person acted in a card. `base_revision` is in the
// model-visible `draft` schema, and `draft_editor_save`'s app-only visibility
// is a host hint that a host may ignore. An MCP request carries nothing a model
// cannot also send (the card's calls arrive through the host with the same
// credentials and the same JSON-RPC shape), so there is no unforgeable signal,
// and the schema must not be narrowed to make one. So every sentence here says
// what was recorded ("draft X was saved", "was sent", "through the draft
// editor") and never who did it. That is true whoever the caller was, and it
// is enough to stop a model saying "I never sent it" or quoting an old subject.
//
// A discard (`draft{action:"delete"}`) carries nothing that tells the card's
// call from the model's, so it is not recorded, and the model's own delete
// result already says the draft is gone.
//
// ── Which results carry the note ───────────────────────────────────────────
// `noteCarrier`: draft calls a model makes over MCP for the inbox
// (index.ts#handleToolsCall, after dispatch). Never:
//   * a call the card itself makes (`draft_read`, `draft_editor_*`,
//     `draft_delete`, a send with base_revision): the host does not put those
//     results in front of the model, so a note there would be claimed and
//     never read;
//   * the web client's calls (client-api), which run the same executors
//     through `dispatchExecutor` and would claim notes no model ever reads.
//     The claim lives in `handleToolsCall`, which client-api never calls;
//   * a non-draft tool: this costs a database round trip, and the draft tools
//     are where a model goes to find out about a draft.
//
// ── Per key ────────────────────────────────────────────────────────────────
// A row carries the API key the editor call came in on, and only a call on
// that key claims it. A save made in Claude's card is news to Claude's
// conversation, not to another client (ChatGPT, a script) on another key that
// happens to touch the same inbox first.
//
// ── What is stored ─────────────────────────────────────────────────────────
// No mail content, the same promise `draft_lineage` keeps: a draft id, which
// action, when, the lineage revision, which FIELDS a save changed (names, not
// values) and recipient COUNTS. The note never quotes a subject; it says which
// fields moved and that `draft_read` has them.
//
// ── Retention ──────────────────────────────────────────────────────────────
// Every insert also deletes every row older than 7 days, in any workspace, in
// the same round trip's follow-up statement. Because this runs on EVERY insert,
// the expired backlog it can meet is only what expired since the previous
// insert anywhere, so the statement stays small without a LIMIT (PostgREST
// deletes take none). With no inserts at all there is nothing new to expire.
//
// ── Fail soft ──────────────────────────────────────────────────────────────
// Bookkeeping around a call that is the user's actual request. Nothing here
// throws: a database without `public.draft_card_activity` (the function
// deployed ahead of its migration) records nothing and notes nothing, and every
// draft tool behaves exactly as before.
// ---------------------------------------------------------------------------

export type CardActivityAction = "saved" | "sent";

/** The fields an editor save can change, as `draft_editor_save` takes them. */
export type CardSavedField = "to" | "cc" | "bcc" | "subject" | "body";

const FIELD_ORDER: readonly CardSavedField[] = ["subject", "to", "cc", "bcc", "body"];

/** One editor action, as recorded. */
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

/** Workspace, inbox AND the API key the editor call came in on. */
export interface CardActivityScope {
  workspaceId: string;
  inboxId: string;
  apiKeyId: string;
}

/** The two operations. Each may throw; the functions here catch. */
export interface CardActivityStore {
  insert(scope: CardActivityScope, event: CardActivityEvent): Promise<void>;
  /**
   * Mark every unreported event for this key and inbox at or after `since`
   * reported, in ONE statement, and return the rows that statement changed. A
   * concurrent second claim gets none of them, so each event is told once.
   */
  claim(scope: CardActivityScope, since: string, at: string): Promise<CardActivityRow[]>;
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
 * last call" in any conversation still going on.
 */
export const CARD_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Rows older than this are deleted (see "Retention" above). */
export const CARD_ACTIVITY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** At most this many actions are spelled out in one note. */
export const CARD_ACTIVITY_NOTE_MAX = 5;

/** Record one editor action. Never throws. */
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

/**
 * One sentence for one event. What was recorded, never who did it (see the
 * header), and never a subject or an address.
 */
export function cardActivitySentence(row: CardActivityEvent): string {
  const at = instant(row.occurredAt) ?? "an unrecorded time";
  if (row.action === "sent") {
    return `At ${at} draft ${row.draftId} was sent. It is no longer a draft and that draft_id no longer resolves.`;
  }
  const fields = FIELD_ORDER.filter((f) => row.fields.includes(f));
  const changed = fields.length ? `, changing ${fieldWords(fields)}` : "";
  const counts = row.toCount === null && row.ccCount === null && row.bccCount === null
    ? ""
    : ` Its recipients are now to ${count(row.toCount)}, cc ${count(row.ccCount)}, bcc ${count(row.bccCount)}.`;
  return `At ${at} draft ${row.draftId} was saved${changed}.${counts}`;
}

/**
 * The note for a set of claimed events, oldest first, or null for none.
 *
 * A statement of fact, like every other server note: it says what was
 * recorded and where the current text is, and asks for nothing. Bounded: at
 * most `CARD_ACTIVITY_NOTE_MAX` actions, newest kept.
 */
export function cardActivityNote(rows: readonly CardActivityEvent[]): string | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  const shown = sorted.slice(-CARD_ACTIVITY_NOTE_MAX);
  const earlier = sorted.length - shown.length;
  const anySaved = shown.some((r) => r.action === "saved");
  return (
    "Since the last draft result for this inbox, the MCP Emails draft editor (the card in which the " +
    "user can edit, save and send a draft) recorded these changes, which may not appear in this " +
    "conversation. " +
    shown.map(cardActivitySentence).join(" ") +
    (earlier > 0 ? ` ${earlier} earlier change${earlier === 1 ? " is" : "s are"} not listed.` : "") +
    (anySaved ? " draft_read returns a saved draft's current subject, recipients and text." : "")
  );
}

/**
 * Claim the unreported editor actions for one key and inbox and word them, or
 * null. Never throws.
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

/**
 * Does this tool call's result carry the note?
 *
 * Draft calls a model makes. `base_revision` on a send marks the card's call;
 * the dispatcher's re-run of an approved send has no result a model reads. The
 * web client is excluded by WHERE this is called (index.ts#handleToolsCall).
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
 * believed. It now says when, from the lineage's close. Never who: the server
 * cannot know (see the header).
 */
export function alreadySentText(input: {
  requestedId: string;
  sentCopyKept: boolean;
  closedAt: string | null;
}): string {
  const closed = instant(input.closedAt);
  return `draft_send: draft ${input.requestedId} was already sent${closed ? ` at ${closed}` : ""}` +
    (input.sentCopyKept ? ", and its copy is still in the Drafts folder" : "") +
    ". Nothing was sent again.";
}

/**
 * The model's sentence for a `draft_read` or `draft_editor_save` against a
 * draft whose line a send closed.
 */
export function closedBySendText(input: { draftId: string; closedAt: string | null }): string {
  const closed = instant(input.closedAt);
  return `Draft ${input.draftId} was already sent${closed ? ` at ${closed}` : ""}. It is no longer a ` +
    "draft, so this draft_id no longer resolves. Nothing was changed.";
}

// ---------------------------------------------------------------------------
// The PostgREST store
// ---------------------------------------------------------------------------

/**
 * The slice of a supabase-js client this store uses. Structural so the store
 * can be built over a recording fake in tests, which is how the filters
 * (workspace, inbox AND key) are pinned against the real query construction.
 */
// deno-lint-ignore no-explicit-any
export type PostgrestLike = { from(table: string): any };

const CARD_ACTIVITY_COLUMNS =
  "id, draft_id, line_id, action, occurred_at, revision, fields, to_count, cc_count, bcc_count";

function cardActivityRowFrom(r: Record<string, unknown>): CardActivityRow {
  const n = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    id: String(r.id),
    draftId: String(r.draft_id),
    lineId: typeof r.line_id === "string" ? r.line_id : null,
    action: r.action === "sent" ? "sent" : "saved",
    occurredAt: String(r.occurred_at),
    revision: n(r.revision),
    fields: Array.isArray(r.fields)
      ? (r.fields as unknown[]).filter((f): f is CardSavedField =>
        f === "to" || f === "cc" || f === "bcc" || f === "subject" || f === "body"
      )
      : [],
    toCount: n(r.to_count),
    ccCount: n(r.cc_count),
    bccCount: n(r.bcc_count),
  };
}

/**
 * `public.draft_card_activity` over PostgREST. Service role; every statement
 * that reads or marks rows filters on workspace, inbox AND key. Throws on a
 * PostgREST error; the functions above catch.
 */
export function postgrestCardActivityStore(
  client: PostgrestLike,
  nowMs: () => number = Date.now,
): CardActivityStore {
  return {
    async insert(scope, event) {
      const { error } = await client.from("draft_card_activity").insert({
        workspace_id: scope.workspaceId,
        inbox_id: scope.inboxId,
        api_key_id: scope.apiKeyId,
        draft_id: event.draftId,
        line_id: event.lineId,
        action: event.action,
        occurred_at: event.occurredAt,
        revision: event.revision,
        fields: event.fields,
        to_count: event.toCount,
        cc_count: event.ccCount,
        bcc_count: event.bccCount,
      });
      if (error) throw new Error(error.message);
      // Retention, every workspace, best effort: see the header.
      const cutoff = new Date(nowMs() - CARD_ACTIVITY_RETENTION_MS).toISOString();
      await client.from("draft_card_activity").delete().lt("occurred_at", cutoff);
    },
    // ONE update that marks and returns, so two concurrent claims never both
    // report the same action.
    async claim(scope, since, at) {
      const { data, error } = await client
        .from("draft_card_activity")
        .update({ reported_at: at })
        .eq("workspace_id", scope.workspaceId)
        .eq("inbox_id", scope.inboxId)
        .eq("api_key_id", scope.apiKeyId)
        .is("reported_at", null)
        .gte("occurred_at", since)
        .select(CARD_ACTIVITY_COLUMNS);
      if (error) throw new Error(error.message);
      return ((data ?? []) as Record<string, unknown>[]).map(cardActivityRowFrom);
    },
  };
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
      if (r.apiKeyId !== scope.apiKeyId) continue;
      if (r.reportedAt !== null || Date.parse(r.occurredAt) < Date.parse(since)) continue;
      r.reportedAt = at;
      const { workspaceId: _w, inboxId: _i, apiKeyId: _k, reportedAt: _r, ...row } = r;
      out.push(row);
    }
    return Promise.resolve(out);
  }
}
