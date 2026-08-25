// ---------------------------------------------------------------------------
// Tiny observable store.
//
// Exists because of phase-0 Q7.12: `ui/notifications/tool-input` and
// `-result` are one-shot events that can land before the UI has mounted, so
// the handlers must be registered BEFORE the handshake. main.tsx wires the
// bridge into this store immediately; the Preact tree subscribes whenever it
// gets around to mounting and reads whatever already arrived.
// ---------------------------------------------------------------------------

import type {
  HostBridge,
  HostContext,
  ToolCancelledParams,
  ToolResultParams,
} from "./bridge";
import { isEnvelope, type Envelope } from "./contract";
import { neutralizeDeep, neutralizeText } from "./sanitize";

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
 *
 * Two more states exist for the case where there is no tool result at all,
 * which used to be indistinguishable from "the result has not landed yet" and
 * therefore pinned the card on its loading skeleton forever:
 *
 *   cancelled — the host sent `ui/notifications/tool-cancelled`. The call was
 *               abandoned (user action, sampling error, classifier
 *               intervention) and there will never be a result. Render
 *               NOTHING: the host displays its own cancellation message, and a
 *               second one from us would just be noise.
 *   absent    — the watchdog fired: connect() resolved and no result or
 *               cancellation followed. Overwhelmingly this is the remount case
 *               (see `armResultWatchdog`). Render NOTHING, for exactly the
 *               reason `foreign` renders nothing.
 *
 * `cancelled` and `absent` render identically today, and they are still two
 * values rather than one, because they are two different facts about the world:
 * one is a call that was stopped, the other is a card that was never told
 * anything. Collapsing them would throw that away at the only layer that still
 * knows the difference. Neither is `foreign` either, for the same reason.
 */
export type ResultStatus =
  | "waiting"
  | "envelope"
  | "foreign"
  | "malformed"
  | "cancelled"
  | "absent";

/**
 * The `tools/call` that instantiated this app, flattened out of
 * `hostContext.toolInfo` for diagnostics.
 *
 * Both halves are useful the next time a card renders empty: `tool` says which
 * of our tools was supposed to produce an envelope (and so whether an absent
 * result is even surprising), and `callId` is the JSON-RPC id that correlates
 * the frame with a row in the server's activity log.
 */
export interface ToolInfoSummary {
  tool: string | null;
  callId: string | number | null;
}

export interface CardStore {
  envelope: Envelope | null;
  /** Classification of the most recent tool result. See `ResultStatus`. */
  resultStatus: ResultStatus;
  hostContext: HostContext;
  connected: boolean;
  connectError: string | null;
  /** Diagnostics only, never rendered. Absent on hosts that omit it (Q6). */
  toolInfo: ToolInfoSummary | null;
}

let state: CardStore = {
  envelope: null,
  resultStatus: "waiting",
  hostContext: {},
  connected: false,
  connectError: null,
  toolInfo: null,
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

// ---------------------------------------------------------------------------
// Getting off "waiting"
//
// `waiting` is the only non-terminal status, and until the watchdog below
// existed there was exactly one thing in the entire card that could end it:
// `ui/notifications/tool-result`. That is a bad single point of failure,
// because the spec does not promise the notification at all. It says the host
// "MUST send this notification when tool execution completes (if the View is
// displayed during tool execution)". The parenthetical is the bug: a view that
// mounts AFTER execution finished is owed nothing, and the spec defines no
// replay for a re-mounted view (state persistence and restoration are
// explicitly deferred out of the MVP; the matching upstream issue,
// openai/openai-apps-sdk-examples#195, is open with no official workaround).
//
// On Claude specifically this is routine rather than exotic: reopening a stored
// conversation lazy-mounts widget cells as they scroll into view, so every
// scroll-back through an old thread re-instantiates a card whose tool call
// finished days ago. Graceful degradation is the only answer available.
// ---------------------------------------------------------------------------

/**
 * How long after a successful handshake the card will keep waiting for a
 * result before deciding it is never getting one.
 *
 * Claude's supersession guidance says the host delivers the mounting tool
 * result "shortly after connect() resolves", and phase-0 saw tool-input and
 * tool-result land effectively in the same tick as the handshake (Q7.12) which
 * is why every handler is registered before connect() rather than after. So the
 * honest expectation is single-digit milliseconds and this budget is roughly
 * three orders of magnitude of headroom.
 *
 * 3s is picked from both ends. Too short and a slow-but-working host gets cut
 * off mid-delivery and the user loses a card they were entitled to (the failure
 * mode here is silent, so that would be a bad trade); too long and the user is
 * left reading a loading skeleton that is never going to resolve, which is the
 * exact symptom being fixed. 3s is comfortably past any plausible delivery and
 * still under the point where a stuck skeleton reads as a broken product. It is
 * deliberately well inside `INITIALIZE_TIMEOUT_MS` (10s), which covers the
 * other half of the problem: a host that never completes the handshake at all
 * surfaces as `connectError`, not as this.
 */
export const RESULT_WATCHDOG_MS = 3_000;

let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

/** Stop the watchdog. Idempotent, and safe to call when it never started. */
export function disarmResultWatchdog() {
  if (watchdogTimer !== null) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

/**
 * Start the watchdog. MUST be called after `connect()` resolves, never at
 * module load: before the handshake completes there is no host to be late, and
 * a timer started at load would be racing the host's own startup instead of its
 * delivery.
 *
 * The fallback state is a floor, not a ceiling. `absent` only ever replaces
 * `waiting`, and a result that arrives after the deadline still overwrites it
 * through the normal `onToolResult` path, so a very late envelope renders
 * exactly as if it had been on time.
 */
export function armResultWatchdog(bridge: HostBridge): () => void {
  disarmResultWatchdog();

  // Read at arm time, which is immediately post-connect: this is the moment
  // `hostContext` is populated and the moment the fields are worth recording.
  setState({ toolInfo: toolInfoFrom(bridge.hostContext) });

  const startedAt = Date.now();
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null;
    // Anything already terminal wins. The watchdog exists to break a deadlock,
    // not to have an opinion about a result that did arrive.
    if (getState().resultStatus !== "waiting") return;

    setState({ resultStatus: "absent" });

    // Fire-and-forget, after the state is already committed, so a host with no
    // log channel cannot affect what the user sees. Protocol facts only.
    const info = getState().toolInfo;
    bridge.log("warning", {
      event: "tool_result_absent",
      waited_ms: Date.now() - startedAt,
      protocol_version: bridge.protocolVersion,
      host: bridge.hostInfo?.name ?? null,
      tool: info?.tool ?? null,
      call_id: info?.callId ?? null,
      note:
        "No ui/notifications/tool-result or -cancelled after connect. " +
        "Card collapsed instead of holding its loading state.",
    });
  }, RESULT_WATCHDOG_MS);

  return disarmResultWatchdog;
}

/** Flatten `hostContext.toolInfo` into the two fields worth keeping. */
export function toolInfoFrom(ctx: HostContext | undefined): ToolInfoSummary | null {
  const info = ctx?.toolInfo;
  if (!info || typeof info !== "object") return null;
  const name = info.tool?.name;
  const id = info.id;
  return {
    // Server-authored in practice, but it reaches us through the host, and it
    // costs nothing to put it through the same boundary as everything else.
    tool: typeof name === "string" ? neutralizeText(name).slice(0, 64) : null,
    callId: typeof id === "string" || typeof id === "number" ? id : null,
  };
}

/**
 * Attach the result handlers to a bridge.
 *
 * Lives here rather than in main.tsx so that the whole waiting -> terminal
 * state machine is one DOM-free unit that can be driven directly, which is how
 * `harness/state-machine.mjs` proves the three no-result paths.
 */
export function wireResultHandlers(bridge: HostBridge) {
  bridge.onToolResult = (params: ToolResultParams) => {
    // `status` matters as much as `envelope`: a result that is not ours at all
    // (an opted-out inbox, a non-plannable email_organize action) must leave
    // the card silent rather than warn under a successful operation.
    const { envelope, status } = classifyResult(params);
    // Unconditional, including after the watchdog has already given up. A late
    // envelope is still a real envelope and must render.
    disarmResultWatchdog();
    setState(envelope ? { envelope, resultStatus: status } : { resultStatus: status });
  };

  bridge.onToolCancelled = (_params: ToolCancelledParams) => {
    disarmResultWatchdog();
    // Only ever leaves `waiting`. If a result somehow already landed, it is the
    // better information and a cancellation arriving afterwards must not wipe
    // a card the user is looking at.
    if (getState().resultStatus !== "waiting") return;
    setState({ resultStatus: "cancelled" });
  };
}
