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
// action here, and the next model draft call that names THAT draft, on the
// same API key and inbox, carries one note saying what happened, once.
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
// `noteTargetDraftId`: draft calls a model makes over MCP that NAME A DRAFT
// (`draft_update`, and `draft_send` without base_revision), after dispatch in
// index.ts#handleToolsCall. Never:
//   * a call with no draft of its own (`draft_list`, `draft_create`,
//     `draft_reply`): there is nothing to scope a note to (see "Per draft");
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
// ── A model's draft_read: told, NOT claimed (re-test 2026-10-17) ───────────
// Live in claude.ai the card's `ui/update-model-context` reached the model
// neither on the next turn nor later (see apps/mcp-app/src/model-context.ts),
// and the descriptions send a model to `draft_read` before it states a
// draft's state, so that read is where the model actually looks. Its result
// shows the current subject and recipients but not WHAT the editor changed,
// which is what "what did I change in the card?" asks. So a successful
// `draft_read` carries the same note about its own draft's line
// (`peekTargetDraftId`), but only READS the rows: the card makes `draft_read`
// calls too (restore, deferred body, the focus re-check), with the same
// arguments, and a claim there would hand the note to a result no model sees.
// The note therefore stays for the next model draft call that claims it, and
// may be told on every model read until then. Same scope as above: one key,
// one inbox, one draft's line, no ids.
//
// ── Per key ────────────────────────────────────────────────────────────────
// A row carries the API key the editor call came in on, and only a call on
// that key claims it. A save made in Claude's card is news to Claude's
// conversation, not to another client (ChatGPT, a script) on another key that
// happens to touch the same inbox first.
//
// ── Per draft (QA 2026-10-17) ──────────────────────────────────────────────
// The key is not a conversation. Claude uses ONE key for every chat a person
// has, so "the next draft result on this key" was the next draft result in ANY
// chat: a brand-new, unrelated conversation was told "Drafts:115 now has 1 To
// and 2 Cc, and Drafts:116 has 1 To and no Cc", about drafts it had never
// seen, by raw provider id, and with 115 already retired by the save that
// made 116. Nothing on an MCP request names the conversation, so the note is
// scoped to the one thing a call does name: its draft. Only the events of the
// draft's LINE (draft-lineage.ts: every id one draft has had) are claimed and
// told, collapsed into one statement about "this draft", with no id at all, so
// a retired id and its successor read as the one draft they are. Everything
// else stays unclaimed for a call that does concern it, or expires.
//
// ── What is stored ─────────────────────────────────────────────────────────
// No mail content, the same promise `draft_lineage` keeps: a draft id, which
// action, when, the lineage revision, which FIELDS a save changed (names, not
// values) and recipient COUNTS. The subject the note may quote is not stored:
// it is the one the CURRENT call's own result already shows the model, passed
// in when the note is worded, so the note adds no content the result lacks.
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

import { neutralizeText } from "./text-safety.ts";

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

/**
 * The draft a call concerns: its lineage line, when it has one, and every id
 * of it the caller knows (the id it was given, the id it resolved to, the id
 * the call returned). An event matches on its line OR its id, so an event
 * recorded before the draft had a line still belongs to it.
 */
export interface CardActivityTarget {
  lineId: string | null;
  draftIds: string[];
}

/** The two operations. Each may throw; the functions here catch. */
export interface CardActivityStore {
  insert(scope: CardActivityScope, event: CardActivityEvent): Promise<void>;
  /**
   * Mark every unreported event for this key and inbox, at or after `since`,
   * that belongs to `target` (its line, or one of its ids) reported, and
   * return the rows that changed. Each statement marks and returns at once, so
   * a concurrent second claim gets none of them and each event is told once.
   */
  claim(
    scope: CardActivityScope,
    target: CardActivityTarget,
    since: string,
    at: string,
  ): Promise<CardActivityRow[]>;
  /** The same rows `claim` would return, left unreported. */
  peek(
    scope: CardActivityScope,
    target: CardActivityTarget,
    since: string,
  ): Promise<CardActivityRow[]>;
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

const SUBJECT_MAX = 120;

/**
 * `this draft ("Q3 numbers")`, or `this draft`. The subject is the one the
 * current result carries, held to one line, clipped, and unable to close its
 * own quotes: on a reply it is a third party's text.
 */
function draftName(subject: string | null | undefined): string {
  if (typeof subject !== "string") return "this draft";
  const flat = neutralizeText(subject).replace(/\s+/g, " ").replace(/"/g, "'").trim();
  if (!flat) return "this draft";
  return `this draft ("${flat.length > SUBJECT_MAX ? `${flat.slice(0, SUBJECT_MAX - 1)}…` : flat}")`;
}

/**
 * The note for the claimed events of ONE draft, or null for none.
 *
 * Every event is about the draft the current call names (see "Per draft"), so
 * they collapse into one statement about "this draft": no draft id, because a
 * retired id and its successor are the same draft and the model already holds
 * the id it called with. What was recorded, never who did it (see the header),
 * and never an address. A statement of fact, like every other server note: it
 * says what was recorded and where the current text is, and asks for nothing.
 */
export function cardActivityNote(
  rows: readonly CardActivityEvent[],
  opts: { subject?: string | null; read?: boolean } = {},
): string | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  const saves = sorted.filter((r) => r.action === "saved");
  const send = sorted.filter((r) => r.action === "sent").at(-1) ?? null;
  const name = draftName(opts.subject);
  const parts: string[] = [
    `Before this call, the MCPEmails draft editor (the card in which the user can edit, save and ` +
    `send a draft) recorded changes to ${name} that may not appear in this conversation.`,
  ];
  if (saves.length > 0) {
    const last = saves[saves.length - 1];
    const at = instant(last.occurredAt) ?? "an unrecorded time";
    const fields = FIELD_ORDER.filter((f) => saves.some((r) => r.fields.includes(f)));
    const times = saves.length === 1 ? "once" : `${saves.length} times`;
    const when = saves.length === 1 ? `at ${at}` : `last at ${at}`;
    const changed = fields.length ? `, changing ${fieldWords(fields)}` : "";
    parts.push(`It was saved there ${times}, ${when}${changed}.`);
    const counted = [...saves].reverse().find((r) =>
      r.toCount !== null || r.ccCount !== null || r.bccCount !== null
    );
    if (counted) {
      parts.push(
        `After that save it had To ${count(counted.toCount)}, Cc ${count(counted.ccCount)}, ` +
          `Bcc ${count(counted.bccCount)}.`,
      );
    }
  }
  if (send) {
    const at = instant(send.occurredAt) ?? "an unrecorded time";
    parts.push(`At ${at} it was sent, so it is no longer a draft.`);
  } else if (saves.length > 0) {
    parts.push(
      opts.read
        ? "This result shows its current subject, recipients and text."
        : "draft_read returns its current subject, recipients and text.",
    );
  }
  return parts.join(" ");
}

/**
 * Claim the unreported editor actions of ONE draft, for one key and inbox,
 * and word them, or null. Never throws.
 *
 * A target with no line and no id is no draft at all, and claims nothing:
 * there is no "every draft" mode any more (see "Per draft").
 */
export async function takeCardActivityNote(
  store: CardActivityStore | null | undefined,
  scope: CardActivityScope,
  target: CardActivityTarget,
  opts: { subject?: string | null; nowMs?: number; log?: Logger } = {},
): Promise<string | null> {
  const log = opts.log ?? defaultLog;
  const nowMs = opts.nowMs ?? Date.now();
  const draftIds = [...new Set(target.draftIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (!store || (!target.lineId && draftIds.length === 0)) return null;
  try {
    const since = new Date(nowMs - CARD_ACTIVITY_WINDOW_MS).toISOString();
    const rows = await store.claim(
      scope,
      { lineId: target.lineId, draftIds },
      since,
      new Date(nowMs).toISOString(),
    );
    return cardActivityNote(rows, { subject: opts.subject });
  } catch (error) {
    log("draft_card_activity_claim_failed", { inbox_id: scope.inboxId, error: message(error) });
    return null;
  }
}

/**
 * Word the unreported editor actions of ONE draft for a model's `draft_read`,
 * without claiming them (see "A model's draft_read"), or null. Never throws.
 */
export async function peekCardActivityNote(
  store: CardActivityStore | null | undefined,
  scope: CardActivityScope,
  target: CardActivityTarget,
  opts: { subject?: string | null; nowMs?: number; log?: Logger } = {},
): Promise<string | null> {
  const log = opts.log ?? defaultLog;
  const nowMs = opts.nowMs ?? Date.now();
  const draftIds = [...new Set(target.draftIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (!store || (!target.lineId && draftIds.length === 0)) return null;
  try {
    const since = new Date(nowMs - CARD_ACTIVITY_WINDOW_MS).toISOString();
    const rows = await store.peek(scope, { lineId: target.lineId, draftIds }, since);
    return cardActivityNote(rows, { subject: opts.subject, read: true });
  } catch (error) {
    log("draft_card_activity_peek_failed", { inbox_id: scope.inboxId, error: message(error) });
    return null;
  }
}

/**
 * The draft a successful `draft_read` names, whose note it carries without
 * claiming it (see "A model's draft_read"), or null.
 */
export function peekTargetDraftId(dispatchName: string, args: unknown): string | null {
  if (dispatchName !== "draft_read") return null;
  const a = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
  return typeof a["draft_id"] === "string" && a["draft_id"].length > 0 ? a["draft_id"] : null;
}

/**
 * The draft this tool call's result may carry a note about, or null for none.
 *
 * Draft calls a model makes that name a draft. `base_revision` on a send marks
 * the card's call; the dispatcher's re-run of an approved send has no result a
 * model reads. A call that names no draft (`draft_list`, `draft_create`,
 * `draft_reply`) carries nothing: see "Per draft". The web client is excluded
 * by WHERE this is called (index.ts#handleToolsCall).
 */
export function noteTargetDraftId(
  dispatchName: string,
  args: unknown,
  opts: { approvalDispatch: boolean },
): string | null {
  if (opts.approvalDispatch) return null;
  const a = args && typeof args === "object" && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
  const id = typeof a["draft_id"] === "string" && a["draft_id"].length > 0 ? a["draft_id"] : null;
  switch (dispatchName) {
    case "draft_update":
      return id;
    case "draft_send":
      return a["base_revision"] === undefined || a["base_revision"] === null ? id : null;
    default:
      return null;
  }
}

/**
 * What the current call's own result says about its draft: the id it ended
 * on and its subject, for the target and the note's wording. Reads the flat
 * payload and the draft card's `draft` block; null for what neither carries.
 */
export function resultDraftFacts(result: unknown): { draftId: string | null; subject: string | null } {
  const r = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const sc = r["structuredContent"] && typeof r["structuredContent"] === "object"
    ? r["structuredContent"] as Record<string, unknown>
    : {};
  const draft = sc["draft"] && typeof sc["draft"] === "object" && !Array.isArray(sc["draft"])
    ? sc["draft"] as Record<string, unknown>
    : {};
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    draftId: str(draft["draft_id"]) ?? str(sc["draft_id"]),
    subject: typeof draft["subject"] === "string"
      ? draft["subject"] as string
      : typeof sc["subject"] === "string"
      ? sc["subject"] as string
      : null,
  };
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
    // Each update marks and returns at once, so two concurrent claims never
    // both report the same action. Two statements, not one `.or()`: a draft id
    // is caller text ("Drafts:115"), and `.in()` quotes it where an
    // or-filter string would have to be escaped by hand. A row the first
    // statement marked is no longer unreported, so the second never returns it.
    async claim(scope, target, since, at) {
      const claimBy = async (column: "line_id" | "draft_id", values: string[]) => {
        let q = client
          .from("draft_card_activity")
          .update({ reported_at: at })
          .eq("workspace_id", scope.workspaceId)
          .eq("inbox_id", scope.inboxId)
          .eq("api_key_id", scope.apiKeyId);
        q = values.length === 1 ? q.eq(column, values[0]) : q.in(column, values);
        const { data, error } = await q
          .is("reported_at", null)
          .gte("occurred_at", since)
          .select(CARD_ACTIVITY_COLUMNS);
        if (error) throw new Error(error.message);
        return ((data ?? []) as Record<string, unknown>[]).map(cardActivityRowFrom);
      };
      const rows: CardActivityRow[] = [];
      if (target.lineId) rows.push(...await claimBy("line_id", [target.lineId]));
      if (target.draftIds.length > 0) rows.push(...await claimBy("draft_id", target.draftIds));
      const seen = new Set<string>();
      return rows.filter((r) => !seen.has(r.id) && (seen.add(r.id), true));
    },
    // `claim`'s filters exactly, as a select: nothing is marked.
    async peek(scope, target, since) {
      const peekBy = async (column: "line_id" | "draft_id", values: string[]) => {
        let q = client
          .from("draft_card_activity")
          .select(CARD_ACTIVITY_COLUMNS)
          .eq("workspace_id", scope.workspaceId)
          .eq("inbox_id", scope.inboxId)
          .eq("api_key_id", scope.apiKeyId);
        q = values.length === 1 ? q.eq(column, values[0]) : q.in(column, values);
        const { data, error } = await q.is("reported_at", null).gte("occurred_at", since);
        if (error) throw new Error(error.message);
        return ((data ?? []) as Record<string, unknown>[]).map(cardActivityRowFrom);
      };
      const rows: CardActivityRow[] = [];
      if (target.lineId) rows.push(...await peekBy("line_id", [target.lineId]));
      if (target.draftIds.length > 0) rows.push(...await peekBy("draft_id", target.draftIds));
      const seen = new Set<string>();
      return rows.filter((r) => !seen.has(r.id) && (seen.add(r.id), true));
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

  claim(
    scope: CardActivityScope,
    target: CardActivityTarget,
    since: string,
    at: string,
  ): Promise<CardActivityRow[]> {
    return this.match(scope, target, since, at);
  }

  private match(
    scope: CardActivityScope,
    target: CardActivityTarget,
    since: string,
    at: string | null,
  ): Promise<CardActivityRow[]> {
    if (this.failing) return Promise.reject(new Error("relation does not exist"));
    const out: CardActivityRow[] = [];
    for (const r of this.rows) {
      if (r.workspaceId !== scope.workspaceId || r.inboxId !== scope.inboxId) continue;
      if (r.apiKeyId !== scope.apiKeyId) continue;
      const ofTarget = (target.lineId !== null && r.lineId === target.lineId) ||
        target.draftIds.includes(r.draftId);
      if (!ofTarget) continue;
      if (r.reportedAt !== null || Date.parse(r.occurredAt) < Date.parse(since)) continue;
      if (at !== null) r.reportedAt = at;
      const { workspaceId: _w, inboxId: _i, apiKeyId: _k, reportedAt: _r, ...row } = r;
      out.push(row);
    }
    return Promise.resolve(out);
  }

  peek(scope: CardActivityScope, target: CardActivityTarget, since: string): Promise<CardActivityRow[]> {
    return this.match(scope, target, since, null);
  }
}
