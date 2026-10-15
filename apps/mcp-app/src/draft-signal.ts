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
  const ids = Array.isArray(o.ids) ? o.ids.filter((x): x is string => typeof x === "string").slice(0, 4) : [];
  return {
    from: o.from,
    ids,
    inbox: typeof o.inbox === "string" ? o.inbox : null,
    revision: typeof o.revision === "number" ? o.revision : null,
  };
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
  const msg = {
    t: SIGNAL_TYPE,
    from: self,
    ids,
    inbox: signalTag(d.identity?.inbox_id ?? null),
    revision: typeof d.revision === "number" ? d.revision : null,
  };
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
