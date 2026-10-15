// ---------------------------------------------------------------------------
// The message a draft card ended on, so "Show" can put it back on screen.
//
// A card that ends (sent, discarded, found gone when the person pressed
// Discard) is one line. The person can open that line to read the message
// again: what they just sent, a draft they discarded by accident, or text they
// threw away and still want. This file holds that copy.
//
// ── What counts as the copy ─────────────────────────────────────────────────
// Only what the card can stand behind:
//
//   sent         the draft the card held when its own Send was answered. Send
//                writes unsaved changes first, so this is what went out.
//   discarded    the draft as it was on screen when the person pressed
//                Discard, including changes they never saved, and which fields
//                those were (`unsaved`), so the view can say so.
//   gone / sent_elsewhere
//                the same, when Discard found the draft already gone. The view
//                says it is the card's copy, not the provider's.
//
// Never the tool result the card was mounted with: on a reopened chat that is
// the assistant's ORIGINAL text, and a person who edited it before sending
// would be shown words they did not send. A card that has no copy of its own
// (another device, a new tab, a send the assistant made) offers no Show at all.
//
// ── Why sessionStorage, as unsaved.ts does ─────────────────────────────────
// The copy is message content, and persist.ts's header is the reason it does
// not go there: localStorage is durable, is not scoped to a conversation, and
// whether this origin is private to this app cannot be read from inside the
// frame. unsaved.ts made the one narrow trade the card makes for content, and
// this file makes the same one, under the same rules:
//
//   - sessionStorage, never localStorage. It dies with the tab. Leaving a chat
//     and coming back in the same tab, and reloading the page, both keep it;
//     a new tab, a restarted browser or another device does not, and then the
//     line has no Show link, which is the honest answer there.
//   - plain text only. The HTML part stays in memory, so a reopened card offers
//     no formatted view.
//   - scoped to the card (`persist.ts#cardKey`) and its inbox, a 24 h TTL like
//     both other stores, at most `MAX_ENTRIES` entries and `MAX_CHARS` each.
//   - every access wrapped. A host that keeps nothing gets the one line it had
//     before this file existed.
//
// The server stores no mail content and this adds none: nothing here is ever
// sent anywhere.
// ---------------------------------------------------------------------------

import type { DraftEditorData } from "./contract";

const KEY = "mcpemails.ended.v1";
export const ENDED_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10;
/** Same bound as unsaved.ts: the server clips a body at 64 KB. */
const MAX_CHARS = 200_000;
const MAX_ATTACHMENTS = 8;
const MAX_RECIPIENTS = 100;

/** How the card ended, which decides the label over the copy. */
export type EndedHow = "sent" | "scheduled" | "discarded" | "gone" | "sent_elsewhere";

/** A field whose text on screen at Discard had never been saved. */
export type EndedField = "to" | "cc" | "bcc" | "subject" | "body";
const ENDED_FIELDS: EndedField[] = ["to", "cc", "bcc", "subject", "body"];

export interface EndedCopy {
  how: EndedHow;
  /** The receipt outcome the card ended on. The copy is shown under that one only. */
  outcome: "sent" | "scheduled" | "discarded";
  /** When this card saw it end, by the browser's clock (ms epoch). */
  at: number;
  /** The server's send time, when the send answer carried one. */
  sent_at?: string | null;
  from?: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body_text: string;
  /** In memory only: never stored. */
  body_html?: string | null;
  truncated?: boolean;
  attachments?: Array<{ filename: string; size_bytes: number }>;
  attachment_count?: number;
  provider?: string | null;
  unsaved?: EndedField[];
}

/** What the editor had on screen at Discard, as opposed to what it last saved. */
export interface OnScreen {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body_text: string;
  unsaved: EndedField[];
}

/**
 * The copy of a draft the card held, with what was on screen laid over it.
 * `screen` only for a discard: a send writes the screen first, so its draft
 * already is the screen.
 */
export function endedFrom(
  d: DraftEditorData,
  how: EndedHow,
  outcome: EndedCopy["outcome"],
  extra: { screen?: OnScreen | null; sent_at?: string | null; provider?: string | null; at?: number } = {},
): EndedCopy {
  const s = extra.screen ?? null;
  const all = d.attachments ?? [];
  return {
    how,
    outcome,
    at: extra.at ?? Date.now(),
    sent_at: extra.sent_at ?? null,
    from: d.identity?.email_address ?? null,
    to: s ? s.to : d.recipients?.to ?? [],
    cc: s ? s.cc : d.recipients?.cc ?? [],
    bcc: s ? s.bcc : d.recipients?.bcc ?? [],
    subject: s ? s.subject : d.subject ?? "",
    body_text: s ? s.body_text : d.body?.text ?? "",
    // A body the person changed has no HTML part that matches it.
    body_html: s?.unsaved.includes("body") ? null : d.body?.html ?? null,
    truncated: d.body?.truncated === true,
    attachments: all.map((a) => ({ filename: a.filename, size_bytes: a.size_bytes })),
    attachment_count: all.length,
    provider: extra.provider ?? null,
    unsaved: s && s.unsaved.length > 0 ? [...s.unsaved] : undefined,
  };
}

interface Entry {
  t: number;
  /** The card's scope (`persist.ts#cardKey`). */
  k: string;
  /** inbox_id, or "" when the draft named none. */
  i: string;
  c: EndedCopy;
}

function area(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function read(): Entry[] {
  try {
    const raw = area()?.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return (parsed as Entry[]).filter(
      (e) =>
        !!e && typeof e.t === "number" && now - e.t <= ENDED_TTL_MS &&
        typeof e.k === "string" && typeof e.i === "string" && !!e.c && typeof e.c === "object",
    );
  } catch {
    return [];
  }
}

function write(entries: Entry[]): void {
  try {
    const s = area();
    if (!s) return;
    if (entries.length === 0) s.removeItem(KEY);
    else s.setItem(KEY, JSON.stringify(entries));
  } catch {
    /* optional by design */
  }
}

/** The stored shape: the copy without its HTML, bounded. */
function storable(c: EndedCopy): EndedCopy {
  const { body_html: _html, ...rest } = c;
  return {
    ...rest,
    to: c.to.slice(0, MAX_RECIPIENTS),
    cc: c.cc.slice(0, MAX_RECIPIENTS),
    bcc: c.bcc.slice(0, MAX_RECIPIENTS),
    attachments: (c.attachments ?? []).slice(0, MAX_ATTACHMENTS),
  };
}

/** Keep the copy for this card. No scope, no entry: nothing could find it again. */
export function rememberEnded(
  scope: string | null | undefined,
  inbox: string | null | undefined,
  copy: EndedCopy,
): void {
  if (!scope) return;
  const c = storable(copy);
  let size = 0;
  try {
    size = JSON.stringify(c).length;
  } catch {
    return;
  }
  const rest = read().filter((e) => e.k !== scope);
  write(
    size > MAX_CHARS
      ? rest
      : [{ t: Date.now(), k: scope, i: inbox ?? "", c }, ...rest]
        .sort((a, b) => b.t - a.t)
        .slice(0, MAX_ENTRIES),
  );
}

const strings = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((s) => typeof s === "string") ? (v as string[]) : null;
const HOWS: readonly string[] = ["sent", "scheduled", "discarded", "gone", "sent_elsewhere"];
const OUTCOMES: readonly string[] = ["sent", "scheduled", "discarded"];

/**
 * The copy stored for this card, type-checked on the way out, or null. `inbox`
 * is the one the mounting call named, when it named one: a copy from another
 * mailbox under the same scope is not this card's.
 */
export function loadEnded(
  scope: string | null | undefined,
  inbox?: string | null,
): EndedCopy | null {
  if (!scope) return null;
  const hit = read().find((e) => e.k === scope);
  if (!hit) return null;
  if (inbox && hit.i && inbox !== hit.i) return null;
  const c = hit.c as unknown as Record<string, unknown>;
  const to = strings(c.to);
  const cc = strings(c.cc);
  const bcc = strings(c.bcc);
  if (
    !HOWS.includes(String(c.how)) || !OUTCOMES.includes(String(c.outcome)) ||
    !to || !cc || !bcc || typeof c.subject !== "string" || typeof c.body_text !== "string"
  ) {
    return null;
  }
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  const attachments = Array.isArray(c.attachments)
    ? (c.attachments as Array<Record<string, unknown>>)
      .filter((a) => !!a && typeof a.filename === "string")
      .map((a) => ({
        filename: a.filename as string,
        size_bytes: typeof a.size_bytes === "number" ? a.size_bytes : 0,
      }))
    : [];
  const unsaved = (strings(c.unsaved) ?? []).filter((f): f is EndedField =>
    (ENDED_FIELDS as string[]).includes(f)
  );
  return {
    how: c.how as EndedHow,
    outcome: c.outcome as EndedCopy["outcome"],
    at: typeof c.at === "number" ? c.at : hit.t,
    sent_at: text(c.sent_at),
    from: text(c.from),
    to,
    cc,
    bcc,
    subject: c.subject,
    body_text: c.body_text,
    body_html: null,
    truncated: c.truncated === true,
    attachments,
    attachment_count: typeof c.attachment_count === "number" ? c.attachment_count : attachments.length,
    provider: text(c.provider),
    unsaved: unsaved.length > 0 ? unsaved : undefined,
  };
}
