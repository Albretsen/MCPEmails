// ---------------------------------------------------------------------------
// "A draft card just mounted": a hint from one card frame to the others.
//
// QA (2026-10-15): when the assistant rewrites a draft, the call mounts a NEW
// card further down, and the older card above it kept showing the old text
// with Send on until someone touched it (a focus, a Refresh, a Save). The
// server refuses a stale send, so this was confusing rather than unsafe, but
// an older card should not look live.
//
// A card is never told about a later tool call, so the newer card tells the
// older ones. It is a HINT, never a verdict: a card that hears one re-reads its
// own draft through `draft_read` (App.tsx#attentionCheck), and
// store.ts#supersededBy decides from that answer, exactly as it does for a
// Refresh. A forged or misrouted hint therefore costs one read and nothing
// else.
//
// Two carriers, because neither is guaranteed inside a host's sandbox:
//
//   - BroadcastChannel, which reaches every same-origin frame.
//   - A `storage` event: one key written and removed at once. Other
//     same-origin documents get the event; nothing is left in storage.
//
// Frames that share neither (separate origins per card) fall back to the
// re-check on focus, on becoming visible, and on scrolling back into view
// (App.tsx). None of the three polls: each is one read in answer to an event.
//
// ── WHAT IS SENT ───────────────────────────────────────────────────────────
// Digests of the draft's ids and of its inbox, the revision, and who last
// wrote it. No subject, no body, no address. The digests only have to be
// equal across frames of one browser; they are not a secret, and they are
// never stored (the storage carrier removes its key in the same tick).
//
// ── A CLAIM: "this card is the current one now" (2026-10-17) ──────────────
// Live review in claude.ai: an older card that SAVED became live again, and the
// newer card below kept Send on for about five seconds until its own re-read
// caught up, so two cards could send one draft. So a card that takes the draft
// over (a successful Save, or "Open here" on a folded card) sends a claim, and
// every other card holding any id of the same draft folds AT ONCE, with no
// read: folding only takes Send away and offers "Open here", so a forged or
// stale claim costs one click. A claim carries the digests of every id the
// claiming card has held (`ids`, newest last, at most four) and the revision
// it was MOUNTED with, which tells a receiver whether the claimer sits above
// or below it in the chat (a later tool call has a higher revision).
//
// A claim never answers a claim and never causes a read, so it cannot loop
// either. A frame running an older bundle reads a claim as a hint: one read.
//
// ── WHY THIS CANNOT LOOP ───────────────────────────────────────────────────
// A hint is sent ONLY when a card accepts a fresh pushed result, i.e. a tool
// call the assistant made (store.ts#wireResultHandlers). A replayed result, a
// re-read, a save, a Refresh: none of them sends one. So a card answering a
// hint with a read sends nothing, and nothing answers it.
// ---------------------------------------------------------------------------

export const SIGNAL_CHANNEL = "mcpemails-draft-cards";
export const SIGNAL_KEY = "mcpemails.draft.signal";
const SIGNAL_TYPE = "mcpemails-draft/1";

/**
 * At most one hinted re-read per card in this long. Both carriers can deliver
 * the same hint, and several new cards can mount in one turn.
 */
export const SIGNAL_GAP_MS = 2_000;

export interface DraftSignal {
  /** Which frame sent it, so a frame never answers its own. */
  from: string;
  /** Digests of the draft's ids (`draft_id`, `resolved_from`). */
  ids: string[];
  /** Digest of the inbox id. */
  inbox: string | null;
  revision: number | null;
  /** "hint" (a card mounted) or "claim" (a card took the draft over). */
  kind: "hint" | "claim";
  /** The revision the sending card was mounted with, on a claim. */
  mounted: number | null;
}

/** This frame's own name. Random per load, never stored. */
const self = Math.random().toString(36).slice(2) + Date.now().toString(36);

/** FNV-1a, 32-bit, seedable. A comparison key, not a security primitive. */
function fnv1a(s: string, seed = 0x811c9dc5): string {
  let h = seed;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** The digest of one id, or null for none. Equal across frames. */
export function signalTag(id: string | null | undefined): string | null {
  if (!id) return null;
  const k = `draft-signal ${id}`;
  return `${fnv1a(k)}${fnv1a(k, 0x01000193)}`;
}

function channelCtor(): typeof BroadcastChannel | null {
  try {
    const w = typeof window !== "undefined" ? (window as unknown as { BroadcastChannel?: typeof BroadcastChannel }) : null;
    return w?.BroadcastChannel ?? null;
  } catch {
    return null;
  }
}

function parse(raw: unknown): DraftSignal | null {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.t !== SIGNAL_TYPE || typeof o.from !== "string" || o.from === self) return null;
  const ids = Array.isArray(o.ids) ? o.ids.filter((x): x is string => typeof x === "string").slice(-4) : [];
  return {
    from: o.from,
    ids,
    inbox: typeof o.inbox === "string" ? o.inbox : null,
    revision: typeof o.revision === "number" ? o.revision : null,
    kind: o.kind === "claim" ? "claim" : "hint",
    mounted: typeof o.mounted === "number" ? o.mounted : null,
  };
}

/** Post one message on both carriers. Never throws. */
function post(msg: Record<string, unknown>): void {
  const Ctor = channelCtor();
  if (Ctor) {
    try {
      const ch = new Ctor(SIGNAL_CHANNEL);
      ch.postMessage(msg);
      ch.close();
    } catch {
      /* no channel in this sandbox: the storage carrier may still work */
    }
  }
  try {
    const ls = window.localStorage;
    ls.setItem(SIGNAL_KEY, JSON.stringify({ ...msg, at: Date.now() }));
    ls.removeItem(SIGNAL_KEY);
  } catch {
    /* storage blocked: the focus and visibility re-checks still apply */
  }
}

/**
 * Tell the other card frames that THIS card is now the current one for the
 * draft (see "A CLAIM" above). `ids` is every id this card has held for it.
 * Never throws.
 */
export function claimDraft(d: {
  ids: Array<string | null | undefined>;
  revision?: number | null;
  mounted?: number | null;
  inbox_id?: string | null;
}): void {
  const ids = [...new Set(d.ids.map((id) => signalTag(id)).filter((x): x is string => !!x))].slice(-4);
  if (ids.length === 0) return;
  post({
    t: SIGNAL_TYPE,
    kind: "claim",
    from: self,
    ids,
    inbox: signalTag(d.inbox_id ?? null),
    revision: typeof d.revision === "number" ? d.revision : null,
    mounted: typeof d.mounted === "number" ? d.mounted : null,
  });
}

/** Tell the other card frames that this one just mounted a draft. Never throws. */
export function announceDraft(d: {
  draft_id?: string | null;
  resolved_from?: string | null;
  revision?: number | null;
  identity?: { inbox_id?: string | null } | null;
}): void {
  const ids = [signalTag(d.draft_id), signalTag(d.resolved_from)].filter((x): x is string => !!x);
  if (ids.length === 0) return;
  post({
    t: SIGNAL_TYPE,
    from: self,
    ids,
    inbox: signalTag(d.identity?.inbox_id ?? null),
    revision: typeof d.revision === "number" ? d.revision : null,
  });
}

/**
 * Listen for other frames' hints. Returns the unsubscribe. Both carriers can
 * deliver the same hint; the caller's own throttle makes that one read.
 */
export function onDraftSignal(fn: (s: DraftSignal) => void): () => void {
  const offs: Array<() => void> = [];
  const Ctor = channelCtor();
  if (Ctor) {
    try {
      const ch = new Ctor(SIGNAL_CHANNEL);
      ch.onmessage = (e: MessageEvent) => {
        const s = parse(e.data);
        if (s) fn(s);
      };
      offs.push(() => ch.close());
    } catch {
      /* see announceDraft */
    }
  }
  try {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== SIGNAL_KEY || !e.newValue) return;
      const s = parse(e.newValue);
      if (s) fn(s);
    };
    window.addEventListener("storage", onStorage);
    offs.push(() => window.removeEventListener("storage", onStorage));
  } catch {
    /* no window: nothing to listen on */
  }
  return () => {
    for (const off of offs) off();
  };
}
