/* Parses and validates the body of POST /assistant/run. Nothing in it is
 * trusted: inbox ids are checked against the caller's inboxes, sizes are
 * capped, and anything out of shape is `invalid_request`. */

import { type DraftKind, makeKey, type MessageKey, parseKey } from "./events.ts";

export const MAX_BODY_BYTES = 256_000;
const MAX_TEXT_CHARS = 8_000;
const MAX_KEYS = 50;
const MAX_ID_CHARS = 1_024;
const MAX_DRAFT_BODY_CHARS = 20_000;

export interface ContextKey {
  inbox_id: string;
  message_id: string;
  /** Provider folder id the message is in, when the client knows it. */
  folder?: string;
}

export interface DraftState {
  inbox_id: string;
  kind: DraftKind;
  to: string;
  cc: string;
  subject: string;
  body: string;
  reply_to?: { inbox_id: string; message_id: string };
}

export type ApprovalDecision = "approved" | "rejected" | "edited";

export interface RunInput {
  text: string;
  keys: ContextKey[];
  note: string;
  /** What the human decided about earlier send requests (`context.notes`). */
  decisions: ApprovalDecision[];
  timezone: string;
  conversation: unknown;
  draft: DraftState | null;
  intent: string;
}

export type ParsedRequest = { ok: true; input: RunInput } | { ok: false; reason: string };

const DRAFT_KINDS: readonly DraftKind[] = ["reply", "reply_all", "new", "forward"];

export function parseRunRequest(body: unknown, inboxIds: ReadonlySet<string>): ParsedRequest {
  const b = obj(body);
  if (!b) return bad("body");
  if (b.text !== undefined && typeof b.text !== "string") return bad("text");
  const text = typeof b.text === "string" ? b.text.trim() : "";
  if (text.length > MAX_TEXT_CHARS) return bad("text_too_long");

  const context = obj(b.context) ?? {};
  const rawKeys = context.keys === undefined ? [] : context.keys;
  if (!Array.isArray(rawKeys) || rawKeys.length > MAX_KEYS) return bad("context.keys");
  const keys: ContextKey[] = [];
  for (const raw of rawKeys) {
    const key = parseContextKey(raw);
    if (!key) return bad("context.keys");
    if (!inboxIds.has(key.inbox_id)) return bad("context.keys.inbox");
    keys.push(key);
  }

  const intent = typeof b.intent === "string" && /^[a-z][a-z_]{0,39}$/i.test(b.intent) ? b.intent : "";
  if (!text && !intent && !keys.length) return bad("empty");

  let draft: DraftState | null = null;
  if (b.draft !== undefined && b.draft !== null) {
    const d = obj(b.draft);
    if (!d) return bad("draft");
    const replyTo = d.reply_to === undefined || d.reply_to === null ? null : parseContextKey(d.reply_to);
    if (d.reply_to !== undefined && d.reply_to !== null && !replyTo) return bad("draft.reply_to");
    const inbox = typeof d.inbox_id === "string" && d.inbox_id ? d.inbox_id : replyTo?.inbox_id ?? "";
    if (!inbox || !inboxIds.has(inbox)) return bad("draft.inbox");
    if (replyTo && !inboxIds.has(replyTo.inbox_id)) return bad("draft.reply_to.inbox");
    const kind = DRAFT_KINDS.find((k) => k === d.kind) ?? (replyTo ? "reply" : "new");
    draft = {
      inbox_id: inbox,
      kind,
      to: clip(strOf(d.to), 2_000),
      cc: clip(strOf(d.cc), 2_000),
      subject: clip(strOf(d.subject), 500),
      body: clip(strOf(d.body), MAX_DRAFT_BODY_CHARS),
      reply_to: replyTo ? { inbox_id: replyTo.inbox_id, message_id: replyTo.message_id } : undefined,
    };
  }

  return {
    ok: true,
    input: {
      text,
      keys,
      note: clip(strOf(context.note).trim(), 500),
      decisions: parseDecisions(context.notes),
      timezone: validTimezone(strOf(context.timezone)),
      conversation: b.conversation,
      draft,
      intent,
    },
  };
}

/** `context.notes`: `[{ type: "approval", approval_id, decision }]`. Only the
 *  decision is kept; anything else in a note is ignored. */
function parseDecisions(raw: unknown): ApprovalDecision[] {
  if (!Array.isArray(raw)) return [];
  const out: ApprovalDecision[] = [];
  for (const n of raw.slice(-5)) {
    const o = obj(n);
    if (o?.type !== "approval") continue;
    if (o.decision === "approved" || o.decision === "rejected" || o.decision === "edited") out.push(o.decision);
  }
  return out;
}

/** Accepts `{ inbox_id, message_id, folder? }` or the client's `"inbox:id"` key. */
function parseContextKey(raw: unknown): ContextKey | null {
  if (typeof raw === "string") {
    const parsed = parseKey(raw);
    if (!parsed || parsed.message_id.length > MAX_ID_CHARS) return null;
    return parsed;
  }
  const o = obj(raw);
  if (!o) return null;
  const inbox_id = strOf(o.inbox_id);
  const message_id = strOf(o.message_id);
  if (!inbox_id || !message_id || inbox_id.includes(":") || message_id.length > MAX_ID_CHARS) return null;
  const folder = strOf(o.folder);
  return { inbox_id, message_id, folder: folder ? clip(folder, 500) : undefined };
}

export function keyOf(k: { inbox_id: string; message_id: string }): MessageKey {
  return makeKey(k.inbox_id, k.message_id);
}

function validTimezone(tz: string): string {
  if (!tz || tz.length > 64) return "";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "";
  }
}

function bad(reason: string): ParsedRequest {
  return { ok: false, reason };
}
function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function strOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}
