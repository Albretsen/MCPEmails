// ---------------------------------------------------------------------------
// Tiny observable store.
//
// Exists because of phase-0 Q7.12: `ui/notifications/tool-input` and
// `-result` are one-shot events that can land before the UI has mounted, so
// the handlers must be registered BEFORE the handshake. main.tsx wires the
// bridge into this store immediately; the Preact tree subscribes whenever it
// gets around to mounting and reads whatever already arrived.
// ---------------------------------------------------------------------------

import type { HostContext, ToolResultParams } from "./bridge";
import { isEnvelope, type Envelope } from "./contract";
import { neutralizeDeep } from "./sanitize";

/**
 * What the last tool result was, which is NOT the same question as "did it
 * parse".
 *
 * `_meta.ui` is per-TOOL, not per-call: a host renders this card for every
 * result of a UI-bearing tool, including results that were never meant for it.
 * Two of those happen in production today — an API key spanning one opted-in
 * and one opted-out inbox gets the card metadata on `email_delete`, and
 * `email_organize`'s non-plannable actions (`copy_batch`, `flag`, `archive`)
 * never produce a plan. Both return today's ordinary payload, which is not an
 * envelope and is not supposed to be.
 *
 * So the card distinguishes two failures that used to be one:
 *
 *   foreign   — not our payload. The tool succeeded, the host is showing its
 *               text result, and the card has nothing to add. Render NOTHING.
 *               A scary "this review could not be displayed" warning under a
 *               perfectly successful delete is worse than no card at all.
 *   malformed — our payload (it carries `schema_version`), but unreadable.
 *               That is a real defect on our side and stays loud.
 */
export type ResultStatus = "waiting" | "envelope" | "foreign" | "malformed";

export interface CardStore {
  envelope: Envelope | null;
  /** Classification of the most recent tool result. See `ResultStatus`. */
  resultStatus: ResultStatus;
  hostContext: HostContext;
  connected: boolean;
  connectError: string | null;
}

let state: CardStore = {
  envelope: null,
  resultStatus: "waiting",
  hostContext: {},
  connected: false,
  connectError: null,
};

const listeners = new Set<() => void>();

export function getState(): CardStore {
  return state;
}

export function setState(patch: Partial<CardStore>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Does this payload claim to be ours?
 *
 * The key presence of `schema_version` is the discriminator, deliberately
 * looser than `isEnvelope`. No other tool result in this server carries that
 * key, so:
 *   - absent  -> somebody else's payload; the card must stay quiet.
 *   - present but unreadable -> ours and broken; the card must complain.
 * The type of the value is not checked, because `{ schema_version: 2 }` is
 * still unmistakably an attempt at our envelope.
 */
function claimsToBeOurs(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "schema_version" in (value as Record<string, unknown>)
  );
}

export interface ClassifiedResult {
  envelope: Envelope | null;
  status: ResultStatus;
}

/**
 * Pull the contract envelope out of a tool result, and say what happened when
 * there isn't one.
 *
 * `structuredContent` is the card channel (contract §7). The `content` array is
 * the model-visible prose fallback; we parse it only if a host delivers
 * structured content in some other shape, so that a degraded host still renders
 * something rather than an empty card.
 */
export function classifyResult(result: ToolResultParams | undefined): ClassifiedResult {
  if (!result) return { envelope: null, status: "waiting" };

  const sc = result.structuredContent;
  // Every string in the payload is neutralised once, here, at the boundary:
  // bidi overrides and zero-width characters in a subject, display name or
  // attachment filename can make the card display something other than what
  // will be sent. See sanitize.ts#neutralizeText.
  if (isEnvelope(sc)) {
    return { envelope: neutralizeDeep(sc as Envelope), status: "envelope" };
  }
  if (claimsToBeOurs(sc)) return { envelope: null, status: "malformed" };

  const text = result.content?.find((c) => c?.type === "text")?.text;
  if (typeof text === "string" && text.trim().startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isEnvelope(parsed)) {
        return { envelope: neutralizeDeep(parsed), status: "envelope" };
      }
      if (claimsToBeOurs(parsed)) return { envelope: null, status: "malformed" };
    } catch {
      /* prose, not JSON — expected */
    }
  }

  // Not our payload. The tool did whatever it does, the host is showing its
  // own text result, and this card has nothing to say about it.
  return { envelope: null, status: "foreign" };
}

/** Convenience wrapper for callers that only need the envelope. */
export function envelopeFrom(result: ToolResultParams | undefined): Envelope | null {
  return classifyResult(result).envelope;
}
