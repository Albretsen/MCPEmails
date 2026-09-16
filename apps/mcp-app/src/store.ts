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
import { cardKey, loadEnvelope, saveEnvelope } from "./persist";
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

/**
 * Whether a tool result arrived, and whether it beat the watchdog.
 *
 * Distinct from `ResultStatus` because it answers a question about the HOST
 * rather than about the payload: "none" on a card that restored itself from
 * storage is the remount case working as designed, and "late" says the host
 * does deliver to a re-mounted view, only slower than the watchdog allows. We
 * cannot read Claude's logs, so the diagnostics line is how that gets measured.
 */
export type ResultArrival = "none" | "ontime" | "late";

export interface CardStore {
  envelope: Envelope | null;
  /** Classification of the most recent tool result. See `ResultStatus`. */
  resultStatus: ResultStatus;
  hostContext: HostContext;
  connected: boolean;
  connectError: string | null;
  /** Diagnostics only, never rendered. Absent on hosts that omit it (Q6). */
  toolInfo: ToolInfoSummary | null;
  /**
   * The arguments of the originating `tools/call`, from
   * `ui/notifications/tool-input`. NEVER rendered: they are agent-authored and
   * carry no field the envelope lacks. Kept only as cache-key material for a
   * host that omits `toolInfo` (persist.ts#cardKey).
   */
  toolInput: Record<string, unknown> | null;
  /** Did the host deliver a result at all, and was it late? */
  resultArrival: ResultArrival;
  /**
   * Milliseconds from the handshake resolving to the tool result landing, or
   * null when none has. Diagnostics only, and internal-only: it is how
   * RESULT_WATCHDOG_MS gets set from the real host's timing instead of the
   * reference host's. Goes when the diagnostics line goes.
   */
  resultAfterMs: number | null;
  /**
   * Bumped once per `ui/initialize` attempt, purely to wake subscribers so the
   * diagnostics line re-reads the bridge's live counters. Rendered by nothing.
   * Goes when the diagnostics line goes.
   */
  handshakeTick: number;
  /**
   * `null` until a restore has been attempted, then what it found. The card
   * must not draw its "nothing to show" placeholder while this is still null,
   * because that is the state in which the answer is genuinely not known yet.
   */
  restored: "storage" | "none" | null;
}

let state: CardStore = {
  envelope: null,
  resultStatus: "waiting",
  hostContext: {},
  connected: false,
  connectError: null,
  toolInfo: null,
  toolInput: null,
  resultArrival: "none",
  resultAfterMs: null,
  handshakeTick: 0,
  restored: null,
};

const listeners = new Set<() => void>();

export function getState(): CardStore {
  return state;
}

export function setState(patch: Partial<CardStore>) {
  state = { ...state, ...patch };
  // Every state change that carries an envelope updates the cache, not just the
  // mounting result: the envelope the user is looking at after a save, a send
  // or a local cancel is the one they should see again on remount, and it is
  // the only one the server will not hand back (an IMAP save retires the id).
  if (patch.envelope) persist(state);
  for (const l of listeners) l();
}

function persist(s: CardStore) {
  if (!s.envelope) return;
  const key = cardKey(s.toolInfo, s.toolInput);
  if (key) saveEnvelope(key, s.envelope);
}

/**
 * Put back the envelope this call last rendered, if this host kept it.
 *
 * Idempotent and one-shot: `restored` going non-null is what stops it running
 * again, and an envelope that has already arrived wins outright — restoring
 * over a live result would replace the truth with a memory of it.
 *
 * `quiet` is for the tool-input trigger, which fires while a result may still
 * be milliseconds away: it restores a hit but does not record a miss, so a
 * perfectly normal first mount is not pushed into its "nothing found" rendering
 * one tick before the result lands. The watchdog calls it without `quiet` and
 * that is what finally settles the question.
 */
export function attemptRestore(quiet = false): void {
  if (state.envelope || state.restored !== null) return;
  const key = cardKey(state.toolInfo, state.toolInput);
  const found = key ? loadEnvelope(key) : null;
  if (found) setState({ envelope: found, restored: "storage" });
  else if (!quiet) setState({ restored: "none" });
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------------------------------------------------------------------------
// Unsaved work at teardown
//
// `ui/resource-teardown` is handled in main.tsx, outside the Preact tree, but
// the only thing that knows whether there is unsaved work is a component. This
// is the one-slot handoff between them: the draft editor registers a saver
// while it is dirty and clears it as soon as it is not, so main.tsx can await
// "whatever still needs writing" without knowing what a draft is.
//
// Deliberately one slot, not a set: one card is mounted per frame.
// ---------------------------------------------------------------------------

let teardownSaver: (() => Promise<unknown>) | null = null;

/** Register (or clear, with `null`) the work to finish before teardown. */
export function setTeardownSaver(fn: (() => Promise<unknown>) | null) {
  teardownSaver = fn;
}

/**
 * Run the registered saver, if any. Never throws: the teardown reply is owed
 * to the host whether or not the save worked. The bridge caps how long this is
 * allowed to take (`TEARDOWN_TIMEOUT_MS`).
 */
export async function runTeardownSaver(): Promise<void> {
  const fn = teardownSaver;
  if (!fn) return;
  // Cleared first: teardown happens once, and a retry on a frame that is going
  // away would only be a second write nobody can see the result of.
  teardownSaver = null;
  try {
    await fn();
  } catch {
    /* nothing left to tell the user: the card is being torn down */
  }
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
 * Was 3s, cut to 1.5s, raised to 4s on 2026-09-16 once the real host could
 * finally be read. The 1.5s was set against phase-0's reference-host timing
 * (tool-input and tool-result in effectively the same tick as the handshake,
 * Q7.12) on the theory that the honest expectation was single-digit
 * milliseconds and the rest was headroom. The first diagnostics line out of
 * Claude says otherwise: `result late`. The host DOES deliver to a freshly
 * mounted view, just not within 1.5s, so the budget was cutting off a host that
 * was working — and the visible cost is a "nothing to show" placeholder
 * flashing in front of a card that then renders perfectly well, on every single
 * card.
 *
 * The asymmetry that justified cutting it still holds and now points the other
 * way. Firing late costs loading state on a card that is never getting a
 * result; firing early costs a flash on every card that is. Claude is the host
 * we have, and it is late, so the budget follows it.
 *
 * Still deliberately well inside `INITIALIZE_TIMEOUT_MS` (10s), which covers
 * the other half of the problem: a host that never completes the handshake at
 * all surfaces as `connectError`, not as this. How late Claude actually is,
 * is not yet known — the diagnostics line now prints the elapsed ms so the next
 * screenshot settles whether 4s is generous or still short.
 */
export const RESULT_WATCHDOG_MS = 4_000;

let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * When the watchdog was armed, i.e. when the handshake resolved. Null until
 * then, which is also the answer to "how late was a result that arrived before
 * we were ready for one": unknowable, and not interesting.
 */
let armedAt: number | null = null;

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
  // Same instant the watchdog is measured from, so "result after 2340ms" and
  // "the watchdog fired at 4000ms" are on one clock and directly comparable.
  armedAt = startedAt;
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null;
    // Anything already terminal wins. The watchdog exists to break a deadlock,
    // not to have an opinion about a result that did arrive.
    if (getState().resultStatus !== "waiting") return;

    setState({ resultStatus: "absent" });
    // The deadline is also the last moment the question "is there a remembered
    // envelope for this call" is still open, so it is answered here rather than
    // left to a component: this is the path the founder's "it doesn't load if I
    // leave the chat and come back" actually takes.
    attemptRestore();

    // Fire-and-forget, after the state is already committed, so a host with no
    // log channel cannot affect what the user sees. Protocol facts only.
    const s = getState();
    bridge.log("warning", {
      event: "tool_result_absent",
      waited_ms: Date.now() - startedAt,
      protocol_version: bridge.protocolVersion,
      host: bridge.hostInfo?.name ?? null,
      tool: s.toolInfo?.tool ?? null,
      call_id: s.toolInfo?.callId ?? null,
      had_tool_input: s.toolInput !== null,
      restored: s.restored,
      note:
        "No ui/notifications/tool-result or -cancelled after connect. " +
        "Card fell back to its stored envelope, or to a one-line placeholder.",
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
  // The host MUST send tool-input with the full arguments after ui/initialize,
  // including to a view that mounts long after the call finished — which makes
  // it the only thing a re-mounted card is guaranteed to receive, and therefore
  // the trigger for putting the last envelope back. The arguments themselves
  // are never rendered; they are agent-authored and the envelope has every
  // field the card needs.
  bridge.onToolInput = (args: Record<string, unknown> | undefined) => {
    setState({ toolInput: args ?? {} });
    // `quiet`: a hit restores immediately, a miss waits for the watchdog. On a
    // first mount the result is usually a tick behind this notification, and
    // recording the miss here would flash a "nothing to show" line in front of
    // a card that is about to render perfectly well.
    attemptRestore(true);
  };

  bridge.onToolResult = (params: ToolResultParams) => {
    // `status` matters as much as `envelope`: a result that is not ours at all
    // (an opted-out inbox, a non-plannable email_organize action) must leave
    // the card silent rather than warn under a successful operation.
    const { envelope, status } = classifyResult(params);
    // Recorded before the disarm, because "did this beat the watchdog" is
    // exactly the fact the diagnostics line exists to collect from the real
    // host: `late` would mean remounts DO get a result and the budget is wrong.
    const arrival: ResultArrival =
      getState().resultStatus === "absent" ? "late" : "ontime";
    const afterMs = armedAt === null ? null : Date.now() - armedAt;
    // Unconditional, including after the watchdog has already given up. A late
    // envelope is still a real envelope and must render, over a restored one.
    disarmResultWatchdog();
    setState(
      envelope
        ? { envelope, resultStatus: status, resultArrival: arrival, resultAfterMs: afterMs }
        : { resultStatus: status, resultArrival: arrival, resultAfterMs: afterMs },
    );
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
