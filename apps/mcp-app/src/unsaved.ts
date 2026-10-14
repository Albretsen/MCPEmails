// ---------------------------------------------------------------------------
// Unsaved edits, kept for the life of the TAB so a page reload does not eat
// them. One of the two places in the card that write message content to web
// storage; the other is ended.ts, the copy a sent or discarded card keeps for
// its "Show" link, which makes the same trade under the same rules.
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
//
// ── And scoped to the CARD (review 2 of 2026-10-13) ─────────────────────────
// Matching on any id of the draft alone meant a second card on the same draft
// in the same tab (a Gmail id never moves, so every card of that draft shares
// it) booted with the FIRST card's edits. So an entry also carries the card's
// scope: `persist.ts#cardKey`, the identity of the tool call the card was
// mounted for (`i<id>` from `hostContext.toolInfo`, else a salted hash of the
// tool name and arguments, which the host re-sends on every mount). It is the
// same value on a reload of the same cell and a different one for another
// call, which is exactly the line between "put my edits back" and "these are
// somebody else's". Two calls with byte-identical arguments still share a
// scope; so does a host that sends neither `toolInfo` nor the arguments
// (scope null), which is the behaviour before this.
//
// ── And with the copy they were made against ───────────────────────────────
// Restored edits are relative to a server copy this mount never saw. Each
// entry keeps a FINGERPRINT (`fingerprint`, not the value) of every edited
// field as the server had it when the edit was made, so the editor can tell a
// field the server has since changed (a conflict, shown as one) from one it
// has not. The edited values themselves are already stored here, so a short
// hash of the old ones adds nothing a reader of this sink could not see.
// ---------------------------------------------------------------------------

const KEY = "mcpemails.unsaved.v1";
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5;
const MAX_IDS = 12;
/** One draft's worth: the server clips a body at 64 KB. */
const MAX_CHARS = 200_000;

export type UnsavedField = "to" | "cc" | "bcc" | "subject" | "body_text";
const UNSAVED_FIELDS: UnsavedField[] = ["to", "cc", "bcc", "subject", "body_text"];

export interface Unsaved {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body_text?: string;
  /** What was in the address inputs and not yet a chip. */
  typed?: { to?: string; cc?: string; bcc?: string };
  /**
   * `fingerprint` of each edited field as the SERVER had it when the edit was
   * made. Absent for an entry written before this existed.
   */
  bases?: Partial<Record<UnsavedField, string>>;
}

interface Entry {
  t: number;
  /** inbox_id, or "" when the envelope named none. */
  i: string;
  /** The card's scope (`persist.ts#cardKey`), or null when it had none. */
  k?: string | null;
  ids: string[];
  p: Unsaved;
}

/**
 * A short, stable digest of one field's value (FNV-1a, two seeds). For
 * comparing two copies in the same tab, never for anything else.
 */
export function fingerprint(value: string): string {
  const pass = (seed: number) => {
    let h = seed;
    for (let i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
  };
  return `${pass(0x811c9dc5)}${pass(0x01000193)}`;
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

const matches = (
  e: Entry,
  inbox: string,
  ids: readonly string[],
  scope: string | null,
): boolean =>
  e.i === inbox && (e.k ?? null) === scope && e.ids.some((id) => ids.includes(id));

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((s) => typeof s === "string") ? (v as string[]) : undefined;

/** The edits stored for this draft, type-checked on the way out. */
export function loadUnsaved(
  inbox: string | null | undefined,
  ids: readonly string[],
  scope: string | null = null,
): Unsaved | null {
  const hit = read().find((e) => matches(e, inbox ?? "", ids, scope));
  if (!hit) return null;
  const p = hit.p as Record<string, unknown>;
  const typed = (p.typed ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);
  const rawBases = (p.bases ?? {}) as Record<string, unknown>;
  const bases: Partial<Record<UnsavedField, string>> = {};
  for (const f of UNSAVED_FIELDS) {
    const v = text(rawBases[f]);
    if (v !== undefined) bases[f] = v;
  }
  return {
    to: strings(p.to),
    cc: strings(p.cc),
    bcc: strings(p.bcc),
    subject: text(p.subject),
    body_text: text(p.body_text),
    typed: { to: text(typed.to), cc: text(typed.cc), bcc: text(typed.bcc) },
    bases,
  };
}

export function saveUnsaved(
  inbox: string | null | undefined,
  ids: readonly string[],
  edits: Unsaved,
  scope: string | null = null,
): void {
  if (ids.length === 0) return;
  const key = inbox ?? "";
  const all = read();
  const old = all.find((e) => matches(e, key, ids, scope));
  const merged = [...new Set([...(old?.ids ?? []), ...ids])];
  const entry: Entry = {
    t: Date.now(),
    i: key,
    k: scope,
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
  scope: string | null = null,
): void {
  const all = read();
  const kept = all.filter((e) => !matches(e, inbox ?? "", ids, scope));
  if (kept.length !== all.length || all.length === 0) write(kept);
}
