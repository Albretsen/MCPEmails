// ---------------------------------------------------------------------------
// Unsaved edits, kept for the life of the TAB so a page reload does not eat
// them. The one place in the card that writes message content to web storage.
//
// ── Why this is not in persist.ts, and not in localStorage ──────────────────
// persist.ts keeps a POINTER and never content, and its header says why: the
// sink is durable, it is not scoped to a conversation, and whether the sandbox
// origin is private to this app cannot be read from inside the frame. None of
// that has changed, so none of this goes there.
//
// What changed is the QA finding of 2026-10-13: a reload dropped a half-edited
// draft without a word. `ui/resource-teardown` cannot help, because on a reload
// it is the HOST that is going away and nothing can wait for a tool call. The
// only thing that survives is storage, so the trade is made as narrowly as it
// can be:
//
//   - sessionStorage, never localStorage. It dies with the tab, which is the
//     bound persist.ts could not get from a TTL, and it is exactly as long as a
//     reload needs.
//   - only the fields the user CHANGED, never the draft. A clean editor stores
//     nothing and removes what was there.
//   - removed on save, on send, on discard, and when the editor goes away.
//   - a TTL and a small cap anyway, for a tab that is left open for days.
//
// Storage is optional, always: every access is wrapped, and a host that keeps
// nothing gets the behaviour the card had before this file existed, which is
// why the editor also says "Unsaved changes" out loud.
//
// ── Keyed by LINEAGE ────────────────────────────────────────────────────────
// A draft's id changes on every IMAP save, and a re-mounted card is handed its
// ORIGINAL tool result, so "the draft id" at write time and at read time are
// routinely different strings for the same draft. An entry therefore carries
// every id the editor has held for it, and a lookup matches on any of them
// within the same inbox. The id a card mounted with is always the first one in
// that list, so a replayed mount finds the edits made three saves later.
// ---------------------------------------------------------------------------

const KEY = "mcpemails.unsaved.v1";
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5;
const MAX_IDS = 12;
/** One draft's worth: the server clips a body at 64 KB. */
const MAX_CHARS = 200_000;

export interface Unsaved {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body_text?: string;
  /** What was in the address inputs and not yet a chip. */
  typed?: { to?: string; cc?: string; bcc?: string };
}

interface Entry {
  t: number;
  /** inbox_id, or "" when the envelope named none. */
  i: string;
  ids: string[];
  p: Unsaved;
}

function area(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    // Reading the property itself throws in a frame denied storage access.
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
        !!e &&
        typeof e.t === "number" &&
        now - e.t <= TTL_MS &&
        typeof e.i === "string" &&
        Array.isArray(e.ids) &&
        !!e.p &&
        typeof e.p === "object",
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

const matches = (e: Entry, inbox: string, ids: readonly string[]): boolean =>
  e.i === inbox && e.ids.some((id) => ids.includes(id));

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((s) => typeof s === "string") ? (v as string[]) : undefined;

/** The edits stored for this draft, type-checked on the way out. */
export function loadUnsaved(
  inbox: string | null | undefined,
  ids: readonly string[],
): Unsaved | null {
  const hit = read().find((e) => matches(e, inbox ?? "", ids));
  if (!hit) return null;
  const p = hit.p as Record<string, unknown>;
  const typed = (p.typed ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    to: strings(p.to),
    cc: strings(p.cc),
    bcc: strings(p.bcc),
    subject: text(p.subject),
    body_text: text(p.body_text),
    typed: { to: text(typed.to), cc: text(typed.cc), bcc: text(typed.bcc) },
  };
}

export function saveUnsaved(
  inbox: string | null | undefined,
  ids: readonly string[],
  edits: Unsaved,
): void {
  if (ids.length === 0) return;
  const key = inbox ?? "";
  const all = read();
  const old = all.find((e) => matches(e, key, ids));
  const merged = [...new Set([...(old?.ids ?? []), ...ids])];
  const entry: Entry = {
    t: Date.now(),
    i: key,
    // The FIRST id is the one a replayed mount will ask with, so it is the one
    // that must never be evicted.
    ids: merged.length > MAX_IDS ? [merged[0], ...merged.slice(1 - MAX_IDS)] : merged,
    p: edits,
  };
  let size = 0;
  try {
    size = JSON.stringify(edits).length;
  } catch {
    return;
  }
  const rest = all.filter((e) => e !== old);
  // Too big to keep is treated as nothing to keep, and the stale copy goes too:
  // restoring an older edit than the one on screen would be worse than none.
  write(
    size > MAX_CHARS
      ? rest
      : [entry, ...rest].sort((a, b) => b.t - a.t).slice(0, MAX_ENTRIES),
  );
}

export function clearUnsaved(
  inbox: string | null | undefined,
  ids: readonly string[],
): void {
  const all = read();
  const kept = all.filter((e) => !matches(e, inbox ?? "", ids));
  if (kept.length !== all.length || all.length === 0) write(kept);
}
