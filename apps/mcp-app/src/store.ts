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
import {
  cardKey,
  isRestoreStub,
  loadEnvelope,
  saveEnvelope,
  stripStubMarker,
} from "./persist";
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
  /**
   * How many pushed tool results were refused because they did not belong to
   * the call this card is showing. Diagnostics only, and expected to be 0 on
   * every host forever: it is the counter that would say otherwise.
   */
  uncorrelatedResults: number;
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
  uncorrelatedResults: 0,
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
  // The arguments go with it: persist.ts fingerprints them into the entry so
  // that the same key in a DIFFERENT conversation reads as a miss rather than
  // as this card. It stores a HASH of them, never the arguments themselves —
  // a `draft{action:"create"}` call carries the body the agent composed.
  if (key) saveEnvelope(key, s.envelope, s.toolInput);
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
  const found = key ? loadEnvelope(key, state.toolInput) : null;
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
  //
  // `stripStubMarker` is the same idea for a key rather than a character:
  // `_stub` means "this is a local pointer, re-request it", and a wire payload
  // that carried it would wedge the cell on a spinner the one-shot re-request
  // can no longer clear. Applied to BOTH channels and on the single path every
  // envelope takes — the pushed notification and the card's own tool calls both
  // land here — so there is no second place to forget it.
  if (isEnvelope(sc)) {
    return { envelope: stripStubMarker(neutralizeDeep(sc as Envelope)), status: "envelope" };
  }
  if (claimsToBeOurs(sc)) return { envelope: null, status: "malformed" };

  const text = result.content?.find((c) => c?.type === "text")?.text;
  if (typeof text === "string" && text.trim().startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isEnvelope(parsed)) {
        return { envelope: stripStubMarker(neutralizeDeep(parsed)), status: "envelope" };
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
// Applying an envelope over the one already on screen
//
// Both paths that produce an envelope end here: the card's own `tools/call`
// responses (App.tsx) and the host's pushed `ui/notifications/tool-result`.
// They used to disagree — App.tsx guarded "an error envelope must not take the
// editor away" and the push path did not — and the asymmetry is the defect,
// not either rule. One function, two callers, no drift.
// ---------------------------------------------------------------------------

/** Does this envelope carry the payload its own discriminator promises? */
export function isRenderable(env: Envelope | null | undefined): boolean {
  if (!env) return false;
  switch (env.card) {
    case "draft_editor":
      return !!env.draft;
    case "outbound_review":
      return !!env.outbound;
    case "bulk_plan":
      return !!env.plan;
    case "receipt":
      return !!env.receipt;
    default:
      return false;
  }
}

/**
 * Merge a new envelope onto the current one.
 *
 * `isEnvelope` is structural: `{schema_version, card}` and nothing else passes
 * it, reaches every card branch in App.tsx without matching one, and lands on
 * the "This review is missing its details" notice. If the user was typing a
 * reply at the time, their text went with it. Today's server always populates
 * `draft`, so this is defence in depth — and it is the kind of defence that has
 * to exist BEFORE the server change that needs it, because the failure is
 * silent and destroys work.
 *
 * Two rules, in order:
 *
 *  1. Same card kind, new envelope has no payload, current one does: keep the
 *     payload and take everything else from the new envelope. This is what
 *     makes `state: "error"` render as an error AROUND the editor rather than
 *     instead of it — the server changed nothing, so neither do we.
 *  2. Nothing renderable in the new envelope at all, and something renderable
 *     on screen: ignore it outright. A payload-less `bulk_plan` is not a
 *     reason to take away a send the user is reviewing.
 *
 * Anything renderable replaces, unconditionally. A receipt over a draft is a
 * send completing, and that must always win.
 *
 * "Always" is scoped to what reaches here. The card's own calls (App.tsx
 * #callDraft) reach this function directly, so a send the user pressed always
 * flips the card to its receipt. A PUSHED receipt is filtered first by
 * `envelopeSubject` / `sameSubject` above, which admits a receipt that names
 * this draft and refuses one that names another — or names nothing at all,
 * which is where the server gap in `receiptSubject` bites. That asymmetry is
 * deliberate: this function decides how to merge, not whether the result
 * belongs to this card.
 */
export function mergeEnvelope(
  current: Envelope | null | undefined,
  next: Envelope,
): Envelope {
  if (isRenderable(next) || !current) return next;
  // A RESTORE STUB is renderable by shape (a draft stub has a `draft`) and
  // empty by design (no subject, no body, no recipients). Grafting it onto a
  // fresh envelope would strip the `_stub` marker with it, and App.tsx gates on
  // that marker alone: the result is a full DraftEditor with blank fields
  // sitting over a real server draft, whose first Save writes the blanks back.
  // There is nothing in a stub worth preserving, so rule 1 does not apply to
  // one and rule 2 below keeps the stub itself, marker intact.
  if (next.card === current.card && isRenderable(current) && !isRestoreStub(current)) {
    switch (current.card) {
      case "draft_editor":
        return { ...next, draft: current.draft };
      case "outbound_review":
        return { ...next, outbound: current.outbound };
      case "bulk_plan":
        return { ...next, plan: current.plan };
      case "receipt":
        return { ...next, receipt: current.receipt };
    }
  }
  return isRenderable(current) ? current : next;
}

// ---------------------------------------------------------------------------
// Re-requesting a restored stub
//
// Both halves of this live here rather than inside App.tsx's effect, because
// both are decisions rather than rendering: WHICH read a card kind has, and
// WHETHER what came back may be adopted. In the component they were reachable
// only through a browser, so the one thing that most needed pinning — "a
// bulk_plan has no reader and must not get one" — was a comment. Here the
// harnesses drive the shipped functions directly.
// ---------------------------------------------------------------------------

/** The read a restored stub needs, or null when its card kind has none. */
export interface RehydrationCall {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Which server read puts the content back, for a stub of this card kind.
 *
 * Checked against the shipped tool definitions on 2026-09-16, not assumed:
 *
 *   draft_editor    `draft_read` (mcp-app-drafts.ts) — read-only, inbox_id +
 *                   draft_id.
 *   outbound_review `approval_review` (mcp-app-approvals.ts) — read-only,
 *                   `approval_id` alone, `readOnlyHint: true`, and its own
 *                   description ends "so it can be shown in the review card".
 *                   It shipped with the card and was simply never called, which
 *                   is what cost a re-mounted pending send its Reject button —
 *                   Approve was already only `openLink(review_url)`.
 *   bulk_plan       NONE, and deliberately none. mcp-app-bulk.ts declares
 *                   exactly `bulk_execute` and `bulk_cancel`; both DECIDE, and
 *                   reading a plan by running it is not a read. Plans are also
 *                   server-held with a 15-minute TTL, so a card scrolled back
 *                   to is usually looking at something already expired. This is
 *                   settled: do not add a case for it.
 *   receipt         Terminal. persist.ts rewrites the headline from the outcome
 *                   and it renders straight from the stub.
 */
export function rehydrationCall(env: Envelope | null | undefined): RehydrationCall | null {
  if (!env || !isRestoreStub(env)) return null;
  if (env.card === "draft_editor" && env.draft?.draft_id) {
    return {
      tool: "draft_read",
      args: {
        inbox_id: env.draft.identity?.inbox_id,
        draft_id: env.draft.draft_id,
      },
    };
  }
  if (env.card === "outbound_review" && env.outbound?.approval_id) {
    return {
      tool: "approval_review",
      args: { approval_id: env.outbound.approval_id },
    };
  }
  return null;
}

/**
 * What to do with the answer. `gone` names a subject, not a sentence: the copy
 * belongs to the component.
 */
export type Rehydration =
  | { kind: "adopt"; envelope: Envelope }
  | { kind: "gone"; subject: "draft" | "send" }
  | { kind: "failed" };

/**
 * Receipt error codes that mean THIS EDITOR MUST STOP RENDERING.
 *
 * An allow-list, and deliberately not its complement ("anything but
 * `provider_error`"). `runDraftRead` answers a transient IMAP blip with a
 * `provider_error` receipt, and a receipt is exactly the same event as the
 * thrown error the effect's own `.catch()` arm was written to tolerate — so
 * adopting receipts by default would let one bad remount replace a restored
 * draft with a one-line error. The complement also adopts every code nobody has
 * written yet, which is the same bet made blind.
 *
 * What is on the list is durable rather than transient, and in every case the
 * server's own copy is the right thing to show: it carries the headline, the
 * detail and the way back. `draft_editor_hidden` is the user's own opt-out and
 * is the reason this list exists — without it the card kept rendering a
 * live-looking editor for a mailbox the user had switched off, over a body held
 * only in this browser. `draft_editor_disabled` is the identical shape for a
 * workspace de-rolled-out mid-session. `insufficient_scope` and
 * `inbox_not_found` say this caller or this inbox can never render this card,
 * which no retry changes either.
 *
 * NOTE for whoever edits the copy: the strings come from the server
 * (mcp-app-drafts.ts#gateDraftTool), and as of ws2/round3 they no longer
 * promise a dashboard control, because there is not one yet. Do not reintroduce
 * that promise on the card side.
 */
const EDITOR_STOP_CODES: readonly string[] = [
  "draft_editor_hidden",
  "draft_editor_disabled",
  "insufficient_scope",
  "inbox_not_found",
];

/**
 * Validate a re-request answer before anything is rendered from it.
 *
 * Held to the same standard as a pushed result, because it is the same kind of
 * thing: a server payload arriving into a card that is already showing
 * something. That standard has two halves and this function used to apply only
 * the first:
 *
 *  1. SHAPE. The card kind must be the one that was asked for AND carry its
 *     payload, or it must be a terminal receipt on a path where a receipt is a
 *     real answer. The stub is never rendered as a fallback: an editor with a
 *     blank subject over a draft that has one is an invitation to overwrite the
 *     real thing, and a decision row drawn from a stub is a Reject button with
 *     nothing behind it.
 *  2. IDENTITY. The answer must be about the id that was ASKED FOR. This is why
 *     `asked` is the stub envelope rather than its card kind: `rehydrationCall`
 *     already had the id, and comparing it costs one `sameSubject`.
 *
 * Without (2) an `approval_review` answer naming a DIFFERENT `approval_id`, or
 * a `draft_read` answer naming a different `draft_id`, was adopted and drew a
 * live Reject bound to whichever id the answer chose. Measured on 2026-09-17
 * by the round-2 verification pass, which also noted the bound: this is
 * server-trust, not privilege escalation, because `approval_decide` re-
 * authorises the id against the caller's key. It is still a server BUG rather
 * than a case to tolerate — we asked about one thing and were told about
 * another — so it fails closed, and the comment no longer claims a standard the
 * code was not applying.
 */
export function acceptRehydration(
  asked: Envelope | null | undefined,
  next: Envelope | null,
): Rehydration {
  // BOTH sides, not just `next`. Round 3 changed `asked` from a card-kind
  // STRING to the stub envelope, and `"draft_editor".card` is a harmless
  // `undefined` where `null.card` throws — so the same call that used to
  // return `failed` now takes the function out. App.tsx cannot reach it (the
  // effect returns on `!env`, captures the value before the await, and its
  // `.catch()` would swallow a throw anyway), but this is an exported boundary
  // the harnesses drive directly, and one of them found it: state-machine.mjs
  // hands in whatever `loadEnvelope` returned, which is `null` on any miss.
  // A re-request with nothing to correlate against IS a failed re-request.
  if (!next || !asked) return { kind: "failed" };
  const kind = asked.card;

  // "There is no such thing any more." One quiet line, never a red notice:
  // re-requesting is what just failed, and a wall of warning over a draft the
  // user deliberately sent, or a send somebody already decided, is the scare
  // this card refuses to raise. `not_found` deliberately also covers the
  // wrong-workspace case, which the server makes indistinguishable on purpose,
  // so the line it maps to has to stay neutral.
  //
  // Correlation does not apply here and must not: these refusals carry no id BY
  // DESIGN. `draftFailure` publishes none at all, and ws2/round3's
  // `approval_id` is explicitly `null` on a not-found, because echoing an
  // unverified id back would turn a deliberately indistinguishable refusal into
  // an existence oracle. So a `null` id reads as UNNAMED, which is refused on
  // the push path and lands here as `gone` — which is the same answer the card
  // gave before, for a better reason.
  const code = next.receipt?.error_code;
  if (code === "draft_not_found") return { kind: "gone", subject: "draft" };
  if (
    kind === "outbound_review" &&
    (code === "not_found" || code === "invalid_approval_id")
  ) {
    return { kind: "gone", subject: "send" };
  }

  if (next.card === kind && isRenderable(next)) {
    // Both sides always name an id on this path — a draft envelope carries
    // `draft_id`, an outbound one `approval_id` — so an answer that cannot be
    // placed is a defect, not the tolerated absence `sameSubject` allows for a
    // receipt's missing scope.
    const mine = envelopeSubject(asked);
    const theirs = envelopeSubject(next);
    if (!mine || !theirs || !sameSubject(mine, theirs)) return { kind: "failed" };
    return { kind: "adopt", envelope: next };
  }

  // A queued send that expired, or that was decided in the dashboard while the
  // card was scrolled away, comes back as a terminal receipt. It is
  // server-authored, carries no mail content (the headline names no recipient
  // and no subject) and is the truthful rendering, so it is adopted rather than
  // collapsed into "open the dashboard to see this".
  //
  // On the DRAFT path the same is now true of the few refusals that mean this
  // editor must stop existing — the opt-out above all. Everything else there
  // still falls to the one-liner: `draft_read` answers a missing draft with a
  // `draft_editor` error envelope rather than a receipt, so an unrecognised
  // receipt is a shape nobody has seen.
  if (
    next.card === "receipt" &&
    next.receipt &&
    (kind === "outbound_review" ||
      (kind === "draft_editor" && EDITOR_STOP_CODES.includes(String(code))))
  ) {
    // A receipt is exempt from (2) when it names NOTHING, and only then. That
    // is not laxity: an unnamed receipt is the shape the draft failures still
    // have (`draftFailure` publishes no `draft_id`) and the shape every approval
    // receipt had before ws2/round3, so requiring an id would refuse the very
    // answers this branch exists for. A receipt that DOES name something and
    // names the wrong thing is a mislabelled answer and fails closed.
    const theirs = envelopeSubject(next);
    const mine = envelopeSubject(asked);
    const named = !!theirs && theirs.id !== "";
    if (named && mine && !sameSubject(mine, theirs)) return { kind: "failed" };
    return { kind: "adopt", envelope: next };
  }

  return { kind: "failed" };
}

/**
 * Adopt a re-request answer as the rendered envelope.
 *
 * Exists so that App.tsx cannot do this with a bare `setState`, which is what
 * it used to do — and which left `pushAccepted` false, so exactly one later
 * PUSHED result bypassed correlation entirely and could rebind the card to a
 * foreign draft or approval.
 *
 * The line between this and a restore is the whole point, and it is why the
 * flag is not simply set wherever an envelope appears. A RESTORE is a memory of
 * a call; the real result is measured seconds late on Claude and must still be
 * able to beat it, which is the allowance pinned by hardening.mjs's "a late
 * result still wins over a RESTORED envelope". A REHYDRATION is a server answer
 * to a call the card itself made about a specific id — from that moment the
 * card knows what it is showing, and a later push about something else is the
 * ordinary uncorrelated case rather than the arrival the recovery was waiting
 * for.
 */
export function adoptRehydration(envelope: Envelope): void {
  pushAccepted = true;
  setState({ envelope });
}

/**
 * What a rendered envelope is ABOUT.
 *
 * Used for one thing only: deciding whether a SECOND pushed tool result is the
 * same call as the first. Never rendered, never stored.
 *
 * `scope` is the mailbox an id lives in, and it is a separate field rather than
 * part of the id because the two sides do not always both know it. Provider
 * draft ids are per-mailbox and collide freely across them — `Drafts:2` is the
 * second draft in EVERY IMAP account — so a draft envelope, which carries the
 * inbox, must compare it. A receipt carries no identity block, so it names the
 * id and nothing else; see `sameSubject`.
 */
interface Subject {
  kind: "draft" | "approval" | "plan" | "receipt";
  id: string;
  scope: string | null;
}

/**
 * A receipt that names nothing it could be a receipt FOR.
 *
 * Every approval and bulk receipt in the server is built by a `receiptEnvelope`
 * helper that emits `{schema_version, card, dashboard_url, state, receipt,
 * actor}` and no id at all (mcp-app-approvals.ts#receiptEnvelope,
 * mcp-app-bulk.ts#receiptEnvelope), so today this is what most of them produce.
 * Its `kind` is its own, so it equals no draft, approval or plan — which keeps
 * an uncorrelatable receipt REFUSED, exactly as before this refinement.
 *
 * That refusal is the fail-safe direction and is chosen deliberately: the
 * alternative, exempting receipts from correlation, trades "a terminal receipt
 * for this card is wrongly refused" for "a foreign receipt replaces a draft the
 * user is typing in", which is the worse failure and is not recoverable.
 */
const UNNAMED_RECEIPT: Subject = { kind: "receipt", id: "", scope: null };

/**
 * What a RECEIPT is a receipt for, read off the merged top-level ids.
 *
 * A receipt envelope has no payload of its own to look at — `receipt` is an
 * outcome and a headline. What it does have, on the draft path, is contract
 * §8's merge: `draft{action:"send"}` and `draft{action:"delete"}` publish
 * today's flat payload with the envelope keys laid on top, so `draft_id` sits
 * at the top level beside `schema_version`. That is the correlating material,
 * and it is read here rather than assumed.
 *
 * SERVER GAP, CLOSED 2026-09-17 (ws2/round3, a3cd89a): the approval and bulk
 * `receiptEnvelope` helpers now publish `approval_id` / `plan_id` at the top
 * level, so this function correlates them. The id is the VERIFIED row id and is
 * `null` wherever nothing was verified — a malformed uuid, or one naming no row
 * this key may see — because echoing an unverified id back would turn the
 * deliberately indistinguishable not-found refusal into an existence oracle.
 * That shape is what this function wants: `typeof === "string"` rejects `null`,
 * so an unverified receipt reads as UNNAMED and stays refused on the push path,
 * which is the fail-safe direction and exactly what it was before.
 *
 * ORDER IS A PRECEDENCE, not a search: `draft_id` first, then `approval_id`,
 * then `plan_id`. A receipt carrying two of them would be read as the draft
 * one, which shadows the approval side — so a hypothetical approval receipt
 * that also named a draft would fail to correlate against an approval card and
 * be refused. That is the safe direction and it is why the order is written
 * down rather than left to whichever key was added last. The three are disjoint
 * in every builder today (`draft{action:"send"|"delete"}` merges `draft_id`
 * only; the two `receiptEnvelope`s publish one id each) and there is no reason
 * to make them overlap.
 */
function receiptSubject(env: Envelope): Subject {
  const top = env as unknown as Record<string, unknown>;
  const draftId = top.draft_id;
  if (typeof draftId === "string" && draftId) {
    const inbox = top.inbox_id;
    return {
      kind: "draft",
      id: draftId,
      scope: typeof inbox === "string" && inbox ? inbox : null,
    };
  }
  const approvalId = top.approval_id;
  if (typeof approvalId === "string" && approvalId) {
    return { kind: "approval", id: approvalId, scope: null };
  }
  const planId = top.plan_id;
  if (typeof planId === "string" && planId) {
    return { kind: "plan", id: planId, scope: null };
  }
  return UNNAMED_RECEIPT;
}

function envelopeSubject(env: Envelope | null | undefined): Subject | null {
  if (!env) return null;
  if (env.draft?.draft_id) {
    return {
      kind: "draft",
      id: env.draft.draft_id,
      scope: env.draft.identity?.inbox_id ?? null,
    };
  }
  if (env.outbound?.approval_id) {
    return { kind: "approval", id: env.outbound.approval_id, scope: null };
  }
  if (env.plan?.plan_id) return { kind: "plan", id: env.plan.plan_id, scope: null };
  if (env.receipt) return receiptSubject(env);
  return null;
}

/**
 * Are these two envelopes about the same thing?
 *
 * The scope comparison is deliberately "differ only when BOTH sides name one".
 * A receipt that omits `inbox_id` is not thereby a receipt for a different
 * mailbox — it simply does not say — and refusing it on an absence would put
 * the whole draft-send path back where D4 found it. The id still has to match
 * exactly, and a provider draft id is not guessable from outside the account
 * that holds it.
 */
function sameSubject(a: Subject, b: Subject): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;
  if (a.scope !== null && b.scope !== null && a.scope !== b.scope) return false;
  return true;
}

/**
 * A call id on a pushed result, when the host puts one there.
 *
 * The 2026-01-26 shape of `ui/notifications/tool-result` carries `content` and
 * `structuredContent` and no id, so this is usually null and the correlation
 * below cannot lean on it. It is read anyway because a host that DOES label its
 * notifications gives us an exact answer, and an exact answer beats a
 * heuristic on the one path where being wrong costs the user their typing.
 */
function pushedCallId(params: ToolResultParams | undefined): string | null {
  const meta = (params?._meta ?? {}) as Record<string, unknown>;
  const candidate =
    params?.callId ?? params?.toolCallId ?? meta.callId ?? meta["ui/callId"];
  return typeof candidate === "string" || typeof candidate === "number"
    ? String(candidate)
    : null;
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
 * MEASURED on Claude, 2026-09-16: `result late 4487ms`. The host delivers the
 * mounting tool result about four and a half seconds after the handshake, which
 * is almost certainly the end of the assistant's turn rather than the end of the
 * tool call. Every budget below 4.5s therefore fired on a host that was working,
 * which is what `late` meant each time. 9s is that measurement with headroom for
 * a longer turn, and the cost of being generous is only a longer loading line on
 * a card that is genuinely getting nothing.
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
 * How late Claude is, is now known and is the first paragraph above.
 */
export const RESULT_WATCHDOG_MS = 9_000;

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
/**
 * Has a PUSHED tool result already been accepted for this view?
 *
 * Module scope, like the watchdog timer: one card is mounted per frame, and
 * this is a fact about the frame rather than about the rendered state.
 */
let pushAccepted = false;

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
    // ---- correlation ------------------------------------------------------
    //
    // A pushed result is supposed to be THE result of the call that
    // instantiated this view. The bridge's `event.source` check already limits
    // the sender to the real parent frame, so this is not a boundary against an
    // attacker; it is a guard against a host (or a future server) delivering a
    // second, unrelated result into a card the user is typing in. `DraftEditor`
    // resyncs on `draft_id` + `last_saved_at` + `origin`, so a foreign envelope
    // does not merely redraw: it discards unsaved text.
    //
    // The exact check first, when the host gives us one.
    const pushedId = pushedCallId(params);
    const mountedId = getState().toolInfo?.callId;
    if (pushedId !== null && mountedId != null && pushedId !== String(mountedId)) {
      setState({ uncorrelatedResults: getState().uncorrelatedResults + 1 });
      return;
    }

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
    const timing = { resultStatus: status, resultArrival: arrival, resultAfterMs: afterMs };
    if (!envelope) {
      // Unchanged and deliberately so: a foreign or malformed SECOND result
      // moves the status and leaves the card alone. App.tsx renders on
      // envelope presence, so nothing blanks.
      setState(timing);
      return;
    }

    const current = getState().envelope;
    // `pushAccepted`, not "is there an envelope": a RESTORED envelope is a
    // memory, not a result, and the first real result must always beat it
    // (state-machine.mjs h3, and every remount that is merely slow).
    //
    // ── A FIRST FOREIGN PUSH STILL WINS, AND THAT IS THE TRADE ──────────────
    //
    // Spelled out because it is otherwise only implicit in `pushAccepted`: with
    // a stub restored from storage and no result yet accepted, a pushed result
    // for a COMPLETELY DIFFERENT draft is accepted and rendered. Nothing here
    // refuses it, and nothing should. A restore is a memory of a call, not the
    // call's answer, and the case this whole file exists for is a host that
    // delivers the real result late — several seconds late, measured. Refusing
    // a first result because it disagrees with a memory would lock the card
    // onto the memory forever on exactly the hosts the recovery was built for.
    // The cost is bounded: there is no unsaved typing to destroy at that point
    // (a stub can never render as an editor — App.tsx re-requests first), and
    // the correlation below starts biting from the second result onwards.
    //
    // `isRenderable(envelope)` because only a PAYLOAD-BEARING envelope can
    // destroy anything. A payload-less one (a `state: "error"` refusal, say)
    // has no subject to compare and cannot take the draft away — mergeEnvelope
    // keeps it — so refusing those would only mean swallowing the error message
    // that belongs to this very card.
    if (pushAccepted && current && isRenderable(envelope)) {
      const theirs = envelopeSubject(envelope);
      const mine = envelopeSubject(current);
      if (theirs !== null && mine !== null && !sameSubject(mine, theirs)) {
        setState({ ...timing, uncorrelatedResults: getState().uncorrelatedResults + 1 });
        return;
      }
    }

    pushAccepted = true;
    setState({ ...timing, envelope: mergeEnvelope(current, envelope) });
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
